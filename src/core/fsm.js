/**
 * fsm.js — Finite-State Machine engine for agentic-cortex.
 *
 * Provides the orchestration layer that transforms agentic-cortex from a
 * memory system into a full agent brain. Agents declare states, transitions,
 * and entry/exit actions. The FSM tracks per-agent state and fires rules
 * on state transitions.
 *
 * This is the "executive function" of the brain — it decides what to do
 * next based on where the agent is and what it knows.
 *
 * Features:
 * - Define state machines with states, transitions, guards, and actions
 * - Start agents in a machine and track their state
 * - Transition between states with guard conditions
 * - Entry/exit hooks per state
 * - Built-in default machines: coding-workflow, debug-workflow, review-workflow
 * - Non-LLM compatible: all transitions are deterministic
 *
 * @module core/fsm
 */

'use strict';

// Injected save function and rule engine (set by api/index.js)
let _saveFn = null;
let _ruleEngine = null;

/** @type {Map<string, Object>} In-memory machine definitions cache */
const _machines = new Map();

/** @type {Map<string, Object>} In-memory agent state cache (agentId::machineName → state) */
const _agentStates = new Map();

// ─── Built-in Default Machines ──────────────────────────────────────

const DEFAULT_MACHINES = {
  'coding-workflow': {
    name: 'coding-workflow',
    description: 'Standard coding workflow: plan → implement → test → review → done',
    initialState: 'planning',
    states: ['planning', 'implementing', 'testing', 'reviewing', 'done'],
    transitions: [
      { from: 'planning', to: 'implementing', trigger: 'plan_approved', description: 'Design is ready to code' },
      { from: 'implementing', to: 'testing', trigger: 'implementation_done', description: 'Code written, ready to test' },
      { from: 'testing', to: 'reviewing', trigger: 'tests_pass', description: 'All tests green' },
      { from: 'testing', to: 'implementing', trigger: 'tests_fail', description: 'Tests failed, back to code' },
      { from: 'reviewing', to: 'implementing', trigger: 'changes_requested', description: 'Review found issues' },
      { from: 'reviewing', to: 'done', trigger: 'review_approved', description: 'PR approved and merged' },
      { from: 'implementing', to: 'planning', trigger: 'requirements_changed', description: 'Need to rethink approach' },
      { from: 'testing', to: 'planning', trigger: 'architecture_issue', description: 'Major rethink needed' },
    ],
    onEnter: {
      planning: { action: 'inject_phase_context', params: { phase: 'planning' } },
      implementing: { action: 'inject_phase_context', params: { phase: 'implementation' } },
      testing: { action: 'inject_phase_context', params: { phase: 'review' } },
      reviewing: { action: 'inject_phase_context', params: { phase: 'review' } },
      done: { action: 'run_maintenance', params: {} },
    },
  },

  'debug-workflow': {
    name: 'debug-workflow',
    description: 'Bug fixing workflow: reproduce → diagnose → fix → verify → close',
    initialState: 'reproducing',
    states: ['reproducing', 'diagnosing', 'fixing', 'verifying', 'closed'],
    transitions: [
      { from: 'reproducing', to: 'diagnosing', trigger: 'bug_reproduced', description: 'Have a reliable reproduction' },
      { from: 'diagnosing', to: 'fixing', trigger: 'root_cause_found', description: 'Root cause identified' },
      { from: 'fixing', to: 'verifying', trigger: 'fix_applied', description: 'Fix implemented' },
      { from: 'verifying', to: 'closed', trigger: 'fix_verified', description: 'Fix confirmed working' },
      { from: 'verifying', to: 'fixing', trigger: 'fix_failed', description: 'Fix did not work' },
      { from: 'diagnosing', to: 'reproducing', trigger: 'need_better_repro', description: 'Need clearer reproduction' },
      { from: 'fixing', to: 'diagnosing', trigger: 'wrong_root_cause', description: 'Root cause was wrong' },
    ],
    onEnter: {
      reproducing: { action: 'save_context', params: { type: 'context', note: 'Reproducing bug' } },
      fixing: { action: 'spawn_experiment_if_recurring', params: {} },
      closed: { action: 'save_learning', params: { type: 'learning', note: 'Bug fix learning' } },
    },
  },

  'review-workflow': {
    name: 'review-workflow',
    description: 'Code review workflow: read → analyze → comment → approve → merge',
    initialState: 'reading',
    states: ['reading', 'analyzing', 'commenting', 'approving', 'merged'],
    transitions: [
      { from: 'reading', to: 'analyzing', trigger: 'code_read', description: 'Understood the changes' },
      { from: 'analyzing', to: 'commenting', trigger: 'issues_found', description: 'Found issues to address' },
      { from: 'analyzing', to: 'approving', trigger: 'no_issues', description: 'Looks good' },
      { from: 'commenting', to: 'analyzing', trigger: 'review_continued', description: 'Continue review' },
      { from: 'commenting', to: 'approving', trigger: 'comments_resolved', description: 'All comments addressed' },
      { from: 'approving', to: 'merged', trigger: 'merged', description: 'PR merged' },
    ],
    onEnter: {
      analyzing: { action: 'inject_phase_context', params: { phase: 'review' } },
      merged: { action: 'run_maintenance', params: {} },
    },
  },
};

