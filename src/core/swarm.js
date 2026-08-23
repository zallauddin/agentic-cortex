/**
 * swarm.js — Persona-based multi-agent orchestration through shared brain.
 *
 * Ported from cortex-swarm. A goal is decomposed into a dependency DAG and
 * dispatched to role-based agents (orchestrator, analyzer, planner, coder,
 * tester, reviewer, verifier). Each persona is a logical agent with its own
 * agent_id + role, but they all write to the SAME SQLite brain. Coordination
 * happens through the brain, not direct process-to-process calls:
 *
 *   1. Decompose — orchestrator breaks down goal, persists as swarm_tasks
 *   2. Dispatch — subtasks sent to persona mailboxes (memory_send)
 *   3. Execute — each persona runs bootstrap() + role-specific work
 *   4. Report — outcomes written back via memory_send to orchestrator
 *   5. Merge — orchestrator collects results and synthesizes final answer
 *
 * @module core/swarm
 */

'use strict';

// ─── Persona definitions ─────────────────────────────────────────────

const PERSONAS = {
  orchestrator: {
    id: 'orchestrator',
    role: 'orchestrator',
    description: 'Decomposes a goal into a dependency DAG, dispatches subtasks to workers, and merges results.',
    handles: ['decompose', 'dispatch', 'merge'],
  },
  analyzer: {
    id: 'analyzer',
    role: 'analyzer',
    description: 'Reads the shared brain and produces findings about what already exists and what is missing.',
    handles: ['analyze'],
  },
  planner: {
    id: 'planner',
    role: 'planner',
    description: 'Turns analysis into an ordered implementation plan.',
    handles: ['plan'],
  },
  coder: {
    id: 'coder',
    role: 'coder',
    description: 'Implements the plan. Its work is recorded as intent/action/outcome so the brain learns from it.',
    handles: ['implement'],
  },
  tester: {
    id: 'tester',
    role: 'tester',
    description: 'Writes/selects tests for the implemented change (parallel branch with the coder).',
    handles: ['write-tests'],
  },
  reviewer: {
    id: 'reviewer',
    role: 'reviewer',
    description: 'Reviews the coder and tester outputs against the shared brain standards and prior failures.',
    handles: ['review'],
  },
  verifier: {
    id: 'verifier',
    role: 'verifier',
    description: 'Verifies the final result end-to-end before the orchestrator merges.',
    handles: ['verify'],
  },
  reasoner: {
    id: 'reasoner',
    role: 'reasoner',
    description: 'Runs deterministic inference (deduction, induction, analogy, abduction, synthesis, forecast) over the brain to produce new insights.',
    handles: ['reason'],
  },
};

/**
 * Standard swarm pipeline: goal → analyze → plan → implement → test → review → verify → merge.
 */
const DEFAULT_PIPELINE = [
  { role: 'analyzer', action: 'analyze', dependsOn: [], description: 'Analyze the problem and existing knowledge' },
  { role: 'planner', action: 'plan', dependsOn: ['analyzer'], description: 'Create an implementation plan' },
  { role: 'coder', action: 'implement', dependsOn: ['planner'], description: 'Implement the plan' },
  { role: 'tester', action: 'write-tests', dependsOn: ['coder'], description: 'Write tests for the implementation' },
  { role: 'reviewer', action: 'review', dependsOn: ['tester'], description: 'Review against standards and past failures' },
  { role: 'verifier', action: 'verify', dependsOn: ['reviewer'], description: 'Verify end-to-end' },
  { role: 'orchestrator', action: 'merge', dependsOn: ['verifier'], description: 'Merge and synthesize results' },
];

// ─── DB-backed orchestration ──────────────────────────────────────────

/**
 * Decompose a goal into swarm tasks and persist them.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} goal — the high-level goal
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @param {Array<{role: string, action: string, dependsOn: string[], description: string}>} [opts.pipeline] — custom pipeline
 * @returns {Array<Object>} created tasks
 */
function decomposeGoal(db, goal, opts = {}) {
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const pipeline = opts.pipeline || DEFAULT_PIPELINE;
  const tasks = [];
  const roleToId = {};

  for (const step of pipeline) {
    const persona = PERSONAS[step.role];
    if (!persona) continue;

    const dependencyIds = (step.dependsOn || [])
      .map(r => roleToId[r])
      .filter(id => id != null);

    const result = db.prepare(`
      INSERT INTO swarm_tasks (project_path, goal, agent_role, status, priority, dependency_ids)
      VALUES (?, ?, ?, 'pending', 5, ?)
    `).run(proj, goal, persona.id, JSON.stringify(dependencyIds));

    roleToId[step.role] = result.lastInsertRowid;

    tasks.push({
      id: result.lastInsertRowid,
      role: persona.id,
      action: step.action,
      description: step.description,
      dependsOn: step.dependsOn,
      status: 'pending',
    });
  }

  return tasks;
}

