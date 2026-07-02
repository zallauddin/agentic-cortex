'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../src/core/db');
const {
  registerHook,
  unregisterHook,
  triggerHooks,
  createHook,
  listHooks,
  updateHook,
  deleteHook,
  setHookEnabled,
  VALID_EVENTS,
  VALID_ACTION_TYPES,
  setSaveFunction,
} = require('../src/core/hooks');

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  return db;
}

// ─── Registry Management ─────────────────────────────────────────────

describe('in-memory hook registry', () => {
  const tracked = []; // Track registered callbacks for cleanup

  afterEach(() => {
    // Clean up all hooks registered in this block
    for (const { event, cb } of tracked) {
      unregisterHook(event, cb);
    }
    tracked.length = 0;
  });

  function trackHook(event, cb) {
    tracked.push({ event, cb });
    return registerHook(event, cb);
  }

  it('should register a hook and return unregister function', () => {
    const cb = () => {};
    const unregister = trackHook('post_save', cb);
    assert.equal(typeof unregister, 'function');
  });

  it('should unregister a hook', () => {
    const cb = () => {};
    trackHook('post_save', cb);
    assert.doesNotThrow(() => unregisterHook('post_save', cb));
    tracked.length = 0; // Already unregistered
  });

  it('should reject invalid event names', () => {
    assert.throws(() => registerHook('invalid_event', () => {}), /Invalid event/);
  });

  it('should reject non-function callbacks', () => {
    assert.throws(() => registerHook('post_save', 'not a function'), /Callback must be a function/);
  });

  it('should allow unregisterHook on empty registry without error', () => {
    assert.doesNotThrow(() => unregisterHook('post_save', () => {}));
  });

  it('should not throw when unregistering twice', () => {
    const cb = () => {};
    trackHook('pre_save', cb);
    unregisterHook('pre_save', cb);
    assert.doesNotThrow(() => unregisterHook('pre_save', cb));
    tracked.length = 0; // Already unregistered
  });
});

// ─── Trigger Hooks ────────────────────────────────────────────────────

describe('triggerHooks', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should call registered in-memory hooks', async () => {
    const calls = [];
    registerHook('post_save', async (obs, ctx) => {
      calls.push({ obs, ctx });
    });

    const obs = { id: 1, type: 'observation', title: 'Test', content: 'Content' };
    await triggerHooks(db, 'post_save', obs, { project: '/test' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].obs.title, 'Test');
    assert.equal(calls[0].ctx.project, '/test');
  });

  it('should catch errors in hooks without propagating', async () => {
    registerHook('post_save', async () => {
      throw new Error('Hook error!');
    });

    const obs = { id: 1, type: 'observation', content: 'Test' };
    await assert.doesNotReject(async () => {
      await triggerHooks(db, 'post_save', obs, {});
    });
  });

  it('should call multiple hooks for the same event', async () => {
    const calls = [];
    registerHook('pre_save', async () => calls.push(1));
    registerHook('pre_save', async () => calls.push(2));

    await triggerHooks(db, 'pre_save', { content: 'test' }, {});
    assert.deepEqual(calls, [1, 2]);
  });

  it('should not call hooks for other events', async () => {
    const calls = [];
    registerHook('post_save', async () => calls.push(1));

    await triggerHooks(db, 'pre_save', { content: 'test' }, {});
    assert.equal(calls.length, 0);
  });

  it('should pass the db instance as third argument to hooks', async () => {
    let passedDb = null;
    registerHook('post_save', async (obs, ctx, dbArg) => {
      passedDb = dbArg;
    });

    await triggerHooks(db, 'post_save', { content: 'test' }, {});
    assert.ok(passedDb !== null, 'db should be passed to hook');
  });

  it('should execute persisted hooks from database', async () => {
    createHook(db, {
      name: 'auto-log',
      event: 'post_save',
      action_type: 'log',
      action_config: { message: 'Saved: {{title}}' },
    });

    const obs = { id: 1, type: 'observation', title: 'My Title', content: 'Content' };
    await assert.doesNotReject(async () => {
      await triggerHooks(db, 'post_save', obs, {});
    });
  });
});

