/**
 * code-index.js — Symbol-level code knowledge engine (v7).
 *
 * Takes the deterministic codebase graph produced by scripts/generate-graph.mjs
 * (.infinit-graph.json) and turns it into a queryable, persistent, symbol-level
 * index stored in SQLite. Powers:
 *
 *   1. Task-scoped subgraph injection — bootstrap injects REAL symbol bodies
 *      for the files relevant to the current task (transitive import closure),
 *      not just a static top-N map. Budget scales with task scope, not project size.
 *   2. Semantic code-symbol retrieval — symbols are embedded (BGE) and hybrid
 *      searched by meaning, not just name.
 *   3. Change-aware ingestion — git diff parsing keeps the index in sync as the
 *      codebase grows (post-commit/post-merge hooks).
 *   4. Distilled one-line summaries — LLM-generated (or docstring fallback),
 *      cached per symbol, invalidated by body fingerprint.
 *
 * No LLM is required for the core path: ingestion and retrieval are pure
 * deterministic SQL + static analysis. LLM is only used for optional distilled
 * summaries.
 *
 * @module core/code-index
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');
const { computeEmbedding, cosineSimilarity, embeddingsEnabled, forceEmbeddingsEnabled } = require('./embedding');
const { callLLM } = require('./session');

/** Graph cache filename (same as scripts/generate-graph.mjs) */
const GRAPH_FILENAME = '.infinit-graph.json';

/** Token estimate: ~4 chars per token (project-wide convention). */
const CHARS_PER_TOKEN = 4;

/** Source extensions eligible for symbol indexing. */
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.py', '.prisma']);

/** Max body chars kept per symbol (matches generator). */
const MAX_BODY_CHARS = 2000;

/** Fallback one-line summary when no LLM/doc is available. */
function _fallbackSummary(sym) {
  if (sym.doc) {
    const firstSentence = sym.doc.split(/(?<=[.!?])\s+/)[0];
    if (firstSentence && firstSentence.length > 8) return firstSentence.slice(0, 160);
  }
  if (sym.signature) {
    return sym.signature.split('{')[0].trim().slice(0, 160) || sym.name;
  }
  return sym.name;
}

