'use strict';

const core = require('../core');

// Wire up save function for hooks and reflection to avoid circular dependencies
core.hooks.setSaveFunction(save);
core.reflection.setSaveFunction(save);

// ─── Cached dimension mismatch check (checked once per session) ──────
let _dimensionMismatchChecked = false;
let _dimensionMismatchWarning = null;

function _checkEmbeddingMismatch() {
  if (_dimensionMismatchChecked) return _dimensionMismatchWarning;
  _dimensionMismatchChecked = true;
  try {
    const db = _getDB();
    const sample = db.prepare('SELECT embedding FROM observations WHERE embedding IS NOT NULL LIMIT 1').get();
    const meta = db.prepare('SELECT * FROM embedding_meta WHERE id = 1').get();
    if (sample && meta) {
      const storedDim = JSON.parse(sample.embedding).length;
      if (storedDim !== meta.dimension) {
        _dimensionMismatchWarning = 'Embedding dimension mismatch: stored=' + storedDim + ' current=' + meta.dimension + '. Run embedAll() or "embed --force" to upgrade.';
      }
    }
  } catch {}
  return _dimensionMismatchWarning;
}

// ─── Lazy DB Singleton ──────────────────────────────────────────────
// Wraps core.db.getDb() but throws Error instead of process.exit(1)
// when better-sqlite3 is missing.

let _apiDb = null;

function _getDB() {
  if (_apiDb) return _apiDb;
  try {
    require('better-sqlite3');
  } catch {
    throw new Error('better-sqlite3 is not installed. Run: npm install better-sqlite3');
  }
  _apiDb = core.db.getDb();
  return _apiDb;
}

// ─── CRUD ───────────────────────────────────────────────────────────

/**
 * Save a new observation. Auto-embeds if the pipeline is available.
 * @param {Object} opts - { title?, content, type?, tags?, importance?, confidence?, provenance?, project?, session?, agentId?, steps?, triggers?, preconditions?, postconditions? }
 * @returns {Promise<{id: number, status: string, type: string, confidence: number, provenance: string, project: string, embedded: boolean, agent_id: string|null}>}
 */
