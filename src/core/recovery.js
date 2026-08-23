/**
 * recovery.js — Self-healing recovery layer (Tier 1 self-improvement).
 *
 * Three deterministic mechanisms ported from Auton's failure-handling loop,
 * designed to complement the LLM-assisted self-improve module with guarantees
 * that do not degrade when the LLM is unavailable:
 *
 * 1. Probe-gated retry — failures are classified into a condition family
 *    (network/file/element/app/auth/parse) and tracked in `condition_states`.
 *    A corrected re-run is offered only after a live probe confirms the
 *    underlying cause actually changed, instead of blindly retrying.
 *
 * 2. LLM negative cache — every LLM pass is absorbed into `llm_cache` keyed by
 *    (operation, input). Identical inputs resolve deterministically forever
 *    after, including the fallback/negative outcome, so a flaky LLM is never
 *    re-invoked for the same input twice.
 *
 * 3. Counter-evidence decay — a later success decrements the lesson count of
 *    a previously recorded failure and can deactivate (delete) it once the
 *    count reaches zero, treating the earlier failure as transient.
 *
 * All state lives in the SQLite database, so the recovery layer survives
 * restarts and is fully deterministic in tests.
 *
 * @module core/recovery
 */

'use strict';

const crypto = require('crypto');

// ─── 1. Probe-gated retry ─────────────────────────────────────────

/**
 * Condition families (ordered by classifier priority).
 * `parse` precedes `auth` because the bare word "token" in an auth pattern
 * would otherwise misclassify JSON "unexpected token" parse errors.
 */
const CONDITION_FAMILIES = ['network', 'file', 'element', 'app', 'parse', 'auth'];

/**
 * Keyword patterns per condition family. First family to match wins.
 * @type {Record<string, RegExp>}
 */
const CONDITION_PATTERNS = {
  network: /\b(network|connection|socket|timeout|dns|refused|unreachable|econnreset|econnrefused|etimedout|enotfound|http|fetch|offline|latency|rate[- ]?limit|request)\b/i,
  file: /\b(file|path|directory|permission denied|eacces|enoent|not found|read|write|\bio\b|disk|rename|move|copy)\b/i,
  element: /\b(element|selector|dom|button|locator|stale|clickable|xpath|css|iframe|render|visible)\b/i,
  app: /\b(app|process|crash|exit|start|launch|restart|instance|server|daemon|port|bind|runtime)\b/i,
  auth: /\b(auth|login|token|credential|password|401|403|permission|forbidden|unauthorized|access denied|session expired|api[- ]?key)\b/i,
  parse: /\b(parse|json|syntax|malformed|unexpected token|schema|decode|encode|invalid format|xml|yaml)\b/i,
};

/**
 * Classify an error text into a condition family using deterministic keyword
 * matching. Returns 'unknown' when no family matches.
 *
 * @param {string} errorText - The error message/content to classify
 * @returns {string} One of the condition families or 'unknown'
 */
function classifyCondition(errorText) {
  const text = String(errorText || '');
  for (const family of CONDITION_FAMILIES) {
    if (CONDITION_PATTERNS[family] && CONDITION_PATTERNS[family].test(text)) {
      return family;
    }
  }
  return 'unknown';
}

/**
 * Record a failure against a condition family, seeding the probe state.
 * Recurring failures increment the occurrence count; the probe state is set to
 * "cause present" so a later passing probe can detect that the cause changed.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} opts
 * @param {string} [opts.project] - Project path
 * @param {number} [opts.errorId] - Error observation ID (if known)
 * @param {string} [opts.errorText] - Error content to classify
 * @param {string} [opts.condition] - Explicit condition family (skips classification)
 * @returns {Object} The recorded/updated condition state row
 */
function recordFailure(db, opts = {}) {
  const family = opts.condition || classifyCondition(opts.errorText);
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const now = new Date().toISOString();

  const existing = db.prepare(
    'SELECT * FROM condition_states WHERE project_path = ? AND condition = ?'
  ).get(project, family);

  if (existing) {
    db.prepare(
      'UPDATE condition_states SET occurrences = occurrences + 1, last_failure_at = ?, last_error_id = ?, last_error_text = ?, last_probe_ok = 0, resolved = 0 WHERE id = ?'
    ).run(now, opts.errorId || null, (opts.errorText || '').slice(0, 1000), existing.id);
    return {
      id: existing.id,
      project_path: project,
      condition: family,
      occurrences: existing.occurrences + 1,
      changed: false,
    };
  }

  const r = db.prepare(
    'INSERT INTO condition_states (project_path, condition, occurrences, last_failure_at, last_error_id, last_error_text, last_probe_ok, resolved) VALUES (?,?,1,?,?,?,0,0)'
  ).run(project, family, now, opts.errorId || null, (opts.errorText || '').slice(0, 1000));

  return {
    id: Number(r.lastInsertRowid),
    project_path: project,
    condition: family,
    occurrences: 1,
    changed: true,
  };
}

