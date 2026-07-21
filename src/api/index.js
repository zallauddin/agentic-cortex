'use strict';

const core = require('../core');

// Wire up save function for hooks and reflection to avoid circular dependencies
core.hooks.setSaveFunction(save);
core.reflection.setSaveFunction(save);

// Initialize self-improving loop (error RCA, conflict resolution, learning verification)
const selfImprove = require('../core/self-improve');
selfImprove.initHooks(save);
core.selfImprove = selfImprove;

// Initialize coding standards module (pre-loaded, always-injected, phase-aware)
const standards = require('../core/standards');
core.standards = standards;

// Keyword fallback arrays for outcome classification (used by recordAction and self-improve)
const _KEYWORD_SUCCESS = ['pass', 'success', 'ok', 'completed', 'works', 'fixed', 'resolved', 'done', 'created', 'updated'];
const _KEYWORD_FAILURE = ['fail', 'error', 'crash', 'broke', 'failed', 'rejected', 'timeout', 'rollback', 'revert'];

// Auto-reflect state: run reflect() every Nth bootstrap call in background
let _bootstrapCount = 0;
const AUTO_REFLECT_INTERVAL = 10;
let _autoReflectRunning = false;

// Ignore-count tracker: how many times each failure has been shown in EXPLICITLY AVOID
// Key: failure obs ID. Value: { count, lastShown (ISO), title }
// Pruned on every write: max 1000 entries, expire entries older than 30 days
const _ignoredWarnings = new Map();
const IGNORED_MAX_ENTRIES = 1000;
const IGNORED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function _pruneIgnoredWarnings() {
  if (_ignoredWarnings.size <= IGNORED_MAX_ENTRIES) {
    // Expire old entries even when under cap
    const now = Date.now();
    for (const [id, entry] of _ignoredWarnings) {
      const age = now - new Date(entry.lastShown || 0).getTime();
      if (age > IGNORED_MAX_AGE_MS) _ignoredWarnings.delete(id);
    }
    return;
  }
  // Cap exceeded — remove oldest entries first
  const entries = [..._ignoredWarnings.entries()]
    .sort((a, b) => new Date(a[1].lastShown || 0).getTime() - new Date(b[1].lastShown || 0).getTime());
  const toRemove = entries.slice(0, entries.length - Math.floor(IGNORED_MAX_ENTRIES * 0.8));
  for (const [id] of toRemove) _ignoredWarnings.delete(id);
}

/**
 * Compute keyword overlap ratio between two texts.
 * Used as a pre-filter so embedding misses don't hide semantically similar failures.
 * @param {string} textA
 * @param {string} textB
 * @returns {number} Overlap ratio 0-1
 */
function _keywordOverlap(textA, textB) {
  const wordsA = new Set((textA || '').toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const wordsB = (textB || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (wordsB.length === 0) return 0;
  const overlap = wordsB.filter(w => wordsA.has(w)).length;
  return overlap / Math.max(wordsB.length, 1);
}

/**
 * Auto-detect observation type from title + content patterns.
 * Falls back to 'observation' if no patterns match.
 *
 * @param {string} title
 * @param {string} content
 * @returns {string} Detected type
 */
function _detectType(title, content) {
  const text = (title + ' ' + content).toLowerCase();

  // Error patterns (strongest signal first)
  if (/\b(error|exception|crash|fail(?:ed|ure)?|bug|broke|broken|stack trace|segfault|panic|runtime error)\b/i.test(text)) {
    return 'error';
  }
  // Decision patterns
  if (/\b(chose|decided|going with|will use|opted|selected|picked|settled on|went with)\b/i.test(text)) {
    return 'decision';
  }
  // Learning patterns
  if (/\b(learned|found that|realized|discovered|figured out|turns out|lesson|insight|noticed that)\b/i.test(text)) {
    return 'learning';
  }
  // Preference patterns
  if (/\b(prefer|rather than|instead of|don't like|like using|favorite|go-to)\b/i.test(text)) {
    return 'preference';
  }
  // Fact/context patterns
  if (/\b(project uses|configured with|running on|database is|powered by|built with|depends on|requires|needs)\b/i.test(text)) {
    return 'fact';
  }
  // Instruction patterns
  if (/\b(step|procedure|how to|guide|workflow|recipe|process|pipeline|run this|do this|execute)\b/i.test(text)) {
    return 'instruction';
  }
  // Event patterns
  if (/\b(published|released|deployed|launched|completed|finished|merged|shipped|announced|rolled out)\b/i.test(text)) {
    return 'event';
  }
  // Goal patterns
  if (/\b(goal|objective|target|aim|milestone|plan to|want to|need to achieve)\b/i.test(text)) {
    return 'goal';
  }

  return 'observation';
}

/**
 * Batch-update access_count and last_accessed_at for observation IDs.
 * Debounces writes — only updates if last access was > 1 hour ago to avoid
 * excessive SQLite write contention during bulk searches.
 * @param {import('better-sqlite3').Database} db
 * @param {number[]} ids
 */
function _trackAccess(db, ids) {
  if (!ids || ids.length === 0) return;
  const unique = [...new Set(ids)];
  const placeholders = unique.map(() => '?').join(',');
  try {
    db.prepare(
      `UPDATE observations SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id IN (${placeholders}) AND (last_accessed_at IS NULL OR last_accessed_at < datetime('now', '-1 hour'))`
    ).run(...unique);
  } catch { /* best-effort */ }
}

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
  } catch (err) {
    console.warn('[agentic-cortex] Dimension mismatch check failed: ' + (err && err.message ? err.message : err));
  }
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
  const type = opts.type || _detectType(opts.title || '', opts.content);
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
  } catch (err) {
    console.warn('[agentic-cortex] Embedding failed for save: ' + (err && err.message ? err.message : err));
  }

  // #1 Save-time deduplication: check for highly similar existing observations
  let dedupResult = null;
  if (embedding) {
    try {
      const vec = JSON.parse(embedding);
      const existing = db.prepare(
        'SELECT id, type, title, content, tags, confidence, embedding FROM observations WHERE project_path = ? AND is_active = 1 AND embedding IS NOT NULL ORDER BY created_at DESC LIMIT 50'
      ).all(project);

      for (const e of existing) {
        try {
          const eVec = JSON.parse(e.embedding);
          const sim = core.embedding.cosineSimilarity(vec, eVec);
          if (sim >= 0.97) {
            // Found a near-duplicate — reinforce instead of creating new
            const mergedTags = [...new Set([...JSON.parse(e.tags || '[]'), ...(opts.tags || [])])];
            db.prepare('UPDATE observations SET confidence = MIN(confidence + 5, 100), predicted_utility = predicted_utility + 3, tags = ?, last_accessed_at = datetime(\'now\') WHERE id = ?')
              .run(JSON.stringify(mergedTags), e.id);

            // Track access on the reinforced observation
            _trackAccess(db, [e.id]);

            dedupResult = { id: e.id, status: 'reinforced', type: e.type, confidence: Math.min(e.confidence + 5, 100), project, agent_id: agentId, embedded: true, similarity: Math.round(sim * 1000) / 1000 };
            break;
          }
        } catch { /* skip unparseable embeddings */ }
      }
    } catch { /* embedding parse failed — skip dedup */ }
  }

  if (dedupResult) {
    // Skip insertion — observation was deduplicated. Still fire post_save hooks with the reinforced obs.
    const reinforcedObs = db.prepare('SELECT * FROM observations WHERE id = ?').get(dedupResult.id);
    await core.hooks.triggerHooks(db, 'post_save', { ...reinforcedObs, tags: JSON.parse(reinforcedObs.tags || '[]') }, { project, session });
    return dedupResult;
  }

  // Pre-save hooks
  const preSaveObs = { title: opts.title, content: opts.content, type, tags: opts.tags || [], importance: imp, confidence, provenance, project_path: project, session_id: session, agent_id: agentId };
  await core.hooks.triggerHooks(db, 'pre_save', preSaveObs, { project, session });

  // Cross-project scope (local vs global for knowledge transfer)
  const projectScope = opts.project_scope || 'local';

  const r = db.prepare(
    'INSERT INTO observations (session_id, project_path, agent_id, type, title, content, tags, importance, confidence, provenance, embedding, steps, triggers, preconditions, postconditions, project_scope, layer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(session, project, agentId, type, opts.title || null, opts.content, tags, imp, confidence, provenance, embedding, steps, triggers, preconditions, postconditions, projectScope, opts.layer || 1);

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
  _trackAccess(db, [id]);
  const { embedding, ...rest } = obs;
  rest.has_embedding = !!embedding;
  // Parse skill/procedure JSON fields
  if (rest.steps) try { rest.steps = JSON.parse(rest.steps); } catch (e) { console.warn('[agentic-cortex] Failed to parse steps for #' + id + ': ' + e.message); }
  if (rest.triggers) try { rest.triggers = JSON.parse(rest.triggers); } catch (e) { console.warn('[agentic-cortex] Failed to parse triggers for #' + id + ': ' + e.message); }
  if (rest.preconditions) try { rest.preconditions = JSON.parse(rest.preconditions); } catch (e) { console.warn('[agentic-cortex] Failed to parse preconditions for #' + id + ': ' + e.message); }
  if (rest.postconditions) try { rest.postconditions = JSON.parse(rest.postconditions); } catch (e) { console.warn('[agentic-cortex] Failed to parse postconditions for #' + id + ': ' + e.message); }
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
      } catch (err) {
        console.warn('[agentic-cortex] Re-embedding failed for edit #' + id + ': ' + (err && err.message ? err.message : err));
      }
    }
  }

  const updated = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
  const { embedding, ...rest } = updated;
  rest.has_embedding = !!embedding;
  // Parse skill/procedure JSON fields
  if (rest.steps) try { rest.steps = JSON.parse(rest.steps); } catch (e) { console.warn('[agentic-cortex] Failed to parse steps for #' + id + ': ' + e.message); }
  if (rest.triggers) try { rest.triggers = JSON.parse(rest.triggers); } catch (e) { console.warn('[agentic-cortex] Failed to parse triggers for #' + id + ': ' + e.message); }
  if (rest.preconditions) try { rest.preconditions = JSON.parse(rest.preconditions); } catch (e) { console.warn('[agentic-cortex] Failed to parse preconditions for #' + id + ': ' + e.message); }
  if (rest.postconditions) try { rest.postconditions = JSON.parse(rest.postconditions); } catch (e) { console.warn('[agentic-cortex] Failed to parse postconditions for #' + id + ': ' + e.message); }
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

  // Track access for returned results
  _trackAccess(db, results.map(r => r.id));

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

/** End a session. On success, boosts predicted_utility for memories accessed during this session. */
function endSession(sessionId, summary) {
  const db = _getDB();
  const result = core.session.endSession(db, sessionId, summary);

  // #1 Predictive ranking: boost predicted_utility for memories accessed during successful sessions
  if (summary) {
    const successIndicators = ['success', 'completed', 'fixed', 'resolved', 'pass', 'works', 'done'];
    const isSuccess = successIndicators.some(w => (summary || '').toLowerCase().includes(w));
    if (isSuccess) {
      try {
        // Find all observations accessed during this session and boost their predicted_utility
        db.prepare(
          `UPDATE observations SET predicted_utility = predicted_utility + 5
           WHERE project_path = (SELECT project_path FROM sessions WHERE session_id = ?)
             AND is_active = 1 AND access_count > 0 AND last_accessed_at >= (SELECT started_at FROM sessions WHERE session_id = ?)`
        ).run(sessionId, sessionId);
      } catch { /* best-effort */ }
    }
  }

  return result;
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
    } catch (err) {
      console.warn('[agentic-cortex] embedAll failed for #' + row.id + ': ' + (err && err.message ? err.message : err));
    }
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
 * If opts.query is provided, performs adaptive context: semantic match +
 * utility ranking + trails + incorrect warnings tailored to the query.
 *
 * @param {Object} [opts] - { project?, query?: string }
 * @returns {Promise<string>} Markdown context
 */
