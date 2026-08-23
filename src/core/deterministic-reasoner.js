/**
 * deterministic-reasoner.js — Zero-LLM inference engine for agentic-cortex.
 *
 * Ported from cortex-os-agent/src/reasoner/. Six inference modes that produce
 * *new knowledge* from existing brain observations:
 *
 *   Deduction   — transitive closure over relations + contradiction detection
 *   Induction   — generalize recurring concepts into principles
 *   Analogy     — transfer solution patterns from past to present
 *   Abduction   — rank candidate explanations by causal signals
 *   Synthesis   — combine related memories into multi-angle facts
 *   Forecast    — extrapolate numeric trends from historical data
 *
 * Every mode is a deterministic transform over the brain's knowledge graph.
 * Insights that clear a confidence floor are persisted as `synthesis` or
 * `principle` observations with `provenance: inferred`.
 *
 * @module core/deterministic-reasoner
 */

'use strict';

// ─── Deduction ────────────────────────────────────────────────────────

/**
 * Transitive closure: given a topic, find all observations connected through
 * relations (depends_on, part_of, derives_from) and detect contradictions
 * (opposing principles on the same topic).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} topic — subject to deduce about
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @param {number} [opts.limit=20]
 * @returns {{ insights: Array, evidence: Object }}
 */
function deduce(db, topic, opts = {}) {
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const limit = opts.limit || 20;
  const insights = [];
  const evidence = { relations: 0, contradictions: 0 };

  // Find observations matching topic keywords
  const terms = topic.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
  if (terms.length === 0) return { insights: [], evidence };

  const conditions = terms.map(() => `(title LIKE ? OR content LIKE ?)`).join(' AND ');
  const params = [];
  for (const t of terms) { params.push(`%${t}%`, `%${t}%`); }

  const rows = db.prepare(`
    SELECT id, title, type, confidence FROM observations
    WHERE project_path = ? AND is_active = 1 AND (${conditions})
    ORDER BY importance DESC LIMIT ?
  `).all(proj, ...params, limit);

  if (rows.length === 0) return { insights: [], evidence };

  const ids = rows.map(r => r.id);

  // Find transitive relations
  const rels = db.prepare(`
    SELECT source_id, target_id, relation_type FROM memory_relations
    WHERE source_id IN (${ids.map(() => '?').join(',')})
       OR target_id IN (${ids.map(() => '?').join(',')})
    LIMIT 100
  `).all(...ids, ...ids);

  evidence.relations = rels.length;

  // Build adjacency for transitive closure
  const adj = {};
  for (const r of rels) {
    if (!adj[r.source_id]) adj[r.source_id] = [];
    adj[r.source_id].push({ target: r.target_id, type: r.relation_type });
  }

  // Detect transitive paths
  const closure = {};
  for (const id of ids) {
    const visited = new Set();
    dfs(id, adj, visited, 3);
    if (visited.size > 1) {
      closure[id] = [...visited].filter(v => v !== id);
    }
  }

  for (const [sourceId, targets] of Object.entries(closure)) {
    if (targets.length > 0) {
      const source = rows.find(r => r.id === Number(sourceId));
      if (source) {
        insights.push({
          title: `Deduction: ${source.title} transitively connects to ${targets.length} observation(s)`,
          content: `Transitive closure from "${source.title}" reveals ${targets.length} connected concepts through relation chains.`,
          confidence: Math.min(85, 50 + targets.length * 5),
          sourceIds: [Number(sourceId), ...targets],
          relationType: 'transitive_closure',
          type: 'synthesis',
        });
      }
    }
  }

  // Contradiction detection: two observations with opposing confidence on same topic
  const byTitle = {};
  for (const r of rows) {
    const key = r.title.toLowerCase();
    if (!byTitle[key]) byTitle[key] = [];
    byTitle[key].push(r);
  }
  for (const [key, group] of Object.entries(byTitle)) {
    if (group.length >= 2) {
      const confs = group.map(g => g.confidence);
      const range = Math.max(...confs) - Math.min(...confs);
      if (range >= 40) {
        evidence.contradictions++;
        insights.push({
          title: `Contradiction: conflicting confidence on "${key}"`,
          content: `${group.length} observations about "${key}" have confidence spread of ${range} points — potential contradiction to resolve.`,
          confidence: 60 + Math.min(20, range / 2),
          sourceIds: group.map(g => g.id),
          relationType: 'contradicts',
          type: 'principle',
        });
      }
    }
  }

  return { insights, evidence };
}

