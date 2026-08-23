'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../src/core/db');

// ─── MOCK SETUP (mirrors integration.test.js so api loads against a test DB) ──
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

sessionModule.callLLM = async function () { return null; };
embeddingModule.computeEmbedding = async function (text) {
  const vec = [];
  for (let i = 0; i < 8; i++) vec.push(((text.charCodeAt(i % text.length) || 0) / 255));
  return vec;
};
conflictModule.checkConflicts = async function () { return { conflicts: [], totalFound: 0 }; };
relationsModule.addRelation = async function () { return { id: 1, status: 'created' }; };

let testDb = null;
dbModule.getDb = function () {
  if (testDb) return testDb;
  throw new Error('No test DB set');
};

const api = require('../src/api');

function createTestDb() {
  testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  testDb.pragma('foreign_keys = ON');
  ensureSchema(testDb);
  return testDb;
}

describe('fine-grained per-observation sharing', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    api.close();
  });

  afterEach(() => {
    delete process.env.AGENTIC_CORTEX_AGENT_ID;
    try { api.close(); } catch {}
  });

  function insertObs(agentId, title, content) {
    const r = db.prepare(
      'INSERT INTO observations (project_path, agent_id, type, title, content) VALUES (?,?,?,?,?)'
    ).run('/m', agentId, 'fact', title, content);
    return Number(r.lastInsertRowid);
  }

  it('shares a specific observation to exactly one recipient', () => {
    const id = insertObs('alice', 'Shared fact', 'Only for bob');
    api.shareMemory({ observationId: id, sharedWith: ['bob'], sharedBy: 'alice' });

    const bobShared = api.getSharedMemories('bob', { project: '/m' });
    assert.equal(bobShared.length, 1);
    assert.equal(bobShared[0].id, id);
    assert.equal(bobShared[0].title, 'Shared fact');

    const carolShared = api.getSharedMemories('carol', { project: '/m' });
    assert.equal(carolShared.length, 0, 'unaddressed agent must not see the memory');
  });

  it('does not leak the whole stream — only the explicitly shared observation', () => {
    const sharedId = insertObs('alice', 'Shared fact', 'for bob');
    insertObs('alice', 'Private fact', 'not for bob');

    api.shareMemory({ observationId: sharedId, sharedWith: ['bob'], sharedBy: 'alice' });

    const bobShared = api.getSharedMemories('bob', { project: '/m' });
    assert.equal(bobShared.length, 1, 'must return only the shared observation, not alice\'s whole stream');
    assert.equal(bobShared[0].id, sharedId);
  });
});

describe('inter-agent mailbox', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    api.close();
  });

  afterEach(() => {
    try { api.close(); } catch {}
  });

  it('sends, receives, and marks a message read', () => {
    const sent = api.sendMessage({
      from: 'orchestrator',
      to: 'coder',
      subject: 'Fix login bug',
      body: 'Please fix the login bug in auth.ts',
      kind: 'task',
      refObservationId: 42,
    });
    assert.equal(sent.status, 'sent');
    assert.equal(sent.to_agent, 'coder');

    let inbox = api.getInbox('coder');
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].from_agent, 'orchestrator');
    assert.equal(inbox[0].kind, 'task');
    assert.equal(inbox[0].read, 0);

    api.markMessageRead(inbox[0].id);

    inbox = api.getInbox('coder', { unreadOnly: true });
    assert.equal(inbox.length, 0, 'read messages must be excluded from unread inbox');
  });

  it('requires a recipient and a body', () => {
    assert.throws(() => api.sendMessage({ body: 'no recipient' }), /recipient agent ID/);
    assert.throws(() => api.sendMessage({ to: 'coder' }), /body is required/);
  });

  it('filters inbox by kind', () => {
    api.sendMessage({ from: 'a', to: 'b', body: 'task 1', kind: 'task' });
    api.sendMessage({ from: 'a', to: 'b', body: 'result 1', kind: 'result' });

    const tasks = api.getInbox('b', { kind: 'task' });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].kind, 'task');
  });
});

describe('provider discovery', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    api.close();
  });

  afterEach(() => {
    try { api.close(); } catch {}
  });

  it('returns a self-describing manifest', () => {
    const info = api.providerInfo();
    assert.equal(info.name, 'agentic-cortex');
    assert.equal(typeof info.version, 'string');
    assert.equal(info.capabilities.multiAgent, true);
    assert.equal(info.capabilities.mailbox, true);
    assert.equal(info.capabilities.fineGrainedSharing, true);
    assert.ok(info.capabilities.memoryTypes > 0);
    assert.ok(Array.isArray(info.capabilities.relationTypes));
    assert.ok(info.usage.bootstrap.length > 0);
    assert.ok(info.usage.search.length > 0);
  });
});

describe('role-aware agent context layer', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    api.close();
  });

  afterEach(() => {
    delete process.env.AGENTIC_CORTEX_AGENT_ID;
    try { api.close(); } catch {}
  });

  it('injects identity, inbox, and shared-with-me sections', () => {
    process.env.AGENTIC_CORTEX_AGENT_ID = 'coder';

    api.startAgentSession({ agentId: 'coder', sessionId: 's1', project: '/m', role: 'coder' });

    const sharedId = db.prepare(
      'INSERT INTO observations (project_path, agent_id, type, title, content) VALUES (?,?,?,?,?)'
    ).run('/m', 'orchestrator', 'goal', 'Ship login', 'Implement login').lastInsertRowid;
    api.shareMemory({ observationId: Number(sharedId), sharedWith: ['coder'], sharedBy: 'orchestrator' });

    api.sendMessage({ from: 'orchestrator', to: 'coder', subject: 'Do it', body: 'Implement login now', kind: 'task' });

    const ctx = api._agentContextLayer(db, '/m');
    assert.ok(ctx.includes('agent_identity'), 'must include agent identity');
    assert.ok(ctx.includes('role="coder"'), 'must include persona role');
    assert.ok(ctx.includes('<inbox'), 'must include inbox');
    assert.ok(ctx.includes('Implement login now'), 'must include inbox body');
    assert.ok(ctx.includes('<shared_with_me'), 'must include shared-with-me');
    assert.ok(ctx.includes('Ship login'), 'must include the shared goal title');
  });
});
