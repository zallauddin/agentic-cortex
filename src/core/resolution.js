/**
 * resolution.js — Evidence-theoretic conflict resolution for agentic-cortex.
 *
 * Turns the silent "highest confidence wins" consolidation into a first-class,
 * auditable adjudication based on Dempster-Shafer evidence theory:
 *
 * 1. Each observation carries a *belief mass* built from three independent
 *    statistical signals — its stored confidence, its corroboration (how many
 *    other active observations independently agree with it), and its usage.
 *
 * 2. That statistical channel is fused with a *second independent channel*
 *    (LLM adjudication of which claim is better supported) via Dempster's rule
 *    of combination over the frame {winner, loser}. Adjudication is a
 *    two-shot debate: first the LLM builds the strongest case for EACH side
 *    (adversarial argument generation, preventing judge anchoring), then it
 *    judges with both cases on the record. The combination yields:
 *      - k: the conflict coefficient — how genuinely contested the decision was
 *      - m12(winner): the normalized combined belief in the winner
 *
 * 3. The winner's confidence boost is discounted by agreement weight (1 - k):
 *    a clean resolution (k≈0) gets the full boost; a knife-edge decision
 *    (k→1) gets almost none. This is the "honest" twist — DS normalization
 *    alone *amplifies* belief under high conflict, which is misleading, so we
 *    report the raw k alongside and damp accordingly.
 *
 * 4. Every resolution persists a resolution_record: winner, loser, both
 *    channels' masses, k, combined belief, the corroborating evidence ids,
 *    a one-sentence *deciding evidence* (LLM-generated, template fallback),
 *    and the full debate (both competing cases) for auditability.
 *    The supersedes edge carries the reason, and bootstrap injects recent
 *    resolutions as "settled debates" so agents don't re-litigate them.
 *
 * @module core/resolution
 */

'use strict';

const { cosineSimilarity } = require('./embedding');
const { callLLM } = require('./session');

// Cosine similarity threshold for "independent corroboration" — observations
// this similar to the candidate are treated as agreeing witnesses.
const CORROBORATION_SIM = 0.9;

// A resolution is WEAK when any of:
//  - conflict coefficient k >= 0.5 (the two independent evidence channels
//    strongly disagreed);
//  - combined belief within 0.05 of 0.5 (a statistical near-tie);
//  - combined belief <= 0.6 (the winner never clearly out-massed the loser —
//    e.g. a human declaring a winner with low conviction).
const HIGH_CONFLICT_K = 0.5;
const NEAR_TIE_BELIEF_DELTA = 0.05;
const LOW_WINNER_BELIEF = 0.6;

/** Saturating corroboration mass: 1 - 2^-n (0 at n=0, .5 at n=1, .75 at n=2). */
function _corroborationMass(count) {
  return 1 - Math.pow(2, -count);
}

/**
 * Compute per-observation corroboration counts for a whole project in one
 * pass (O(n²) over embedded observations — same cost profile as consolidation
 * clustering). Pure math on stored vectors; never loads the embedding model.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @returns {Map<number, number>} obs id -> corroborator count
 */
function computeCorroboration(db, project) {
  const counts = new Map();
  let rows;
  try {
    rows = db.prepare(
      'SELECT id, embedding FROM observations WHERE project_path = ? AND is_active = 1 AND embedding IS NOT NULL'
    ).all(project);
  } catch {
    return counts;
  }
  const vecs = [];
  for (const r of rows) {
    try {
      vecs.push({ id: r.id, vec: JSON.parse(r.embedding) });
      counts.set(r.id, 0);
    } catch { /* unparseable embedding — skip */ }
  }
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      try {
        if (cosineSimilarity(vecs[i].vec, vecs[j].vec) >= CORROBORATION_SIM) {
          counts.set(vecs[i].id, (counts.get(vecs[i].id) || 0) + 1);
          counts.set(vecs[j].id, (counts.get(vecs[j].id) || 0) + 1);
        }
      } catch { /* skip pair */ }
    }
  }
  return counts;
}

/**
 * Statistical belief mass for one observation, from confidence, corroboration,
 * and usage — each normalized to [0,1] and weighted:
 *   mass = 0.4·conf + 0.4·corr + 0.2·usage
 * Clamped to [0.05, 0.95] so a lone low-confidence claim keeps a floor of
 * doubt and no observation can claim total certainty from statistics alone.
 *
 * @param {Object} obs - observation row (id, confidence, access_count)
 * @param {number} corroborators - corroboration count for this obs
 * @returns {number} belief mass in [0.05, 0.95]
 */
