/**
 * experience-replay.js — Learn successful operations as replayable scripts.
 *
 * Ported from auton/core/experience.py. Every successful multi-step operation
 * is recorded as a deterministic script: the exact steps that worked. When the
 * same command is repeated, we replay the script instead of re-computing —
 * same result, zero reasoning overhead, zero LLM calls.
 *
 * This is the agent's own determinism engine: the more operations it runs
 * successfully, the more it runs them *exactly* the way that worked. Includes
 * trajectory optimization (bottleneck detection, batching, redundancy removal)
 * and LLM cost estimation to prove how many model calls were saved.
 *
 * @module core/experience-replay
 */

'use strict';

const MAX_SCRIPTS = 200;

// ─── Key normalization ────────────────────────────────────────────────

/**
 * Canonical command key: lowercase, whitespace-collapsed, punctuation-trimmed.
 * @param {string} text
 * @returns {string}
 */
function normalizeKey(text) {
  return (text || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/^[ ,;:-]+|[ ,;:-]+$/g, '');
}

// ─── Cost estimation ──────────────────────────────────────────────────

/**
 * Estimate the notional LLM cost avoided by running this deterministically.
 *
 * @param {string} label — the command text
 * @param {Array<Object>} steps — recorded steps
 * @param {Object} [pricing] — { inputPerMtok: 0.15, outputPerMtok: 0.60 }
 * @returns {number} estimated USD saved
 */
function estimateCostSaved(label, steps, pricing = {}) {
  const inputPerMtok = pricing.inputPerMtok || 0.15;
  const outputPerMtok = pricing.outputPerMtok || 0.60;
  let words = (label || '').split(/\s+/).length;
  for (const s of (steps || [])) {
    words += JSON.stringify(s).split(/\s+/).length;
  }
  const inTok = Math.ceil(words * 1.35);
  const outTok = (steps || []).length * 240;
  const calls = Math.max(1, (steps || []).length) * 1.2;
  return (inTok * calls / 1e6 * inputPerMtok) + (outTok * calls / 1e6 * outputPerMtok);
}

// ─── DB-backed store ──────────────────────────────────────────────────

/**
 * Record a successful operation as a replayable script.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} params
 * @param {string} params.commandKey — normalized key
 * @param {string} params.label — original command text
 * @param {Array<Object>} params.steps — steps that worked
 * @param {string} [params.project]
 * @param {number} [params.llmCallsSaved=0] — LLM calls avoided
 * @returns {{ replayed: boolean, runs: number }}
 */
function recordScript(db, { commandKey, label, steps, project, llmCallsSaved }) {
  const proj = project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const cost = estimateCostSaved(label, steps);
  const llm = llmCallsSaved || 0;
  const now = new Date().toISOString();

  const existing = db.prepare(
    `SELECT id, runs FROM experience_scripts WHERE project_path = ? AND command_key = ?`
  ).get(proj, commandKey);

  if (existing) {
    db.prepare(`
      UPDATE experience_scripts SET
        label = ?, steps = ?, runs = runs + 1, successes = successes + 1,
        llm_calls_saved = llm_calls_saved + ?, est_cost_saved = est_cost_saved + ?,
        last_run = ?
      WHERE id = ?
    `).run(label.slice(0, 160), JSON.stringify(steps), llm, cost, now, existing.id);
  } else {
    db.prepare(`
      INSERT INTO experience_scripts (project_path, command_key, label, steps,
        runs, successes, failures, llm_calls_saved, est_cost_saved, last_run, created_at)
      VALUES (?, ?, ?, ?, 1, 1, 0, ?, ?, ?, ?)
    `).run(proj, commandKey, label.slice(0, 160), JSON.stringify(steps), llm, cost, now, now);
    pruneScripts(db, proj);
  }

  // Log execution
  db.prepare(`
    INSERT INTO experience_executions (script_id, project_path, kind, outcome, llm_calls_saved, est_cost_saved)
    VALUES (?, ?, 'record', 'success', ?, ?)
  `).run(existing ? existing.id : null, proj, llm, cost);

  const row = db.prepare(
    `SELECT runs FROM experience_scripts WHERE project_path = ? AND command_key = ?`
  ).get(proj, commandKey);

  return { replayed: !!existing, runs: row ? row.runs : 1 };
}

/**
 * Log a replay outcome (success or failure).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} commandKey
 * @param {string} outcome — 'success' | 'failure'
 * @param {string} [project]
 * @param {number} [durationMs=0]
 * @param {number} [llmCallsSaved=0]
 */
