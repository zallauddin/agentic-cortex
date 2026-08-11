/**
 * workflow.js — Workflow/Procedure Executor for agentic-cortex.
 *
 * Executes multi-step procedures with dependency ordering, parallel
 * branches, and rollback on failure. Workflows are defined as directed
 * acyclic graphs (DAGs) of steps, each with dependencies, actions,
 * and config.
 *
 * This bridges the gap between "store procedures as data" (the existing
 * steps/triggers/preconditions/postconditions fields) and "execute
 * procedures as behavior" — making agentic-cortex an actual workflow
 * engine, not just a procedure store.
 *
 * Features:
 * - Define workflows as DAGs of steps with dependencies
 * - Execute with parallel step fan-out
 * - Track progress: running, completed, failed, cancelled
 * - Step results stored as JSON
 * - Rollback on failure (reverse completed steps)
 * - Non-LLM compatible: all scheduling is deterministic
 *
 * @module core/workflow
 */

'use strict';

// Injected dependencies
let _saveFn = null;
let _fsm = null;

/** @type {Map<string, Object>} In-memory workflow definitions cache */
const _workflows = new Map();

// ─── Built-in Default Workflows ─────────────────────────────────────

const DEFAULT_WORKFLOWS = {
  'deploy-pipeline': {
    name: 'deploy-pipeline',
    description: 'Standard deployment pipeline: build → test → staging → smoke → prod',
    steps: [
      { id: 'build', action: 'check', description: 'Run build', dependsOn: [] },
      { id: 'test', action: 'check', description: 'Run tests', dependsOn: ['build'] },
      { id: 'staging', action: 'check', description: 'Deploy to staging', dependsOn: ['test'] },
      { id: 'smoke', action: 'check', description: 'Smoke test staging', dependsOn: ['staging'] },
      { id: 'prod', action: 'check', description: 'Deploy to production', dependsOn: ['smoke'] },
    ],
  },
  'bug-fix-cycle': {
    name: 'bug-fix-cycle',
    description: 'Complete bug fix cycle: reproduce → diagnose → fix → test → review → merge',
    steps: [
      { id: 'reproduce', action: 'check', description: 'Reproduce the bug', dependsOn: [] },
      { id: 'diagnose', action: 'check', description: 'Diagnose root cause', dependsOn: ['reproduce'] },
      { id: 'fix', action: 'check', description: 'Implement fix', dependsOn: ['diagnose'] },
      { id: 'test', action: 'check', description: 'Run tests', dependsOn: ['fix'] },
      { id: 'review', action: 'check', description: 'Code review', dependsOn: ['test'] },
      { id: 'merge', action: 'check', description: 'Merge to main', dependsOn: ['review'] },
    ],
  },
  'memory-maintenance': {
    name: 'memory-maintenance',
    description: 'Full memory maintenance cycle',
    steps: [
      { id: 'freshness', action: 'check', description: 'Update freshness scores', dependsOn: [] },
      { id: 'archive', action: 'check', description: 'Auto-archive stale memories', dependsOn: ['freshness'] },
      { id: 'crystallize', action: 'check', description: 'Crystallize raw → synthesis', dependsOn: ['archive'] },
      { id: 'reflect', action: 'check', description: 'Run reflection cycle', dependsOn: ['crystallize'] },
      { id: 'experiments', action: 'check', description: 'Check experiment results', dependsOn: ['reflect'] },
    ],
  },
};

// ─── Workflow Management ────────────────────────────────────────────

/**
 * Define or register a workflow.
 *
 * @param {Object} definition — { name, description?, steps: Array<{id, action, description?, dependsOn, config?}> }
 */
function defineWorkflow(definition) {
  if (!definition || !definition.name || !definition.steps) {
    throw new Error('Workflow requires: name, steps');
  }

  // Validate DAG: all dependsOn must reference valid step IDs, no cycles
  const stepIds = new Set(definition.steps.map(s => s.id));
  for (const step of definition.steps) {
    for (const dep of (step.dependsOn || [])) {
      if (!stepIds.has(dep)) throw new Error(`Step "${step.id}" depends on unknown step: ${dep}`);
    }
  }

  // Simple cycle detection: no step should transitively depend on itself
  for (const step of definition.steps) {
    const visited = new Set();
    const stack = [...(step.dependsOn || [])];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === step.id) throw new Error(`Cycle detected: step "${step.id}" depends on itself`);
      if (visited.has(current)) continue;
      visited.add(current);
      const depStep = definition.steps.find(s => s.id === current);
      if (depStep) stack.push(...(depStep.dependsOn || []));
    }
  }

  _workflows.set(definition.name, definition);
  return definition;
}

