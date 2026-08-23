'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../src/core/db');
const recovery = require('../src/core/recovery');

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  return db;
}

// ─── Condition classification ──────────────────────────────────────

describe('classifyCondition', () => {
  it('classifies network errors', () => {
    assert.equal(recovery.classifyCondition('ECONNREFUSED: connection refused'), 'network');
    assert.equal(recovery.classifyCondition('request timed out'), 'network');
  });

  it('classifies file errors', () => {
    assert.equal(recovery.classifyCondition('ENOENT: no such file or directory'), 'file');
  });

  it('classifies element errors', () => {
    assert.equal(recovery.classifyCondition('element is not clickable'), 'element');
  });

  it('classifies app errors', () => {
    assert.equal(recovery.classifyCondition('server crashed with exit code 1'), 'app');
  });

  it('classifies auth errors', () => {
    assert.equal(recovery.classifyCondition('401 Unauthorized'), 'auth');
  });

  it('classifies parse errors', () => {
    assert.equal(recovery.classifyCondition('Unexpected token in JSON at position 5'), 'parse');
  });

  it('returns unknown when nothing matches', () => {
    assert.equal(recovery.classifyCondition('something went wrong'), 'unknown');
  });
});

// ─── Probe-gated retry ─────────────────────────────────────────────

describe('probe-gated retry', () => {
  let db;

  beforeEach(() => { db = createTestDb(); });

  it('records a failure with a classified condition and seeds probe state', () => {
    const r = recovery.recordFailure(db, { project: '/p', errorId: 1, errorText: 'connection refused' });
    assert.equal(r.condition, 'network');
    assert.equal(r.occurrences, 1);
    assert.equal(r.changed, true);

    const row = db.prepare("SELECT * FROM condition_states WHERE project_path = '/p'").get();
    assert.equal(row.condition, 'network');
    assert.equal(row.last_probe_ok, 0);
    assert.equal(row.resolved, 0);
  });

  it('increments occurrences on repeated failures of the same condition', () => {
    recovery.recordFailure(db, { project: '/p', errorText: 'connection refused' });
    const r2 = recovery.recordFailure(db, { project: '/p', errorText: 'connection refused again' });
    assert.equal(r2.occurrences, 2);
    assert.equal(r2.changed, false);
  });

  it('respects an explicit condition override', () => {
    const r = recovery.recordFailure(db, { project: '/p', errorText: 'whatever', condition: 'auth' });
    assert.equal(r.condition, 'auth');
  });

  it('offers retry only when the probe confirms the cause changed', async () => {
    recovery.recordFailure(db, { project: '/p', errorText: 'connection refused' });

    // Cause still present → no retry
    const r1 = await recovery.shouldRetry(db, {
      project: '/p', condition: 'network', check: async () => ({ ok: false, detail: 'still down' }),
    });
    assert.equal(r1.retry, false);
    assert.equal(r1.changed, false);
    assert.equal(r1.reason, 'cause-still-present');

    // Cause now gone → corrected re-run is offered
    const r2 = await recovery.shouldRetry(db, {
      project: '/p', condition: 'network', check: async () => ({ ok: true, detail: 'back online' }),
    });
    assert.equal(r2.retry, true);
    assert.equal(r2.changed, true);
    assert.equal(r2.reason, 'cause-changed');
  });

  it('does not offer retry when no failure was recorded', async () => {
    const r = await recovery.shouldRetry(db, {
      project: '/p', condition: 'network', check: async () => ({ ok: true }),
    });
    assert.equal(r.retry, false);
    assert.equal(r.reason, 'no-failure-recorded');
  });

  it('requires a check function', async () => {
    await assert.rejects(
      () => recovery.shouldRetry(db, { project: '/p', condition: 'network' }),
      /check function is required/,
    );
  });
});

// ─── LLM negative cache ────────────────────────────────────────────