async function context(opts) {
  opts = opts || {};
  const db = _getDB();
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();

  // If a query is provided, use the new bootstrap-style context
  if (opts.query) {
    return _buildBootstrapContext(db, project, opts.query, opts);
  }

  const sessions = db.prepare(
    'SELECT id, session_id, project_name, user_prompt, summary, started_at, ended_at FROM sessions WHERE project_path = ? ORDER BY started_at DESC LIMIT 5'
  ).all(project);

  const observations = db.prepare(
    "SELECT id, session_id, type, title, substr(content, 1, 200) as preview, tags, importance, predicted_utility, created_at FROM observations WHERE project_path = ? AND is_active = 1 AND tags NOT LIKE '%coding-standard%' ORDER BY (importance + predicted_utility) DESC, created_at DESC LIMIT 20"
  ).all(project);

  let pack = '# Agentic Cortex - Project Context\n\n';

  // Layer 3: Principles — hardened, battle-tested knowledge (AutoGTM's seed layer)
  try {
    const principles = core.reflection.getPrinciples(db, project, 5);
    if (principles.length > 0) {
      pack += '## 🔷 Hardened Principles (always in effect)\n';
      for (const p of principles) {
        let tags = '';
        try { const arr = JSON.parse(p.tags || '[]'); tags = arr.filter(t => !['principle', 'auto-crystallized', 'synthesis'].includes(t)).join(', '); } catch {}
        pack += `- **${p.title || '(untitled)'}** (conf: ${p.confidence}%, util: ${p.predicted_utility || 0})${tags ? ' — ' + tags : ''}\n`;
      }
      pack += '\n';
    }
  } catch { /* best-effort */ }

  // Coding standards: always injected, phase-aware, pre-loaded
  pack += standards.getStandardsContext();
  pack += '\n---\n\n';

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
    pack += '## Key Observations (ranked by utility)\n';
    const byType = {};
    for (const o of observations) { (byType[o.type] = byType[o.type] || []).push(o); }
    for (const [t, obs] of Object.entries(byType)) {
      pack += '### ' + t.charAt(0).toUpperCase() + t.slice(1) + '\n';
      for (const o of obs.slice(0, 5)) {
        let tags = '';
        try { const arr = JSON.parse(o.tags); if (arr.length) tags = ' [' + arr.join(', ') + ']'; } catch {}
        pack += '- ' + (o.title || o.preview) + tags + ' (★' + o.predicted_utility + ')\n';
      }
      pack += '\n';
    }
  }

  // Warnings: previously incorrect/unreliable memories
  try {
    const warnings = db.prepare(
      "SELECT id, type, title, content FROM observations WHERE project_path = ? AND is_active = 1 AND tags LIKE '%incorrect%' ORDER BY created_at DESC LIMIT 5"
    ).all(project);
    if (warnings.length > 0) {
      pack += '## ⚠️ Previously Incorrect / Unreliable\n';
      for (const w of warnings) {
        pack += '- [' + w.type.toUpperCase() + '] ' + (w.title || w.content.slice(0, 80)) + '\n';
      }
      pack += '\n';
    }
  } catch {}

  if (!sessions.length && !observations.length) {
    pack += '_No previous memory for this project yet._\n';
  }

  // Track access for observations included in context
  _trackAccess(db, observations.map(o => o.id));

  return pack;
}

// ─── Bootstrap Context (Phase 1+2: Structured, LLM-Optimized) ────────

/**
 * Build a structured, token-budget-aware context optimized for LLM consumption.
 * Uses XML-style tagging for hierarchical parsing, full content (not previews),
 * hybrid search + reranking for task-relevant memories, and LLM-powered
 * memory summarization for actionable insights.
 *
 * Called automatically by context() when opts.query is provided, and exposed
 * as a standalone function for the memory_bootstrap MCP tool.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project - Project path
 * @param {string} workingOn - What the agent is working on (query for search)
 * @param {Object} [opts] - { includeStandards?, includeGraph?, budgetTokens? }
 * @returns {Promise<string>} Structured XML-tagged context
 */
async function _buildBootstrapContext(db, project, workingOn, opts = {}) {
  const includeStandards = opts.includeStandards !== false; // default true
  const includeGraph = opts.includeGraph !== false;          // default true
  const budgetTokens = opts.budgetTokens || 4000;
  const now = new Date().toISOString();

  let output = `<agentic_cortex_context project="${_xmlEscape(project)}" generated="${now}" task="${_xmlEscape(workingOn)}">\n`;
  let tokenEstimate = 0;

  // ── Layer 0: Auto-start session if none active ──
  let sessionId = process.env.AGENTIC_CORTEX_SESSION || null;
  if (!sessionId) {
    try {
      const sess = startSession({ project, prompt: workingOn });
      sessionId = sess.session_id;
      process.env.AGENTIC_CORTEX_SESSION = sessionId;
      output += `  <session_started id="${_xmlEscape(sessionId)}" />\n`;
    } catch { /* best-effort */ }
  }

  // ── Layer 0.5: Team memory sync result ──
  if (opts._syncResult) {
    const sr = opts._syncResult;
    if (sr.pulled > 0) {
      output += `  <team_memory_sync status="ok" pulled="${sr.pulled}" new="${sr.new || 0}" updated="${sr.updated || 0}" repo="${_xmlEscape(sr.repoUrl || '')}" />\n`;
    } else if (sr.reason) {
      output += `  <team_memory_sync status="skipped" reason="${_xmlEscape(sr.reason)}" />\n`;
    }
  }
  // Always report available global observations (may exist from prior syncs)
  try {
    const globalCount = db.prepare('SELECT COUNT(*) as c FROM observations WHERE project_path = ? AND is_active = 1').get('__global__').c;
    if (globalCount > 0) {
      output += `  <team_memory_available count="${globalCount}" scope="__global__">Community knowledge from team memory repo is available for this session</team_memory_available>\n`;
    }
  } catch { /* best-effort */ }

  // ── Layer 1: Actionable Insights (LLM summary of relevant memories) ──
  try {
    const insights = await _summarizeMemories(db, project, workingOn);
    if (insights) {
      output += `  <actionable_insights>\n    ${_xmlEscape(insights)}\n  </actionable_insights>\n`;
      tokenEstimate += Math.ceil(insights.length / 4);
    }
  } catch { /* best-effort */ }

  // ── Layer 2: Task-Relevant Memories (hybrid search + reranking) ──
  try {
    const queryVec = await core.embedding.computeEmbedding(workingOn).catch(() => null);
    let relevant;
    if (queryVec) {
      relevant = core.search.hybridSearch(db, workingOn, queryVec, { project, limit: 30 });
      // Apply cross-encoder reranking for precision
      try {
        relevant = await core.search.rerankResults(workingOn, relevant);
      } catch { /* use hybrid scores as-is */ }
    } else {
      relevant = core.search.keywordSearch(db, { query: workingOn, project, limit: 20 });
    }

    if (relevant && relevant.length > 0) {
      // Fetch full content for top results
      const topIds = relevant.slice(0, 12).map(r => r.id);
      const placeholders = topIds.map(() => '?').join(',');
      const fullRows = db.prepare(
        'SELECT id, agent_id, type, title, content, tags, importance, confidence, provenance, predicted_utility, freshness_score, created_at FROM observations WHERE id IN (' + placeholders + ')'
      ).all(...topIds);
      const fullMap = new Map(fullRows.map(r => [r.id, r]));

      output += '  <relevant_memories count="' + Math.min(relevant.length, 12) + '">\n';

      // Split into critical (confidence >= 85) and important tiers
      const critical = [];
      const important = [];
      for (const r of relevant.slice(0, 12)) {
        const full = fullMap.get(r.id);
        if (!full) continue;
        const score = r.rerank_score || r.combined_score || r.semantic_score || 0;
        const confidence = full.confidence || 100;
        const tier = (confidence >= 85 && score >= 0.6) ? critical : important;
        tier.push({ ...full, relevance_score: Math.round(score * 1000) / 1000 });
      }

      if (critical.length > 0) {
        output += '    <tier priority="critical">\n';
        for (const mem of critical.slice(0, 5)) {
          const tags = _safeJsonParse(mem.tags, []);
          const tagsStr = tags.length ? ' tags="' + _xmlEscape(tags.join(',')) + '"' : '';
          output += `      <memory type="${_xmlEscape(mem.type)}" confidence="${mem.confidence}" utility="${mem.predicted_utility || 0}" relevance="${mem.relevance_score}" freshness="${mem.freshness_score || 50}"${tagsStr}>\n`;
          output += `        <title>${_xmlEscape(mem.title || '(untitled)')}</title>\n`;
          output += `        <content>${_xmlEscape(_truncateContent(mem.content, 600))}</content>\n`;
          output += `      </memory>\n`;
          tokenEstimate += Math.ceil(((mem.title || '').length + _truncateContent(mem.content, 600).length) / 4);
        }
        output += '    </tier>\n';
      }

      if (important.length > 0) {
        output += '    <tier priority="important">\n';
        for (const mem of important.slice(0, 7)) {
          const tags = _safeJsonParse(mem.tags, []);
          const tagsStr = tags.length ? ' tags="' + _xmlEscape(tags.join(',')) + '"' : '';
          output += `      <memory type="${_xmlEscape(mem.type)}" confidence="${mem.confidence}" utility="${mem.predicted_utility || 0}" relevance="${mem.relevance_score}"${tagsStr}>\n`;
          output += `        <title>${_xmlEscape(mem.title || '(untitled)')}</title>\n`;
          output += `        <content>${_xmlEscape(_truncateContent(mem.content, 400))}</content>\n`;
          output += `      </memory>\n`;
          tokenEstimate += Math.ceil(((mem.title || '').length + _truncateContent(mem.content, 400).length) / 4);
        }
        output += '    </tier>\n';
      }
      output += '  </relevant_memories>\n';

      _trackAccess(db, fullRows.map(r => r.id));
    }
  } catch { /* hybrid search unavailable — skip layer */ }

  // ── Layer 2.5: Past Failures on Similar Tasks ──
  try {
    const failRows = db.prepare(
      "SELECT id, type, title, content, confidence, tags FROM observations WHERE project_path = ? AND is_active = 1 AND type IN ('error', 'failure') AND confidence < ? ORDER BY created_at DESC LIMIT 20"
    ).all(project, 50);

    if (failRows.length > 0) {
      // Rank failures by similarity to workingOn
      const failVec = await core.embedding.computeEmbedding(workingOn).catch(() => null);
      let ranked = failRows;
      if (failVec && core.embedding.cosineSimilarity) {
        ranked = failRows.map(row => {
          const rowVec = row.embedding || null;
          const sim = rowVec ? core.embedding.cosineSimilarity(failVec, rowVec) : 0;
          // Keyword boost: add up to 0.3 based on word overlap, ensuring embedding misses don't hide relevant failures
          const kwBoost = _keywordOverlap(workingOn, (row.title || '') + ' ' + (row.content || ''));
          const boostedSim = Math.min(1.0, sim + kwBoost * 0.3);
          return { ...row, _sim: boostedSim, _embeddingSim: sim, _keywordBoost: kwBoost };
        }).sort((a, b) => b._sim - a._sim);
      } else {
        // Fallback: keyword-only ranking
        ranked = failRows.map(row => {
          const kwBoost = _keywordOverlap(workingOn, (row.title || '') + ' ' + (row.content || ''));
          return { ...row, _sim: kwBoost, _embeddingSim: 0, _keywordBoost: kwBoost };
        }).sort((a, b) => b._sim - a._sim);
      }

      const top3 = ranked.slice(0, 3);
      const top3Ids = top3.map(r => r.id);

      if (top3.length > 0) {
        // Track ignore counts and build escalated warning language
        let warningLevel = 'standard';
        const ignoredIds = [];
        for (const fail of top3) {
          const tracker = _ignoredWarnings.get(fail.id) || { count: 0, lastShown: null };
          tracker.count++;
          tracker.lastShown = new Date().toISOString();
          tracker.title = fail.title;
          _ignoredWarnings.set(fail.id, tracker);
          _pruneIgnoredWarnings();
          if (tracker.count >= 3) ignoredIds.push(fail.id);
          if (tracker.count >= 5) warningLevel = 'escalated';
          else if (tracker.count >= 3 && warningLevel !== 'escalated') warningLevel = 'critical';
        }

        output += `  <past_failures_on_similar_tasks count="${top3.length}" warning_level="${warningLevel}">\n`;

        if (warningLevel === 'escalated') {
          output += '    <warning severity="escalated">ESCALATED: one or more of these failures has been shown 5+ times and repeatedly IGNORED. Using this approach WILL cause failure. Choose a DIFFERENT approach now.</warning>\n';
        } else if (warningLevel === 'critical') {
          output += '    <warning severity="critical">CRITICAL: you have IGNORED one or more of these warnings 3+ times. DO NOT repeat these approaches — they WILL fail again.</warning>\n';
        } else {
          output += '    <warning severity="standard">EXPLICITLY AVOID these past approaches — they failed in this project. Pick a DIFFERENT path.</warning>\n';
        }

        for (const fail of top3) {
          const tracker = _ignoredWarnings.get(fail.id);
          const ignoreInfo = tracker && tracker.count > 1 ? ` ignored_count="${tracker.count}"` : '';
          const simStr = fail._sim > 0 ? ` similarity="${fail._sim.toFixed(2)}"` : '';
          output += `    <failure type="${_xmlEscape(fail.type)}" confidence="${fail.confidence}"${simStr}${ignoreInfo}>\n`;
          output += `      <title>${_xmlEscape(fail.title || '(untitled)')}</title>\n`;
          output += `      <content>${_xmlEscape(_truncateContent(fail.content, 400))}</content>\n`;
          output += '    </failure>\n';
          tokenEstimate += Math.ceil(((fail.title || '').length + _truncateContent(fail.content, 400).length) / 4);
        }
        output += '  </past_failures_on_similar_tasks>\n';

        _trackAccess(db, top3Ids);
      }
    }
  } catch { /* past failures query failed — skip */ }

  // ── Layer 3: Recent Sessions ──
  try {
    const sessions = db.prepare(
      'SELECT session_id, user_prompt, summary, started_at, ended_at FROM sessions WHERE project_path = ? ORDER BY started_at DESC LIMIT 3'
    ).all(project);
    if (sessions.length > 0) {
      output += '  <recent_sessions>\n';
      for (const s of sessions) {
        const status = s.ended_at ? 'completed' : 'active';
        output += `    <session id="${_xmlEscape(s.session_id)}" status="${status}" started="${s.started_at || '?'}">\n`;
        output += `      <summary>${_xmlEscape(s.summary || s.user_prompt || 'No summary')}</summary>\n`;
        output += `    </session>\n`;
        tokenEstimate += Math.ceil(((s.summary || s.user_prompt || '').length) / 4);
      }
      output += '  </recent_sessions>\n';
    }
  } catch {}

  // ── Layer 4: Warnings (incorrect/unreliable memories) ──
  try {
    const warnings = db.prepare(
      "SELECT id, type, title, content FROM observations WHERE project_path = ? AND is_active = 1 AND tags LIKE '%incorrect%' ORDER BY created_at DESC LIMIT 5"
    ).all(project);
    if (warnings.length > 0) {
      output += '  <warnings>\n';
      for (const w of warnings) {
        output += `    <warning type="${_xmlEscape(w.type)}" id="${w.id}">${_xmlEscape(w.title || w.content.slice(0, 120))}</warning>\n`;
      }
      output += '  </warnings>\n';
      tokenEstimate += 100;
    }
  } catch {}

  // ── Layer 5: Coding Standards (collapsed/summarized) ──
  if (includeStandards) {
    const standardsSummary = _getStandardsSummary();
    output += `  <coding_standards collapsed="true">\n    <summary>${_xmlEscape(standardsSummary)}</summary>\n  </coding_standards>\n`;
    tokenEstimate += Math.ceil(standardsSummary.length / 4);
  }

  // ── Layer 5.5: Global Vault (machine-wide immune system) ──
  try {
    const globalMemories = db.prepare(
      'SELECT id, type, title, content, confidence, predicted_utility, freshness_score, tags FROM observations WHERE project_path = ? AND is_active = 1 ORDER BY (predicted_utility + COALESCE(freshness_score, 50)) DESC LIMIT 20'
    ).all('__global__');

    if (globalMemories.length > 0) {
      // Filter: find global memories semantically relevant to workingOn
      let relevantGlobal = globalMemories;
      try {
        const globalVec = await core.embedding.computeEmbedding(workingOn).catch(() => null);
        if (globalVec) {
          const scored = globalMemories.map(m => {
            // Score by title match (fast keyword check) + utility
            const titleWords = (m.title || '').toLowerCase().split(/\s+/);
            const queryWords = workingOn.toLowerCase().split(/\s+/);
            const wordMatch = titleWords.filter(w => queryWords.some(q => q.includes(w) || w.includes(q))).length;
            const keywordScore = wordMatch / Math.max(queryWords.length, 1);
            return { ...m, _relevance: keywordScore * 0.4 + ((m.predicted_utility || 0) / 30) * 0.3 + (m.confidence / 100) * 0.3 };
          });
          scored.sort((a, b) => b._relevance - a._relevance);
          relevantGlobal = scored.slice(0, 5);
        }
      } catch { /* use utility ranking */ }

      if (relevantGlobal.length > 0) {
        output += '  <global_vault count="' + relevantGlobal.length + '">\n';
        // Always show a summary line explaining the concept
        const vaultSize = db.prepare('SELECT COUNT(*) as c FROM observations WHERE project_path = ? AND is_active = 1').get('__global__').c;
        output += `    <summary>Machine-wide immune system — ${vaultSize} battle-tested learnings from all projects. These prevented mistakes from repeating across projects.</summary>\n`;
        for (const mem of relevantGlobal.slice(0, 3)) {
          const tags = _safeJsonParse(mem.tags, []);
          const tagsStr = tags.filter(t => !['machine-global', 'cross-project', 'auto-promoted'].includes(t)).join(',');
          output += `    <global_rule type="${_xmlEscape(mem.type)}" confidence="${mem.confidence}" utility="${mem.predicted_utility || 0}" original_tags="${_xmlEscape(tagsStr)}">\n`;
          output += `      <title>${_xmlEscape(mem.title || '(untitled)')}</title>\n`;
          output += `      <content>${_xmlEscape(_truncateContent(mem.content, 300))}</content>\n`;
          output += `    </global_rule>\n`;
          tokenEstimate += Math.ceil(((mem.title || '').length + _truncateContent(mem.content, 300).length) / 4);
        }
        output += '  </global_vault>\n';
      }
      // Track access for global memories shown in bootstrap
      _trackAccess(db, relevantGlobal.map(r => r.id));
    }
  } catch { /* global vault query failed — skip */ }

  // ── Layer 6: Codebase Graph (budget-limited) ──
  if (includeGraph) {
    try {
      const graphRemaining = Math.max(200, budgetTokens - tokenEstimate - 300);
      const graphBlock = _getGraphSummary(project, graphRemaining);
      if (graphBlock) {
        output += `  ${graphBlock}\n`;
      }
    } catch {}
  }

  output += '</agentic_cortex_context>';

  // ── Layer 7: Usage instructions (appended after XML block) ──
  output += '\n\n<!--\nINSTRUCTIONS: The above is your project memory context. Use it to:\n1. Avoid repeating past mistakes (check <warnings>)\n2. Apply previous learnings (check <actionable_insights>)\n3. Search deeper if needed: agentic-cortex search "your query" --project .\n4. Save new observations: agentic-cortex save "title" "content" --type decision\n5. Get full coding standard details: agentic-cortex standards --search "topic"\n-->\n';

  return output;
}

