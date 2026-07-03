#!/usr/bin/env node
// agentic-cortex CLI — Persistent memory for AI coding agents.
// Features: FTS5 search, BGE embeddings (768-dim), 13 typed memories,
// confidence/provenance tracking, conflict detection, temporal queries,
// grounded QA, file upload, daily summaries, Obsidian export.
// No server, no port, no wrapper. Just: node cli.js <command> [args]

const path = require('path');
const fs = require('fs');

// ─── Core Modules ────────────────────────────────────────────────
const { VALID_TYPES, EMBED_MODEL, PORT, LLAMA_URL } = require('./src/core/constants');
const { getDb } = require('./src/core/db');
const { getEmbedPipeline, computeEmbedding, cosineSimilarity } = require('./src/core/embedding');
const { sanitizeDate } = require('./src/core/search');
const { startSession, endSession, callLLM, templateSummary, summarizeSession } = require('./src/core/session');
const { checkConflicts } = require('./src/core/conflict');
const api = require('./src/api');

// ─── Core functions imported from src/core/ modules above ───────
// (getDb, ensureSchema, getDbPath, computeEmbedding, cosineSimilarity,
//  callLLM, sanitizeDate, templateSummary, checkConflicts, etc.)


// ─── Commands ────────────────────────────────────────────────────

const commands = {};

commands.health = {
  desc: 'Show database stats',
  args: [],
  run(db) {
    console.log(JSON.stringify(api.health(), null, 2));
  }
};

commands.save = {
  desc: 'Save an observation (auto-embeds, 13 types, confidence tracking)',
  args: ['<title>', '<content>', '[options]'],
  parse(args) {
    const opts = { title: args[0], content: args[1] };
    for (let i = 2; i < args.length; i += 2) {
      if (args[i] === '--type') opts.type = args[i + 1];
      if (args[i] === '--tags') opts.tags = args[i + 1].split(',');
      if (args[i] === '--importance') opts.importance = parseInt(args[i + 1], 10);
      if (args[i] === '--confidence') opts.confidence = Math.min(100, Math.max(0, parseInt(args[i + 1], 10) || 100));
      if (args[i] === '--provenance') opts.provenance = args[i + 1];
      if (args[i] === '--project') opts.project = args[i + 1];
      if (args[i] === '--session') opts.session = args[i + 1];
      if (args[i] === '--agent-id') opts.agentId = args[i + 1];
      if (args[i] === '--steps') opts.steps = args[i + 1].split(',');
      if (args[i] === '--triggers') opts.triggers = args[i + 1].split(',');
      if (args[i] === '--preconditions') opts.preconditions = args[i + 1].split(',');
      if (args[i] === '--postconditions') opts.postconditions = args[i + 1].split(',');
    }
    return opts;
  },
  async run(db, opts) {
    if (!opts.content) {
      console.error('Usage: save <title> <content> [--type TYPE] [--tags t1,t2] [--importance N] [--confidence N] [--provenance explicit|inferred|observed] [--project PATH] [--agent-id ID] [--steps step1,step2] [--triggers t1,t2] [--preconditions c1,c2] [--postconditions c1,c2]');
      process.exit(1);
    }
    try {
      const result = await api.save(opts);
      console.log(JSON.stringify(result));
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  }
};

commands.search = {
  desc: 'Search observations (keyword, semantic, or temporal)',
  args: ['<query>', '[--project PATH]', '[--limit N]', '[--semantic]', '[--type TYPE]', '[--as-of DATE]', '[--changed-since DATE]', '[--min-confidence N]', '[--agent-id ID]'],
  parse(args) {
    const opts = { query: '', limit: 10, semantic: false, minConfidence: 0 };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--project') opts.project = args[++i];
      else if (args[i] === '--limit') opts.limit = parseInt(args[++i], 10);
      else if (args[i] === '--semantic') opts.semantic = true;
      else if (args[i] === '--type') opts.type = args[++i];
      else if (args[i] === '--as-of') opts.asOf = args[++i];
      else if (args[i] === '--changed-since') opts.changedSince = args[++i];
      else if (args[i] === '--min-confidence') opts.minConfidence = parseInt(args[++i], 10);
      else if (args[i] === '--agent-id') opts.agentId = args[++i];
      else opts.query += (opts.query ? ' ' : '') + args[i];
    }
    return opts;
  },
  async run(db, opts) {
    if (!opts.query && !opts.type && !opts.asOf && !opts.changedSince) {
      console.error('Usage: search <query> [--project PATH] [--limit N] [--semantic] [--type TYPE] [--as-of DATE] [--changed-since DATE] [--min-confidence N] [--agent-id ID]');
      process.exit(1);
    }
    try {
      const results = await api.search(opts.query, opts);
      const embeddedCount = db.prepare('SELECT COUNT(*) as c FROM observations WHERE embedding IS NOT NULL').get().c;
      console.log(JSON.stringify({ results, count: results.length, mode: opts.semantic ? 'hybrid' : 'keyword', embedded: embeddedCount }, null, 2));
    } catch (err) {
      console.error('Search error:', err.message);
      process.exit(1);
    }
  }
};

