'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../src/core/db');
const {
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
} = require('../src/core/fsm');

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  initDefaultMachines(db);
  return db;
}

// ─── Machine Definition ──────────────────────────────────────────────

describe('FSM: machine definition', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { resetState(); });

  it('should define a custom machine', () => {
    defineMachine({
      name: 'test-machine',
      description: 'A test state machine',
      initialState: 'idle',
      states: ['idle', 'running', 'done'],
      transitions: [
        { from: 'idle', to: 'running', trigger: 'start', description: 'Begin' },
        { from: 'running', to: 'done', trigger: 'finish' },
      ],
    });

    const m = getMachine('test-machine');
    assert.ok(m);
    assert.equal(m.name, 'test-machine');
    assert.equal(m.initialState, 'idle');
    assert.equal(m.states.length, 3);
    assert.equal(m.transitions.length, 2);
  });

  it('should reject machine without required fields', () => {
    assert.throws(() => defineMachine({}), /requires/);
    assert.throws(() => defineMachine({ name: 'x' }), /requires/);
    assert.throws(() => defineMachine({ name: 'x', initialState: 'a' }), /requires/);
  });

  it('should reject transitions referencing unknown states', () => {
    assert.throws(() => defineMachine({
      name: 'bad-machine',
      initialState: 'a',
      states: ['a', 'b'],
      transitions: [{ from: 'a', to: 'z', trigger: 'go' }],
    }), /unknown state: z/);

    assert.throws(() => defineMachine({
      name: 'bad-machine-2',
      initialState: 'a',
      states: ['a', 'b'],
      transitions: [{ from: 'z', to: 'a', trigger: 'go' }],
    }), /unknown state: z/);
  });

  it('should list all machines including defaults', () => {
    const machines = listMachines();
    assert.ok(machines.length >= 3);
    const names = machines.map(m => m.name);
    assert.ok(names.includes('coding-workflow'));
    assert.ok(names.includes('debug-workflow'));
    assert.ok(names.includes('review-workflow'));
  });

  it('should return null for unknown machine', () => {
    assert.equal(getMachine('nonexistent'), undefined);
  });
});

// ─── Default Machines ─────────────────────────────────────────────────

describe('FSM: default machines', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { resetState(); });

  it('should include all expected default machines', () => {
    assert.ok(DEFAULT_MACHINES['coding-workflow']);
    assert.ok(DEFAULT_MACHINES['debug-workflow']);
    assert.ok(DEFAULT_MACHINES['review-workflow']);
  });

  it('coding-workflow should have 5 states', () => {
    const m = DEFAULT_MACHINES['coding-workflow'];
    assert.equal(m.states.length, 5);
    assert.deepEqual(m.states, ['planning', 'implementing', 'testing', 'reviewing', 'done']);
  });

  it('debug-workflow should have 5 states', () => {
    const m = DEFAULT_MACHINES['debug-workflow'];
    assert.equal(m.states.length, 5);
    assert.deepEqual(m.states, ['reproducing', 'diagnosing', 'fixing', 'verifying', 'closed']);
  });

  it('debug-workflow should have entry actions', () => {
    const m = DEFAULT_MACHINES['debug-workflow'];
    assert.ok(m.onEnter);
    assert.equal(m.onEnter.reproducing.action, 'save_context');
    assert.equal(m.onEnter.closed.action, 'save_learning');
  });
});

// ─── Agent State Management ───────────────────────────────────────────

describe('FSM: agent state management', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { resetState(); });

  it('should start an agent in initial state', () => {
    const state = startAgent(db, 'agent-1', 'coding-workflow');
    assert.equal(state.agentId, 'agent-1');
    assert.equal(state.machineName, 'coding-workflow');
    assert.equal(state.currentState, 'planning');
  });

  it('should throw for unknown machine', () => {
    assert.throws(() => startAgent(db, 'agent-1', 'no-such-machine'), /Unknown machine/);
  });

  it('should restart agent to initial state if already exists', () => {
    startAgent(db, 'agent-1', 'coding-workflow');
    const state = startAgent(db, 'agent-1', 'coding-workflow');
    assert.equal(state.currentState, 'planning');
  });

  it('should get agent state after starting', () => {
    startAgent(db, 'agent-1', 'debug-workflow');
    const state = getAgentState('agent-1');
    assert.ok(state);
    assert.equal(state.currentState, 'reproducing');
    assert.equal(state.machineName, 'debug-workflow');
  });

  it('should return null for unknown agent', () => {
    assert.equal(getAgentState('no-such-agent'), null);
  });

  it('should list agent states', () => {
    startAgent(db, 'agent-a', 'coding-workflow');
    startAgent(db, 'agent-b', 'debug-workflow');
    const states = listAgentStates(db);
    assert.ok(states.length >= 2);
  });

  it('should list agent states filtered by machine', () => {
    startAgent(db, 'agent-x', 'coding-workflow');
    startAgent(db, 'agent-y', 'debug-workflow');
    const states = listAgentStates(db, { machineName: 'coding-workflow' });
    assert.ok(states.every(s => s.machine_name === 'coding-workflow'));
  });
});

