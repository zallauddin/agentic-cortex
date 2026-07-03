'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../src/core/db');

// ─── MOCK SETUP: Replace LLM, embeddings, DB BEFORE API loads ──────
const modulesToReset = [
  'self-improve', 'hooks', 'session', 'conflict', 'relations',
  'reflection', 'embedding', 'search', 'db',
  'api/index', 'core/index',
];
for (const k of Object.keys(require.cache)) {
  if (modulesToReset.some(m => k.includes(m))) delete require.cache[k];
}

const sessionModule = require('../src/core/session');
const embeddingModule = require('../src/core/embedding');
const conflictModule = require('../src/core/conflict');
const relationsModule = require('../src/core/relations');
const dbModule = require('../src/core/db');

let llmCallCount = 0;
let mockLLMResponse = null;

sessionModule.callLLM = async function () {
  llmCallCount++;
  if (mockLLMResponse instanceof Error) throw mockLLMResponse;
  return mockLLMResponse;
};

embeddingModule.computeEmbedding = async function (text) {
  const vec = [];
  for (let i = 0; i < 8; i++) vec.push(((text.charCodeAt(i % text.length) || 0) / 255));
  return vec;
};

let mockConflictResult = null;
conflictModule.checkConflicts = async function () {
  return mockConflictResult || { conflicts: [], totalFound: 0 };
};

let relationCalls = [];
relationsModule.addRelation = async function (db, opts) {
  try {
    const r = db.prepare(
      'INSERT INTO memory_relations (source_id, target_id, relation_type, confidence) VALUES (?,?,?,?)'
    ).run(opts.sourceId, opts.targetId, opts.relationType || 'related_to', opts.confidence || 100);
    relationCalls.push(opts);
    return { id: Number(r.lastInsertRowid), status: 'created' };
  } catch { return { id: -1, status: 'skipped' }; }
};

let testDb = null;
dbModule.getDb = function () {
  if (testDb) return testDb;
  throw new Error('No test DB set');
};

const api = require('../src/api');
const selfImproveMod = require('../src/core/self-improve');

function createTestDb() {
  testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  testDb.pragma('foreign_keys = ON');
  ensureSchema(testDb);
  return testDb;
}

// ════════════════════════════════════════════════════════════════════

describe('Save Search Reflect Pipeline', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    llmCallCount = 0;
    mockLLMResponse = null;
    mockConflictResult = null;
    relationCalls = [];
    selfImproveMod.resetState(); // Clear persisted _analyzedErrorIds
    api.close(); // Critical: reset internal _apiDb to pick up new test DB
    api.init();
  });

  afterEach(() => {
    try { api.close(); } catch {}
  });

  it('should save observations and retrieve them via search', async () => {
    await api.save({ title: 'Redis Cache', content: 'Use Redis for caching layer', project: '/int-test', type: 'decision' });
    await api.save({ title: 'PostgreSQL', content: 'Use PostgreSQL for primary DB', project: '/int-test', type: 'decision' });
    await api.save({ title: 'Rate Limiting', content: 'Add rate limiting to API endpoints', project: '/int-test', type: 'observation' });

    const results = await api.search('Redis', { project: '/int-test' });
    assert.ok(results.length >= 1);
    assert.ok(results.some(r => r.title === 'Redis Cache'));

    const list = api.list({ project: '/int-test', limit: 10 });
    assert.equal(list.length, 3);
  });

  it('should save with embeddings and enable search', async () => {
    const r1 = await api.save({ title: 'Redis', content: 'Redis cache', project: '/int-test' });
    assert.ok(r1.embedded, 'Should auto-embed via mock');
    const obs1 = api.get(r1.id);
    assert.ok(obs1.has_embedding);
    const results = await api.search('Redis cache', { project: '/int-test' });
    assert.ok(results.length >= 1);
  });

  it('should save, edit, and track version history', async () => {
    const saved = await api.save({ title: 'Original', content: 'Original content', project: '/int-test', type: 'fact' });
    const edited = await api.edit(saved.id, { title: 'Updated', content: 'Updated content', confidence: 80 });
    assert.equal(edited.title, 'Updated');
    assert.equal(edited.status, 'edited');
    assert.ok(edited.versionCount >= 1);
  });

  it('should save, forget (soft-delete), and exclude from search', async () => {
    const saved = await api.save({ title: 'Temp', content: 'Temporary note', project: '/int-test' });
    await api.forget(saved.id);
    // get() returns the observation even after soft-delete (it has is_active=0)
    const forgotten = api.get(saved.id);
    assert.ok(forgotten, 'Soft-deleted observation is still retrievable by ID');
    assert.equal(forgotten.is_active, 0, 'is_active should be 0 after soft-delete');
    // But it should be excluded from search
    const results = await api.search('Temporary', { project: '/int-test' });
    assert.equal(results.filter(r => r.id === saved.id).length, 0);
  });

  it('should generate context markdown from saved observations', async () => {
    await api.save({ title: 'Important Decision', content: 'Chose SQLite for persistent storage', project: '/int-test', importance: 10, type: 'decision' });
    const ctx = api.context({ project: '/int-test' });
    assert.ok(typeof ctx === 'string');
    assert.ok(ctx.includes('SQLite') || ctx.includes('Important Decision'));
  });

  it('should report accurate health stats', async () => {
    await api.save({ title: 'Test', content: 'Content', project: '/int-test' });
    await api.save({ title: 'Test 2', content: 'Content 2', project: '/int-test' });
    const h = api.health();
    assert.equal(h.status, 'ok');
    assert.equal(h.observations.total, 2);
    assert.equal(h.observations.active, 2);
  });

  it('should create and traverse memory relations', async () => {
    const a = await api.save({ title: 'Redis Setup', content: 'Install Redis', project: '/int-test' });
    const b = await api.save({ title: 'Redis Config', content: 'Redis config details', project: '/int-test' });
    await api.addRelation({ sourceId: a.id, targetId: b.id, relationType: 'depends_on' });
    const graph = api.getGraph({ observationId: a.id, depth: 1 });
    assert.ok('nodes' in graph);
    assert.ok(graph.nodes.some(n => n.id === b.id));
  });

  it('should run reflection cycle without errors', async () => {
    await api.save({ title: 'Pattern A', content: 'Cache pattern', project: '/int-test' });
    await api.save({ title: 'Pattern B', content: 'Cache pattern again', project: '/int-test' });
    const result = await api.reflect({ project: '/int-test', dryRun: true });
    assert.ok('consolidate' in result);
    assert.ok('promote' in result);
    assert.ok('archive' in result);
  });

  it('should export and re-import observations', async () => {
    const saved = await api.save({ title: 'Exportable', content: 'For export', project: '/int-test', type: 'fact', confidence: 95 });
    const exported = api.exportJSON({ project: '/int-test' });
    const found = exported.observations.find(o => o.title === 'Exportable');
    assert.ok(found, 'Export should contain the saved observation');
    const imported = await api.importJSON(exported.observations, { project: '/int-import' });
    assert.ok(imported.saved >= 1);
  });
});

