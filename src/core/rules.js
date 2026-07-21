/**
 * rules.js — Declarative Rule Engine for agentic-cortex.
 *
 * Provides a priority-based condition→action rule system that integrates
 * with the hooks system and FSM engine. Rules fire on events (post_save,
 * state_transition, manual) and can chain: one rule's output feeds another.
 *
 * This is the "deliberate thinking" layer — not just reflexes (hooks) but
 * conditional reasoning with priorities and conflict resolution.
 *
 * Features:
 * - Declarative rules: WHEN condition THEN actions
 * - Priority-based execution (higher priority = first)
 * - Condition types: observation_count, field_match, tag_contains, state_equals
 * - Action types: save_observation, spawn_experiment, transition_state, run_maintenance, crystallize
 * - Rule chaining: one rule's output can trigger another rule
 * - Non-LLM compatible: all conditions are deterministic
 *
 * @module core/rules
 */

'use strict';

// Injected dependencies
let _saveFn = null;
let _fsm = null;

// ─── Rule Definitions ──────────────────────────────────────────────

const DEFAULT_RULES = [
  {
    name: 'escalate-recurring-errors',
    priority: 10,
    event: 'post_save',
    condition_type: 'tag_count',
    condition_config: { minCount: 5, withinMinutes: 10080, type: 'error' },
    action_type: 'spawn_experiment',
    action_config: { note: 'Auto-escalated by rule engine' },
  },
  {
    name: 'auto-crystallize-on-milestone',
    priority: 8,
    event: 'state_transition',
    condition_type: 'state_equals',
    condition_config: { toState: 'done' },
    action_type: 'crystallize',
    action_config: {},
  },
  {
    name: 'run-maintenance-on-review',
    priority: 6,
    event: 'state_transition',
    condition_type: 'state_equals',
    condition_config: { toState: 'reviewing' },
    action_type: 'run_maintenance',
    action_config: {},
  },
  {
    name: 'save-context-on-state-change',
    priority: 3,
    event: 'state_transition',
    condition_type: 'always',
    condition_config: {},
    action_type: 'save_observation',
    action_config: {
      type: 'context',
      title: 'State transition: {{fromState}} → {{toState}}',
      content: 'Agent transitioned from {{fromState}} to {{toState}} via trigger "{{trigger}}".',
      tags: ['fsm', 'state-transition', 'auto-capture'],
    },
  },
];

/**
 * Define a new rule. Can be persisted to DB or in-memory only.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} def — { name, priority, event, condition_type, condition_config, action_type, action_config, enabled? }
 * @param {boolean} [persist=true] — Whether to save to DB
 * @returns {Object} Created rule
 */
function defineRule(db, def, persist = true) {
  if (!def.name || !def.event || !def.condition_type || !def.action_type) {
    throw new Error('Rule requires: name, event, condition_type, action_type');
  }

  if (persist) {
    const existing = db.prepare('SELECT id FROM brain_rules WHERE name = ?').get(def.name);
    if (existing) {
      db.prepare(
        'UPDATE brain_rules SET priority=?, event=?, condition_type=?, condition_config=?, action_type=?, action_config=?, enabled=? WHERE id=?'
      ).run(
        def.priority || 5, def.event, def.condition_type,
        JSON.stringify(def.condition_config || {}),
        def.action_type, JSON.stringify(def.action_config || {}),
        def.enabled !== false ? 1 : 0, existing.id
      );
      return { id: existing.id, status: 'updated' };
    }
    const r = db.prepare(
      'INSERT INTO brain_rules (name, priority, event, condition_type, condition_config, action_type, action_config, enabled) VALUES (?,?,?,?,?,?,?,?)'
    ).run(
      def.name, def.priority || 5, def.event, def.condition_type,
      JSON.stringify(def.condition_config || {}),
      def.action_type, JSON.stringify(def.action_config || {}),
      def.enabled !== false ? 1 : 0
    );
    return { id: Number(r.lastInsertRowid), status: 'created' };
  }

  return { id: null, status: 'in_memory_only' };
}