function statisticalMass(obs, corroborators) {
  const conf = Math.max(0, Math.min(100, obs.confidence || 50)) / 100;
  const corr = _corroborationMass(corroborators || 0);
  const usage = Math.min(1, (obs.access_count || 0) / 20);
  const mass = 0.4 * conf + 0.4 * corr + 0.2 * usage;
  return Math.max(0.05, Math.min(0.95, mass));
}

/**
 * Dempster's rule of combination over the frame {A, B} with ignorance Θ.
 * Each channel is a mass function over A, B, Θ (m(A)+m(B)+m(Θ)=1).
 *
 * Returns the conflict coefficient k and the normalized combined masses.
 * When k >= 1 the channels are totally contradictory — combination is
 * undefined (the "empty set" paradox), so we return undecidable.
 *
 * @param {number} m1A - channel 1 mass for A
 * @param {number} m1B - channel 1 mass for B
 * @param {number} m2A - channel 2 mass for A
 * @param {number} m2B - channel 2 mass for B
 * @returns {{k: number, mA: number, mB: number, mTheta: number}}
 */
function dsCombine(m1A, m1B, m2A, m2B) {
  const m1Theta = 1 - m1A - m1B;
  const m2Theta = 1 - m2A - m2B;
  // Conflict mass: evidence for A meeting evidence for B, and vice versa.
  const k = m1A * m2B + m1B * m2A;
  if (k >= 1) return { k: 1, mA: 0, mB: 0, mTheta: 0, undecidable: true };
  const denom = 1 - k;
  return {
    k,
    mA: (m1A * m2A + m1A * m2Theta + m1Theta * m2A) / denom,
    mB: (m1B * m2B + m1B * m2Theta + m1Theta * m2B) / denom,
    mTheta: (m1Theta * m2Theta) / denom,
    undecidable: false,
  };
}

/**
 * Adjudicate a pair via LLM: which claim is better supported, with what
 * confidence and a one-sentence deciding evidence. Returns null when the LLM
 * is unavailable or the response doesn't parse — the caller then falls back
 * to statistical-only resolution (ignorance passes through DS unchanged).
 *
 * @param {Object} a - observation row (title, content)
 * @param {Object} b - observation row (title, content)
 * @returns {Promise<{winner: 'A'|'B', confidence: number, reason: string, arguments: {a: string, b: string}}|null>}
 */
async function llmAdjudicate(a, b) {
  const claimA = 'A: ' + (a.title || '(untitled)') + ' — ' + String(a.content || '').slice(0, 500);
  const claimB = 'B: ' + (b.title || '(untitled)') + ' — ' + String(b.content || '').slice(0, 500);

  // ── Shot 1: Debate — elicit the strongest case for EACH side independently.
  // Separating argument generation from judgment prevents anchoring: the
  // judge weighs both sides' best cases rather than its own first impression.
  let argsA = '';
  let argsB = '';
  const debate = await callLLM([
    { role: 'system', content: 'You are an adversarial debate coach. Build the strongest possible case for EACH side. Respond ONLY with valid JSON.' },
    { role: 'user', content:
      'Two claims in a knowledge store conflict. For each side, give the single strongest argument in its favor ' +
      '(2-3 sentences, focused on evidence and practical consequences).\n\n' +
      claimA + '\n\n' + claimB + '\n\n' +
      'Reply ONLY with: {"a":"strongest case for A","b":"strongest case for B"}' },
  ], { temperature: 0.4, maxTokens: 400, timeout: 30000 });
  if (!debate) return null; // LLM unavailable — caller falls back to statistical-only
  try {
    const cleaned = String(debate).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (parsed) {
      argsA = String(parsed.a || '').trim();
      argsB = String(parsed.b || '').trim();
    }
  } catch { /* unparseable debate — judge without recorded arguments */ }

  // ── Shot 2: Judgment — adjudicate with both cases on the record.
  const prompt =
    'You are the judge in a debate between two claims in a knowledge store. ' +
    'They are similar but disagree. Decide which is BETTER SUPPORTED by evidence and reasoning. ' +
    'Reply with ONLY a JSON object: {"winner":"A" or "B","confidence":0.0-1.0,"reason":"one sentence stating the deciding evidence"}\n\n' +
    claimA + '\n\nCase for A: ' + (argsA || '(none given)') + '\n\n' +
    claimB + '\n\nCase for B: ' + (argsB || '(none given)') + '\n\n';
  try {
    const res = await callLLM([
      { role: 'system', content: 'You are an evidence adjudicator. Respond ONLY with valid JSON.' },
      { role: 'user', content: prompt },
    ], { temperature: 0, maxTokens: 150, timeout: 30000 });
    if (!res) return null;
    const cleaned = String(res).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (parsed && (parsed.winner === 'A' || parsed.winner === 'B')) {
      return {
        winner: parsed.winner,
        confidence: Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0.5)),
        reason: String(parsed.reason || '').trim(),
        arguments: { a: argsA, b: argsB },
      };
    }
  } catch { /* LLM unavailable or bad JSON — caller falls back */ }
  return null;
}