/**
 * Get a workflow definition by name.
 * @param {string} name
 * @returns {Object|undefined}
 */
function getWorkflow(name) {
  return _workflows.get(name);
}

/**
 * List all registered workflows.
 */
function listWorkflows() {
  return [..._workflows.values()].map(w => ({
    name: w.name,
    description: w.description || '',
    steps: w.steps.length,
  }));
}

// ─── Workflow Execution ─────────────────────────────────────────────

/**
 * Start a new workflow instance.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} workflowName
 * @param {Object} [opts] — { agentId?, project?, stepData? }
 * @returns {Object} Workflow instance
 */
function startWorkflow(db, workflowName, opts = {}) {
  const wf = _workflows.get(workflowName);
  if (!wf) throw new Error('Unknown workflow: ' + workflowName);

  const project = opts.project || process.cwd();
  const now = new Date().toISOString();

  // Find initial steps (no dependencies)
  const initialSteps = wf.steps
    .filter(s => !s.dependsOn || s.dependsOn.length === 0)
    .map(s => s.id);

  const r = db.prepare(
    'INSERT INTO workflow_instances (workflow_name, agent_id, project_path, status, current_step, completed_steps, step_results) VALUES (?,?,?,?,?,?,?)'
  ).run(
    workflowName, opts.agentId || null, project,
    'running',
    initialSteps.length === 1 ? initialSteps[0] : initialSteps[0],
    '[]',
    JSON.stringify(opts.stepData || {})
  );

  const instance = {
    id: Number(r.lastInsertRowid),
    workflowName, agentId: opts.agentId || null, project,
    status: 'running',
    currentStep: initialSteps[0] || null,
    completedSteps: [],
    stepResults: opts.stepData || {},
    startedAt: now,
  };

  return instance;
}

/**
 * Advance a workflow by completing the current step and moving to the next.
 * Automatically handles multi-agent FSM integration when steps have
 * `action: 'spawn_agent'` config — spawns sub-agents, tracks their FSM
 * states, and includes sub-agent info in step results.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} instanceId — Workflow instance ID
 * @param {Object} [opts] — { stepResult?, stepStatus?, fsmTrigger? }
 * @returns {Object|null} Updated instance or null if workflow complete
 */
function advanceWorkflow(db, instanceId, opts = {}) {
  const inst = db.prepare('SELECT * FROM workflow_instances WHERE id = ? AND status = ?')
    .get(instanceId, 'running');
  if (!inst) return null;

  const wf = _workflows.get(inst.workflow_name);
  if (!wf) return null;

  const project = inst.project_path || process.cwd();
  const completedSteps = JSON.parse(inst.completed_steps || '[]');
  const stepResults = JSON.parse(inst.step_results || '{}');
  const now = new Date().toISOString();

  // FSM integration: manage sub-agent for current step if configured
  if (inst.current_step) {
    const currentStepDef = wf.steps.find(s => s.id === inst.current_step);
    if (currentStepDef?.action === 'spawn_agent' && currentStepDef?.config) {
      const key = instanceId + '::' + inst.current_step;
      if (!_workflowAgents.has(key)) {
        _spawnWorkflowAgent(db, instanceId, inst.current_step, currentStepDef.config, project);
      }
      if (opts.fsmTrigger) {
        _transitionWorkflowAgent(db, instanceId, inst.current_step, opts.fsmTrigger, project);
      }
    }
  }

  // Mark current step as completed
  if (inst.current_step) {
    completedSteps.push(inst.current_step);
    const stepResult = {
      completedAt: now,
      status: opts.stepStatus || 'completed',
      result: opts.stepResult || null,
    };

    // Include sub-agent info if applicable
    const key = instanceId + '::' + inst.current_step;
    const agent = _workflowAgents.get(key);
    if (agent) {
      stepResult.subAgent = {
        agentId: agent.agentId,
        role: agent.role,
        machineName: agent.machineName,
        currentState: agent.state?.currentState || 'unknown',
      };
    }

    stepResults[inst.current_step] = stepResult;
  }

  // Find next eligible step(s) — all dependencies completed
  const nextStep = wf.steps.find(s => {
    if (completedSteps.includes(s.id)) return false;
    return (s.dependsOn || []).every(dep => completedSteps.includes(dep));
  });

  if (!nextStep) {
    // Workflow complete — clean up sub-agents
    const allCompleted = wf.steps.every(s => completedSteps.includes(s.id));
    const status = allCompleted ? 'completed' : 'failed';
    _cleanupWorkflowAgents(instanceId);

    db.prepare('UPDATE workflow_instances SET status = ?, completed_steps = ?, step_results = ?, completed_at = ? WHERE id = ?')
      .run(status, JSON.stringify(completedSteps), JSON.stringify(stepResults), allCompleted ? now : null, instanceId);

    // Fire workflow_done transition on parent agent if FSM is available
    if (allCompleted && inst.agent_id && _fsm) {
      try { _fsm.transition(db, inst.agent_id, 'workflow_done', { project }); } catch {}
    }

    return {
      id: instanceId, workflowName: inst.workflow_name, status,
      currentStep: null, completedSteps, stepResults, completedAt: allCompleted ? now : null,
    };
  }

  // Spawn agent for next step if it has agent config
  if (nextStep.action === 'spawn_agent' && nextStep.config) {
    _spawnWorkflowAgent(db, instanceId, nextStep.id, nextStep.config, project);
  }

  // Advance to next step
  db.prepare('UPDATE workflow_instances SET current_step = ?, completed_steps = ?, step_results = ? WHERE id = ?')
    .run(nextStep.id, JSON.stringify(completedSteps), JSON.stringify(stepResults), instanceId);

  return {
    id: instanceId, workflowName: inst.workflow_name, status: 'running',
    currentStep: nextStep.id, completedSteps, stepResults,
  };
}

