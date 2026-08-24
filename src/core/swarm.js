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

// ─── Reasoning engine injection ──────────────────────────────────────

/** @type {Object|null} API reference injected by src/api/index.js */
let _api = null;

/** @type {Function|null} Save function for persisting insights */
let _saveFn = null;

/**
 * Inject the API reference and save function so executeTask can dispatch
 * to tree-search, self-consistency, budget-force, and deterministic-reasoner.
 */
function setApi(api, saveFn) {
  _api = api;
  _saveFn = saveFn || null;
}

// ─── Role → strategy dispatch map ─────────────────────────────────────

/**
 * Each persona role maps to a reasoning strategy and a problem template.
 * The template uses {{goal}} and {{context}} placeholders.
 */
const ROLE_STRATEGY = {
  analyzer: {
    engine: 'tree-search',
    strategy: 'beam',
    promptTemplate: 'swarm-analyze',
    description: 'Analyze the problem and existing knowledge',
  },
  planner: {
    engine: 'budget-force',
    strategy: null,
    promptTemplate: 'swarm-plan',
    description: 'Create an ordered implementation plan',
  },
  coder: {
    engine: 'tree-search',
    strategy: 'mcts',
    promptTemplate: 'swarm-implement',
    description: 'Implement the plan step',
  },
  tester: {
    engine: 'self-consistency',
    strategy: null,
    promptTemplate: null,
    description: 'Write tests and validate the implementation',
  },
  reviewer: {
    engine: 'tree-search',
    strategy: 'beam',
    promptTemplate: 'swarm-review',
    description: 'Review against standards and past failures',
  },
  verifier: {
    engine: 'budget-force',
    strategy: null,
    promptTemplate: 'swarm-verify',
    description: 'Verify the final result end-to-end',
  },
  reasoner: {
    engine: 'deterministic',
    strategy: null,
    promptTemplate: null,
    description: 'Run deterministic inference to produce new insights',
  },
  orchestrator: {
    engine: 'synthesize',
    strategy: null,
    promptTemplate: null,
    description: 'Collect and merge all results',
  },
};

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

// ─── Task execution (personas dispatch to reasoning engines) ─────────

/**
 * Build a role-specific problem prompt for the reasoning engine.
 *
 * @param {Object} task — swarm task row
 * @param {string} goal — the parent goal text
 * @param {Object} [context] — additional context (prior results, brain search)
 * @returns {string} problem statement
 */
function _buildProblem(task, goal, context = {}) {
  const persona = PERSONAS[task.agent_role];
  const roleName = (persona && persona.role) || task.agent_role;
  const priorResults = context.priorResults || '';
  const brainContext = context.brainContext || '';

  switch (task.agent_role) {
    case 'analyzer':
      return `Goal: ${goal}\n\nYou are the ANALYZER. Read the shared brain and produce findings about what already exists and what is missing.\n\nBrain context:\n${brainContext}`;
    case 'planner':
      return `Goal: ${goal}\n\nYou are the PLANNER. Turn the analysis into an ordered implementation plan.\n\nAnalysis:\n${priorResults}`;
    case 'coder':
      return `Goal: ${goal}\n\nYou are the CODER. Implement the planned changes.\n\nPlan:\n${priorResults}\n\nRelevant context:\n${brainContext}`;
    case 'tester':
      return `Goal: ${goal}\n\nYou are the TESTER. Write tests that validate the implementation. Consider edge cases, regression risks, and standards.\n\nImplementation to test:\n${priorResults}`;
    case 'reviewer':
      return `Goal: ${goal}\n\nYou are the REVIEWER. Review the implementation and tests against known standards, past failures, and best practices.\n\nImplementation:\n${priorResults}\n\nStandards:\n${brainContext}`;
    case 'verifier':
      return `Goal: ${goal}\n\nYou are the VERIFIER. Verify that the completed work actually solves the original goal end-to-end.\n\nCompleted results:\n${priorResults}`;
    case 'reasoner':
      return goal;
    case 'orchestrator':
      return `Goal: ${goal}\n\nYou are the ORCHESTRATOR. Merge all completed results into a final synthesized answer.\n\nResults:\n${priorResults}`;
    default:
      return `Goal: ${goal}\n\nComplete your task as ${roleName}.`;
  }
}

/**
 * Execute a swarm task by dispatching to the appropriate reasoning engine.
 *
 * Each persona role maps to a reasoning strategy:
 *   analyzer    → beam search (wide exploration of brain)
 *   planner     → budget-force (deep sequential reasoning)
 *   coder       → MCTS (implementation with branching)
 *   tester      → self-consistency (multiple test approaches, majority vote)
 *   reviewer    → beam search (standards check)
 *   verifier    → budget-force (deep end-to-end verification)
 *   reasoner    → deterministic-reasoner (6 inference modes, zero LLM)
 *   orchestrator → synthesize (merge all completed results)
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} taskId
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @param {boolean} [opts.dryRun=false] — if true, return plan without executing
 * @returns {Promise<Object>} execution result
 */
