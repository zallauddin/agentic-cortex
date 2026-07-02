'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../src/core/db');
const {
  startSession,
  endSession,
  listSessions,
  templateSummary,
  summarizeSession,
} = require('../src/core/session');

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  return db;
}

// ─── startSession ────────────────────────────────────────────────────

describe('startSession', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should create a session with auto-generated ID', () => {
    const result = startSession(db, { prompt: 'Fix login bug', project: '/test-project' });
    assert.equal(result.status, 'started');
    assert.ok(result.session_id.startsWith('session-'));
  });

  it('should accept a custom session ID', () => {
    const result = startSession(db, {
      sessionId: 'my-custom-session',
      prompt: 'Refactor auth',
      project: '/test-project',
    });
    assert.equal(result.session_id, 'my-custom-session');
  });

  it('should store project name from basename', () => {
    startSession(db, { prompt: 'Test', project: '/home/user/my-project' });
    const row = db.prepare('SELECT project_name FROM sessions WHERE project_path = ?').get('/home/user/my-project');
    assert.equal(row.project_name, 'my-project');
  });

  it('should store user prompt', () => {
    startSession(db, { prompt: 'What database to use?', project: '/test' });
    const row = db.prepare('SELECT user_prompt FROM sessions WHERE project_path = ?').get('/test');
    assert.equal(row.user_prompt, 'What database to use?');
  });

  it('should store empty prompt as empty string', () => {
    startSession(db, { project: '/test' });
    const row = db.prepare('SELECT user_prompt FROM sessions WHERE project_path = ?').get('/test');
    assert.equal(row.user_prompt, '');
  });

  it('should set started_at automatically', () => {
    startSession(db, { prompt: 'Test', project: '/test' });
    const row = db.prepare('SELECT started_at FROM sessions WHERE project_path = ?').get('/test');
    assert.ok(row.started_at, 'started_at should be set');
    assert.ok(row.started_at.match(/^\d{4}-\d{2}-\d{2}/));
  });

  it('should set ended_at as NULL for active sessions', () => {
    startSession(db, { prompt: 'Test', project: '/test' });
    const row = db.prepare('SELECT ended_at FROM sessions WHERE project_path = ?').get('/test');
    assert.equal(row.ended_at, null);
  });

  it('should generate unique session IDs', () => {
    const r1 = startSession(db, { project: '/a' });
    const r2 = startSession(db, { project: '/b' });
    assert.notEqual(r1.session_id, r2.session_id);
  });
});

// ─── endSession ──────────────────────────────────────────────────────

describe('endSession', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should set ended_at and summary on a session', () => {
    startSession(db, { sessionId: 'sess-end', prompt: 'Test', project: '/test' });
    const result = endSession(db, 'sess-end', 'Completed auth refactor');
    assert.equal(result.status, 'ended');
    assert.equal(result.session_id, 'sess-end');

    const row = db.prepare('SELECT ended_at, summary FROM sessions WHERE session_id = ?').get('sess-end');
    assert.ok(row.ended_at, 'ended_at should be set');
    assert.equal(row.summary, 'Completed auth refactor');
  });

  it('should throw when session ID is empty', () => {
    assert.throws(() => endSession(db, ''), /session ID is required/);
  });

  it('should throw when session ID is null', () => {
    assert.throws(() => endSession(db, null), /session ID is required/);
  });

  it('should handle ending with empty summary', () => {
    startSession(db, { sessionId: 'sess-no-summary', prompt: 'Test', project: '/test' });
    const result = endSession(db, 'sess-no-summary');
    assert.equal(result.status, 'ended');

    const row = db.prepare('SELECT summary FROM sessions WHERE session_id = ?').get('sess-no-summary');
    assert.equal(row.summary, '');
  });

  it('should handle ending a non-existent session gracefully', () => {
    // endSession runs UPDATE without checking existence — it succeeds silently
    const result = endSession(db, 'nonexistent-session', 'summary');
    assert.equal(result.status, 'ended');
  });
});