commands.embed = {
  desc: 'Generate embeddings for all observations',
  args: ['[--ids 1,2,3]', '[--force]'],
  parse(args) {
    const opts = { ids: null, force: false };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--ids') opts.ids = args[++i].split(',').map(Number);
      if (args[i] === '--force') opts.force = true;
    }
    return opts;
  },
  async run(db, opts) {
    let rows;
    if (opts.ids) {
      const ph = opts.ids.map(() => '?').join(',');
      rows = db.prepare("SELECT id, title, content, embedding FROM observations WHERE id IN (" + ph + ")").all(...opts.ids);
    } else if (opts.force) {
      rows = db.prepare('SELECT id, title, content, embedding FROM observations').all();
    } else {
      rows = db.prepare('SELECT id, title, content, embedding FROM observations WHERE embedding IS NULL').all();
    }

    if (rows.length === 0) {
      console.log(JSON.stringify({
        status: 'nothing_to_embed',
        message: 'All observations already have embeddings. Use --force to re-embed.'
      }));
      return;
    }

    console.error('Embedding ' + rows.length + ' observations with ' + EMBED_MODEL + '...');
    const pipe = await getEmbedPipeline();
    const update = db.prepare('UPDATE observations SET embedding = ? WHERE id = ?');
    let done = 0;

    for (const row of rows) {
      const text = [row.title || '', row.content].filter(Boolean).join('. ');
      try {
        const result = await pipe(text, { pooling: 'mean', normalize: true });
        update.run(JSON.stringify(Array.from(result.data)), row.id);
        done++;
        if (done % 5 === 0 || done === rows.length) {
          console.error('  Embedded ' + done + '/' + rows.length);
        }
      } catch (err) {
        console.error('  Failed to embed observation ' + row.id + ': ' + err.message);
      }
    }

    const sample = db.prepare('SELECT embedding FROM observations WHERE embedding IS NOT NULL LIMIT 1').get();
    const dim = sample ? JSON.parse(sample.embedding).length : 0;
    const total = db.prepare('SELECT COUNT(*) as c FROM observations WHERE embedding IS NOT NULL').get().c;
    db.prepare("INSERT OR REPLACE INTO embedding_meta (id, model, dimension, count, updated_at) VALUES (1, ?, ?, ?, datetime('now'))").run(EMBED_MODEL, dim, total);

    console.log(JSON.stringify({ status: 'done', embedded: done, total, dimension: dim, model: EMBED_MODEL }));
  }
};

commands.get = {
  desc: 'Get full observation by ID',
  args: ['<id>'],
  parse(args) { return { id: parseInt(args[0], 10) }; },
  run(db, opts) {
    if (isNaN(opts.id)) { console.error('Usage: get <id>'); process.exit(1); }
    const obs = api.get(opts.id);
    if (!obs) { console.error('Not found: ' + opts.id); process.exit(1); }
    console.log(JSON.stringify(obs, null, 2));
  }
};

commands.timeline = {
  desc: 'Show recent sessions for a project',
  args: ['[project]', '[--limit N]'],
  parse(args) {
    const opts = {
      project: args[0] || process.env.AGENTIC_CORTEX_PROJECT || process.cwd(),
      limit: 10
    };
    for (let i = 1; i < args.length; i += 2) {
      if (args[i] === '--limit') opts.limit = parseInt(args[i + 1], 10);
    }
    return opts;
  },
  run(db, opts) {
    const sessions = db.prepare(
      'SELECT id, session_id, project_name, user_prompt, summary, started_at, ended_at FROM sessions WHERE project_path = ? ORDER BY started_at DESC LIMIT ?'
    ).all(opts.project, opts.limit);
    console.log(JSON.stringify({ sessions, count: sessions.length }, null, 2));
  }
};

commands.context = {
  desc: 'Generate context pack for a project',
  args: ['[project]'],
  parse(args) {
    return { project: args[0] || process.env.AGENTIC_CORTEX_PROJECT || process.cwd() };
  },
  run(db, opts) {
    console.log(api.context(opts));
  }
};

commands.session = {
  desc: 'Record session start/end/summarize',
  args: ['<start|end|summarize>', '[prompt]', '[--id ID]', '[--summary TEXT]'],
  parse(args) {
    const action = args[0];
    const opts = { action };
    if (action === 'start') opts.prompt = args.slice(1).join(' ');
    if (action === 'end') {
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--summary') opts.summary = args.slice(i + 1).join(' ');
        if (args[i] === '--id') opts.id = args[i + 1];
      }
    }
    if (action === 'summarize') {
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--id') opts.id = args[i + 1];
        if (args[i] === '--project') opts.project = args[i + 1];
      }
    }
    return opts;
  },
  async run(db, opts) {
    if (opts.action === 'start') {
      const result = startSession(db, opts);
      console.log(JSON.stringify(result));
    } else if (opts.action === 'end') {
      const sid = opts.id || process.env.AGENTIC_CORTEX_SESSION;
      if (!sid) {
        console.error('Usage: session end --id SESSION_ID [--summary TEXT]');
        process.exit(1);
      }
      const result = endSession(db, sid, opts.summary);
      console.log(JSON.stringify(result));
    } else if (opts.action === 'summarize') {
      const result = await api.summarizeSession(opts);
      console.log(JSON.stringify(result));
    } else {
      console.error('Usage: session <start|end|summarize>');
      process.exit(1);
    }
  }
};

commands.summary = {
  desc: 'List all known projects',
  args: [],
  run(db) {
    const projects = db.prepare(
      'SELECT DISTINCT project_path, project_name, COUNT(*) as sessions, MAX(started_at) as last_active FROM sessions GROUP BY project_path ORDER BY last_active DESC'
    ).all();
    console.log(JSON.stringify({ projects }, null, 2));
  }
};