// ─── Machine Management ─────────────────────────────────────────────

/**
 * Define or register a state machine. Built-in machines are pre-loaded.
 * Custom machines can be added by agents at runtime.
 *
 * @param {Object} definition — { name, description?, initialState, states: string[], transitions: Array<{from, to, trigger, description?, guard?}>, onEnter?, onExit? }
 */
function defineMachine(definition) {
  if (!definition || !definition.name || !definition.initialState || !definition.states || !definition.transitions) {
    throw new Error('Machine definition requires: name, initialState, states, transitions');
  }

  // Validate transitions reference valid states
  for (const t of definition.transitions) {
    if (!definition.states.includes(t.from)) throw new Error(`Transition from unknown state: ${t.from}`);
    if (!definition.states.includes(t.to)) throw new Error(`Transition to unknown state: ${t.to}`);
  }

  if (!definition.states.includes(definition.initialState)) {
    throw new Error(`Initial state "${definition.initialState}" not in states list`);
  }

  _machines.set(definition.name, definition);
  return definition;
}

/**
 * Get a machine definition by name.
 * @param {string} name
 * @returns {Object|undefined}
 */
function getMachine(name) {
  return _machines.get(name);
}

/**
 * List all registered machines.
 * @returns {Array<{name: string, description: string, states: number, initialState: string}>}
 */
function listMachines() {
  return [..._machines.values()].map(m => ({
    name: m.name,
    description: m.description || '',
    states: m.states.length,
    initialState: m.initialState,
  }));
}

// ─── Agent State Management ─────────────────────────────────────────

/**
 * Start an agent in a state machine.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} agentId
 * @param {string} machineName
 * @param {Object} [opts] — { project?, stateData? }
 * @returns {Object} Agent state
 */
function startAgent(db, agentId, machineName, opts = {}) {
  const machine = _machines.get(machineName);
  if (!machine) throw new Error('Unknown machine: ' + machineName);

  const project = opts.project || process.cwd();
  const now = new Date().toISOString();
  const stateKey = agentId + '::' + machineName;

  // Check if agent already in this machine
  const existing = db.prepare(
    'SELECT * FROM agent_states WHERE agent_id = ? AND machine_name = ?'
  ).get(agentId, machineName);

  if (existing) {
    // Reset to initial state
    db.prepare('UPDATE agent_states SET current_state = ?, state_data = ?, last_transition_at = ? WHERE id = ?')
      .run(machine.initialState, JSON.stringify(opts.stateData || {}), now, existing.id);
  } else {
    db.prepare(
      'INSERT INTO agent_states (agent_id, machine_name, current_state, state_data, started_at, last_transition_at) VALUES (?,?,?,?,?,?)'
    ).run(agentId, machineName, machine.initialState, JSON.stringify(opts.stateData || {}), now, now);
  }

  const state = {
    agentId, machineName, currentState: machine.initialState,
    stateData: opts.stateData || {}, lastTransitionAt: now,
  };
  _agentStates.set(stateKey, state);

  // Fire onEnter for initial state
  _fireOnEnter(db, machine, machine.initialState, agentId, project);

  return state;
}

/**
 * Transition an agent from one state to another.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} agentId
 * @param {string} trigger — The event that triggered this transition
 * @param {Object} [opts] — { stateData? }
 * @returns {Object|null} New state, or null if no valid transition
 */
function transition(db, agentId, trigger, opts = {}) {
  // Find the agent's current state across all machines
  const stateKey = [..._agentStates.keys()].find(k => k.startsWith(agentId + '::'));
  if (!stateKey) {
    // Try from DB
    const dbState = db.prepare('SELECT * FROM agent_states WHERE agent_id = ? ORDER BY last_transition_at DESC LIMIT 1').get(agentId);
    if (!dbState) return null;
    return _transitionFromDB(db, dbState, trigger, opts);
  }

  const state = _agentStates.get(stateKey);
  return _transitionFromState(db, state, trigger, opts);
}