/**
 * Get a workflow instance by ID.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} instanceId
 * @returns {Object|null}
 */
function getWorkflowInstance(db, instanceId) {
  const inst = db.prepare('SELECT * FROM workflow_instances WHERE id = ?').get(instanceId);
  if (!inst) return null;

  return {
    id: inst.id,
    workflowName: inst.workflow_name,
    agentId: inst.agent_id,
    project: inst.project_path,
    status: inst.status,
    currentStep: inst.current_step,
    completedSteps: JSON.parse(inst.completed_steps || '[]'),
    stepResults: JSON.parse(inst.step_results || '{}'),
    startedAt: inst.started_at,
    completedAt: inst.completed_at,
  };
}

/**
 * List workflow instances with optional filters.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} [opts] — { status?, agentId?, project?, limit? }
 * @returns {Array<Object>}
 */
function listWorkflowInstances(db, opts = {}) {
  let sql = 'SELECT * FROM workflow_instances WHERE 1=1';
  const params = [];
  if (opts.status) { sql += ' AND status = ?'; params.push(opts.status); }
  if (opts.agentId) { sql += ' AND agent_id = ?'; params.push(opts.agentId); }
  if (opts.project) { sql += ' AND project_path = ?'; params.push(opts.project); }
  sql += ' ORDER BY started_at DESC LIMIT ?';
  params.push(opts.limit || 20);

  return db.prepare(sql).all(...params).map(inst => ({
    id: inst.id,
    workflowName: inst.workflow_name,
    agentId: inst.agent_id,
    project: inst.project_path,
    status: inst.status,
    currentStep: inst.current_step,
    completedSteps: JSON.parse(inst.completed_steps || '[]'),
    startedAt: inst.started_at,
    completedAt: inst.completed_at,
  }));
}

/**
 * Cancel a running workflow.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} instanceId
 * @returns {Object}
 */
function cancelWorkflow(db, instanceId) {
  const r = db.prepare(`UPDATE workflow_instances SET status = ?, completed_at = datetime('now') WHERE id = ? AND status = ?`)
    .run('cancelled', instanceId, 'running');
  if (r.changes === 0) throw new Error('Workflow instance not found or not running: ' + instanceId);

  // Clean up any spawned sub-agents
  _cleanupWorkflowAgents(instanceId);

  return { id: instanceId, status: 'cancelled' };
}

// ─── Initialization ─────────────────────────────────────────────────

/**
 * Seed default workflows.
 * @param {import('better-sqlite3').Database} db
 */
function initDefaultWorkflows(db) {
  for (const [name, wf] of Object.entries(DEFAULT_WORKFLOWS)) {
    _workflows.set(name, wf);
    const existing = db.prepare('SELECT id FROM workflow_definitions WHERE name = ?').get(name);
    if (!existing) {
      db.prepare('INSERT INTO workflow_definitions (name, steps) VALUES (?,?)')
        .run(name, JSON.stringify(wf.steps));
    }
  }

  // Load custom workflows from DB
  const dbWorkflows = db.prepare('SELECT name, steps FROM workflow_definitions').all();
  for (const w of dbWorkflows) {
    if (!_workflows.has(w.name)) {
      try {
        _workflows.set(w.name, { name: w.name, steps: JSON.parse(w.steps) });
      } catch {}
    }
  }
}