/**
 * Summarize task-relevant memories into actionable insights using LLM.
 * Falls back to template-based summary if LLM is unavailable.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @param {string} workingOn
 * @returns {Promise<string>} 1-3 sentence actionable insight
 */
async function _summarizeMemories(db, project, workingOn) {
  // Get top observations for this project ranked by utility + freshness
  const topObs = db.prepare(
    'SELECT type, title, content, confidence, predicted_utility, freshness_score FROM observations WHERE project_path = ? AND is_active = 1 AND tags NOT LIKE \'%coding-standard%\' ORDER BY (predicted_utility + COALESCE(freshness_score, 50)) DESC LIMIT 8'
  ).all(project);

  if (topObs.length === 0) return null;

  const obsText = topObs.map((o, i) =>
    `${i + 1}. [${o.type}] ${o.title || '(untitled)'}: ${o.content.slice(0, 200)}`
  ).join('\n');

  try {
    const { callLLM } = require('../core/session');
    const prompt = `You are a context summarizer for a coding agent. Given the agent is about to work on "${workingOn}" and has the following past memories, produce 2-4 actionable sentences. Focus on: what mistakes to avoid, what decisions were made, what patterns worked. Be specific. Output plain text, no formatting.\n\nPast memories:\n${obsText}`;

    const result = await callLLM([
      { role: 'system', content: 'You produce concise, actionable context summaries for coding agents. Output 2-4 sentences, plain text.' },
      { role: 'user', content: prompt },
    ], { temperature: 0.2, maxTokens: 400, timeout: 5000 });

    if (result) {
      const cleaned = result.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (cleaned && cleaned.length > 10) return cleaned;
    }
  } catch { /* LLM unavailable */ }

  // Fallback: template-based summary
  const byType = {};
  for (const o of topObs.slice(0, 5)) {
    (byType[o.type] = byType[o.type] || []).push(o.title || o.content.slice(0, 60));
  }
  const parts = [];
  if (byType.decision) parts.push('Past decisions: ' + byType.decision.slice(0, 2).join('; '));
  if (byType.error) parts.push('Errors encountered: ' + byType.error.slice(0, 2).join('; '));
  if (byType.learning) parts.push('Learnings: ' + byType.learning.slice(0, 2).join('; '));
  if (byType.preference) parts.push('Preferences: ' + byType.preference.slice(0, 2).join('; '));

  if (parts.length === 0) return 'No specific insights from past sessions. Proceed with caution.';
  return parts.join('. ') + '.';
}

/**
 * Get a condensed summary of coding standards (titles + categories only).
 * Saves ~2000 tokens vs the full standards block.
 *
 * @returns {string}
 */
function _getStandardsSummary() {
  const phases = [
    { key: 'all', label: 'Always Active' },
    { key: 'planning', label: 'Planning' },
    { key: 'implementation', label: 'Implementation' },
    { key: 'review', label: 'Review' },
  ];
  let summary = 'Key rules: ';
  const rules = [];
  for (const phase of phases) {
    const items = standards.ALL_STANDARDS.filter(s => s.phase === phase.key);
    for (const s of items.slice(0, 4)) {
      rules.push(`[${s.category}] ${s.title}`);
    }
  }
  summary += rules.slice(0, 12).join(' | ');
  summary += '. Use `agentic-cortex standards --search "topic"` for full details on any standard.';
  return summary;
}

/**
 * Get a structured XML codebase graph summary limited to a token budget.
 * Reads from .infinit-graph.json cache if available, or extracted from knowledge.md.
 * Returns real XML (not escaped) for direct embedding in bootstrap context.
 *
 * @param {string} project
 * @param {number} tokenBudget - Approximate token budget for graph
 * @returns {string|null}
 */
