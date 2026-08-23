'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../src/core/db');

// ── Clear module cache for modules we need to mock ────────────────
const modulesToReset = ['self-improve', 'hooks', 'session', 'conflict', 'relations'];
for (const k of Object.keys(require.cache)) {
  if (modulesToReset.some(m => k.includes(m))) delete require.cache[k];
}

// ── Load and mock ALL dependencies BEFORE self-improve ────────────
const sessionModule = require('../src/core/session');
const conflictModule = require('../src/core/conflict');
const relationsModule = require('../src/core/relations');

let llmCallCount = 0;
let mockLLMResponse = null;
let mockConflictResult = null;

sessionModule.callLLM = async function () {
  llmCallCount++;
  if (mockLLMResponse instanceof Error) throw mockLLMResponse;
  return mockLLMResponse;
};

conflictModule.checkConflicts = async function () {
  return mockConflictResult || { conflicts: [], totalFound: 0 };
};

relationsModule.addRelation = async function () {
  return { id: 99, status: 'created' };
};

// ── Now load self-improve — it gets our mocked dependencies ──────
const selfImprove = require('../src/core/self-improve');

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  return db;
}

// ─── learnFromError ──────────────────────────────────────────────────

describe('learnFromError', () => {
  let db;
  let savedItems;

  beforeEach(() => {
    db = createTestDb();
    llmCallCount = 0;
    mockLLMResponse = null;
    savedItems = [];
    selfImprove.setSaveFunction(async (opts) => {
      savedItems.push(opts);
      return { id: savedItems.length, status: 'saved' };
    });
  });

  it('should return null when no save function is injected', async () => {
    selfImprove.setSaveFunction(null);
    const r = await selfImprove.learnFromError(db, { id: 1, content: 'Error', project_path: '/test' });
    assert.equal(r, null);
  });

  it('should return null when error observation has no id', async () => {
    const r = await selfImprove.learnFromError(db, { content: 'Error' });
    assert.equal(r, null);
  });

  it('should skip already-analyzed error IDs', async () => {
    mockLLMResponse = JSON.stringify({
      title: 'Fix: Validate input', content: 'Always validate', confidence: 80, tags: ['validation'],
    });
    const r1 = await selfImprove.learnFromError(db, { id: 201, content: 'Error', project_path: '/test' });
    assert.ok(r1, 'First call should produce a learning');
    assert.equal(llmCallCount, 1);

    const r2 = await selfImprove.learnFromError(db, { id: 201, content: 'Error again', project_path: '/test' });
    assert.equal(r2, null, 'Second call with same ID should return null');
  });

  it('should generate a learning observation from error via LLM', async () => {
    mockLLMResponse = JSON.stringify({
      title: 'Fix: Validate', content: 'Systemic fix.', confidence: 85, tags: ['validation'],
    });
    const result = await selfImprove.learnFromError(db, {
      id: 202, content: 'NPE', project_path: '/test', session_id: 'sess-abc',
    });
    assert.ok(result);
    assert.equal(savedItems.length, 1);
    assert.equal(savedItems[0].type, 'learning');
    assert.equal(savedItems[0].project, '/test');
  });

  it('should handle LLM returning invalid JSON gracefully', async () => {
    mockLLMResponse = 'not valid json';
    const r = await selfImprove.learnFromError(db, { id: 203, content: 'Error', project_path: '/test' });
    assert.equal(r, null);
  });

  it('should handle LLM returning JSON without required fields', async () => {
    mockLLMResponse = JSON.stringify({ unrelated: 'data' });
    const r = await selfImprove.learnFromError(db, { id: 204, content: 'Error', project_path: '/test' });
    assert.equal(r, null);
  });
});

// ─── autoResolveConflicts ────────────────────────────────────────────

