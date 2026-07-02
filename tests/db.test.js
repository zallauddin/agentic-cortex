'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');
const { ensureSchema, getDbPath } = require('../src/core/db');

/**
 * Helper: create a fresh in-memory database with full schema.
 * Returns the db instance ready for testing.
 */
function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  return db;
}

// ─── Schema Tests ────────────────────────────────────────────────────

describe('ensureSchema', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should create the sessions table', () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get();
    assert.ok(row, 'sessions table should exist');
  });

  it('should create the observations table', () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations'").get();
    assert.ok(row, 'observations table should exist');
  });

  it('should create the observation_versions table', () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observation_versions'").get();
    assert.ok(row, 'observation_versions table should exist');
  });

  it('should create the daily_summaries table', () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='daily_summaries'").get();
    assert.ok(row, 'daily_summaries table should exist');
  });

  it('should create the embedding_meta table', () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embedding_meta'").get();
    assert.ok(row, 'embedding_meta table should exist');
  });

  it('should create the memory_relations table', () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_relations'").get();
    assert.ok(row, 'memory_relations table should exist');
  });

  it('should create the hooks table', () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hooks'").get();
    assert.ok(row, 'hooks table should exist');
  });

  it('should create the agent_sessions table', () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_sessions'").get();
    assert.ok(row, 'agent_sessions table should exist');
  });

  it('should create the FTS5 virtual table observations_fts', () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").get();
    assert.ok(row, 'FTS5 virtual table should exist');
  });

  it('should be idempotent (calling twice does not throw)', () => {
    assert.doesNotThrow(() => ensureSchema(db));
    assert.doesNotThrow(() => ensureSchema(db));
    assert.doesNotThrow(() => ensureSchema(db));
  });
});

// ─── Index Tests ─────────────────────────────────────────────────────

describe('ensureSchema indexes', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should create idx_sessions_project', () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_project'").get();
    assert.ok(row);
  });

  it('should create idx_observations_project', () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_observations_project'").get();
    assert.ok(row);
  });

  it('should create idx_observations_type', () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_observations_type'").get();
    assert.ok(row);
  });

  it('should create idx_observations_type_active', () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_observations_type_active'").get();
    assert.ok(row);
  });

  it('should create idx_observations_session', () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_observations_session'").get();
    assert.ok(row);
  });

  it('should create idx_observations_active', () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_observations_active'").get();
    assert.ok(row);
  });

  it('should create idx_observations_agent', () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_observations_agent'").get();
    assert.ok(row);
  });

  it('should create idx_relations_source, target, and type', () => {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_relations_source'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_relations_target'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_relations_type'").get());
  });

  it('should create idx_hooks_event and idx_hooks_enabled', () => {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_hooks_event'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_hooks_enabled'").get());
  });

  it('should create idx_agent_sessions_agent and idx_agent_sessions_project', () => {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_sessions_agent'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_sessions_project'").get());
  });
});

// ─── FTS5 Trigger Tests ──────────────────────────────────────────────