// ─── Rule Evaluation ────────────────────────────────────────────────

/**
 * Evaluate all matching rules for an event.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} event — 'post_save', 'state_transition', 'manual'
 * @param {Object} context — Event-specific context (observation, state transition data, etc.)
 * @returns {Promise<Array<{rule: string, matched: boolean, action: string, result: any}>>}
 */
async function evaluate(db, event, context) {
  const results = [];

  // Get rules: in-memory defaults + persisted
  const persisted = db.prepare('SELECT * FROM brain_rules WHERE event = ? AND enabled = 1 ORDER BY priority DESC').all(event);

  // Combine with defaults, prefer persisted over defaults with same name
  const allRules = [...DEFAULT_RULES];
  for (const pr of persisted) {
    const idx = allRules.findIndex(r => r.name === pr.name);
    const ruleObj = {
      name: pr.name, priority: pr.priority, event: pr.event,
      condition_type: pr.condition_type,
      condition_config: JSON.parse(pr.condition_config || '{}'),
      action_type: pr.action_type,
      action_config: JSON.parse(pr.action_config || '{}'),
      enabled: !!pr.enabled,
    };
    if (idx >= 0) allRules[idx] = ruleObj;
    else allRules.push(ruleObj);
  }

  // Sort by priority descending
  allRules.sort((a, b) => (b.priority || 0) - (a.priority || 0));

  for (const rule of allRules) {
    if (rule.enabled === false) continue;
    if (rule.event !== event) continue;

    const matched = _checkCondition(db, rule, context);
    if (!matched) {
      results.push({ rule: rule.name, matched: false, action: rule.action_type });
      continue;
    }

    try {
      const result = await _executeAction(db, rule, context);
      results.push({ rule: rule.name, matched: true, action: rule.action_type, result });
    } catch (e) {
      console.warn('[rules] Rule "%s" action failed: %s', rule.name, e.message);
      results.push({ rule: rule.name, matched: true, action: rule.action_type, error: e.message });
    }
  }

  return results;
}

// ─── Condition Checking ─────────────────────────────────────────────

function _checkCondition(db, rule, context) {
  const config = rule.condition_config || {};

  switch (rule.condition_type) {
    case 'always':
      return true;

    case 'state_equals': {
      const targetState = config.toState || config.state;
      if (!targetState) return false;
      return context.toState === targetState || context.state === targetState;
    }

    case 'tag_count': {
      if (!context.project_path && !context.project) return false;
      const project = context.project_path || context.project;
      const type = config.type || 'error';
      const minCount = config.minCount || 3;

      // Count observations of this type
      const count = db.prepare(
        'SELECT COUNT(*) as c FROM observations WHERE project_path = ? AND type = ? AND is_active = 1'
      ).get(project, type).c;

      return count >= minCount;
    }

    case 'field_match': {
      const field = config.field;
      const value = config.value;
      if (!field) return false;
      if (context[field] === undefined) return false;
      if (value !== undefined && context[field] !== value) return false;
      return true;
    }

    case 'observation_count': {
      if (!context.project_path && !context.project) return false;
      const project = context.project_path || context.project;
      const type = config.type || 'error';
      const minCount = config.minCount || 5;

      const count = db.prepare(
        'SELECT COUNT(*) as c FROM observations WHERE project_path = ? AND type = ? AND is_active = 1'
      ).get(project, type).c;

      return count >= minCount;
    }

    default:
      return false;
  }
}

// ─── Action Execution ───────────────────────────────────────────────