function _transitionFromState(db, state, trigger, opts) {
  const machine = _machines.get(state.machineName);
  if (!machine) return null;

  // Find matching transition
  const t = machine.transitions.find(
    tr => tr.from === state.currentState && tr.trigger === trigger
  );
  if (!t) return null;

  // Check guard condition if present
  if (t.guard && typeof t.guard === 'function') {
    if (!t.guard(state.stateData, opts)) return null;
  }

  // Fire onExit for current state
  _fireOnExit(db, machine, state.currentState, state.agentId, opts.project || process.cwd());

  // Update state
  const now = new Date().toISOString();
  state.currentState = t.to;
  state.stateData = { ...state.stateData, ...(opts.stateData || {}), lastTrigger: trigger };
  state.lastTransitionAt = now;
  _agentStates.set(state.agentId + '::' + state.machineName, state);

  // Persist
  db.prepare('UPDATE agent_states SET current_state = ?, state_data = ?, last_transition_at = ? WHERE agent_id = ? AND machine_name = ?')
    .run(state.currentState, JSON.stringify(state.stateData), now, state.agentId, state.machineName);

  // Fire onEnter for new state
  _fireOnEnter(db, machine, state.currentState, state.agentId, opts.project || process.cwd());

  // Evaluate rules for state transition
  if (_ruleEngine) {
    try {
      _ruleEngine.evaluate(db, 'state_transition', {
        agentId: state.agentId,
        fromState: t.from,
        toState: t.to,
        trigger,
        machineName: state.machineName,
      });
    } catch { /* best-effort */ }
  }

  return state;
}

function _transitionFromDB(db, dbState, trigger, opts) {
  const machine = _machines.get(dbState.machine_name);
  if (!machine) return null;

  const t = machine.transitions.find(
    tr => tr.from === dbState.current_state && tr.trigger === trigger
  );
  if (!t) return null;

  const now = new Date().toISOString();
  const newData = { ...JSON.parse(dbState.state_data || '{}'), ...(opts.stateData || {}), lastTrigger: trigger };
  db.prepare('UPDATE agent_states SET current_state = ?, state_data = ?, last_transition_at = ? WHERE id = ?')
    .run(t.to, JSON.stringify(newData), now, dbState.id);

  const state = {
    agentId: dbState.agent_id,
    machineName: dbState.machine_name,
    currentState: t.to,
    stateData: newData,
    lastTransitionAt: now,
  };
  _agentStates.set(dbState.agent_id + '::' + dbState.machine_name, state);

  _fireOnEnter(db, machine, t.to, dbState.agent_id, dbState.project_path || process.cwd());

  return state;
}

// ─── State Queries ──────────────────────────────────────────────────

/**
 * Get an agent's current state across all machines.
 * @param {string} agentId
 * @returns {Object|null}
 */
function getAgentState(agentId) {
  const stateKey = [..._agentStates.keys()].find(k => k.startsWith(agentId + '::'));
  if (stateKey) return _agentStates.get(stateKey);

  // Try from DB
  const db = require('./db').getDb();
  const dbState = db.prepare('SELECT * FROM agent_states WHERE agent_id = ? ORDER BY last_transition_at DESC LIMIT 1').get(agentId);
  if (!dbState) return null;

  const state = {
    agentId: dbState.agent_id,
    machineName: dbState.machine_name,
    currentState: dbState.current_state,
    stateData: JSON.parse(dbState.state_data || '{}'),
    lastTransitionAt: dbState.last_transition_at,
  };
  _agentStates.set(agentId + '::' + dbState.machine_name, state);
  return state;
}

/**
 * List all agent states, optionally filtered by machine.
 * @param {import('better-sqlite3').Database} db
 * @param {Object} [opts] — { machineName?, limit? }
 * @returns {Array<Object>}
 */
function listAgentStates(db, opts = {}) {
  let sql = 'SELECT * FROM agent_states WHERE 1=1';
  const params = [];
  if (opts.machineName) { sql += ' AND machine_name = ?'; params.push(opts.machineName); }
  sql += ' ORDER BY last_transition_at DESC LIMIT ?';
  params.push(opts.limit || 50);
  return db.prepare(sql).all(...params);
}

/**
 * Get available transitions from an agent's current state.
 * @param {string} agentId
 * @returns {Array<{trigger: string, to: string, description: string}>}
 */
function getAvailableTransitions(agentId) {
  const state = getAgentState(agentId);
  if (!state) return [];

  const machine = _machines.get(state.machineName);
  if (!machine) return [];

  return machine.transitions
    .filter(t => t.from === state.currentState)
    .map(t => ({ trigger: t.trigger, to: t.to, description: t.description || '' }));
}

// ─── State Context Injection ────────────────────────────────────────

