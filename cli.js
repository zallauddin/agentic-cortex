#!/usr/bin/env node
// agentic-cortex CLI v3.0 — Persistent memory for AI coding agents.
// Features: FTS5 search, BGE embeddings (768-dim), 13 typed memories,
// confidence/provenance tracking, conflict detection, temporal queries,
// grounded QA, file upload, daily summaries, Obsidian export.
// No server, no port, no wrapper. Just: node cli.js <command> [args]

const path = require('path');
const fs = require('fs');

// ─── Core Modules ────────────────────────────────────────────────
const { VALID_TYPES, VALID_PROVENANCES, EMBED_MODEL, DB_FILENAME, PORT, LLAMA_URL } = require('./src/core/constants');
const { getDb, ensureSchema, getDbPath } = require('./src/core/db');
const { getEmbedPipeline, computeEmbedding, cosineSimilarity } = require('./src/core/embedding');
const { sanitizeDate, buildWhereClause, keywordSearch, semanticSearch, hybridSearch } = require('./src/core/search');
const { startSession, endSession, listSessions, callLLM, templateSummary, summarizeSession } = require('./src/core/session');
const { checkConflicts } = require('./src/core/conflict');
const { exportJSON, exportMarkdown, importJSON } = require('./src/core/export');

// ─── Core functions imported from src/core/ modules above ───────
// (getDb, ensureSchema, getDbPath, computeEmbedding, cosineSimilarity,
//  callLLM, sanitizeDate, templateSummary, checkConflicts, etc.)


// ─── Commands ────────────────────────────────────────────────────

const commands = {};

commands.health = {
  desc: 'Show database stats',
  args: [],
  run(db) {
    const sessions = db.prepare('SELECT COUNT(*) as c FROM sessions').get().c;
    const obs = db.prepare('SELECT COUNT(*) as c FROM observations').get().c;
    const embedded = db.prepare('SELECT COUNT(*) as c FROM observations WHERE embedding IS NOT NULL').get().c;
    const projects = db.prepare('SELECT COUNT(DISTINCT project_path) as c FROM sessions').get().c;
    const dbPath = getDbPath();
    const dbSize = fs.existsSync(dbPath) ? (fs.statSync(dbPath).size / 1024).toFixed(1) : 0;
    const meta = db.prepare('SELECT * FROM embedding_meta WHERE id = 1').get();
    console.log(JSON.stringify({
      status: 'ok', sessions, observations: obs, embedded, projects,
      dbSizeKB: parseFloat(dbSize),
      embedding: meta ? { model: meta.model, dimension: meta.dimension, count: meta.count } : null,
    }, null, 2));
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
    }
    return opts;
  },
  async run(db, opts) {
    if (!opts.content) {
      console.error('Usage: save <title> <content> [--type TYPE] [--tags t1,t2] [--importance N] [--confidence N] [--provenance explicit|inferred|observed] [--project PATH]');
      process.exit(1);
    }
    const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
    const session = opts.session || process.env.AGENTIC_CORTEX_SESSION || null;
    const type = opts.type || 'observation';
    if (!VALID_TYPES.has(type)) {
      console.error('Invalid type: ' + type + '. Valid types: ' + [...VALID_TYPES].sort().join(', '));
      process.exit(1);
    }
    const provenance = opts.provenance || 'observed';
    if (!VALID_PROVENANCES.has(provenance)) {
      console.error('Invalid provenance: ' + provenance + '. Valid: explicit, inferred, observed');
      process.exit(1);
    }
    const confidence = opts.confidence || 100;
    const tags = JSON.stringify(opts.tags || []);
    const imp = opts.importance || 5;

    let embedding = null;
    try {
      const text = [opts.title || '', opts.content].filter(Boolean).join('. ');
      const vec = await computeEmbedding(text);
      embedding = JSON.stringify(vec);
    } catch (err) { console.error('Embedding skipped:', err.message); }

    const r = db.prepare(
      'INSERT INTO observations (session_id, project_path, type, title, content, tags, importance, confidence, provenance, embedding) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).run(session, project, type, opts.title || null, opts.content, tags, imp, confidence, provenance, embedding);
    console.log(JSON.stringify({
      id: Number(r.lastInsertRowid), status: 'saved', type, confidence, provenance, project, embedded: !!embedding
    }));
  }
};