/**
 * Deterministic template reason when no LLM is available — still a real
 * reason: the statistical ground truth that decided the case. When the
 * channels produce a near-tie, says so honestly instead of inventing a
 * decisive-sounding justification.
 */
function _templateReason(winner, loser, mWinner, mLoser, corrWinner, corrLoser) {
  const parts = [];
  if (winner.confidence !== loser.confidence) {
    parts.push('stored confidence ' + (winner.confidence || 50) + ' vs ' + (loser.confidence || 50));
  }
  if (corrWinner !== corrLoser) {
    parts.push((corrWinner || 0) + ' corroborating observations vs ' + (corrLoser || 0));
  }
  const belief = 'combined belief ' + mWinner.toFixed(2) + ' vs ' + mLoser.toFixed(2);
  const base = parts.length > 0 ? parts.join('; ') + '; ' : '';
  if (Math.abs(mWinner - mLoser) < 0.01) {
    return ('Statistical near-tie (' + belief + '); resolved to ' +
      (winner.title || winner.id) + ' by tie-break with no decisive evidence. ' +
      'Treat this resolution as weak — revisit if new evidence appears.').slice(0, 300);
  }
  return (base + belief + '.').slice(0, 300);
}

/**
 * Resolve a conflict between two observations using DS evidence fusion.
 * If opts.explicit (winnerId/loserId given by a human or agent), skips the
 * LLM adjudication and records the supplied reason directly.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} opts
 * @param {string} opts.project - Project path
 * @param {Object} opts.a - observation row A (id, title, content, confidence, access_count, embedding)
 * @param {Object} opts.b - observation row B
 * @param {Map<number, number>} [opts.corroboration] - precomputed corroboration counts
 * @param {Object} [opts.explicit] - { winnerId, loserId, reason } for human/agent-guided resolution
 * @param {string} [opts.resolutionType='consolidation']
 * @returns {Promise<Object>} the resolution record + masses
 */
async function resolveConflict(db, opts) {
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const corr = opts.corroboration || computeCorroboration(db, project);
  const type = opts.resolutionType || 'consolidation';

  const explicit = opts.explicit;
  if (explicit) {
    const winner = explicit.winnerId === opts.a.id ? opts.a : opts.b;
    const loser = explicit.winnerId === opts.a.id ? opts.b : opts.a;
    const mWinner = statisticalMass(winner, corr.get(winner.id) || 0);
    const mLoser = statisticalMass(loser, corr.get(loser.id) || 0);
    // Single channel: LLM mass is the human's stated conviction (default 0.9).
    const llmMass = explicit.confidence != null ? Math.max(0, Math.min(1, explicit.confidence)) : 0.9;
    const combined = dsCombine(mWinner, mLoser, llmMass, 1 - llmMass);
    return _persistResolution(db, {
      project,
      winnerId: winner.id,
      loserId: loser.id,
      resolutionType: type === 'consolidation' ? 'explicit' : type,
      k: combined.k,
      combinedBelief: combined.undecidable ? 0 : combined.mA,
      statMass: mWinner,
      llmMass,
      evidenceIds: corr.get(winner.id) > 0 ? _findEvidenceIds(db, winner.id, project, corr) : [],
      reason: (explicit.reason || '').trim() || _templateReason(winner, loser, mWinner, mLoser, corr.get(winner.id) || 0, corr.get(loser.id) || 0),
    });
  }

  // ── Auto-adjudication: two independent channels ──
  const m1a = statisticalMass(opts.a, corr.get(opts.a.id) || 0);
  const m1b = statisticalMass(opts.b, corr.get(opts.b.id) || 0);

  // Channel 2: LLM adjudication (m2a, m2b; rest is ignorance). Two-shot
  // debate: generate competing cases first, then judge with them on record.
  let m2a = 0;
  let m2b = 0;
  let llmReason = '';
  let debateArgs = null;
  const verdict = await llmAdjudicate(opts.a, opts.b);
  if (verdict) {
    if (verdict.winner === 'A') { m2a = verdict.confidence; m2b = Math.max(0, 1 - verdict.confidence - 0.1); }
    else { m2b = verdict.confidence; m2a = Math.max(0, 1 - verdict.confidence - 0.1); }
    llmReason = verdict.reason;
    debateArgs = verdict.arguments || null;
  }
  // When the LLM is unavailable, m2a=m2b=0 (full ignorance) — DS passes the
  // statistical channel through unchanged. Still a legitimate resolution.

  const combined = dsCombine(m1a, m1b, m2a, m2b);
  if (combined.undecidable) {
    // Total contradiction between channels — refuse to pick a winner rather
    // than resolve dishonestly.
    return {
      status: 'undecidable',
      conflictCoefficient: 1,
      reason: 'Evidence channels are totally contradictory (k=1) — no winner declared.',
      a: opts.a.id,
      b: opts.b.id,
    };
  }

  const aWins = combined.mA >= combined.mB;
  const winner = aWins ? opts.a : opts.b;
  const loser = aWins ? opts.b : opts.a;
  const winnerMass = aWins ? combined.mA : combined.mB;
  const loserMass = aWins ? combined.mB : combined.mA;
  const statWinner = aWins ? m1a : m1b;
  const llmWinner = aWins ? m2a : m2b;

  const reason = (llmReason || _templateReason(
    winner, loser, winnerMass, loserMass,
    corr.get(winner.id) || 0, corr.get(loser.id) || 0
  )).slice(0, 400);

  return _persistResolution(db, {
    project,
    winnerId: winner.id,
    loserId: loser.id,
    resolutionType: type,
    k: combined.k,
    combinedBelief: winnerMass,
    statMass: statWinner,
    llmMass: llmWinner,
    evidenceIds: (corr.get(winner.id) || 0) > 0 ? _findEvidenceIds(db, winner.id, project, corr) : [],
    reason,
    debate: debateArgs,
  });
}

