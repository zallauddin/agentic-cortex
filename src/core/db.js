/**
 * db.js — Database module for agentic-cortex.
 *
 * Provides lazy singleton database initialization with WAL mode, foreign keys,
 * and busy timeout. Includes schema creation (tables, indexes, FTS5 virtual
 * tables, triggers) and migration from legacy freebuff-mem.db.
 *
 * @module core/db
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { getDbPath } = require('./db-path');
const { DB_FILENAME } = require('./constants');

/** @type {import('better-sqlite3').Database|null} Lazy singleton database instance */
let _db = null;

/**
 * Get or create the database connection (lazy singleton).
 * Handles migration from freebuff-mem.db on first access.
 * Sets WAL mode, foreign keys, and busy timeout.
 *
 * @returns {import('better-sqlite3').Database} The database instance
 */
function getDb() {
  if (_db) return _db;

  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    throw new Error('better-sqlite3 is not installed. Run: npm install better-sqlite3');
  }

  const dbPath = getDbPath();

  // Auto-migrate from old database names to agentic-cortex.db on upgrade
  const dbDir = path.dirname(dbPath);
  const oldNames = ['freebuff-mem.db', 'infinit-mem.db'];
  for (const oldName of oldNames) {
    const oldDbPath = path.join(dbDir, oldName);
    if (!fs.existsSync(dbPath) && fs.existsSync(oldDbPath)) {
      try {
        fs.renameSync(oldDbPath, dbPath);
        console.error('[agentic-cortex] Migrated existing database from ' + oldName + ' to ' + dbPath);
        break;
      } catch (err) {
        console.error('[agentic-cortex] Warning: Could not migrate old database (' + oldName + '):', err.message);
      }
    }
  }

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');
  ensureSchema(_db);
  return _db;
}

/**
 * Initialize the database schema with all required tables, indexes,
 * FTS5 virtual tables, and triggers. Uses IF NOT EXISTS for idempotency.
 *
 * @param {import('better-sqlite3').Database} db - Database instance
 */
function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      project_path TEXT NOT NULL,
      project_name TEXT NOT NULL,
      user_prompt TEXT,
      summary TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    );
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      project_path TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'observation',
      title TEXT,
      content TEXT NOT NULL,
      tags TEXT DEFAULT '[]',
      importance INTEGER DEFAULT 5,
      confidence INTEGER DEFAULT 100,
      provenance TEXT DEFAULT 'observed',
      is_active INTEGER DEFAULT 1,
      embedding TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS observation_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_id INTEGER REFERENCES observations(id),
      version_number INTEGER NOT NULL DEFAULT 1,
      old_title TEXT,
      old_content TEXT,
      old_confidence INTEGER,
      changed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS daily_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      summary_date TEXT NOT NULL,
      summary TEXT NOT NULL,
      observation_count INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_path, summary_date)
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
    CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project_path);
    CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
    CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id);
    CREATE INDEX IF NOT EXISTS idx_versions_obs_id ON observation_versions(observation_id);
  `);

  // Migration ALTERs — safe to fail if column already exists
  try { db.exec(`ALTER TABLE observations ADD COLUMN embedding TEXT`); } catch {}
  try { db.exec(`ALTER TABLE observations ADD COLUMN confidence INTEGER DEFAULT 100`); } catch {}
  try { db.exec(`ALTER TABLE observations ADD COLUMN provenance TEXT DEFAULT 'observed'`); } catch {}
  try { db.exec(`ALTER TABLE observations ADD COLUMN is_active INTEGER DEFAULT 1`); } catch {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS observation_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, observation_id INTEGER REFERENCES observations(id), version_number INTEGER NOT NULL DEFAULT 1, old_title TEXT, old_content TEXT, old_confidence INTEGER, changed_at TEXT NOT NULL DEFAULT (datetime('now')))`); } catch {}
  try { db.exec(`CREATE TABLE IF NOT EXISTS daily_summaries (id INTEGER PRIMARY KEY AUTOINCREMENT, project_path TEXT NOT NULL, summary_date TEXT NOT NULL, summary TEXT NOT NULL, observation_count INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(project_path, summary_date))`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_observations_active ON observations(is_active)`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_versions_obs_id ON observation_versions(observation_id)`); } catch {}

  // FTS5 virtual table for full-text search
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(title, content, tags, content=observations, content_rowid=id)`);
  } catch {}

  // FTS5 sync triggers (INSERT, DELETE, UPDATE)
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, title, content, tags) VALUES (new.id, new.title, new.content, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, content, tags) VALUES ('delete', old.id, old.title, old.content, old.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, title, content, tags) VALUES ('delete', old.id, old.title, old.content, old.tags);
        INSERT INTO observations_fts(rowid, title, content, tags) VALUES (new.id, new.title, new.content, new.tags);
      END;
    `);
  } catch {}

  // Embedding metadata table
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      model TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Memory relations table (graph edges between observations)
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
      target_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL,
      confidence INTEGER DEFAULT 100,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_id, target_id, relation_type)
    );
    CREATE INDEX IF NOT EXISTS idx_relations_source ON memory_relations(source_id);
    CREATE INDEX IF NOT EXISTS idx_relations_target ON memory_relations(target_id);
    CREATE INDEX IF NOT EXISTS idx_relations_type ON memory_relations(relation_type);
  `);

  // Hooks table for auto-capture triggers
  db.exec(`
    CREATE TABLE IF NOT EXISTS hooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      event TEXT NOT NULL,
      condition_type TEXT,
      condition_value TEXT,
      action_type TEXT NOT NULL,
      action_config TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_hooks_event ON hooks(event);
    CREATE INDEX IF NOT EXISTS idx_hooks_enabled ON hooks(enabled);
  `);

  // Multi-agent support: agent_id column on observations + agent_sessions table
  try { db.exec(`ALTER TABLE observations ADD COLUMN agent_id TEXT`); } catch {}
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_observations_agent ON observations(agent_id)`);
  } catch {}
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project_path TEXT NOT NULL,
      role TEXT,
      shared_with TEXT DEFAULT '[]',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      UNIQUE(agent_id, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent ON agent_sessions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_project ON agent_sessions(project_path);
  `);

  // Phase 6: Skill/procedure fields — steps, triggers, preconditions, postconditions
  try { db.exec(`ALTER TABLE observations ADD COLUMN steps TEXT`); } catch {}
  try { db.exec(`ALTER TABLE observations ADD COLUMN triggers TEXT`); } catch {}
  try { db.exec(`ALTER TABLE observations ADD COLUMN preconditions TEXT`); } catch {}
  try { db.exec(`ALTER TABLE observations ADD COLUMN postconditions TEXT`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_observations_type_active ON observations(type, is_active)`); } catch {}
}

/**
 * Get the resolved database file path.
 * Useful for health checks and size reporting.
 *
 * @returns {string} Absolute path to the database file
 */
function getDbPath_() {
  return getDbPath();
}

module.exports = { getDb, ensureSchema, getDbPath: getDbPath_ };