/**
 * Run a live probe for a condition family and record the result. Returns
 * whether the underlying cause changed since the failure was recorded.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} opts
 * @param {string} [opts.project] - Project path
 * @param {string} [opts.condition] - Condition family to probe
 * @param {Function} opts.check - Async probe: () => Promise<{ok: boolean, detail?: string}>
 * @returns {Promise<Object>} Probe result { ok, changed, condition, reason, detail }
 */
async function probeCondition(db, opts = {}) {
  if (typeof opts.check !== 'function') throw new Error('check function is required');
  const family = opts.condition || 'unknown';
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();

  const state = db.prepare(
    'SELECT * FROM condition_states WHERE project_path = ? AND condition = ?'
  ).get(project, family);

  if (!state) {
    return { ok: null, changed: false, condition: family, reason: 'no-failure-recorded', detail: null };
  }

  const probe = await opts.check();
  const ok = !!probe.ok;
  const prevOk = state.last_probe_ok;
  // The cause changed when it was present at failure time and the probe now says it's gone.
  const changed = (prevOk === 0 || prevOk === false) && ok;

  db.prepare(
    'UPDATE condition_states SET last_probe_ok = ?, last_probe_at = ?, resolved = ? WHERE id = ?'
  ).run(ok ? 1 : 0, new Date().toISOString(), ok ? 1 : 0, state.id);

  const reason = changed ? 'cause-changed' : (ok ? 'already-resolved' : 'cause-still-present');
  return { ok, changed, condition: family, reason, detail: probe.detail || null };
}

/**
 * Offer a corrected re-run only when a live probe confirms the underlying
 * cause changed since the failure was recorded.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} opts
 * @param {string} [opts.project] - Project path
 * @param {string} [opts.condition] - Condition family to probe
 * @param {Function} opts.check - Async probe: () => Promise<{ok: boolean, detail?: string}>
 * @returns {Promise<Object>} { retry, ...probeResult }
 */
async function shouldRetry(db, opts = {}) {
  const probe = await probeCondition(db, opts);
  return { retry: probe.ok === true && probe.changed === true, ...probe };
}

// ─── 2. LLM negative cache ────────────────────────────────────────

/**
 * Deterministic cache key from (operation, input). Input is trimmed and
 * capped so pathological payloads don't bloat the index.
 *
 * @param {string} operation
 * @param {string} input
 * @returns {string} sha256 hex digest
 */
function _cacheKey(operation, input) {
  const normalized = String(input || '').trim().slice(0, 2000);
  return crypto.createHash('sha256').update(operation + '\u0000' + normalized).digest('hex');
}

/**
 * Retrieve a cached LLM result, if any. Records a hit for observability.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} operation
 * @param {string} input
 * @returns {{result: any, status: string, hitCount: number}|null} Cached entry or null
 */
function getCachedLLM(db, operation, input) {
  const key = _cacheKey(operation, input);
  const row = db.prepare('SELECT * FROM llm_cache WHERE cache_key = ?').get(key);
  if (!row) return null;

  db.prepare("UPDATE llm_cache SET hit_count = hit_count + 1, last_hit_at = datetime('now') WHERE id = ?").run(row.id);

  let result;
  try { result = JSON.parse(row.result); } catch { result = row.result; }
  return { result, status: row.status, hitCount: row.hit_count + 1 };
}

/**
 * Absorb an LLM pass into the cache. The `status` distinguishes positive
 * results ('ok') from fallback/negative results ('fallback'), both of which
 * are cached so identical inputs resolve deterministically forever after.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} operation
 * @param {string} input
 * @param {any} result - The result (or fallback result) to cache; may be null
 * @param {string} [status='ok'] - 'ok' or 'fallback'
 */
function cacheLLM(db, operation, input, result, status) {
  const key = _cacheKey(operation, input);
  const serialized = JSON.stringify(result === undefined ? null : result);
  const inputText = String(input || '').slice(0, 2000);

  const existing = db.prepare('SELECT id FROM llm_cache WHERE cache_key = ?').get(key);
  if (existing) {
    db.prepare('UPDATE llm_cache SET result = ?, status = ?, input_text = ? WHERE id = ?')
      .run(serialized, status || 'ok', inputText, existing.id);
  } else {
    db.prepare('INSERT INTO llm_cache (cache_key, operation, input_text, result, status) VALUES (?,?,?,?,?)')
      .run(key, operation, inputText, serialized, status || 'ok');
  }
}

