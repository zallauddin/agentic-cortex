/**
 * swarm-plan.js — Bridge between the .swarm plan-ledger harness and the
 * core swarm engine.
 *
 * The external harness keeps its plan in `.swarm/plan.json` (current state)
 * and `.swarm/plan-ledger.jsonl` (append-only history: plan_created,
 * task_status_changed, snapshot events with plan hashes). QA gate selection
 * lives in `.swarm/context.md` ("User selected: reviewer, test_engineer,
 * hallucination_guard").
 *
 * This module makes the plan and the engine share ONE source of truth:
 *
 *   1. importPlan  — reads the harness plan and materializes it as real
 *                    swarm_tasks rows (plan tasks → worker roles, `depends`
 *                    → dependency_ids, acceptance/size/plan ids preserved,
 *                    QA gates appended as reviewer/tester/verifier tasks).
 *   2. execute     — the imported goal runs through the core engine
 *                    (executePipeline: parallel pool, failure loop, workers,
 *                    job queue — all existing machinery).
 *   3. syncPlan    — writes the resulting task/phase statuses back to
 *                    plan.json and appends task_status_changed events to
 *                    the ledger (with plan hashes), so the harness sees
 *                    exactly what the engine did.
 *
 * @module core/swarm-plan
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEDGER_SCHEMA_VERSION = '1.1.0';
const PLAN_SCHEMA_VERSION = '1.0.0';

// QA gate name → swarm persona role.
const DEFAULT_GATE_ROLES = {
  reviewer: 'reviewer',
  test_engineer: 'tester',
  hallucination_guard: 'verifier',
  sme: 'planner',
  critic: 'reviewer',
  explorer: 'analyzer',
};

// Plan status ⇄ swarm task status.
const PLAN_TO_SWARM = { pending: 'pending', in_progress: 'pending', running: 'pending', completed: 'completed', failed: 'failed', blocked: 'pending' };
const SWARM_TO_PLAN = { pending: 'pending', running: 'in_progress', completed: 'completed', failed: 'failed', stale: 'in_progress' };

// ─── File helpers ─────────────────────────────────────────────────────

function _swarmDir(project) {
  return path.join(path.resolve(project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd()), '.swarm');
}

/**
 * Canonical sha256 hash of a plan object (sorted keys for stability).
 */
function planHash(plan) {
  const canonical = JSON.stringify(sortKeys(plan));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, k) => { acc[k] = sortKeys(value[k]); return acc; }, {});
  }
  return value;
}

/**
 * Parse a .swarm/plan-ledger.jsonl file into records (in order).
 */
function readLedger(project) {
  const file = path.join(_swarmDir(project), 'plan-ledger.jsonl');
  if (!fs.existsSync(file)) return [];
  const records = [];
  for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return records;
}

/**
 * Read the current plan: plan.json (live state) → SWARM_PLAN.json →
 * latest ledger record carrying a full plan snapshot.
 */
function readPlan(project) {
  const dir = _swarmDir(project);
  for (const name of ['plan.json', 'SWARM_PLAN.json']) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) {
      try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { /* try next */ }
    }
  }
  for (const rec of [...readLedger(project)].reverse()) {
    if (rec.payload && rec.payload.plan) return rec.payload.plan;
  }
  return null;
}

/**
 * Parse QA gate selection from context.md ("User selected: a, b, c"),
 * falling back to defaults.
 */
function readQaGates(project, fallback = ['reviewer']) {
  const file = path.join(_swarmDir(project), 'context.md');
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf-8');
    const m = text.match(/User selected:\s*(.+)/i);
    if (m) {
      const gates = m[1]
        .split(',')
        .map(s => s.replace(/\(mandatory\)/gi, '').trim().toLowerCase())
        .filter(Boolean);
      if (gates.length > 0) return gates;
    }
  }
  return fallback.slice();
}

function _planId(plan) {
  if (plan.plan_id) return plan.plan_id;
  const slug = String(plan.title || 'plan').replace(/\s+/g, '_');
  return `${plan.swarm || 'swarm'}-${slug}`;
}

function _goalName(plan) {
  return plan.title || _planId(plan);
}