/**
 * Get the context hint for an agent's current state — used by context()
 * to inject phase-specific content.
 *
 * @param {string} agentId
 * @returns {{machineName: string, state: string, phase: string}|null}
 */
function getStateContext(agentId) {
  const state = getAgentState(agentId);
  if (!state) return null;

  // Map machine states to context phases
  const phaseMap = {
    'planning': 'planning',
    'implementing': 'implementing',
    'testing': 'review',
    'reviewing': 'review',
    'reading': 'review',
    'analyzing': 'review',
    'commenting': 'review',
    'approving': 'review',
    'reproducing': 'planning',
    'diagnosing': 'planning',
    'fixing': 'implementation',
    'verifying': 'review',
    'done': 'review',
    'closed': 'review',
    'merged': 'review',
  };

  return {
    machineName: state.machineName,
    state: state.currentState,
    phase: phaseMap[state.currentState] || 'all',
  };
}

// ─── Entry/Exit Actions ─────────────────────────────────────────────

function _fireOnEnter(db, machine, stateName, agentId, project) {
  const entry = machine.onEnter && machine.onEnter[stateName];
  if (!entry) return;

  const action = entry.action;
  const params = entry.params || {};

  switch (action) {
    case 'save_context':
      if (_saveFn) {
        _saveFn({
          project, type: params.type || 'context',
          title: `FSM: entered ${stateName} (${machine.name})`,
          content: `Agent ${agentId} entered state "${stateName}" in machine "${machine.name}". ${params.note || ''}`,
          tags: ['fsm', 'state-transition', 'auto-capture'], importance: 4, provenance: 'inferred',
          agentId,
        }).catch(() => {});
      }
      break;
    case 'run_maintenance':
      try {
        const api = require('../api');
        api.runMaintenance({ project }).catch(() => {});
      } catch {}
      break;
    case 'spawn_experiment_if_recurring':
      // Handled by self-improve Hook 5
      break;
    case 'save_learning':
      if (_saveFn) {
        _saveFn({
          project, type: 'learning',
          title: `FSM: ${machine.name} completed at ${stateName}`,
          content: `Agent ${agentId} reached state "${stateName}" in workflow "${machine.name}". ${params.note || ''}`,
          tags: ['fsm', 'workflow-complete', 'auto-capture'], importance: 6, provenance: 'inferred',
          agentId,
        }).catch(() => {});
      }
      break;
    case 'inject_phase_context':
      // Handled by context() reading getStateContext()
      break;
  }
}

function _fireOnExit(db, machine, stateName, agentId, project) {
  const exit = machine.onExit && machine.onExit[stateName];
  if (!exit) return;

  if (_saveFn && exit.action === 'save_context') {
    _saveFn({
      project, type: 'context',
      title: `FSM: exited ${stateName} (${machine.name})`,
      content: `Agent ${agentId} left state "${stateName}" in machine "${machine.name}".`,
      tags: ['fsm', 'state-transition', 'auto-capture'], importance: 4, provenance: 'inferred',
      agentId,
    }).catch(() => {});
  }
}

// ─── Initialization ─────────────────────────────────────────────────

/**
 * Seed default machines into the database and in-memory cache.
 * Called once during API initialization.
 *
 * @param {import('better-sqlite3').Database} db
 */
function initDefaultMachines(db) {
  for (const [name, def] of Object.entries(DEFAULT_MACHINES)) {
    _machines.set(name, def);
    // Persist to DB if not already there
    const existing = db.prepare('SELECT id FROM state_machines WHERE name = ?').get(name);
    if (!existing) {
      db.prepare('INSERT INTO state_machines (name, definition) VALUES (?,?)')
        .run(name, JSON.stringify(def));
    }
  }
  // Also load any custom machines from DB
  const dbMachines = db.prepare('SELECT name, definition FROM state_machines').all();
  for (const m of dbMachines) {
    if (!_machines.has(m.name)) {
      try {
        _machines.set(m.name, JSON.parse(m.definition));
      } catch {}
    }
  }
}

// ─── Dependency Injection ───────────────────────────────────────────

function setSaveFunction(fn) { _saveFn = fn; }
function setRuleEngine(re) { _ruleEngine = re; }
function resetState() { _agentStates.clear(); }

// ─── Exports ────────────────────────────────────────────────────────

module.exports = {
  DEFAULT_MACHINES,
  defineMachine,
  getMachine,
  listMachines,
  startAgent,
  transition,
  getAgentState,
  listAgentStates,
  getAvailableTransitions,
  getStateContext,
  initDefaultMachines,
  setSaveFunction,
  setRuleEngine,
  resetState,
};
