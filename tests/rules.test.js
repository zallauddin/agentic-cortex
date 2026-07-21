'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../src/core/db');
const {
  DEFAULT_RULES,
  defineRule,
  evaluate,
  listRules,
  deleteRule,
  setRuleEnabled,
  initRuleHook,
  setSaveFunction,
  setFsm,
} = require('../src/core/rules');

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  return db;
}

// ─── Default Rules ────────────────────────────────────────────────────

describe('Rules: default rules', () => {
  it('should have 4 default rules', () => {
    assert.equal(DEFAULT_RULES.length, 4);
  });

  it('should include escalate-recurring-errors', () => {
    const r = DEFAULT_RULES.find(r => r.name === 'escalate-recurring-errors');
    assert.ok(r);
    assert.equal(r.priority, 10);
    assert.equal(r.event, 'post_save');
    assert.equal(r.condition_type, 'tag_count');
    assert.equal(r.action_type, 'spawn_experiment');
  });

  it('should include auto-crystallize-on-milestone', () => {
    const r = DEFAULT_RULES.find(r => r.name === 'auto-crystallize-on-milestone');
    assert.ok(r);
    assert.equal(r.event, 'state_transition');
    assert.equal(r.action_type, 'crystallize');
  });

  it('should include run-maintenance-on-review', () => {
    const r = DEFAULT_RULES.find(r => r.name === 'run-maintenance-on-review');
    assert.ok(r);
  });

  it('should include save-context-on-state-change', () => {
    const r = DEFAULT_RULES.find(r => r.name === 'save-context-on-state-change');
    assert.ok(r);
  });
});

// ─── Rule CRUD ────────────────────────────────────────────────────────

describe('Rules: CRUD', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should define a new rule', () => {
    const result = defineRule(db, {
      name: 'test-rule',
      event: 'post_save',
      condition_type: 'always',
      condition_config: {},
      action_type: 'save_observation',
      action_config: { type: 'learning', note: 'test' },
      priority: 5,
    });
    assert.equal(result.status, 'created');
    assert.ok(result.id > 0);
  });

  it('should update an existing rule by name', () => {
    defineRule(db, {
      name: 'update-test',
      event: 'post_save',
      condition_type: 'always',
      condition_config: {},
      action_type: 'save_observation',
      action_config: {},
      priority: 3,
    });
    const result = defineRule(db, {
      name: 'update-test',
      event: 'pre_save',
      condition_type: 'always',
      condition_config: {},
      action_type: 'save_observation',
      action_config: {},
      priority: 7,
    });
    assert.equal(result.status, 'updated');
    // Verify the update
    const rule = db.prepare('SELECT * FROM brain_rules WHERE name = ?').get('update-test');
    assert.equal(rule.priority, 7);
  });

  it('should reject rule without required fields', () => {
    assert.throws(() => defineRule(db, {}), /requires/);
    assert.throws(() => defineRule(db, { name: 'x' }), /requires/);
    assert.throws(() => defineRule(db, { name: 'x', event: 'post_save', condition_type: 'always' }), /requires/);
  });

  it('should list all rules (built-in + persisted)', () => {
    defineRule(db, {
      name: 'custom-rule',
      event: 'post_save',
      condition_type: 'always',
      condition_config: {},
      action_type: 'save_observation',
      action_config: {},
      priority: 1,
    });
    const rules = listRules(db);
    assert.ok(rules.length >= 5, `Expected at least 5 rules (4 built-in + 1 custom), got ${rules.length}`);
  });

  it('should list rules filtered by event', () => {
    const rules = listRules(db, { event: 'state_transition' });
    assert.ok(rules.every(r => r.event === 'state_transition'));
    assert.ok(rules.length >= 2);
  });

  it('should delete a persisted rule', () => {
    const created = defineRule(db, {
      name: 'to-delete',
      event: 'post_save',
      condition_type: 'always',
      condition_config: {},
      action_type: 'save_observation',
      action_config: {},
      priority: 1,
    });
    const result = deleteRule(db, created.id);
    assert.equal(result.status, 'deleted');
  });

  it('should throw when deleting non-existent rule', () => {
    assert.throws(() => deleteRule(db, 9999), /not found/);
  });

  it('should enable/disable a rule', () => {
    const created = defineRule(db, {
      name: 'toggle-rule',
      event: 'post_save',
      condition_type: 'always',
      condition_config: {},
      action_type: 'save_observation',
      action_config: {},
      priority: 1,
    });
    setRuleEnabled(db, created.id, false);
    const r = db.prepare('SELECT enabled FROM brain_rules WHERE id = ?').get(created.id);
    assert.equal(r.enabled, 0);

    setRuleEnabled(db, created.id, true);
    const r2 = db.prepare('SELECT enabled FROM brain_rules WHERE id = ?').get(created.id);
    assert.equal(r2.enabled, 1);
  });

  it('should throw when toggling non-existent rule', () => {
    assert.throws(() => setRuleEnabled(db, 9999, true), /not found/);
  });
});