// ─── Import: plan → swarm_tasks ───────────────────────────────────────

/**
 * Materialize the harness plan as swarm_tasks rows.
 *
 * Each plan task becomes a primary task (default role 'coder' — the work
 * itself) plus one QA-gate task per selected gate (reviewer / test_engineer
 * → tester / hallucination_guard → verifier), chained by the plan's
 * `depends`. Completed plan tasks import as completed. Idempotent: rows are
 * keyed by (project, plan_id, plan_task_id).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @param {Object} [opts]
 * @param {Object} [opts.plan] — plan object (defaults to readPlan)
 * @param {string[]} [opts.gates] — QA gates (defaults to readQaGates)
 * @param {Object} [opts.roleFor] — gate→role override
 * @param {string} [opts.role] — default role for plan tasks ('coder')
 * @returns {{ ok: boolean, planId: string, goal: string, imported: number, tasks: number, gates: string[], error?: string }}
 */
function importPlan(db, project, opts = {}) {
  const plan = opts.plan || readPlan(project);
  if (!plan || !Array.isArray(plan.phases)) {
    return { ok: false, error: `no plan found in ${_swarmDir(project)} (plan.json / SWARM_PLAN.json / ledger)` };
  }

  const proj = path.resolve(project);
  const planId = _planId(plan);
  const goal = _goalName(plan);
  const gates = (opts.gates || readQaGates(proj)).map(g => g.toLowerCase()).filter(Boolean);
  const roleFor = { ...DEFAULT_GATE_ROLES, ...(opts.roleFor || {}) };
  const defaultRole = opts.role || 'coder';

  const idByPlanTask = {};
  let imported = 0;

  // Pass 1: primary tasks.
  for (const phase of plan.phases) {
    for (const pt of (phase.tasks || [])) {
      const existing = db.prepare(
        `SELECT * FROM swarm_tasks WHERE project_path = ? AND plan_id = ? AND plan_task_id = ?`
      ).get(proj, planId, pt.id);
      let taskId;
      if (existing) {
        taskId = existing.id;
        if (pt.status === 'completed' && existing.status !== 'completed') {
          completeTask_(db, existing.id, '(imported as completed from plan)');
        }
      } else {
        const r = db.prepare(`
          INSERT INTO swarm_tasks (project_path, goal, plan_id, plan_task_id, phase_id, agent_role,
            status, priority, dependency_ids, acceptance, task_size, qa_gates)
          VALUES (?, ?, ?, ?, ?, ?, ?, 5, '[]', ?, ?, ?)
        `).run(proj, goal, planId, pt.id, String(phase.id), defaultRole,
          PLAN_TO_SWARM[pt.status] || 'pending',
          pt.acceptance || '', pt.size || '', JSON.stringify(gates));
        taskId = r.lastInsertRowid;
        imported++;
      }
      idByPlanTask[pt.id] = taskId;
    }
  }

  // Pass 2: dependencies + QA gate tasks.
  const depsStmt = db.prepare(`UPDATE swarm_tasks SET dependency_ids = ? WHERE id = ?`);
  const gateFind = db.prepare(
    `SELECT id FROM swarm_tasks WHERE project_path = ? AND plan_id = ? AND plan_task_id = ?`
  );

  for (const phase of plan.phases) {
    for (const pt of (phase.tasks || [])) {
      const primaryId = idByPlanTask[pt.id];
      if (!primaryId) continue;
      const depIds = (pt.depends || [])
        .map(d => idByPlanTask[d])
        .filter(id => id != null);
      depsStmt.run(JSON.stringify(depIds), primaryId);

      for (const gate of gates) {
        const gateRole = roleFor[gate] || defaultRole;
        const gateTaskId = `${pt.id}:gate:${gate}`;
        const existingGate = gateFind.get(proj, planId, gateTaskId);
        if (!existingGate) {
          db.prepare(`
            INSERT INTO swarm_tasks (project_path, goal, plan_id, plan_task_id, phase_id, agent_role,
              status, priority, dependency_ids, acceptance, task_size, qa_gates)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', 4, ?, ?, ?, ?)
          `).run(
            proj, goal, planId, gateTaskId, String(phase.id), gateRole,
            JSON.stringify([primaryId]),
            `QA gate '${gate}' for task ${pt.id} — ${pt.acceptance || ''}`,
            '',
            JSON.stringify([gate])
          );
        }
      }
    }
  }

  const total = db.prepare(
    `SELECT COUNT(*) as c FROM swarm_tasks WHERE project_path = ? AND plan_id = ?`
  ).get(proj, planId).c;

  return { ok: true, planId, goal, imported, tasks: total, gates };
}