function dfs(node, adj, visited, maxDepth, depth = 0) {
  if (depth > maxDepth || visited.has(node)) return;
  visited.add(node);
  const neighbors = adj[node] || [];
  for (const n of neighbors) {
    dfs(n.target, adj, visited, maxDepth, depth + 1);
  }
}

// ─── Induction ────────────────────────────────────────────────────────

/**
 * Generalize recurring concepts across many memories into a reusable principle.
 * Confidence ∝ support (number of observations sharing the pattern).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} topic
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @param {number} [opts.minSupport=3]
 * @returns {{ insights: Array, evidence: Object }}
 */
function induce(db, topic, opts = {}) {
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const minSupport = opts.minSupport || 3;
  const insights = [];
  const evidence = { patterns: 0 };

  const rows = db.prepare(`
    SELECT type, COUNT(*) as cnt, GROUP_CONCAT(title, ' || ') as samples
    FROM observations WHERE project_path = ? AND is_active = 1
      AND (title LIKE ? OR content LIKE ?)
    GROUP BY type HAVING cnt >= ?
    ORDER BY cnt DESC LIMIT 10
  `).all(proj, `%${topic}%`, `%${topic}%`, minSupport);

  evidence.patterns = rows.length;

  for (const r of rows) {
    const confidence = Math.min(90, 40 + r.cnt * 5);
    insights.push({
      title: `Induction: recurring "${r.type}" pattern (${r.cnt} occurrences)`,
      content: `${r.cnt} observations share the type "${r.type}" — a reusable principle emerges. Samples: ${r.samples.slice(0, 200)}`,
      confidence,
      sourceIds: [],
      relationType: 'generalizes',
      type: 'principle',
      tags: ['induction', r.type],
    });
  }

  return { insights, evidence };
}

// ─── Analogy ──────────────────────────────────────────────────────────

/**
 * Find past memories with a solution signal and propose transferring that
 * approach to the current topic.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} topic
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @returns {{ insights: Array, evidence: Object }}
 */
function analogize(db, topic, opts = {}) {
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const insights = [];
  const evidence = { candidates: 0 };

  // Find past observations with solution signals (tags like 'fixed', 'solved', 'solution', high confidence)
  const candidates = db.prepare(`
    SELECT id, title, content, confidence, tags FROM observations
    WHERE project_path = ? AND is_active = 1
      AND (tags LIKE '%fixed%' OR tags LIKE '%solved%' OR tags LIKE '%solution%' OR tags LIKE '%fix%'
           OR confidence >= 90)
      AND (title LIKE ? OR content LIKE ?)
    ORDER BY confidence DESC LIMIT 10
  `).all(proj, `%${topic}%`, `%${topic}%`);

  evidence.candidates = candidates.length;

  for (const c of candidates) {
    insights.push({
      title: `Analogy: "${c.title}" may transfer to this context`,
      content: `A past solution "${c.title}" (confidence ${c.confidence}) matches the current topic. Its approach may be reusable.`,
      confidence: Math.min(75, c.confidence - 10),
      sourceIds: [c.id],
      relationType: 'analogous_to',
      type: 'synthesis',
    });
  }

  return { insights, evidence };
}

// ─── Abduction ────────────────────────────────────────────────────────

/**
 * Rank candidate explanations by causal signals (because, root cause, fixed by).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} topic
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @returns {{ insights: Array, evidence: Object }}
 */
