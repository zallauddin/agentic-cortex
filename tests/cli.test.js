'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../src/core/db');
const { sanitizeDate } = require('../src/core/search');
const { VALID_TYPES } = require('../src/core/constants');
const { cosineSimilarity } = require('../src/core/embedding');

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  return db;
}

// ─── CLI Command Argument Parsing ──────────────────────────────────

describe('CLI save command argument parsing', () => {
  function parseSave(args) {
    const opts = { title: args[0], content: args[1] };
    for (let i = 2; i < args.length; i += 2) {
      if (args[i] === '--type') opts.type = args[i + 1];
      if (args[i] === '--tags') opts.tags = args[i + 1].split(',');
      if (args[i] === '--importance') opts.importance = parseInt(args[i + 1], 10);
      if (args[i] === '--confidence') opts.confidence = Math.min(100, Math.max(0, parseInt(args[i + 1], 10) || 100));
      if (args[i] === '--provenance') opts.provenance = args[i + 1];
      if (args[i] === '--project') opts.project = args[i + 1];
      if (args[i] === '--session') opts.session = args[i + 1];
      if (args[i] === '--agent-id') opts.agentId = args[i + 1];
      if (args[i] === '--steps') opts.steps = args[i + 1].split(',');
      if (args[i] === '--triggers') opts.triggers = args[i + 1].split(',');
      if (args[i] === '--preconditions') opts.preconditions = args[i + 1].split(',');
      if (args[i] === '--postconditions') opts.postconditions = args[i + 1].split(',');
    }
    return opts;
  }

  it('should parse basic title and content', () => {
    const opts = parseSave(['My Title', 'My Content']);
    assert.equal(opts.title, 'My Title');
    assert.equal(opts.content, 'My Content');
  });

  it('should parse --type option', () => {
    const opts = parseSave(['Title', 'Content', '--type', 'decision']);
    assert.equal(opts.type, 'decision');
  });

  it('should parse --tags option as array', () => {
    const opts = parseSave(['Title', 'Content', '--tags', 'cache,redis']);
    assert.deepEqual(opts.tags, ['cache', 'redis']);
  });

  it('should clamp --confidence to 0-100', () => {
    const optsHigh = parseSave(['Title', 'Content', '--confidence', '150']);
    assert.equal(optsHigh.confidence, 100);
    const optsValid = parseSave(['Title', 'Content', '--confidence', '75']);
    assert.equal(optsValid.confidence, 75);
  });

  it('should parse --agent-id', () => {
    const opts = parseSave(['Title', 'Content', '--agent-id', 'agent-42']);
    assert.equal(opts.agentId, 'agent-42');
  });
});

describe('CLI search command argument parsing', () => {
  function parseSearch(args) {
    const opts = { query: '', limit: 10, semantic: false, minConfidence: 0 };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--project') opts.project = args[++i];
      else if (args[i] === '--limit') opts.limit = parseInt(args[++i], 10);
      else if (args[i] === '--semantic') opts.semantic = true;
      else if (args[i] === '--type') opts.type = args[++i];
      else if (args[i] === '--as-of') opts.asOf = args[++i];
      else if (args[i] === '--changed-since') opts.changedSince = args[++i];
      else if (args[i] === '--min-confidence') opts.minConfidence = parseInt(args[++i], 10);
      else if (args[i] === '--agent-id') opts.agentId = args[++i];
      else opts.query += (opts.query ? ' ' : '') + args[i];
    }
    return opts;
  }

  it('should parse a simple query', () => {
    const opts = parseSearch(['redis', 'cache']);
    assert.equal(opts.query, 'redis cache');
  });

  it('should parse --semantic flag', () => {
    const opts = parseSearch(['test', '--semantic']);
    assert.equal(opts.semantic, true);
  });

  it('should parse --agent-id filter', () => {
    const opts = parseSearch(['test', '--agent-id', 'agent-7']);
    assert.equal(opts.agentId, 'agent-7');
  });

  it('should parse query mixed with options', () => {
    const opts = parseSearch(['find', 'redis', '--type', 'decision', '--limit', '5', 'cache']);
    assert.equal(opts.query, 'find redis cache');
    assert.equal(opts.type, 'decision');
    assert.equal(opts.limit, 5);
  });
});

describe('CLI embed command argument parsing', () => {
  function parseEmbed(args) {
    const opts = { ids: null, force: false };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--ids') opts.ids = args[++i].split(',').map(Number);
      if (args[i] === '--force') opts.force = true;
    }
    return opts;
  }

  it('should parse --ids', () => {
    const opts = parseEmbed(['--ids', '1,2,3']);
    assert.deepEqual(opts.ids, [1, 2, 3]);
  });

  it('should parse --force flag', () => {
    const opts = parseEmbed(['--force']);
    assert.equal(opts.force, true);
  });
});

describe('CLI edit command argument parsing', () => {
  function parseEdit(args) {
    const opts = { id: parseInt(args[0], 10) };
    for (let i = 1; i < args.length; i += 2) {
      if (args[i] === '--title') opts.title = args[i + 1];
      if (args[i] === '--content') opts.content = args[i + 1];
      if (args[i] === '--confidence') opts.confidence = Math.min(100, Math.max(0, parseInt(args[i + 1], 10)));
      if (args[i] === '--importance') opts.importance = parseInt(args[i + 1], 10);
    }
    return opts;
  }

  it('should parse ID and options', () => {
    const opts = parseEdit(['42', '--title', 'New Title', '--content', 'Updated']);
    assert.equal(opts.id, 42);
    assert.equal(opts.title, 'New Title');
    assert.equal(opts.content, 'Updated');
  });
});