/**
 * Get the next ready task for a given role (all dependencies completed).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} role — agent role (e.g. 'coder', 'analyzer')
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @param {number} [opts.goalId] — filter by specific goal
 * @returns {Object|null}
 */
function getNextTask(db, role, opts = {}) {
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const rows = db.prepare(`
    SELECT * FROM swarm_tasks
    WHERE project_path = ? AND agent_role = ? AND status = 'pending'
    ORDER BY priority DESC, created_at ASC
  `).all(proj, role);

  for (const task of rows) {
    // Check dependencies
    let deps = [];
    try { deps = JSON.parse(task.dependency_ids || '[]'); } catch { /* empty */ }
    if (deps.length === 0) return task;

    const allDone = deps.every(depId => {
      const dep = db.prepare(
        `SELECT status FROM swarm_tasks WHERE id = ?`
      ).get(depId);
      return dep && dep.status === 'completed';
    });

    if (allDone) return task;
  }

  return null;
}

/**
 * Mark a task as started.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} taskId
 */
function startTask(db, taskId) {
  db.prepare(`
    UPDATE swarm_tasks SET status = 'running', started_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(new Date().toISOString(), taskId);
}

/**
 * Mark a task as completed with results.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} taskId
 * @param {string} resultSummary
 * @param {number} [resultObsId] — observation ID for the result
 */
function completeTask(db, taskId, resultSummary, resultObsId) {
  db.prepare(`
    UPDATE swarm_tasks SET status = 'completed', result_summary = ?,
      result_observation_id = ?, completed_at = ?
    WHERE id = ?
  `).run(resultSummary, resultObsId || null, new Date().toISOString(), taskId);
}

/**
 * Mark a task as failed.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} taskId
 * @param {string} reason
 */
function failTask(db, taskId, reason) {
  db.prepare(`
    UPDATE swarm_tasks SET status = 'failed', result_summary = ?, completed_at = ?
    WHERE id = ?
  `).run(reason, new Date().toISOString(), taskId);
}

/**
 * Get all tasks for a goal.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} goal
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @returns {Array<Object>}
 */
function getGoalTasks(db, goal, opts = {}) {
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const rows = db.prepare(`
    SELECT * FROM swarm_tasks WHERE project_path = ? AND goal = ? ORDER BY created_at
  `).all(proj, goal);
  for (const r of rows) {
    try { r.dependency_ids = JSON.parse(r.dependency_ids || '[]'); } catch { r.dependency_ids = []; }
  }
  return rows;
}

/**
 * Get a summary of the swarm's progress on a goal.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} goal
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @returns {{ goal: string, total: number, pending: number, running: number, completed: number, failed: number, results: Array }}
 */
function getGoalProgress(db, goal, opts = {}) {
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const statuses = db.prepare(`
    SELECT status, COUNT(*) as cnt FROM swarm_tasks WHERE project_path = ? AND goal = ?
    GROUP BY status
  `).all(proj, goal);

  const counts = { total: 0, pending: 0, running: 0, completed: 0, failed: 0 };
  for (const s of statuses) {
    counts[s.status] = s.cnt;
    counts.total += s.cnt;
  }

  const results = db.prepare(`
    SELECT id, agent_role, status, result_summary FROM swarm_tasks
    WHERE project_path = ? AND goal = ? AND status IN ('completed', 'failed')
    ORDER BY completed_at
  `).all(proj, goal);

  return { goal, ...counts, results };
}

/**
 * List all active goals (goals with pending/running tasks).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @returns {Array<{goal: string, status: string, taskCount: number}>}
 */
function listActiveGoals(db, opts = {}) {
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  return db.prepare(`
    SELECT goal, COUNT(*) as task_count
    FROM swarm_tasks WHERE project_path = ? AND status IN ('pending', 'running')
    GROUP BY goal ORDER BY goal
  `).all(proj);
}

/**
 * Synthesize a final answer from all completed task results.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} goal
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @returns {Array<string>} collected result summaries in pipeline order
 */
function synthesizeGoal(db, goal, opts = {}) {
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const rows = db.prepare(`
    SELECT agent_role, result_summary FROM swarm_tasks
    WHERE project_path = ? AND goal = ? AND status = 'completed'
    ORDER BY completed_at
  `).all(proj, goal);
  return rows.map(r => ({ role: r.agent_role, result: r.result_summary }));
}

// ─── Exports ──────────────────────────────────────────────────────────

module.exports = {
  PERSONAS,
  DEFAULT_PIPELINE,
  decomposeGoal,
  getNextTask,
  startTask,
  completeTask,
  failTask,
  getGoalTasks,
  getGoalProgress,
  listActiveGoals,
  synthesizeGoal,
};