function abduce(db, topic, opts = {}) {
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const insights = [];
  const evidence = { candidates: 0 };

  const rows = db.prepare(`
    SELECT id, title, content FROM observations
    WHERE project_path = ? AND is_active = 1
      AND (content LIKE '%because%' OR content LIKE '%root cause%'
           OR content LIKE '%fixed by%' OR content LIKE '%caused by%'
           OR content LIKE '%reason:%')
      AND (title LIKE ? OR content LIKE ?)
    ORDER BY importance DESC LIMIT 10
  `).all(proj, `%${topic}%`, `%${topic}%`);

  evidence.candidates = rows.length;

  for (const r of rows) {
    // Extract causal phrases
    const matches = r.content.match(/\b(because|caused by|root cause|fixed by|reason:)\s+(.{10,120})/gi);
    const causes = (matches || []).slice(0, 3);
    if (causes.length > 0) {
      insights.push({
        title: `Abduction: possible explanations for "${topic}"`,
        content: `Causal signals found in "${r.title}": ${causes.join('; ')}`,
        confidence: 55 + causes.length * 5,
        sourceIds: [r.id],
        relationType: 'explains',
        type: 'synthesis',
      });
    }
  }

  return { insights, evidence };
}

// ─── Synthesis ────────────────────────────────────────────────────────

/**
 * Combine memories sharing a subject into a single multi-angle derived fact.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} topic
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @returns {{ insights: Array, evidence: Object }}
 */
function synthesize(db, topic, opts = {}) {
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const insights = [];
  const evidence = { sources: 0 };

  const rows = db.prepare(`
    SELECT id, title, content, type, confidence FROM observations
    WHERE project_path = ? AND is_active = 1
      AND (title LIKE ? OR content LIKE ?)
    ORDER BY importance DESC LIMIT 20
  `).all(proj, `%${topic}%`, `%${topic}%`);

  if (rows.length < 2) return { insights, evidence };

  evidence.sources = rows.length;

  // Combine into a multi-angle summary
  const angles = rows.map(r => `[${r.type}] ${r.title}: ${r.content.slice(0, 100)}`).join(' | ');
  const avgConf = Math.round(rows.reduce((s, r) => s + r.confidence, 0) / rows.length);

  insights.push({
    title: `Synthesis: ${topic} (${rows.length} sources)`,
    content: `Multi-angle synthesis from ${rows.length} observations: ${angles.slice(0, 500)}`,
    confidence: Math.min(85, avgConf),
    sourceIds: rows.map(r => r.id),
    relationType: 'synthesizes',
    type: 'synthesis',
  });

  return { insights, evidence };
}

// ─── Forecast ─────────────────────────────────────────────────────────

/**
 * Extract numeric series (years, versions) from observations and extrapolate.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} topic
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @returns {{ insights: Array, evidence: Object }}
 */
function forecast(db, topic, opts = {}) {
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const insights = [];
  const evidence = { series: 0, dataPoints: 0 };

  const rows = db.prepare(`
    SELECT id, title, content FROM observations
    WHERE project_path = ? AND is_active = 1
      AND (title LIKE ? OR content LIKE ?)
    ORDER BY created_at LIMIT 50
  `).all(proj, `%${topic}%`, `%${topic}%`);

  // Extract numeric patterns: version numbers, years, counts
  const numbers = [];
  for (const r of rows) {
    const matches = r.content.match(/\b(\d{4})\b/g); // years
    if (matches) {
      for (const m of matches) numbers.push(Number(m));
    }
    const verMatches = r.content.match(/\bv?(\d+)\.(\d+)\b/g);
    if (verMatches) {
      for (const v of verMatches) {
        const parts = v.replace(/^v/, '').split('.');
        numbers.push(Number(parts[0]));
      }
    }
  }

  if (numbers.length < 3) return { insights, evidence };

  evidence.dataPoints = numbers.length;

  // Simple linear trend
  const n = numbers.length;
  const indices = Array.from({ length: n }, (_, i) => i);
  const sumX = indices.reduce((a, b) => a + b, 0);
  const sumY = numbers.reduce((a, b) => a + b, 0);
  const sumXY = indices.reduce((s, x, i) => s + x * numbers[i], 0);
  const sumX2 = indices.reduce((s, x) => s + x * x, 0);

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const nextVal = Math.round(numbers[numbers.length - 1] + slope);
  const rSquared = computeRSquared(indices, numbers, slope, sumY / n);

  if (Math.abs(slope) > 0.1 && rSquared > 0.3) {
    evidence.series = 1;
    insights.push({
      title: `Forecast: ${topic} trend`,
      content: `Numeric trend in ${n} data points shows a slope of ${slope.toFixed(2)} (R²=${rSquared.toFixed(2)}). Next predicted value: ${nextVal}.`,
      confidence: Math.min(80, Math.round(rSquared * 100)),
      sourceIds: rows.slice(0, 10).map(r => r.id),
      relationType: 'forecasts',
      type: 'synthesis',
    });
  }

  return { insights, evidence };
}

