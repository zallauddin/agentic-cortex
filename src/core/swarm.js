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

const { classifyFailure, recordFailure } = require('./failure-classifier');
const worker = require('./worker');

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

// ─── Retry / replan / escalation policy ──────────────────────────────

/**
 * Failure-loop policy for swarm tasks.
 *
 * - Transient failures (network, timeout, other) are retried with exponential
 *   backoff up to `maxRetries`.
 * - Deterministic failures (auth, parse, config/engine wiring, element) fail
 *   immediately — retrying would only repeat the same mistake.
 * - After retries are exhausted, the failed task and its not-yet-completed
 *   transitive dependents are re-decomposed (replanned) as a fresh attempt.
 * - Once the attempt budget (`1 + maxReplans`) is spent, the task is
 *   escalated to the war room: a high-importance error memory + a failure
 *   lesson (probe-gated) so future swarms don't blindly retry.
 */
const RETRY_POLICY = {
  maxRetries: 2,      // retries per attempt
  maxReplans: 1,      // additional attempts after the original
  baseDelayMs: 5000,  // first retry delay
  backoffFactor: 2,   // 5s → 10s → 20s …
  maxDelayMs: 60000,  // backoff ceiling
};

/** Default worker-pool size for the parallel swarm executor. */
const DEFAULT_CONCURRENCY = 4;

/** Job queue statuses (swarm_jobs.status). */
const JOB_STATUSES = new Set(['queued', 'running', 'paused', 'completed', 'failed', 'canceled']);

/** Failure kinds that are safe to retry — the underlying cause is transient. */
const RETRYABLE_KINDS = new Set(['network', 'timeout', 'other']);

/** Failure kinds that mean the task itself (or its wiring) is wrong. */
const NON_RETRYABLE_KINDS = new Set(['auth', 'parse', 'element', 'config']);

const ENGINE_ERROR_RE = /(API not available|No strategy mapping|Unknown engine|not available|not wired|requires .* API)/i;

/**
 * Merge caller overrides into the default retry policy.
 */
function _retryPolicy(opts = {}) {
  return { ...RETRY_POLICY, ...(opts.retryPolicy || {}) };
}

/**
 * Exponential backoff with ±20% jitter for a retry number (1-based).
 */
function _backoffMs(retryNumber, policy) {
  const raw = Math.min(policy.baseDelayMs * Math.pow(policy.backoffFactor, retryNumber - 1), policy.maxDelayMs);
  return Math.max(1, Math.round(raw * (0.8 + Math.random() * 0.4)));
}

/**
 * Classify a swarm task failure: reuse the deterministic failure-classifier
 * and map the family to a retry decision.
 *
 * @param {string} reason — error message
 * @returns {{ kind: string, target: string, suggestion: string, retryable: boolean }}
 */