function _getGraphSummary(project, tokenBudget) {
  const fs = require('fs');
  const path = require('path');
  const graphPath = path.join(project, '.infinit-graph.json');

  // Try the JSON cache first
  if (fs.existsSync(graphPath)) {
    try {
      const graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
      let xml = `<codebase_graph files="${graph.fileCount}" api_routes="${(graph.apiRoutes || []).length}" generated="${graph.generated || '?'}">`;

      if (graph.paradigms && graph.paradigms.length > 0) {
        let stackStr = '';
        if (graph.techStack) {
          const ts = graph.techStack;
          const parts = [];
          if (ts.runtime && ts.runtime.length) parts.push('Lang: ' + ts.runtime.join(','));
          if (ts.frameworks && ts.frameworks.length) parts.push('Framework: ' + ts.frameworks.join(','));
          if (ts.databases && ts.databases.length) parts.push('DB: ' + ts.databases.join(','));
          if (ts.tools && ts.tools.length) parts.push('Tools: ' + ts.tools.join(','));
          if (parts.length) stackStr = ` stack="${_xmlEscape(parts.join(' | '))}"`;
        }
        xml += `<architecture patterns="${_xmlEscape(graph.paradigms.join(', '))}"${stackStr}/>`;
      }

      if (graph.layerMap && graph.layerMap.requestPath) {
        const lc = graph.layerMap.layerCounts;
        xml += `<layers dataflow="${_xmlEscape(graph.layerMap.requestPath)}" ui="${lc.UI}" api="${lc.API}" service="${lc.Service}" data="${lc.Data}"/>`;
        if (graph.layerMap.hubFiles && graph.layerMap.hubFiles.length > 0) {
          xml += `<hub_files>${graph.layerMap.hubFiles.slice(0, 8).map(h => _xmlEscape(h.path)).join(', ')}</hub_files>`;
        }
      }

      // Include key libraries (most import count)
      const libEntries = Object.entries(graph.graph || {})
        .filter(([, n]) => n.role === 'library')
        .sort(([, a], [, b]) => (b.imports?.length || 0) - (a.imports?.length || 0))
        .slice(0, 12);
      if (libEntries.length > 0) {
        xml += '<libraries>';
        for (const [libPath, node] of libEntries) {
          const exports = (node.exports || []).filter(e => !e.startsWith('model:')).slice(0, 8);
          const expStr = exports.length ? ` exports="${_xmlEscape(exports.join(','))}"` : '';
          let fnStr = '';
          if (node.functions && node.functions.length > 0) {
            const sigs = node.functions.slice(0, 5).map(f => f.name + '(' + (f.params || []).map(p => p.name).join(',') + ')');
            fnStr = ` fns="${_xmlEscape(sigs.join(';'))}"`;
          }
          xml += `<file path="${_xmlEscape(libPath)}"${expStr}${fnStr}/>`;
        }
        xml += '</libraries>';
      }

      // Scripts
      const scriptEntries = Object.entries(graph.graph || {}).filter(([, n]) => n.role === 'script');
      if (scriptEntries.length > 0) {
        xml += '<scripts>';
        for (const [p] of scriptEntries.slice(0, 10)) xml += `<file path="${_xmlEscape(p)}"/>`;
        xml += '</scripts>';
      }

      xml += '</codebase_graph>';
      // Truncate to budget safely — ensure we close the root tag
      const maxChars = tokenBudget * 4;
      if (xml.length > maxChars) {
        const closingLen = '</codebase_graph>'.length;
        const safeLen = Math.max(100, maxChars - closingLen);
        xml = xml.slice(0, safeLen) + '</codebase_graph>';
      }
      return xml;
    } catch {
      // JSON parse failed, try knowledge.md fallback
    }
  }

  // Fallback: extract from knowledge.md (markdown graph -> convert to XML)
  try {
    const knowledgePath = path.join(project, 'knowledge.md');
    if (fs.existsSync(knowledgePath)) {
      const content = fs.readFileSync(knowledgePath, 'utf-8');
      // Try to find XML codebase_graph block first (new format)
      const xmlMatch = content.match(/<codebase_graph[\s\S]*?<\/codebase_graph>/);
      if (xmlMatch) return xmlMatch[0].slice(0, tokenBudget * 4);

      // Fall back to old markdown format
      const m = content.match(/## Codebase Graph\n([\s\S]*?)(?:\n## |\n<!--|$)/);
      if (m) {
        const text = m[1].trim().slice(0, tokenBudget * 4);
        return `<codebase_graph><raw>${_xmlEscape(text)}</raw></codebase_graph>`;
      }
    }
  } catch {}

  return null;
}

/**
 * Escape text for safe inclusion in XML content.
 * @param {string} text
 * @returns {string}
 */
function _xmlEscape(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Truncate content to maxChars while preserving word boundaries.
 * @param {string} content
 * @param {number} maxChars
 * @returns {string}
 */
function _truncateContent(content, maxChars) {
  if (!content || content.length <= maxChars) return content || '';
  const truncated = content.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.8 ? truncated.slice(0, lastSpace) : truncated) + '...';
}

/**
 * Parse JSON safely, returning a default on failure.
 * @param {string} json
 * @param {*} defaultVal
 * @returns {*}
 */
function _safeJsonParse(json, defaultVal) {
  try { return JSON.parse(json); } catch { return defaultVal; }
}

/**
 * Bootstrap context for an agent session — the main entry point for agents.
 * Auto-starts a session, retrieves task-relevant memories via hybrid search
 * with cross-encoder reranking, generates actionable insights via LLM, and
 * returns a structured XML-tagged context block optimized for LLM consumption.
 *
 * **Zero-parameter by default**: Just run `agentic-cortex bootstrap` with no
 * arguments. The system infers what you're working on from your session,
 * git branch, and recent activity. No need to describe your task.
 *
 * @param {Object} [opts] - { workingOn?: string, project?: string, includeStandards?: boolean, includeGraph?: boolean, budgetTokens?: number }
 * @returns {Promise<string>} Structured XML-tagged context
 */
async function bootstrap(opts) {
  opts = opts || {};
  const db = _getDB();
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();

  // ── Layer -1: Pull from team memory repo (Git sync) ──
  // syncPull resolves the repo URL from env var > sync-config.json, so no guard needed
  let syncResult = null;
  try {
    const { syncPull, _getRepoUrl } = require('../sync/git-sync');
    const repoUrl = _getRepoUrl();
    if (repoUrl) {
      syncResult = syncPull(db, repoUrl);
    }
  } catch (err) {
    console.warn('[agentic-cortex] Git sync pull failed (non-fatal):', err.message);
  }

  // Infer what the agent is working on if not explicitly provided
  const workingOn = opts.workingOn || _inferTask(db, project);

  // Pass sync result through so bootstrap context can report it
  if (syncResult) opts._syncResult = syncResult;

  const result = await _buildBootstrapContext(db, project, workingOn, opts);

  // Auto-reflect: trigger background reflect after every Nth bootstrap
  _bootstrapCount++;
  if (_bootstrapCount % AUTO_REFLECT_INTERVAL === 0 && !_autoReflectRunning) {
    _autoReflectRunning = true;
    (async () => {
      try {
        await core.reflection.reflect(_getDB(), { project });
        console.warn('[api] Auto-reflect triggered after %d bootstraps for project %s', _bootstrapCount, project);
      } catch (e) {
        console.error('[api] Auto-reflect failed:', e.message);
      } finally {
        _autoReflectRunning = false;
      }
    })();
  }

  return result;
}

/**
 * Infer what the agent is currently working on.
 * Tries multiple signals in priority order:
 *   1. Active session's user_prompt (most reliable)
 *   2. Git branch name (run `git branch --show-current`)
 *   3. Most recent observation title
 *   4. Falls back to generic project name
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @returns {string} Inferred task description
 */
function _inferTask(db, project) {
  // Signal 1: Active session's user prompt
  try {
    const sid = process.env.AGENTIC_CORTEX_SESSION;
    if (sid) {
      const session = db.prepare(
        'SELECT user_prompt FROM sessions WHERE session_id = ? AND ended_at IS NULL'
      ).get(sid);
      if (session && session.user_prompt && session.user_prompt.length > 3) {
        return session.user_prompt;
      }
    }
    // Fall back to most recent session prompt
    const lastSession = db.prepare(
      'SELECT user_prompt FROM sessions WHERE project_path = ? ORDER BY started_at DESC LIMIT 1'
    ).get(project);
    if (lastSession && lastSession.user_prompt && lastSession.user_prompt.length > 3) {
      return lastSession.user_prompt;
    }
  } catch {}

  // Signal 2: Git branch name
  try {
    const { execSync } = require('child_process');
    const branch = execSync('git branch --show-current', {
      encoding: 'utf-8',
      cwd: project,
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (branch && branch.length > 1 && branch !== 'main' && branch !== 'master') {
      // Convert branch name to readable task: "fix-login-bug" → "fix login bug"
      return branch.replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
    }
  } catch {}

  // Signal 3: Most recent observation
  try {
    const lastObs = db.prepare(
      'SELECT title, content FROM observations WHERE project_path = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1'
    ).get(project);
    if (lastObs) {
      const text = (lastObs.title || lastObs.content || '').slice(0, 120);
      if (text.length > 5) return text;
    }
  } catch {}

  // Signal 4: Project name
  try {
    const path = require('path');
    return 'working on ' + path.basename(project);
  } catch {
    return 'working on this project';
  }
}

// ─── Proactive Warning Hook ───────────────────────────────────────────

/**
 * Check a new observation against recent errors to proactively warn
 * the agent BEFORE they repeat a known failure pattern.
 * Registered as a pre_save hook during init().
 */
function _checkNewObsAgainstErrors(observation, context, db) {
  // Only check observations that aren't themselves errors/failures
  if (observation.type === 'error' || observation.type === 'failure') return;

  try {
    const project = observation.project_path || context?.project || null;
    if (!project) return;

    // Get last 50 errors/failures in this project
    const recentErrors = db.prepare(
      "SELECT id, type, title, content, tags, confidence FROM observations WHERE project_path = ? AND is_active = 1 AND type IN ('error', 'failure') ORDER BY created_at DESC LIMIT 50"
    ).all(project);

    if (recentErrors.length === 0) return;

    const newText = (observation.title || '') + ' ' + (observation.content || '');
    let bestMatch = null;
    let bestOverlap = 0;

    for (const err of recentErrors) {
      const kwOverlap = _keywordOverlap(newText, (err.title || '') + ' ' + (err.content || ''));
      if (kwOverlap > bestOverlap) {
        bestOverlap = kwOverlap;
        bestMatch = err;
      }
    }

    // Threshold: warn when overlap exceeds 0.25 (substantial keyword match)
    if (bestOverlap >= 0.25 && bestMatch) {
      console.error(
        '[agentic-cortex] ⚠️ PROACTIVE WARNING: New observation "%s" (type=%s) closely matches a known ERROR #%d "%s" (confidence=%d, keyword-overlap=%.2f). Consider if you are about to repeat this failure.',
        (observation.title || observation.content || '').slice(0, 80),
        observation.type,
        bestMatch.id,
        (bestMatch.title || bestMatch.content || '').slice(0, 60),
        bestMatch.confidence || 0,
        bestOverlap
      );
    }
  } catch { /* best-effort — never block a save */
    console.warn('[agentic-cortex] Proactive warning check failed (non-fatal):', err && err.message ? err.message : err);
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────

/** Initialize the database (idempotent) */
// Track whether proactive warning hook has been registered (idempotent guard)
let _proactiveWarningHookRegistered = false;

async function init() {
  _getDB();
  // Initialize auto-maintenance scheduler on first init
  initMaintenanceScheduler();

  // Register proactive warning hook (idempotent — only once)
  if (!_proactiveWarningHookRegistered) {
    core.hooks.registerHook('pre_save', _checkNewObsAgainstErrors);
    _proactiveWarningHookRegistered = true;
  }

  // Auto-seed coding standards on first init (zero user action needed)
  try {
    const project = process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
    await standards.ensureStandardsExist(_getDB(), project, save);
  } catch (err) {
    console.warn('[agentic-cortex] Standards seeding failed:', err.message);
  }

  return { status: 'initialized', dbPath: core.db.getDbPath() };
}

/** Close the database connection and release pipeline resources */
function close() {
  if (_apiDb) {
    _apiDb.close();
    _apiDb = null;
  }
  try {
    core.embedding.disposePipelines();
  } catch (err) {
    console.warn('[agentic-cortex] Pipeline disposal failed: ' + (err && err.message ? err.message : err));
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
  } catch (err) {
    console.warn('[agentic-cortex] Health dimension check failed: ' + (err && err.message ? err.message : err));
  }

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

// ─── Intent → Action → Outcome Tracking ───────────────────────────────

/**
 * Record an agent action as a linked triplet of observations:
 *   intent (what the agent tried to do)
 *   action (what the agent did)
 *   outcome (what happened)
 *
 * All three are linked via 'achieves' and 'produces' relations so the
 * self-improve loop can compare intents to outcomes for evidence-based
 * confidence scoring.
 *
 * @param {Object} opts - { intent: string, action: string, outcome: string, project?: string, agentId?: string, confidence?: number }
 * @returns {Promise<{intentId: number, actionId: number, outcomeId: number, status: string}>}
 */
async function recordAction(opts) {
  if (!opts.intent || !opts.action || !opts.outcome) {
    throw new Error('intent, action, and outcome are required');
  }
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const agentId = opts.agentId || null;
  const confidence = opts.confidence ?? 90;
  const db = _getDB();

  // Save all three as a transaction
  const intentObs = await save({
    title: 'Intent: ' + opts.intent.slice(0, 80),
    content: opts.intent,
    type: 'action',
    project,
    agentId,
    confidence,
    provenance: 'observed',
    tags: ['intent', 'action-triplet'],
  });

  const actionObs = await save({
    title: 'Action: ' + opts.action.slice(0, 80),
    content: opts.action,
    type: 'action',
    project,
    agentId,
    confidence,
    provenance: 'observed',
    tags: ['action', 'action-triplet'],
  });

  // Classify outcome via LLM with keyword fallback
  let classification = 'neutral';
  let usedFallback = false;
  try {
    classification = await core.selfImprove.classifyOutcome(opts.outcome);
  } catch {
    // Keyword fallback when LLM classifier unavailable
    usedFallback = true;
    const outcomeText = opts.outcome.toLowerCase();
    const succeeded = _KEYWORD_SUCCESS.some(w => outcomeText.includes(w));
    const failed = _KEYWORD_FAILURE.some(w => outcomeText.includes(w));
    classification = (succeeded && !failed) ? 'success' : failed ? 'failure' : 'neutral';
  }

  // Use first-class type based on classification
  const outcomeType = classification === 'success' ? 'success' : classification === 'failure' ? 'failure' : 'observation';
  const classificationTag = classification === 'success' ? 'success' : classification === 'failure' ? 'failure' : null;

  const outcomeObs = await save({
    title: 'Outcome: ' + opts.outcome.slice(0, 80),
    content: opts.outcome,
    type: outcomeType,
    project,
    agentId,
    confidence: 100,
    provenance: 'observed',
    tags: ['outcome', 'action-triplet', classificationTag].filter(Boolean),
  });

  // Link the triplet via relations: intent → achieves → action → produces → outcome
  await core.relations.addRelation(db, { sourceId: intentObs.id, targetId: actionObs.id, relationType: 'achieves', confidence: 90 });
  await core.relations.addRelation(db, { sourceId: actionObs.id, targetId: outcomeObs.id, relationType: 'produces', confidence: 90 });

  // Evidence-based confidence boost/decay driven by LLM classification
  if (classification === 'success') {
    db.prepare('UPDATE observations SET confidence = MIN(confidence + 3, 100) WHERE id = ?').run(intentObs.id);
    db.prepare('UPDATE observations SET confidence = MIN(confidence + 5, 100) WHERE id = ?').run(actionObs.id);
  } else if (classification === 'failure') {
    db.prepare('UPDATE observations SET confidence = MAX(confidence - 10, 10) WHERE id = ?').run(actionObs.id);
    db.prepare('UPDATE observations SET confidence = MAX(confidence - 5, 10) WHERE id = ?').run(intentObs.id);
  }

  return { intentId: intentObs.id, actionId: actionObs.id, outcomeId: outcomeObs.id, status: 'recorded', evidence: classification, classificationMethod: usedFallback ? 'keyword-fallback' : 'llm' };
}

// ─── Cross-Project Knowledge Transfer ─────────────────────────────────

/**
 * Transfer high-confidence observations from one project to another.
 * Applies a confidence decay modifier (default 0.8) and tags items as
 * cross-project transfers. Useful for sharing battle-tested learnings
 * and instructions across projects.
 *
 * @param {Object} opts - { fromProject: string, toProject: string, types?: string[], minConfidence?: number, confidenceModifier?: number }
 * @returns {Promise<{transferred: number, skipped: number}>}
 */
async function transferKnowledge(opts) {
  if (!opts.fromProject || !opts.toProject) {
    throw new Error('fromProject and toProject are required');
  }
  const db = _getDB();
  const minConf = opts.minConfidence ?? 80;
  const modifier = opts.confidenceModifier ?? 0.8;

  let sql = 'SELECT id, type, title, content, tags, importance, confidence, provenance, steps, triggers, preconditions, postconditions FROM observations WHERE project_path = ? AND is_active = 1 AND confidence >= ?';
  const params = [opts.fromProject, minConf];

  if (opts.types && opts.types.length > 0) {
    const ph = opts.types.map(() => '?').join(',');
    sql += ' AND type IN (' + ph + ')';
    params.push(...opts.types);
  }

  const candidates = db.prepare(sql + ' ORDER BY confidence DESC LIMIT 50').all(...params);
  let transferred = 0;
  let skipped = 0;

  for (const c of candidates) {
    // Skip if a similar observation already exists in the target project
    const existing = db.prepare(
      'SELECT id FROM observations WHERE project_path = ? AND title = ? AND is_active = 1'
    ).get(opts.toProject, c.title);
    if (existing) { skipped++; continue; }

    const newTags = JSON.stringify([
      ...(JSON.parse(c.tags || '[]')),
      'cross-project-transfer',
    ]);

    db.prepare(
      'INSERT INTO observations (project_path, agent_id, type, title, content, tags, importance, confidence, provenance, project_scope, steps, triggers, preconditions, postconditions) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      opts.toProject, null, c.type, c.title, c.content, newTags,
      c.importance, Math.round(c.confidence * modifier), c.provenance, 'global',
      c.steps, c.triggers, c.preconditions, c.postconditions
    );
    transferred++;
  }

  return { transferred, skipped };
}

// ─── Machine-Wide / Global Memory (Cross-Project Immune System) ──────

/**
 * Automatically promote a high-confidence, high-utility observation
 * to machine-wide (global) scope. Called during reflection/consolidation
 * and also exposed as a tool for manual promotion.
 *
 * Global memories act as a "machine-wide immune system" — if you learned
 * it once, you never make that mistake again anywhere on this machine.
 *
 * @param {number} id - Observation ID to promote
 * @param {Object} [opts] - { force?: boolean }
 * @returns {Promise<{id: number, status: string, previousScope: string}>}
 */
async function promoteToGlobal(id, opts = {}) {
  const db = _getDB();
  const obs = db.prepare(
    'SELECT id, project_path, type, title, content, confidence, predicted_utility, project_scope, tags FROM observations WHERE id = ? AND is_active = 1'
  ).get(id);
  if (!obs) throw new Error('Active observation not found: ' + id);

  // Only promote if high enough quality, unless forced
  if (!opts.force) {
    if (obs.confidence < 85) {
      throw new Error('Confidence too low for global promotion: ' + obs.confidence + '. Minimum: 85. Use --force to override.');
    }
    if ((obs.predicted_utility || 0) < 10) {
      throw new Error('Utility too low for global promotion: ' + (obs.predicted_utility || 0) + '. Minimum: 10. Use --force to override.');
    }
  }

  const previousScope = obs.project_scope || 'local';
  if (previousScope === 'global') {
    return { id, status: 'already_global', previousScope };
  }

  // Move the observation to the global namespace
  const newTags = [...new Set([...(JSON.parse(obs.tags || '[]')), 'machine-global', 'cross-project'])];
  db.prepare(
    'UPDATE observations SET project_path = ?, project_scope = ?, tags = ?, agent_id = NULL WHERE id = ?'
  ).run('__global__', 'global', JSON.stringify(newTags), id);

  return { id, status: 'promoted_to_global', previousScope };
}

/**
 * Auto-promote eligible high-quality learnings and instructions to global scope.
 * Called during reflection to automatically grow the machine-wide knowledge base.
 *
 * Uses RELATIVE thresholds (not hardcoded values):
 *   - Confidence: top 20% of all active learnings in this project (min floor: 70)
 *   - Utility: > 2x the project's median predicted_utility (min floor: 5)
 *
 * This self-tunes as the project grows — what qualifies as "high quality"
 * naturally increases over time.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} [project] - Optional: only promote from this project
 * @returns {{ promoted: number, candidates: number, thresholds: {confidence: number, utility: number} }}
 */
function autoPromoteGlobal(db, project) {
  // Compute RELATIVE thresholds from project data
  let confThreshold = 70; // floor
  let utilThreshold = 5;   // floor

  try {
    // Get confidence at 80th percentile of active learnings in this project
    const projectFilter = project ? ' AND project_path = ?' : '';
    const projectParams = project ? [project] : [];

    const confRows = db.prepare(
      `SELECT confidence FROM observations WHERE is_active = 1 AND type IN ('learning','instruction','fact','decision') AND project_scope = 'local'${projectFilter} ORDER BY confidence ASC`
    ).all(...projectParams);
    if (confRows.length >= 5) {
      const p80Idx = Math.floor(confRows.length * 0.8);
      confThreshold = Math.max(70, confRows[p80Idx]?.confidence || 70);
    }

    // Get median utility
    const utilRows = db.prepare(
      `SELECT predicted_utility FROM observations WHERE is_active = 1${projectFilter} ORDER BY predicted_utility ASC`
    ).all(...projectParams);
    if (utilRows.length >= 5) {
      const medianIdx = Math.floor(utilRows.length / 2);
      const median = utilRows[medianIdx]?.predicted_utility || 0;
      utilThreshold = Math.max(5, Math.ceil(median * 2));
    }
  } catch { /* use floor thresholds */ }

  let sql = `SELECT id, type, title, confidence, predicted_utility
    FROM observations
    WHERE is_active = 1
      AND project_scope = 'local'
      AND type IN ('learning', 'instruction', 'fact', 'decision')
      AND confidence >= ?
      AND predicted_utility >= ?
      AND tags NOT LIKE '%machine-global%'`;
  const params = [confThreshold, utilThreshold];

  if (project) {
    sql += ' AND project_path = ?';
    params.push(project);
  }

  sql += ' ORDER BY confidence DESC, predicted_utility DESC LIMIT 20';
  const candidates = db.prepare(sql).all(...params);

  let promoted = 0;
  const promotedIds = [];
  for (const c of candidates) {
    try {
      const existing = db.prepare(
        'SELECT id FROM observations WHERE project_path = ? AND title = ? AND is_active = 1'
      ).get('__global__', c.title);
      if (existing) continue;

      const obs = db.prepare('SELECT * FROM observations WHERE id = ?').get(c.id);
      const newTags = [...new Set([...(JSON.parse(obs.tags || '[]')), 'machine-global', 'cross-project', 'auto-promoted'])];
      db.prepare(
        'UPDATE observations SET project_path = ?, project_scope = ?, tags = ? WHERE id = ?'
      ).run('__global__', 'global', JSON.stringify(newTags), c.id);
      promoted++;
      promotedIds.push(c.id);
    } catch { /* skip individual failures */ }
  }

  if (promoted > 0) {
    console.error('[agentic-cortex] Auto-promoted %d memories to machine-wide global vault (from %d candidates, conf≥%d, util≥%d)', promoted, candidates.length, confThreshold, utilThreshold);

    // ── Push newly promoted global observations to team memory repo ──
    if (process.env.AGENTIC_CORTEX_MEMORY_REPO && promotedIds.length > 0) {
      try {
        const { syncPush } = require('../sync/git-sync');
        syncPush(db, promotedIds);
      } catch (err) {
        console.warn('[agentic-cortex] Git sync push failed (non-fatal):', err.message);
      }
    }
  }

  return { promoted, candidates: candidates.length, thresholds: { confidence: confThreshold, utility: utilThreshold } };
}

/**
 * Get the machine-wide global vault — all observations promoted to global scope.
 * These are battle-tested learnings, instructions, and facts that apply
 * across all projects on this machine.
 *
 * @param {Object} [opts] - { type?, limit?, minConfidence?, query? }
 * @returns {Promise<Object[]>}
 */
async function getGlobalVault(opts = {}) {
  const db = _getDB();
  const limit = opts.limit || 50;

  let sql = `SELECT id, type, title, content, tags, confidence, predicted_utility,
    freshness_score, created_at, steps, triggers, preconditions, postconditions, embedding
    FROM observations
    WHERE project_path = ? AND is_active = 1`;
  const params = ['__global__'];

  if (opts.type) { sql += ' AND type = ?'; params.push(opts.type); }
  if (opts.minConfidence) { sql += ' AND confidence >= ?'; params.push(opts.minConfidence); }

  sql += ' ORDER BY predicted_utility DESC, confidence DESC LIMIT ?';
  params.push(limit);

  const results = db.prepare(sql).all(...params);

  // Track access for global vault reads
  _trackAccess(db, results.map(r => r.id));

  if (opts.query && results.length > 0) {
    try {
      const queryVec = await core.embedding.computeEmbedding(opts.query);
      const scored = results.map(r => {
        try {
          const vec = r.embedding ? JSON.parse(r.embedding) : [];
          if (vec.length === 0 && queryVec && queryVec.length > 0) return { ...r, _score: 0 };
          return { ...r, _score: core.embedding.cosineSimilarity(queryVec, vec) };
        } catch { return { ...r, _score: 0 }; }
      });
      scored.sort((a, b) => b._score - a._score);
      return scored.slice(0, limit).map(({ _score, embedding, ...r }) => r);
    } catch { /* embedding unavailable — return as-is */ }
  }

  return results.map(({ embedding, ...r }) => r);
}

/**
 * Search across ALL projects (not just current) on this machine.
 * Uses hybrid search when embeddings are available, falls back to keyword.
 *
 * @param {string} query - Search query
 * @param {Object} [opts] - { limit?, type?, minConfidence?, includeGlobal? }
 * @returns {Promise<Object[]>}
 */
async function searchAllProjects(query, opts = {}) {
  const db = _getDB();
  const limit = opts.limit || 20;

  // Use hybrid search if available (no project filter = all projects)
  let results;
  try {
    const searchOpts = { limit: limit * 2 };
    if (opts.type) searchOpts.type = opts.type;
    if (opts.minConfidence) searchOpts.minConfidence = opts.minConfidence;

    const queryVec = await core.embedding.computeEmbedding(query);
    results = core.search.hybridSearch(db, query, queryVec, searchOpts);
  } catch {
    results = core.search.keywordSearch(db, { query, limit: limit * 2 });
  }

  // Add project_path info for context
  const enriched = results.slice(0, limit).map(r => ({
    ...r,
    project: r.project_path === '__global__' ? '[GLOBAL VAULT]' : r.project_path,
  }));

  _trackAccess(db, results.map(r => r.id));
  return enriched;
}

/**
 * Get machine-wide analytics — insights across all projects.
 * Shows: top repeated errors, most useful global learnings, project count,
 * cross-project pattern frequency.
 *
 * @returns {{ projectCount: number, totalObservations: number, globalVaultSize: number,
 *             topErrors: Object[], topLearnings: Object[], repeatedTags: Object[] }}
 */
function machineAnalytics() {
  const db = _getDB();

  const projectCount = db.prepare(
    'SELECT COUNT(DISTINCT project_path) as c FROM observations WHERE project_path != ?'
  ).get('__global__').c;

  const totalObservations = db.prepare(
    'SELECT COUNT(*) as c FROM observations WHERE is_active = 1'
  ).get().c;

  const globalVaultSize = db.prepare(
    'SELECT COUNT(*) as c FROM observations WHERE project_path = ? AND is_active = 1'
  ).get('__global__').c;

  // Top errors across all projects
  const topErrors = db.prepare(
    'SELECT title, content, project_path, confidence, created_at FROM observations WHERE type = ? AND is_active = 1 AND project_path != ? ORDER BY confidence DESC LIMIT 10'
  ).all('error', '__global__');

  // Top global learnings
  const topLearnings = db.prepare(
    'SELECT title, content, confidence, predicted_utility, created_at FROM observations WHERE project_path = ? AND type IN (?, ?) AND is_active = 1 ORDER BY predicted_utility DESC LIMIT 10'
  ).all('__global__', 'learning', 'instruction');

  // Repeated tags across projects (potential patterns)
  const repeatedTags = db.prepare(
    `SELECT tags FROM observations WHERE is_active = 1 AND project_path != ? AND tags != '[]' LIMIT 500`
  ).all('__global__');

  const tagCounts = new Map();
  for (const row of repeatedTags) {
    try {
      const tags = JSON.parse(row.tags);
      for (const tag of tags) {
        if (tag === 'machine-global' || tag === 'cross-project' || tag === 'coding-standard') continue;
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    } catch {}
  }
  const topTags = [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, count }));

  return {
    projectCount,
    totalObservations,
    globalVaultSize,
    topErrors: topErrors.map(e => ({ ...e, preview: e.content.slice(0, 150) })),
    topLearnings: topLearnings.map(l => ({ ...l, preview: l.content.slice(0, 150) })),
    repeatedTags: topTags,
  };
}

// ─── Conversation Transcript Ingestion ────────────────────────────────

/**
 * Parse a conversation transcript (agent chat log, code review, meeting notes)
 * and auto-extract structured observations. Uses regex for fast extraction,
 * with LLM fallback for ambiguous cases.
 *
 * Extracts:
 *   - decisions ("decided to", "chose", "going with")
 *   - errors ("error:", "failed:", "exception")
 *   - learnings ("learned", "found that", "realized")
 *   - preferences ("prefer", "rather than", "instead of")
 *   - facts ("the project uses", "configured with", "running on")
 *
 * @param {string} text - Raw transcript text
 * @param {Object} [opts] - { project?, agentId?, useLLM?: boolean }
 * @returns {Promise<{extracted: number, observations: Array<{type: string, title: string}>}>}
 */
async function ingestTranscript(text, opts) {
  opts = opts || {};
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const agentId = opts.agentId || null;
  const useLLM = opts.useLLM ?? true;

  const patterns = [
    { regex: /(?:decided to|chose to|going with|will use|switch(?:ed)? to)\s+(.{20,200}?)(?:\.|$)/gi, type: 'decision', confidence: 80 },
    { regex: /(?:error[:\)]|failed[:\)]|exception[:\)]|crash(?:ed)?[:\)])\s*(.{20,200}?)(?:\.|$)/gi, type: 'error', confidence: 90 },
    { regex: /(?:learned that|found that|realized that|discovered that)\s+(.{20,200}?)(?:\.|$)/gi, type: 'learning', confidence: 75 },
    { regex: /(?:prefer(?:s)? to|rather than|instead of|would rather)\s+(.{20,200}?)(?:\.|,|$)/gi, type: 'preference', confidence: 85 },
    { regex: /(?:the project uses|configured with|running on|deployed (?:to|on)|database is|powered by)\s+(.{20,200}?)(?:\.|$)/gi, type: 'fact', confidence: 70 },
  ];

  const extracted = [];
  const seen = new Set();

  for (const { regex, type, confidence } of patterns) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      const content = match[1].trim();
      if (content.length < 10) continue;
      // Deduplicate by content hash
      const hash = type + ':' + content.slice(0, 40);
      if (seen.has(hash)) continue;
      seen.add(hash);

      extracted.push({
        type,
        title: content.slice(0, 80),
        content,
        confidence,
        provenance: 'inferred',
        project,
        agentId,
        tags: ['auto-extracted', 'transcript-ingestion'],
      });
    }
  }

  // LLM fallback: if few or no regex matches and LLM is available, try deeper extraction
  if (extracted.length < 3 && useLLM) {
    try {
      const { callLLM } = require('../core/session');
      const prompt = `Extract key observations from this conversation transcript. Return a JSON array of objects with: type (decision/error/learning/preference/fact), title (max 80 chars), content (max 200 chars), confidence (1-100).\n\nTranscript:\n${text.slice(0, 4000)}\n\nReturn ONLY a JSON array.`;

      const result = await callLLM([
        { role: 'system', content: 'You extract structured observations from transcripts. Respond ONLY with a JSON array.' },
        { role: 'user', content: prompt },
      ], { temperature: 0.1, maxTokens: 2000, timeout: 30000 });

      if (result) {
        try {
          const parsed = JSON.parse(result);
          for (const item of parsed) {
            if (item.type && item.content) {
              const hash = item.type + ':' + (item.content || '').slice(0, 40);
              if (seen.has(hash)) continue;
              seen.add(hash);
              extracted.push({
                type: item.type,
                title: (item.title || item.content || '').slice(0, 80),
                content: item.content || '',
                confidence: item.confidence || 70,
                provenance: 'inferred',
                project,
                agentId,
                tags: ['auto-extracted', 'transcript-ingestion', 'llm-assisted'],
              });
            }
          }
        } catch {}
      }
    } catch { /* LLM unavailable — use regex-only results */ }
  }

  // Save all extracted observations
  const saved = [];
  for (const obs of extracted) {
    try {
      const r = await save(obs);
      saved.push({ type: obs.type, title: obs.title, id: r.id });
    } catch {}
  }

  return { extracted: saved.length, observations: saved };
}