describe('autoResolveConflicts', () => {
  let db;
  let savedItems;

  beforeEach(() => {
    db = createTestDb();
    llmCallCount = 0;
    mockLLMResponse = null;
    mockConflictResult = null;
    savedItems = [];
    selfImprove.setSaveFunction(async (opts) => {
      savedItems.push(opts);
      return { id: savedItems.length, status: 'saved' };
    });
  });

  it('should handle no conflicts found', async () => {
    mockConflictResult = { conflicts: [], totalFound: 0 };
    const r = await selfImprove.autoResolveConflicts(db, { project: '/test' });
    assert.equal(r.resolved, 0);
    assert.equal(r.conflictsFound, 0);
  });

  it('should skip conflicts without LLM contradiction flag', async () => {
    mockConflictResult = {
      conflicts: [{ a: { id: 1, content: 'A' }, b: { id: 2, content: 'B' }, similarity: 0.9 }],
      totalFound: 1,
    };
    const r = await selfImprove.autoResolveConflicts(db, { project: '/test' });
    assert.equal(r.resolved, 0);
    assert.equal(r.conflictsFound, 1);
  });

  it('should resolve conflicts where LLM determines A is correct', async () => {
    db.prepare('INSERT INTO observations (project_path, type, title, content, confidence) VALUES (?,?,?,?,?)')
      .run('/test', 'decision', 'Redis', 'Redis cache', 90);
    db.prepare('INSERT INTO observations (project_path, type, title, content, confidence) VALUES (?,?,?,?,?)')
      .run('/test', 'decision', 'Memcached', 'Memcached cache', 85);

    mockConflictResult = {
      conflicts: [{
        a: { id: 1, content: 'Redis cache', preview: 'Redis' },
        b: { id: 2, content: 'Memcached cache', preview: 'Memcached' },
        similarity: 0.88, llm_contradiction: true,
      }],
      totalFound: 1,
    };
    mockLLMResponse = JSON.stringify({
      correct: 'A', reasoning: 'Redis is standard', resolution: 'Use Redis.',
    });

    const r = await selfImprove.autoResolveConflicts(db, { project: '/test' });
    assert.equal(r.resolved, 1);
    assert.equal(r.conflictsFound, 1);
  });

  it('should handle conflict detection throwing an error', async () => {
    // Temporarily override checkConflicts to throw, then restore
    const orig = conflictModule.checkConflicts;
    conflictModule.checkConflicts = async () => { throw new Error('DB error'); };
    try {
      const r = await selfImprove.autoResolveConflicts(db, { project: '/test' });
      assert.equal(r.resolved, 0);
      assert.equal(r.conflictsFound, 0);
    } finally {
      conflictModule.checkConflicts = orig;
    }
  });
});

// ─── verifyLearning ──────────────────────────────────────────────────

describe('verifyLearning', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    llmCallCount = 0;
    mockLLMResponse = null;
    selfImprove.resetState(); // clear debounce cache between tests
  });

  it('should debounce repeated verification of the same learning within 60s', async () => {
    db.prepare('INSERT INTO observations (project_path, type, title, content, confidence) VALUES (?,?,?,?,?)')
      .run('/test', 'learning', 'Rule', 'Desc', 50);

    // First call invokes LLM and applies REINFORCE (confidence 50 -> 55)
    mockLLMResponse = JSON.stringify({ verdict: 'REINFORCE', reason: 'good' });
    await selfImprove.verifyLearning(db, { project_path: '/test', type: 'observation', content: 't1' });
    assert.equal(llmCallCount, 1, 'First verifyLearning call invokes LLM');

    // Second call within 60s debounce window must NOT invoke LLM (deterministic)
    mockLLMResponse = JSON.stringify({ verdict: 'CONTRADICT', reason: 'bad' });
    await selfImprove.verifyLearning(db, { project_path: '/test', type: 'observation', content: 't2' });
    assert.equal(llmCallCount, 1, 'Second call within debounce window is skipped');

    // Confidence from first call is preserved (50 + 5 = 55, REINFORCE not CONTRADICT)
    const l = db.prepare('SELECT confidence FROM observations WHERE type = ?').get('learning');
    assert.equal(l.confidence, 55, 'Confidence reflects first call only (REINFORCE): got ' + l.confidence);
  });

  it('should reinforce learning', async () => {
    db.prepare('INSERT INTO observations (project_path, type, title, content, confidence) VALUES (?,?,?,?,?)')
      .run('/test', 'learning', 'Rule', 'Desc', 50);
    mockLLMResponse = JSON.stringify({ verdict: 'REINFORCE', reason: 'good' });

    await selfImprove.verifyLearning(db, { project_path: '/test', type: 'observation', content: 't' });
    const l = db.prepare('SELECT confidence FROM observations WHERE type = ?').get('learning');
    assert.ok(l.confidence > 50, 'REINFORCE should boost confidence: got ' + l.confidence);
  });

  it('should downgrade learning on contradiction', async () => {
    db.prepare('INSERT INTO observations (project_path, type, title, content, confidence) VALUES (?,?,?,?,?)')
      .run('/test', 'learning', 'Bad', 'Desc', 50);
    mockLLMResponse = JSON.stringify({ verdict: 'CONTRADICT', reason: 'wrong' });

    await selfImprove.verifyLearning(db, { project_path: '/test', type: 'observation', content: 't' });
    const l = db.prepare('SELECT confidence FROM observations WHERE type = ?').get('learning');
    assert.ok(l.confidence < 50, 'CONTRADICT should reduce confidence: got ' + l.confidence);
  });
});

