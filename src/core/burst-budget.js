/**
 * burst-budget.js — Rolling-window burst budget + circuit breaker.
 *
 * Ported from auton/core/brain.py (hands_free_check). A rate-limiting guard
 * that allows autonomous operation within a bounded, audited envelope:
 *
 * 1. Allowlist — only configured tools may run autonomously
 * 2. Burst budget — max N actions per rolling M-second window
 * 3. Circuit breaker — any failure opens the breaker; requires explicit
 *    human reset (no auto-recovery from a failure cascade)
 * 4. Audit trail — every action is logged (tool, outcome, timestamp)
 *
 * The circuit breaker is the safety boundary: when the agent fails at
 * something, it stops acting autonomously until you explicitly re-enable it.
 * No silent cascading failures.
 *
 * @module core/burst-budget
 */

'use strict';

/**
 * @typedef {Object} BurstConfig
 * @property {string[]} allowlist — tools permitted to run autonomously
 * @property {number} windowMs — rolling window duration (default 300000 = 5 min)
 * @property {number} maxPerWindow — max actions per window (default 5)
 */

/**
 * @typedef {Object} BurstState
 * @property {boolean} circuitOpen — is the circuit breaker tripped?
 * @property {string} openReason — why the breaker opened
 * @property {string} openedAt — ISO timestamp
 * @property {number[]} recentTimestamps — recent action timestamps (ms)
 */

// ─── In-memory state (per project) ─────────────────────────────────────

/** @type {Map<string, BurstState>} */
const _states = new Map();

function getState(project) {
  let s = _states.get(project);
  if (!s) {
    s = { circuitOpen: false, openReason: null, openedAt: null, recentTimestamps: [] };
    _states.set(project, s);
  }
  return s;
}

// ─── Core checks ───────────────────────────────────────────────────────

/**
 * Check whether a tool is allowed to run under the current burst budget.
 * Returns { allowed, reason, remaining }.
 *
 * @param {string} toolName
 * @param {string} project
 * @param {BurstConfig} config
 * @returns {{ allowed: boolean, reason: string, remaining: number }}
 */
function check(toolName, project, config = {}) {
  const allowlist = config.allowlist || [];
  const windowMs = config.windowMs || 300000;
  const maxPerWindow = config.maxPerWindow || 5;
  const state = getState(project);

  // 1. Circuit breaker: open => no autonomous actions
  if (state.circuitOpen) {
    return {
      allowed: false,
      reason: `Circuit breaker open (${state.openReason || 'unknown failure'} at ${state.openedAt || 'unknown time'}). Reset manually.`,
      remaining: 0,
    };
  }

  // 2. Allowlist: only permitted tools
  if (!allowlist.includes(toolName)) {
    return {
      allowed: false,
      reason: `'${toolName}' is not in the autonomous allowlist: [${allowlist.join(', ')}]`,
      remaining: 0,
    };
  }

  // 3. Burst budget: rolling window
  const now = Date.now();
  const cutoff = now - windowMs;
  state.recentTimestamps = state.recentTimestamps.filter(ts => ts > cutoff);
  const used = state.recentTimestamps.length;
  const remaining = Math.max(0, maxPerWindow - used - 1); // -1 for the action we're about to take

  if (used >= maxPerWindow) {
    return {
      allowed: false,
      reason: `Burst budget exhausted: ${used}/${maxPerWindow} actions in the last ${Math.round(windowMs / 1000)}s. Wait for the window to roll.`,
      remaining: 0,
    };
  }

  return { allowed: true, reason: `${remaining} remaining in this window`, remaining };
}

/**
 * Record a successful autonomous action.
 *
 * @param {string} toolName
 * @param {string} project
 * @param {string} [summary=''] — human-readable description
 */
function recordSuccess(toolName, project, summary = '') {
  const state = getState(project);
  state.recentTimestamps.push(Date.now());
}

/**
 * Trip the circuit breaker after a failure.
 * Records the failure, opens the breaker, and logs the audit trail to DB.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} toolName
 * @param {string} project
 * @param {string} [reason=''] — what went wrong
 */