commands.search = {
  desc: 'Search observations (keyword, semantic, or temporal)',
  args: ['<query>', '[--project PATH]', '[--limit N]', '[--semantic]', '[--type TYPE]', '[--as-of DATE]', '[--changed-since DATE]', '[--min-confidence N]'],
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
      else opts.query += (opts.query ? ' ' : '') + args[i];
    }
    return opts;
  },
  async run(db, opts) {
    if (!opts.query && !opts.type && !opts.asOf && !opts.changedSince) {
      console.error('Usage: search <query> [--project PATH] [--limit N] [--semantic] [--type TYPE] [--as-of DATE] [--changed-since DATE] [--min-confidence N]');
      process.exit(1);
    }

    // Build WHERE clause for temporal/confidence/type filters
    const conditions = ['o.is_active = 1'];
    const params = [];
    if (opts.project) { conditions.push('o.project_path = ?'); params.push(opts.project); }
    if (opts.type) { conditions.push('o.type = ?'); params.push(opts.type); }
    if (opts.minConfidence > 0) { conditions.push('o.confidence >= ?'); params.push(opts.minConfidence); }
    if (opts.changedSince) { conditions.push("o.created_at >= ?"); params.push(sanitizeDate(opts.changedSince) + ' 00:00:00'); }
    if (opts.asOf) {
      conditions.push("o.created_at <= ?"); params.push(sanitizeDate(opts.asOf) + ' 23:59:59');
    }
    const whereClause = conditions.join(' AND ');

    // Phase 1: FTS5 keyword search
    const safe = (opts.query || '').replace(/["']/g, '').trim();
    let ftsResults = [];
    if (safe) {
      const ftsQuery = safe.split(' ').map(w => '"' + w + '"').join(' OR ');
      const sql = 'SELECT o.id, o.project_path, o.type, o.title, substr(o.content, 1, 300) as preview, o.tags, o.importance, o.confidence, o.provenance, o.created_at, o.embedding IS NOT NULL as has_embedding, rank FROM observations_fts fts JOIN observations o ON o.id = fts.rowid WHERE observations_fts MATCH ? AND ' + whereClause + ' ORDER BY rank LIMIT ?';
      try {
        ftsResults = db.prepare(sql).all(ftsQuery, ...params, opts.limit * 2);
      } catch (err) { console.error('FTS5 search error:', err.message); }
    } else {
      // No query text — just apply filters (e.g., --changed-since alone)
      const colOrder = 'o.id, o.project_path, o.type, o.title, substr(o.content, 1, 300) as preview, o.tags, o.importance, o.confidence, o.provenance, o.created_at';
      try {
        ftsResults = db.prepare('SELECT ' + colOrder + ' FROM observations o WHERE ' + whereClause + ' ORDER BY o.created_at DESC LIMIT ?').all(...params, opts.limit * 2);
      } catch (err) { console.error('Filter search error:', err.message); }
    }

    // Phase 2: Semantic reranking (if --semantic and embeddings exist)
    if (opts.semantic) {
      const embeddedCount = db.prepare(
        'SELECT COUNT(*) as c FROM observations WHERE embedding IS NOT NULL'
      ).get().c;

      if (embeddedCount === 0) {
        console.error('No embeddings found. Run: node cli.js embed');
        console.error('Falling back to keyword search only.');
      } else {
        // Warn about dimension mismatch (stored vs current model)
        try {
          const sample = db.prepare('SELECT embedding FROM observations WHERE embedding IS NOT NULL LIMIT 1').get();
          if (sample) {
            const storedDim = JSON.parse(sample.embedding).length;
            if (meta && storedDim !== meta.dimension) {
              console.error('Note: Stored embeddings are ' + storedDim + '-dim but current model (' + EMBED_MODEL + ') produces ' + (meta?.dimension || '?') + '-dim.');
              console.error('Run: node cli.js embed --force  to upgrade all embeddings to the current model.');
              console.error('Search will still work (using min-length similarity) but results may be suboptimal.');
            }
          }
        } catch {}
        try {
          const queryVec = await computeEmbedding(opts.query);

          let candidateIds;
          if (ftsResults.length > 0) {
            const ftsIds = ftsResults.map(r => r.id);
            const moreLimit = Math.max(opts.limit * 3, 50);
            const moreIds = db.prepare(
              "SELECT id FROM observations WHERE embedding IS NOT NULL AND id NOT IN (" +
              ftsIds.map(() => '?').join(',') + ") ORDER BY created_at DESC LIMIT ?"
            ).all(...ftsIds, moreLimit).map(r => r.id);
            candidateIds = [...ftsIds, ...moreIds];
          } else {
            const all = opts.project
              ? db.prepare("SELECT id FROM observations WHERE embedding IS NOT NULL AND project_path = ? ORDER BY created_at DESC").all(opts.project)
              : db.prepare("SELECT id FROM observations WHERE embedding IS NOT NULL ORDER BY created_at DESC").all();
            candidateIds = all.map(r => r.id);
          }

          const scores = [];
          const placeholders = candidateIds.map(() => '?').join(',');
          const rows = db.prepare(
            "SELECT id, project_path, type, title, substr(content, 1, 300) as preview, tags, importance, created_at, embedding " +
            "FROM observations WHERE id IN (" + placeholders + ")"
          ).all(...candidateIds);

          for (const row of rows) {
            try {
              const vec = JSON.parse(row.embedding);
              const sim = cosineSimilarity(queryVec, vec);
              scores.push({ ...row, semantic_score: sim });
            } catch {}
          }

          const ftsMap = new Map(ftsResults.map(r => [r.id, r]));
          const merged = scores.map(s => {
            const fts = ftsMap.get(s.id);
            const ftsRank = fts ? Math.abs(fts.rank) : 0;
            const combined = fts
              ? (0.4 * (1 / (1 + ftsRank)) + 0.6 * s.semantic_score)
              : s.semantic_score;
            return {
              id: s.id, project_path: s.project_path, type: s.type,
              title: s.title, preview: s.preview, tags: s.tags,
              importance: s.importance, confidence: s.confidence, provenance: s.provenance,
              created_at: s.created_at,
              semantic_score: Math.round(s.semantic_score * 1000) / 1000,
              fts_rank: fts?.rank || null,
              combined_score: Math.round(combined * 1000) / 1000,
            };
          });

          merged.sort((a, b) => b.combined_score - a.combined_score);
          const results = merged.slice(0, opts.limit);
          console.log(JSON.stringify({
            results, count: results.length, mode: 'hybrid', embedded: embeddedCount
          }, null, 2));
          return;
        } catch (err) {
          console.error('Semantic search failed:', err.message);
          console.error('Falling back to keyword search only.');
        }
      }
    }

    const results = ftsResults.map(r => ({
      id: r.id, project_path: r.project_path, type: r.type, title: r.title,
      preview: r.preview, tags: r.tags, importance: r.importance,
      confidence: r.confidence, provenance: r.provenance,
      created_at: r.created_at, rank: r.rank,
    }));
    console.log(JSON.stringify({ results, count: results.length, mode: 'keyword' }, null, 2));
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
    const obs = db.prepare('SELECT * FROM observations WHERE id = ?').get(opts.id);
    if (!obs) { console.error('Not found: ' + opts.id); process.exit(1); }
    const { embedding, ...rest } = obs;
    rest.has_embedding = !!embedding;
    console.log(JSON.stringify(rest, null, 2));
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
    const sessions = db.prepare(
      'SELECT id, session_id, project_name, user_prompt, summary, started_at, ended_at FROM sessions WHERE project_path = ? ORDER BY started_at DESC LIMIT 5'
    ).all(opts.project);
    const observations = db.prepare(
      "SELECT id, session_id, type, title, substr(content, 1, 200) as preview, tags, importance, created_at FROM observations WHERE project_path = ? ORDER BY importance DESC, created_at DESC LIMIT 20"
    ).all(opts.project);

    let pack = '# Infinit Memory - Project Context\n\n';
    if (sessions.length) {
      pack += '## Recent Sessions\n';
      for (const s of sessions) {
        const d = s.started_at ? new Date(s.started_at).toLocaleDateString() : '?';
        const st = s.ended_at ? 'done' : 'active';
        pack += '- **' + d + '** (' + st + '): ' + (s.summary || s.user_prompt || 'No summary') + '\n';
      }
      pack += '\n';
    }
    if (observations.length) {
      pack += '## Key Observations\n';
      const byType = {};
      for (const o of observations) { (byType[o.type] = byType[o.type] || []).push(o); }
      for (const [t, obs] of Object.entries(byType)) {
        pack += '### ' + t.charAt(0).toUpperCase() + t.slice(1) + '\n';
        for (const o of obs.slice(0, 5)) {
          let tags = '';
          try { const arr = JSON.parse(o.tags); if (arr.length) tags = ' [' + arr.join(', ') + ']'; } catch {}
          pack += '- ' + (o.title || o.preview) + tags + '\n';
        }
        pack += '\n';
      }
    }
    if (!sessions.length && !observations.length) {
      pack += '_No previous memory for this project yet._\n';
    }
    console.log(pack);
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
      await summarizeSession(db, opts);
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

    let pipe;
    try { pipe = await getEmbedPipeline(); } catch {}

    const insert = db.transaction((arr) => {
      const ids = [];
      for (const item of arr) {
        const r = db.prepare(
          'INSERT INTO observations (session_id, project_path, type, title, content, tags, importance) VALUES (?,?,?,?,?,?,?)'
        ).run(
          item.session_id || null, item.project_path || process.cwd(),
          item.type || 'context', item.title || null, item.content,
          JSON.stringify(item.tags || []), item.importance || 5
        );
        ids.push(Number(r.lastInsertRowid));
      }
      return ids;
    });
    const ids = insert(items);

    if (pipe) {
      console.error('Computing embeddings for ' + ids.length + ' observations...');
      for (const id of ids) {
        const obs = db.prepare('SELECT title, content FROM observations WHERE id = ?').get(id);
        if (obs) {
          try {
            const text = [obs.title || '', obs.content].filter(Boolean).join('. ');
            const result = await pipe(text, { pooling: 'mean', normalize: true });
            db.prepare('UPDATE observations SET embedding = ? WHERE id = ?')
              .run(JSON.stringify(Array.from(result.data)), id);
          } catch {}
        }
      }
    }

    console.log(JSON.stringify({ saved: ids.length, ids, embedded: !!pipe }));
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
          const s = db.prepare('SELECT COUNT(*) as c FROM sessions').get().c;
          const o = db.prepare('SELECT COUNT(*) as c FROM observations').get().c;
          const e = db.prepare('SELECT COUNT(*) as c FROM observations WHERE embedding IS NOT NULL').get().c;
          return json({ status: 'ok', sessions: s, observations: o, embedded: e });
        }
        if (p === '/search') {
          const q = url.searchParams.get('q');
          const proj = url.searchParams.get('project');
          const lim = parseInt(url.searchParams.get('limit') || '10', 10);
          if (!q) return json({ error: 'q required' }, 400);
          const safe = q.replace(/["']/g, '').trim();
          const fts = safe.split(' ').map(w => '"' + w + '"').join(' OR ');
          let r;
          if (proj) {
            r = db.prepare(
              "SELECT o.id, o.project_path, o.type, o.title, substr(o.content,1,200) as preview, o.tags, o.importance, o.confidence, o.provenance, o.created_at, rank FROM observations_fts fts JOIN observations o ON o.id=fts.rowid WHERE observations_fts MATCH ? AND o.project_path=? AND o.is_active=1 ORDER BY rank LIMIT ?"
            ).all(fts, proj, lim);
          } else {
            r = db.prepare(
              "SELECT o.id, o.project_path, o.type, o.title, substr(o.content,1,200) as preview, o.tags, o.importance, o.confidence, o.provenance, o.created_at, rank FROM observations_fts fts JOIN observations o ON o.id=fts.rowid WHERE observations_fts MATCH ? AND o.is_active=1 ORDER BY rank LIMIT ?"
            ).all(fts, lim);
          }
          return json({ results: r, count: r.length });
        }
        if (p === '/observation' && req.method === 'POST') {
          const b = await getBody();
          if (!b.content) return json({ error: 'content required' }, 400);
          let embedding = null;
          try {
            const text = [b.title || '', b.content].filter(Boolean).join('. ');
            const vec = await computeEmbedding(text);
            embedding = JSON.stringify(vec);
          } catch {}
          const r = db.prepare(
            'INSERT INTO observations (session_id, project_path, type, title, content, tags, importance, confidence, provenance, embedding) VALUES (?,?,?,?,?,?,?,?,?,?)'
          ).run(b.session_id||null, b.project_path||process.cwd(), b.type||'observation',
            b.title||null, b.content, JSON.stringify(b.tags||[]), b.importance||5, b.confidence??100, b.provenance||'observed', embedding);
          return json({ id: Number(r.lastInsertRowid), status: 'saved', embedded: !!embedding });
        }
        if (p === '/session/start' && req.method === 'POST') {
          const b = await getBody();
          const sid = b.session_id || 'session-' + Date.now();
          db.prepare('INSERT INTO sessions (session_id, project_path, project_name, user_prompt) VALUES (?,?,?,?)')
            .run(sid, b.project_path||process.cwd(), b.project_name||'unknown', b.user_prompt||'');
          return json({ session_id: sid, status: 'started' });
        }
        if (p === '/session/end' && req.method === 'POST') {
          const b = await getBody();
          db.prepare("UPDATE sessions SET ended_at=datetime('now'), summary=? WHERE session_id=?")
            .run(b.summary||'', b.session_id);
          return json({ status: 'ended' });
        }
        if (p === '/context') {
          const proj = url.searchParams.get('project');
          if (!proj) return json({ error: 'project required' }, 400);
          const s = db.prepare('SELECT * FROM sessions WHERE project_path=? ORDER BY started_at DESC LIMIT 5').all(proj);
          const o = db.prepare(
            "SELECT id, type, title, substr(content,1,200) as preview, tags, importance, confidence, provenance, created_at FROM observations WHERE project_path=? AND is_active=1 ORDER BY importance DESC, created_at DESC LIMIT 20"
          ).all(proj);
          return json({ sessions: s, observations: o });
        }
        if (p === '/shutdown') {
          json({ status: 'shutting down' });
          setTimeout(() => { db.close(); process.exit(0); }, 100);
          return;
        }
        json({ error: 'not found' }, 404);
      } catch (err) { json({ error: err.message }, 500); }
    });
    server.listen(opts.port, '127.0.0.1', () => {
      console.log('[agentic-cortex] HTTP server on http://127.0.0.1:' + opts.port);
    });
    process.on('SIGINT', () => { db.close(); process.exit(0); });
    process.on('SIGTERM', () => { db.close(); process.exit(0); });
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
  run(db, opts) {
    if (isNaN(opts.id)) { console.error('Usage: edit <id> [--title TITLE] [--content CONTENT] [--confidence N] [--importance N]'); process.exit(1); }
    const existing = db.prepare('SELECT * FROM observations WHERE id = ? AND is_active = 1').get(opts.id);
    if (!existing) { console.error('Active observation not found: ' + opts.id); process.exit(1); }

    // Save old version
    db.prepare(
      'INSERT INTO observation_versions (observation_id, version_number, old_title, old_content, old_confidence) VALUES (?, (SELECT COALESCE(MAX(version_number), 0) + 1 FROM observation_versions WHERE observation_id = ?), ?, ?, ?)'
    ).run(existing.id, existing.id, existing.title, existing.content, existing.confidence);

    // Update in place (FTS5 triggers handle index update)
    db.prepare(
      'UPDATE observations SET title = COALESCE(?, title), content = COALESCE(?, content), confidence = COALESCE(?, confidence), importance = COALESCE(?, importance) WHERE id = ?'
    ).run(opts.title || null, opts.content || null, opts.confidence ?? null, opts.importance ?? null, opts.id);

    const updated = db.prepare('SELECT * FROM observations WHERE id = ?').get(opts.id);
    console.log(JSON.stringify({
      id: updated.id, status: 'edited', title: updated.title,
      confidence: updated.confidence, versionCount: db.prepare('SELECT COUNT(*) as c FROM observation_versions WHERE observation_id = ?').get(updated.id).c,
    }));
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
  run(db, opts) {
    if (isNaN(opts.id)) { console.error('Usage: forget <id> [--hard]'); process.exit(1); }
    if (opts.hard) {
      db.prepare('DELETE FROM observation_versions WHERE observation_id = ?').run(opts.id);
      db.prepare('DELETE FROM observations WHERE id = ?').run(opts.id);
      console.log(JSON.stringify({ id: opts.id, status: 'hard_deleted' }));
    } else {
      const r = db.prepare('UPDATE observations SET is_active = 0 WHERE id = ?').run(opts.id);
      if (r.changes === 0) { console.error('Observation not found: ' + opts.id); process.exit(1); }
      console.log(JSON.stringify({ id: opts.id, status: 'forgotten', note: 'Soft-deleted. Use --hard to permanently remove.' }));
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
    const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
    const embedded = db.prepare('SELECT id, type, title, content, confidence, provenance, embedding FROM observations WHERE project_path = ? AND is_active = 1 AND embedding IS NOT NULL ORDER BY id DESC LIMIT ?').all(project, 100);
    if (embedded.length < 2) { console.log(JSON.stringify({ conflicts: [], note: 'Need at least 2 embedded observations to detect conflicts' })); return; }

    const conflicts = [];
    for (let i = 0; i < embedded.length; i++) {
      for (let j = i + 1; j < embedded.length; j++) {
        try {
          const vecA = JSON.parse(embedded[i].embedding);
          const vecB = JSON.parse(embedded[j].embedding);
          const sim = cosineSimilarity(vecA, vecB);
          // High similarity but potentially conflicting types (e.g., two decisions/goals about the same topic)
          if (sim > 0.65) {
            conflicts.push({
              a: { id: embedded[i].id, type: embedded[i].type, title: embedded[i].title, confidence: embedded[i].confidence, preview: embedded[i].content.slice(0, 150) },
              b: { id: embedded[j].id, type: embedded[j].type, title: embedded[j].title, confidence: embedded[j].confidence, preview: embedded[j].content.slice(0, 150) },
              similarity: Math.round(sim * 1000) / 1000,
            });
          }
        } catch {}
      }
    }

    conflicts.sort((a, b) => b.similarity - a.similarity);
    const top = conflicts.slice(0, opts.limit);

    // Optional LLM check for each conflict pair
    if (top.length > 0) {
      console.error('Found ' + conflicts.length + ' potential conflicts. Top ' + top.length + ':');
      for (const c of top) {
        try {
          const llmCheck = await callLLM([
            { role: 'system', content: 'You detect contradictions between two pieces of information. Answer ONLY "YES" or "NO".' },
            { role: 'user', content: 'Do these two observations contradict each other?\nA: ' + c.a.preview + '\nB: ' + c.b.preview },
          ], { temperature: 0, maxTokens: 10, timeout: 30000 });
          c.llm_contradiction = llmCheck && llmCheck.toUpperCase().startsWith('YES');
        } catch { c.llm_contradiction = null; }
      }
    }

    console.log(JSON.stringify({ conflicts: top, totalFound: conflicts.length, project }, null, 2));
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
    const safe = opts.question.replace(/["']/g, '').trim();
    const ftsQuery = safe.split(' ').map(w => '"' + w + '"').join(' OR ');

    let ftsResults = [];
    try {
      ftsResults = db.prepare(
        "SELECT o.id, o.type, o.title, o.content, o.confidence, o.provenance, o.importance, o.created_at, rank FROM observations_fts fts JOIN observations o ON o.id = fts.rowid WHERE observations_fts MATCH ? AND o.project_path = ? AND o.is_active = 1 ORDER BY rank LIMIT ?"
      ).all(ftsQuery, project, opts.topK * 3);
    } catch { /* FTS5 might throw on special chars */ }

    // Semantic reranking if embeddings exist
    let finalResults = ftsResults;
    try {
      const queryVec = await computeEmbedding(opts.question);
      const scored = [];
      for (const r of ftsResults) {
        const embRow = db.prepare('SELECT embedding FROM observations WHERE id = ? AND embedding IS NOT NULL').get(r.id);
        if (embRow) {
          try {
            const vec = JSON.parse(embRow.embedding);
            scored.push({ ...r, semantic_score: cosineSimilarity(queryVec, vec) });
          } catch { scored.push(r); }
        } else { scored.push(r); }
      }
      scored.sort((a, b) => (b.semantic_score || 0) - (a.semantic_score || 0));
      finalResults = scored.slice(0, opts.topK);
    } catch { finalResults = ftsResults.slice(0, opts.topK); }

    if (finalResults.length === 0) {
      console.log(JSON.stringify({ answer: 'No relevant memories found for this question.', sources: [] }));
      return;
    }

    // 2. Build RAG prompt
    const memoryContext = finalResults.map((r, i) =>
      `[${i + 1}] (${r.type}, confidence: ${r.confidence}%, source: ${r.provenance}) ${r.title || ''}: ${r.content}`
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
        sources: finalResults.map(r => ({ id: r.id, type: r.type, title: r.title, content: r.content.slice(0, 300) })),
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
      // JSON: store as single object (compact)
      try { content = JSON.stringify(JSON.parse(content), null, 2); } catch {}
      chunks.push({ title, content: content.slice(0, 12000) });
    } else if (ext === '.csv') {
      // CSV: each row as an observation
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
      // Text/Markdown: chunk by 10K char segments
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

    // Bulk insert
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

    // Check for existing summary
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
      console.error('  vault-path: Path to the Obsidian vault directory');
      console.error('  --project:  Export only observations from a specific project');
      console.error('  --force:    Overwrite existing files');
      process.exit(1);
    }

    const vaultPath = path.resolve(opts.vaultPath);
    const mkdirOpts = { recursive: true };

    // Create vault directory structure
    const dirs = ['sessions', 'decisions', 'context', 'gotchas', 'bugs', 'architecture', 'preferences', 'misc', '_tags'];
    for (const dir of dirs) {
      try { fs.mkdirSync(path.join(vaultPath, dir), mkdirOpts); } catch {}
    }

    // Fetch all sessions
    const sessions = opts.project
      ? db.prepare('SELECT * FROM sessions WHERE project_path = ? ORDER BY started_at DESC').all(opts.project)
      : db.prepare('SELECT * FROM sessions ORDER BY started_at DESC').all();

    // Fetch all observations
    const observations = opts.project
      ? db.prepare('SELECT id, session_id, project_path, type, title, content, tags, importance, created_at FROM observations WHERE project_path = ? ORDER BY created_at DESC').all(opts.project)
      : db.prepare('SELECT id, session_id, project_path, type, title, content, tags, importance, created_at FROM observations ORDER BY created_at DESC').all();

    if (observations.length === 0 && sessions.length === 0) {
      console.log(JSON.stringify({ status: 'empty', message: 'No observations or sessions to export.' }));
      return;
    }

    // ── Helper: sanitize filename ──
    function sanitizeFilename(title, id) {
      const base = (title || 'untitled')
        .replace(/[^a-zA-Z0-9\s\-]/g, '')
        .replace(/\s+/g, '-')
        .toLowerCase()
        .slice(0, 60);
      return (base || 'obs-' + id) + '.md';
    }

    // ── Helper: generate wikilinks for related observations ──
    function findRelated(obs, allObs) {
      // Simple tag-based relatedness
      let obsTags;
      try { obsTags = JSON.parse(obs.tags || '[]'); } catch { obsTags = []; }
      if (obsTags.length === 0) return [];

      const related = [];
      for (const other of allObs) {
        if (other.id === obs.id) continue;
        let otherTags;
        try { otherTags = JSON.parse(other.tags || '[]'); } catch { otherTags = []; }
        const shared = obsTags.filter(t => otherTags.includes(t));
        if (shared.length > 0) {
          related.push({ id: other.id, title: other.title, shared: shared.length });
        }
      }
      related.sort((a, b) => b.shared - a.shared);
      return related.slice(0, 5);
    }

    // ── Export sessions ──
    let sessionsExported = 0;
    for (const session of sessions) {
      const date = session.started_at ? session.started_at.replace(' ', 'T').split('T')[0] : 'unknown';
      const name = session.project_name || 'unknown';
      const filename = (date + '-' + name).replace(/[^a-zA-Z0-9\-]/g, '-').replace(/-+/g, '-').toLowerCase() + '.md';
      const filepath = path.join(vaultPath, 'sessions', filename);

      // Get observations for this session
      const sessionObs = observations.filter(o => o.session_id === session.session_id);

      let content = '---\n';
      content += 'type: session\n';
      content += 'session_id: ' + session.session_id + '\n';
      content += 'project: ' + (session.project_path || '') + '\n';
      content += 'project_name: ' + (session.project_name || '') + '\n';
      content += 'started: ' + (session.started_at || '') + '\n';
      content += 'ended: ' + (session.ended_at || 'active') + '\n';
      content += 'observations: ' + sessionObs.length + '\n';
      content += '---\n\n';
      content += '# Session: ' + (session.user_prompt || session.project_name || 'Unknown') + '\n\n';

      if (session.summary) {
        content += '## Summary\n' + session.summary + '\n\n';
      }

      if (sessionObs.length > 0) {
        content += '## Observations\n';
        for (const obs of sessionObs) {
          const typeEmoji = { decision: '\u2705', bugfix: '\ud83d\udc1b', context: '\ud83d\udcca', gotcha: '\u26a0\ufe0f', architecture: '\ud83c\udfd7\ufe0f', preference: '\u2b50', bug: '\ud83d\udc1b' };
          const emoji = typeEmoji[obs.type] || '\ud83d\udccc';
          content += '- ' + emoji + ' **' + (obs.title || 'Untitled') + '** (ID: ' + obs.id + ', importance: ' + obs.importance + ')\n';
          content += '  ' + obs.content.slice(0, 200) + (obs.content.length > 200 ? '...' : '') + '\n';
        }
        content += '\n';
      }

      // Wikilinks to related observations
      if (sessionObs.length > 0) {
        content += '## Related\n';
        for (const obs of sessionObs.slice(0, 5)) {
          content += '- [[' + sanitizeFilename(obs.title, obs.id).replace('.md', '') + ']]\n';
        }
        content += '\n';
      }

      if (!fs.existsSync(filepath) || opts.force) { if (opts.force && fs.existsSync(filepath)) console.error('Overwriting: ' + filepath);
        fs.writeFileSync(filepath, content, 'utf-8');
        sessionsExported++;
      }
    }

    // ── Export observations by type ──
    const typeFolders = {
      decision: 'decisions',
      bugfix: 'bugs',
      context: 'context',
      gotcha: 'gotchas',
      architecture: 'architecture',
      preference: 'preferences',

    };

    let observationsExported = 0;
    const tagCounts = {};

    for (const obs of observations) {
      const folder = typeFolders[obs.type] || 'misc';
      const filename = sanitizeFilename(obs.title, obs.id);
      const filepath = path.join(vaultPath, folder, filename);

      // Parse tags
      let tags;
      try { tags = JSON.parse(obs.tags || '[]'); } catch { tags = []; }

      // Count tags for index
      for (const tag of tags) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }

      // Find related observations
      const related = findRelated(obs, observations);

      let content = '---\n';
      content += 'id: ' + obs.id + '\n';
      content += 'type: ' + obs.type + '\n';
      content += 'importance: ' + obs.importance + '\n';
      content += 'project: ' + (obs.project_path || '') + '\n';
      content += 'created: ' + (obs.created_at || '') + '\n';
      if (obs.session_id) content += 'session: ' + obs.session_id + '\n';
      if (tags.length > 0) content += 'tags: [' + tags.join(', ') + ']\n';
      content += '---\n\n';
      content += '# ' + (obs.title || 'Untitled') + '\n\n';
      content += '> **Type:** ' + obs.type + ' | **Importance:** ' + obs.importance + '/10 | **ID:** ' + obs.id + '\n\n';
      content += obs.content + '\n';

      // Add wikilinks to related observations
      if (related.length > 0) {
        content += '\n## Related Observations\n';
        for (const r of related) {
          content += '- [[' + sanitizeFilename(r.title, r.id).replace('.md', '') + ']] (shared tags: ' + r.shared + ')\n';
        }
        content += '\n';
      }

      // Backlink to session
      if (obs.session_id) {
        const session = sessions.find(s => s.session_id === obs.session_id);
        if (session) {
          const date = session.started_at ? session.started_at.replace(' ', 'T').split('T')[0] : 'unknown';
          const name = session.project_name || 'unknown';
          const sessionFile = (date + '-' + name).replace(/[^a-zA-Z0-9\-]/g, '-').replace(/-+/g, '-').toLowerCase();
          content += '## Session\n';
          content += '- [[' + session + ']]\n\n';
        }
      }

      if (!fs.existsSync(filepath) || opts.force) { if (opts.force && fs.existsSync(filepath)) console.error('Overwriting: ' + filepath);
        fs.writeFileSync(filepath, content, 'utf-8');
        observationsExported++;
      }
    }

    // ── Generate tag index pages ──
    for (const [tag, count] of Object.entries(tagCounts)) {
      const tagObs = observations.filter(o => {
        let t; try { t = JSON.parse(o.tags || '[]'); } catch { t = []; }
        return t.includes(tag);
      });

      let content = '---\n';
      content += 'type: tag-index\n';
      content += 'tag: ' + tag + '\n';
      content += 'count: ' + count + '\n';
      content += '---\n\n';
      content += '# Tag: ' + tag + '\n\n';
      content += '> ' + count + ' observations tagged with **' + tag + '**\n\n';

      for (const obs of tagObs) {
        const folder = typeFolders[obs.type] || 'misc';
        content += '- [[' + sanitizeFilename(obs.title, obs.id).replace('.md', '') + ']] (' + obs.type + ', importance: ' + obs.importance + ')\n';
      }
      content += '\n';

      const tagFile = path.join(vaultPath, '_tags', tag.replace(/[^a-zA-Z0-9\-]/g, '-').toLowerCase() + '.md');
      fs.writeFileSync(tagFile, content, 'utf-8');
    }

    // ── Generate master index ──
    const typeCounts = {};
    for (const obs of observations) {
      typeCounts[obs.type] = (typeCounts[obs.type] || 0) + 1;
    }

    const projectSet = new Set(observations.map(o => o.project_path).filter(Boolean));

    let index = '---\n';
    index += 'type: index\n';
    index += 'generated: ' + new Date().toISOString() + '\n';
    index += 'total_observations: ' + observations.length + '\n';
    index += 'total_sessions: ' + sessions.length + '\n';
    index += '---\n\n';
    index += '# Infinit Memory Index\n\n';
    index += '> Auto-generated by agentic-cortex. ' + observations.length + ' observations across ' + projectSet.size + ' projects.\n\n';

    index += '## Stats\n';
    index += '| Metric | Value |\n';
    index += '|--------|-------|\n';
    index += '| Observations | ' + observations.length + ' |\n';
    index += '| Sessions | ' + sessions.length + ' |\n';
    index += '| Projects | ' + projectSet.size + ' |\n';
    index += '| Tags | ' + Object.keys(tagCounts).length + ' |\n\n';

    index += '## By Type\n';
    for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
      index += '- **' + type + '**: ' + count + ' observations\n';
    }
    index += '\n';

    index += '## Top Tags\n';
    const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 20);
    for (const [tag, count] of topTags) {
      index += '- [[' + tag.replace(/[^a-zA-Z0-9\-]/g, '-').toLowerCase() + '|' + tag + ']] (' + count + ')\n';
    }
    index += '\n';

    index += '## Recent Sessions\n';
    for (const session of sessions.slice(0, 10)) {
      const date = session.started_at ? session.started_at.split('T')[0] : '?';
      const st = session.ended_at ? 'done' : 'active';
      const name = session.project_name || 'unknown';
      const sessionFile = (date + '-' + name).replace(/[^a-zA-Z0-9\-]/g, '-').replace(/-+/g, '-').toLowerCase();
      index += '- [[' + sessionFile + '|' + date + ' ' + name + ']] (' + st + ')\n';
    }
    index += '\n';

    index += '## Recent Observations\n';
    for (const obs of observations.slice(0, 20)) {
      const folder = typeFolders[obs.type] || 'misc';
      index += '- [[' + sanitizeFilename(obs.title, obs.id).replace('.md', '') + '|' + (obs.title || 'Untitled') + ']] (' + obs.type + ', \u2b50' + obs.importance + ')\n';
    }
    index += '\n';

    fs.writeFileSync(path.join(vaultPath, '_index.md'), index, 'utf-8');

    // ── Summary ──
    console.log(JSON.stringify({
      status: 'done',
      vault: vaultPath,
      exported: {
        sessions: sessionsExported,
        observations: observationsExported,
        tags: Object.keys(tagCounts).length,
      },
      total: {
        sessions: sessions.length,
        observations: observations.length,
      },
    }, null, 2));
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
      const minimal = '# Codebuff Agent Memory Instructions\n\n## Persistent Memory\n\nUse `agentic-cortex save` to persist observations.\nAt session start, check below for injected context.\n\n<!-- MEMORY_CONTEXT_START -->\n<!-- MEMORY_CONTEXT_END -->\n';
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
        for (const hookName of ['post-merge', 'post-checkout', 'post-rewrite']) {
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
    const hookNames = ['post-merge', 'post-checkout', 'post-rewrite'];

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
      // status
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
      // inject-memory.mjs writes to stderr, capture stdout even on error
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
  console.log('agentic-cortex v3.0 — Persistent memory for AI coding agents\n');
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
    if (cmd !== 'serve') db.close();
  }
}

main();