// ─── Persisted Hooks CRUD ────────────────────────────────────────────

describe('persisted hooks CRUD', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should create a hook', () => {
    const result = createHook(db, {
      name: 'test-hook',
      event: 'post_save',
      action_type: 'log',
      action_config: { message: 'hello' },
    });
    assert.equal(result.status, 'created');
    assert.ok(result.id > 0);
  });

  it('should reject missing required fields', () => {
    assert.throws(() => createHook(db, {}), /required/);
    assert.throws(() => createHook(db, { name: 'x' }), /required/);
  });

  it('should reject invalid event', () => {
    assert.throws(() => createHook(db, {
      name: 'bad', event: 'nope', action_type: 'log', action_config: '{}',
    }), /Invalid event/);
  });

  it('should reject invalid action_type', () => {
    assert.throws(() => createHook(db, {
      name: 'bad', event: 'post_save', action_type: 'invalid', action_config: '{}',
    }), /Invalid action_type/);
  });

  it('should list all hooks', () => {
    createHook(db, { name: 'h1', event: 'post_save', action_type: 'log', action_config: '{}' });
    createHook(db, { name: 'h2', event: 'pre_save', action_type: 'log', action_config: '{}' });
    const hooks = listHooks(db);
    assert.equal(hooks.length, 2);
  });

  it('should update a hook', () => {
    const created = createHook(db, { name: 'upd', event: 'post_save', action_type: 'log', action_config: '{}' });
    const result = updateHook(db, created.id, { event: 'pre_save' });
    assert.equal(result.status, 'updated');
  });

  it('should throw when updating non-existent hook', () => {
    assert.throws(() => updateHook(db, 9999, { event: 'post_save' }), /not found/);
  });

  it('should throw when updating with no fields', () => {
    const created = createHook(db, { name: 'nofields', event: 'post_save', action_type: 'log', action_config: '{}' });
    assert.throws(() => updateHook(db, created.id, {}), /No fields to update/);
  });

  it('should delete a hook', () => {
    const created = createHook(db, { name: 'del', event: 'post_save', action_type: 'log', action_config: '{}' });
    const result = deleteHook(db, created.id);
    assert.equal(result.status, 'deleted');
  });

  it('should throw when deleting non-existent hook', () => {
    assert.throws(() => deleteHook(db, 9999), /not found/);
  });

  it('should enable/disable a hook', () => {
    const created = createHook(db, { name: 'toggle', event: 'post_save', action_type: 'log', action_config: '{}' });
    setHookEnabled(db, created.id, false);
    const hooks = listHooks(db);
    const h = hooks.find(h => h.id === created.id);
    assert.equal(h.enabled, 0);
  });

  it('should persist action_config as object or string', () => {
    // Object config
    const r1 = createHook(db, {
      name: 'obj-config',
      event: 'post_save',
      action_type: 'log',
      action_config: { message: 'hello', level: 'info' },
    });
    const h1 = db.prepare('SELECT action_config FROM hooks WHERE id = ?').get(r1.id);
    assert.ok(h1.action_config.includes('"message"'));

    // String config
    const r2 = createHook(db, {
      name: 'str-config',
      event: 'pre_save',
      action_type: 'log',
      action_config: '{"message":"direct"}',
    });
    const h2 = db.prepare('SELECT action_config FROM hooks WHERE id = ?').get(r2.id);
    assert.equal(h2.action_config, '{"message":"direct"}');
  });
});

// ─── Save Function Injection ──────────────────────────────────────────

