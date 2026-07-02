/**
 * hooks.js — Auto-capture hook system.
 *
 * Allows registering callbacks that trigger on memory events (save, edit, forget).
 * Hooks can filter by conditions and execute actions (save related memory, notify, etc.).
 *
 * @module core/hooks
 */

'use strict';

/** @type {Map<string, Array<Function>>} In-memory hook registry */
const _hookRegistry = new Map();

/** @type {Array<Object>} Persisted hook definitions (loaded from DB) */
let _persistedHooks = null;

/**
 * Valid hook events
 * @type {Set<string>}
 */
const VALID_EVENTS = new Set(['pre_save', 'post_save', 'pre_edit', 'post_edit', 'pre_forget', 'post_forget']);

/** Valid action types */
const VALID_ACTION_TYPES = new Set(['save_memory', 'log', 'webhook']);

/**
 * Register an in-memory hook callback.
 * @param {string} event - Event name (pre_save, post_save, etc.)
 * @param {Function} callback - Async function(observation, context)
 * @returns {Function} Unregister function
 */
function registerHook(event, callback) {
  if (!VALID_EVENTS.has(event)) {
    throw new Error('Invalid event: ' + event + '. Valid: ' + [...VALID_EVENTS].join(', '));
  }
  if (typeof callback !== 'function') {
    throw new Error('Callback must be a function');
  }
  if (!_hookRegistry.has(event)) {
    _hookRegistry.set(event, []);
  }
  _hookRegistry.get(event).push(callback);
  return () => unregisterHook(event, callback);
}

/**
 * Unregister an in-memory hook callback.
 * @param {string} event
 * @param {Function} callback
 */
function unregisterHook(event, callback) {
  const arr = _hookRegistry.get(event);
  if (arr) {
    const idx = arr.indexOf(callback);
    if (idx >= 0) arr.splice(idx, 1);
  }
}

/**
 * Trigger all registered hooks for an event.
 * @param {import('better-sqlite3').Database} db
 * @param {string} event
 * @param {Object} observation - The observation data
 * @param {Object} [context] - Additional context
 */
async function triggerHooks(db, event, observation, context) {
  // In-memory hooks
  const memHooks = _hookRegistry.get(event) || [];
  for (const cb of memHooks) {
    try {
      await cb(observation, context, db);
    } catch (err) {
      console.error('[hooks] In-memory hook error for ' + event + ':', err.message);
    }
  }

  // Persisted hooks from database
  const persisted = getPersistedHooks(db, event);
  for (const hook of persisted) {
    if (!hook.enabled) continue;
    try {
      await executePersistedHook(db, hook, observation, context);
    } catch (err) {
      console.error('[hooks] Persisted hook error (' + hook.name + '):', err.message);
    }
  }
}

/**
 * Get persisted hooks for an event from database.
 * @param {import('better-sqlite3').Database} db
 * @param {string} event
 * @returns {Array<Object>}
 */
function getPersistedHooks(db, event) {
  return db.prepare('SELECT * FROM hooks WHERE event = ? AND enabled = 1').all(event);
}

/**
 * Execute a persisted hook definition.
 * @param {import('better-sqlite3').Database} db
 * @param {Object} hook
 * @param {Object} observation
 * @param {Object} context
 */
async function executePersistedHook(db, hook, observation, context) {
  // Check condition
  if (hook.condition_type && hook.condition_value) {
    const match = evaluateCondition(hook.condition_type, hook.condition_value, observation, context);
    if (!match) return;
  }

  const actionConfig = JSON.parse(hook.action_config || '{}');

  switch (hook.action_type) {
    case 'save_memory': {
      // Auto-save a related observation
      const { title, content, type, tags, importance, provenance } = actionConfig;
      const saveOpts = {
        title: interpolate(title, observation, context),
        content: interpolate(content, observation, context),
        type: type || 'observation',
        tags: tags || [],
        importance: importance || 5,
        provenance: provenance || 'inferred',
        project: observation.project_path,
        session: observation.session_id,
        agentId: observation.agent_id || null,
      };
      const { save } = require('../api');
      await save(saveOpts);
      break;
    }
    case 'log': {
      console.log('[hook:' + hook.name + ']', interpolate(actionConfig.message, observation, context));
      break;
    }
    case 'webhook': {
      // Future: HTTP webhook call
      break;
    }
  }
}

/**
 * Evaluate a condition against observation/context.
 */