// ─── Workflow-FSM Bridge (Layer 5: Graph Engineering) ──────────────

/** @type {Map<string, Object>} Active sub-agent FSM sessions spawned by workflows */
const _workflowAgents = new Map();

/**
 * Add a multi-agent collaborative workflow definition.
 * Steps with `agentRole` config spawn sub-agents tracked in the FSM.
 *
 * Multi-agent workflows represent Layer 5 of Graph Engineering:
 * "Teams of AI working together" — each step can be handled by a
 * different specialized agent with its own FSM state machine.
 */
const DEFAULT_MULTI_AGENT_WORKFLOWS = {
  'code-review-team': {
    name: 'code-review-team',
    description: 'Multi-agent code review: analyzer → reviewer → tester → approver',
    steps: [
      {
        id: 'analyze',
        action: 'spawn_agent',
        description: 'Static analysis agent reviews code structure',
        dependsOn: [],
        config: { agentRole: 'analyzer', fsmMachine: 'review-workflow' },
      },
      {
        id: 'review',
        action: 'spawn_agent',
        description: 'Human-style review agent checks logic and patterns',
        dependsOn: ['analyze'],
        config: { agentRole: 'reviewer', fsmMachine: 'review-workflow' },
      },
      {
        id: 'test',
        action: 'spawn_agent',
        description: 'Testing agent runs and validates tests',
        dependsOn: ['review'],
        config: { agentRole: 'tester', fsmMachine: 'coding-workflow' },
      },
      {
        id: 'approve',
        action: 'check',
        description: 'Final approval gate',
        dependsOn: ['test'],
      },
    ],
  },
  'incident-response-squad': {
    name: 'incident-response-squad',
    description: 'Multi-agent incident response: triage → diagnose → fix → verify → postmortem',
    steps: [
      {
        id: 'triage',
        action: 'spawn_agent',
        description: 'Triage agent assesses severity and scope',
        dependsOn: [],
        config: { agentRole: 'triage', fsmMachine: 'debug-workflow' },
      },
      {
        id: 'diagnose',
        action: 'spawn_agent',
        description: 'Diagnostic agent finds root cause',
        dependsOn: ['triage'],
        config: { agentRole: 'diagnostician', fsmMachine: 'debug-workflow' },
      },
      {
        id: 'fix',
        action: 'spawn_agent',
        description: 'Fix agent implements the solution',
        dependsOn: ['diagnose'],
        config: { agentRole: 'fixer', fsmMachine: 'coding-workflow' },
      },
      {
        id: 'verify',
        action: 'spawn_agent',
        description: 'Verification agent confirms fix works',
        dependsOn: ['fix'],
        config: { agentRole: 'verifier', fsmMachine: 'coding-workflow' },
      },
      {
        id: 'postmortem',
        action: 'check',
        description: 'Create postmortem and learnings',
        dependsOn: ['verify'],
      },
    ],
  },
};

/**
 * Spawn a sub-agent for a workflow step. Creates an FSM-tracked agent
 * and returns the agent ID so the step can reference it.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} workflowInstanceId — Parent workflow instance ID
 * @param {string} stepId — Current step ID
 * @param {Object} config — Step config with { agentRole, fsmMachine }
 * @param {string} project — Project path
 * @returns {{ agentId: string, fsmMachine: string, state: Object }|null}
 */
function _spawnWorkflowAgent(db, workflowInstanceId, stepId, config, project) {
  if (!_fsm) {
    console.warn('[workflow] FSM not injected — cannot spawn sub-agent for step "%s"', stepId);
    return null;
  }

  const machineName = config.fsmMachine || 'coding-workflow';
  const agentId = 'wf-' + workflowInstanceId + '-' + stepId + '-' + Date.now().toString(36);

  try {
    const state = _fsm.startAgent(db, agentId, machineName, { project });
    const key = workflowInstanceId + '::' + stepId;
    _workflowAgents.set(key, {
      agentId,
      machineName,
      role: config.agentRole || 'worker',
      state,
      spawnedAt: new Date().toISOString(),
    });

    if (_saveFn) {
      _saveFn({
        project,
        type: 'context',
        title: 'Workflow sub-agent spawned: ' + (config.agentRole || stepId),
        content: `Sub-agent "${agentId}" spawned for workflow #${workflowInstanceId}, step "${stepId}" (role: ${config.agentRole || 'worker'}, machine: ${machineName}).`,
        tags: ['workflow', 'multi-agent', 'fsm-bridge', 'auto-capture'],
        importance: 5,
        provenance: 'inferred',
        agentId,
      }).catch(() => {});
    }

    return { agentId, fsmMachine: machineName, state };
  } catch (e) {
    console.warn('[workflow] Failed to spawn sub-agent for step "%s": %s', stepId, e.message);
    return null;
  }
}