function logReplay(db, commandKey, outcome, project, durationMs = 0, llmCallsSaved = 0) {
  const proj = project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO experience_executions (project_path, kind, outcome, llm_calls_saved, duration_ms, est_cost_saved)
    VALUES (?, 'replay', ?, ?, ?, 0)
  `).run(proj, outcome, llmCallsSaved, durationMs);

  if (outcome === 'success') {
    db.prepare(`
      UPDATE experience_scripts SET runs = runs + 1, successes = successes + 1, last_run = ?
      WHERE project_path = ? AND command_key = ?
    `).run(now, proj, commandKey);
  } else {
    db.prepare(`
      UPDATE experience_scripts SET runs = runs + 1, failures = failures + 1, last_run = ?
      WHERE project_path = ? AND command_key = ?
    `).run(now, proj, commandKey);
  }
}

/**
 * Find a script by key.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} commandKey
 * @param {string} [project]
 * @returns {Object|null}
 */
function findScript(db, commandKey, project) {
  const proj = project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const row = db.prepare(
    `SELECT * FROM experience_scripts WHERE project_path = ? AND command_key = ?`
  ).get(proj, commandKey);
  if (!row) return null;
  try { row.steps = JSON.parse(row.steps || '[]'); } catch { row.steps = []; }
  return row;
}

/**
 * List all learned scripts.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @param {number} [opts.limit=100]
 * @returns {Array<Object>}
 */
function listScripts(db, opts = {}) {
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const limit = opts.limit || 100;
  const rows = db.prepare(
    `SELECT * FROM experience_scripts WHERE project_path = ? ORDER BY last_run DESC LIMIT ?`
  ).all(proj, limit);
  for (const r of rows) {
    try { r.steps = JSON.parse(r.steps || '[]'); } catch { r.steps = []; }
  }
  return rows;
}

/**
 * Get experience stats.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} [project]
 * @returns {{ tasks: number, runs: number, successes: number, failures: number, llmCallsSaved: number, estCostSaved: number, executions: number }}
 */
function scriptStats(db, project) {
  const proj = project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const row = db.prepare(`
    SELECT COUNT(*) as tasks, COALESCE(SUM(runs), 0) as runs,
      COALESCE(SUM(successes), 0) as successes, COALESCE(SUM(failures), 0) as failures,
      COALESCE(SUM(llm_calls_saved), 0) as llm_calls_saved,
      COALESCE(SUM(est_cost_saved), 0) as est_cost_saved
    FROM experience_scripts WHERE project_path = ?
  `).get(proj);
  const execRow = db.prepare(
    `SELECT COUNT(*) as cnt FROM experience_executions WHERE project_path = ?`
  ).get(proj);
  return {
    tasks: row.tasks,
    runs: row.runs,
    successes: row.successes,
    failures: row.failures,
    llmCallsSaved: row.llm_calls_saved,
    estCostSaved: Math.round(row.est_cost_saved * 1e6) / 1e6,
    executions: execRow ? execRow.cnt : 0,
  };
}

/**
 * Forget a learned script.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} commandKey
 * @param {string} [project]
 * @returns {boolean}
 */
function forgetScript(db, commandKey, project) {
  const proj = project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const result = db.prepare(
    `DELETE FROM experience_scripts WHERE project_path = ? AND command_key = ?`
  ).run(proj, commandKey);
  return result.changes > 0;
}

// ─── Trajectory optimization ─────────────────────────────────────────

/**
 * Analyze an experience script and suggest optimizations:
 *  - Redundant steps (repeated type)
 *  - Bottlenecks (step > 2x median)
 *  - Batching opportunities (consecutive same-type steps)
 *
 * @param {Array<Object>} steps
 * @param {Array<number>} [timingMs] — per-step duration
 * @returns {{ totalSteps: number, suggestions: Array, estimatedSavingMs: number }}
 */
function optimizeScript(steps, timingMs = []) {
  const suggestions = [];
  const totalSteps = steps.length;

  if (!steps || totalSteps === 0) {
    return { totalSteps: 0, suggestions: [], estimatedSavingMs: 0 };
  }

  // 1. Redundant steps (same action type back-to-back)
  for (let i = 1; i < totalSteps; i++) {
    if (steps[i].type === steps[i - 1].type && steps[i].type !== 'observe') {
      suggestions.push({
        type: 'redundant_step',
        step: i,
        detail: `Step ${i} repeats type '${steps[i].type}' from step ${i - 1} — consider merging`,
        estimatedSavingMs: timingMs[i] || 0,
      });
    }
  }

  // 2. Bottleneck detection
  if (timingMs.length > 0) {
    const sorted = [...timingMs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    for (let i = 0; i < timingMs.length; i++) {
      if (timingMs[i] > median * 2 && timingMs[i] > 1000) {
        suggestions.push({
          type: 'bottleneck',
          step: i,
          detail: `Step ${i} took ${timingMs[i]}ms (${(timingMs[i] / median).toFixed(1)}x the median ${median}ms)`,
          estimatedSavingMs: 0,
        });
      }
    }
  }

  // 3. Batching opportunity (3+ consecutive same-type steps)
  if (totalSteps >= 3) {
    let batchStart = 0;
    for (let i = 1; i <= totalSteps; i++) {
      if (i === totalSteps || steps[i].type !== steps[batchStart].type) {
        const batchLen = i - batchStart;
        if (batchLen >= 3) {
          const saving = timingMs.slice(batchStart, i).reduce((a, b) => a + b, 0);
          suggestions.push({
            type: 'batching_opportunity',
            step: batchStart,
            detail: `Steps ${batchStart}-${i - 1} all type '${steps[batchStart].type}' — batch ${batchLen} actions`,
            estimatedSavingMs: Math.floor(saving / 3),
          });
        }
        batchStart = i;
      }
    }
  }

  const estimatedSavingMs = suggestions.reduce((s, sug) => s + (sug.estimatedSavingMs || 0), 0);

  return { totalSteps, suggestions, estimatedSavingMs };
}

// ─── Internal ──────────────────────────────────────────────────────────

function pruneScripts(db, project) {
  const rows = db.prepare(
    `SELECT id FROM experience_scripts WHERE project_path = ? ORDER BY last_run DESC LIMIT -1 OFFSET ?`
  ).all(project, MAX_SCRIPTS);
  const del = db.prepare(`DELETE FROM experience_scripts WHERE id = ?`);
  for (const r of rows) del.run(r.id);
}

// ─── Exports ──────────────────────────────────────────────────────────

module.exports = {
  normalizeKey,
  estimateCostSaved,
  recordScript,
  logReplay,
  findScript,
  listScripts,
  scriptStats,
  forgetScript,
  optimizeScript,
};