// ─── Memory Utility ────────────────────────────────────────────────────

/**
 * Get the most and least useful memories for a project, ranked by access_count.
 * Useful for understanding which memories the agent actually uses.
 *
 * @param {Object} [opts] - { project?, limit? }
 * @returns {{ top: Object[], bottom: Object[], total: number }}
 */
function getUtilityStats(opts) {
  opts = opts || {};
  const db = _getDB();
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const limit = opts.limit || 10;

  const top = db.prepare(
    'SELECT id, type, title, access_count, last_accessed_at, confidence FROM observations WHERE project_path = ? AND is_active = 1 AND access_count > 0 ORDER BY access_count DESC LIMIT ?'
  ).all(project, limit);

  const bottom = db.prepare(
    'SELECT id, type, title, access_count, last_accessed_at, confidence, created_at FROM observations WHERE project_path = ? AND is_active = 1 AND access_count = 0 AND created_at < datetime(\'now\', \'-30 days\') ORDER BY created_at ASC LIMIT ?'
  ).all(project, limit);

  const total = db.prepare(
    'SELECT COUNT(*) as c FROM observations WHERE project_path = ? AND is_active = 1'
  ).get(project).c;

  return { top, bottom, total };
}

// ─── Agent Feedback ────────────────────────────────────────────────────