function recordFailure(db, toolName, project, reason = '') {
  const state = getState(project);
  state.circuitOpen = true;
  state.openReason = reason || `Autonomous action '${toolName}' failed`;
  state.openedAt = new Date().toISOString();

  // Persist to DB
  if (db) {
    const proj = project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
    db.prepare(`
      INSERT INTO burst_audit (project_path, tool_name, outcome) VALUES (?, ?, 'failure')
    `).run(proj, toolName);
    db.prepare(`
      INSERT INTO burst_state (project_path, circuit_open, open_reason, opened_at, updated_at)
      VALUES (?, 1, ?, ?, ?)
      ON CONFLICT(project_path) DO UPDATE SET
        circuit_open = 1, open_reason = excluded.open_reason,
        opened_at = excluded.opened_at, updated_at = excluded.updated_at
    `).run(proj, state.openReason, state.openedAt, state.openedAt);
  }
}

/**
 * Record a successful autonomous action in the DB audit trail.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} toolName
 * @param {string} project
 */
function auditSuccess(db, toolName, project) {
  const proj = project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  db.prepare(
    `INSERT INTO burst_audit (project_path, tool_name, outcome) VALUES (?, ?, 'success')`
  ).run(proj, toolName);
}

/**
 * Reset the circuit breaker. Requires explicit call — no auto-recovery.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @returns {{ reset: boolean, previousReason: string }}
 */
function resetCircuit(db, project) {
  const state = getState(project);
  const previous = state.openReason;
  state.circuitOpen = false;
  state.openReason = null;
  state.openedAt = null;
  state.recentTimestamps = []; // fresh budget on reset

  if (db) {
    const proj = project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
    db.prepare(`
      INSERT INTO burst_state (project_path, circuit_open, open_reason, opened_at, updated_at)
      VALUES (?, 0, NULL, NULL, ?)
      ON CONFLICT(project_path) DO UPDATE SET
        circuit_open = 0, open_reason = NULL, opened_at = NULL, updated_at = excluded.updated_at
    `).run(proj, new Date().toISOString());
  }

  return { reset: true, previousReason: previous };
}

/**
 * Get the current burst budget state.
 *
 * @param {string} project
 * @param {BurstConfig} [config]
 * @returns {{ circuitOpen: boolean, openReason: string|null, recentCount: number, remainingBudget: number, allowlist: string[] }}
 */
function getBurstState(project, config = {}) {
  const state = getState(project);
  const windowMs = config.windowMs || 300000;
  const maxPerWindow = config.maxPerWindow || 5;
  const cutoff = Date.now() - windowMs;
  const recent = state.recentTimestamps.filter(ts => ts > cutoff).length;
  return {
    circuitOpen: state.circuitOpen,
    openReason: state.openReason,
    openedAt: state.openedAt,
    recentCount: recent,
    remainingBudget: Math.max(0, maxPerWindow - recent),
    allowlist: config.allowlist || [],
    windowMs,
    maxPerWindow,
  };
}

/**
 * Get audit log from DB.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @param {number} [opts.limit=50]
 * @returns {Array<Object>}
 */
function getAuditLog(db, opts = {}) {
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const limit = opts.limit || 50;
  return db.prepare(
    `SELECT * FROM burst_audit WHERE project_path = ? ORDER BY created_at DESC LIMIT ?`
  ).all(proj, limit);
}

/**
 * Restore circuit state from DB (called at startup).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 */
function restoreFromDB(db, project) {
  const proj = project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const row = db.prepare(
    `SELECT * FROM burst_state WHERE project_path = ?`
  ).get(proj);
  if (row && row.circuit_open) {
    const state = getState(project);
    state.circuitOpen = true;
    state.openReason = row.open_reason;
    state.openedAt = row.opened_at;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────

module.exports = {
  check,
  recordSuccess,
  recordFailure,
  auditSuccess,
  resetCircuit,
  getBurstState,
  getAuditLog,
  restoreFromDB,
};