function classifyTaskFailure(reason) {
  const msg = reason || '';
  if (ENGINE_ERROR_RE.test(msg)) {
    return { kind: 'config', target: '', suggestion: 'the task executor is not wired to a reasoning engine — check the harness/API wiring', retryable: false };
  }
  const { kind, target, suggestion } = classifyFailure(msg);
  return { kind, target, suggestion, retryable: RETRYABLE_KINDS.has(kind) };
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a task should be executed by a real worker subprocess (opt-in).
 *
 * Enabled by opts.workerMode='process' (or the AGENTIC_CORTEX_WORKER env
 * being set), and optionally restricted to specific roles via
 * opts.workerRoles (e.g. ['coder', 'tester']). When enabled but no worker
 * resolves, execution falls back to the in-process reasoning engine.
 */
function _shouldUseWorker(opts = {}, task) {
  if (worker.workerMode(opts) !== 'process') return false;
  const roles = opts.workerRoles;
  if (Array.isArray(roles) && roles.length > 0) {
    return roles.includes(task.agent_role);
  }
  return true;
}

/**
 * Build the instruction sent to a real worker subprocess: a role-specific
 * real-action preamble (edit files / run tests) + shared-brain context +
 * the persona problem, plus the compose-wiring's MCP tool list if any.
 */
function _buildWorkerProblem(task, goal, context, proj, spec) {
  const role = task.agent_role;
  const roleGuidance = {
    analyzer: 'Inspect the ACTUAL repository (files, modules, existing tests) and produce structured findings about what already exists and what is missing. Cite real files.',
    planner: 'Produce an ordered implementation plan grounded in the ACTUAL repository layout. Reference real files/modules where the work will land.',
    coder: 'EDIT REAL FILES: implement the planned changes in the repository, then run the relevant tests/build to confirm. Report exactly which files you changed and the test results.',
    tester: 'RUN TESTS: write or select tests for the implementation and execute them (e.g. npm test / node --test). Report which tests ran and their pass/fail status.',
    reviewer: 'Review the ACTUAL changed files against the shared standards and prior failures. Report findings with file/line references.',
    verifier: 'Verify the completed work end-to-end in the repository: build, run tests, check the acceptance criteria. Report concrete pass/fail evidence.',
    reasoner: 'Run deterministic inference over the shared brain context to produce new insights.',
    orchestrator: 'Collect and synthesize the completed results into a final answer.',
  };
  const guidance = roleGuidance[role] || 'Complete the task for real in the repository.';
  const tools = spec && spec.plan && spec.plan.wiring && Array.isArray(spec.plan.wiring.memoryTools)
    ? spec.plan.wiring.memoryTools
    : [];
  const base = _buildProblem(task, goal, context);
  return [
    `You are the ${role.toUpperCase()} persona of a swarm, operating as a REAL agent on the repository at: ${proj}`,
    'You have tool access for file editing, shell, and test running. Perform the work for real — do not just describe it.',
    guidance,
    tools.length ? `Shared-brain (agentic-cortex) MCP tools available to you if wired: ${tools.join(', ')}` : null,
    '',
    base,
  ].filter(Boolean).join('\n');
}

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
  const now = new Date().toISOString();
  const rows = db.prepare(`
    SELECT * FROM swarm_tasks
    WHERE project_path = ? AND agent_role = ? AND status = 'pending' AND escalated = 0
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
    ORDER BY priority DESC, created_at ASC
  `).all(proj, role, now);

  for (const task of rows) {
    if (_depsMet(db, task)) return task;
  }

  return null;
}

/**
 * Parse the dependency_ids JSON column.
 */
function _parseDeps(task) {
  try { return JSON.parse(task.dependency_ids || '[]'); } catch { return []; }
}

/**
 * True when every dependency of the task is completed (live DB read).
 */
function _depsMet(db, task) {
  const deps = _parseDeps(task);
  if (deps.length === 0) return true;
  return deps.every(depId => {
    const dep = db.prepare(`SELECT status FROM swarm_tasks WHERE id = ?`).get(depId);
    return dep && dep.status === 'completed';
  });
}

/**
 * All tasks for a goal in pipeline (creation) order.
 */
function _pipelineOrder(db, proj, goal) {
  return db.prepare(
    `SELECT * FROM swarm_tasks WHERE project_path = ? AND goal = ? ORDER BY created_at, id`
  ).all(proj, goal);
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
 * Mark a task as failed — with the failure loop built in.
 *
 * The failure is classified, and unless the failure is permanent
 * (human-initiated) or deterministic (auth/parse/config), the task is
 * scheduled for retry with exponential backoff instead of failing outright.
 * When retries are exhausted the task goes to 'failed'; the replan pass
 * (replanSubgraph / replanGoal) then re-decomposes its subgraph.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} taskId
 * @param {string} reason — why it failed
 * @param {Object} [opts]
 * @param {boolean} [opts.permanent=false] — human/operator-initiated failure: no auto-retry
 * @param {Object} [opts.retryPolicy] — override RETRY_POLICY fields
 * @returns {Object} outcome summary
 */