describe('save function injection', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should accept a save function', () => {
    const fn = async () => ({ id: 1 });
    assert.doesNotThrow(() => setSaveFunction(fn));
  });

  it('should call injected save function from save_memory action', async () => {
    const savedItems = [];
    setSaveFunction(async (opts) => {
      savedItems.push(opts);
      return { id: savedItems.length, status: 'saved' };
    });

    createHook(db, {
      name: 'auto-capture',
      event: 'post_save',
      action_type: 'save_memory',
      action_config: {
        title: 'Auto: {{title}}',
        content: 'Follow-up to: {{content}}',
        type: 'observation',
        provenance: 'inferred',
      },
    });

    const obs = {
      id: 1,
      type: 'decision',
      title: 'Use Redis',
      content: 'Decided to use Redis for caching',
      project_path: '/test',
      session_id: 'sess-1',
      agent_id: 'agent-1',
      tags: '["cache"]',
      importance: 8,
      confidence: 90,
      provenance: 'explicit',
    };

    await triggerHooks(db, 'post_save', obs, {});

    assert.equal(savedItems.length, 1, 'Should have called save once');
    assert.equal(savedItems[0].title, 'Auto: Use Redis');
    assert.ok(savedItems[0].content.includes('Follow-up'));
    assert.equal(savedItems[0].type, 'observation');
    assert.equal(savedItems[0].provenance, 'inferred');
    assert.equal(savedItems[0].project, '/test');
    assert.equal(savedItems[0].session, 'sess-1');
    assert.equal(savedItems[0].agentId, 'agent-1');
  });

  // Clean up — reset save function
  afterEach(() => setSaveFunction(null));

  it('should skip disabled persisted hooks during trigger', async () => {
    const calls = [];
    setSaveFunction(async (opts) => { calls.push(opts); return { id: 1 }; });

    const created = createHook(db, {
      name: 'disabled-hook',
      event: 'post_save',
      action_type: 'save_memory',
      action_config: { title: 'Should not fire', content: 'disabled', type: 'observation' },
    });

    // Disable the hook
    setHookEnabled(db, created.id, false);

    const obs = {
      id: 10, type: 'observation', title: 'Test', content: 'Test',
      project_path: '/test', tags: '[]',
    };

    await triggerHooks(db, 'post_save', obs, {});
    assert.equal(calls.length, 0, 'Disabled hook should not fire');

    // Re-enable and verify it fires
    setHookEnabled(db, created.id, true);
    await triggerHooks(db, 'post_save', obs, {});
    assert.equal(calls.length, 1, 'Re-enabled hook should fire');
  });
});

// ─── Condition Evaluation ─────────────────────────────────────────────