commands.bulk = {
  desc: 'Bulk save observations from JSON stdin',
  args: [],
  async run(db) {
    if (process.stdin.isTTY) {
      console.error('Bulk expects JSON on stdin. Usage: echo [{...}] | node cli.js bulk');
      process.exit(1);
    }
    let input = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', c => input += c);
    await new Promise(resolve => process.stdin.on('end', resolve));
    let items;
    try { items = JSON.parse(input); } catch {
      console.error('Invalid JSON on stdin'); process.exit(1);
    }
    if (!Array.isArray(items)) items = items.observations || [items];
    const result = await api.importJSON(items);
    console.log(JSON.stringify(result));
  }
};

commands.serve = {
  desc: 'Start HTTP server (optional, for Obsidian/external tools)',
  args: ['[port]'],
  parse(args) {
    return { port: parseInt(args[0] || String(PORT), 10) || PORT };
  },
  run(db, opts) {
    const http = require('http');
    const { URL } = require('url');
    const server = http.createServer(async (req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        });
        return res.end();
      }
      const url = new URL(req.url, 'http://localhost:' + opts.port);
      const p = url.pathname;
      const json = (d, s) => {
        res.writeHead(s || 200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify(d));
      };
      let body = '';
      const getBody = () => new Promise(r => {
        req.on('data', c => body += c);
        req.on('end', () => { try { r(JSON.parse(body)); } catch { r({}); } });
      });
      try {
        if (p === '/health') {
          return json(api.health());
        }
        if (p === '/search') {
          const q = url.searchParams.get('q');
          const proj = url.searchParams.get('project');
          const lim = parseInt(url.searchParams.get('limit') || '10', 10);
          const typ = url.searchParams.get('type');
          if (!q) return json({ error: 'q required' }, 400);
          try {
            const results = await api.search(q, { project: proj, limit: lim, type: typ });
            return json({ results, count: results.length });
          } catch (err) {
            return json({ error: err.message }, 500);
          }
        }
        if (p === '/observation' && req.method === 'POST') {
          const b = await getBody();
          if (!b.content) return json({ error: 'content required' }, 400);
          try {
            const result = await api.save(b);
            return json(result);
          } catch (err) {
            return json({ error: err.message }, 400);
          }
        }
        if (p === '/session/start' && req.method === 'POST') {
          const b = await getBody();
          const result = api.startSession(b);
          return json(result);
        }
        if (p === '/session/end' && req.method === 'POST') {
          const b = await getBody();
          if (!b.session_id) return json({ error: 'session_id required' }, 400);
          const result = api.endSession(b.session_id, b.summary);
          return json(result);
        }
        if (p === '/context') {
          const proj = url.searchParams.get('project');
          if (!proj) return json({ error: 'project required' }, 400);
          return json({ context: api.context({ project: proj }) });
        }
        if (p === '/shutdown') {
          json({ status: 'shutting down' });
          setTimeout(() => { api.close(); process.exit(0); }, 100);
          return;
        }
        json({ error: 'not found' }, 404);
      } catch (err) { json({ error: err.message }, 500); }
    });
    server.listen(opts.port, '127.0.0.1', () => {
      console.log('[agentic-cortex] HTTP server on http://127.0.0.1:' + opts.port);
    });
    process.on('SIGINT', () => { api.close(); process.exit(0); });
    process.on('SIGTERM', () => { api.close(); process.exit(0); });
  }
};



// ─── Edit & Forget ─────────────────────────────────────────────