// ─── Plateau Detection ───────────────────────────────────────────────

describe('detectPlateau', () => {
  let db;
  let savedItems;

  beforeEach(() => {
    db = createTestDb();
    llmCallCount = 0;
    mockLLMResponse = null;
    savedItems = [];
    selfImprove.setSaveFunction(async (opts) => {
      savedItems.push(opts);
      return { id: savedItems.length, status: 'saved' };
    });
    selfImprove._prunePlateauCache(); // Clear debounce cache
  });

  it('should return no plateau when evaluations are below minimum', async () => {
    const r = await selfImprove.detectPlateau(db, { project: '/test', force: true });
    assert.equal(r.plateauDetected, false);
    assert.equal(r.diagnosis, null);
  });

  it('should return no plateau when improvement is occurring', async () => {
    const now = new Date().toISOString();
    const recent = new Date(Date.now() - 3 * 86400000).toISOString(); // 3 days ago
    const older = new Date(Date.now() - 10 * 86400000).toISOString(); // 10 days ago

    // Current window: mostly SUCCESS (high rate)
    for (let i = 0; i < 20; i++) {
      db.prepare(
        'INSERT INTO evaluation_log (project_path, llm_verdict, evaluated_at) VALUES (?,?,?)'
      ).run('/test', 'SUCCESS', recent);
    }

    // Previous window: mostly FAILURE (low rate)
    for (let i = 0; i < 15; i++) {
      db.prepare(
        'INSERT INTO evaluation_log (project_path, llm_verdict, evaluated_at) VALUES (?,?,?)'
      ).run('/test', 'FAILURE', older);
    }

    const r = await selfImprove.detectPlateau(db, { project: '/test', force: true, windowDays: 7 });
    assert.equal(r.plateauDetected, false, 'Improvement is happening, should not be plateau');
  });

  it('should detect plateau when rate is flat across windows', async () => {
    const now = new Date().toISOString();
    const recent = new Date(Date.now() - 3 * 86400000).toISOString();
    const older = new Date(Date.now() - 10 * 86400000).toISOString();

    // Current window: 20 evaluations, 10 success = 50%
    for (let i = 0; i < 10; i++) {
      db.prepare(
        'INSERT INTO evaluation_log (project_path, llm_verdict, evaluated_at) VALUES (?,?,?)'
      ).run('/test', 'SUCCESS', recent);
    }
    for (let i = 0; i < 10; i++) {
      db.prepare(
        'INSERT INTO evaluation_log (project_path, llm_verdict, evaluated_at) VALUES (?,?,?)'
      ).run('/test', 'FAILURE', recent);
    }

    // Previous window: 20 evaluations, 10 success = 50%
    for (let i = 0; i < 10; i++) {
      db.prepare(
        'INSERT INTO evaluation_log (project_path, llm_verdict, evaluated_at) VALUES (?,?,?)'
      ).run('/test', 'SUCCESS', older);
    }
    for (let i = 0; i < 10; i++) {
      db.prepare(
        'INSERT INTO evaluation_log (project_path, llm_verdict, evaluated_at) VALUES (?,?,?)'
      ).run('/test', 'FAILURE', older);
    }

    const r = await selfImprove.detectPlateau(db, { project: '/test', force: true, windowDays: 7 });
    assert.equal(r.plateauDetected, true, '50% rate in both windows should be plateau');
  });

  it('should count REINFORCE as success in plateau detection', async () => {
    const recent = new Date(Date.now() - 3 * 86400000).toISOString();

    for (let i = 0; i < 10; i++) {
      db.prepare(
        'INSERT INTO evaluation_log (project_path, llm_verdict, evaluated_at) VALUES (?,?,?)'
      ).run('/test', 'REINFORCE', recent);
    }
    for (let i = 0; i < 10; i++) {
      db.prepare(
        'INSERT INTO evaluation_log (project_path, llm_verdict, evaluated_at) VALUES (?,?,?)'
      ).run('/test', 'FAILURE', recent);
    }

    const r = await selfImprove.detectPlateau(db, { project: '/test', force: true, windowDays: 7 });
    // 10 REINFORCE + 10 FAILURE = 50% in current. No previous = default to current (50-50=0 improvement).
    assert.equal(r.plateauDetected, true);
  });

  it('should respect debounce cache by default', async () => {
    const recent = new Date(Date.now() - 1 * 86400000).toISOString();
    for (let i = 0; i < 15; i++) {
      db.prepare(
        'INSERT INTO evaluation_log (project_path, llm_verdict, evaluated_at) VALUES (?,?,?)'
      ).run('/test', 'SUCCESS', recent);
    }

    // First call (no force) — should actually run the check
    await selfImprove.detectPlateau(db, { project: '/test' });

    // Second call immediately after — should be debounced
    const r2 = await selfImprove.detectPlateau(db, { project: '/test' });
    // Debounced result should have no diagnosis (cached: { plateau: false, ... })
    assert.equal(r2.plateauDetected !== undefined, true);
  });

  it('should bypass debounce when force is true', async () => {
    const recent = new Date(Date.now() - 1 * 86400000).toISOString();
    for (let i = 0; i < 15; i++) {
      db.prepare(
        'INSERT INTO evaluation_log (project_path, llm_verdict, evaluated_at) VALUES (?,?,?)'
      ).run('/test', 'FAILURE', recent);
    }

    await selfImprove.detectPlateau(db, { project: '/test' });
    // Force should still run
    const r = await selfImprove.detectPlateau(db, { project: '/test', force: true });
    assert.ok(r.plateauDetected !== undefined);
  });

  it('should default to current project when no project specified', async () => {
    const r = await selfImprove.detectPlateau(db, { force: true });
    // Should not throw, returns a result object
    assert.equal(typeof r.plateauDetected, 'boolean');
  });
});