describe('FTS5 triggers', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('INSERT trigger should sync new observations to FTS5', () => {
    db.prepare(
      'INSERT INTO observations (project_path, type, title, content, tags) VALUES (?,?,?,?,?)'
    ).run('/test', 'observation', 'Test Title', 'This is test content for FTS5', '["test","fts"]');

    const ftsResults = db.prepare(
      "SELECT rowid, title, content FROM observations_fts WHERE observations_fts MATCH ?"
    ).all('"test"');

    assert.equal(ftsResults.length, 1, 'Should find 1 result via FTS5');
    assert.equal(ftsResults[0].title, 'Test Title');
  });

  it('INSERT trigger should make content searchable via FTS5', () => {
    db.prepare(
      'INSERT INTO observations (project_path, type, title, content) VALUES (?,?,?,?)'
    ).run('/test', 'observation', 'API Design', 'We decided to use REST over GraphQL');

    const ftsResults = db.prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH ?"
    ).all('"GraphQL"');

    assert.equal(ftsResults.length, 1);
  });

  it('UPDATE trigger should sync changes to FTS5', () => {
    const r = db.prepare(
      'INSERT INTO observations (project_path, type, title, content) VALUES (?,?,?,?)'
    ).run('/test', 'observation', 'Old Title', 'Old content');

    db.prepare('UPDATE observations SET title = ?, content = ? WHERE id = ?')
      .run('New Title', 'New updated content', Number(r.lastInsertRowid));

    // Old content should NOT be found
    const oldResults = db.prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH ?"
    ).all('"Old"');
    assert.equal(oldResults.length, 0, 'Old content should be removed from FTS5');

    // New content SHOULD be found
    const newResults = db.prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH ?"
    ).all('"updated"');
    assert.equal(newResults.length, 1, 'Updated content should be in FTS5');
  });

  it('DELETE trigger should remove observation from FTS5', () => {
    const r = db.prepare(
      'INSERT INTO observations (project_path, type, title, content) VALUES (?,?,?,?)'
    ).run('/test', 'observation', 'To Delete', 'Content to be deleted');

    const id = Number(r.lastInsertRowid);

    // Verify exists in FTS5
    const before = db.prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH ?"
    ).all('"delete"');
    assert.equal(before.length, 1);

    db.prepare('DELETE FROM observations WHERE id = ?').run(id);

    // Verify removed from FTS5
    const after = db.prepare(
      "SELECT rowid FROM observations_fts WHERE observations_fts MATCH ?"
    ).all('"delete"');
    assert.equal(after.length, 0);
  });

  it('should handle special characters in FTS5 queries', () => {
    db.prepare(
      'INSERT INTO observations (project_path, type, title, content) VALUES (?,?,?,?)'
    ).run('/test', 'observation', 'Special Chars', 'Has special chars: @#$%^&*()');

    // FTS5 with special chars should not crash — might return empty
    assert.doesNotThrow(() => {
      db.prepare(
        "SELECT rowid FROM observations_fts WHERE observations_fts MATCH ?"
      ).all('"chars"');
    });
  });
});

// ─── Column Tests ────────────────────────────────────────────────────

describe('observations columns', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should have all required columns on observations table', () => {
    const cols = db.prepare('PRAGMA table_info(observations)').all();
    const colNames = cols.map(c => c.name);

    const required = [
      'id', 'session_id', 'project_path', 'type', 'title', 'content',
      'tags', 'importance', 'confidence', 'provenance', 'is_active',
      'embedding', 'created_at', 'agent_id',
      'steps', 'triggers', 'preconditions', 'postconditions'
    ];

    for (const name of required) {
      assert.ok(colNames.includes(name), `Column '${name}' should exist on observations`);
    }
  });

  it('should have all required columns on sessions table', () => {
    const cols = db.prepare('PRAGMA table_info(sessions)').all();
    const colNames = cols.map(c => c.name);

    assert.ok(colNames.includes('id'));
    assert.ok(colNames.includes('session_id'));
    assert.ok(colNames.includes('project_path'));
    assert.ok(colNames.includes('project_name'));
    assert.ok(colNames.includes('user_prompt'));
    assert.ok(colNames.includes('summary'));
    assert.ok(colNames.includes('started_at'));
    assert.ok(colNames.includes('ended_at'));
  });

  it('should have all required columns on memory_relations', () => {
    const cols = db.prepare('PRAGMA table_info(memory_relations)').all();
    const colNames = cols.map(c => c.name);

    assert.ok(colNames.includes('id'));
    assert.ok(colNames.includes('source_id'));
    assert.ok(colNames.includes('target_id'));
    assert.ok(colNames.includes('relation_type'));
    assert.ok(colNames.includes('confidence'));
    assert.ok(colNames.includes('created_at'));
  });

  it('should have all required columns on hooks table', () => {
    const cols = db.prepare('PRAGMA table_info(hooks)').all();
    const colNames = cols.map(c => c.name);

    assert.ok(colNames.includes('id'));
    assert.ok(colNames.includes('name'));
    assert.ok(colNames.includes('event'));
    assert.ok(colNames.includes('condition_type'));
    assert.ok(colNames.includes('condition_value'));
    assert.ok(colNames.includes('action_type'));
    assert.ok(colNames.includes('action_config'));
    assert.ok(colNames.includes('enabled'));
  });
});

// ─── Default Values ──────────────────────────────────────────────────