function computeRSquared(x, y, slope, intercept) {
  const mean = y.reduce((a, b) => a + b, 0) / y.length;
  const ssRes = y.reduce((s, yi, i) => s + (yi - (slope * x[i] + intercept)) ** 2, 0);
  const ssTot = y.reduce((s, yi) => s + (yi - mean) ** 2, 0);
  return ssTot > 0 ? 1 - ssRes / ssTot : 0;
}

// ─── Orchestrator ─────────────────────────────────────────────────────

const MODES = { deduce, induce, analogize, abduce, synthesize, forecast };
const VALID_MODES = Object.keys(MODES);

/**
 * Run all six reasoning modes over a topic and return aggregated insights.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} topic
 * @param {Object} [opts]
 * @param {string|string[]} [opts.modes] — specific modes to run (default: all)
 * @param {string} [opts.project]
 * @param {number} [opts.minConfidence=50]
 * @param {number} [opts.maxInsights=10]
 * @param {boolean} [opts.persist=true] — save insights as observations
 * @returns {{ success: boolean, total: number, byMode: Object, insights: Array, savedIds: Array }}
 */
function reasonAll(db, topic, opts = {}) {
  if (!topic) throw new Error('reason() requires a topic');

  let modeList = opts.modes;
  if (typeof modeList === 'string') modeList = modeList.split(/[,\s]+/).filter(Boolean);
  if (!Array.isArray(modeList) || modeList.length === 0) modeList = VALID_MODES;
  modeList = modeList.filter(m => VALID_MODES.includes(m));

  const minConfidence = opts.minConfidence || 50;
  const maxInsights = opts.maxInsights || 10;
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const persist = opts.persist !== false;

  const allInsights = [];
  const byMode = {};

  for (const mode of modeList) {
    try {
      const result = MODES[mode](db, topic, { ...opts, project: proj });
      for (const ins of result.insights || []) {
        ins.mode = mode;
        if (ins.confidence >= minConfidence) allInsights.push(ins);
      }
      byMode[mode] = (result.insights || []).length;
    } catch (err) {
      byMode[mode] = 0;
    }
  }

  // Sort by confidence descending, cap
  allInsights.sort((a, b) => b.confidence - a.confidence);
  const capped = allInsights.slice(0, maxInsights);

  const savedIds = [];
  if (persist) {
    for (const ins of capped) {
      try {
        const result = db.prepare(`
          INSERT INTO observations (project_path, type, title, content, tags, importance, confidence, provenance)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'inferred')
        `).run(
          proj,
          ins.type || 'synthesis',
          ins.title,
          ins.content.slice(0, 4000),
          JSON.stringify(['reasoning', ins.mode, ...(ins.tags || [])]),
          ins.importance || 5,
          ins.confidence
        );
        savedIds.push(result.lastInsertRowid);
      } catch { /* best-effort */ }
    }
  }

  // Link relations from saved insights to their sources
  for (let i = 0; i < savedIds.length; i++) {
    const ins = capped[i];
    const obsId = savedIds[i];
    for (const srcId of (ins.sourceIds || []).slice(0, 5)) {
      try {
        db.prepare(`
          INSERT OR IGNORE INTO memory_relations (source_id, target_id, relation_type, confidence)
          VALUES (?, ?, ?, ?)
        `).run(obsId, srcId, ins.relationType || 'derives_from', ins.confidence);
      } catch { /* best-effort */ }
    }
  }

  return {
    success: true,
    total: allInsights.length,
    byMode,
    insights: capped,
    savedIds,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────

module.exports = {
  deduce,
  induce,
  analogize,
  abduce,
  synthesize,
  forecast,
  reasonAll,
  VALID_MODES,
  MODES,
};