// ─── listSessions ────────────────────────────────────────────────────

describe('listSessions', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should list sessions for a project', () => {
    startSession(db, { prompt: 'One', project: '/proj-a' });
    startSession(db, { prompt: 'Two', project: '/proj-a' });
    startSession(db, { prompt: 'Three', project: '/proj-b' });

    const sessions = listSessions(db, { project: '/proj-a', limit: 10 });
    assert.equal(sessions.length, 2);
    assert.ok(sessions.every(s => s.project_name));
    assert.ok(new Date(sessions[0].started_at) >= new Date(sessions[1].started_at), 'Should be ordered by started_at DESC');
  });

  it('should respect limit', () => {
    for (let i = 0; i < 5; i++) {
      startSession(db, { prompt: 'Session ' + i, project: '/proj-limit' });
    }
    const sessions = listSessions(db, { project: '/proj-limit', limit: 2 });
    assert.equal(sessions.length, 2);
  });

  it('should return empty array for project with no sessions', () => {
    const sessions = listSessions(db, { project: '/no-sessions' });
    assert.equal(sessions.length, 0);
  });

  it('should include all expected fields', () => {
    startSession(db, { prompt: 'Test', project: '/test' });
    const sessions = listSessions(db, { project: '/test' });
    assert.equal(sessions.length, 1);
    const s = sessions[0];
    assert.ok('id' in s);
    assert.ok('session_id' in s);
    assert.ok('project_name' in s);
    assert.ok('user_prompt' in s);
    assert.ok('summary' in s);
    assert.ok('started_at' in s);
    assert.ok('ended_at' in s);
  });
});

// ─── summarizeSession (error path only) ──────────────────────────────

describe('summarizeSession', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should throw when session not found', async () => {
    await assert.rejects(
      () => summarizeSession(db, { id: 'nonexistent-session' }),
      /Session not found/
    );
  });

  it('should throw when no sessions exist and no id given', async () => {
    await assert.rejects(
      () => summarizeSession(db, { project: '/no-sessions' }),
      /Session not found/
    );
  });

  it('should throw when session has no observations and project has none', async () => {
    startSession(db, { sessionId: 'empty-session', prompt: 'Empty', project: '/test' });
    await assert.rejects(
      () => summarizeSession(db, { id: 'empty-session' }),
      /No observations found/
    );
  });
});

describe('templateSummary', () => {
  it('should produce a summary from observations', () => {
    const obs = [
      { title: 'Fix login bug', content: 'Fixed CSS on login page' },
      { title: 'Add rate limiting', content: 'Added rate limiting to API' },
    ];
    const summary = templateSummary(obs, 'LLM unavailable');
    assert.ok(summary.includes('Fix login bug'));
    assert.ok(summary.includes('Add rate limiting'));
    assert.ok(summary.includes('LLM unavailable'));
    assert.ok(summary.includes('2 observations recorded'));
  });

  it('should use content when title is empty', () => {
    const obs = [
      { title: null, content: 'This is a long observation about something important' },
    ];
    const summary = templateSummary(obs, 'test reason');
    assert.ok(summary.includes('important'));
  });

  it('should limit to 5 topics', () => {
    const obs = [];
    for (let i = 0; i < 10; i++) {
      obs.push({ title: 'Topic ' + i, content: 'Content ' + i });
    }
    const summary = templateSummary(obs, 'test');
    assert.ok(summary.includes('Topic 0'));
    assert.ok(summary.includes('Topic 4'));
    assert.ok(!summary.includes('Topic 5'), 'Should only show first 5 topics');
    assert.ok(summary.includes('10 observations recorded'));
  });

  it('should handle empty observations', () => {
    const summary = templateSummary([], 'test');
    assert.ok(summary.includes('Session covered:'));
    assert.ok(summary.includes('0 observations recorded'));
  });
});