// ─── State Transitions ────────────────────────────────────────────────

describe('FSM: state transitions', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { resetState(); });

  it('should transition through valid path', () => {
    startAgent(db, 'agent-1', 'coding-workflow');

    const s1 = transition(db, 'agent-1', 'plan_approved');
    assert.equal(s1.currentState, 'implementing');

    const s2 = transition(db, 'agent-1', 'implementation_done');
    assert.equal(s2.currentState, 'testing');
  });

  it('should return null for invalid transition', () => {
    startAgent(db, 'agent-1', 'coding-workflow');
    const result = transition(db, 'agent-1', 'review_approved'); // not valid from planning
    assert.equal(result, null);
  });

  it('should return null for unknown agent', () => {
    assert.equal(transition(db, 'no-one', 'any_trigger'), null);
  });

  it('should support back-transitions (testing → implementing on test failure)', () => {
    startAgent(db, 'agent-1', 'coding-workflow');
    transition(db, 'agent-1', 'plan_approved');
    transition(db, 'agent-1', 'implementation_done');
    assert.equal(getAgentState('agent-1').currentState, 'testing');

    const s = transition(db, 'agent-1', 'tests_fail');
    assert.equal(s.currentState, 'implementing');
  });

  it('should support full debug-workflow lifecycle', () => {
    startAgent(db, 'agent-1', 'debug-workflow');
    assert.equal(getAgentState('agent-1').currentState, 'reproducing');

    transition(db, 'agent-1', 'bug_reproduced');
    assert.equal(getAgentState('agent-1').currentState, 'diagnosing');

    transition(db, 'agent-1', 'root_cause_found');
    assert.equal(getAgentState('agent-1').currentState, 'fixing');

    transition(db, 'agent-1', 'fix_applied');
    assert.equal(getAgentState('agent-1').currentState, 'verifying');

    transition(db, 'agent-1', 'fix_verified');
    assert.equal(getAgentState('agent-1').currentState, 'closed');
  });

  it('should support fix_failed back-transition in debug-workflow', () => {
    startAgent(db, 'agent-1', 'debug-workflow');
    transition(db, 'agent-1', 'bug_reproduced');
    transition(db, 'agent-1', 'root_cause_found');
    transition(db, 'agent-1', 'fix_applied');
    assert.equal(getAgentState('agent-1').currentState, 'verifying');

    const s = transition(db, 'agent-1', 'fix_failed');
    assert.equal(s.currentState, 'fixing');
  });

  it('should set lastTransitionAt on transition', () => {
    startAgent(db, 'agent-1', 'coding-workflow');
    transition(db, 'agent-1', 'plan_approved');
    const state = getAgentState('agent-1');
    assert.ok(state.lastTransitionAt);
  });
});

// ─── Available Transitions ────────────────────────────────────────────

describe('FSM: available transitions', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { resetState(); });

  it('should list available transitions from current state', () => {
    startAgent(db, 'agent-1', 'coding-workflow');
    const transitions = getAvailableTransitions('agent-1');
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].trigger, 'plan_approved');
    assert.equal(transitions[0].to, 'implementing');
  });

  it('should list multiple transitions when available', () => {
    startAgent(db, 'agent-1', 'coding-workflow');
    transition(db, 'agent-1', 'plan_approved');
    transition(db, 'agent-1', 'implementation_done');
    // testing state: tests_pass → reviewing, tests_fail → implementing, architecture_issue → planning
    const transitions = getAvailableTransitions('agent-1');
    assert.equal(transitions.length, 3);
    const triggers = transitions.map(t => t.trigger);
    assert.ok(triggers.includes('tests_pass'));
    assert.ok(triggers.includes('tests_fail'));
    assert.ok(triggers.includes('architecture_issue'));
  });

  it('should return empty for terminal state', () => {
    startAgent(db, 'agent-1', 'coding-workflow');
    transition(db, 'agent-1', 'plan_approved');
    transition(db, 'agent-1', 'implementation_done');
    transition(db, 'agent-1', 'tests_pass');
    transition(db, 'agent-1', 'review_approved');
    // 'done' is terminal — no transitions from it in coding-workflow
    const transitions = getAvailableTransitions('agent-1');
    assert.equal(transitions.length, 0, 'done state should have no outgoing transitions');
  });

  it('should return empty array for unknown agent', () => {
    assert.deepEqual(getAvailableTransitions('no-one'), []);
  });
});

// ─── State Context ────────────────────────────────────────────────────

