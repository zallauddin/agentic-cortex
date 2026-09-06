'use strict';

/**
 * seed-lifecycle.js — Envelope, TTL, trust decay, and expiry for distributed seeds.
 *
 * THE DISTRIBUTED-LEARNING DESIGN (how knowledge gathers at one point but
 * stays distributed with seeds):
 *
 *   1. LOCAL GATHERING — every agent/tool wired to AC writes observations into
 *      one machine-local SQLite vault. Nothing leaves the machine at this stage.
 *   2. DISTILLATION — reflection + crystallization compress raw observations
 *      upward (raw → learning → principle) and confidence/utility prove them.
 *   3. SEEDING — only distilled, battle-tested learnings that pass the
 *      sanitizer are exported as small self-contained "seeds" (markdown with
 *      a lifecycle envelope) to the optional git memory repo. A seed carries
 *      NO identity, NO project paths, NO transcripts — just the lesson.
 *   4. GERMINATION — other machines import seeds into a QUARANTINED scope:
 *      they are advisory, lower-trust than any local memory, decay over
 *      time, and expire if never corroborated locally.
 *   5. LOCALIZATION — when a local agent re-proves a seed (hits the same
 *      lesson, or feedback marks it helpful), the seed graduates to a full
 *      local memory with fresh provenance. The seed was the spark; local
 *      evidence is the fuel.
 *
 * This keeps the loop: gathered centrally on each machine, shared as
 * lightweight disposable seeds, kept distributed (no central server, each
 * machine owns its vault), and bounded in lifespan (nothing imported lives
 * forever on unverified trust).
 *
 * Trust hierarchy (highest → lowest):
 *   local proven (re-proven seed or native memory with feedback)
 *   > local native memory
 *   > corroboration boost applied to a germinated seed
 *   > germinated seed (advisory only)
 *   > expired seed (injected only as a tombstone warning, never as guidance)
 *
 * @module core/seed-lifecycle
 */

const crypto = require('crypto');

/** Default TTL per seed type, in days. Softer knowledge expires sooner. */
const SEED_TTL_DAYS = {
  principle: 365,
  instruction: 180,
  learning: 120,
  pattern: 120,
  synthesis: 120,
  fact: 90,      // facts rot fastest — stacks change
  decision: 90,
};

const DEFAULT_TTL_DAYS = 90;

/** A germinated seed gets this confidence ceiling until corroborated locally. */
const GERMINATED_CONFIDENCE_CAP = 60;

/** Corroboration bonus applied each time a local agent re-proves a seed. */
const CORROBORATION_BOOST = 15;

/** Seeds past this fraction of TTL are flagged "aging" during injection. */
const AGING_FRACTION = 0.75;

/**
 * Stable pseudonymous machine identity for seed envelopes.
 * Derived once from a random file under the AC data dir — NOT a hostname,
 * username, MAC, or serial. Reveals nothing about who or where you are;
 * it only lets the same machine recognize its own seeds on round-trip.
 * @returns {string} e.g. "m_9f2c4e8a"
 */
function machinePseudonym() {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  try {
    const dir = path.join(os.homedir(), '.agentic-cortex');
    const file = path.join(dir, 'machine-id');
    if (fs.existsSync(file)) {
      const id = fs.readFileSync(file, 'utf-8').trim();
      if (/^m_[0-9a-f]{12}$/.test(id)) return id;
    }
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const id = 'm_' + crypto.randomBytes(6).toString('hex');
    fs.writeFileSync(file, id, 'utf-8');
    return id;
  } catch {
    return 'm_anonymous0';
  }
}

/**
 * Wrap a sanitized seed in a lifecycle envelope.
 * @param {Object} seed — output of seed-sanitizer.sanitizeSeed().seed
 * @param {Object} [opts] — { ttlDays?: number, origin?: string }
 * @returns {Object} envelope
 */
function createEnvelope(seed, opts = {}) {
  const type = seed.type || 'learning';
  const ttlDays = opts.ttlDays || SEED_TTL_DAYS[type] || DEFAULT_TTL_DAYS;
  const now = new Date().toISOString();
  return {
    schema: 'agentic-cortex-seed/1',
    seedId: 'seed_' + crypto.randomBytes(8).toString('hex'),
    origin: opts.origin || machinePseudonym(),
    createdAt: now,
    expiresAt: new Date(Date.now() + ttlDays * 24 * 3600 * 1000).toISOString(),
    ttlDays,
    type,
    title: seed.title,
    content: seed.content,
    confidence: seed.confidence,
    tags: ['seed', ...(seed.tags || [])],
    generation: 1, // incremented if a machine re-shares a seed it germinated
  };
}