commands.edit = {
  desc: 'Edit an observation (creates version history)',
  args: ['<id>', '[--title TITLE]', '[--content CONTENT]', '[--confidence N]', '[--importance N]'],
  parse(args) {
    const opts = { id: parseInt(args[0], 10) };
    for (let i = 1; i < args.length; i += 2) {
      if (args[i] === '--title') opts.title = args[i + 1];
      if (args[i] === '--content') opts.content = args[i + 1];
      if (args[i] === '--confidence') opts.confidence = Math.min(100, Math.max(0, parseInt(args[i + 1], 10)));
      if (args[i] === '--importance') opts.importance = parseInt(args[i + 1], 10);
    }
    return opts;
  },
  async run(db, opts) {
    if (isNaN(opts.id)) { console.error('Usage: edit <id> [--title TITLE] [--content CONTENT] [--confidence N] [--importance N]'); process.exit(1); }
    try {
      const result = await api.edit(opts.id, opts);
      console.log(JSON.stringify({
        id: result.id, status: result.status, title: result.title,
        confidence: result.confidence, versionCount: result.versionCount,
      }));
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  }
};

commands.forget = {
  desc: 'Soft-delete an observation (sets is_active = false)',
  args: ['<id>', '[--hard]'],
  parse(args) {
    const opts = { id: parseInt(args[0], 10), hard: false };
    if (args[1] === '--hard') opts.hard = true;
    return opts;
  },
  async run(db, opts) {
    if (isNaN(opts.id)) { console.error('Usage: forget <id> [--hard]'); process.exit(1); }
    try {
      const result = await api.forget(opts.id, { hard: opts.hard });
      if (!opts.hard) result.note = 'Soft-deleted. Use --hard to permanently remove.';
      console.log(JSON.stringify(result));
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  }
};

// ─── Conflict Detection ───────────────────────────────────────────

commands.conflicts = {
  desc: 'Detect contradictory observations using semantic similarity + LLM check',
  args: ['[--project PATH]', '[--limit N]', '[--auto-resolve]'],
  parse(args) {
    const opts = { limit: 10, autoResolve: false };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--project') opts.project = args[++i];
      if (args[i] === '--limit') opts.limit = parseInt(args[++i], 10);
      if (args[i] === '--auto-resolve') opts.autoResolve = true;
    }
    return opts;
  },
  async run(db, opts) {
    try {
      const result = await api.checkConflicts(opts);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('Conflict detection error:', err.message);
      process.exit(1);
    }
  }
};

// ─── Grounded QA ─────────────────────────────────────────────────

commands.answer = {
  desc: 'Grounded QA: retrieve relevant memories + LLM to answer a question',
  args: ['<question>', '[--project PATH]', '[--top-k N]'],
  parse(args) {
    const opts = { question: '', topK: 5 };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--project') opts.project = args[++i];
      else if (args[i] === '--top-k') opts.topK = parseInt(args[++i], 10);
      else opts.question += (opts.question ? ' ' : '') + args[i];
    }
    return opts;
  },
  async run(db, opts) {
    if (!opts.question) { console.error('Usage: answer <question> [--project PATH] [--top-k N]'); process.exit(1); }
    const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();

    // 1. Retrieve relevant memories (hybrid search)
    let finalResults;
    try { finalResults = await api.search(opts.question, { project, limit: opts.topK }); }
    catch { finalResults = []; }

    if (finalResults.length === 0) {
      console.log(JSON.stringify({ answer: 'No relevant memories found for this question.', sources: [] }));
      return;
    }

    // 2. Build RAG prompt
    const memoryContext = finalResults.map((r, i) =>
      `[${i + 1}] (${r.type}, confidence: ${r.confidence}%, source: ${r.provenance}) ${r.title || ''}: ${r.preview || r.content}`
    ).join('\n\n');

    // 3. LLM-grounded answer
    try {
      const answer = await callLLM([
        { role: 'system', content: 'You answer questions based ONLY on provided memory context. Cite sources as [1], [2], etc. If the context is insufficient, say so. Be concise.' },
        { role: 'user', content: 'Question: ' + opts.question + '\n\nMemory Context:\n' + memoryContext + '\n\nAnswer the question using ONLY the context above.' },
      ], { temperature: 0.2, maxTokens: 1000 });

      console.log(JSON.stringify({
        answer: answer || '(LLM returned empty — try again)',
        sources: finalResults.map(r => ({ id: r.id, type: r.type, title: r.title, confidence: r.confidence, provenance: r.provenance })),
        sourceCount: finalResults.length,
      }, null, 2));
    } catch (err) {
      console.log(JSON.stringify({
        answer: 'LLM unavailable. Retrieved relevant memories below.',
        sources: finalResults.map(r => ({ id: r.id, type: r.type, title: r.title, content: (r.preview || r.content || '').slice(0, 300) })),
        sourceCount: finalResults.length,
      }, null, 2));
    }
  }
};

// ─── File Upload ─────────────────────────────────────────────────

commands.upload = {
  desc: 'Upload a file into memory (splits large files into chunks)',
  args: ['<file-path>', '[--type TYPE]', '[--project PATH]', '[--title TITLE]'],
  parse(args) {
    const opts = { filePath: args[0] };
    for (let i = 1; i < args.length; i += 2) {
      if (args[i] === '--type') opts.type = args[i + 1];
      if (args[i] === '--project') opts.project = args[i + 1];
      if (args[i] === '--title') opts.title = args[i + 1];
    }
    return opts;
  },
  async run(db, opts) {
    if (!opts.filePath) { console.error('Usage: upload <file-path> [--type TYPE] [--project PATH] [--title TITLE]'); process.exit(1); }
    const fullPath = path.resolve(opts.filePath);
    if (!fs.existsSync(fullPath)) { console.error('File not found: ' + fullPath); process.exit(1); }

    const ext = path.extname(fullPath).toLowerCase();
    const readableExts = ['.md', '.txt', '.json', '.csv', '.log', '.yml', '.yaml', '.toml', '.xml', '.html', '.mjs', '.mts', '.js', '.ts', '.py', '.prisma'];
    if (!readableExts.includes(ext)) {
      console.error('Unsupported format: ' + ext + '. Supported: ' + readableExts.join(', '));
      process.exit(1);
    }

    const title = opts.title || path.basename(fullPath);
    const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();

    let content = fs.readFileSync(fullPath, 'utf-8');
    if (content.length > 12000) {
      console.error('File is ' + content.length + ' chars — chunking into ~10K segments...');
    }

    const chunks = [];
    if (ext === '.json') {
      try { content = JSON.stringify(JSON.parse(content), null, 2); } catch {}
      chunks.push({ title, content: content.slice(0, 12000) });
    } else if (ext === '.csv') {
      const lines = content.split('\n').filter(Boolean);
      if (lines.length > 1 && lines[0].includes(',')) {
        const headers = lines[0].split(',');
        for (let i = 1; i < Math.min(lines.length, 200); i++) {
          chunks.push({ title: title + ' (row ' + i + ')', content: headers.map((h, j) => h + ': ' + (lines[i].split(',')[j] || '')).join(' | ') });
        }
      } else {
        chunks.push({ title, content: content.slice(0, 12000) });
      }
    } else {
      for (let i = 0; i < content.length; i += 10000) {
        const chunk = content.slice(i, i + 10000);
        const chunkTitle = content.length > 12000 ? title + ' (part ' + Math.floor(i / 10000 + 1) + ')' : title;
        chunks.push({ title: chunkTitle, content: chunk });
      }
    }

    const type = opts.type || 'artifact';
    if (!VALID_TYPES.has(type)) {
      console.error('Invalid type: ' + type + '. Valid types: ' + [...VALID_TYPES].sort().join(', '));
      process.exit(1);
    }

    const pipe = await getEmbedPipeline().catch(() => null);
    const ids = [];
    for (const chunk of chunks) {
      let embedding = null;
      try {
        if (pipe) {
          const text = [chunk.title, chunk.content].filter(Boolean).join('. ');
          const result = await pipe(text, { pooling: 'mean', normalize: true });
          embedding = JSON.stringify(Array.from(result.data));
        }
      } catch {}
      const r = db.prepare(
        'INSERT INTO observations (project_path, type, title, content, confidence, provenance, embedding) VALUES (?,?,?,?,?,?,?)'
      ).run(project, type, chunk.title, chunk.content, 100, 'observed', embedding);
      ids.push(Number(r.lastInsertRowid));
    }

    console.log(JSON.stringify({
      file: path.basename(fullPath), status: 'uploaded', chunks: chunks.length,
      ids, embedded: !!pipe, project,
    }));
  }
};