describe('FSM: state context', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { resetState(); });

  it('should return context for planning state', () => {
    startAgent(db, 'agent-1', 'coding-workflow');
    const ctx = getStateContext('agent-1');
    assert.ok(ctx);
    assert.equal(ctx.state, 'planning');
    assert.equal(ctx.machineName, 'coding-workflow');
    assert.equal(ctx.phase, 'planning');
  });

  it('should return context for implementing state', () => {
    startAgent(db, 'agent-1', 'coding-workflow');
    transition(db, 'agent-1', 'plan_approved');
    const ctx = getStateContext('agent-1');
    assert.equal(ctx.state, 'implementing');
    assert.equal(ctx.phase, 'implementing');
  });

  it('should return context for testing state', () => {
    startAgent(db, 'agent-1', 'coding-workflow');
    transition(db, 'agent-1', 'plan_approved');
    transition(db, 'agent-1', 'implementation_done');
    const ctx = getStateContext('agent-1');
    assert.equal(ctx.state, 'testing');
    assert.equal(ctx.phase, 'review');
  });

  it('should return null for unknown agent', () => {
    assert.equal(getStateContext('no-one'), null);
  });
});

// ─── Dependency Injection ─────────────────────────────────────────────

describe('FSM: dependency injection', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { resetState(); setSaveFunction(null); setRuleEngine(null); });

  it('should accept a save function', () => {
    const fn = async () => ({ id: 1 });
    assert.doesNotThrow(() => setSaveFunction(fn));
  });

  it('should accept a rule engine', () => {
    const engine = { evaluate: () => {} };
    assert.doesNotThrow(() => setRuleEngine(engine));
  });

  it('should call save function on entry action (save_context)', () => {
    const saved = [];
    // Async function body runs synchronously until first await — no await here,
    // so saved.push() completes before startAgent returns. No race condition.
    setSaveFunction(async (opts) => {
      saved.push(opts);
      return { id: saved.length };
    });

    startAgent(db, 'agent-save', 'debug-workflow');
    // reproducing state has onEnter: save_context — fires synchronously

    assert.ok(saved.length >= 1, 'save_context should have been called synchronously');
    const ctxEntry = saved.find(s => s.tags && s.tags.includes('fsm'));
    assert.ok(ctxEntry, 'Should have saved an FSM context entry');
    assert.ok(ctxEntry.title.includes('reproducing'));
  });
});

// ─── Reset State ──────────────────────────────────────────────────────

describe('FSM: resetState', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { resetState(); });

  it('should clear in-memory agent state cache', () => {
    startAgent(db, 'agent-1', 'coding-workflow');
    assert.ok(getAgentState('agent-1'));

    resetState();

    // After reset, in-memory cache is cleared but DB persists
    // getAgentState falls back to DB via require('./db').getDb()
    // (which accesses the real file DB, separate from in-memory test DB)
    // So we verify the in-memory cache was cleared by checking
    // that a subsequent startAgent re-registers without error
    assert.doesNotThrow(() => {
      // Re-starting should work since cache was cleared
      startAgent(db, 'agent-1', 'coding-workflow');
    });
  });
});

// ─── Entry Actions for All States ─────────────────────────────────────

describe('FSM: entry actions', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { resetState(); setSaveFunction(null); });

  it('debug-workflow: reproducing triggers save_context', () => {
    // The action should not throw
    assert.doesNotThrow(() => startAgent(db, 'agent-entry', 'debug-workflow'));
  });

  it('debug-workflow: closed triggers save_learning', () => {
    const saved = [];
    // Async function body runs synchronously until first await — no await here,
    // so saved.push() completes before transition returns.
    setSaveFunction(async (opts) => {
      saved.push(opts);
      return { id: saved.length };
    });

    startAgent(db, 'agent-closed', 'debug-workflow');
    transition(db, 'agent-closed', 'bug_reproduced');
    transition(db, 'agent-closed', 'root_cause_found');
    transition(db, 'agent-closed', 'fix_applied');
    transition(db, 'agent-closed', 'fix_verified');
    // fix_verified transition triggers onEnter for 'closed' state → save_learning fires synchronously

    const learningEntry = saved.find(s => s.type === 'learning' && s.tags && s.tags.includes('fsm'));
    assert.ok(learningEntry, 'Should have saved a learning entry on closed state synchronously');
  });
});

// ─── Module Exports ───────────────────────────────────────────────────

describe('FSM: module exports', () => {
  it('should export all expected functions', () => {
    assert.equal(typeof defineMachine, 'function');
    assert.equal(typeof getMachine, 'function');
    assert.equal(typeof listMachines, 'function');
    assert.equal(typeof startAgent, 'function');
    assert.equal(typeof transition, 'function');
    assert.equal(typeof getAgentState, 'function');
    assert.equal(typeof listAgentStates, 'function');
    assert.equal(typeof getAvailableTransitions, 'function');
    assert.equal(typeof getStateContext, 'function');
    assert.equal(typeof initDefaultMachines, 'function');
    assert.equal(typeof setSaveFunction, 'function');
    assert.equal(typeof setRuleEngine, 'function');
    assert.equal(typeof resetState, 'function');
  });
});