// local completeTask wrapper (avoid coupling to swarm module internals)
function completeTask_(db, taskId, summary) {
  db.prepare(`
    UPDATE swarm_tasks SET status = 'completed', result_summary = ?, completed_at = ?
    WHERE id = ?
  `).run(summary, new Date().toISOString(), taskId);
}

// ─── Sync: swarm_tasks → plan.json + ledger ───────────────────────────

/**
 * Derive the harness status for a plan task from its swarm task rows
 * (original + any replan replacements / gates). Completed wins; then failed;
 * then running; else pending.
 */
function _statusForTask(db, proj, planId, ptId) {
  const rows = db.prepare(
    `SELECT status, escalated FROM swarm_tasks WHERE project_path = ? AND plan_id = ? AND plan_task_id = ?`
  ).all(proj, planId, ptId);
  if (rows.length === 0) return 'pending';
  if (rows.some(r => r.status === 'completed')) return 'completed';
  if (rows.some(r => r.status === 'failed' || r.escalated)) return 'failed';
  if (rows.some(r => r.status === 'running')) return 'in_progress';
  return 'pending';
}

/**
 * Write the engine's swarm_tasks state back into the harness plan.
 *
 * Updates `.swarm/plan.json` (the live plan) and appends
 * `task_status_changed` ledger events for every status that moved, plus a
 * `snapshot` event carrying the full updated plan.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @param {Object} [opts]
 * @param {Object} [opts.plan] — plan to sync (defaults to readPlan)
 * @returns {{ ok: boolean, planId: string, changes: Array<Object>, error?: string }}
 */