function evaluateCondition(type, value, observation, context) {
  switch (type) {
    case 'type_equals':
      return observation.type === value;
    case 'tag_contains':
      try { return JSON.parse(observation.tags || '[]').includes(value); } catch { return false; }
    case 'importance_gte':
      return observation.importance >= parseInt(value, 10);
    case 'project_equals':
      return observation.project_path === value;
    case 'custom_js':
      // SECURITY: only allow if explicitly enabled via env
      if (process.env.AGENTIC_CORTEX_HOOKS_JS !== '1') return false;
      try { return new Function('obs', 'ctx', value)(observation, context); } catch { return false; }
    default:
      return true;
  }
}

/**
 * Simple template interpolation: {{field}} -> value from observation or context.
 */
function interpolate(str, observation, context) {
  if (!str) return '';
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (observation[key] !== undefined) return observation[key];
    if (context && context[key] !== undefined) return context[key];
    return '';
  });
}

/**
 * Persist a hook definition to the database.
 * @param {import('better-sqlite3').Database} db
 * @param {Object} opts - { name, event, condition_type?, condition_value?, action_type, action_config, enabled? }
 * @returns {Object} Created hook
 */
function createHook(db, opts) {
  if (!opts.name || !opts.event || !opts.action_type || !opts.action_config) {
    throw new Error('name, event, action_type, and action_config are required');
  }
  if (!VALID_EVENTS.has(opts.event)) {
    throw new Error('Invalid event: ' + opts.event);
  }
  if (!VALID_ACTION_TYPES.has(opts.action_type)) {
    throw new Error('Invalid action_type: ' + opts.action_type);
  }

  const actionConfigStr = typeof opts.action_config === 'string'
    ? opts.action_config
    : JSON.stringify(opts.action_config);

  const r = db.prepare(`
    INSERT INTO hooks (name, event, condition_type, condition_value, action_type, action_config, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.name,
    opts.event,
    opts.condition_type || null,
    opts.condition_value || null,
    opts.action_type,
    actionConfigStr,
    opts.enabled !== false ? 1 : 0
  );

  _persistedHooks = null; // Invalidate cache
  return { id: Number(r.lastInsertRowid), status: 'created' };
}

/**
 * List all persisted hooks.
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<Object>}
 */
function listHooks(db) {
  return db.prepare('SELECT * FROM hooks ORDER BY created_at DESC').all();
}

/**
 * Update a persisted hook.
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 * @param {Object} opts - Fields to update
 * @returns {Object}
 */
function updateHook(db, id, opts) {
  const fields = [];
  const params = [];

  if (opts.event !== undefined) {
    if (!VALID_EVENTS.has(opts.event)) throw new Error('Invalid event: ' + opts.event);
    fields.push('event = ?'); params.push(opts.event);
  }
  if (opts.condition_type !== undefined) { fields.push('condition_type = ?'); params.push(opts.condition_type); }
  if (opts.condition_value !== undefined) { fields.push('condition_value = ?'); params.push(opts.condition_value); }
  if (opts.action_type !== undefined) {
    if (!VALID_ACTION_TYPES.has(opts.action_type)) throw new Error('Invalid action_type: ' + opts.action_type);
    fields.push('action_type = ?'); params.push(opts.action_type);
  }
  if (opts.action_config !== undefined) {
    fields.push('action_config = ?');
    params.push(typeof opts.action_config === 'string' ? opts.action_config : JSON.stringify(opts.action_config));
  }
  if (opts.enabled !== undefined) { fields.push('enabled = ?'); params.push(opts.enabled ? 1 : 0); }

  if (fields.length === 0) throw new Error('No fields to update');

  fields.push('updated_at = datetime(\'now\')');
  params.push(id);

  const r = db.prepare('UPDATE hooks SET ' + fields.join(', ') + ' WHERE id = ?').run(...params);
  _persistedHooks = null;
  if (r.changes === 0) throw new Error('Hook not found: ' + id);
  return { id, status: 'updated' };
}

/**
 * Delete a persisted hook.
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 * @returns {Object}
 */
function deleteHook(db, id) {
  const r = db.prepare('DELETE FROM hooks WHERE id = ?').run(id);
  _persistedHooks = null;
  if (r.changes === 0) throw new Error('Hook not found: ' + id);
  return { id, status: 'deleted' };
}

/**
 * Enable/disable a hook.
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 * @param {boolean} enabled
 * @returns {Object}
 */
function setHookEnabled(db, id, enabled) {
  return updateHook(db, id, { enabled });
}

module.exports = {
  registerHook,
  unregisterHook,
  triggerHooks,
  createHook,
  listHooks,
  updateHook,
  deleteHook,
  setHookEnabled,
  VALID_EVENTS,
  VALID_ACTION_TYPES,
};