// ─── Daily Summary ───────────────────────────────────────────────

commands['daily-summary'] = {
  desc: 'Summarize yesterdays observations for a project',
  args: ['[--project PATH]', '[--date DATE]', '[--force]'],
  parse(args) {
    const opts = { force: false };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--project') opts.project = args[++i];
      if (args[i] === '--date') opts.date = args[++i];
      if (args[i] === '--force') opts.force = true;
    }
    return opts;
  },
  async run(db, opts) {
    const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
    const targetDate = opts.date || new Date(Date.now() - 86400000).toISOString().split('T')[0];

    if (!opts.force) {
      const existing = db.prepare('SELECT summary FROM daily_summaries WHERE project_path = ? AND summary_date = ?').get(project, targetDate);
      if (existing) {
        console.log(JSON.stringify({ date: targetDate, summary: existing.summary, cached: true }));
        return;
      }
    }

    const obs = db.prepare(
      "SELECT id, type, title, content, importance, confidence FROM observations WHERE project_path = ? AND is_active = 1 AND date(created_at) = ? ORDER BY importance DESC LIMIT 50"
    ).all(project, targetDate);

    if (obs.length === 0) {
      console.log(JSON.stringify({ date: targetDate, summary: 'No observations recorded on ' + targetDate, observationCount: 0 }));
      return;
    }

    const obsText = obs.map((o, i) =>
      `${i + 1}. [${o.type}] ${o.title || '(untitled)'}: ${o.content.slice(0, 300)}`
    ).join('\n');

    console.error('Summarizing ' + obs.length + ' observations for ' + targetDate + '...');

    let summary;
    try {
      summary = await callLLM([
        { role: 'system', content: 'You summarize a day\'s worth of coding agent observations. Be concise (2-4 sentences). Focus on what was accomplished, key decisions, and problems solved. Use past tense.' },
        { role: 'user', content: 'Date: ' + targetDate + '\n\nObservations:\n' + obsText },
      ], { temperature: 0.2, maxTokens: 300 });
    } catch {}

    if (!summary || summary === null) {
      const types = {};
      for (const o of obs) { types[o.type] = (types[o.type] || 0) + 1; }
      summary = obs.length + ' observations — ' + Object.entries(types).map(([t, c]) => c + ' ' + t).join(', ');
    }

    db.prepare(
      'INSERT OR REPLACE INTO daily_summaries (project_path, summary_date, summary, observation_count) VALUES (?,?,?,?)'
    ).run(project, targetDate, summary, obs.length);

    console.log(JSON.stringify({
      date: targetDate, summary, observationCount: obs.length, status: 'summarized',
    }));
  }
};

// ─── Obsidian Export ─────────────────────────────────────────────

commands.export = {
  desc: 'Export memories to an Obsidian vault (one-way, read-only mirror)',
  args: ['<vault-path>', '[--project PATH]', '[--force]'],
  parse(args) {
    const opts = { vaultPath: args[0], force: false };
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--project') opts.project = args[++i];
      if (args[i] === '--force') opts.force = true;
    }
    return opts;
  },
  run(db, opts) {
    if (!opts.vaultPath) {
      console.error('Usage: export <vault-path> [--project PATH] [--force]');
      process.exit(1);
    }
    try {
      const result = api.exportMarkdown({ vaultPath: opts.vaultPath, project: opts.project, force: opts.force });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('Export error:', err.message);
      process.exit(1);
    }
  }
};

// --- Setup: One-command init (install & forget) ---