/**
 * Record explicit agent feedback on a memory.
 * 'helpful' boosts confidence + predicted_utility.
 * 'incorrect' triggers confidence decay and flags for review.
 *
 * @param {number} id - Observation ID
 * @param {Object} opts - { type: 'helpful'|'incorrect', reason?: string }
 * @returns {Object} Updated observation info
 */
async function feedback(id, opts) {
  const db = _getDB();
  const obs = db.prepare('SELECT * FROM observations WHERE id = ? AND is_active = 1').get(id);
  if (!obs) throw new Error('Active observation not found: ' + id);

  const type = opts.type;
  if (type !== 'helpful' && type !== 'incorrect') {
    throw new Error('feedback type must be "helpful" or "incorrect"');
  }

  if (type === 'helpful') {
    // Boost confidence and utility — this memory proved useful
    db.prepare('UPDATE observations SET confidence = MIN(confidence + 5, 100), predicted_utility = predicted_utility + 10 WHERE id = ?').run(id);

    // Append 'helpful' tag
    const currentTags = JSON.parse(obs.tags || '[]');
    if (!currentTags.includes('helpful')) {
      currentTags.push('helpful');
      db.prepare('UPDATE observations SET tags = ? WHERE id = ?').run(JSON.stringify(currentTags), id);
    }
  } else {
    // Incorrect — significant confidence decay, flag for review
    db.prepare('UPDATE observations SET confidence = MAX(confidence - 20, 10), predicted_utility = MAX(predicted_utility - 5, -10) WHERE id = ?').run(id);

    const currentTags = JSON.parse(obs.tags || '[]');
    if (!currentTags.includes('incorrect')) {
      currentTags.push('incorrect');
      db.prepare('UPDATE observations SET tags = ? WHERE id = ?').run(JSON.stringify(currentTags), id);
    }
  }

  // Save the feedback itself as an observation for audit trail
  if (opts.reason) {
    await save({
      title: `Feedback: ${type} — ${obs.title || '#' + id}`,
      content: `Agent marked observation #${id} as ${type}. Reason: ${opts.reason}`,
      type: 'observation',
      project: obs.project_path,
      confidence: 100,
      provenance: 'explicit',
      tags: ['feedback', type],
    });
  }

  const updated = db.prepare('SELECT id, confidence, predicted_utility, tags FROM observations WHERE id = ?').get(id);
  return { id, type, status: 'feedback_recorded', confidence: updated.confidence, predicted_utility: updated.predicted_utility };
}