/**
 * Find the actual observation ids corroborating the winner (for auditability).
 */
function _findEvidenceIds(db, winnerId, project, corr) {
  const ids = [];
  try {
    const row = db.prepare('SELECT embedding FROM observations WHERE id = ?').get(winnerId);
    if (!row || !row.embedding) return ids;
    const vec = JSON.parse(row.embedding);
    const rows = db.prepare(
      'SELECT id, embedding FROM observations WHERE project_path = ? AND is_active = 1 AND id != ? AND embedding IS NOT NULL'
    ).all(project, winnerId);
    for (const r of rows) {
      try {
        if (cosineSimilarity(vec, JSON.parse(r.embedding)) >= CORROBORATION_SIM) ids.push(r.id);
      } catch { /* skip */ }
    }
  } catch { /* best-effort */ }
  return ids;
}

/**
 * Persist a resolution: insert the resolution_record, attach the supersedes
 * edge with the reason, and boost the winner's confidence by the
 * agreement-weighted boost (10·(1-k)) — contested decisions get little boost.
 */
function _persistResolution(db, data) {
  const agreement = Math.max(0, 1 - data.k);
  const boost = Math.round(10 * agreement);

  const tx = db.transaction(() => {
    // Soft-archive the loser (keep history in observation_versions).
    db.prepare('UPDATE observations SET is_active = 0 WHERE id = ?').run(data.loserId);

    // Supersedes edge WITH the reason — the auditable pointer.
    db.prepare(
      `INSERT INTO memory_relations (source_id, target_id, relation_type, confidence, reason) VALUES (?, ?, 'supersedes', ?, ?)
       ON CONFLICT(source_id, target_id, relation_type) DO UPDATE SET confidence = excluded.confidence, reason = excluded.reason`
    ).run(data.winnerId, data.loserId, Math.round(data.combinedBelief * 100), data.reason);

    // Winner confidence: never decrease; apply agreement-weighted boost.
    db.prepare(
      'UPDATE observations SET confidence = MIN(100, MAX(confidence, ? + confidence)) WHERE id = ?'
    ).run(boost, data.winnerId);

    // Resolution record (debate = the two-shot deliberation, when available).
    const relation = db.prepare(
      "SELECT id FROM memory_relations WHERE source_id = ? AND target_id = ? AND relation_type = 'supersedes'"
    ).get(data.winnerId, data.loserId);
    db.prepare(
      `INSERT INTO resolution_records
        (project_path, winner_id, loser_id, relation_id, resolution_type, conflict_coefficient,
         combined_belief, statistical_mass, llm_mass, agreement_weight, evidence_ids, reason, debate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      data.project, data.winnerId, data.loserId, relation ? relation.id : null,
      data.resolutionType, data.k, data.combinedBelief, data.statMass, data.llmMass,
      agreement, JSON.stringify(data.evidenceIds), data.reason,
      data.debate ? JSON.stringify(data.debate) : null
    );
  });
  tx();

  return {
    status: 'resolved',
    winnerId: data.winnerId,
    loserId: data.loserId,
    resolutionType: data.resolutionType,
    conflictCoefficient: Math.round(data.k * 1000) / 1000,
    combinedBelief: Math.round(data.combinedBelief * 1000) / 1000,
    agreementWeight: Math.round((1 - data.k) * 1000) / 1000,
    confidenceBoost: boost,
    reason: data.reason,
    evidenceIds: data.evidenceIds,
    debate: data.debate,
  };
}

/**
 * Fetch recent resolution records for a project (joined with titles).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @param {number} [limit=5]
 * @returns {Array<Object>}
 */
function getRecentResolutions(db, project, limit = 5) {
  try {
    return db.prepare(
      `SELECT r.id, r.winner_id, r.loser_id, r.resolution_type, r.conflict_coefficient,
              r.combined_belief, r.agreement_weight, r.reason, r.debate, r.created_at,
              w.title AS winner_title, l.title AS loser_title
       FROM resolution_records r
       JOIN observations w ON w.id = r.winner_id
       JOIN observations l ON l.id = r.loser_id
       WHERE r.project_path = ?
       ORDER BY r.created_at DESC LIMIT ?`
    ).all(project, limit);
  } catch {
    return [];
  }
}

/**
 * Count resolutions for stats/analytics.
 */
function resolutionStats(db, project) {
  try {
    const total = db.prepare(
      'SELECT COUNT(*) as c FROM resolution_records WHERE project_path = ?'
    ).get(project).c;
    const byType = db.prepare(
      'SELECT resolution_type, COUNT(*) as c FROM resolution_records WHERE project_path = ? GROUP BY resolution_type'
    ).all(project);
    const avgConflict = db.prepare(
      'SELECT AVG(conflict_coefficient) as k, AVG(agreement_weight) as w FROM resolution_records WHERE project_path = ?'
    ).get(project);
    return { total, byType, avgConflictCoefficient: Math.round((avgConflict.k || 0) * 1000) / 1000, avgAgreement: Math.round((avgConflict.w || 0) * 1000) / 1000 };
  } catch {
    return { total: 0, byType: [], avgConflictCoefficient: 0, avgAgreement: 0 };
  }
}

/**
 * Classify the strength of a resolution record.
 *
 * A resolution is WEAK when the evidence was genuinely contested:
 *  - high conflict coefficient (k >= HIGH_CONFLICT_K): the two channels
 *    (statistical vs LLM) strongly disagreed, so the "winner" was a coin-flip
 *    between independent sources;
 *  - near-tie combined belief (within NEAR_TIE_BELIEF of 0.5): even after
 *    fusion, the winner barely out-massed the loser.
 *
 * Weak resolutions are marked so agents treat the topic as unsettled territory
 * rather than settled precedent.
 *
 * @param {Object} r - resolution record row (conflict_coefficient, combined_belief)
 * @returns {{weak: boolean, highConflict: boolean, nearTie: boolean, reasons: string[]}}
 */
function classifyResolution(r) {
  const k = Number(r.conflict_coefficient) || 0;
  const belief = Number(r.combined_belief) || 0;
  const highConflict = k >= HIGH_CONFLICT_K;
  const nearTie = Math.abs(belief - 0.5) <= NEAR_TIE_BELIEF_DELTA;
  const lowBelief = belief <= LOW_WINNER_BELIEF;
  const reasons = [];
  if (highConflict) {
    reasons.push('conflict coefficient ' + k.toFixed(2) + ' — the two evidence channels strongly disagreed');
  }
  if (nearTie) {
    reasons.push('combined belief ' + belief.toFixed(2) + ' — a statistical near-tie');
  } else if (lowBelief && !highConflict) {
    reasons.push('combined belief ' + belief.toFixed(2) + ' — the winner never clearly out-massed the loser');
  }
  return { weak: reasons.length > 0, highConflict, nearTie, lowBelief, reasons };
}

module.exports = {
  dsCombine,
  statisticalMass,
  computeCorroboration,
  resolveConflict,
  getRecentResolutions,
  resolutionStats,
  classifyResolution,
  HIGH_CONFLICT_K: 0.5,
  NEAR_TIE_BELIEF_DELTA: 0.05,
  CORROBORATION_SIM,
};