// ─── Rule Evaluation ──────────────────────────────────────────────────

describe('Rules: evaluation', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should evaluate and return results array', async () => {
    const results = await evaluate(db, 'post_save', {
      project_path: '/test',
      tags: ['test'],
      type: 'observation',
    });
    assert.ok(Array.isArray(results));
    assert.ok(results.length > 0);
  });

  it('should match escalate-recurring-errors rule with sufficient errors', async () => {
    // Seed 6 errors with same tag
    const project = '/test-project';
    for (let i = 0; i < 6; i++) {
      db.prepare(
        'INSERT INTO observations (project_path, type, title, content, tags) VALUES (?,?,?,?,?)'
      ).run(project, 'error', `Error ${i}`, `Content ${i}`, JSON.stringify(['parser', 'error']));
    }

    const results = await evaluate(db, 'post_save', {
      project_path: project,
      tags: ['parser', 'error'],
      type: 'error',
    });

    const escalate = results.find(r => r.rule === 'escalate-recurring-errors');
    assert.ok(escalate, 'escalate-recurring-errors should be in results');
    assert.ok(escalate.matched, 'Should match with 6 errors');
    assert.equal(escalate.action, 'spawn_experiment');
  });

  it('should NOT match escalate-recurring-errors with insufficient errors', async () => {
    const project = '/test-few';
    for (let i = 0; i < 2; i++) {
      db.prepare(
        'INSERT INTO observations (project_path, type, title, content, tags) VALUES (?,?,?,?,?)'
      ).run(project, 'error', `Error ${i}`, `Content ${i}`, JSON.stringify(['parser', 'error']));
    }

    const results = await evaluate(db, 'post_save', {
      project_path: project,
      tags: ['parser', 'error'],
      type: 'error',
    });

    const escalate = results.find(r => r.rule === 'escalate-recurring-errors');
    assert.ok(escalate);
    assert.equal(escalate.matched, false, 'Should NOT match with only 2 errors');
  });

  it('should match auto-crystallize-on-milestone on transition to done', async () => {
    const results = await evaluate(db, 'state_transition', {
      agentId: 'agent-1',
      fromState: 'reviewing',
      toState: 'done',
      machineName: 'coding-workflow',
    });

    const crystallize = results.find(r => r.rule === 'auto-crystallize-on-milestone');
    assert.ok(crystallize);
    assert.ok(crystallize.matched, 'Should fire when transitioning to done');
  });

  it('should NOT match auto-crystallize-on-milestone on other transitions', async () => {
    const results = await evaluate(db, 'state_transition', {
      agentId: 'agent-1',
      fromState: 'planning',
      toState: 'implementing',
      machineName: 'coding-workflow',
    });

    const crystallize = results.find(r => r.rule === 'auto-crystallize-on-milestone');
    assert.ok(crystallize);
    assert.equal(crystallize.matched, false, 'Should not fire on non-done transition');
  });

  it('should match run-maintenance-on-review on transition to reviewing', async () => {
    const results = await evaluate(db, 'state_transition', {
      agentId: 'agent-1',
      fromState: 'testing',
      toState: 'reviewing',
      machineName: 'coding-workflow',
    });

    const maintenance = results.find(r => r.rule === 'run-maintenance-on-review');
    assert.ok(maintenance);
    assert.ok(maintenance.matched, 'Should fire when transitioning to reviewing');
  });

  it('should match save-context-on-state-change on any state transition', async () => {
    const results = await evaluate(db, 'state_transition', {
      agentId: 'agent-1',
      fromState: 'planning',
      toState: 'implementing',
      machineName: 'coding-workflow',
    });

    const saveCtx = results.find(r => r.rule === 'save-context-on-state-change');
    assert.ok(saveCtx);
    assert.ok(saveCtx.matched, 'Should fire on any state transition');
  });

  it('should return results in evaluation order', async () => {
    const results = await evaluate(db, 'state_transition', {
      agentId: 'agent-1',
      fromState: 'testing',
      toState: 'reviewing',
      machineName: 'coding-workflow',
    });

    // Results should include all rules matching the event
    assert.ok(results.length > 0);
    // Each result has rule name, matched status, and action
    for (const r of results) {
      assert.ok(r.rule);
      assert.equal(typeof r.matched, 'boolean');
      assert.ok(r.action);
    }
  });
});

