/**
 * calibration.js — Confidence calibration + dead-memory audit (YOINK-inspired).
 *
 * Every memory carries a confidence, but confidence means nothing until it is
 * graded against outcomes. feedback() records an immutable feedback event with
 * the confidence the system held at the moment of judgment; this module turns
 * those events into two numbers nobody's memory vault wants to print:
 *
 *   the gap   — said − right. Said 75%, right 40% = 35 points overconfident.
 *               It cannot be improved by saving more memories — only by being
 *               right, or by saying a smaller number and meaning it.
 *   brier     — mean (p − outcome)². 0 perfect, 0.25 a coin, 1 certain and
 *               wrong. Chosen because the best expected score comes from
 *               saying what you actually believe.
 *
 * Also: the dead-memory audit. A memory is dead if nothing links to it, it
 * links to nothing, nobody ever retrieved it, and it never got feedback. In
 * most vaults this is invisible — which is why people believe their vault is
 * working.
 *
 * @module core/calibration
 */

'use strict';

// ─── Calibration report ──────────────────────────────────────────────────

/**
 * Grade confidence against outcomes for one graded bucket.
 * Outcome: 1 = helpful (the memory was right), 0 = incorrect.
 *
 * @param {Array<{p: number, outcome: 0|1}>} graded
 * @returns {{ graded: number, said: number, right: number, gap: number, brier: number }}
 */
function gradeBucket(graded) {
  const n = graded.length;
  if (n === 0) return { graded: 0, said: null, right: null, gap: null, brier: null };
  const said = graded.reduce((s, g) => s + g.p, 0) / n;             // 0..1
  const right = graded.reduce((s, g) => s + g.outcome, 0) / n;      // 0..1
  const brier = graded.reduce((s, g) => s + Math.pow(g.p - g.outcome, 2), 0) / n;
  return {
    graded: n,
    said: Math.round(said * 1000) / 10,        // percent, 1 decimal
    right: Math.round(right * 1000) / 10,
    gap: Math.round((said - right) * 1000) / 10,
    brier: Math.round(brier * 10000) / 10000,
  };
}

/**
 * Build the calibration report from feedback events (preferred) or, for
 * vaults graded before feedback events existed, from feedback tags.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} [opts] - { project?, machineWide? }
 * @returns {{ record: Object, byType: Object, note: string }}
 */
function calibrationReport(db, opts) {
  opts = opts || {};
  const project = opts.project || null;

  const graded = [];
  let usedEvents = false;

  if (opts.machineWide) {
    try {
      const rows = db.prepare(
        'SELECT f.feedback_type, f.confidence_at, o.type FROM feedback_events f JOIN observations o ON o.id = f.observation_id'
      ).all();
      usedEvents = rows.length > 0;
      for (const r of rows) graded.push({ p: (r.confidence_at || 0) / 100, outcome: r.feedback_type === 'helpful' ? 1 : 0, type: r.type });
    } catch { /* table missing */ }
  } else if (project) {
    let rows = [];
    try {
      rows = db.prepare(
        'SELECT f.feedback_type, f.confidence_at, o.type FROM feedback_events f JOIN observations o ON o.id = f.observation_id WHERE o.project_path = ?'
      ).all(project);
    } catch { /* table missing */ }
    usedEvents = rows.length > 0;
    for (const r of rows) graded.push({ p: (r.confidence_at || 0) / 100, outcome: r.feedback_type === 'helpful' ? 1 : 0, type: r.type });
  }

  let note = 'graded from feedback events (confidence held at the moment of judgment)';
  if (!usedEvents) {
    // Fallback: tag-based grading. Confidence is the current value — honest
    // about the weakness: confidence has moved since the judgment.
    note = 'graded from feedback tags (current confidence — save-time snapshot missing)';
    let rows = [];
    try {
      rows = project
        ? db.prepare("SELECT confidence, type, tags FROM observations WHERE project_path = ? AND is_active = 1 AND tags LIKE '%feedback%' AND (tags LIKE '%helpful%' OR tags LIKE '%incorrect%')").all(project)
        : db.prepare("SELECT confidence, type, tags FROM observations WHERE is_active = 1 AND tags LIKE '%feedback%' AND (tags LIKE '%helpful%' OR tags LIKE '%incorrect%')").all();
    } catch { /* empty */ }
    for (const r of rows) {
      let tags = [];
      try { tags = JSON.parse(r.tags || '[]'); } catch { tags = []; }
      const isHelpful = tags.includes('helpful');
      const isIncorrect = tags.includes('incorrect');
      if (isHelpful === isIncorrect) continue; // both or neither — ambiguous
      graded.push({ p: (r.confidence || 0) / 100, outcome: isHelpful ? 1 : 0, type: r.type });
    }
  }

  const record = gradeBucket(graded);

  const byType = {};
  const byTypeMap = new Map();
  for (const g of graded) {
    if (!byTypeMap.has(g.type)) byTypeMap.set(g.type, []);
    byTypeMap.get(g.type).push(g);
  }
  for (const [type, items] of byTypeMap) {
    byType[type] = gradeBucket(items);
  }

  return { record, byType, note };
}

// ─── Dead-memory audit ───────────────────────────────────────────────────

/**
 * A memory is dead if nothing links to it, it links to nothing, it was never
 * retrieved, it never got feedback, and it is older than a day. Claims that
 * have not settled stay alive regardless. Principles (layer 3) stay alive.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} [opts] - { project?, minAgeDays?: number, limit?: number }
 * @returns {{ total: number, dead: number, alive: number, deadSharePct: number, sample: Array<{id: number, type: string, title: string, ageDays: number}>, note: string }}
 */
function deadMemoryAudit(db, opts) {
  opts = opts || {};
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const minAgeDays = opts.minAgeDays != null ? opts.minAgeDays : 1;
  const limit = opts.limit || 20;

  const rows = db.prepare(
    "SELECT id, type, title, created_at, access_count, layer, tags FROM observations WHERE project_path = ? AND is_active = 1 AND (layer IS NULL OR layer < 3) AND (claim_status IS NULL OR claim_status != 'open')"
  ).all(project);

  const linkedIds = new Set();
  try {
    for (const r of db.prepare('SELECT source_id, target_id FROM memory_relations').all()) {
      linkedIds.add(r.source_id);
      linkedIds.add(r.target_id);
    }
  } catch { /* table missing */ }

  const now = Date.now();
  const dead = [];
  let total = 0;
  for (const r of rows) {
    total++;
    const ageDays = (now - new Date(r.created_at.replace(' ', 'T') + 'Z').getTime()) / 86400000;
    if (ageDays < minAgeDays) continue;
    if ((r.access_count || 0) > 0) continue;
    let tags = [];
    try { tags = JSON.parse(r.tags || '[]'); } catch { tags = []; }
    if (tags.includes('helpful') || tags.includes('incorrect')) continue;
    if (linkedIds.has(r.id)) continue;
    dead.push({ id: r.id, type: r.type, title: r.title || (r.content || '').slice(0, 60), ageDays: Math.round(ageDays) });
  }

  return {
    total,
    dead: dead.length,
    alive: total - dead.length,
    deadSharePct: total > 0 ? Math.round((dead.length / total) * 100) : 0,
    sample: dead
      .sort((a, b) => b.ageDays - a.ageDays)
      .slice(0, limit),
    note: 'dead = nothing links to it, it links to nothing, never retrieved, never graded, older than ' + minAgeDays + ' day(s)',
  };
}

module.exports = { gradeBucket, calibrationReport, deadMemoryAudit };