// ════════════════════════════════════════════════════════════════════

describe('Self-Improve Loop Integration', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    llmCallCount = 0;
    mockLLMResponse = null;
    mockConflictResult = null;
    relationCalls = [];
    selfImproveMod.resetState(); // Clear persisted _analyzedErrorIds
    api.close();
    api.init();
  });

  afterEach(() => {
    try { api.close(); } catch {}
  });

  it('should trigger learnFromError when saving an error observation', async () => {
    mockLLMResponse = JSON.stringify({
      title: 'Fix: Add null check',
      content: 'Systemic fix: validate array bounds.',
      confidence: 85,
      tags: ['validation'],
    });

    await api.save({
      title: 'IndexOutOfBounds in parser.ts',
      content: 'Got IndexOutOfBoundsException at parser.ts line 142.',
      type: 'error',
      project: '/int-test',
      importance: 9,
      tags: ['bug', 'parser'],
    });

    assert.ok(llmCallCount >= 1, 'LLM should have been called for RCA');

    const learnings = api.list({ project: '/int-test', type: 'learning' });
    assert.ok(learnings.length >= 1, 'RCA should produce a learning observation');
    assert.ok(learnings[0].title.includes('null check') || learnings[0].title.includes('Fix'));
  });

  it('should create derives_from relation between learning and error', async () => {
    mockLLMResponse = JSON.stringify({
      title: 'Fix: Handle null pointers',
      content: 'Always null-check before dereferencing.',
      confidence: 80,
      tags: ['null-safety'],
    });

    const errorObs = await api.save({
      title: 'NullPointerException', content: 'NPE in handler.ts', type: 'error', project: '/int-test',
    });

    // learnFromError should have been triggered by post_save hook
    assert.ok(llmCallCount >= 1, 'LLM should have been called');

    // The learning observation should exist in the DB
    const allObs = db.prepare('SELECT * FROM observations WHERE type = ? AND project_path = ?').all('learning', '/int-test');
    assert.ok(allObs.length >= 1, `Should produce a learning observation, got ${allObs.length}`);

    // Check relations via direct DB query
    const relations = db.prepare('SELECT * FROM memory_relations WHERE relation_type = ?').all('derives_from');
    assert.ok(relations.length >= 1, 'Should have derives_from relation');
  });

  it('should resolve conflicting observations', async () => {
    await api.save({ title: 'Use Redis', content: 'Redis for caching', project: '/int-test', type: 'decision', confidence: 90 });
    await api.save({ title: 'Use Memcached', content: 'Memcached for caching', project: '/int-test', type: 'decision', confidence: 85 });

    mockConflictResult = {
      conflicts: [{
        a: { id: 1, content: 'Redis for caching', preview: 'Use Redis' },
        b: { id: 2, content: 'Memcached for caching', preview: 'Use Memcached' },
        similarity: 0.88, llm_contradiction: true,
      }],
      totalFound: 1,
    };

    mockLLMResponse = JSON.stringify({ correct: 'A', reasoning: 'Redis is better', resolution: 'Use Redis.' });

    const result = await api.checkConflicts({ project: '/int-test', autoResolve: true });
    assert.ok(result.conflicts.length >= 1);
  });
});