describe('default values', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('observations should default is_active to 1', () => {
    const r = db.prepare(
      'INSERT INTO observations (project_path, type, title, content) VALUES (?,?,?,?)'
    ).run('/test', 'observation', 'Test', 'Content');
    const obs = db.prepare('SELECT is_active FROM observations WHERE id = ?').get(Number(r.lastInsertRowid));
    assert.equal(obs.is_active, 1);
  });

  it('observations should default importance to 5', () => {
    const r = db.prepare(
      'INSERT INTO observations (project_path, type, title, content) VALUES (?,?,?,?)'
    ).run('/test', 'observation', 'Test', 'Content');
    const obs = db.prepare('SELECT importance FROM observations WHERE id = ?').get(Number(r.lastInsertRowid));
    assert.equal(obs.importance, 5);
  });

  it('observations should default confidence to 100', () => {
    const r = db.prepare(
      'INSERT INTO observations (project_path, type, title, content) VALUES (?,?,?,?)'
    ).run('/test', 'observation', 'Test', 'Content');
    const obs = db.prepare('SELECT confidence FROM observations WHERE id = ?').get(Number(r.lastInsertRowid));
    assert.equal(obs.confidence, 100);
  });

  it('observations should default provenance to observed', () => {
    const r = db.prepare(
      'INSERT INTO observations (project_path, type, title, content) VALUES (?,?,?,?)'
    ).run('/test', 'observation', 'Test', 'Content');
    const obs = db.prepare('SELECT provenance FROM observations WHERE id = ?').get(Number(r.lastInsertRowid));
    assert.equal(obs.provenance, 'observed');
  });

  it('observations should default tags to []', () => {
    const r = db.prepare(
      'INSERT INTO observations (project_path, type, title, content) VALUES (?,?,?,?)'
    ).run('/test', 'observation', 'Test', 'Content');
    const obs = db.prepare('SELECT tags FROM observations WHERE id = ?').get(Number(r.lastInsertRowid));
    assert.equal(obs.tags, '[]');
  });

  it('sessions should default started_at to current datetime', () => {
    db.prepare(
      'INSERT INTO sessions (session_id, project_path, project_name) VALUES (?,?,?)'
    ).run('sess-1', '/test', 'Test Project');
    const sess = db.prepare('SELECT started_at FROM sessions WHERE session_id = ?').get('sess-1');
    assert.ok(sess.started_at, 'started_at should be set');
    // Should be a valid datetime string
    assert.ok(sess.started_at.match(/^\d{4}-\d{2}-\d{2}/), 'started_at should be a valid datetime');
  });
});

// ─── getDbPath ───────────────────────────────────────────────────────

describe('getDbPath', () => {
  let savedEnv;

  beforeEach(() => {
    // Save and clear env var to avoid flaky test when AGENTIC_CORTEX_DB is set
    savedEnv = process.env.AGENTIC_CORTEX_DB;
    delete process.env.AGENTIC_CORTEX_DB;
    // Use os.tmpdir() for cross-platform safety instead of hardcoded /tmp
    process.env.XDG_DATA_HOME = path.join(os.tmpdir(), 'test-xdg');
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.AGENTIC_CORTEX_DB = savedEnv;
    } else {
      delete process.env.AGENTIC_CORTEX_DB;
    }
    delete process.env.XDG_DATA_HOME;
  });

  it('should return a string path', () => {
    const dbPath = getDbPath();
    assert.equal(typeof dbPath, 'string');
    assert.ok(dbPath.length > 0, 'db path should not be empty');
  });

  it('should end with agentic-cortex.db', () => {
    const dbPath = getDbPath();
    assert.ok(dbPath.endsWith('agentic-cortex.db'), `Path should end with agentic-cortex.db, got: ${dbPath}`);
  });
});

// ─── Constraints ─────────────────────────────────────────────────────

describe('constraints', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('session_id should be UNIQUE in sessions table', () => {
    db.prepare('INSERT INTO sessions (session_id, project_path, project_name) VALUES (?,?,?)')
      .run('uniq-1', '/test', 'Test');
    assert.throws(() => {
      db.prepare('INSERT INTO sessions (session_id, project_path, project_name) VALUES (?,?,?)')
        .run('uniq-1', '/test', 'Test');
    }, /UNIQUE constraint failed/);
  });

  it('source_id + target_id + relation_type should be UNIQUE in memory_relations', () => {
    db.prepare(
      'INSERT INTO observations (project_path, type, title, content) VALUES (?,?,?,?)'
    ).run('/test', 'observation', 'A', 'Content A');
    db.prepare(
      'INSERT INTO observations (project_path, type, title, content) VALUES (?,?,?,?)'
    ).run('/test', 'observation', 'B', 'Content B');

    db.prepare(
      'INSERT INTO memory_relations (source_id, target_id, relation_type) VALUES (?,?,?)'
    ).run(1, 2, 'related_to');

    assert.throws(() => {
      db.prepare(
        'INSERT INTO memory_relations (source_id, target_id, relation_type) VALUES (?,?,?)'
      ).run(1, 2, 'related_to');
    }, /UNIQUE constraint failed/);
  });

  it('embedding_meta id should be constrained to 1', () => {
    db.prepare("INSERT INTO embedding_meta (id, model, dimension, count) VALUES (1, 'test', 768, 0)").run();
    assert.throws(() => {
      db.prepare("INSERT INTO embedding_meta (id, model, dimension, count) VALUES (2, 'test', 768, 0)").run();
    }, /CHECK constraint failed/);
  });
});