describe('CLI forget command argument parsing', () => {
  function parseForget(args) {
    return { id: parseInt(args[0], 10), hard: args[1] === '--hard' };
  }

  it('should parse soft forget by default', () => {
    const opts = parseForget(['99']);
    assert.equal(opts.id, 99);
    assert.equal(opts.hard, false);
  });

  it('should parse --hard flag', () => {
    const opts = parseForget(['99', '--hard']);
    assert.equal(opts.hard, true);
  });
});

describe('CLI conflicts command argument parsing', () => {
  function parseConflicts(args) {
    const opts = { limit: 10, autoResolve: false };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--project') opts.project = args[++i];
      if (args[i] === '--limit') opts.limit = parseInt(args[++i], 10);
      if (args[i] === '--auto-resolve') opts.autoResolve = true;
    }
    return opts;
  }

  it('should parse --project and --limit', () => {
    const opts = parseConflicts(['--project', '/my/proj', '--limit', '5', '--auto-resolve']);
    assert.equal(opts.project, '/my/proj');
    assert.equal(opts.limit, 5);
    assert.equal(opts.autoResolve, true);
  });
});

// ─── Core Function Tests ──────────────────────────────────────────

describe('API layer integration via core functions', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  describe('save and retrieve', () => {
    it('should insert and query observations', () => {
      db.prepare(
        'INSERT INTO observations (project_path, type, title, content, importance, confidence) VALUES (?,?,?,?,?,?)'
      ).run('/test-cli', 'decision', 'CLI Test', 'Testing CLI', 7, 95);

      const obs = db.prepare('SELECT * FROM observations WHERE title = ?').get('CLI Test');
      assert.ok(obs);
      assert.equal(obs.type, 'decision');
      assert.equal(obs.importance, 7);
      assert.equal(obs.confidence, 95);
    });
  });

  describe('list and filter', () => {
    it('should filter by project', () => {
      db.prepare('INSERT INTO observations (project_path, type, title, content) VALUES (?,?,?,?)')
        .run('/proj-a', 'observation', 'A', 'Content');
      db.prepare('INSERT INTO observations (project_path, type, title, content) VALUES (?,?,?,?)')
        .run('/proj-b', 'observation', 'B', 'Content');

      const results = db.prepare('SELECT * FROM observations WHERE project_path = ?').all('/proj-a');
      assert.equal(results.length, 1);
      assert.equal(results[0].title, 'A');
    });
  });

  describe('session management', () => {
    it('should create and end sessions', () => {
      const { startSession, endSession } = require('../src/core/session');

      const sess = startSession(db, { project: '/test-cli', name: 'Test', prompt: 'Testing CLI' });
      assert.ok(sess.session_id);

      const ended = endSession(db, sess.session_id, 'Session completed');
      assert.equal(ended.status, 'ended');
    });
  });
});

// ─── sanitizeDate ─────────────────────────────────────────────────

describe('sanitizeDate', () => {
  it('should return valid ISO dates unchanged', () => {
    assert.equal(sanitizeDate('2024-06-15'), '2024-06-15');
    assert.equal(sanitizeDate('2024-01-01'), '2024-01-01');
  });

  it('should return trimmed input for unrecognized dates', () => {
    // sanitizeDate extracts YYYY-MM-DD prefix or returns trimmed input
    assert.equal(sanitizeDate('not-a-date'), 'not-a-date');
    assert.equal(sanitizeDate(''), '');
  });
});

// ─── cosineSimilarity ─────────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('should return 1 for identical vectors', () => {
    const result = cosineSimilarity([1, 2, 3], [1, 2, 3]);
    assert.ok(Math.abs(result - 1.0) < 0.0001);
  });

  it('should return 0 for orthogonal vectors', () => {
    const result = cosineSimilarity([1, 0, 0], [0, 1, 0]);
    assert.ok(Math.abs(result - 0.0) < 0.0001);
  });
});

// ─── VALID_TYPES ──────────────────────────────────────────────────

describe('VALID_TYPES', () => {
  it('should include all core types', () => {
    assert.ok(VALID_TYPES.has('instruction'));
    assert.ok(VALID_TYPES.has('fact'));
    assert.ok(VALID_TYPES.has('decision'));
    assert.ok(VALID_TYPES.has('goal'));
    assert.ok(VALID_TYPES.has('commitment'));
    assert.ok(VALID_TYPES.has('preference'));
    assert.ok(VALID_TYPES.has('relationship'));
    assert.ok(VALID_TYPES.has('context'));
    assert.ok(VALID_TYPES.has('event'));
    assert.ok(VALID_TYPES.has('learning'));
    assert.ok(VALID_TYPES.has('observation'));
    assert.ok(VALID_TYPES.has('artifact'));
    assert.ok(VALID_TYPES.has('error'));
  });

  it('should include extended types', () => {
    assert.ok(VALID_TYPES.has('skill'));
    assert.ok(VALID_TYPES.has('procedure'));
    assert.ok(VALID_TYPES.has('architecture'));
    assert.ok(VALID_TYPES.has('bugfix'));
    assert.ok(VALID_TYPES.has('gotcha'));
  });
});
