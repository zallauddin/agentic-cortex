/**
 * translation-store.js — LLM-fallback absorption: learn once, replay free.
 *
 * Ported from auton/core/translations.py. When the optional LLM resolves
 * something the deterministic path cannot — an unrecognized command, a
 * semantic description — the mapping is absorbed here so the identical
 * input resolves deterministically next time with ZERO LLM calls.
 *
 * Keys are namespaced:
 *   "problem|<normalized problem>"  -> { solution, confidence, steps }
 *   "verify|<content hash>"         -> { verdict, score, reason }
 *
 * Each row tracks `uses` — how many times the cached mapping resolved
 * deterministically (i.e. LLM calls saved). Bounded to MAX_ENTRIES with
 * least-recently-used eviction; scoped per project.
 *
 * @module core/translation-store
 */

'use strict';

const crypto = require('crypto');

const MAX_ENTRIES = 500;

// ─── Helpers ──────────────────────────────────────────────────────────

function hashContent(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function namespaceKey(ns, key) {
  return `${ns}|${(key || '').trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

// ─── Store operations ─────────────────────────────────────────────────

/**
 * Look up a cached mapping. Bumps the `uses` counter on every hit
 * (representing one LLM call avoided).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} namespace — e.g. "problem", "verify"
 * @param {string} key — the normalized input
 * @param {string} [project]
 * @returns {Object|null} the cached payload, or null
 */
function lookup(db, namespace, key, project) {
  const proj = project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const cacheKey = namespaceKey(namespace, key);
  const row = db.prepare(
    `SELECT payload, uses FROM translations WHERE project_path = ? AND cache_key = ?`
  ).get(proj, cacheKey);
  if (!row) return null;

  // Increment uses — every hit avoided an LLM call
  db.prepare(
    `UPDATE translations SET uses = uses + 1 WHERE project_path = ? AND cache_key = ?`
  ).run(proj, cacheKey);

  try {
    return { ...JSON.parse(row.payload), _uses: row.uses + 1 };
  } catch {
    return null;
  }
}

/**
 * Store a learned mapping. Upserts on conflict, preserving `created_at`
 * and `uses` from the original learning.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} namespace — e.g. "problem", "verify"
 * @param {string} key — the normalized input
 * @param {Object} payload — the resolved mapping
 * @param {string} [project]
 */
function store(db, namespace, key, payload, project) {
  const proj = project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const cacheKey = namespaceKey(namespace, key);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO translations (project_path, cache_key, payload, uses, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?)
    ON CONFLICT(project_path, cache_key) DO UPDATE SET
      payload = excluded.payload, updated_at = excluded.updated_at
  `).run(proj, cacheKey, JSON.stringify(payload), now, now);

  evict(db, proj);
}

/**
 * Delete a cached mapping.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} namespace
 * @param {string} key
 * @param {string} [project]
 * @returns {boolean}
 */
function forget(db, namespace, key, project) {
  const proj = project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const cacheKey = namespaceKey(namespace, key);
  const result = db.prepare(
    `DELETE FROM translations WHERE project_path = ? AND cache_key = ?`
  ).run(proj, cacheKey);
  return result.changes > 0;
}

/**
 * List all translations for a project.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @param {string} [opts.namespace] — filter by namespace prefix
 * @param {number} [opts.limit=200]
 * @returns {Array<Object>}
 */
function list(db, opts = {}) {
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const limit = opts.limit || 200;
  let query, params;
  if (opts.namespace) {
    query = `SELECT * FROM translations WHERE project_path = ? AND cache_key LIKE ? ORDER BY updated_at DESC LIMIT ?`;
    params = [proj, `${opts.namespace}|%`, limit];
  } else {
    query = `SELECT * FROM translations WHERE project_path = ? ORDER BY updated_at DESC LIMIT ?`;
    params = [proj, limit];
  }
  const rows = db.prepare(query).all(...params);
  for (const r of rows) {
    try { r.payload = JSON.parse(r.payload); } catch { r.payload = {}; }
  }
  return rows;
}

/**
 * Get aggregate stats: how many translations exist and how many times
 * they've been used (LLM calls saved).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} [project]
 * @returns {{ total: number, byNamespace: Object, totalUses: number }}
 */
function stats(db, project) {
  const proj = project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const rows = db.prepare(
    `SELECT cache_key, uses FROM translations WHERE project_path = ?`
  ).all(proj);
  const byNamespace = {};
  let totalUses = 0;
  for (const r of rows) {
    const ns = r.cache_key.split('|')[0] || 'other';
    byNamespace[ns] = (byNamespace[ns] || 0) + 1;
    totalUses += r.uses || 0;
  }
  return { total: rows.length, byNamespace, totalUses };
}

// ─── Internal ──────────────────────────────────────────────────────────

function evict(db, project) {
  const rows = db.prepare(
    `SELECT id FROM translations WHERE project_path = ? ORDER BY updated_at DESC LIMIT -1 OFFSET ?`
  ).all(project, MAX_ENTRIES);
  const del = db.prepare(`DELETE FROM translations WHERE id = ?`);
  for (const r of rows) del.run(r.id);
}

// ─── Exports ──────────────────────────────────────────────────────────

module.exports = {
  lookup,
  store,
  forget,
  list,
  stats,
  hashContent,
  namespaceKey,
};