function failTask(db, taskId, reason, opts = {}) {
  const task = db.prepare(`SELECT * FROM swarm_tasks WHERE id = ?`).get(taskId);
  if (!task) throw new Error(`Swarm task not found: ${taskId}`);

  const policy = _retryPolicy(opts);
  const { kind, suggestion } = classifyTaskFailure(reason || '');
  const retryable = !opts.permanent && !NON_RETRYABLE_KINDS.has(kind) && (task.retry_count || 0) < policy.maxRetries;
  const now = new Date();

  if (retryable) {
    const retryCount = (task.retry_count || 0) + 1;
    const delayMs = _backoffMs(retryCount, policy);
    const nextRetryAt = new Date(now.getTime() + delayMs).toISOString();
    db.prepare(`
      UPDATE swarm_tasks SET
        status = 'pending',
        retry_count = ?,
        last_error = ?,
        failure_class = ?,
        failure_suggestion = ?,
        next_retry_at = ?,
        result_summary = NULL,
        completed_at = NULL
      WHERE id = ?
    `).run(retryCount, (reason || '').slice(0, 2000), kind, suggestion, nextRetryAt, taskId);
    return {
      taskId,
      goal: task.goal,
      role: task.agent_role,
      status: 'pending',
      retryScheduled: true,
      retryCount,
      maxRetries: policy.maxRetries,
      failureClass: kind,
      failureSuggestion: suggestion,
      lastError: reason || '',
      nextRetryAt,
      retryInMs: delayMs,
    };
  }

  db.prepare(`
    UPDATE swarm_tasks SET status = 'failed', result_summary = ?,
      last_error = ?, failure_class = ?, failure_suggestion = ?,
      next_retry_at = NULL, completed_at = ?
    WHERE id = ?
  `).run((reason || '').slice(0, 1000), (reason || '').slice(0, 2000), kind, suggestion, now.toISOString(), taskId);

  return {
    taskId,
    goal: task.goal,
    role: task.agent_role,
    status: 'failed',
    retryScheduled: false,
    retryCount: task.retry_count || 0,
    maxRetries: policy.maxRetries,
    failureClass: kind,
    failureSuggestion: suggestion,
    lastError: reason || '',
  };
}

/**
 * Force a retry now — clears any backoff window so the task is pickable again.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} taskId
 * @returns {Object|null} the refreshed task row
 */
function retryNow(db, taskId) {
  const task = db.prepare(`SELECT * FROM swarm_tasks WHERE id = ?`).get(taskId);
  if (!task) return null;
  db.prepare(`UPDATE swarm_tasks SET next_retry_at = NULL WHERE id = ?`).run(taskId);
  return db.prepare(`SELECT * FROM swarm_tasks WHERE id = ?`).get(taskId);
}

/**
 * Escalate a permanently failed task to the war room.
 *
 * Records a high-importance error memory (with a zero-LLM war-room self-check
 * attached for supervisor context) and a probe-gated failure lesson so future
 * swarms won't blindly retry the same underlying condition.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} taskId
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @returns {Promise<Object|null>} escalation payload
 */
async function escalateTask(db, taskId, opts = {}) {
  const task = db.prepare(`SELECT * FROM swarm_tasks WHERE id = ?`).get(taskId);
  if (!task) return null;
  const proj = task.project_path || opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();

  const now = new Date().toISOString();
  db.prepare(`UPDATE swarm_tasks SET escalated = 1, completed_at = COALESCE(completed_at, ?) WHERE id = ?`).run(now, taskId);

  // War-room self-check: lightweight reasoning health diagnostics (zero LLM).
  let warRoom = null;
  if (_api && _api.warRoomSelfCheck) {
    try {
      const check = _api.warRoomSelfCheck({ project: proj, maxScenarios: 3 });
      warRoom = check && check.diagnostics
        ? {
            avgScore: check.diagnostics.avgScore,
            strengths: check.diagnostics.strengths,
            weaknesses: check.diagnostics.weaknesses,
          }
        : null;
    } catch { /* non-fatal */ }
  }

  const payload = {
    taskId,
    goal: task.goal,
    role: task.agent_role,
    failureClass: task.failure_class || null,
    failureSuggestion: task.failure_suggestion || null,
    lastError: task.last_error || null,
    attempt: task.attempt || 1,
    retryCount: task.retry_count || 0,
    escalatedAt: now,
    warRoom,
  };

  if (_saveFn) {
    try {
      await _saveFn({
        project: proj,
        type: 'error',
        title: `swarm-escalation:${task.agent_role}:${(task.goal || 'task').slice(0, 50)}`,
        content: JSON.stringify(payload, null, 2),
        tags: ['swarm', 'escalation', task.agent_role, task.failure_class || 'unknown'],
        importance: 10,
        provenance: 'inferred',
      });
    } catch { /* non-fatal */ }
  }

  // Probe-gated failure lesson: future swarms only retry once the condition clears.
  try {
    recordFailure(db, {
      commandKey: `swarm:${task.agent_role}:${(task.goal || 'task').slice(0, 60)}`,
      errorText: task.last_error || task.result_summary || '',
      project: proj,
      suggestion: task.failure_suggestion || undefined,
    });
  } catch { /* non-fatal */ }

  return payload;
}