describe('LLM negative cache', () => {
  let db;

  beforeEach(() => { db = createTestDb(); });

  it('round-trips a cached result and counts hits', () => {
    assert.equal(recovery.getCachedLLM(db, 'op', 'input'), null);
    recovery.cacheLLM(db, 'op', 'input', { outcome: 'success' }, 'ok');

    const hit = recovery.getCachedLLM(db, 'op', 'input');
    assert.deepEqual(hit.result, { outcome: 'success' });
    assert.equal(hit.status, 'ok');
    assert.equal(hit.hitCount, 1);

    const again = recovery.getCachedLLM(db, 'op', 'input');
    assert.equal(again.hitCount, 2);
  });

  it('caches null (negative/fallback) results deterministically', () => {
    recovery.cacheLLM(db, 'op', 'bad input', null, 'fallback');
    const hit = recovery.getCachedLLM(db, 'op', 'bad input');
    assert.equal(hit.result, null);
    assert.equal(hit.status, 'fallback');
  });

  it('distinguishes operations and inputs', () => {
    recovery.cacheLLM(db, 'a', 'x', 'res-a', 'ok');
    recovery.cacheLLM(db, 'b', 'x', 'res-b', 'ok');
    recovery.cacheLLM(db, 'a', 'y', 'res-y', 'ok');

    assert.equal(recovery.getCachedLLM(db, 'a', 'x').result, 'res-a');
    assert.equal(recovery.getCachedLLM(db, 'b', 'x').result, 'res-b');
    assert.equal(recovery.getCachedLLM(db, 'a', 'y').result, 'res-y');
    assert.equal(recovery.getCachedLLM(db, 'b', 'y'), null);
  });

  it('clearLLMCache empties the cache', () => {
    recovery.cacheLLM(db, 'op', 'x', 'r', 'ok');
    recovery.clearLLMCache(db);
    assert.equal(recovery.getCachedLLM(db, 'op', 'x'), null);
  });
});

// ─── Counter-evidence decay ────────────────────────────────────────

describe('counter-evidence decay', () => {
  let db;

  beforeEach(() => { db = createTestDb(); });

  function seedError(id, title, tags) {
    db.prepare('INSERT INTO observations (project_path, type, title, content, tags) VALUES (?,?,?,?,?)')
      .run('/p', 'error', title, title + ' failure', JSON.stringify(tags || []));
  }

  it('registers an error lesson with count 1', () => {
    seedError(1, 'NPE in parser');
    const r = recovery.registerFailure(db, { project: '/p', errorObs: { id: 1 } });
    assert.equal(r.errorId, 1);
    assert.equal(r.lessonCount, 1);
    assert.equal(r.deleted, false);
  });

  it('returns null when the error has no id', () => {
    assert.equal(recovery.registerFailure(db, { errorObs: {} }), null);
  });

  it('increments lesson count on repeated failure', () => {
    seedError(1, 'NPE in parser');
    recovery.registerFailure(db, { errorObs: { id: 1 } });
    const r2 = recovery.registerFailure(db, { errorObs: { id: 1 } });
    assert.equal(r2.lessonCount, 2);
  });

  it('decrements and deactivates an error when a matching success arrives', () => {
    seedError(1, 'NPE in parser');
    recovery.registerFailure(db, { errorObs: { id: 1 } });

    const results = recovery.applyCounterEvidence(db, {
      project: '/p',
      successObs: { content: 'Fixed the NPE in parser', tags: [] },
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].deleted, true);
    assert.equal(results[0].lessonCount, 0);

    const obs = db.prepare('SELECT is_active FROM observations WHERE id = 1').get();
    assert.equal(obs.is_active, 0, 'error observation should be deactivated');
    assert.equal(db.prepare('SELECT * FROM failure_decay WHERE error_id = 1').get(), undefined);
  });

  it('decrements but does not delete when lesson count is above one', () => {
    seedError(1, 'NPE in parser');
    recovery.registerFailure(db, { errorObs: { id: 1 } });
    recovery.registerFailure(db, { errorObs: { id: 1 } });

    const results = recovery.applyCounterEvidence(db, {
      project: '/p',
      successObs: { content: 'Fixed the NPE in parser', tags: [] },
    });

    assert.equal(results[0].deleted, false);
    assert.equal(results[0].lessonCount, 1);
    assert.equal(db.prepare('SELECT is_active FROM observations WHERE id = 1').get().is_active, 1);
  });

  it('matches on shared tags even when the title is absent from content', () => {
    seedError(1, 'Redis connection error', ['bug']);
    recovery.registerFailure(db, { errorObs: { id: 1 } });

    const results = recovery.applyCounterEvidence(db, {
      project: '/p',
      successObs: { content: 'Deployed a fix', tags: ['bug'] },
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].deleted, true);
  });

  it('ignores unrelated successes', () => {
    seedError(1, 'NPE in parser');
    recovery.registerFailure(db, { errorObs: { id: 1 } });

    const results = recovery.applyCounterEvidence(db, {
      project: '/p',
      successObs: { content: 'Unrelated feature shipped', tags: [] },
    });

    assert.equal(results.length, 0);
    assert.equal(db.prepare('SELECT is_active FROM observations WHERE id = 1').get().is_active, 1);
  });
});