// ─── Migration / Upgrade Tests ───────────────────────────────────────

describe('ensureSchema migration (upgrade from older schema)', () => {
  it('should add missing columns to an older-schema database', () => {
    // Create a minimal DB simulating an older version (no agent_id, steps, etc.)
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Create only the original observations table without newer columns.
    // NOTE: avoid DEFAULT (datetime('now')) — some better-sqlite3 builds
    // don't support parenthesized default expressions.
    db.exec(`
      CREATE TABLE observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        project_path TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'observation',
        title TEXT,
        content TEXT NOT NULL,
        tags TEXT DEFAULT '[]',
        importance INTEGER DEFAULT 5,
        created_at TEXT NOT NULL DEFAULT '1970-01-01'
      );
    `);

    // Insert a row to ensure data survives
    db.prepare(
      "INSERT INTO observations (project_path, type, title, content) VALUES (?,?,?,?)"
    ).run('/test', 'observation', 'Old Data', 'This data predates the upgrade');

    // Now run ensureSchema — this should add all missing columns and tables
    ensureSchema(db);

    // Verify the old data still exists
    const oldRow = db.prepare("SELECT title, content FROM observations WHERE title = 'Old Data'").get();
    assert.ok(oldRow, 'Old data should survive the migration');
    assert.equal(oldRow.content, 'This data predates the upgrade');

    // Verify new columns were added
    const cols = db.prepare('PRAGMA table_info(observations)').all();
    const colNames = cols.map(c => c.name);
    for (const name of ['agent_id', 'steps', 'triggers', 'preconditions', 'postconditions', 'confidence', 'provenance', 'is_active', 'embedding']) {
      assert.ok(colNames.includes(name), `Column '${name}' should have been added during migration`);
    }

    // Verify new tables were created
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observation_versions'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_relations'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hooks'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_sessions'").get());

    // Verify new default values work
    const r = db.prepare(
      "INSERT INTO observations (project_path, type, title, content) VALUES (?,?,?,?)"
    ).run('/test', 'observation', 'New Data', 'After upgrade');
    const newRow = db.prepare('SELECT confidence, provenance, is_active FROM observations WHERE id = ?').get(Number(r.lastInsertRowid));
    assert.equal(newRow.confidence, 100);
    assert.equal(newRow.provenance, 'observed');
    assert.equal(newRow.is_active, 1);
  });

  it('should be safe to run ensureSchema on a fully-migrated database', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    ensureSchema(db);
    // Second call should not throw
    assert.doesNotThrow(() => ensureSchema(db));
    // Data operations should still work
    db.prepare("INSERT INTO observations (project_path, type, title, content) VALUES (?,?,?,?)")
      .run('/test', 'observation', 'After Migration', 'Data after second ensureSchema');
    const row = db.prepare("SELECT title FROM observations WHERE title = 'After Migration'").get();
    assert.ok(row);
  });
});

// ─── WAL + Foreign Keys ──────────────────────────────────────────────

describe('database pragmas', () => {
  it('in-memory DB with WAL mode should work', () => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    ensureSchema(db);

    // In-memory databases always use 'memory' journal mode;
    // WAL is only available for file-based databases.
    const journalMode = db.pragma('journal_mode');
    assert.ok(['wal', 'memory'].includes(journalMode[0].journal_mode),
      `Expected WAL or memory journal mode, got: ${journalMode[0].journal_mode}`);
  });

  it('foreign keys should be enforced', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    ensureSchema(db);

    // memory_relations references observations — should fail when source_id doesn't exist
    assert.throws(() => {
      db.prepare(
        'INSERT INTO memory_relations (source_id, target_id, relation_type) VALUES (?,?,?)'
      ).run(9999, 9999, 'related_to');
    }, /FOREIGN KEY constraint failed/);
  });
});