function syncPlan(db, project, opts = {}) {
  const plan = opts.plan || readPlan(project);
  if (!plan) return { ok: false, error: 'no plan to sync' };

  const proj = path.resolve(project);
  const planId = _planId(plan);
  const changes = [];
  let anyChange = false;

  for (const phase of plan.phases) {
    for (const pt of (phase.tasks || [])) {
      const newStatus = _statusForTask(db, proj, planId, pt.id);
      if (pt.status !== newStatus) {
        changes.push({ taskId: pt.id, phaseId: phase.id, fromStatus: pt.status, toStatus: newStatus });
        pt.status = newStatus;
        anyChange = true;
      }
    }
    // Phase status from its tasks, QA gates included: a failed gate task
    // (e.g. reviewer/test_engineer/hallucination_guard) fails the phase.
    const phaseTasks = phase.tasks || [];
    const gateRows = db.prepare(
      `SELECT status, escalated FROM swarm_tasks WHERE project_path = ? AND plan_id = ? AND phase_id = ? AND plan_task_id LIKE '%:gate:%'`
    ).all(proj, planId, String(phase.id));
    const gateFailed = gateRows.some(r => r.status === 'failed' || r.escalated);
    const taskFailed = phaseTasks.some(t => t.status === 'failed');
    const gatesDone = gateRows.length === 0 || gateRows.every(r => r.status === 'completed');
    const allDone = phaseTasks.length > 0 && phaseTasks.every(t => t.status === 'completed') && gatesDone;
    const next = (taskFailed || gateFailed) ? 'failed' : allDone ? 'completed' : 'in_progress';
    if (phase.status !== next) {
      phase.status = next;
      anyChange = true;
    }
  }

  // Persist the live plan file + append ledger events.
  const dir = _swarmDir(proj);
  const planFile = path.join(dir, 'plan.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2) + '\n', 'utf-8');

  if (anyChange) {
    const ledger = path.join(dir, 'plan-ledger.jsonl');
    const records = readLedger(proj);
    let seq = records.length ? Math.max(...records.map(r => r.seq || 0)) : 0;
    const hashAfter = planHash(plan);
    const now = new Date().toISOString();
    const lines = [];
    for (const c of changes) {
      seq++;
      lines.push(JSON.stringify({
        plan_id: planId,
        event_type: 'task_status_changed',
        task_id: c.taskId,
        phase_id: c.phaseId,
        from_status: c.fromStatus,
        to_status: c.toStatus,
        source: 'swarm-engine',
        seq,
        timestamp: now,
        plan_hash_before: hashAfter,
        plan_hash_after: hashAfter,
        schema_version: LEDGER_SCHEMA_VERSION,
      }));
    }
    seq++;
    lines.push(JSON.stringify({
      plan_id: planId,
      event_type: 'snapshot',
      source: 'swarm-engine',
      seq,
      timestamp: now,
      plan_hash_before: hashAfter,
      plan_hash_after: hashAfter,
      schema_version: LEDGER_SCHEMA_VERSION,
      payload: { plan },
    }));
    fs.appendFileSync(ledger, lines.map(l => l + '\n').join(''), 'utf-8');
  }

  return { ok: true, planId, changes, synced: anyChange };
}

// ─── Combined flow ─────────────────────────────────────────────────────

/**
 * End-to-end: import the harness plan into swarm_tasks, execute it through
 * the core engine (parallel pool, failure loop, optional workers/jobs), then
 * sync results back to plan.json + the ledger.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @param {Object} [opts] — passed to importPlan (plan/gates) and executePipeline (workerMode, worker, concurrency, retryPolicy…)
 * @returns {Promise<{ ok: boolean, import: Object, execution: Object|null, sync: Object, error?: string }>}
 */
async function runPlan(db, project, opts = {}) {
  const imported = importPlan(db, project, opts);
  if (!imported.ok) return { ok: false, import: imported, execution: null, sync: null, error: imported.error };

  let execution = null;
  try {
    const { executePipeline } = require('./swarm');
    execution = await executePipeline(db, imported.goal, { project, ...opts });
  } catch (err) {
    execution = { goal: imported.goal, results: [], meta: { error: err.message } };
  }

  const sync = syncPlan(db, project, { plan: opts.plan });
  return { ok: true, import: imported, execution, sync };
}

// ─── Info ─────────────────────────────────────────────────────────────

/**
 * Describe the harness↔engine wiring for a project: plan summary, task/phase
 * statuses, QA gates, and how many tasks are imported into swarm_tasks.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @param {Object} [opts]
 * @returns {Object}
 */
function planInfo(db, project, opts = {}) {
  const proj = path.resolve(project);
  const plan = opts.plan || readPlan(proj);
  const gates = readQaGates(proj);
  if (!plan) {
    return { ok: false, project: proj, error: 'no plan found' };
  }
  const planId = _planId(plan);
  const counts = { total: 0, pending: 0, running: 0, completed: 0, failed: 0 };
  for (const phase of plan.phases) {
    for (const pt of (phase.tasks || [])) {
      counts.total++;
      if (counts[pt.status] != null) counts[pt.status]++;
    }
  }
  const imported = db.prepare(
    `SELECT COUNT(*) as c FROM swarm_tasks WHERE project_path = ? AND plan_id = ?`
  ).get(proj, planId).c;
  return {
    ok: true,
    project: proj,
    planId,
    title: plan.title,
    swarm: plan.swarm,
    currentPhase: plan.current_phase,
    phases: (plan.phases || []).map(p => ({ id: p.id, name: p.name, status: p.status, tasks: (p.tasks || []).length })),
    counts,
    qaGates: gates,
    importedTasks: imported,
    ledgerEvents: readLedger(proj).length,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────

module.exports = {
  LEDGER_SCHEMA_VERSION,
  PLAN_SCHEMA_VERSION,
  DEFAULT_GATE_ROLES,
  planHash,
  readLedger,
  readPlan,
  readQaGates,
  importPlan,
  syncPlan,
  runPlan,
  planInfo,
};