/**
 * Evaluate a seed envelope's lifecycle state at a point in time.
 * @param {Object} envelope
 * @param {Date|string} [now]
 * @returns {{ status: 'fresh'|'aging'|'expired', daysLeft: number, expired: boolean }}
 */
function evaluateEnvelope(envelope, now) {
  const t = now ? new Date(now) : new Date();
  const exp = new Date(envelope.expiresAt || 0);
  const created = new Date(envelope.createdAt || 0);
  const totalMs = Math.max(exp - created, 1);
  const daysLeft = Math.max(0, Math.round((exp - t) / (24 * 3600 * 1000)));

  if (t >= exp) return { status: 'expired', daysLeft: 0, expired: true };
  const remaining = (exp - t) / totalMs;
  if (remaining < 1 - AGING_FRACTION) return { status: 'aging', daysLeft, expired: false };
  return { status: 'fresh', daysLeft, expired: false };
}

/**
 * Confidence a germinated seed should have locally.
 * Seeds arrive capped — they were proven on ANOTHER machine, not this one.
 * @param {Object} envelope
 * @returns {number} 0-100, capped at GERMINATED_CONFIDENCE_CAP
 */
function germinationConfidence(envelope) {
  // Only seeds carrying an explicit envelope expiry can be "expired" —
  // legacy/synced rows without one fall back to age-based trust decay only.
  if (envelope.expiresAt) {
    const { status } = evaluateEnvelope(envelope);
    if (status === 'expired') return 0;
  }
  const base = Math.min(Number(envelope.confidence) || 50, 100);
  // Trust decay: lose 1 point per 10 days since creation, min 20.
  const ageDays = (Date.now() - new Date(envelope.createdAt || Date.now()).getTime()) / (24 * 3600 * 1000);
  const decayed = Math.max(20, base - Math.floor(ageDays / 10));
  return Math.min(decayed, GERMINATED_CONFIDENCE_CAP);
}

/**
 * Apply local corroboration to a germinated seed. Called when a local agent
 * independently hits the same lesson (failure classifier match, feedback
 * 'helpful', or a duplicate save with rising confidence).
 * @param {number} currentConfidence
 * @param {number} [timesCorroborated]
 * @returns {{ confidence: number, graduated: boolean }} graduated = proven locally
 */
function corroborate(currentConfidence, timesCorroborated = 1) {
  let confidence = Math.min(100, (currentConfidence || 0) + CORROBORATION_BOOST * timesCorroborated);
  // Graduation: once local evidence pushes a seed past the native-memory
  // floor (85, same threshold as promoteToGlobal), it becomes a full local
  // memory and sheds its seed status.
  return { confidence, graduated: confidence >= 85 };
}

/**
 * Injection-time filter for a list of seed-sourced observations.
 * Expired seeds are dropped (or replaced by a tombstone warning upstream);
 * aging seeds are flagged so agents treat them as possibly stale.
 * @param {Array<{tags: string, confidence: number, created_at: string, content: string}>} rows
 * @returns {{ keep: Array, expired: Array, aging: Array }}
 */
function filterForInjection(rows) {
  const keep = [], expired = [], aging = [];
  for (const row of rows || []) {
    let tags = [];
    try { tags = JSON.parse(row.tags || '[]'); } catch { /* ignore */ }
    if (!tags.includes('seed')) { keep.push(row); continue; }

    // Seeds carry their envelope as a JSON line in the `seed_meta` content prefix
    // (written at germination); fall back to created_at-based freshness.
    const env = row._envelope || null;
    const state = env
      ? evaluateEnvelope(env)
      : (row.created_at && (Date.now() - new Date(row.created_at).getTime() < 120 * 24 * 3600 * 1000)
          ? { status: 'fresh', expired: false }
          : { status: 'expired', expired: true });

    if (state.expired) { expired.push(row); continue; }
    if (state.status === 'aging') aging.push(row);
    keep.push(row);
  }
  return { keep, expired, aging };
}

module.exports = {
  SEED_TTL_DAYS,
  DEFAULT_TTL_DAYS,
  GERMINATED_CONFIDENCE_CAP,
  CORROBORATION_BOOST,
  AGING_FRACTION,
  machinePseudonym,
  createEnvelope,
  evaluateEnvelope,
  germinationConfidence,
  corroborate,
  filterForInjection,
};