commands.setup = {
  desc: 'One-command setup: init + graph + inject + optional git hooks',
  args: ['[--no-hooks]'],
  parse(args) {
    return { noHooks: args.includes('--no-hooks') };
  },
  run(db, opts) {
    const cwd = process.cwd();
    const targetPath = path.join(cwd, 'knowledge.md');
    const templatePath = path.join(__dirname, 'templates', 'knowledge.md');

    // Step 1: Init
    console.error('[agentic-cortex] Setup starting in ' + cwd + '...\n');
    if (fs.existsSync(targetPath)) {
      console.error('[agentic-cortex] knowledge.md already exists at ' + targetPath + ' — skipping init');
    } else if (fs.existsSync(templatePath)) {
      fs.copyFileSync(templatePath, targetPath);
      console.error('[agentic-cortex]   created knowledge.md');
    } else {
      console.error('[agentic-cortex] Template not found, creating minimal knowledge.md');
      const minimal = '# Agentic Cortex Memory Instructions\n\n## Persistent Memory\n\nUse `agentic-cortex save` to persist observations.\nAt session start, check below for injected context.\n\n<!-- MEMORY_CONTEXT_START -->\n<!-- MEMORY_CONTEXT_END -->\n';
      fs.writeFileSync(targetPath, minimal, 'utf-8');
    }

    // Step 2: Graph
    const graphScript = path.join(__dirname, 'scripts', 'generate-graph.mjs');
    if (fs.existsSync(graphScript)) {
      try {
        const { execSync } = require('child_process');
        execSync('node "' + graphScript + '" --output md', { encoding: 'utf-8', timeout: 30000, cwd });
        console.error('[agentic-cortex]   codebase graph generated');
      } catch (err) {
        console.error('[agentic-cortex]   graph generation skipped: ' + (err.message || '').split('\n')[0]);
      }
    }

    // Step 3: Inject
    const injectScript = path.join(__dirname, 'scripts', 'inject-memory.mjs');
    if (fs.existsSync(injectScript)) {
      try {
        const { execSync } = require('child_process');
        execSync('node "' + injectScript + '" "' + cwd.replace(/\\/g, '/') + '"', { encoding: 'utf-8', timeout: 60000 });
        console.error('[agentic-cortex]   context injected into knowledge.md');
      } catch (err) {
        if (err.stdout) process.stderr.write(err.stdout.toString());
        console.error('[agentic-cortex]   injection completed with warnings');
      }
    }

    // Step 4: Git hooks (unless --no-hooks)
    const gitDir = path.join(cwd, '.git');
    if (!opts.noHooks && fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory()) {
      try {
        const hookDir = path.join(gitDir, 'hooks');
        if (!fs.existsSync(hookDir)) fs.mkdirSync(hookDir, { recursive: true });
        const hookContent = '#!/bin/sh\n# Auto-generated by agentic-cortex setup\nagentic-cortex inject 2>/dev/null || true\n';
        for (const hookName of ['post-merge', 'post-checkout', 'post-rewrite', 'post-commit']) {
          const hookPath = path.join(hookDir, hookName);
          if (!fs.existsSync(hookPath)) {
            fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
            console.error('[agentic-cortex]   installed .git/hooks/' + hookName);
          }
        }
      } catch (err) {
        console.error('[agentic-cortex]   git hooks skipped: ' + err.message);
      }
    }

    console.log('\n[agentic-cortex] Setup complete! Your agent now has full context.');
    if (!opts.noHooks && fs.existsSync(path.join(cwd, '.git'))) {
      console.log('[agentic-cortex] Context auto-refreshes on git checkout/merge/pull.');
    }
    console.log('[agentic-cortex] Run "agentic-cortex help" to see all commands.');
  }
};

// --- Git Hooks: Install/remove auto-injection hooks ---

commands.hook = {
  desc: 'Install or remove git hooks for auto context injection',
  args: ['<install|uninstall|status>'],
  parse(args) {
    return { action: args[0] || 'status' };
  },
  run(db, opts) {
    const cwd = process.cwd();
    const gitDir = path.join(cwd, '.git');
    if (!fs.existsSync(gitDir)) {
      console.error('No .git directory found in ' + cwd + '. Run this inside a git repo.');
      process.exit(1);
    }
    const hookDir = path.join(gitDir, 'hooks');
    const hookContent = '#!/bin/sh\n# Auto-generated by agentic-cortex hook\nagentic-cortex inject 2>/dev/null || true\n';
    const hookNames = ['post-merge', 'post-checkout', 'post-rewrite', 'post-commit'];

    if (opts.action === 'install') {
      if (!fs.existsSync(hookDir)) fs.mkdirSync(hookDir, { recursive: true });
      let installed = 0;
      for (const name of hookNames) {
        const hp = path.join(hookDir, name);
        if (!fs.existsSync(hp)) {
          fs.writeFileSync(hp, hookContent, { mode: 0o755 });
          installed++;
          console.error('[agentic-cortex] Installed .git/hooks/' + name);
        }
      }
      console.log(JSON.stringify({ status: 'installed', hooks: installed, note: 'Context auto-refreshes on git operations' }));
    } else if (opts.action === 'uninstall') {
      let removed = 0;
      for (const name of hookNames) {
        const hp = path.join(hookDir, name);
        try {
          const content = fs.readFileSync(hp, 'utf-8');
          if (content.includes('agentic-cortex inject')) {
            fs.unlinkSync(hp);
            removed++;
            console.error('[agentic-cortex] Removed .git/hooks/' + name);
          }
        } catch {}
      }
      console.log(JSON.stringify({ status: 'uninstalled', hooks: removed }));
    } else {
      const installed = [];
      for (const name of hookNames) {
        const hp = path.join(hookDir, name);
        try {
          const content = fs.readFileSync(hp, 'utf-8');
          if (content.includes('agentic-cortex inject')) installed.push(name);
        } catch {}
      }
      console.log(JSON.stringify({ status: 'status', installed, total: installed.length }));
    }
  }
};

// --- Init: Create knowledge.md template ---

commands.init = {
  desc: 'Initialize knowledge.md with memory markers in current directory',
  args: [],
  run(db) {
    const templateDir = path.join(__dirname, 'templates');
    const templatePath = path.join(templateDir, 'knowledge.md');
    const targetPath = path.join(process.cwd(), 'knowledge.md');

    if (fs.existsSync(targetPath)) {
      console.log('knowledge.md already exists at ' + targetPath);
      console.log('Remove it first or use a different directory.');
      process.exit(1);
    }

    if (!fs.existsSync(templatePath)) {
      console.error('Template not found at ' + templatePath);
      console.error('Reinstall agentic-cortex or create knowledge.md manually.');
      process.exit(1);
    }

    fs.copyFileSync(templatePath, targetPath);
    console.log('[agentic-cortex] Created knowledge.md at ' + targetPath);
    console.log('[agentic-cortex] Next: run "agentic-cortex graph" to generate the codebase map');
    console.log('[agentic-cortex] Then:  run "agentic-cortex inject" to inject context');
  }
};