/**
 * Re-decompose the subgraph of a permanently failed task.
 *
 * The failed task plus every not-yet-completed transitive dependent is
 * replaced by a fresh pending task (new attempt, same role, dependency ids
 * remapped through the replacements). Originals are marked 'stale' so they
 * are never picked up again; completed dependents keep their valid results.
 *
 * Attempts are capped at 1 + maxReplans — beyond that, escalation kicks in.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} taskId
 * @param {Object} [opts]
 * @param {Object} [opts.retryPolicy]
 * @returns {Promise<Array<Object>>} created replacement tasks
 */
async function replanSubgraph(db, taskId, opts = {}) {
  const task = db.prepare(`SELECT * FROM swarm_tasks WHERE id = ?`).get(taskId);
  if (!task || task.status !== 'failed') return [];

  const proj = task.project_path;
  const goal = task.goal;
  const rootId = task.retry_of || task.id;
  const policy = _retryPolicy(opts);
  const maxAttempt = policy.maxReplans + 1;

  // Already replanned? Don't duplicate.
  const pendingReplacement = db.prepare(
    `SELECT id FROM swarm_tasks WHERE retry_of = ? AND status = 'pending' LIMIT 1`
  ).get(rootId);
  if (pendingReplacement) return [];

  // Attempt budget for the root chain (original + all replans).
  const chain = db.prepare(
    `SELECT MAX(attempt) as mx FROM swarm_tasks WHERE id = ? OR retry_of = ?`
  ).get(rootId, rootId);
  const rootAttempt = chain.mx || task.attempt || 1;
  if (rootAttempt >= maxAttempt) {
    await escalateTask(db, taskId, opts);
    return [];
  }

  // Collect the replacement set: failed task + non-completed transitive dependents.
  const order = _pipelineOrder(db, proj, goal);
  const replaceSet = new Set([taskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of order) {
      if (replaceSet.has(t.id)) continue;
      if (t.status === 'completed') continue;
      const deps = _parseDeps(t);
      if (deps.some(d => replaceSet.has(d))) { replaceSet.add(t.id); changed = true; }
    }
  }

  // Create replacements in pipeline order, remapping dependency ids.
  const idMap = new Map();
  const created = [];
  const newAttempt = rootAttempt + 1;
  for (const t of order) {
    if (!replaceSet.has(t.id)) continue;
    const newDeps = _parseDeps(t).map(d => (idMap.has(d) ? idMap.get(d) : d));
    const r = db.prepare(`
      INSERT INTO swarm_tasks (project_path, goal, parent_task_id, agent_role, status, priority, dependency_ids, attempt, retry_of, max_retries)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(proj, goal, rootId, t.agent_role, t.priority, JSON.stringify(newDeps), newAttempt, rootId, policy.maxRetries);
    idMap.set(t.id, r.lastInsertRowid);
    created.push({
      id: r.lastInsertRowid,
      role: t.agent_role,
      attempt: newAttempt,
      retryOf: rootId,
      dependencyIds: newDeps,
    });
  }

  const staleStmt = db.prepare(`UPDATE swarm_tasks SET status = 'stale' WHERE id = ?`);
  for (const t of order) {
    if (replaceSet.has(t.id)) staleStmt.run(t.id);
  }

  return created;
}

/**
 * Replan every permanently failed (non-escalated) task for a goal.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} goal
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @param {Object} [opts.retryPolicy]
 * @returns {Promise<Array<Object>>} created replacement tasks
 */
async function replanGoal(db, goal, opts = {}) {
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const failed = db.prepare(`
    SELECT * FROM swarm_tasks WHERE project_path = ? AND goal = ?
      AND status = 'failed' AND escalated = 0 ORDER BY created_at
  `).all(proj, goal);
  const created = [];
  for (const t of failed) {
    created.push(...(await replanSubgraph(db, t.id, opts)));
  }
  return created;
}

/**
 * List escalated swarm tasks for a goal (or all goals in the project).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} [goal]
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @returns {Array<Object>}
 */
function listEscalations(db, goal, opts = {}) {
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const rows = goal
    ? db.prepare(`SELECT * FROM swarm_tasks WHERE project_path = ? AND goal = ? AND escalated = 1 ORDER BY completed_at DESC`).all(proj, goal)
    : db.prepare(`SELECT * FROM swarm_tasks WHERE project_path = ? AND escalated = 1 ORDER BY completed_at DESC`).all(proj);
  return rows.map(r => ({
    taskId: r.id,
    goal: r.goal,
    role: r.agent_role,
    status: r.status,
    failureClass: r.failure_class,
    failureSuggestion: r.failure_suggestion,
    lastError: r.last_error,
    attempt: r.attempt,
    retryCount: r.retry_count,
    retryOf: r.retry_of,
    escalatedAt: r.completed_at,
  }));
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
    SELECT id, agent_role, status, result_summary, last_error, failure_class,
      retry_count, attempt, escalated FROM swarm_tasks
    WHERE project_path = ? AND goal = ? AND status IN ('completed', 'failed')
    ORDER BY completed_at
  `).all(proj, goal);

  const escalated = db.prepare(
    `SELECT COUNT(*) as c FROM swarm_tasks WHERE project_path = ? AND goal = ? AND escalated = 1`
  ).get(proj, goal).c;

  return { goal, ...counts, escalated, results };
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

  // Worker mode (opt-in): launch a real agent subprocess for this task
  // instead of the in-process reasoning engine. Falls back to the engine
  // when no worker resolves.
  const workerSpec = _shouldUseWorker(opts, task) ? worker.resolveWorker(opts) : null;

  if (opts.dryRun) {
    return {
      taskId,
      role: task.agent_role,
      goal: task.goal,
      engine: mapping.engine,
      strategy: mapping.strategy,
      problem,
      worker: workerSpec ? {
        framework: workerSpec.frameworkId,
        command: workerSpec.binary || workerSpec.command,
        args: workerSpec.argsPreview,
        cwd: workerSpec.cwd,
        timeoutMs: workerSpec.timeoutMs,
      } : null,
      dryRun: true,
    };
  }

  // Mark task as started (the worker pool pre-claims via claimTask, so
  // skipStart lets the pool own the transition).
  if (!opts.skipStart) startTask(db, taskId);

  const t0 = Date.now();
  let result = null;
  let error = null;
  let retry = null;
  let workerUsed = null;

  try {
    if (workerSpec) {
      // Real work: the worker subprocess edits files / runs tests in the project.
      const workerProblem = _buildWorkerProblem(task, task.goal || '', context, proj, workerSpec);
      const wr = await worker.runWorker(workerSpec, workerProblem, opts);
      workerUsed = {
        framework: workerSpec.frameworkId,
        command: workerSpec.binary || workerSpec.command,
        durationMs: wr.durationMs,
        timedOut: wr.timedOut,
        exitCode: wr.exitCode,
      };
      if (!wr.ok) throw new Error(wr.error || `worker failed (${workerSpec.frameworkId})`);
      result = wr.output || '(worker produced no output)';
    } else {
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
    // The failure loop: classify → retry with backoff → (eventually) replan.
    const outcome = failTask(db, taskId, error, opts);
    retry = outcome.retryScheduled
      ? { scheduled: true, retryCount: outcome.retryCount, nextRetryAt: outcome.nextRetryAt, retryInMs: outcome.retryInMs, failureClass: outcome.failureClass }
      : { scheduled: false, retryCount: outcome.retryCount, failureClass: outcome.failureClass };
  }

  const durationMs = Date.now() - t0;

  return {
    taskId,
    role: task.agent_role,
    goal: task.goal,
    engine: mapping.engine,
    result: result ? result.slice(0, 500) : null,
    error,
    retry,
    worker: workerUsed,
    durationMs,
  };
}

/**
 * Atomically claim a pending task for execution. Returns false if another
 * worker (possibly another process) already claimed it.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} taskId
 * @returns {boolean}
 */
function claimTask(db, taskId) {
  const r = db.prepare(`
    UPDATE swarm_tasks SET status = 'running', started_at = ?
    WHERE id = ? AND status = 'pending'
  `).run(new Date().toISOString(), taskId);
  return r.changes > 0;
}

/**
 * Reset tasks left 'running' by a previous (possibly crashed) run back to
 * 'pending' so the next job run can pick them up. This is what makes the
 * job queue survive restarts — all state lives in swarm_tasks.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} proj
 * @param {string} goal
 * @returns {number} number of recovered tasks
 */
function _recoverRunningTasks(db, proj, goal) {
  const r = db.prepare(`
    UPDATE swarm_tasks SET status = 'pending', started_at = NULL, next_retry_at = NULL
    WHERE project_path = ? AND goal = ? AND status = 'running'
  `).run(proj, goal);
  return r.changes;
}

/**
 * Run a batch of runnable tasks through a bounded worker pool.
 *
 * Workers atomically claim tasks (claimTask) so a task is never executed
 * twice even across processes; dependencies were already validated when the
 * batch was collected. Execution order is therefore non-deterministic — only
 * the DAG order is enforced (across rounds).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<Object>} tasks — pending task rows whose deps are met
 * @param {number} concurrency — max simultaneous executions
 * @param {Object} opts — forwarded to executeTask
 * @returns {Promise<Array<Object>>} execution results
 */
async function _runPool(db, tasks, concurrency, opts) {
  const results = [];
  let idx = 0;
  const n = Math.max(1, Math.min(concurrency, tasks.length));

  const worker = async () => {
    while (idx < tasks.length) {
      const task = tasks[idx++];
      // Dry runs must not mutate task state — executeTask short-circuits
      // before any engine call, so skip the claim entirely.
      if (!opts.dryRun && !claimTask(db, task.id)) continue; // claimed elsewhere
      try {
        const r = await executeTask(db, task.id, { ...opts, skipStart: true });
        results.push(r);
      } catch (err) {
        // executeTask should never throw synchronously, but guard anyway.
        results.push({ taskId: task.id, role: task.agent_role, goal: task.goal, error: err.message, retry: null, durationMs: 0 });
      }
    }
  };

  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

/**
 * Execute the entire pipeline for a goal — a closed, parallel failure loop.
 *
 * Round by round:
 *   1. Collect every pending task whose dependencies are met and whose
 *      backoff window has elapsed, then run them through a bounded worker
 *      pool (`concurrency`) — independent DAG branches execute concurrently.
 *   2. Permanently failed tasks are re-decomposed (replanGoal) into fresh
 *      attempts, capped by the attempt budget; past the cap they are escalated
 *      to the war room.
 *   3. If the only work left is in a backoff window and `waitRetries` is set,
 *      the loop waits (bounded by maxWaitMs) and continues.
 *
 * When `opts.jobId` is set, the loop checkpoints round progress into the
 * swarm_jobs row and stops early if the job was canceled.
 *
 * The loop terminates when a round makes no progress (stable state) or the
 * round budget is exhausted.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} goal
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @param {boolean} [opts.dryRun=false]
 * @param {number} [opts.concurrency=4] — worker-pool size (bounded parallelism)
 * @param {number} [opts.jobId] — swarm_jobs row to checkpoint/cancel against
 * @param {boolean} [opts.waitRetries=true] — wait out backoff windows within the run
 * @param {number} [opts.maxWaitMs=30000] — cap on total backoff waiting
 * @param {number} [opts.maxRounds] — round budget
 * @param {Object} [opts.retryPolicy] — override RETRY_POLICY fields
 * @returns {Promise<{ goal: string, results: Array<Object>, meta: Object }>}
 */
async function executePipeline(db, goal, opts = {}) {
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const policy = _retryPolicy(opts);
  const concurrency = Math.max(1, opts.concurrency || opts.maxConcurrency || DEFAULT_CONCURRENCY);
  // Round budget: every attempt needs (maxRetries + 1) executions plus a
  // backoff wait between retries and replan passes — and there are
  // (maxReplans + 1) attempts. Anything beyond that is a stalled loop.
  // Dry runs preview exactly one pass (tasks stay pending, so more rounds
  // would only repeat the same plans).
  const maxRounds = opts.dryRun ? 1 : (opts.maxRounds || Math.max(8, (policy.maxRetries + 1) * (policy.maxReplans + 1) * 2 + 4));
  const waitRetries = opts.waitRetries !== false;
  const maxWaitMs = opts.maxWaitMs || 30000;

  const results = [];
  let rounds = 0;
  let replanned = 0;
  let retryScheduled = 0;
  let completed = 0;
  let failed = 0;
  let totalWaitMs = 0;
  let canceled = false;

  while (rounds < maxRounds) {
    rounds++;
    let roundProgress = false;

    // Job checkpoint: honor cancellation and persist round progress so a
    // restarted supervisor can see where the run left off.
    if (opts.jobId) {
      const job = getJob(db, opts.jobId);
      if (!job) throw new Error(`Swarm job not found: ${opts.jobId}`);
      if (job.status === 'canceled') { canceled = true; break; }
      db.prepare(`UPDATE swarm_jobs SET round = ?, updated_at = ? WHERE id = ?`)
        .run(rounds, new Date().toISOString(), opts.jobId);
    }

    // Collect runnable tasks (deps met, backoff elapsed, not escalated).
    const nowIso = new Date().toISOString();
    const runnable = [];
    for (const task of _pipelineOrder(db, proj, goal)) {
      if (task.status !== 'pending' || task.escalated) continue;
      if (task.next_retry_at && task.next_retry_at > nowIso) continue; // backoff waiting
      if (!_depsMet(db, task)) continue;
      runnable.push(task);
    }

    if (runnable.length > 0) {
      const roundResults = await _runPool(db, runnable, concurrency, { ...opts, project: proj });
      for (const execResult of roundResults) {
        results.push(execResult);
        roundProgress = true;
        if (execResult.error) {
          if (execResult.retry && execResult.retry.scheduled) retryScheduled++;
          else failed++;
        } else {
          completed++;
        }
      }
    }

    // Replan pass: permanently failed tasks become fresh attempts (or escalate).
    const created = await replanGoal(db, goal, { ...opts, project: proj });
    if (created.length > 0) { replanned += created.length; roundProgress = true; }

    if (!roundProgress) {
      // Stable? Or just waiting on a backoff window?
      const waiting = db.prepare(`
        SELECT MIN(next_retry_at) as nxt FROM swarm_tasks
        WHERE project_path = ? AND goal = ? AND status = 'pending' AND escalated = 0
          AND next_retry_at IS NOT NULL AND next_retry_at > ?
      `).get(proj, goal, new Date().toISOString());
      if (waitRetries && waiting && waiting.nxt) {
        const waitMs = Math.max(1, Math.min(new Date(waiting.nxt).getTime() - Date.now(), maxWaitMs - totalWaitMs));
        if (waitMs > 0) {
          await _sleep(waitMs);
          totalWaitMs += waitMs;
          roundProgress = true;
        }
      }
      if (!roundProgress) break; // stable state reached
    }
  }

  const pendingNow = db.prepare(`
    SELECT COUNT(*) as c FROM swarm_tasks
    WHERE project_path = ? AND goal = ? AND status = 'pending' AND escalated = 0
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
  `).get(proj, goal, new Date().toISOString());
  const waitingBackoff = db.prepare(`
    SELECT COUNT(*) as c FROM swarm_tasks
    WHERE project_path = ? AND goal = ? AND status = 'pending' AND escalated = 0
      AND next_retry_at IS NOT NULL AND next_retry_at > ?
  `).get(proj, goal, new Date().toISOString());
  const escalatedCount = db.prepare(
    `SELECT COUNT(*) as c FROM swarm_tasks WHERE project_path = ? AND goal = ? AND escalated = 1`
  ).get(proj, goal).c;

  return {
    goal,
    results,
    meta: {
      rounds,
      executed: results.length,
      completed,
      failed,
      retryScheduled,
      replanned,
      escalated: escalatedCount,
      stillPending: pendingNow.c,
      waitingBackoff: waitingBackoff.c,
      backoffWaitMs: totalWaitMs,
      canceled,
    },
  };
}

// ─── Persistent job queue ─────────────────────────────────────────────

/**
 * Create (enqueue) a job for a goal. The job is 'queued' until runJob is
 * called — the queue survives restarts because it lives in SQLite.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} goal
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @param {number} [opts.concurrency]
 * @param {number} [opts.maxRounds]
 * @param {Object} [opts.retryPolicy]
 * @returns {Object} the created job row
 */
function createJob(db, goal, opts = {}) {
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const policy = _retryPolicy(opts);
  const total = db.prepare(
    `SELECT COUNT(*) as c FROM swarm_tasks WHERE project_path = ? AND goal = ?`
  ).get(proj, goal).c;
  const concurrency = Math.max(1, opts.concurrency || opts.maxConcurrency || DEFAULT_CONCURRENCY);
  const maxRounds = opts.maxRounds || Math.max(8, (policy.maxRetries + 1) * (policy.maxReplans + 1) * 2 + 4);
  const r = db.prepare(`
    INSERT INTO swarm_jobs (project_path, goal, status, round, max_rounds, concurrency, total_tasks)
    VALUES (?, ?, 'queued', 0, ?, ?, ?)
  `).run(proj, goal, maxRounds, concurrency, total);
  return getJob(db, r.lastInsertRowid);
}

/**
 * Get a job row.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} jobId
 * @returns {Object|null}
 */
function getJob(db, jobId) {
  return db.prepare(`SELECT * FROM swarm_jobs WHERE id = ?`).get(jobId) || null;
}

/**
 * List jobs, optionally filtered by project / status.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @param {string} [opts.status]
 * @param {number} [opts.limit=50]
 * @returns {Array<Object>}
 */
function listJobs(db, opts = {}) {
  let sql = `SELECT * FROM swarm_jobs WHERE 1=1`;
  const params = [];
  if (opts.project) { sql += ` AND project_path = ?`; params.push(opts.project); }
  if (opts.status) { sql += ` AND status = ?`; params.push(opts.status); }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(opts.limit || 50);
  return db.prepare(sql).all(...params);
}

/**
 * Cancel a job. A running job stops at the next round checkpoint.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} jobId
 * @returns {boolean} whether the job was canceled (false if already terminal)
 */
function cancelJob(db, jobId) {
  const now = new Date().toISOString();
  const r = db.prepare(`
    UPDATE swarm_jobs SET status = 'canceled', finished_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('queued', 'running', 'paused')
  `).run(now, now, jobId);
  return r.changes > 0;
}

/**
 * Run (or resume) a job.
 *
 * If the job was previously running — e.g. the process died mid-run — this
 * recovers any tasks left 'running', resets them to 'pending', and continues
 * from where the DAG left off. All progress lives in swarm_tasks/swarm_jobs,
 * so nothing is lost across restarts.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} jobId
 * @param {Object} [opts]
 * @param {Object} [opts.retryPolicy]
 * @param {boolean} [opts.waitRetries]
 * @param {number} [opts.maxWaitMs]
 * @returns {Promise<{ job: Object, meta: Object|null, recovered: number, error: string|null, skipped?: boolean }>}
 */
async function runJob(db, jobId, opts = {}) {
  const job = getJob(db, jobId);
  if (!job) throw new Error(`Swarm job not found: ${jobId}`);
  if (job.status === 'completed' || job.status === 'canceled') {
    return { job, meta: null, recovered: 0, error: null, skipped: true, reason: `job already ${job.status}` };
  }

  const now = new Date().toISOString();
  const claim = db.prepare(`
    UPDATE swarm_jobs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
    WHERE id = ?
  `).run(now, now, jobId);
  if (claim.changes === 0) {
    return { job: getJob(db, jobId), meta: null, recovered: 0, error: null, skipped: true, reason: 'job not runnable' };
  }

  // Survive restarts: reset tasks left 'running' by a previous attempt.
  const recovered = _recoverRunningTasks(db, job.project_path, job.goal);

  let meta = null;
  let error = null;
  let status = 'completed';
  try {
    const out = await executePipeline(db, job.goal, {
      project: job.project_path,
      concurrency: job.concurrency || opts.concurrency,
      maxRounds: job.max_rounds || opts.maxRounds,
      retryPolicy: opts.retryPolicy,
      waitRetries: opts.waitRetries,
      maxWaitMs: opts.maxWaitMs,
      jobId,
    });
    meta = out.meta;
    if (meta.canceled) status = 'canceled';
  } catch (err) {
    error = err.message;
    status = 'failed';
  }

  const doneAt = new Date().toISOString();
  db.prepare(`
    UPDATE swarm_jobs SET
      status = ?, round = ?, completed_tasks = ?, failed_tasks = ?,
      retried_tasks = ?, replanned_tasks = ?, escalated_tasks = ?,
      result_summary = ?, error = ?, finished_at = ?, updated_at = ?
    WHERE id = ?
  `).run(
    status,
    meta ? meta.rounds : job.round,
    meta ? meta.completed : 0,
    meta ? meta.failed : 0,
    meta ? meta.retryScheduled : 0,
    meta ? meta.replanned : 0,
    meta ? meta.escalated : 0,
    meta ? JSON.stringify(meta) : null,
    error,
    doneAt, doneAt, jobId
  );

  return { job: getJob(db, jobId), meta, recovered, error };
}

// ─── Exports ──────────────────────────────────────────────────────────

module.exports = {
  PERSONAS,
  DEFAULT_PIPELINE,
  ROLE_STRATEGY,
  RETRY_POLICY,
  RETRYABLE_KINDS,
  NON_RETRYABLE_KINDS,
  DEFAULT_CONCURRENCY,
  JOB_STATUSES,
  setApi,
  decomposeGoal,
  getNextTask,
  startTask,
  completeTask,
  failTask,
  retryNow,
  claimTask,
  replanSubgraph,
  replanGoal,
  escalateTask,
  listEscalations,
  classifyTaskFailure,
  getGoalTasks,
  getGoalProgress,
  listActiveGoals,
  synthesizeGoal,
  executeTask,
  executePipeline,
  createJob,
  getJob,
  listJobs,
  cancelJob,
  runJob,
};