// ─── Memory Trails ─────────────────────────────────────────────────────

/**
 * Walk the relation graph to surface a readable narrative trail.
 * Follows relation chains (derives_from, produces, achieves, depends_on, supersedes)
 * and formats them as a chronological story.
 *
 * @param {number} observationId - Starting observation ID
 * @param {Object} [opts] - { depth?: number, direction?: 'forward'|'backward'|'both' }
 * @returns {{ trail: string, nodes: Object[], chain: string[] }}
 */
function trail(observationId, opts) {
  opts = opts || {};
  const db = _getDB();
  const depth = Math.min(opts.depth || 5, 10);
  const direction = ['forward', 'backward', 'both'].includes(opts.direction) ? opts.direction : 'both';

  const startObs = db.prepare('SELECT * FROM observations WHERE id = ? AND is_active = 1').get(observationId);
  if (!startObs) throw new Error('Active observation not found: ' + observationId);

  const visited = new Set();
  const nodes = [];
  const chain = [];

  // BFS walk following relation edges
  const queue = [{ id: observationId, depth: 0, prefix: '' }];

  const trailRelations = ['derives_from', 'produces', 'achieves', 'depends_on', 'supersedes', 'refines'];

  while (queue.length > 0 && nodes.length < 50) {
    const { id, depth: d, prefix } = queue.shift();
    if (visited.has(id) || d > depth) continue;
    visited.add(id);

    const obs = db.prepare('SELECT id, type, title, content, confidence, created_at FROM observations WHERE id = ? AND is_active = 1').get(id);
    if (!obs) continue;
    nodes.push(obs);
    chain.push(prefix + `[${obs.type.toUpperCase()}] ${obs.title || obs.content.slice(0, 80)} (${obs.confidence}%)`);

    if (d < depth) {
      // Get connected neighbors via trail-worthy relations
      const placeholders = trailRelations.map(() => '?').join(',');
      let neighbors;
      if (direction === 'forward' || direction === 'both') {
        neighbors = db.prepare(
          `SELECT target_id as neighborId, relation_type FROM memory_relations WHERE source_id = ? AND relation_type IN (${placeholders})`
        ).all(id, ...trailRelations);
      }
      if (direction === 'backward' || direction === 'both') {
        const backward = db.prepare(
          `SELECT source_id as neighborId, relation_type FROM memory_relations WHERE target_id = ? AND relation_type IN (${placeholders})`
        ).all(id, ...trailRelations);
        neighbors = (neighbors || []).concat(backward);
      }

      for (const n of (neighbors || [])) {
        if (!visited.has(n.neighborId)) {
          const arrow = n.relation_type === 'derives_from' ? '  └─ learned from → '
            : n.relation_type === 'produces' ? '  └─ produced → '
            : n.relation_type === 'achieves' ? '  └─ achieved by → '
            : n.relation_type === 'depends_on' ? '  └─ depends on → '
            : n.relation_type === 'refines' ? '  └─ refined by → '
            : '  └─ ' + n.relation_type + ' → ';
          queue.push({ id: n.neighborId, depth: d + 1, prefix: prefix + arrow });
        }
      }
    }
  }

  // Build the narrative trail text
  const trail = chain.join('\n');
  _trackAccess(db, nodes.map(n => n.id));

  return { trail, nodes, chain, startId: observationId, nodeCount: nodes.length };
}

// ─── #1 Freshness Scoring ──────────────────────────────────────────────

/**
 * Compute a freshness score (0-100) for an observation combining:
 *   - access_count: recency/frequency of use (0-30)
 *   - last_accessed_at: time since last access (0-25)
 *   - confidence: how reliable this memory is (0-25)
 *   - predicted_utility: how useful it proved to be (0-20)
 *
 * The score naturally decays over time — frequently accessed,
 * high-confidence memories stay fresh; never-touched ones rot.
 *
 * @param {Object} obs - Observation row with access_count, last_accessed_at, confidence, predicted_utility, created_at
 * @returns {number} Freshness score 0-100
 */
function computeFreshness(obs) {
  // Access recency subscore: 0-30
  let accessScore = 0;
  if (obs.access_count > 0 && obs.last_accessed_at) {
    const daysSinceAccess = Math.max(0, (Date.now() - new Date(obs.last_accessed_at + 'Z').getTime()) / 86400000);
    accessScore = Math.max(0, 30 - daysSinceAccess) * Math.min(obs.access_count / 10, 1);
  }

  // Recency subscore: 0-25 (newer = higher, caps at 30 days)
  const daysSinceCreation = Math.max(0, (Date.now() - new Date(obs.created_at + 'Z').getTime()) / 86400000);
  const recencyScore = Math.max(0, 25 - (daysSinceCreation / 30) * 25);

  // Confidence subscore: 0-25
  const confidenceScore = (obs.confidence / 100) * 25;

  // Utility subscore: 0-20
  const utilityScore = Math.min(Math.max(obs.predicted_utility || 0, -10), 20);

  return Math.round(Math.min(100, Math.max(0, accessScore + recencyScore + confidenceScore + utilityScore)));
}

/**
 * Update freshness_score for all active observations in a project.
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @returns {number} Number of observations updated
 */
function updateFreshnessScores(db, project) {
  const observations = db.prepare(
    'SELECT id, access_count, last_accessed_at, confidence, predicted_utility, created_at FROM observations WHERE project_path = ? AND is_active = 1'
  ).all(project);

  const update = db.prepare('UPDATE observations SET freshness_score = ? WHERE id = ?');
  let count = 0;
  for (const obs of observations) {
    const score = computeFreshness(obs);
    update.run(score, obs.id);
    count++;
  }
  return count;
}

/**
 * Auto-archive observations with freshness below threshold.
 * Returns archived count and list of archived IDs.
 *
 * @param {Object} [opts] - { project?, threshold?: number, dryRun?: boolean }
 * @returns {{ archived: number, ids: number[], dryRun: boolean }}
 */
function autoArchive(opts) {
  opts = opts || {};
  const db = _getDB();
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const threshold = opts.threshold ?? 15;
  const dryRun = opts.dryRun || false;

  // First update freshness scores
  updateFreshnessScores(db, project);

  // Find stale observations
  const stale = db.prepare(
    'SELECT id, title, freshness_score FROM observations WHERE project_path = ? AND is_active = 1 AND freshness_score < ? ORDER BY freshness_score ASC'
  ).all(project, threshold);

  if (dryRun) {
    return { archived: 0, ids: stale.map(s => s.id), candidates: stale.length, dryRun: true };
  }

  const archivedIds = [];
  for (const s of stale) {
    db.prepare('UPDATE observations SET is_active = 0 WHERE id = ?').run(s.id);
    archivedIds.push(s.id);
  }

  return { archived: archivedIds.length, ids: archivedIds, dryRun: false };
}

// ─── #2 Auto-Maintenance Scheduler ────────────────────────────────────

// Track last maintenance check per project (in-memory, reset on restart)
const _lastMaintenanceChecks = new Map();
const MAINTENANCE_INTERVAL_SAVES = 50; // check every ~50 saves per project
const MAINTENANCE_MIN_HOURS = 6;       // minimum hours between full maintenance runs

/**
 * Run the full maintenance cycle for a project:
 *   1. Update freshness scores
 *   2. Auto-archive stale observations
 *   3. Run utility decay pass (archiveSuperseded)
 *   4. Log the run to maintenance_log
 *
 * @param {Object} [opts] - { project?, dryRun?: boolean, maxAgeDays?: number }
 * @returns {Promise<{freshnessUpdated: number, archived: number, decayed: number, dryRun: boolean}>}
 */
async function runMaintenance(opts) {
  opts = opts || {};
  const db = _getDB();
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const dryRun = opts.dryRun || false;
  const maxAgeDays = opts.maxAgeDays || 30;

  // 1. Update freshness scores
  const freshnessUpdated = dryRun ? 0 : updateFreshnessScores(db, project);

  // 2. Auto-archive stale observations
  const archiveResult = autoArchive({ project, dryRun });

  // 3. Run utility decay pass via archiveSuperseded
  let decayed = 0;
  try {
    const archiveP = await archiveSuperseded({ project, dryRun, maxAgeDays });
    decayed = archiveP.decayed || 0;
  } catch {}

  // 4. Log the maintenance run
  if (!dryRun) {
    const summary = JSON.stringify({ freshnessUpdated, archived: archiveResult.archived, decayed });
    db.prepare(
      'INSERT OR REPLACE INTO maintenance_log (project_path, task, result_summary, run_at) VALUES (?, ?, ?, datetime(\'now\'))'
    ).run(project, 'full_maintenance', summary);
  }

  _lastMaintenanceChecks.set(project, Date.now());

  return { freshnessUpdated, archived: archiveResult.archived, decayed, dryRun };
}

/**
 * Check if maintenance is due and run it if needed.
 * Called periodically from the post_save hook (every ~50 saves).
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 */
async function checkAndRunMaintenance(db, project) {
  const lastCheck = _lastMaintenanceChecks.get(project) || 0;
  const hoursSinceCheck = (Date.now() - lastCheck) / 3600000;

  // Only run if enough time has passed since last check
  const lastRun = db.prepare(
    "SELECT run_at FROM maintenance_log WHERE project_path = ? AND task = 'full_maintenance' ORDER BY run_at DESC LIMIT 1"
  ).get(project);

  if (lastRun) {
    const hoursSinceRun = (Date.now() - new Date(lastRun.run_at + 'Z').getTime()) / 3600000;
    if (hoursSinceRun < MAINTENANCE_MIN_HOURS) return;
  }

  if (hoursSinceCheck < 1) return; // At most once per hour

  try {
    console.error('[agentic-cortex] Auto-maintenance triggered for %s', project);
    await runMaintenance({ project, maxAgeDays: 30 });
  } catch (err) {
    console.warn('[agentic-cortex] Auto-maintenance failed:', err.message);
  }
}

/**
 * Initialize the maintenance scheduler hook.
 * Registers a post_save hook that periodically checks if maintenance is due.
 */
function initMaintenanceScheduler() {
  // Prevent double-registration (init() may be called multiple times in tests)
  if (initMaintenanceScheduler._initialized) return;
  initMaintenanceScheduler._initialized = true;

  // Track save counts per project for maintenance scheduling
  const _maintSaveCounts = new Map();

  core.hooks.registerHook('post_save', async (obs, ctx, db) => {
    if (!obs.project_path) return;
    const count = (_maintSaveCounts.get(obs.project_path) || 0) + 1;
    _maintSaveCounts.set(obs.project_path, count);

    // Clean up old entries periodically
    if (_maintSaveCounts.size > 100) {
      const keys = [..._maintSaveCounts.keys()];
      for (const k of keys.slice(0, 50)) _maintSaveCounts.delete(k);
    }

    if (count % MAINTENANCE_INTERVAL_SAVES === 0) {
      await checkAndRunMaintenance(db, obs.project_path);
    }
  });

  console.error('[agentic-cortex] Auto-maintenance scheduler initialized (every ~%d saves, min %dh between runs)', MAINTENANCE_INTERVAL_SAVES, MAINTENANCE_MIN_HOURS);
}