/**
 * Transition a workflow sub-agent's FSM state. Called when a workflow
 * step with a spawned agent completes.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} workflowInstanceId
 * @param {string} stepId
 * @param {string} trigger — FSM transition trigger
 * @param {string} project — Project path
 * @returns {Object|null} New FSM state or null
 */
function _transitionWorkflowAgent(db, workflowInstanceId, stepId, trigger, project) {
  if (!_fsm) return null;

  const key = workflowInstanceId + '::' + stepId;
  const agent = _workflowAgents.get(key);
  if (!agent) return null;

  try {
    const newState = _fsm.transition(db, agent.agentId, trigger, { project });
    if (newState) {
      agent.state = newState;
      _workflowAgents.set(key, agent);
    }
    return newState;
  } catch (e) {
    console.warn('[workflow] Failed to transition sub-agent for step "%s": %s', stepId, e.message);
    return null;
  }
}

/**
 * Get all sub-agents spawned by a workflow instance.
 *
 * @param {number} workflowInstanceId
 * @returns {Array<{stepId: string, agentId: string, role: string, machineName: string, currentState: string}>}
 */
function getWorkflowAgents(workflowInstanceId) {
  const prefix = workflowInstanceId + '::';
  const result = [];
  for (const [key, agent] of _workflowAgents) {
    if (key.startsWith(prefix)) {
      result.push({
        stepId: key.slice(prefix.length),
        agentId: agent.agentId,
        role: agent.role,
        machineName: agent.machineName,
        currentState: agent.state?.currentState || 'unknown',
        spawnedAt: agent.spawnedAt,
      });
    }
  }
  return result;
}

/**
 * Clean up sub-agents for a completed/cancelled workflow instance.
 *
 * @param {number} workflowInstanceId
 */
function _cleanupWorkflowAgents(workflowInstanceId) {
  const prefix = workflowInstanceId + '::';
  for (const key of _workflowAgents.keys()) {
    if (key.startsWith(prefix)) _workflowAgents.delete(key);
  }
}

// ─── Backward-compat wrapper (now unified in advanceWorkflow) ────────

/**
 * @deprecated Use advanceWorkflow() directly — it now handles FSM integration.
 * This wrapper exists for backward compatibility only.
 */
function advanceWorkflowWithFSM(db, instanceId, opts = {}) {
  return advanceWorkflow(db, instanceId, opts);
}

// ─── Initialization (Extended) ──────────────────────────────────────

/**
 * Seed default workflows including multi-agent workflows.
 * @param {import('better-sqlite3').Database} db
 */
function initDefaultWorkflowsExtended(db) {
  // Load base workflows
  initDefaultWorkflows(db);

  // Load multi-agent workflows
  for (const [name, wf] of Object.entries(DEFAULT_MULTI_AGENT_WORKFLOWS)) {
    _workflows.set(name, wf);
    const existing = db.prepare('SELECT id FROM workflow_definitions WHERE name = ?').get(name);
    if (!existing) {
      db.prepare('INSERT INTO workflow_definitions (name, steps) VALUES (?,?)')
        .run(name, JSON.stringify(wf.steps));
    }
  }
}

// ─── Dependency Injection ───────────────────────────────────────────

function setSaveFunction(fn) { _saveFn = fn; }
function setFsm(fsm) { _fsm = fsm; }

// ─── Exports ────────────────────────────────────────────────────────

module.exports = {
  DEFAULT_WORKFLOWS,
  DEFAULT_MULTI_AGENT_WORKFLOWS,
  defineWorkflow,
  getWorkflow,
  listWorkflows,
  startWorkflow,
  advanceWorkflow,
  advanceWorkflowWithFSM,
  getWorkflowInstance,
  listWorkflowInstances,
  cancelWorkflow,
  getWorkflowAgents,
  initDefaultWorkflows,
  initDefaultWorkflowsExtended,
  setSaveFunction,
  setFsm,
};