describe('condition evaluation', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should skip hook when condition not met', async () => {
    const calls = [];
    setSaveFunction(async (opts) => { calls.push(opts); return { id: 1 }; });

    createHook(db, {
      name: 'conditional',
      event: 'post_save',
      condition_type: 'type_equals',
      condition_value: 'bug',
      action_type: 'save_memory',
      action_config: { title: 'Only bugs', content: 'triggered', type: 'observation' },
    });

    // Trigger with type 'decision' — should NOT match type_equals 'bug'
    const obs = {
      id: 1,
      type: 'decision',
      title: 'Not a bug',
      content: 'Some decision',
      project_path: '/test',
      tags: '[]',
    };

    await triggerHooks(db, 'post_save', obs, {});
    assert.equal(calls.length, 0, 'Hook should not fire when condition not met');
  });

  it('should fire hook when condition IS met', async () => {
    const calls = [];
    setSaveFunction(async (opts) => { calls.push(opts); return { id: 1 }; });

    createHook(db, {
      name: 'matching',
      event: 'post_save',
      condition_type: 'type_equals',
      condition_value: 'bug',
      action_type: 'save_memory',
      action_config: { title: 'Bug caught', content: 'triggered', type: 'observation' },
    });

    const obs = {
      id: 2,
      type: 'bug',
      title: 'A real bug',
      content: 'Found a null pointer',
      project_path: '/test',
      tags: '[]',
    };

    await triggerHooks(db, 'post_save', obs, {});
    assert.equal(calls.length, 1, 'Hook should fire when condition met');
  });

  it('should support tag_contains condition', async () => {
    const calls = [];
    setSaveFunction(async (opts) => { calls.push(opts); return { id: 1 }; });

    createHook(db, {
      name: 'tagged',
      event: 'post_save',
      condition_type: 'tag_contains',
      condition_value: 'urgent',
      action_type: 'save_memory',
      action_config: { title: 'Urgent', content: 'tagged urgent', type: 'observation' },
    });

    const obs = {
      id: 3,
      type: 'observation',
      title: 'Urgent fix needed',
      content: 'Fix ASAP',
      project_path: '/test',
      tags: '["urgent","bug"]',
    };

    await triggerHooks(db, 'post_save', obs, {});
    assert.equal(calls.length, 1);
  });

  it('should support importance_gte condition', async () => {
    const calls = [];
    setSaveFunction(async (opts) => { calls.push(opts); return { id: 1 }; });

    createHook(db, {
      name: 'important',
      event: 'post_save',
      condition_type: 'importance_gte',
      condition_value: '8',
      action_type: 'save_memory',
      action_config: { title: 'Important', content: 'high importance item', type: 'observation' },
    });

    // Importance 7 — should NOT trigger
    const obsLow = { id: 4, type: 'observation', title: 'Low', content: 'x', project_path: '/test', tags: '[]', importance: 7 };
    await triggerHooks(db, 'post_save', obsLow, {});
    assert.equal(calls.length, 0);

    // Importance 9 — should trigger
    const obsHigh = { id: 5, type: 'observation', title: 'High', content: 'x', project_path: '/test', tags: '[]', importance: 9 };
    await triggerHooks(db, 'post_save', obsHigh, {});
    assert.equal(calls.length, 1);
  });

  it('should support project_equals condition', async () => {
    const calls = [];
    setSaveFunction(async (opts) => { calls.push(opts); return { id: 1 }; });

    createHook(db, {
      name: 'proj-specific',
      event: 'post_save',
      condition_type: 'project_equals',
      condition_value: '/my-special-project',
      action_type: 'save_memory',
      action_config: { title: 'Special', content: 'special project only', type: 'observation' },
    });

    // Wrong project — should NOT trigger
    const obsWrong = { id: 6, type: 'observation', title: 'Wrong', content: 'x', project_path: '/other', tags: '[]' };
    await triggerHooks(db, 'post_save', obsWrong, {});
    assert.equal(calls.length, 0);

    // Right project — should trigger
    const obsRight = { id: 7, type: 'observation', title: 'Right', content: 'x', project_path: '/my-special-project', tags: '[]' };
    await triggerHooks(db, 'post_save', obsRight, {});
    assert.equal(calls.length, 1);
  });

  afterEach(() => setSaveFunction(null));
});

// ─── Module Exports ───────────────────────────────────────────────────

describe('module exports', () => {
  it('should export VALID_EVENTS', () => {
    assert.ok(VALID_EVENTS.has('pre_save'));
    assert.ok(VALID_EVENTS.has('post_save'));
    assert.ok(VALID_EVENTS.has('pre_edit'));
    assert.ok(VALID_EVENTS.has('post_edit'));
    assert.ok(VALID_EVENTS.has('pre_forget'));
    assert.ok(VALID_EVENTS.has('post_forget'));
    assert.equal(VALID_EVENTS.size, 6);
  });

  it('should export VALID_ACTION_TYPES', () => {
    assert.ok(VALID_ACTION_TYPES.has('save_memory'));
    assert.ok(VALID_ACTION_TYPES.has('log'));
    assert.ok(VALID_ACTION_TYPES.has('webhook'));
    assert.equal(VALID_ACTION_TYPES.size, 3);
  });
});
