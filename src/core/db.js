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
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent_ended ON agent_sessions(agent_id, ended_at);
  `);

  // Phase 6: Skill/procedure fields — steps, triggers, preconditions, postconditions
  try { db.exec(`ALTER TABLE observations ADD COLUMN steps TEXT`); } catch {}
  try { db.exec(`ALTER TABLE observations ADD COLUMN triggers TEXT`); } catch {}
  try { db.exec(`ALTER TABLE observations ADD COLUMN preconditions TEXT`); } catch {}
  try { db.exec(`ALTER TABLE observations ADD COLUMN postconditions TEXT`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_observations_type_active ON observations(type, is_active)`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_observations_project_active_type ON observations(project_path, is_active, type)`); } catch {}

  // Phase 7: Memory utility tracking — access_count, last_accessed_at
  try { db.exec(`ALTER TABLE observations ADD COLUMN access_count INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE observations ADD COLUMN last_accessed_at TEXT`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_observations_access ON observations(access_count, last_accessed_at)`); } catch {}

  // Phase 8: Cross-project knowledge transfer — project_scope
  try { db.exec(`ALTER TABLE observations ADD COLUMN project_scope TEXT DEFAULT 'local'`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_observations_scope ON observations(project_scope)`); } catch {}

  // Phase 9: Predictive context ranking — predicted_utility
  try { db.exec(`ALTER TABLE observations ADD COLUMN predicted_utility INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_observations_utility ON observations(predicted_utility, is_active)`); } catch {}

  // Phase 10: Freshness scoring — auto-decaying composite score
  try { db.exec(`ALTER TABLE observations ADD COLUMN freshness_score INTEGER DEFAULT 50`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_observations_freshness ON observations(freshness_score, is_active)`); } catch {}

  // Phase 11: Maintenance log — tracks last maintenance runs per project
  db.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      task TEXT NOT NULL,
      result_summary TEXT,
      run_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_path, task)
    );
    CREATE INDEX IF NOT EXISTS idx_maintenance_project ON maintenance_log(project_path);
  `);

  // Phase 12: Team memory sync — synced_at for tracking repo sync state
  try { db.exec(`ALTER TABLE observations ADD COLUMN synced_at TEXT`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_observations_synced ON observations(synced_at)`); } catch {}

  // Phase 13: Crystallized memory layers — tiered knowledge (raw=1, synthesis=2, principle=3)
  try { db.exec(`ALTER TABLE observations ADD COLUMN layer INTEGER DEFAULT 1`); } catch {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_observations_layer ON observations(layer, is_active)`); } catch {}
  db.exec(`
    CREATE TABLE IF NOT EXISTS crystallization_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      from_layer INTEGER NOT NULL,
      to_layer INTEGER NOT NULL,
      source_count INTEGER NOT NULL,
      result_observation_id INTEGER,
      run_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_crystallization_project ON crystallization_log(project_path);
  `);

  // Phase 14: Append-only evaluation log — immutable audit trail for self-improvement
  db.exec(`
    CREATE TABLE IF NOT EXISTS evaluation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      intent_id INTEGER,
      intent_content TEXT,
      action_id INTEGER,
      action_content TEXT,
      outcome_id INTEGER,
      outcome_content TEXT,
      llm_verdict TEXT NOT NULL,
      verdict_reason TEXT,
      confidence_delta INTEGER DEFAULT 0,
      variable_changed TEXT,
      evaluated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_eval_log_project ON evaluation_log(project_path);
    CREATE INDEX IF NOT EXISTS idx_eval_log_verdict ON evaluation_log(llm_verdict);
    CREATE INDEX IF NOT EXISTS idx_eval_log_time ON evaluation_log(evaluated_at);
  `);

  // Phase 15: FSM engine — state machines, transitions, per-agent state
  db.exec(`
    CREATE TABLE IF NOT EXISTS state_machines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      definition TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agent_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      machine_name TEXT NOT NULL,
      current_state TEXT NOT NULL,
      state_data TEXT DEFAULT '{}',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_transition_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(agent_id, machine_name)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_states_agent ON agent_states(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_states_machine ON agent_states(machine_name, current_state);
  `);

  // Phase 16: Rule engine — declarative condition-action rules
  db.exec(`
    CREATE TABLE IF NOT EXISTS brain_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      priority INTEGER DEFAULT 5,
      event TEXT NOT NULL,
      condition_type TEXT NOT NULL,
      condition_config TEXT NOT NULL,
      action_type TEXT NOT NULL,
      action_config TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rules_event ON brain_rules(event, enabled);
    CREATE INDEX IF NOT EXISTS idx_rules_priority ON brain_rules(priority);
  `);

  // Phase 17: Workflow executor — multi-step procedures with dependencies
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      steps TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS workflow_instances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_name TEXT NOT NULL,
      agent_id TEXT,
      project_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      current_step TEXT,
      completed_steps TEXT DEFAULT '[]',
      step_results TEXT DEFAULT '{}',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_instances_status ON workflow_instances(status, agent_id);
  `);

  // Phase 18: Recovery layer — probe-gated retry, LLM negative cache, counter-evidence decay
  db.exec(`
    CREATE TABLE IF NOT EXISTS condition_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      condition TEXT NOT NULL,
      occurrences INTEGER NOT NULL DEFAULT 0,
      last_failure_at TEXT,
      last_error_id INTEGER,
      last_error_text TEXT,
      last_probe_ok INTEGER,
      last_probe_at TEXT,
      resolved INTEGER NOT NULL DEFAULT 0,
      UNIQUE(project_path, condition)
    );
    CREATE INDEX IF NOT EXISTS idx_condition_states_project ON condition_states(project_path);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cache_key TEXT UNIQUE NOT NULL,
      operation TEXT NOT NULL,
      input_text TEXT,
      result TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok',
      hit_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_hit_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_llm_cache_operation ON llm_cache(operation);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS failure_decay (
      error_id INTEGER PRIMARY KEY REFERENCES observations(id) ON DELETE CASCADE,
      project_path TEXT NOT NULL,
      lesson_count INTEGER NOT NULL DEFAULT 1,
      last_success_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_failure_decay_project ON failure_decay(project_path);
  `);

  // Phase 19: Fine-grained multi-agent sharing + inter-agent mailbox
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
      shared_with TEXT NOT NULL,
      shared_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(observation_id, shared_with)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_shares_with ON memory_shares(shared_with);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mailbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      subject TEXT,
      body TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'message',
      ref_observation_id INTEGER,
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mailbox_to ON mailbox(to_agent, read);
    CREATE INDEX IF NOT EXISTS idx_mailbox_ref ON mailbox(ref_observation_id);
  `);

  // Phase 20: Test-time compute reasoning — Tree of Thoughts / MCTS traces
  db.exec(`
    CREATE TABLE IF NOT EXISTS reasoning_traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      problem TEXT NOT NULL,
      strategy TEXT DEFAULT 'beam',
      difficulty_score INTEGER DEFAULT 0,
      root_node_id INTEGER,
      best_node_id INTEGER,
      nodes_explored INTEGER DEFAULT 0,
      tokens_spent INTEGER DEFAULT 0,
      branches_pruned INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'running',
      project_path TEXT NOT NULL,
      reflexion_context TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reasoning_traces_project ON reasoning_traces(project_path);
    CREATE INDEX IF NOT EXISTS idx_reasoning_traces_status ON reasoning_traces(status);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS reasoning_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id INTEGER NOT NULL REFERENCES reasoning_traces(id) ON DELETE CASCADE,
      parent_id INTEGER,
      step_index INTEGER NOT NULL DEFAULT 0,
      step_content TEXT NOT NULL,
      step_type TEXT DEFAULT 'reasoning',
      branch_label TEXT,
      prm_score REAL DEFAULT 0.0,
      is_pruned INTEGER DEFAULT 0,
      prune_reason TEXT,
      is_terminal INTEGER DEFAULT 0,
      visit_count INTEGER DEFAULT 0,
      q_value REAL DEFAULT 0.0,
      children_ids TEXT DEFAULT '[]',
      verification_result TEXT,
      error_observation_id INTEGER,
      execution_output TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reasoning_nodes_trace ON reasoning_nodes(trace_id);
    CREATE INDEX IF NOT EXISTS idx_reasoning_nodes_parent ON reasoning_nodes(parent_id);
    CREATE INDEX IF NOT EXISTS idx_reasoning_nodes_prm ON reasoning_nodes(prm_score);
    CREATE INDEX IF NOT EXISTS idx_reasoning_nodes_active ON reasoning_nodes(is_pruned, is_terminal);
  `);

  // Phase 22: Failure condition classification + retry gating
  db.exec(`
    CREATE TABLE IF NOT EXISTS failure_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      command_key TEXT NOT NULL,
      error_signature TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      condition_kind TEXT DEFAULT 'other',
      condition_target TEXT,
      suggestion TEXT,
      resolved INTEGER NOT NULL DEFAULT 0,
      last_failed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_path, command_key)
    );
    CREATE INDEX IF NOT EXISTS idx_failure_lessons_project ON failure_lessons(project_path);
    CREATE INDEX IF NOT EXISTS idx_failure_lessons_kind ON failure_lessons(condition_kind);
  `);

  // Phase 23: Experience replay — learn successful operations as scripts
  db.exec(`
    CREATE TABLE IF NOT EXISTS experience_scripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      command_key TEXT NOT NULL,
      label TEXT,
      steps TEXT NOT NULL,
      runs INTEGER DEFAULT 0,
      successes INTEGER DEFAULT 0,
      failures INTEGER DEFAULT 0,
      llm_calls_saved INTEGER DEFAULT 0,
      est_cost_saved REAL DEFAULT 0.0,
      last_run TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_path, command_key)
    );
    CREATE INDEX IF NOT EXISTS idx_experience_scripts_project ON experience_scripts(project_path);
    CREATE TABLE IF NOT EXISTS experience_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      script_id INTEGER REFERENCES experience_scripts(id),
      project_path TEXT NOT NULL,
      kind TEXT DEFAULT 'record',
      outcome TEXT NOT NULL,
      llm_calls_saved INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      est_cost_saved REAL DEFAULT 0.0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_experience_execs_project ON experience_executions(project_path);
  `);

  // Phase 24: Translation store — LLM-fallback absorption (learn once, replay free)
  db.exec(`
    CREATE TABLE IF NOT EXISTS translations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      uses INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_path, cache_key)
    );
    CREATE INDEX IF NOT EXISTS idx_translations_project ON translations(project_path);
  `);

  // Phase 25: Burst budget — rolling-window rate limiting + circuit breaker
  db.exec(`
    CREATE TABLE IF NOT EXISTS burst_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      outcome TEXT DEFAULT 'success',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_burst_audit_project ON burst_audit(project_path);
    CREATE TABLE IF NOT EXISTS burst_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      project_path TEXT UNIQUE NOT NULL,
      circuit_open INTEGER NOT NULL DEFAULT 0,
      open_reason TEXT,
      opened_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Phase 26: War room — self-improvement arena
  db.exec(`
    CREATE TABLE IF NOT EXISTS war_room_scoreboard (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      round_number INTEGER NOT NULL,
      scenario_id TEXT NOT NULL,
      scenario_name TEXT,
      difficulty TEXT DEFAULT 'medium',
      kind TEXT DEFAULT 'code',
      score INTEGER DEFAULT 0,
      issues_found INTEGER DEFAULT 0,
      planted_issues INTEGER DEFAULT 0,
      fixes_applied INTEGER DEFAULT 0,
      new_observations INTEGER DEFAULT 0,
      new_patterns INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_war_room_project ON war_room_scoreboard(project_path);
    CREATE INDEX IF NOT EXISTS idx_war_room_difficulty ON war_room_scoreboard(difficulty);
  `);

  // Phase 27: Swarm — persona-based multi-agent orchestration
  db.exec(`
    CREATE TABLE IF NOT EXISTS swarm_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT NOT NULL,
      goal TEXT NOT NULL,
      parent_task_id INTEGER,
      agent_role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER DEFAULT 5,
      dependency_ids TEXT DEFAULT '[]',
      result_summary TEXT,
      result_observation_id INTEGER,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_swarm_tasks_project ON swarm_tasks(project_path);
    CREATE INDEX IF NOT EXISTS idx_swarm_tasks_status ON swarm_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_swarm_tasks_role ON swarm_tasks(agent_role, status);
  `);
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