// ─── #3 Learning Loop Analytics ───────────────────────────────────────

/**
 * Surface insights about the self-improving loop's effectiveness.
 * Measures RCA effectiveness, conflict health, utility distribution, and feedback ratio.
 *
 * @param {Object} [opts] - { project? }
 * @returns {{ rca: Object, conflicts: Object, utility: Object, feedback: Object, freshness: Object }}
 */
function analytics(opts) {
  opts = opts || {};
  const db = _getDB();
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();

  // RCA effectiveness: errors saved → learnings generated → learnings still active
  const errorsSaved = db.prepare(
    'SELECT COUNT(*) as c FROM observations WHERE project_path = ? AND type = ? AND is_active = 1'
  ).get(project, 'error').c;

  const rcaLearnings = db.prepare(
    "SELECT COUNT(*) as c FROM observations WHERE project_path = ? AND type = ? AND is_active = 1 AND tags LIKE '%rca%'"
  ).get(project, 'learning').c;

  const totalLearnings = db.prepare(
    'SELECT COUNT(*) as c FROM observations WHERE project_path = ? AND type = ? AND is_active = 1'
  ).get(project, 'learning').c;

  // Learnings that got verified/reinforced (confidence > original)
  const verifiedLearnings = db.prepare(
    "SELECT COUNT(*) as c FROM observations WHERE project_path = ? AND type = ? AND is_active = 1 AND confidence >= 85"
  ).get(project, 'learning').c;

  const rca = {
    errorsSaved,
    rcaLearnings,
    totalLearnings,
    verifiedLearnings,
    rcaRate: errorsSaved > 0 ? Math.round((rcaLearnings / errorsSaved) * 100) : 0,
    verificationRate: totalLearnings > 0 ? Math.round((verifiedLearnings / totalLearnings) * 100) : 0,
  };

  // Conflict health
  const conflictLearnings = db.prepare(
    "SELECT COUNT(*) as c FROM observations WHERE project_path = ? AND type = ? AND is_active = 1 AND tags LIKE '%conflict-resolution%'"
  ).get(project, 'learning').c;

  const totalRelations = db.prepare(
    'SELECT COUNT(*) as c FROM memory_relations r JOIN observations o ON (r.source_id = o.id OR r.target_id = o.id) WHERE o.project_path = ?'
  ).get(project).c;

  const supersedeRels = db.prepare(
    'SELECT COUNT(*) as c FROM memory_relations r JOIN observations o ON r.source_id = o.id WHERE o.project_path = ? AND r.relation_type = ?'
  ).get(project, 'supersedes').c;

  const contradictions = db.prepare(
    'SELECT COUNT(*) as c FROM memory_relations r JOIN observations o ON r.source_id = o.id WHERE o.project_path = ? AND r.relation_type = ?'
  ).get(project, 'contradicts').c;

  const conflicts = {
    conflictLearnings,
    totalRelations,
    supersedeRels,
    contradictions,
    health: contradictions === 0 ? 'clean' : (contradictions <= 3 ? 'minor_issues' : 'needs_attention'),
  };

  // Utility distribution
  const utilityRows = db.prepare(
    'SELECT access_count, predicted_utility, freshness_score FROM observations WHERE project_path = ? AND is_active = 1'
  ).all(project);

  const totalActive = utilityRows.length;
  const accessed = utilityRows.filter(r => r.access_count > 0).length;
  const highUtil = utilityRows.filter(r => (r.predicted_utility || 0) >= 10).length;
  const lowUtil = utilityRows.filter(r => (r.predicted_utility || 0) <= 0 && r.access_count === 0).length;
  const avgFreshness = totalActive > 0
    ? Math.round(utilityRows.reduce((s, r) => s + (r.freshness_score || 50), 0) / totalActive)
    : 50;

  const utility = {
    totalActive,
    accessed,
    untouched: totalActive - accessed,
    highUtility: highUtil,
    lowUtility: lowUtil,
    avgFreshness,
    accessRate: totalActive > 0 ? Math.round((accessed / totalActive) * 100) : 0,
  };

  // Feedback ratio
  const helpfulFeedback = db.prepare(
    "SELECT COUNT(*) as c FROM observations WHERE project_path = ? AND is_active = 1 AND tags LIKE '%helpful%' AND tags LIKE '%feedback%'"
  ).get(project).c;

  const incorrectFeedback = db.prepare(
    "SELECT COUNT(*) as c FROM observations WHERE project_path = ? AND is_active = 1 AND tags LIKE '%incorrect%' AND tags LIKE '%feedback%'"
  ).get(project).c;

  const totalFeedback = helpfulFeedback + incorrectFeedback;

  const feedback = {
    helpful: helpfulFeedback,
    incorrect: incorrectFeedback,
    total: totalFeedback,
    ratio: totalFeedback > 0 ? Math.round((helpfulFeedback / totalFeedback) * 100) : null,
  };

  // Freshness distribution
  const freshBuckets = { high: 0, medium: 0, low: 0, stale: 0 };
  for (const r of utilityRows) {
    const s = r.freshness_score || 50;
    if (s >= 70) freshBuckets.high++;
    else if (s >= 40) freshBuckets.medium++;
    else if (s >= 15) freshBuckets.low++;
    else freshBuckets.stale++;
  }

  const freshness = { ...freshBuckets, avg: avgFreshness };

  // ── Eval log stats (AutoGTM's results.tsv analytics) ──
  let evalLog = { total: 0, successRate: 0, avgConfidenceDelta: 0, recentVerdicts: [] };
  try {
    evalLog = selfImprove.getEvalLogStats(db, project);
  } catch { /* best-effort */ }

  // ── Layer stats (AutoGTM's crystallized brain analytics) ──
  let layers = { raw: 0, synthesis: 0, principle: 0 };
  try {
    layers.raw = db.prepare('SELECT COUNT(*) as c FROM observations WHERE project_path = ? AND is_active = 1 AND (layer IS NULL OR layer = 1)').get(project).c;
    layers.synthesis = db.prepare('SELECT COUNT(*) as c FROM observations WHERE project_path = ? AND is_active = 1 AND layer = 2').get(project).c;
    layers.principle = db.prepare('SELECT COUNT(*) as c FROM observations WHERE (project_path = ? OR (project_scope = ? AND is_active = 1)) AND is_active = 1 AND (layer = 3 OR type = ?)').get(project, 'global', 'principle').c;
  } catch { /* best-effort */ }

  // ── Experiment stats (AutoGTM's hypothesis testing analytics) ──
  let experiments = { active: 0, resolved: 0, successRate: 0 };
  try {
    experiments.active = db.prepare("SELECT COUNT(*) as c FROM observations WHERE project_path = ? AND type = 'experiment' AND is_active = 1").get(project).c;
    const resolved = db.prepare("SELECT COUNT(*) as c FROM evaluation_log WHERE project_path = ? AND intent_id IN (SELECT id FROM observations WHERE project_path = ? AND type = 'experiment')").get(project, project).c;
    const resolvedSuccess = db.prepare("SELECT COUNT(*) as c FROM evaluation_log WHERE project_path = ? AND llm_verdict = 'SUCCESS' AND intent_id IN (SELECT id FROM observations WHERE project_path = ? AND type = 'experiment')").get(project, project).c;
    experiments.resolved = resolved;
    experiments.successRate = resolved > 0 ? Math.round((resolvedSuccess / resolved) * 10000) / 100 : 0;
  } catch { /* best-effort */ }

  return { rca, conflicts, utility, feedback, freshness, evalLog, layers, experiments };
}

// ─── Crystallization (AutoGTM's Compounding Brain) ──────────────────

/**
 * Run memory crystallization: compress raw observations upward through
 * tiered layers (raw → synthesis → principle).
 *
 * @param {Object} [opts] - { project?, fromLayer?, minCount?, dryRun? }
 * @returns {Promise<{rawToSynthesis: number, synthesisToPrinciple: number, dryRun: boolean}>}
 */
async function crystallize(opts) {
  return core.reflection.crystallize(_getDB(), opts || {});
}

/**
 * Get principles (layer 3) for a project.
 *
 * @param {Object} [opts] - { project?, limit? }
 * @returns {Array<Object>}
 */
function getPrinciples(opts) {
  const db = _getDB();
  const project = (opts && opts.project) || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  return core.reflection.getPrinciples(db, project, (opts && opts.limit) || 10);
}

// ─── Experiment (AutoGTM's Hypothesis Testing) ──────────────────────

/**
 * Spawn a hypothesis-testing experiment for a recurring error.
 *
 * @param {Object} [opts] - { project?, errorTag? }
 * @returns {Promise<Object|null>}
 */
async function spawnExperiment(opts) {
  return selfImprove.spawnExperiment(_getDB(), opts || {});
}

/**
 * List active experiments for a project.
 *
 * @param {Object} [opts] - { project?, limit? }
 * @returns {Array<Object>}
 */
function listExperiments(opts) {
  const db = _getDB();
  const project = (opts && opts.project) || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  return db.prepare(
    "SELECT id, title, content, tags, confidence, created_at FROM observations WHERE project_path = ? AND type = 'experiment' AND is_active = 1 ORDER BY created_at DESC LIMIT ?"
  ).all(project, (opts && opts.limit) || 20);
}

// ─── Evaluation Log (AutoGTM's results.tsv) ─────────────────────────

/**
 * Query the immutable evaluation log.
 *
 * @param {Object} [opts] - { project?, verdict?, limit? }
 * @returns {Array<Object>}
 */
function getEvaluationLog(opts) {
  return selfImprove.getEvaluationLog(_getDB(), opts || {});
}

/**
 * Get evaluation log summary stats.
 *
 * @param {Object} [opts] - { project? }
 * @returns {{total: number, successRate: number, avgConfidenceDelta: number, recentVerdicts: Array}}
 */
function getEvalLogStats(opts) {
  const db = _getDB();
  const project = (opts && opts.project) || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  return selfImprove.getEvalLogStats(db, project);
}

// ─── Exports ───────────────────────────────────────────────────────────

module.exports = {
  save, get, edit, forget, list,
  search, keywordSearch, semanticSearch,
  startSession, endSession, summarizeSession, listSessions,
  embed, embedAll,
  checkConflicts,
  exportJSON, exportMarkdown, importJSON,
  context, bootstrap,
  init, close, health,
  addRelation, getRelations, getGraph, deleteRelation, listRelationTypes,
  createHook, listHooks, updateHook, deleteHook, setHookEnabled, registerHook, unregisterHook,
  reflect, consolidateMemories, promotePatterns, archiveSuperseded,
  startAgentSession, endAgentSession, listAgentSessions, shareMemory, getSharedMemories,
  searchSkills,
  recordAction, transferKnowledge, ingestTranscript, getUtilityStats,
  feedback, trail,
  computeFreshness, updateFreshnessScores, autoArchive,
  runMaintenance, checkAndRunMaintenance, initMaintenanceScheduler,
  analytics,
  promoteToGlobal, autoPromoteGlobal, getGlobalVault, searchAllProjects, machineAnalytics,
  getStandardsContext: standards.getStandardsContext,
  ensureStandardsExist: standards.ensureStandardsExist,
  listStandards: standards.listStandards,
  searchStandards: standards.searchStandards,
  getStandardsAsObservations: standards.getStandardsAsObservations,
  // ── v4.7.0: AutoGTM-inspired self-improvement ──
  crystallize,
  getPrinciples,
  spawnExperiment,
  listExperiments,
  getEvaluationLog,
  getEvalLogStats,
};