async function executeTask(db, taskId, opts = {}) {
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();

  // Read the task
  const task = db.prepare(`SELECT * FROM swarm_tasks WHERE id = ?`).get(taskId);
  if (!task) throw new Error(`Swarm task not found: ${taskId}`);

  const mapping = ROLE_STRATEGY[task.agent_role];
  if (!mapping) throw new Error(`No strategy mapping for role: ${task.agent_role}`);

  // Gather context: prior completed results for dependency chain
  let priorResults = '';
  if (task.dependency_ids) {
    let deps = [];
    try { deps = JSON.parse(task.dependency_ids); } catch { /* empty */ }
    if (deps.length > 0) {
      const depRows = db.prepare(
        `SELECT agent_role, result_summary FROM swarm_tasks WHERE id IN (${deps.map(() => '?').join(',')}) AND status = 'completed'`
      ).all(...deps);
      priorResults = depRows.map(r => `[${r.agent_role}]: ${r.result_summary || '(no summary)'}`).join('\n');
    }
  }

  // Gather brain context: search for relevant knowledge
  let brainContext = '';
  if (_api && _api.search) {
    try {
      const searchResults = await _api.search(task.goal || '', { project: proj, limit: 5 });
      if (searchResults && searchResults.results) {
        brainContext = searchResults.results.slice(0, 5).map(r => r.content || r.title || '').join('\n---\n');
      }
    } catch { /* best-effort */ }
  }

  const context = { priorResults, brainContext };
  const problem = _buildProblem(task, task.goal || '', context);

  if (opts.dryRun) {
    return {
      taskId,
      role: task.agent_role,
      goal: task.goal,
      engine: mapping.engine,
      strategy: mapping.strategy,
      problem,
      dryRun: true,
    };
  }

  // Mark task as started
  startTask(db, taskId);

  const t0 = Date.now();
  let result = null;
  let error = null;

  try {
    switch (mapping.engine) {
      case 'tree-search': {
        if (!_api || !_api.treeSearch) throw new Error('treeSearch API not available');
        const tsResult = await _api.treeSearch({
          problem,
          project: proj,
          strategy: mapping.strategy || 'auto',
        });
        result = tsResult.solution
          ? (typeof tsResult.solution === 'string' ? tsResult.solution : JSON.stringify(tsResult.solution))
          : JSON.stringify({ nodesExplored: tsResult.nodesExplored, status: tsResult.status });
        break;
      }

      case 'self-consistency': {
        if (!_api || !_api.selfConsistency) throw new Error('selfConsistency API not available');
        const scResult = await _api.selfConsistency({
          problem,
          project: proj,
          samples: 5,
        });
        result = scResult.answer || JSON.stringify(scResult);
        break;
      }

      case 'budget-force': {
        if (!_api || !_api.budgetForce) throw new Error('budgetForce API not available');
        const bfResult = await _api.budgetForce({
          problem,
          project: proj,
          minTokens: 200,
          maxRounds: 3,
        });
        result = bfResult.answer || bfResult.finalResponse || JSON.stringify(bfResult);
        break;
      }

      case 'deterministic': {
        if (!_api || !_api.reasonAll) throw new Error('reasonAll API not available');
        const drResult = await _api.reasonAll(task.goal || problem, { project: proj });
        result = JSON.stringify(drResult.insights || drResult);
        break;
      }

      case 'synthesize': {
        // Orchestrator: collect all completed task results
        const allResults = synthesizeGoal(db, task.goal, { project: proj });
        result = JSON.stringify(allResults);
        break;
      }

      default:
        throw new Error(`Unknown engine: ${mapping.engine}`);
    }

    // Save result to brain if save function is available
    if (_saveFn && result) {
      try {
        await _saveFn({
          project: proj,
          type: 'observation',
          title: `swarm:${task.agent_role}:${task.goal ? task.goal.slice(0, 50) : 'task'}`,
          content: result,
          tags: ['swarm', task.agent_role, 'auto-capture'],
          importance: 6,
          provenance: 'inferred',
        });
      } catch { /* best-effort */ }
    }

    completeTask(db, taskId, result ? result.slice(0, 1000) : '(empty result)');
  } catch (err) {
    error = err.message;
    failTask(db, taskId, error);
  }

  const durationMs = Date.now() - t0;

  return {
    taskId,
    role: task.agent_role,
    goal: task.goal,
    engine: mapping.engine,
    result: result ? result.slice(0, 500) : null,
    error,
    durationMs,
  };
}

/**
 * Execute the entire pipeline for a goal — run all tasks in dependency order.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} goal
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @param {boolean} [opts.dryRun=false]
 * @returns {Promise<Array<Object>>} execution results for all tasks
 */
async function executePipeline(db, goal, opts = {}) {
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();

  // Get all tasks for this goal, ordered by creation
  const tasks = db.prepare(`
    SELECT * FROM swarm_tasks WHERE project_path = ? AND goal = ? ORDER BY created_at
  `).all(proj, goal);

  if (tasks.length === 0) return [];

  const results = [];
  for (const task of tasks) {
    // Only execute pending tasks
    if (task.status !== 'pending') {
      results.push({ taskId: task.id, role: task.agent_role, skipped: true, status: task.status });
      continue;
    }

    // Check dependencies before executing
    if (task.dependency_ids) {
      let deps = [];
      try { deps = JSON.parse(task.dependency_ids); } catch { /* empty */ }
      let allDone = true;
      for (const depId of deps) {
        const dep = db.prepare(`SELECT status FROM swarm_tasks WHERE id = ?`).get(depId);
        if (!dep || dep.status !== 'completed') { allDone = false; break; }
      }
      if (!allDone) {
        results.push({ taskId: task.id, role: task.agent_role, skipped: true, reason: 'dependencies not met' });
        continue;
      }
    }

    const execResult = await executeTask(db, task.id, { ...opts, project: proj });
    results.push(execResult);
  }

  return results;
}

// ─── Exports ──────────────────────────────────────────────────────────

module.exports = {
  PERSONAS,
  DEFAULT_PIPELINE,
  ROLE_STRATEGY,
  setApi,
  decomposeGoal,
  getNextTask,
  startTask,
  completeTask,
  failTask,
  getGoalTasks,
  getGoalProgress,
  listActiveGoals,
  synthesizeGoal,
  executeTask,
  executePipeline,
};