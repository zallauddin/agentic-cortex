/**
 * forgetting.js — Temporal forgetting & supersession for agentic-cortex.
 *
 * Learned from supermemory's temporal fact lifecycle:
 *   - Temporary facts get a bounded lifespan ("I have an exam tomorrow" must
 *     die after the date passes, not linger via a slow freshness decay).
 *   - Contradictory updates explicitly supersede: "I just moved to SF"
 *     supersedes "I live in NYC" — the old fact is marked, not silently
 *     left to compete in retrieval.
 *
 * Everything here is deterministic and LLM-free: parsing, sweeps, and
 * marking are pure SQLite + regex, so they run in maintenance, bootstrap,
 * and search with zero cost and never fail because a model is away.
 *
 * @module core/forgetting
 */

'use strict';

// ─── Expiry parsing ──────────────────────────────────────────────────

/** Matches absolute dates in common formats: 2026-03-05, 2026/03/05, March 5 2026, Mar 5, 2026 */
const ABSOLUTE_DATE_RE =
  /\b(\d{4}[-/](\d{1,2})[-/](\d{1,2}))\b|\b((jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}))\b/i;

/** Matches relative spans: "in 3 days", "for 2 weeks", "next month", "tomorrow" */
const RELATIVE_SPAN_RE =
  /\b(?:in|within|for|after)\s+(a|an|\d+)\s+(day|week|month|year|hour)s?\b|\btomorrow\b|\bnext\s+(week|month|year)\b/i;