// ─── Graph: Generate codebase structure map ─────────────────────

commands.graph = {
  desc: 'Generate/update the codebase structure graph (deterministic, cached)',
  args: ['[--output json|md]', '[--skip-cache]'],
  parse(args) {
    const opts = { output: 'md', skipCache: false };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--output') opts.output = args[++i];
      if (args[i] === '--skip-cache') opts.skipCache = true;
    }
    return opts;
  },
  run(db, opts) {
    const scriptPath = path.join(__dirname, 'scripts', 'generate-graph.mjs');
    if (!fs.existsSync(scriptPath)) {
      console.error('Graph generator not found at ' + scriptPath);
      process.exit(1);
    }
    const args = ['--output', opts.output];
    if (opts.skipCache) args.push('--skip-cache');
    const { execSync } = require('child_process');
    try {
      const result = execSync('node "' + scriptPath + '" ' + args.join(' '), {
        encoding: 'utf-8',
        timeout: 30000,
        cwd: process.cwd(),
      });
      process.stdout.write(result);
    } catch (err) {
      console.error('[agentic-cortex] Graph generation failed:', err.message);
      process.exit(1);
    }
  }
};

// ─── Watch: File watcher daemon ────────────────────────────────

commands.watch = {
  desc: 'Watch a directory for file changes and auto-record observations',
  args: ['[dir]', '[--debounce N]'],
  parse(args) {
    const opts = { debounceMs: 10000 };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--debounce') opts.debounceMs = parseInt(args[++i], 10) || 10000;
      else if (!opts.dir) opts.dir = args[i];
    }
    return opts;
  },
  async run(db, opts) {
    const watcher = require('./src/core/watcher');
    watcher.setAPI(api);

    const targetDir = opts.dir || process.cwd();
    console.log(JSON.stringify(await watcher.startWatching(targetDir, {
      debounceMs: opts.debounceMs,
      onBatch: (summary) => {
        console.error('[agentic-cortex:watch] Batch: ' + summary.slice(0, 100) + '...');
      }
    })));

    console.error('[agentic-cortex:watch] Daemon running. Press Ctrl+C to stop.');

    process.on('SIGINT', () => {
      watcher.stopWatching();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      watcher.stopWatching();
      process.exit(0);
    });
  }
};

// ─── Action: Intent → Action → Outcome tracking ─────────────────