async function save(opts) {
  const db = _getDB();
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const session = opts.session || process.env.AGENTIC_CORTEX_SESSION || null;
  const type = opts.type || 'observation';
  const agentId = opts.agentId || opts.agent_id || null;

  if (!core.constants.VALID_TYPES.has(type)) {
    throw new Error('Invalid type: ' + type + '. Valid: ' + [...core.constants.VALID_TYPES].sort().join(', '));
  }
  const provenance = opts.provenance || 'observed';
  if (!core.constants.VALID_PROVENANCES.has(provenance)) {
    throw new Error('Invalid provenance: ' + provenance + '. Valid: explicit, inferred, observed');
  }
  if (!opts.content) throw new Error('content is required');

  const confidence = opts.confidence ?? 100;
  const tags = JSON.stringify(opts.tags || []);
  const imp = opts.importance || 5;

  // Skill/procedure fields — store as JSON arrays
  const steps = opts.steps ? JSON.stringify(opts.steps) : null;
  const triggers = opts.triggers ? JSON.stringify(opts.triggers) : null;
  const preconditions = opts.preconditions ? JSON.stringify(opts.preconditions) : null;
  const postconditions = opts.postconditions ? JSON.stringify(opts.postconditions) : null;

  let embedding = null;
  try {
    const text = [opts.title || '', opts.content].filter(Boolean).join('. ');
    const vec = await core.embedding.computeEmbedding(text);
    embedding = JSON.stringify(vec);
  } catch {}

  // Pre-save hooks
  const preSaveObs = { title: opts.title, content: opts.content, type, tags: opts.tags || [], importance: imp, confidence, provenance, project_path: project, session_id: session, agent_id: agentId };
  await core.hooks.triggerHooks(db, 'pre_save', preSaveObs, { project, session });

  const r = db.prepare(
    'INSERT INTO observations (session_id, project_path, agent_id, type, title, content, tags, importance, confidence, provenance, embedding, steps, triggers, preconditions, postconditions) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(session, project, agentId, type, opts.title || null, opts.content, tags, imp, confidence, provenance, embedding, steps, triggers, preconditions, postconditions);

  const savedId = Number(r.lastInsertRowid);
  const saved = { id: savedId, status: 'saved', type, confidence, provenance, project, agent_id: agentId, embedded: !!embedding };

  // Post-save hooks
  await core.hooks.triggerHooks(db, 'post_save', { ...preSaveObs, id: savedId }, { project, session });

  return saved;
}

/**
 * Get a single observation by ID.
 * Strips the raw embedding blob, adds has_embedding boolean, and parses JSON skill/procedure fields.
 * @param {number} id
 * @returns {Object|null}
 */
function get(id) {
  const db = _getDB();
  const obs = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
  if (!obs) return null;
  const { embedding, ...rest } = obs;
  rest.has_embedding = !!embedding;
  // Parse skill/procedure JSON fields
  if (rest.steps) try { rest.steps = JSON.parse(rest.steps); } catch {}
  if (rest.triggers) try { rest.triggers = JSON.parse(rest.triggers); } catch {}
  if (rest.preconditions) try { rest.preconditions = JSON.parse(rest.preconditions); } catch {}
  if (rest.postconditions) try { rest.postconditions = JSON.parse(rest.postconditions); } catch {}
  return rest;
}

/**
 * Edit an observation (creates version history entry first).
 * @param {number} id
 * @param {Object} opts - { title?, content?, confidence?, importance?, steps?, triggers?, preconditions?, postconditions? }
 * @returns {Object} Updated observation with versionCount and status
 */
async function edit(id, opts) {
  const db = _getDB();
  const existing = db.prepare('SELECT * FROM observations WHERE id = ? AND is_active = 1').get(id);
  if (!existing) throw new Error('Active observation not found: ' + id);

  // Pre-edit hooks
  await core.hooks.triggerHooks(db, 'pre_edit', existing, { id, changes: opts });

  // Skill/procedure fields — serialize JSON arrays if provided
  const steps = opts.steps !== undefined ? (opts.steps ? JSON.stringify(opts.steps) : null) : null;
  const triggers = opts.triggers !== undefined ? (opts.triggers ? JSON.stringify(opts.triggers) : null) : null;
  const preconditions = opts.preconditions !== undefined ? (opts.preconditions ? JSON.stringify(opts.preconditions) : null) : null;
  const postconditions = opts.postconditions !== undefined ? (opts.postconditions ? JSON.stringify(opts.postconditions) : null) : null;

  // Save old version and update atomically
  db.transaction(() => {
    db.prepare(
      'INSERT INTO observation_versions (observation_id, version_number, old_title, old_content, old_confidence) VALUES (?, (SELECT COALESCE(MAX(version_number), 0) + 1 FROM observation_versions WHERE observation_id = ?), ?, ?, ?)'
    ).run(existing.id, existing.id, existing.title, existing.content, existing.confidence);

    db.prepare(
      `UPDATE observations SET title = COALESCE(?, title), content = COALESCE(?, content), confidence = COALESCE(?, confidence), importance = COALESCE(?, importance),
       steps = CASE WHEN ? IS NOT NULL THEN ? ELSE steps END,
       triggers = CASE WHEN ? IS NOT NULL THEN ? ELSE triggers END,
       preconditions = CASE WHEN ? IS NOT NULL THEN ? ELSE preconditions END,
       postconditions = CASE WHEN ? IS NOT NULL THEN ? ELSE postconditions END
       WHERE id = ?`
    ).run(
      opts.title || null, opts.content || null, opts.confidence ?? null, opts.importance ?? null,
      steps, steps, triggers, triggers, preconditions, preconditions, postconditions, postconditions,
      id
    );
  })();

  // Re-embed if content or title changed
  if (opts.title || opts.content) {
    const updatedForEmbed = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
    if (updatedForEmbed) {
      const text = [opts.title || updatedForEmbed.title || '', opts.content || updatedForEmbed.content].filter(Boolean).join('. ');
      try {
        const vec = await core.embedding.computeEmbedding(text);
        db.prepare('UPDATE observations SET embedding = ? WHERE id = ?').run(JSON.stringify(vec), id);
      } catch {}
    }
  }

  const updated = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
  const { embedding, ...rest } = updated;
  rest.has_embedding = !!embedding;
  // Parse skill/procedure JSON fields
  if (rest.steps) try { rest.steps = JSON.parse(rest.steps); } catch {}
  if (rest.triggers) try { rest.triggers = JSON.parse(rest.triggers); } catch {}
  if (rest.preconditions) try { rest.preconditions = JSON.parse(rest.preconditions); } catch {}
  if (rest.postconditions) try { rest.postconditions = JSON.parse(rest.postconditions); } catch {}
  rest.versionCount = db.prepare('SELECT COUNT(*) as c FROM observation_versions WHERE observation_id = ?').get(id).c;
  rest.status = 'edited';

  // Post-edit hooks
  await core.hooks.triggerHooks(db, 'post_edit', rest, { id, changes: opts });

  return rest;
}

/**
 * Soft-delete (forget) or hard-delete an observation.
 * @param {number} id
 * @param {Object} [opts] - { hard?: boolean }
 * @returns {Promise<{id: number, status: string}>}
 */
async function forget(id, opts) {
  opts = opts || {};
  const db = _getDB();
  const existing = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
  if (!existing) throw new Error('Observation not found: ' + id);

  // Pre-forget hooks
  await core.hooks.triggerHooks(db, 'pre_forget', existing, { id, hard: opts.hard });

  if (opts.hard) {
    db.transaction(() => {
      db.prepare('DELETE FROM memory_relations WHERE source_id = ? OR target_id = ?').run(id, id);
      db.prepare('DELETE FROM observation_versions WHERE observation_id = ?').run(id);
      db.prepare('DELETE FROM observations WHERE id = ?').run(id);
    })();
    const result = { id, status: 'hard_deleted' };
    await core.hooks.triggerHooks(db, 'post_forget', existing, { id, hard: true });
    return result;
  }
  const r = db.prepare('UPDATE observations SET is_active = 0 WHERE id = ?').run(id);
  if (r.changes === 0) throw new Error('Observation not found: ' + id);
  const result = { id, status: 'forgotten' };
  await core.hooks.triggerHooks(db, 'post_forget', existing, { id, hard: false });
  return result;
}

/**
 * List observations with filters.
 * @param {Object} [opts] - { project?, type?, limit?, minConfidence?, changedSince?, asOf? }
 * @returns {Object[]}
 */
function list(opts) {
  opts = opts || {};
  const db = _getDB();
  const { whereClause, params } = core.search.buildWhereClause(opts);
  const limit = opts.limit || 10;
  return db.prepare(
    'SELECT o.id, o.agent_id, o.project_path, o.type, o.title, substr(o.content, 1, 300) as preview, o.tags, o.importance, o.confidence, o.provenance, o.created_at, o.is_active FROM observations o WHERE ' + whereClause + ' ORDER BY o.created_at DESC LIMIT ?'
  ).all(...params, limit);
}

// ─── Search ─────────────────────────────────────────────────────────

/**
 * Hybrid search (FTS5 + semantic). Auto-computes embedding for the query.
 * Falls back to keyword-only if embedding pipeline unavailable.
 * If opts.rerank is truthy, applies cross-encoder reranking to the top
 * results for higher relevance ordering.
 * @param {string} query
 * @param {Object} [opts] - hybridSearch options + { rerank?: boolean, rerankTopN?: number }
 * @returns {Promise<Object[]>}
 */
async function search(query, opts) {
  opts = opts || {};
  const db = _getDB();
  const wantsRerank = !!opts.rerank;

  // When reranking: pull more candidates up front so the reranker has room.
  const candidateLimit = wantsRerank
    ? Math.max((opts.limit || 10) * (opts.rerankTopN || 5), 50)
    : undefined;

  let queryVec;
  try { queryVec = await core.embedding.computeEmbedding(query); } catch { queryVec = null; }

  // Check for embedding dimension mismatch once (cached)
  if (queryVec) {
    const warn = _checkEmbeddingMismatch();
    if (warn) console.error('[agentic-cortex] Warning:', warn);
  }

  let results;
  if (queryVec) {
    results = core.search.hybridSearch(
      db,
      query,
      queryVec,
      candidateLimit != null ? { ...opts, limit: candidateLimit } : opts
    );
  } else {
    results = core.search.keywordSearch(
      db,
      candidateLimit != null ? { ...opts, query, limit: candidateLimit } : { ...opts, query }
    );
  }

  if (wantsRerank) {
    results = await core.search.rerankResults(query, results);
    // Restore requested limit after rerank (reranker returns all candidates).
    if (opts.limit) results = results.slice(0, opts.limit);
  }

  return results;
}

/**
 * Keyword-only search (FTS5).
 * @param {string} query
 * @param {Object} [opts]
 * @returns {Object[]}
 */
function keywordSearch(query, opts) {
  opts = opts || {};
  const db = _getDB();
  return core.search.keywordSearch(db, { ...opts, query });
}

/**
 * Semantic search (vector similarity). Auto-computes embedding for the query.
 * @param {string} query
 * @param {Object} [opts]
 * @returns {Promise<Object[]>}
 */
async function semanticSearch(query, opts) {
  opts = opts || {};
  const db = _getDB();
  const queryVec = await core.embedding.computeEmbedding(query);
  return core.search.semanticSearch(db, queryVec, opts);
}

// ─── Sessions ────────────────────────────────────────────────────────

/** Start a new session */
function startSession(opts) {
  return core.session.startSession(_getDB(), opts || {});
}

/** End a session */
function endSession(sessionId, summary) {
  return core.session.endSession(_getDB(), sessionId, summary);
}

/** Summarize a session (async — calls LLM if available) */
async function summarizeSession(opts) {
  return core.session.summarizeSession(_getDB(), opts || {});
}

/** List recent sessions */
function listSessions(opts) {
  return core.session.listSessions(_getDB(), opts || {});
}

// ─── Embedding ───────────────────────────────────────────────────────

/**
 * Embed a text string or re-embed an observation.
 * - Number id → re-embeds that observation in-place
 * - String → returns the embedding vector
 * @param {number|string} idOrText
 * @returns {Promise<Object|number[]>}
 */
async function embed(idOrText) {
  const db = _getDB();
  if (typeof idOrText === 'number') {
    const obs = db.prepare('SELECT * FROM observations WHERE id = ?').get(idOrText);
    if (!obs) throw new Error('Observation not found: ' + idOrText);
    const text = [obs.title || '', obs.content].filter(Boolean).join('. ');
    const vec = await core.embedding.computeEmbedding(text);
    db.prepare('UPDATE observations SET embedding = ? WHERE id = ?').run(JSON.stringify(vec), idOrText);
    return { id: idOrText, status: 'embedded', dimension: vec.length };
  }
  return core.embedding.computeEmbedding(idOrText);
}

/**
 * Re-embed all observations that lack embeddings.
 * @param {Object} [opts] - { project?, limit? }
 * @returns {Promise<{total: number, embedded: number, skipped: number}>}
 */
async function embedAll(opts) {
  opts = opts || {};
  const db = _getDB();
  const project = opts.project || null;
  const limit = opts.limit || 0;

  let sql = 'SELECT id, title, content FROM observations WHERE embedding IS NULL AND is_active = 1';
  const params = [];
  if (project) { sql += ' AND project_path = ?'; params.push(project); }
  if (limit > 0) { sql += ' LIMIT ?'; params.push(limit); }

  const rows = db.prepare(sql).all(...params);
  let embedded = 0;
  for (const row of rows) {
    try {
      const text = [row.title || '', row.content].filter(Boolean).join('. ');
      const vec = await core.embedding.computeEmbedding(text);
      db.prepare('UPDATE observations SET embedding = ? WHERE id = ?').run(JSON.stringify(vec), row.id);
      embedded++;
    } catch {}
  }
  return { total: rows.length, embedded, skipped: rows.length - embedded };
}

// ─── Conflict Detection ──────────────────────────────────────────────

/** Detect conflicting observations (async) */
async function checkConflicts(opts) {
  return core.conflict.checkConflicts(_getDB(), opts || {});
}

// ─── Reflection / Consolidation ──────────────────────────────────────

/**
 * Run reflection cycle: consolidate similar memories, promote patterns,
 * and archive superseded observations.
 * @param {Object} opts - { project?, dryRun?, threshold?, minCount?, maxAgeDays? }
 * @returns {Promise<{consolidate: Object, promote: Object, archive: Object}>}
 */
async function reflect(opts) {
  return core.reflection.reflect(_getDB(), opts || {});
}

/** Consolidate similar observations only */
async function consolidateMemories(opts) {
  return core.reflection.consolidateMemories(_getDB(), opts || {});
}

/** Promote recurring patterns only */
async function promotePatterns(opts) {
  return core.reflection.promotePatterns(_getDB(), opts || {});
}

/** Archive superseded observations only */
async function archiveSuperseded(opts) {
  return core.reflection.archiveSuperseded(_getDB(), opts || {});
}

// ─── Export / Import ─────────────────────────────────────────────────

/** Export observations and sessions as JSON */
function exportJSON(opts) {
  return core.export.exportJSON(_getDB(), opts || {});
}

/** Export to Obsidian-compatible markdown. opts.vaultPath required. */
function exportMarkdown(opts) {
  return core.export.exportMarkdown(_getDB(), opts || {});
}

/** Import observations from JSON data */
async function importJSON(data, opts) {
  return core.export.importJSON(_getDB(), data, opts || {});
}

// ─── Context ─────────────────────────────────────────────────────────

/**
 * Generate a formatted markdown context pack for AI system prompts.
 * @param {Object} [opts] - { project? }
 * @returns {string} Markdown context
 */
function context(opts) {
  opts = opts || {};
  const db = _getDB();
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();

  const sessions = db.prepare(
    'SELECT id, session_id, project_name, user_prompt, summary, started_at, ended_at FROM sessions WHERE project_path = ? ORDER BY started_at DESC LIMIT 5'
  ).all(project);

  const observations = db.prepare(
    'SELECT id, session_id, type, title, substr(content, 1, 200) as preview, tags, importance, created_at FROM observations WHERE project_path = ? AND is_active = 1 ORDER BY importance DESC, created_at DESC LIMIT 20'
  ).all(project);

  let pack = '# Agentic Cortex - Project Context\n\n';
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
  return pack;
}

// ─── Lifecycle ────────────────────────────────────────────────────────

/** Initialize the database (idempotent) */
function init() {
  _getDB();
  return { status: 'initialized', dbPath: core.db.getDbPath() };
}

/** Close the database connection */
function close() {
  if (_apiDb) {
    _apiDb.close();
    _apiDb = null;
  }
}

/** Health check: DB stats + embedding cache stats */
function health() {
  const db = _getDB();
  const observations = db.prepare('SELECT COUNT(*) as c FROM observations').get().c;
  const active = db.prepare('SELECT COUNT(*) as c FROM observations WHERE is_active = 1').get().c;
  const embedded = db.prepare('SELECT COUNT(*) as c FROM observations WHERE embedding IS NOT NULL').get().c;
  const sessions = db.prepare('SELECT COUNT(*) as c FROM sessions').get().c;
  const cacheStats = core.embedding.getEmbeddingCacheStats();

  // Check for embedding dimension mismatch (stored vs current model)
  let dimensionWarning = null;
  try {
    const sample = db.prepare('SELECT embedding FROM observations WHERE embedding IS NOT NULL LIMIT 1').get();
    const meta = db.prepare('SELECT * FROM embedding_meta WHERE id = 1').get();
    if (sample && meta) {
      const storedDim = JSON.parse(sample.embedding).length;
      if (storedDim !== meta.dimension) {
        dimensionWarning = 'Embedding dimension mismatch: stored=' + storedDim + ' current=' + meta.dimension + '. Run embed --force to upgrade all embeddings.';
      }
    }
  } catch {}

  return {
    status: 'ok',
    dbPath: core.db.getDbPath(),
    observations: { total: observations, active, embedded },
    sessions,
    embeddingCache: cacheStats,
    dimensionWarning,
  };
}

// ─── Relations (Memory Graph) ─────────────────────────────────────────

/**
 * Add a relation between two observations.
 * @param {Object} opts - { sourceId, targetId, relationType, confidence? }
 * @returns {Promise<Object>}
 */
async function addRelation(opts) {
  return core.relations.addRelation(_getDB(), opts);
}

/**
 * Get all relations for an observation.
 * @param {number} observationId
 * @returns {Object[]}
 */
function getRelations(observationId) {
  return core.relations.getRelations(_getDB(), observationId);
}

/**
 * Get a subgraph around an observation.
 * @param {Object} opts - { observationId, depth?, limit? }
 * @returns {Object} { nodes, edges, centerId }
 */
function getGraph(opts) {
  return core.relations.getGraph(_getDB(), opts);
}

/**
 * Delete a relation by ID.
 * @param {number} relationId
 * @returns {Object}
 */
function deleteRelation(relationId) {
  return core.relations.deleteRelation(_getDB(), relationId);
}

/**
 * List all relation types with counts.
 * @returns {Object[]}
 */
function listRelationTypes() {
  return core.relations.listRelationTypes(_getDB());
}

// ─── Hooks ────────────────────────────────────────────────────────────

/**
 * Create a persisted hook.
 * @param {Object} opts - { name, event, condition_type, condition_value, action_type, action_config?, enabled? }
 * @returns {Object}
 */
function createHook(opts) {
  return core.hooks.createHook(_getDB(), opts);
}

/**
 * List all persisted hooks.
 * @returns {Object[]}
 */
function listHooks() {
  return core.hooks.listHooks(_getDB());
}

/**
 * Update a persisted hook.
 * @param {number} id
 * @param {Object} opts - fields to update
 * @returns {Object}
 */
function updateHook(id, opts) {
  return core.hooks.updateHook(_getDB(), id, opts);
}

/**
 * Delete a persisted hook.
 * @param {number} id
 * @returns {Object}
 */
function deleteHook(id) {
  return core.hooks.deleteHook(_getDB(), id);
}

/**
 * Enable or disable a persisted hook.
 * @param {number} id
 * @param {boolean} enabled
 * @returns {Object}
 */
function setHookEnabled(id, enabled) {
  return core.hooks.setHookEnabled(_getDB(), id, enabled);
}

/**
 * Register an in-memory hook callback.
 * @param {string} event
 * @param {Function} callback
 */
function registerHook(event, callback) {
  return core.hooks.registerHook(event, callback);
}

/**
 * Unregister an in-memory hook callback.
 * @param {string} event
 * @param {Function} callback
 */
function unregisterHook(event, callback) {
  return core.hooks.unregisterHook(event, callback);
}

// ─── Multi-Agent Sharing ──────────────────────────────────────────────

/**
 * Start an agent session.
 * @param {Object} opts - { agentId, sessionId, project?, role? }
 * @returns {Object}
 */
function startAgentSession(opts) {
  const db = _getDB();
  const agentId = opts.agentId || opts.agent_id;
  if (!agentId) throw new Error('agentId is required');
  const sessionId = opts.sessionId || opts.session_id;
  if (!sessionId) throw new Error('sessionId is required');
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const role = opts.role || null;

  const r = db.prepare(
    'INSERT OR REPLACE INTO agent_sessions (agent_id, session_id, project_path, role) VALUES (?,?,?,?)'
  ).run(agentId, sessionId, project, role);

  return { id: Number(r.lastInsertRowid), agent_id: agentId, session_id: sessionId, project_path: project, role, status: 'started' };
}

/**
 * End an agent session.
 * @param {string} agentId
 * @param {string} sessionId
 * @returns {Object}
 */
function endAgentSession(agentId, sessionId) {
  const db = _getDB();
  const r = db.prepare(
    "UPDATE agent_sessions SET ended_at = datetime('now') WHERE agent_id = ? AND session_id = ? AND ended_at IS NULL"
  ).run(agentId, sessionId);
  if (r.changes === 0) throw new Error('Active agent session not found: ' + agentId + '/' + sessionId);
  return { agent_id: agentId, session_id: sessionId, status: 'ended' };
}

/**
 * List agent sessions.
 * @param {Object} [opts] - { agentId?, project?, limit? }
 * @returns {Object[]}
 */
function listAgentSessions(opts) {
  opts = opts || {};
  const db = _getDB();
  let sql = 'SELECT * FROM agent_sessions WHERE 1=1';
  const params = [];
  if (opts.agentId || opts.agent_id) { sql += ' AND agent_id = ?'; params.push(opts.agentId || opts.agent_id); }
  if (opts.project) { sql += ' AND project_path = ?'; params.push(opts.project); }
  sql += ' ORDER BY started_at DESC LIMIT ?';
  params.push(opts.limit || 20);
  return db.prepare(sql).all(...params);
}

/**
 * Share an observation with other agents.
 * Updates the agent's session shared_with list, and copies the observation's
 * agent_id to create a shared reference.
 * @param {Object} opts - { observationId, sharedWith: string[] }
 * @returns {Object}
 */
function shareMemory(opts) {
  const db = _getDB();
  const obs = db.prepare('SELECT * FROM observations WHERE id = ? AND is_active = 1').get(opts.observationId);
  if (!obs) throw new Error('Active observation not found: ' + opts.observationId);
  const sharedWith = opts.sharedWith || [];
  if (!sharedWith.length) throw new Error('sharedWith must be a non-empty array of agent IDs');

  // Update shared_with on the observation's agent session if one exists
  if (obs.agent_id) {
    const session = db.prepare(
      'SELECT * FROM agent_sessions WHERE agent_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1'
    ).get(obs.agent_id);
    if (session) {
      const existing = JSON.parse(session.shared_with || '[]');
      const merged = [...new Set([...existing, ...sharedWith])];
      db.prepare('UPDATE agent_sessions SET shared_with = ? WHERE id = ?')
        .run(JSON.stringify(merged), session.id);
    }
  }

  return {
    observation_id: opts.observationId,
    shared_with: sharedWith,
    status: 'shared',
  };
}

/**
 * Get memories shared with a specific agent.
 * Returns observations from agent sessions where the agent is in shared_with.
 * @param {string} agentId - The agent requesting shared memories
 * @param {Object} [opts] - { project?, limit? }
 * @returns {Object[]}
 */
function getSharedMemories(agentId, opts) {
  opts = opts || {};
  const db = _getDB();
  // Find agents that have shared with this agent
  const sharedSessions = db.prepare(
    "SELECT DISTINCT a.agent_id FROM agent_sessions a WHERE EXISTS (SELECT 1 FROM json_each(a.shared_with) j WHERE j.value = ?) AND a.project_path LIKE ? AND a.ended_at IS NULL"
  ).all(agentId, opts.project || '%');

  if (sharedSessions.length === 0) return [];
  const agentIds = sharedSessions.map(s => s.agent_id);

  const placeholders = agentIds.map(() => '?').join(',');
  let sql = 'SELECT o.id, o.agent_id, o.project_path, o.type, o.title, substr(o.content, 1, 300) as preview, o.tags, o.importance, o.confidence, o.provenance, o.created_at FROM observations o WHERE o.agent_id IN (' + placeholders + ') AND o.is_active = 1';
  const params = [...agentIds];
  if (opts.project) { sql += ' AND o.project_path = ?'; params.push(opts.project); }
  sql += ' ORDER BY o.created_at DESC LIMIT ?';
  params.push(opts.limit || 20);

  return db.prepare(sql).all(...params);
}

// ─── Skill/Procedure Search ───────────────────────────────────────────

/**
 * Search within skills and procedures by text query.
 * Searches across title, content, steps, triggers, preconditions, and postconditions.
 * @param {Object} opts - { query, project?, type?, agentId?, limit? }
 * @returns {Promise<Object[]>}
 */
async function searchSkills(opts) {
  if (!opts.query) throw new Error('query is required');
  const db = _getDB();
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || null;
  const limit = opts.limit || 10;
  const agentId = opts.agentId || null;

  // Determine type filter — push skill/procedure type into the search query
  let typeFilter;
  if (opts.type && opts.type !== 'both') {
    typeFilter = opts.type;
  } else {
    // Default: search both skill and procedure types
    typeFilter = undefined;  // We'll filter in SQL via an IN clause instead
  }

  // Build a search that targets skill/procedure types specifically
  const searchOpts = { project, agentId, limit: limit * 3 };
  if (typeFilter) {
    searchOpts.type = typeFilter;
  }

  // Use hybrid search if available, otherwise keyword-only
  let results;
  try {
    const queryVec = await core.embedding.computeEmbedding(opts.query);
    results = core.search.hybridSearch(db, opts.query, queryVec, searchOpts);
  } catch {
    results = core.search.keywordSearch(db, { ...searchOpts, query: opts.query });
  }

  // Augment with structured fields
  const db2 = _getDB();
  const skills = results.slice(0, limit).map(r => {
    const full = db2.prepare('SELECT steps, triggers, preconditions, postconditions FROM observations WHERE id = ?').get(r.id);
    return {
      ...r,
      steps: full?.steps ? JSON.parse(full.steps) : [],
      triggers: full?.triggers ? JSON.parse(full.triggers) : [],
      preconditions: full?.preconditions ? JSON.parse(full.preconditions) : [],
      postconditions: full?.postconditions ? JSON.parse(full.postconditions) : [],
    };
  });

  return skills;
}

// ─── Exports ───────────────────────────────────────────────────────────

module.exports = {
  save, get, edit, forget, list,
  search, keywordSearch, semanticSearch,
  startSession, endSession, summarizeSession, listSessions,
  embed, embedAll,
  checkConflicts,
  exportJSON, exportMarkdown, importJSON,
  context,
  init, close, health,
  addRelation, getRelations, getGraph, deleteRelation, listRelationTypes,
  createHook, listHooks, updateHook, deleteHook, setHookEnabled, registerHook, unregisterHook,
  reflect, consolidateMemories, promotePatterns, archiveSuperseded,
  startAgentSession, endAgentSession, listAgentSessions, shareMemory, getSharedMemories,
  searchSkills,
};