const UNIT_MS = {
  hour: 3600 * 1000,
  day: 24 * 3600 * 1000,
  week: 7 * 24 * 3600 * 1000,
  month: 30 * 24 * 3600 * 1000,
  year: 365 * 24 * 3600 * 1000,
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Parse an ISO-8601 datetime string into a Date, tolerating SQLite's
 * "YYYY-MM-DD HH:MM:SS" (no timezone) and missing timezone offsets.
 *
 * @param {string} s
 * @returns {Date|null}
 */
function parseTs(s) {
  if (!s) return null;
  let str = String(s).trim().replace(' ', 'T');
  if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(str)) str += 'Z'; // SQLite UTC convention
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Extract an expiry timestamp from free text, an explicit opts.expiresAt,
 * or a TTL in days. Returns null when no expiry is implied.
 *
 * Detection order:
 *   1. opts.expiresAt (ISO string) — explicit wins
 *   2. opts.ttlDays (number) — mechanical
 *   3. absolute date in text ("deadline is 2026-03-05")
 *   4. relative span in text ("in 2 weeks", "tomorrow")
 *
 * @param {string} text — memory content (+ title)
 * @param {Object} [opts] — { expiresAt?: string, ttlDays?: number, now?: Date }
 * @returns {string|null} ISO timestamp, or null
 */
function extractExpiry(text, opts) {
  opts = opts || {};
  const now = opts.now || new Date();

  // 1. Explicit ISO timestamp
  if (opts.expiresAt) {
    const d = parseTs(opts.expiresAt);
    if (d) return d.toISOString();
  }

  // 2. Explicit TTL
  if (typeof opts.ttlDays === 'number' && opts.ttlDays > 0) {
    return new Date(now.getTime() + opts.ttlDays * UNIT_MS.day).toISOString();
  }

  const t = String(text || '');

  // 3. Absolute date — take the FIRST date mentioned; skip dates already
  //    in the past unless they are within the last 48h (a same-day mention).
  const abs = t.match(ABSOLUTE_DATE_RE);
  if (abs) {
    let d = null;
    if (abs[1]) {
      // abs[1] = "YYYY-MM-DD" (groups 2,3 are month/day re-captures)
      const [ys, ms, ds] = abs[1].split(/[-\/]/);
      d = new Date(Date.UTC(Number(ys), Number(ms) - 1, Number(ds), 23, 59, 59));
    } else if (abs[4]) {
      const mon = MONTHS.indexOf(abs[5].slice(0, 3).toLowerCase());
      d = new Date(Date.UTC(Number(abs[8]), mon, Number(abs[7]), 23, 59, 59));
    }
    if (d && !isNaN(d.getTime())) {
      // Only future dates imply an expiry
      if (d.getTime() > now.getTime()) return d.toISOString();
    }
  }

  // 4. Relative span
  const rel = t.match(RELATIVE_SPAN_RE);
  if (rel) {
    if (/tomorrow/i.test(rel[0])) {
      const d = new Date(now.getTime() + UNIT_MS.day);
      d.setUTCHours(23, 59, 59, 0);
      return d.toISOString();
    }
    if (/^next\s+/i.test(rel[0])) {
      const unit = rel[0].split(/\s+/)[1].toLowerCase().replace(/s$/, '');
      const mult = unit === 'week' ? 1 : unit === 'month' ? 4 : unit === 'year' ? 52 : 1;
      return new Date(now.getTime() + UNIT_MS.week * mult).toISOString();
    }
    const qty = (rel[1] === 'a' || rel[1] === 'an') ? 1 : parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    if (qty > 0 && UNIT_MS[unit]) {
      return new Date(now.getTime() + qty * UNIT_MS[unit]).toISOString();
    }
  }

  return null;
}

// ─── Expiry sweep ────────────────────────────────────────────────────

/**
 * Expire every active memory whose expires_at has passed. Expired memories
 * are soft-deleted (is_active = 0) — same semantic as `forget`, recoverable
 * via list with includeExpired-style queries, and never hard-destroyed.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} [opts] — { project?: string, dryRun?: boolean, now?: Date }
 * @returns {{ expired: number, ids: number[], dryRun: boolean }}
 */
function expireDueMemories(db, opts) {
  opts = opts || {};
  const nowIso = (opts.now || new Date()).toISOString();
  const dryRun = !!opts.dryRun;

  let where = 'is_active = 1 AND expires_at IS NOT NULL AND expires_at <= ?';
  const params = [nowIso];
  if (opts.project) { where += ' AND project_path = ?'; params.push(opts.project); }

  let due;
  try {
    due = db.prepare(
      'SELECT id, title, project_path, expires_at FROM observations WHERE ' + where + ' ORDER BY expires_at ASC'
    ).all(...params);
  } catch {
    // Schema not migrated yet (pre-Phase-15 DB) — nothing to do
    return { expired: 0, ids: [], dryRun };
  }

  if (dryRun) return { expired: 0, ids: due.map(d => d.id), candidates: due.length, dryRun };

  const update = db.prepare('UPDATE observations SET is_active = 0 WHERE id = ?');
  const tx = db.transaction((ids) => { for (const id of ids) update.run(id); });
  tx(due.map(d => d.id));

  return { expired: due.length, ids: due.map(d => d.id), dryRun: false };
}

// ─── Supersession ────────────────────────────────────────────────────

/**
 * Mark an old memory as superseded by a newer one. The old memory stays in
 * the vault (auditability, version history) but is excluded from retrieval:
 * buildWhereClause filters `superseded_by IS NULL` unless includeSuperseded.
 *
 * Unlike a conflict resolution (Dempster-Shafer debate), supersession is a
 * fast, mechanical "this replaced that" link for updates of the same fact —
 * e.g. a deploy date, a config value, "I moved to SF".
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} oldId — the memory being replaced
 * @param {number} newId — the memory replacing it
 * @param {Object} [opts] — { reason?: string }
 * @returns {{ oldId: number, newId: number, superseded: boolean }}
 */
function supersede(db, oldId, newId, opts) {
  opts = opts || {};
  if (!db) throw new Error('db is required');
  const oldRow = db.prepare('SELECT id, is_active FROM observations WHERE id = ?').get(oldId);
  const newRow = db.prepare('SELECT id FROM observations WHERE id = ?').get(newId);
  if (!oldRow || !newRow) throw new Error('Supersession requires both observations to exist');
  if (oldId === newId) throw new Error('Cannot supersede a memory with itself');

  db.prepare('UPDATE observations SET superseded_by = ?, is_active = 0 WHERE id = ?').run(newId, oldId);

  // Record the relation so the graph shows the lineage
  try {
    db.prepare(
      "INSERT OR IGNORE INTO memory_relations (source_id, target_id, relation_type, confidence, reason) VALUES (?, ?, 'supersedes', 100, ?)"
    ).run(newId, oldId, opts.reason || 'temporal update: newer fact replaces older');
  } catch { /* relations table missing — non-fatal */ }

  return { oldId, newId, superseded: true, reason: opts.reason || null };
}

/**
 * Types eligible for automatic supersession. Only statement-like knowledge
 * (facts/decisions/preferences) participates — run-of-the-mill observations,
 * errors, and events are never auto-superseded by a similar-titled save.
 * Fuzzy contradiction handling for everything else stays with the
 * Dempster-Shafer debate pipeline, which has an LLM.
 *
 * @type {Set<string>}
 */
const SUPERSEDEABLE_TYPES = new Set(['fact', 'decision', 'preference', 'context', 'learning']);

/**
 * Check whether a new save should supersede an existing memory: same
 * project, same statement-like type, highly similar title — but NEWER. This
 * is the deterministic (no-LLM) half of contradiction handling: instead of
 * letting "deploy is Friday" and "deploy is Monday" both surface, the
 * newest wins and the older is marked.
 *
 * Conservative by design: title-token Jaccard ≥ 0.6 within SUPERSEDEABLE_TYPES
 * only. Over-eager fuzzy supersession is the job of the conflict/debate
 * pipeline, which has an LLM and Dempster-Shafer.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} saved — the just-saved observation ({ id, type, title, content, project_path })
 * @param {Object} [opts] — { similarityThreshold?: number, excludeIds?: number[] }
 * @returns {{ supersededId: number|null, similarity: number }}
 */
function findSupersededTarget(db, saved, opts) {
  opts = opts || {};
  const threshold = opts.similarityThreshold ?? 0.6;
  const out = { supersededId: null, similarity: 0 };
  if (!saved || !saved.id || !saved.title || !saved.project_path) return out;
  if (!SUPERSEDEABLE_TYPES.has(saved.type)) return out;

  let candidates;
  try {
    candidates = db.prepare(
      'SELECT id, title, content, created_at FROM observations WHERE project_path = ? AND type = ? AND is_active = 1 AND id != ? AND id != COALESCE(superseded_by, -1) ORDER BY created_at DESC LIMIT 40'
    ).all(saved.project_path, saved.type, saved.id);
  } catch {
    return out;
  }

  const norm = (s) => String(s || '').toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
  const toks = new Set(norm(saved.title));

  for (const c of candidates) {
    if (opts.excludeIds && opts.excludeIds.includes(c.id)) continue;
    const cToks = new Set(norm(c.title));
    if (cToks.size === 0) continue;
    let inter = 0;
    for (const w of toks) if (cToks.has(w)) inter++;
    const union = new Set([...toks, ...cToks]).size;
    const sim = union > 0 ? inter / union : 0;
    if (sim >= threshold && sim > out.similarity) {
      out.supersededId = c.id;
      out.similarity = Math.round(sim * 1000) / 1000;
    }
  }
  return out;
}

module.exports = {
  extractExpiry,
  parseTs,
  expireDueMemories,
  supersede,
  findSupersededTarget,
  SUPERSEDEABLE_TYPES,
  UNIT_MS,
};