commands.action = {
  desc: 'Record an agent action as intent→action→outcome triplet',
  args: ['--intent INTENT', '--action ACTION', '--outcome OUTCOME', '[--project PATH]', '[--agent-id ID]'],
  parse(args) {
    const opts = {};
    for (let i = 0; i < args.length; i += 2) {
      if (args[i] === '--intent') opts.intent = args[i + 1];
      if (args[i] === '--action') opts.action = args[i + 1];
      if (args[i] === '--outcome') opts.outcome = args[i + 1];
      if (args[i] === '--project') opts.project = args[i + 1];
      if (args[i] === '--agent-id') opts.agentId = args[i + 1];
      if (args[i] === '--confidence') opts.confidence = parseInt(args[i + 1], 10);
    }
    return opts;
  },
  async run(db, opts) {
    if (!opts.intent || !opts.action || !opts.outcome) {
      console.error('Usage: action --intent "what you tried" --action "what you did" --outcome "what happened" [--project PATH] [--agent-id ID]');
      process.exit(1);
    }
    try {
      const result = await api.recordAction(opts);
      console.log(JSON.stringify(result));
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  }
};

// ─── Transfer: Cross-project knowledge transfer ──────────────────

commands.transfer = {
  desc: 'Transfer high-confidence knowledge between projects',
  args: ['--from PROJECT', '--to PROJECT', '[--types t1,t2]', '[--min-confidence N]'],
  parse(args) {
    const opts = {};
    for (let i = 0; i < args.length; i += 2) {
      if (args[i] === '--from') opts.fromProject = args[i + 1];
      if (args[i] === '--to') opts.toProject = args[i + 1];
      if (args[i] === '--types') opts.types = args[i + 1].split(',');
      if (args[i] === '--min-confidence') opts.minConfidence = parseInt(args[i + 1], 10);
    }
    return opts;
  },
  async run(db, opts) {
    if (!opts.fromProject || !opts.toProject) {
      console.error('Usage: transfer --from PROJECT --to PROJECT [--types t1,t2] [--min-confidence N]');
      process.exit(1);
    }
    try {
      const result = await api.transferKnowledge(opts);
      console.log(JSON.stringify(result));
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  }
};

// ─── Ingest: Parse transcripts into structured observations ──────

commands.ingest = {
  desc: 'Parse conversation transcript into structured observations',
  args: ['<text|--file PATH>', '[--project PATH]', '[--agent-id ID]'],
  parse(args) {
    const opts = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--file') {
        const filePath = args[++i];
        if (filePath && require('fs').existsSync(filePath)) {
          opts.text = require('fs').readFileSync(filePath, 'utf-8');
        }
      } else if (args[i] === '--project') opts.project = args[++i];
      else if (args[i] === '--agent-id') opts.agentId = args[++i];
      else if (!opts.text) opts.text = (opts.text ? opts.text + ' ' : '') + args[i];
    }
    return opts;
  },
  async run(db, opts) {
    if (!opts.text) {
      console.error('Usage: ingest <text> [--file PATH] [--project PATH] [--agent-id ID]');
      console.error('  Or pipe: cat transcript.txt | agentic-cortex ingest --file -');
      process.exit(1);
    }
    try {
      const result = await api.ingestTranscript(opts.text, { project: opts.project, agentId: opts.agentId });
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  }
};

// ─── Feedback: Agent feedback on memory usefulness ───────────────

commands.feedback = {
  desc: 'Give feedback on a memory (helpful or incorrect)',
  args: ['<id>', '--type helpful|incorrect', '[--reason TEXT]'],
  parse(args) {
    const opts = { id: parseInt(args[0], 10) };
    for (let i = 1; i < args.length; i += 2) {
      if (args[i] === '--type') opts.type = args[i + 1];
      if (args[i] === '--reason') opts.reason = args.slice(i + 1).join(' ');
    }
    return opts;
  },
  async run(db, opts) {
    if (isNaN(opts.id) || !opts.type) {
      console.error('Usage: feedback <id> --type helpful|incorrect [--reason TEXT]');
      process.exit(1);
    }
    try {
      const result = await api.feedback(opts.id, { type: opts.type, reason: opts.reason });
      console.log(JSON.stringify(result));
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  }
};

// ─── Trail: Memory relation trail ────────────────────────────────

commands.trail = {
  desc: 'Walk the memory relation graph to surface a narrative trail',
  args: ['<id>', '[--depth N]', '[--direction forward|backward|both]'],
  parse(args) {
    const opts = { id: parseInt(args[0], 10), depth: 5, direction: 'both' };
    for (let i = 1; i < args.length; i += 2) {
      if (args[i] === '--depth') opts.depth = parseInt(args[i + 1], 10);
      if (args[i] === '--direction') opts.direction = args[i + 1];
    }
    return opts;
  },
  run(db, opts) {
    if (isNaN(opts.id)) {
      console.error('Usage: trail <id> [--depth N] [--direction forward|backward|both]');
      process.exit(1);
    }
    try {
      const result = api.trail(opts.id, { depth: opts.depth, direction: opts.direction });
      console.log(result.trail);
      console.log('\n' + JSON.stringify({ nodeCount: result.nodeCount, startId: result.startId }));
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
  }
};

// ─── Utility: Memory utility stats ───────────────────────────────

commands.utility = {
  desc: 'Show which memories are most/least useful (by access count)',
  args: ['[--project PATH]', '[--limit N]'],
  parse(args) {
    const opts = { limit: 10 };
    for (let i = 0; i < args.length; i += 2) {
      if (args[i] === '--project') opts.project = args[i + 1];
      if (args[i] === '--limit') opts.limit = parseInt(args[i + 1], 10);
    }
    return opts;
  },
  run(db, opts) {
    const stats = api.getUtilityStats(opts);
    console.log(JSON.stringify(stats, null, 2));
  }
};

// ─── Inject: Inject memories + graph into knowledge.md ──────────

commands.inject = {
  desc: 'Inject session memories + codebase graph into knowledge.md',
  args: ['[--project PATH]'],
  parse(args) {
    const opts = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--project') opts.project = args[++i];
    }
    return opts;
  },
  run(db, opts) {
    const scriptPath = path.join(__dirname, 'scripts', 'inject-memory.mjs');
    if (!fs.existsSync(scriptPath)) {
      console.error('Inject script not found at ' + scriptPath);
      process.exit(1);
    }
    const projectArg = opts.project || process.cwd();
    const { execSync } = require('child_process');
    try {
      const result = execSync('node "' + scriptPath + '" "' + projectArg + '"', {
        encoding: 'utf-8',
        timeout: 60000,
      });
      process.stdout.write(result);
    } catch (err) {
      if (err.stdout) process.stdout.write(err.stdout.toString());
      if (err.stderr) process.stderr.write(err.stderr.toString());
      if (!err.stdout && !err.stderr) {
        console.error('[agentic-cortex] Injection failed:', err.message);
      }
      process.exit(1);
    }
  }
};

// ─── CLI Entry Point ─────────────────────────────────────────────

const [,, cmd, ...args] = process.argv;

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log('agentic-cortex — Persistent memory for AI coding agents\n');
  console.log('Usage: agentic-cortex <command> [args]\n');
  console.log('Commands:');
  for (const [name, c] of Object.entries(commands)) {
    console.log('  ' + name.padEnd(12) + c.desc + (c.args.length ? '  ' + c.args.join(' ') : ''));
  }
  console.log('\nMemory Types (13 from Memanto):');
  const displayTypes = [...VALID_TYPES].filter(t => !['architecture','bugfix','gotcha','codebase-graph'].includes(t));
  for (let i = 0; i < displayTypes.length; i += 5) {
    console.log('  ' + displayTypes.slice(i, i + 5).join(', '));
  }
  console.log('\nEnvironment:');
  console.log('  AGENTIC_CORTEX_PROJECT    Default project path for observations');
  console.log('  AGENTIC_CORTEX_SESSION    Current session ID');
  console.log('  AGENTIC_CORTEX_PORT       HTTP server port (default: 37777)');
  console.log('  LLAMA_CPP_BASE_URL    llama.cpp server URL (default: http://127.0.0.1:8081)');
  process.exit(0);
}

const command = commands[cmd];
if (!command) {
  console.error('Unknown command: ' + cmd + '. Run with --help for usage.');
  process.exit(1);
}

async function main() {
  const db = getDb();
  try {
    const opts = command.parse ? command.parse(args) : {};
    await command.run(db, opts);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    if (cmd !== 'serve' && db) db.close();
  }
}

main();