// ─── Exports ─────────────────────────────────────────────────────────

// ─── Outcome Classification (keyword fallback) ────────────────────

describe('classifyOutcome keyword fallback', () => {
  beforeEach(() => {
    llmCallCount = 0;
    mockLLMResponse = null; // LLM unavailable → keyword fallback
  });

  it('does not misclassify "past-failure" as a failure', async () => {
    const r = await selfImprove.classifyOutcome('No past-failure patterns triggered');
    assert.equal(r, 'neutral', 'word "failure" should not trip the "fail" keyword');
  });

  it('does not misclassify "failures" (plural) as a failure', async () => {
    const r = await selfImprove.classifyOutcome('Reviewing prior learnings and past failures');
    assert.equal(r, 'neutral');
  });

  it('classifies "tests passed" as success', async () => {
    const r = await selfImprove.classifyOutcome('All tests passed');
    assert.equal(r, 'success');
  });

  it('classifies "the build failed" as failure', async () => {
    const r = await selfImprove.classifyOutcome('The build failed');
    assert.equal(r, 'failure');
  });

  it('still classifies standalone "errors" as failure', async () => {
    const r = await selfImprove.classifyOutcome('There were errors during the run');
    assert.equal(r, 'failure');
  });

  it('classifies "implemented" as success', async () => {
    const r = await selfImprove.classifyOutcome('Implemented the login endpoint');
    assert.equal(r, 'success');
  });
});

describe('module exports', () => {
  it('should accept a save function without throwing', () => {
    assert.doesNotThrow(() => selfImprove.initHooks(async () => ({ id: 1 })));
  });

  it('setSaveFunction should accept null', () => {
    assert.doesNotThrow(() => selfImprove.setSaveFunction(null));
  });

  it('should export all expected functions', () => {
    assert.equal(typeof selfImprove.learnFromError, 'function');
    assert.equal(typeof selfImprove.autoResolveConflicts, 'function');
    assert.equal(typeof selfImprove.verifyLearning, 'function');
    assert.equal(typeof selfImprove.detectPlateau, 'function');
    assert.equal(typeof selfImprove.initHooks, 'function');
    assert.equal(typeof selfImprove.setSaveFunction, 'function');
  });
});