async function _executeAction(db, rule, context) {
  const config = rule.action_config || {};

  // Template interpolation
  function tpl(str) {
    if (!str) return '';
    return str.replace(/\{\{(\w+)\}\}/g, (_, key) => context[key] !== undefined ? context[key] : '');
  }

  switch (rule.action_type) {
    case 'save_observation': {
      if (!_saveFn) return null;
      const obs = await _saveFn({
        project: context.project_path || context.project || process.cwd(),
        type: config.type || 'observation',
        title: tpl(config.title || 'Rule: ' + rule.name),
        content: tpl(config.content || ''),
        tags: config.tags || ['rule-triggered', 'auto-capture'],
        importance: config.importance || 5,
        provenance: 'inferred',
        agentId: context.agentId || null,
      });
      return obs;
    }

    case 'spawn_experiment': {
      try {
        const selfImprove = require('./self-improve');
        const tag = context.tag || config.tag || 'auto';
        return await selfImprove.spawnExperiment(db, {
          project: context.project_path || context.project || process.cwd(),
          errorTag: tag,
        });
      } catch { return null; }
    }

    case 'transition_state': {
      if (!_fsm || !context.agentId) return null;
      return _fsm.transition(db, context.agentId, config.trigger || 'auto');
    }

    case 'run_maintenance': {
      try {
        const api = require('../api');
        return await api.runMaintenance({
          project: context.project_path || context.project || process.cwd(),
        });
      } catch { return null; }
    }

    case 'crystallize': {
      try {
        const api = require('../api');
        return await api.crystallize({
          project: context.project_path || context.project || process.cwd(),
        });
      } catch { return null; }
    }

    default:
      throw new Error('Unknown action type: ' + rule.action_type);
  }
}

// ─── Rule Management ────────────────────────────────────────────────

/**
 * List all rules (in-memory + persisted).
 * @param {import('better-sqlite3').Database} db
 * @param {Object} [opts] — { event?, enabled? }
 * @returns {Array<Object>}
 */
function listRules(db, opts = {}) {
  const persisted = db.prepare('SELECT * FROM brain_rules ORDER BY priority DESC').all();
  const result = [...DEFAULT_RULES.map(r => ({ ...r, source: 'built-in', id: null }))];

  for (const pr of persisted) {
    const idx = result.findIndex(r => r.name === pr.name);
    const obj = {
      id: pr.id, name: pr.name, priority: pr.priority, event: pr.event,
      condition_type: pr.condition_type,
      condition_config: JSON.parse(pr.condition_config || '{}'),
      action_type: pr.action_type,
      action_config: JSON.parse(pr.action_config || '{}'),
      enabled: !!pr.enabled, source: 'persisted',
    };
    if (idx >= 0) result[idx] = obj;
    else result.push(obj);
  }

  let filtered = result;
  if (opts.event) filtered = filtered.filter(r => r.event === opts.event);
  if (opts.enabled !== undefined) filtered = filtered.filter(r => r.enabled === opts.enabled);

  return filtered;
}

/**
 * Delete a persisted rule.
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 * @returns {Object}
 */
function deleteRule(db, id) {
  const r = db.prepare('DELETE FROM brain_rules WHERE id = ?').run(id);
  if (r.changes === 0) throw new Error('Rule not found: ' + id);
  return { id, status: 'deleted' };
}

/**
 * Enable/disable a persisted rule.
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 * @param {boolean} enabled
 * @returns {Object}
 */
function setRuleEnabled(db, id, enabled) {
  const r = db.prepare('UPDATE brain_rules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  if (r.changes === 0) throw new Error('Rule not found: ' + id);
  return { id, status: enabled ? 'enabled' : 'disabled' };
}

// ─── Initialization ─────────────────────────────────────────────────

/**
 * Register rules as a hook so they fire automatically on every save.
 * @param {import('better-sqlite3').Database} db
 */
function initRuleHook(db) {
  const hooks = require('./hooks');
  hooks.registerHook('post_save', async (obs, ctx) => {
    try {
      await evaluate(db, 'post_save', obs);
    } catch { /* best-effort */ }
  });
}

// ─── Dependency Injection ───────────────────────────────────────────

function setSaveFunction(fn) { _saveFn = fn; }
function setFsm(fsm) { _fsm = fsm; }

// ─── Exports ────────────────────────────────────────────────────────

module.exports = {
  DEFAULT_RULES,
  defineRule,
  evaluate,
  listRules,
  deleteRule,
  setRuleEnabled,
  initRuleHook,
  setSaveFunction,
  setFsm,
};