/** Escape text for safe inclusion in XML. */
function _xmlEscape(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** SHA-256 fingerprint of a symbol body (16 hex chars). */
function _bodyHash(body) {
  return createHash('sha256').update(body || '').digest('hex').slice(0, 16);
}

/** Resolve the .infinit-graph.json path for a project. */
function getGraphPath(project) {
  return path.join(project, GRAPH_FILENAME);
}

/** Load the graph cache JSON. Returns null if missing/unreadable. */
function loadGraph(project) {
  try {
    const p = getGraphPath(project);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Regenerate the codebase graph by invoking the deterministic generator.
 * Returns the fresh graph JSON (or null on failure). Used when the cache is
 * missing and by diff-based ingestion.
 *
 * @param {string} project - Project root (cwd for the generator)
 * @param {Object} [opts] - { onlyFiles?: string[], skipCache?: boolean, timeoutMs?: number }
 * @returns {Object|null} Parsed graph JSON
 */
function regenerateGraph(project, opts = {}) {
  const script = path.join(__dirname, '..', '..', 'scripts', 'generate-graph.mjs');
  if (!fs.existsSync(script)) return null;
  const args = [script, '--output', 'json'];
  if (opts.skipCache) args.push('--skip-cache');
  if (opts.onlyFiles && opts.onlyFiles.length > 0) {
    args.push('--only-files', opts.onlyFiles.join(','));
  }
  try {
    const out = execFileSync(process.execPath, args, {
      cwd: project,
      encoding: 'utf-8',
      timeout: opts.timeoutMs || 60000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/**
 * Upsert symbols from the graph JSON into the code_symbols table.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project - Absolute project path
 * @param {Object} [opts] - { graph?, onlyFiles?, regenerate? }
 * @returns {{ status: string, project: string, symbols: number, files: number, inserted: number, updated: number }}
 */
function ingestProject(db, project, opts = {}) {
  opts = opts || {};
  const projectPath = path.resolve(project);
  let graph = opts.graph || loadGraph(projectPath);

  // Lazy regeneration if the cache is missing
  if (!graph && opts.regenerate !== false) {
    graph = regenerateGraph(projectPath, { onlyFiles: opts.onlyFiles });
  }
  if (!graph || !graph.graph || typeof graph.graph !== 'object') {
    return { status: 'no-graph', project: projectPath, symbols: 0, files: 0, inserted: 0, updated: 0 };
  }

  const allFiles = Object.keys(graph.graph);
  const targetFiles = opts.onlyFiles && opts.onlyFiles.length > 0
    ? allFiles.filter(f => opts.onlyFiles.includes(f))
    : allFiles;

  const upsert = db.prepare(`
    INSERT INTO code_symbols (project_path, file_path, symbol_name, kind, signature, doc, summary, body, body_hash, role, layer, imports, exports, updated_at)
    VALUES (@project, @file, @name, @kind, @signature, @doc, NULL, @body, @bodyHash, @role, @layer, @imports, @exports, datetime('now'))
    ON CONFLICT(project_path, file_path, symbol_name, kind) DO UPDATE SET
      signature = excluded.signature,
      doc = excluded.doc,
      body = excluded.body,
      body_hash = excluded.body_hash,
      role = excluded.role,
      layer = excluded.layer,
      imports = excluded.imports,
      exports = excluded.exports,
      summary = COALESCE(code_symbols.summary, excluded.summary),
      updated_at = datetime('now')
    WHERE code_symbols.body_hash IS NOT excluded.body_hash
  `);

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let symbolCount = 0;

  // Pre-fetch existing hashes so insert-vs-update is classified precisely
  // (better-sqlite3's changes() can't distinguish an upsert insert from update).
  const existingByFile = new Map();
  if (targetFiles.length > 0) {
    const placeholders = targetFiles.map(() => '?').join(',');
    const existingRows = db.prepare(
      'SELECT file_path, symbol_name, kind, body_hash FROM code_symbols WHERE project_path = ? AND file_path IN (' + placeholders + ')'
    ).all(projectPath, ...targetFiles);
    for (const r of existingRows) {
      if (!existingByFile.has(r.file_path)) existingByFile.set(r.file_path, new Map());
      existingByFile.get(r.file_path).set(r.symbol_name + '\u0000' + r.kind, r.body_hash);
    }
  }

  for (const filePath of targetFiles) {
    const node = graph.graph[filePath];
    if (!node || !node.symbols || node.symbols.length === 0) continue;
    const fileExisting = existingByFile.get(filePath) || new Map();
    for (const s of node.symbols) {
      const body = (s.body || '').slice(0, MAX_BODY_CHARS);
      const key = s.name + '\u0000' + (s.kind || 'function');
      const hash = _bodyHash(body);
      upsert.run({
        project: projectPath,
        file: filePath,
        name: s.name,
        kind: s.kind || 'function',
        signature: s.signature || null,
        doc: s.doc || null,
        body,
        bodyHash: hash,
        role: node.role || null,
        layer: node.layer || null,
        imports: JSON.stringify(node.imports || []),
        exports: JSON.stringify(node.exports || []),
      });
      symbolCount++;
      if (!fileExisting.has(key)) inserted++;
      else if (fileExisting.get(key) !== hash) updated++;
      else unchanged++;
    }
  }

  // Drop symbols for files that no longer exist in the graph (full ingest only)
  if (!opts.onlyFiles && allFiles.length > 0) {
    const placeholders = allFiles.map(() => '?').join(',');
    db.prepare(
      'DELETE FROM code_symbols WHERE project_path = ? AND file_path NOT IN (' + placeholders + ')'
    ).run(projectPath, ...allFiles);
  }

  return {
    status: 'ok',
    project: projectPath,
    symbols: symbolCount,
    files: targetFiles.length,
    inserted,
    updated,
    unchanged,
  };
}

/**
 * Compute embeddings for symbols missing them (semantic retrieval support).
 * Falls back gracefully when the embedding model is unavailable.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @param {Object} [opts] - { limit?, force? }
 * @returns {Promise<{ embedded: number, failed: number, total: number }>}
 */
async function embedSymbols(db, project, opts = {}) {
  opts = opts || {};
  const projectPath = path.resolve(project);
  const limit = opts.limit || 500;
  const rows = opts.force
    ? db.prepare('SELECT id, symbol_name, signature, doc, summary FROM code_symbols WHERE project_path = ? LIMIT ?').all(projectPath, limit)
    : db.prepare('SELECT id, symbol_name, signature, doc, summary FROM code_symbols WHERE project_path = ? AND embedding IS NULL LIMIT ?').all(projectPath, limit);

  let embedded = 0;
  let failed = 0;
  const update = db.prepare('UPDATE code_symbols SET embedding = ? WHERE id = ?');

  for (const row of rows) {
    const text = [row.symbol_name, row.signature, row.doc, row.summary]
      .filter(Boolean).join('\n').slice(0, 800);
    try {
      const vec = await computeEmbedding(text);
      update.run(JSON.stringify(vec), row.id);
      embedded++;
    } catch {
      failed++;
    }
  }

  return { embedded, failed, total: rows.length };
}

/**
 * Keyword search over code symbols using FTS5.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} query
 * @param {Object} [opts] - { project?, limit?, includeBody? }
 * @returns {Array<Object>}
 */
function keywordSymbolSearch(db, query, opts = {}) {
  const projectPath = path.resolve(opts.project || process.cwd());
  const limit = opts.limit || 10;
  const safe = String(query || '').replace(/["']/g, '').trim();
  if (!safe) return [];

  const ftsQuery = safe.split(/\s+/).map(w => '"' + w.replace(/[^\w.-]/g, '') + '"').filter(Boolean).join(' OR ');
  if (!ftsQuery) return [];

  const bodySelect = opts.includeBody ? ', cs.body' : ', substr(cs.body, 1, 400) as body_preview';
  const sql =
    'SELECT cs.id, cs.file_path, cs.symbol_name, cs.kind, cs.signature, cs.summary, cs.doc, cs.role, cs.layer, rank' + bodySelect + ' ' +
    'FROM code_symbols_fts fts JOIN code_symbols cs ON cs.id = fts.rowid ' +
    'WHERE code_symbols_fts MATCH ? AND cs.project_path = ? ORDER BY rank LIMIT ?';
  try {
    return db.prepare(sql).all(ftsQuery, projectPath, limit);
  } catch (err) {
    console.error('[code-index] FTS5 symbol search error:', err.message);
    return [];
  }
}

/**
 * Semantic search over embedded symbols.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number[]} queryVec
 * @param {Object} [opts] - { project?, limit?, includeBody? }
 * @returns {Array<Object>}
 */
function semanticSymbolSearch(db, queryVec, opts = {}) {
  const projectPath = path.resolve(opts.project || process.cwd());
  const limit = opts.limit || 10;
  const candidateIds = db.prepare(
    'SELECT id FROM code_symbols WHERE project_path = ? AND embedding IS NOT NULL LIMIT 500'
  ).all(projectPath).map(r => r.id);
  if (candidateIds.length === 0) return [];

  const placeholders = candidateIds.map(() => '?').join(',');
  const rows = db.prepare(
    'SELECT id, file_path, symbol_name, kind, signature, summary, doc, role, layer, embedding' +
    (opts.includeBody ? ', body' : ', substr(body, 1, 400) as body_preview') +
    ' FROM code_symbols WHERE id IN (' + placeholders + ')'
  ).all(...candidateIds);

  const scored = [];
  for (const row of rows) {
    try {
      const vec = JSON.parse(row.embedding);
      scored.push({ ...row, semantic_score: cosineSimilarity(queryVec, vec) });
    } catch { /* unparseable embedding — skip */ }
  }
  scored.sort((a, b) => b.semantic_score - a.semantic_score);
  return scored.slice(0, limit).map(r => ({
    ...r,
    embedding: undefined,
    semantic_score: Math.round(r.semantic_score * 1000) / 1000,
  }));
}

/**
 * Hybrid symbol search: FTS5 keyword + semantic cosine, merged 0.4/0.6.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} query
 * @param {Object} [opts] - { project?, limit?, includeBody?, semantic? }
 * @returns {Promise<Array<Object>>}
 */
async function searchSymbols(db, query, opts = {}) {
  const limit = opts.limit || 10;
  const ftsResults = keywordSymbolSearch(db, query, { ...opts, limit });

  // Semantic pass ONLY when embeddings are enabled. Default is keyword-only:
  // the ~400MB embedding model must never be auto-loaded by a search.
  let semanticResults = [];
  if (opts.semantic !== false && embeddingsEnabled()) {
    try {
      const queryVec = await computeEmbedding(String(query || '')).catch(() => null);
      if (queryVec) {
        semanticResults = semanticSymbolSearch(db, queryVec, { ...opts, limit });
      }
    } catch { /* embeddings unavailable */ }
  }

  let results;
  if (semanticResults.length === 0) {
    results = ftsResults;
  } else {
    // Merge: FTS results keep their rank; semantic-only results get ranked after.
    const merged = [];
    const seen = new Set();
    for (const r of ftsResults) {
      merged.push(r);
      seen.add(r.id);
    }
    for (const r of semanticResults) {
      if (seen.has(r.id)) continue;
      merged.push(r);
    }
    results = merged.slice(0, limit);
  }

  // Feedback loop: every retrieved symbol counts toward future weighting.
  recordSymbolAccess(db, projectOf(opts), results);
  return results;
}

/** Resolve a project path from opts (for access tracking). */
function projectOf(opts) {
  return path.resolve(opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd());
}

/**
 * Record that symbols were retrieved/used: bump access_count and touch
 * last_accessed_at. Accepts DB rows (with id) or { symbol_name, file_path, kind }.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project - Project path
 * @param {Array<Object>} rows - Retrieved symbol rows
 * @returns {number} Number of rows updated
 */
function recordSymbolAccess(db, project, rows) {
  if (!rows || rows.length === 0) return 0;
  const projectPath = path.resolve(project);
  const update = db.prepare(
    'UPDATE code_symbols SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = datetime(\'now\') ' +
    'WHERE project_path = ? AND id = ?'
  );
  const updateByKey = db.prepare(
    'UPDATE code_symbols SET access_count = COALESCE(access_count, 0) + 1, last_accessed_at = datetime(\'now\') ' +
    'WHERE project_path = ? AND file_path = ? AND symbol_name = ? AND kind = ?'
  );
  let updated = 0;
  const seen = new Set();
  for (const r of rows) {
    const key = r.id != null ? 'id:' + r.id : r.file_path + ':' + r.symbol_name + ':' + (r.kind || 'function');
    if (seen.has(key)) continue; // de-dupe within one retrieval batch
    seen.add(key);
    try {
      const changes = r.id != null
        ? update.run(projectPath, r.id).changes
        : updateByKey.run(projectPath, r.file_path, r.symbol_name, r.kind || 'function').changes;
      if (changes > 0) updated++;
    } catch { /* row may not exist — skip */ }
  }
  return updated;
}

/**
 * Most-retrieved symbols for a project (the "frequently-needed code" signal).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @param {Object} [opts] - { limit?, withBody? }
 * @returns {Array<Object>}
 */
function getTopSymbols(db, project, opts = {}) {
  const projectPath = path.resolve(project);
  const limit = opts.limit || 10;
  const bodySelect = opts.withBody ? ', body' : ', substr(body, 1, 300) as body_preview';
  return db.prepare(
    'SELECT id, file_path, symbol_name, kind, signature, summary, doc, access_count, last_accessed_at' + bodySelect + ' ' +
    'FROM code_symbols WHERE project_path = ? AND access_count > 0 ' +
    'ORDER BY access_count DESC, last_accessed_at DESC LIMIT ?'
  ).all(projectPath, limit);
}

/**
 * Score a file's relevance to a working-on description. Path matches dominate
 * (a file NAMED embedding.js IS the embedding code), then symbol/export name
 * matches, then doc mentions as a weak tiebreaker.
 */
function _scoreFileRelevance(filePath, node, workingWords) {
  if (!workingWords || workingWords.length === 0) return 0;
  const pathLower = filePath.toLowerCase();
  const symbols = (node.symbols || []).slice(0, 40);
  const nameText = [...(node.exports || []), ...symbols.map(s => s.name)].join(' ').toLowerCase();
  const docText = symbols.map(s => (s.doc || '').slice(0, 80)).join(' ').toLowerCase();

  let score = 0;
  for (const w of workingWords) {
    if (w.length < 3) continue;
    if (pathLower.includes(w)) score += 3;
    else if (nameText.includes(w)) score += 1.5;
    if (docText.includes(w)) score += 0.3;
  }
  return score;
}

/**
 * Compute the transitive import closure (and reverse edges) for a seed set of
 * files, using the graph's import edges. Returns a Set of file paths.
 *
 * @param {Object} graph - Graph JSON
 * @param {string[]} seeds - Relative file paths
 * @param {Object} [opts] - { depth?, maxFiles? }
 * @returns {Set<string>}
 */
function expandImportClosure(graph, seeds, opts = {}) {
  const depth = opts.depth || 2;
  const maxFiles = opts.maxFiles || 30;
  const selected = new Set(seeds);
  const graphNodes = graph.graph || {};

  // Resolve a relative import to a graph key (best-effort, mirrors generator)
  const resolveImport = (imp, fromFile) => {
    if (!imp) return null;
    if (imp.startsWith('@/')) {
      const candidate = 'src/' + imp.slice(2);
      for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts']) {
        if (graphNodes[candidate + ext]) return candidate + ext;
        if (graphNodes[candidate + ext + '/index.ts']) return candidate + ext + '/index.ts';
      }
      return null;
    }
    if (!imp.startsWith('.')) return null;
    const base = path.posix.dirname(fromFile);
    const candidate = path.posix.normalize(path.posix.join(base, imp));
    for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts']) {
      if (graphNodes[candidate + ext]) return candidate + ext;
      if (graphNodes[candidate + ext + '/index.ts']) return candidate + ext + '/index.ts';
      if (graphNodes[candidate + ext + '/index.js']) return candidate + ext + '/index.js';
    }
    return null;
  };

  // Outward: files imported by seeds (dependencies)
  for (let d = 0; d < depth && selected.size < maxFiles; d++) {
    const frontier = [...selected];
    for (const f of frontier) {
      const node = graphNodes[f];
      if (!node) continue;
      for (const imp of node.imports || []) {
        const resolved = resolveImport(imp, f);
        if (resolved && !selected.has(resolved)) {
          selected.add(resolved);
        }
        if (selected.size >= maxFiles) break;
      }
      if (selected.size >= maxFiles) break;
    }
  }

  // Inward: files that import seeds (callers) — one hop, keep it small
  const reverse = [];
  for (const [f, node] of Object.entries(graphNodes)) {
    if (selected.has(f)) continue;
    if (selected.size >= maxFiles) break;
    for (const imp of node.imports || []) {
      const resolved = resolveImport(imp, f);
      if (resolved && selected.has(resolved)) {
        reverse.push(f);
        break;
      }
    }
  }
  for (const f of reverse) selected.add(f);

  return selected;
}

/**
 * Task-scoped symbol retrieval: pick files relevant to `workingOn`, expand via
 * the import closure, fetch their symbols, and budget-cap the result so it fits
 * in the context window. Returns symbols (with real bodies) plus stats.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @param {string} workingOn - What the agent is working on
 * @param {number} [tokenBudget=1200] - Approximate token cap for the block
 * @param {Object} [opts] - { topFiles?, depth?, maxFiles?, includeBody? }
 * @returns {{ symbols: Array<Object>, files: string[], stats: Object }}
 */
function getTaskScopedSymbols(db, project, workingOn, tokenBudget = 1200, opts = {}) {
  opts = opts || {};
  const projectPath = path.resolve(project);
  const topFiles = opts.topFiles || 6;
  const maxFiles = opts.maxFiles || 24;
  const includeBody = opts.includeBody !== false;
  const maxChars = Math.max(200, tokenBudget * CHARS_PER_TOKEN);

  // Accept an injected graph (tests, callers that already hold it); otherwise disk
  const graph = opts.graph || loadGraph(projectPath);
  const empty = { symbols: [], files: [], stats: { files: 0, symbols: 0, chars: 0, tokenBudget } };
  if (!graph || !graph.graph) return empty;

  const workingWords = String(workingOn || '').toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);

  // 1. Score all files
  const scored = [];
  for (const [filePath, node] of Object.entries(graph.graph)) {
    const score = _scoreFileRelevance(filePath, node, workingWords);
    if (score > 0) scored.push({ filePath, score });
  }
  scored.sort((a, b) => b.score - a.score);

  // 2. Seed files: top relevance matches; when the task matches nothing, fall
  //    back to the MOST-RETRIEVED files (usage feedback) so frequently-needed
  //    code still gets injected, then most-connected hub files.
  let seeds;
  if (scored.length > 0) {
    seeds = scored.slice(0, topFiles).map(s => s.filePath);
  } else {
    const byUsage = db.prepare(
      'SELECT file_path FROM code_symbols WHERE project_path = ? AND access_count > 0 ' +
      'GROUP BY file_path ORDER BY SUM(access_count) DESC, MAX(last_accessed_at) DESC LIMIT ?'
    ).all(projectPath, topFiles).map(r => r.file_path);
    seeds = byUsage.filter(p => graph.graph[p]);
    if (seeds.length === 0) {
      seeds = (graph.layerMap && graph.layerMap.hubFiles || [])
        .slice(0, topFiles)
        .map(h => h.path)
        .filter(p => graph.graph[p]);
    }
    if (seeds.length === 0) {
      seeds = Object.entries(graph.graph)
        .sort(([, a], [, b]) => (b.imports || []).length - (a.imports || []).length)
        .slice(0, topFiles)
        .map(([p]) => p);
    }
  }

  // 3. Expand with import closure
  const selectedFiles = expandImportClosure(graph, seeds, { depth: opts.depth, maxFiles });

  // 4. Fetch symbols for selected files. Order files by relevance, then by
  //    accumulated usage (access_count) — frequently-needed code wins ties.
  const fileScore = new Map(scored.map(s => [s.filePath, s.score]));
  const fileUsage = new Map();
  for (const f of selectedFiles) {
    const u = db.prepare(
      'SELECT COALESCE(SUM(access_count), 0) as u FROM code_symbols WHERE project_path = ? AND file_path = ?'
    ).get(projectPath, f).u;
    fileUsage.set(f, u);
  }
  const fileList = [...selectedFiles].sort((a, b) => {
    const sa = fileScore.get(a) || 0;
    const sb = fileScore.get(b) || 0;
    if (sa !== sb) return sb - sa;
    const ua = fileUsage.get(a) || 0;
    const ub = fileUsage.get(b) || 0;
    if (ua !== ub) return ub - ua;
    return a.localeCompare(b);
  });

  const rows = [];
  for (const f of fileList.slice(0, maxFiles)) {
    const fileRows = db.prepare(
      'SELECT id, file_path, symbol_name, kind, signature, doc, summary, body, role, layer, access_count, last_accessed_at ' +
      'FROM code_symbols WHERE project_path = ? AND file_path = ? ORDER BY ' +
      "(CASE kind WHEN 'class' THEN 0 WHEN 'function' THEN 1 WHEN 'method' THEN 2 ELSE 3 END), access_count DESC, last_accessed_at DESC"
    ).all(projectPath, f);
    rows.push(...fileRows);
  }

  // 5. Budget cap: include signature/doc always, body when room remains.
  //    Cap symbols per file so the budget spreads across the subgraph instead
  //    of being consumed by one large file.
  const symbolsPerFile = opts.symbolsPerFile || 4;
  const symbols = [];
  const includedIds = [];
  let usedChars = 0;
  const headerPer = (r) => (r.signature || '').length + (r.doc || '').length + (r.summary || '').length + 60;
  const ordered = rows.sort((a, b) => {
    const sa = fileScore.get(a.file_path) || 0;
    const sb = fileScore.get(b.file_path) || 0;
    if (sa !== sb) return sb - sa;
    const ua = a.access_count || 0;
    const ub = b.access_count || 0;
    if (ua !== ub) return ub - ua;
    return a.file_path.localeCompare(b.file_path);
  });
  const perFileCount = new Map();

  for (const r of ordered) {
    const fileUsed = perFileCount.get(r.file_path) || 0;
    if (fileUsed >= symbolsPerFile) continue;
    const head = headerPer(r);
    let bodyText = '';
    if (includeBody && r.body && usedChars + head + Math.min(r.body.length, 400) <= maxChars) {
      // Include as much of the body as fits
      const budgetForBody = Math.max(0, maxChars - usedChars - head);
      bodyText = (r.body || '').slice(0, Math.min(r.body.length, budgetForBody));
    }
    const cost = head + bodyText.length;
    if (usedChars + cost > maxChars && symbols.length >= 3) break;
    symbols.push({
      file_path: r.file_path,
      symbol_name: r.symbol_name,
      kind: r.kind,
      signature: r.signature || '',
      doc: r.doc || '',
      summary: r.summary || '',
      body: bodyText || (includeBody ? (r.body || '').slice(0, 200) : ''),
      role: r.role || '',
      layer: r.layer || '',
    });
    if (r.id != null) includedIds.push(r.id);
    perFileCount.set(r.file_path, fileUsed + 1);
    usedChars += cost;
  }

  // Feedback loop: symbols actually injected into context count as "used".
  if (includedIds.length > 0) {
    recordSymbolAccess(db, projectPath, includedIds.map(id => ({ id })));
  }

  return {
    symbols,
    files: fileList,
    stats: {
      files: fileList.length,
      symbols: symbols.length,
      chars: usedChars,
      tokenBudget,
      estimatedTokens: Math.ceil(usedChars / CHARS_PER_TOKEN),
    },
  };
}

/**
 * Render retrieved symbols as a compact XML block for context injection.
 *
 * @param {Array<Object>} symbols - From getTaskScopedSymbols / searchSymbols
 * @param {Object} [opts] - { maxBodyChars? }
 * @returns {string} XML string
 */
function renderSymbolsXML(symbols, opts = {}) {
  if (!symbols || symbols.length === 0) return '';
  const maxBodyChars = opts.maxBodyChars || 600;
  let xml = `<code_symbols count="${symbols.length}">\n`;
  for (const s of symbols) {
    xml += `  <symbol file="${_xmlEscape(s.file_path)}" name="${_xmlEscape(s.symbol_name)}" kind="${_xmlEscape(s.kind || 'function')}">\n`;
    if (s.signature) xml += `    <signature>${_xmlEscape(s.signature)}</signature>\n`;
    if (s.summary) xml += `    <summary>${_xmlEscape(s.summary)}</summary>\n`;
    if (s.doc) xml += `    <doc>${_xmlEscape(s.doc.slice(0, 200))}</doc>\n`;
    if (s.body) xml += `    <body>${_xmlEscape(s.body.slice(0, maxBodyChars))}</body>\n`;
    xml += '  </symbol>\n';
  }
  xml += '</code_symbols>';
  return xml;
}

/**
 * One-stop context block for bootstrap: lazy-ingests the index if empty, then
 * returns task-scoped symbols as XML.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @param {string} workingOn
 * @param {number} [tokenBudget=1200]
 * @returns {string} XML block ('' when nothing indexed)
 */
function getCodeContext(db, project, workingOn, tokenBudget = 1200) {
  const projectPath = path.resolve(project);
  try {
    const count = db.prepare(
      'SELECT COUNT(*) as c FROM code_symbols WHERE project_path = ?'
    ).get(projectPath).c;
    if (count === 0) {
      ingestProject(db, projectPath, { regenerate: true, timeoutMs: 30000 });
    }
    const scoped = getTaskScopedSymbols(db, projectPath, workingOn, tokenBudget);
    return renderSymbolsXML(scoped.symbols);
  } catch (err) {
    console.error('[code-index] getCodeContext failed:', err.message);
    return '';
  }
}

/**
 * Generate distilled one-line summaries for symbols missing them.
 * Uses the local LLM (llama.cpp) when available; falls back to the docstring's
 * first sentence, then the signature. Cached per symbol; re-runs only for
 * symbols without a summary.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @param {Object} [opts] - { limit?, force? }
 * @returns {Promise<{ summarized: number, fallback: number, skipped: number }>}
 */
async function summarizeSymbols(db, project, opts = {}) {
  opts = opts || {};
  const projectPath = path.resolve(project);
  const limit = opts.limit || 60;
  const rows = opts.force
    ? db.prepare('SELECT id, symbol_name, signature, doc, body FROM code_symbols WHERE project_path = ? LIMIT ?').all(projectPath, limit)
    : db.prepare('SELECT id, symbol_name, signature, doc, body FROM code_symbols WHERE project_path = ? AND summary IS NULL LIMIT ?').all(projectPath, limit);

  let summarized = 0;
  let fallback = 0;
  const update = db.prepare('UPDATE code_symbols SET summary = ? WHERE id = ?');

  for (const row of rows) {
    // Deterministic fallback first — cheap and always available
    const fb = _fallbackSummary(row);
    if (!fb) {
      update.run(row.symbol_name, row.id);
      fallback++;
      continue;
    }

    // Try LLM once; on failure keep the fallback
    let summary = null;
    try {
      const prompt =
        'You are a code summarizer. Given one code symbol, reply with a single concise line (max 20 words) ' +
        'describing what it does and why it matters. No markdown, no preamble.\n\n' +
        'SYMBOL: ' + row.symbol_name + '\n' +
        (row.signature ? 'SIGNATURE: ' + row.signature + '\n' : '') +
        (row.doc ? 'DOC: ' + row.doc + '\n' : '') +
        (row.body ? 'BODY:\n' + row.body.slice(0, 600) : '');
      const res = await callLLM([
        { role: 'system', content: 'You write ultra-compact one-line code summaries.' },
        { role: 'user', content: prompt },
      ], { temperature: 0.1, maxTokens: 60, timeout: 15000 });
      const cleaned = String(res || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\s+/g, ' ').trim();
      if (cleaned && cleaned.length > 4 && cleaned.length < 200) {
        summary = cleaned;
        summarized++;
      }
    } catch { /* LLM unavailable */ }

    update.run(summary || fb, row.id);
    if (!summary) fallback++;
  }

  return { summarized, fallback, skipped: Math.max(0, rows.length - summarized - fallback) };
}

/**
 * Get changed source files for a project via git. Unions the last commit's diff
 * with working-tree changes. Falls back to all tracked files on first commit.
 *
 * @param {string} project
 * @returns {string[]} Relative file paths
 */
function gitChangedFiles(project) {
  const git = (args) => {
    try {
      return execFileSync('git', args, {
        cwd: project,
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).split('\n').map(s => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  };

  const files = new Set();
  for (const f of git(['diff', '--name-only', 'HEAD~1', 'HEAD'])) files.add(f);
  for (const f of git(['diff', '--name-only', 'HEAD'])) files.add(f);
  for (const f of git(['diff', '--cached', '--name-only'])) files.add(f);
  // Untracked + modified from status
  for (const line of git(['status', '--porcelain'])) {
    const f = line.slice(3).trim();
    if (f) files.add(f.replace(/^"(.*)"$/, '$1'));
  }

  return [...files].filter(f => {
    const ext = path.posix.extname(f);
    return SOURCE_EXTS.has(ext) && !f.includes('node_modules');
  });
}

/**
 * Change-aware ingestion: re-parse changed files (partial graph regen), upsert
 * their symbols, and record a 'code-change' observation so future sessions know
 * what moved. This is what keeps the index current as the codebase grows.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @param {Object} [opts] - { files?, saveMemory? }
 * @returns {Promise<{ status: string, changedFiles: string[], ingest: Object|null, memorySaved: boolean }>}
 */
async function ingestDiff(db, project, opts = {}) {
  opts = opts || {};
  const projectPath = path.resolve(project);
  const changedFiles = (opts.files || gitChangedFiles(projectPath)).slice(0, 200);

  if (changedFiles.length === 0) {
    return { status: 'no-changes', changedFiles: [], ingest: null, memorySaved: false };
  }

  const graph = regenerateGraph(projectPath, { onlyFiles: changedFiles, timeoutMs: 60000 });
  if (!graph) {
    return { status: 'regen-failed', changedFiles, ingest: null, memorySaved: false };
  }

  const ingest = ingestProject(db, projectPath, { graph, onlyFiles: changedFiles });

  // Record a change memory so future sessions know what moved
  let memorySaved = false;
  if (opts.saveMemory !== false) {
    try {
      const title = 'Code change: ' + (changedFiles.length === 1 ? changedFiles[0] : changedFiles.length + ' files');
      const content = 'Changed files: ' + changedFiles.join(', ') +
        '. Re-indexed ' + ingest.symbols + ' symbol(s) (' + ingest.inserted + ' new, ' + ingest.updated + ' updated).';
      db.prepare(
        "INSERT INTO observations (session_id, project_path, type, title, content, tags, importance, confidence, provenance) " +
        "VALUES (NULL, ?, 'event', ?, ?, ?, 5, 95, 'observed')"
      ).run(projectPath, title, content, JSON.stringify(['code-change', 'code-index']));
      memorySaved = true;
    } catch { /* best-effort */ }
  }

  return { status: 'ok', changedFiles, ingest, memorySaved };
}

/**
 * Symbol index statistics for a project.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @returns {Object}
 */
function symbolStats(db, project) {
  const projectPath = path.resolve(project);
  const total = db.prepare('SELECT COUNT(*) as c FROM code_symbols WHERE project_path = ?').get(projectPath).c;
  const byKind = db.prepare(
    'SELECT kind, COUNT(*) as c FROM code_symbols WHERE project_path = ? GROUP BY kind ORDER BY c DESC'
  ).all(projectPath);
  const embedded = db.prepare('SELECT COUNT(*) as c FROM code_symbols WHERE project_path = ? AND embedding IS NOT NULL').get(projectPath).c;
  const summarized = db.prepare('SELECT COUNT(*) as c FROM code_symbols WHERE project_path = ? AND summary IS NOT NULL').get(projectPath).c;
  const files = db.prepare('SELECT COUNT(DISTINCT file_path) as c FROM code_symbols WHERE project_path = ?').get(projectPath).c;
  const accesses = db.prepare('SELECT COALESCE(SUM(access_count), 0) as a FROM code_symbols WHERE project_path = ?').get(projectPath).a;
  const accessedSymbols = db.prepare('SELECT COUNT(*) as c FROM code_symbols WHERE project_path = ? AND access_count > 0').get(projectPath).c;
  return {
    project: projectPath,
    symbols: total,
    files,
    embedded,
    summarized,
    accesses,
    accessedSymbols,
    byKind,
  };
}

module.exports = {
  GRAPH_FILENAME,
  getGraphPath,
  loadGraph,
  regenerateGraph,
  ingestProject,
  embedSymbols,
  keywordSymbolSearch,
  semanticSymbolSearch,
  searchSymbols,
  getTaskScopedSymbols,
  renderSymbolsXML,
  getCodeContext,
  summarizeSymbols,
  gitChangedFiles,
  ingestDiff,
  symbolStats,
  recordSymbolAccess,
  getTopSymbols,
  embeddingsEnabled,
  forceEmbeddingsEnabled,
};