// ─── Rule Evaluation Edge Cases ───────────────────────────────────────

describe('Rules: evaluation edge cases', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should handle empty context without throwing', async () => {
    const results = await evaluate(db, 'post_save', {});
    assert.ok(Array.isArray(results));
  });

  it('should handle unknown event without throwing', async () => {
    const results = await evaluate(db, 'unknown_event', {});
    assert.ok(Array.isArray(results));
  });

  it('should respect disabled persisted rules — disabled rules do not override defaults', async () => {
    // Disabled persisted rules are filtered by 'enabled=1' in evaluate(),
    // so they never replace the in-memory defaults. The default still fires.
    const created = defineRule(db, {
      name: 'escalate-recurring-errors',
      event: 'post_save',
      condition_type: 'tag_count',
      condition_config: { minCount: 1, type: 'error' },
      action_type: 'spawn_experiment',
      action_config: {},
      priority: 10,
    });
    setRuleEnabled(db, created.id, false);

    // Seed errors — the default escalate-recurring-errors still fires
    const project = '/test-disabled';
    for (let i = 0; i < 6; i++) {
      db.prepare(
        'INSERT INTO observations (project_path, type, title, content, tags) VALUES (?,?,?,?,?)'
      ).run(project, 'error', `Error ${i}`, `Content ${i}`, JSON.stringify(['parser']));
    }

    const results = await evaluate(db, 'post_save', {
      project_path: project,
      tags: ['parser'],
      type: 'error',
    });

    const escalate = results.find(r => r.rule === 'escalate-recurring-errors');
    assert.ok(escalate);
    // Default rule (built-in) still matches because disabled persisted rules
    // are filtered by the enabled=1 WHERE clause and never replace defaults
    assert.ok(escalate.matched, 'Default rule should still fire when persisted version is disabled');
  });
});

// ─── Dependency Injection ─────────────────────────────────────────────

describe('Rules: dependency injection', () => {
  it('should accept a save function', () => {
    const fn = async () => ({ id: 1 });
    assert.doesNotThrow(() => setSaveFunction(fn));
  });

  it('should accept an FSM reference', () => {
    const fsm = { transition: () => {}, getAgentState: () => null };
    assert.doesNotThrow(() => setFsm(fsm));
  });
});

// ─── Rule Hook ────────────────────────────────────────────────────────

describe('Rules: initRuleHook', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should register a post_save hook without throwing', () => {
    assert.doesNotThrow(() => initRuleHook(db));
  });
});

// ─── Module Exports ───────────────────────────────────────────────────

describe('Rules: module exports', () => {
  it('should export all expected functions', () => {
    assert.equal(typeof defineRule, 'function');
    assert.equal(typeof evaluate, 'function');
    assert.equal(typeof listRules, 'function');
    assert.equal(typeof deleteRule, 'function');
    assert.equal(typeof setRuleEnabled, 'function');
    assert.equal(typeof initRuleHook, 'function');
    assert.equal(typeof setSaveFunction, 'function');
    assert.equal(typeof setFsm, 'function');
  });
});