/**
 * Clear the entire LLM cache (used by tests and maintenance).
 *
 * @param {import('better-sqlite3').Database} db
 */
function clearLLMCache(db) {
  db.prepare('DELETE FROM llm_cache').run();
}

// ─── 3. Counter-evidence decay ────────────────────────────────────

/** Cap on lesson_count so an endlessly-recurring error stays bounded. */
const MAX_LESSON_COUNT = 25;

/**
 * Seed (or increment) the lesson counter for an error observation.
 * Each repeated failure raises the count, requiring more successes to clear.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} opts
 * @param {string} [opts.project] - Project path
 * @param {Object} opts.errorObs - The error observation { id, project_path? }
 * @returns {Object|null} { errorId, lessonCount, deleted: false } or null
 */
function registerFailure(db, opts = {}) {
  const errorId = opts.errorObs && opts.errorObs.id;
  if (!errorId) return null;
  const project = opts.project || (opts.errorObs && opts.errorObs.project_path) || process.cwd();

  const existing = db.prepare('SELECT * FROM failure_decay WHERE error_id = ?').get(errorId);
  if (existing) {
    const next = Math.min(existing.lesson_count + 1, MAX_LESSON_COUNT);
    db.prepare('UPDATE failure_decay SET lesson_count = ?, project_path = ? WHERE error_id = ?')
      .run(next, project, errorId);
    return { errorId, lessonCount: next, deleted: false };
  }

  db.prepare('INSERT INTO failure_decay (error_id, project_path, lesson_count) VALUES (?,?,1)')
    .run(errorId, project);
  return { errorId, lessonCount: 1, deleted: false };
}

/**
 * Match a success observation against a candidate error observation.
 * Deterministic signals: a shared tag, or the error title appearing in the
 * success content (case-insensitive).
 *
 * @param {string} successText - Lowercased success content
 * @param {Array<string>} successTags
 * @param {Object} error - { title, tags }
 * @returns {boolean}
 */
function _matchesError(successText, successTags, error) {
  let errorTags = [];
  try { errorTags = JSON.parse(error.tags || '[]'); } catch { errorTags = []; }
  if (Array.isArray(successTags) && successTags.length && errorTags.some(t => successTags.includes(t))) {
    return true;
  }
  const title = String(error.title || '').toLowerCase().trim();
  if (title && title.length >= 4 && successText.includes(title)) {
    return true;
  }
  return false;
}

/**
 * Apply counter-evidence: a later success decrements the lesson count of
 * matching error observations and deactivates them once the count reaches
 * zero (the earlier failure was transient).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} opts
 * @param {string} [opts.project] - Project path
 * @param {Object} [opts.successObs] - The success observation { project_path?, content?, title?, tags? }
 * @returns {Array<Object>} Results: [{ errorId, lessonCount, deleted }]
 */
function applyCounterEvidence(db, opts = {}) {
  const successObs = opts.successObs || {};
  const project = opts.project || successObs.project_path || process.cwd();
  const successText = String(successObs.content || successObs.title || '').toLowerCase();
  let successTags = successObs.tags;
  if (typeof successTags === 'string') {
    try { successTags = JSON.parse(successTags || '[]'); } catch { successTags = []; }
  }
  successTags = Array.isArray(successTags) ? successTags : [];

  const errors = db.prepare(
    `SELECT o.id, o.title, o.tags, fd.lesson_count
     FROM observations o
     JOIN failure_decay fd ON fd.error_id = o.id
     WHERE o.project_path = ? AND o.type = 'error' AND o.is_active = 1`
  ).all(project);

  const results = [];
  for (const e of errors) {
    if (!_matchesError(successText, successTags, e)) continue;

    const next = e.lesson_count - 1;
    if (next <= 0) {
      db.prepare('UPDATE observations SET is_active = 0 WHERE id = ?').run(e.id);
      db.prepare('DELETE FROM failure_decay WHERE error_id = ?').run(e.id);
      results.push({ errorId: e.id, lessonCount: 0, deleted: true });
    } else {
      db.prepare("UPDATE failure_decay SET lesson_count = ?, last_success_at = datetime('now') WHERE error_id = ?")
        .run(next, e.id);
      results.push({ errorId: e.id, lessonCount: next, deleted: false });
    }
  }
  return results;
}

// ─── Exports ──────────────────────────────────────────────────────

module.exports = {
  CONDITION_FAMILIES,
  classifyCondition,
  recordFailure,
  probeCondition,
  shouldRetry,
  getCachedLLM,
  cacheLLM,
  clearLLMCache,
  registerFailure,
  applyCounterEvidence,
};