// ════════════════════════════════════════════════════════════════════

describe('Hooks Pipeline Integration', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    llmCallCount = 0;
    mockLLMResponse = null;
    relationCalls = [];
    selfImproveMod.resetState(); // Clear persisted _analyzedErrorIds
    api.close();
    api.init();
  });

  afterEach(() => {
    try { api.close(); } catch {}
  });

  it('should fire persisted hooks on save', async () => {
    api.createHook({
      name: 'auto-log' + Date.now(),
      event: 'post_save',
      action_type: 'log',
      action_config: { message: 'Saved: {{title}}' },
    });

    await api.save({ title: 'Hooked', content: 'Hook test', project: '/int-test' });
    const results = api.list({ project: '/int-test' });
    assert.ok(results.length >= 1);
  });

  it('should fire pre_save and post_save in-memory hooks in order', async () => {
    const calls = [];
    api.registerHook('pre_save', async () => { calls.push('pre'); });
    api.registerHook('post_save', async () => { calls.push('post'); });

    await api.save({ title: 'Hook Test', content: 'Testing hooks', project: '/int-test' });
    assert.deepEqual(calls, ['pre', 'post']);
  });
});

// ════════════════════════════════════════════════════════════════════

describe('Multi-Agent Integration', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    llmCallCount = 0;
    mockLLMResponse = null;
    relationCalls = [];
    selfImproveMod.resetState(); // Clear persisted _analyzedErrorIds
    api.close();
    api.init();
  });

  afterEach(() => {
    try { api.close(); } catch {}
  });

  it('should share memories between agents', async () => {
    api.startAgentSession({ agentId: 'agent-a', sessionId: 'sess-a', project: '/int-test' });
    const obs = await api.save({ title: 'Shared finding', content: 'Important', project: '/int-test', agentId: 'agent-a' });

    api.shareMemory({ observationId: obs.id, sharedWith: ['agent-b'] });
    api.startAgentSession({ agentId: 'agent-b', sessionId: 'sess-b', project: '/int-test' });

    const shared = api.getSharedMemories('agent-b', { project: '/int-test' });
    assert.ok(Array.isArray(shared));
  });

  it('should list and end agent sessions', () => {
    api.startAgentSession({ agentId: 'agent-x', sessionId: 's1', project: '/int-test', role: 'coder' });
    api.startAgentSession({ agentId: 'agent-y', sessionId: 's2', project: '/int-test', role: 'reviewer' });

    const sessions = api.listAgentSessions({ project: '/int-test' });
    assert.ok(sessions.length >= 2);

    const ended = api.endAgentSession('agent-x', 's1');
    assert.equal(ended.status, 'ended');
  });
});

// ════════════════════════════════════════════════════════════════════

describe('CRUD Lifecycle Integration', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    selfImproveMod.resetState(); // Clear persisted _analyzedErrorIds
    api.close();
    api.init();
  });

  afterEach(() => {
    try { api.close(); } catch {}
  });

  it('should handle full CRUD: save get edit forget', async () => {
    const saved = await api.save({ title: 'Lifecycle', content: 'Testing', project: '/int-test', type: 'fact', confidence: 90 });
    assert.equal(api.get(saved.id).title, 'Lifecycle');

    const edited = await api.edit(saved.id, { title: 'Updated', confidence: 75 });
    assert.equal(edited.title, 'Updated');

    await api.forget(saved.id);
    // get() returns observation even after soft-delete; check is_active
    const forgotten = api.get(saved.id);
    assert.equal(forgotten.is_active, 0);
  });

  it('should handle sessions: start list end', () => {
    const sess = api.startSession({ project: '/int-test', name: 'Test', prompt: 'Testing' });
    assert.ok(sess.session_id);

    const sessions = api.listSessions({ project: '/int-test' });
    assert.ok(sessions.length >= 1);

    assert.equal(api.endSession(sess.session_id, 'Done').status, 'ended');
  });

  it('should handle skills with structured fields', async () => {
    const saved = await api.save({
      title: 'Setup PG', content: 'PostgreSQL setup', type: 'instruction', project: '/int-test',
      steps: ['Install', 'Create DB', 'Migrate'],
      triggers: ['New project'],
      preconditions: ['Node.js'],
      postconditions: ['DB running'],
    });

    const fetched = api.get(saved.id);
    assert.deepEqual(fetched.steps, ['Install', 'Create DB', 'Migrate']);

    const skills = await api.searchSkills({ query: 'PostgreSQL', project: '/int-test' });
    assert.ok(Array.isArray(skills));
  });
});

// ─── Cleanup ──────────────────────────────────────────────────────────
afterEach(() => {
  testDb = null;
  llmCallCount = 0;
  mockLLMResponse = null;
  mockConflictResult = null;
  relationCalls = [];
  try { api.close(); } catch {}
});
