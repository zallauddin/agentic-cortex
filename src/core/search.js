/**
 * search.js — Search engine for agentic-cortex.
 *
 * Provides keyword (FTS5), semantic (vector), and hybrid search over
 * observations. The hybrid mode combines FTS5 ranking with cosine
 * similarity scoring (0.4 FTS + 0.6 semantic).
 *
 * @module core/search
 */

'use strict';

const { cosineSimilarity, rerank: rerankPipeline } = require('./embedding');

/**
 * Sanitize a date string to YYYY-MM-DD format.
 * Strips time portion if present.
 *
 * @param {string} dateStr - Date string to sanitize
 * @returns {string} Date in YYYY-MM-DD format
 */
function sanitizeDate(dateStr) {
  const match = dateStr.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : dateStr.trim();
}

/**
 * Build a SQL WHERE clause and parameter array from search options.
 *
 * @param {Object} opts - Filter options
 * @param {string} [opts.project] - Filter by project path
 * @param {string} [opts.type] - Filter by observation type
 * @param {number} [opts.minConfidence] - Minimum confidence threshold
 * @param {string} [opts.changedSince] - Only observations created after this date
 * @param {string} [opts.asOf] - Only observations created before this date
 * @returns {{ whereClause: string, params: Array }} SQL WHERE clause and bind parameters
 */
function buildWhereClause(opts) {
  const conditions = ['o.is_active = 1'];
  const params = [];

  // Temporal forgetting (Phase 15): expired memories (past expires_at) and
  // explicitly superseded memories are excluded from every retrieval path.
  // `includeExpired` opts back in (audit/analysis use). is_active=0 already
  // covers expired memories swept by expireDueMemories; the SQL-time check
  // catches anything not yet swept between maintenance runs.
  if (!opts.includeExpired) {
    conditions.push("(o.expires_at IS NULL OR o.expires_at > ?)");
    params.push(new Date().toISOString());
  }
  if (!opts.includeSuperseded) {
    conditions.push('o.superseded_by IS NULL');
  }

  if (opts.project) {
    conditions.push('o.project_path = ?');
    params.push(opts.project);
  }
  if (opts.type) {
    conditions.push('o.type = ?');
    params.push(opts.type);
  }
  if (opts.minConfidence > 0) {
    conditions.push('o.confidence >= ?');
    params.push(opts.minConfidence);
  }
  if (opts.changedSince) {
    conditions.push('o.created_at >= ?');
    params.push(sanitizeDate(opts.changedSince) + ' 00:00:00');
  }
  if (opts.asOf) {
    conditions.push('o.created_at <= ?');
    params.push(sanitizeDate(opts.asOf) + ' 23:59:59');
  }
  if (opts.agentId) {
    conditions.push('o.agent_id = ?');
    params.push(opts.agentId);
  }

  return { whereClause: conditions.join(' AND '), params };
}

/** @type {string} Column selection for result rows */
const RESULT_COLUMNS = 'o.id, o.agent_id, o.project_path, o.type, o.title, substr(o.content, 1, 300) as preview, o.tags, o.importance, o.confidence, o.provenance, o.steps, o.triggers, o.preconditions, o.postconditions, o.created_at';

/**
 * Perform a keyword search using FTS5 full-text search.
 * Returns results ordered by FTS rank.
 *
 * @param {import('better-sqlite3').Database} db - Database instance
 * @param {Object} opts - Search options
 * @param {string} [opts.query=''] - Search query text
 * @param {string} [opts.project] - Filter by project path
 * @param {string} [opts.type] - Filter by observation type
 * @param {number} [opts.minConfidence=0] - Minimum confidence threshold
 * @param {string} [opts.changedSince] - Only observations created after this date
 * @param {string} [opts.asOf] - Only observations created before this date
 * @param {number} [opts.limit=10] - Maximum number of results
 * @returns {Array<Object>} Search results with rank
 */
function keywordSearch(db, opts) {
  const { whereClause, params } = buildWhereClause(opts);
  const limit = (opts.limit || 10) * 2;
  const safe = (opts.query || '').replace(/["']/g, '').trim();

  if (!safe) {
    // No query text — just apply filters (e.g., --changed-since alone)
    try {
      return db.prepare(
        'SELECT ' + RESULT_COLUMNS + ' FROM observations o WHERE ' + whereClause + ' ORDER BY o.created_at DESC LIMIT ?'
      ).all(...params, limit);
    } catch (err) {
      console.error('Filter search error:', err.message);
      return [];
    }
  }

  const ftsQuery = safe.split(' ').map(w => '"' + w + '"').join(' OR ');
  const sql =
    'SELECT ' + RESULT_COLUMNS + ', o.embedding IS NOT NULL as has_embedding, rank ' +
    'FROM observations_fts fts JOIN observations o ON o.id = fts.rowid ' +
    'WHERE observations_fts MATCH ? AND ' + whereClause + ' ORDER BY rank LIMIT ?';

  try {
    return db.prepare(sql).all(ftsQuery, ...params, limit);
  } catch (err) {
    console.error('FTS5 search error:', err.message);
    return [];
  }
}

/**
 * Perform a semantic (vector similarity) search over embedded observations.
 * Returns results ordered by cosine similarity score.
 *
 * @param {import('better-sqlite3').Database} db - Database instance
 * @param {number[]} queryVec - Query embedding vector
 * @param {Object} opts - Search options
 * @param {string} [opts.project] - Filter by project path
 * @param {number} [opts.limit=10] - Maximum number of results
 * @returns {Array<Object>} Search results with semantic_score
 */
function semanticSearch(db, queryVec, opts) {
  const limit = opts.limit || 10;
  const { whereClause, params: whereParams } = buildWhereClause(opts);

  let candidateSql = 'SELECT id FROM observations o WHERE ' + whereClause + ' AND embedding IS NOT NULL';
  const candidateParams = [...whereParams];
  candidateSql += ' ORDER BY created_at DESC';

  const candidateIds = db.prepare(candidateSql).all(...candidateParams).map(r => r.id);

  if (candidateIds.length === 0) return [];

  const scores = [];
  const placeholders = candidateIds.map(() => '?').join(',');
  const rows = db.prepare(
    'SELECT id, agent_id, project_path, type, title, substr(content, 1, 300) as preview, ' +
    'tags, importance, confidence, provenance, steps, triggers, preconditions, postconditions, created_at, embedding ' +
    'FROM observations WHERE id IN (' + placeholders + ')'
  ).all(...candidateIds);

  for (const row of rows) {
    try {
      const vec = JSON.parse(row.embedding);
      const sim = cosineSimilarity(queryVec, vec);
      scores.push({
        id: row.id,
        agent_id: row.agent_id,
        project_path: row.project_path,
        type: row.type,
        title: row.title,
        preview: row.preview,
        tags: row.tags,
        importance: row.importance,
        confidence: row.confidence,
        provenance: row.provenance,
        steps: row.steps ? JSON.parse(row.steps) : undefined,
        triggers: row.triggers ? JSON.parse(row.triggers) : undefined,
        preconditions: row.preconditions ? JSON.parse(row.preconditions) : undefined,
        postconditions: row.postconditions ? JSON.parse(row.postconditions) : undefined,
        created_at: row.created_at,
        semantic_score: Math.round(sim * 1000) / 1000,
      });
    } catch {
      // Skip rows with unparseable embeddings
    }
  }

  scores.sort((a, b) => b.semantic_score - a.semantic_score);
  return scores.slice(0, limit);
}

/**
 * Perform a hybrid search combining FTS5 keyword ranking with semantic
 * vector similarity. FTS results seed the candidate pool, which is then
 * expanded with additional recent embeddings. Each candidate is scored
 * using a weighted combination: 0.4 * fts_rank + 0.6 * semantic_score.
 *
 * @param {import('better-sqlite3').Database} db - Database instance
 * @param {string} query - Search query text
 * @param {number[]} queryVec - Query embedding vector
 * @param {Object} opts - Search options
 * @param {string} [opts.project] - Filter by project path
 * @param {string} [opts.type] - Filter by observation type
 * @param {number} [opts.minConfidence=0] - Minimum confidence threshold
 * @param {string} [opts.changedSince] - Only observations created after this date
 * @param {string} [opts.asOf] - Only observations created before this date
 * @param {number} [opts.limit=10] - Maximum number of results
 * @returns {Array<Object>} Search results with semantic_score, fts_rank, and combined_score
 */
function hybridSearch(db, query, queryVec, opts) {
  const limit = opts.limit || 10;

  // Phase 1: FTS5 keyword search
  const ftsResults = keywordSearch(db, { ...opts, query, limit });

  // Phase 2: Build candidate pool from FTS results + additional recent embeddings
  let candidateIds;
  if (ftsResults.length > 0) {
    const ftsIds = ftsResults.map(r => r.id);
    const moreLimit = Math.max(limit * 3, 50);
    let moreSql = 'SELECT id FROM observations WHERE is_active = 1 AND embedding IS NOT NULL AND id NOT IN (' +
      ftsIds.map(() => '?').join(',') + ')';
    const moreParams = [...ftsIds];
    if (opts.project) { moreSql += ' AND project_path = ?'; moreParams.push(opts.project); }
    if (opts.agentId) { moreSql += ' AND agent_id = ?'; moreParams.push(opts.agentId); }
    moreSql += ' ORDER BY created_at DESC LIMIT ?';
    moreParams.push(moreLimit);
    const moreIds = db.prepare(moreSql).all(...moreParams).map(r => r.id);
    candidateIds = [...ftsIds, ...moreIds];
  } else {
    let fallbackSql = 'SELECT id FROM observations WHERE is_active = 1 AND embedding IS NOT NULL';
    const fallbackParams = [];
    if (opts.project) { fallbackSql += ' AND project_path = ?'; fallbackParams.push(opts.project); }
    if (opts.agentId) { fallbackSql += ' AND agent_id = ?'; fallbackParams.push(opts.agentId); }
    fallbackSql += ' ORDER BY created_at DESC';
    candidateIds = db.prepare(fallbackSql).all(...fallbackParams).map(r => r.id);
  }

  if (candidateIds.length === 0) return [];

  // Phase 3: Score each candidate. Keyword-only mode (queryVec = null) is the
  // DEFAULT (memory-safe: no embedding model), so FTS hits must survive —
  // they get a neutral semantic_score of 0 and rank by FTS rank alone.
  // Previously cosineSimilarity(null, vec) threw per-row and silently
  // discarded every result, breaking all memory-grounded reasoning paths.
  const scores = [];
  const placeholders = candidateIds.map(() => '?').join(',');
  const rows = db.prepare(
    'SELECT id, agent_id, project_path, type, title, substr(content, 1, 300) as preview, ' +
    'tags, importance, confidence, provenance, steps, triggers, preconditions, postconditions, created_at, embedding ' +
    'FROM observations WHERE id IN (' + placeholders + ')'
  ).all(...candidateIds);

  for (const row of rows) {
    try {
      const vec = JSON.parse(row.embedding);
      const sim = queryVec ? cosineSimilarity(queryVec, vec) : 0;
      scores.push({ ...row, semantic_score: sim });
    } catch {
      // Skip rows with unparseable embeddings (still reachable via ftsMap below)
      if (queryVec) continue;
      scores.push({ ...row, semantic_score: 0 });
    }
  }

  // Phase 4: Merge FTS rank with semantic score
  const ftsMap = new Map(ftsResults.map(r => [r.id, r]));
  const merged = scores.map(s => {
    const fts = ftsMap.get(s.id);
    const ftsRank = fts ? Math.abs(fts.rank) : 0;
    const combined = fts
      ? (0.4 * (1 / (1 + ftsRank)) + 0.6 * s.semantic_score)
      : s.semantic_score;

    return {
      id: s.id,
      agent_id: s.agent_id,
      project_path: s.project_path,
      type: s.type,
      title: s.title,
      preview: s.preview,
      tags: s.tags,
      importance: s.importance,
      confidence: s.confidence,
      provenance: s.provenance,
      created_at: s.created_at,
      semantic_score: Math.round(s.semantic_score * 1000) / 1000,
      fts_rank: fts ? fts.rank : null,
      combined_score: Math.round(combined * 1000) / 1000,
    };
  });

  merged.sort((a, b) => b.combined_score - a.combined_score);
  return merged.slice(0, limit);
}

/**
 * Rerank a list of search results using a cross-encoder model.
 * Preserves the input shape (id, project_path, type, preview, etc.) but
 * replaces combined_score ordering with rerank_score ordering. The original
 * pre-rerank position is preserved as `original_rank` for debugging.
 *
 * If the cross-encoder pipeline is unavailable (e.g., transformers not
 * installed), returns the input array unchanged with a `rerank_score` of
 * null so callers can still rely on the same shape.
 *
 * @param {string} query - The original search query
 * @param {Array<Object>} results - Hybrid/semantic/keyword search results
 * @returns {Promise<Array<Object>>} Reranked results with rerank_score
 */
async function rerankResults(query, results) {
  if (!results || results.length === 0) return [];
  try {
    const ranked = await rerankPipeline(query, results);
    const byId = new Map(ranked.map(r => [r.id, r]));
    // Re-order results by rerank rank, attaching the rerank score.
    const reranked = ranked.map(({ id, score, rank }) => {
      const original = results.find(r => r.id === id);
      if (!original) return null;
      return {
        ...original,
        original_rank: original.combined_score != null
          ? null // resolved below
          : null,
        rerank_score: Math.round(score * 1000) / 1000,
      };
    }).filter(Boolean);

    // Fill in original_rank (1-based pre-rerank position) for traceability.
    const originalIndex = new Map(results.map((r, i) => [r.id, i + 1]));
    for (const r of reranked) {
      r.original_rank = originalIndex.get(r.id) ?? null;
    }

    return reranked;
  } catch (err) {
    console.error('[search] rerank failed:', err && err.message ? err.message : err);
    // Soft-fail: keep the original ordering, mark scores null.
    return results.map(r => ({ ...r, rerank_score: null, original_rank: null }));
  }
}

/**
 * Outcome-weighted selection: adjust search result scores by each memory's
 * recorded eval-outcome history (eval_memory_injections JOIN
 * evaluation_log). Memories injected into successful evals are boosted;
 * ones injected into failures are demoted — the eval-log feedback loop
 * closed at retrieval time.
 *
 * The adjustment applies to whatever numeric score a result carries
 * (rerank_score, else combined_score), clamped to [0, 1]. Keyword-only
 * results (no numeric score) keep the weight attached as a secondary sort
 * key. Every result gains `outcome_weight` ([-1, 1], 0 below the min-runs
 * threshold) and `outcome_runs` so callers can see the signal.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<Object>} results — hybrid/keyword/reranked search results
 * @param {Object} [opts] — { project?, delta? (default 0.1), minRuns? }
 * @returns {Array<Object>} re-sorted results with outcome fields attached
 */
function applyOutcomeWeights(db, results, opts = {}) {
  if (!db || !results || results.length === 0) return results || [];
  const delta = opts.delta || 0.1;
  let stats = null;
  try {
    const { memoryOutcomeStats } = require('./self-improve');
    stats = memoryOutcomeStats(db, opts.project, { minRuns: opts.minRuns });
  } catch { stats = null; }

  if (!stats || stats.size === 0) {
    return results.map(r => ({ ...r, outcome_weight: 0, outcome_runs: 0 }));
  }

  const adjusted = results.map(r => {
    const st = stats.get(r.id);
    const weight = st ? st.weight : 0;
    const out = {
      ...r,
      outcome_weight: Math.round(weight * 1000) / 1000,
      outcome_runs: st ? st.runs : 0,
    };
    if (weight === 0) return out;
    if (typeof r.rerank_score === 'number') {
      out.rerank_score = Math.round(Math.max(0, Math.min(1, r.rerank_score + weight * delta)) * 1000) / 1000;
    } else if (typeof r.combined_score === 'number') {
      out.combined_score = Math.round(Math.max(0, Math.min(1, r.combined_score + weight * delta)) * 1000) / 1000;
    }
    return out;
  });

  // Re-sort: numeric score desc; keyword-only results by outcome weight.
  adjusted.sort((a, b) => {
    const sa = typeof a.rerank_score === 'number' ? a.rerank_score : (typeof a.combined_score === 'number' ? a.combined_score : null);
    const sb = typeof b.rerank_score === 'number' ? b.rerank_score : (typeof b.combined_score === 'number' ? b.combined_score : null);
    if (sa != null && sb != null) return sb - sa;
    if (sa != null) return -1;
    if (sb != null) return 1;
    return (b.outcome_weight || 0) - (a.outcome_weight || 0);
  });
  return adjusted;
}


/**
 * Attach each result's eval-outcome record as inline provenance fields
 * (`outcome_weight`, `outcome_runs`) WITHOUT reordering. Unlike
 * applyOutcomeWeights — which re-sorts by the adjusted score — this is for
 * surfaces that should keep their existing ordering (e.g. cross-project
 * search, where adjusting one project's scores against another's is
 * misleading) but still want agents to see a memory's proven-ness at
 * retrieval time.
 *
 * When `project` is given, the correlation stats are scoped to that
 * project; otherwise stats span ALL projects keyed by observation id.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<Object>} results
 * @param {Object} [opts] — { project?, minRuns? }
 * @returns {Array<Object>} results with outcome_weight/outcome_runs attached
 */
/**
 * Temporal-query detection (Phase 15): deterministic regex, no LLM. Matches
 * questions that ask about time or the CURRENT state of the world — the two
 * cases where recency/supersession metadata should influence ranking.
 * Word-bounded to avoid substring false positives (e.g. "whenever").
 *
 * @param {string} query
 * @returns {boolean}
 */
const TEMPORAL_QUERY_RE = /\b(when|what day|what time|what year|how long|how recent|since when|until when|as of|latest|newest|current|currently|now|today|tomorrow|yesterday|this week|last week|this month|last month|this year|last year|these days|recently|deadline|schedule|scheduled|expire|expires|expired|moved|changed|switched|updated|upgrade|upgraded|migrate|migrated)\b/i;

function isTemporalQuery(query) {
  return TEMPORAL_QUERY_RE.test(String(query || ''));
}

/**
 * Parse a SQLite datetime ('YYYY-MM-DD HH:MM:SS', UTC) or ISO string to ms.
 * Returns NaN when unparseable.
 *
 * @param {string} s
 * @returns {number}
 */
function _parseSQLiteDate(s) {
  if (!s) return NaN;
  const str = String(s);
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(str)) return Date.parse(str);
  return Date.parse(str.replace(' ', 'T') + 'Z');
}

/**
 * Temporal ranking boost (Phase 15): when the QUERY asks about time or the
 * current state of the world, use the temporal-lifecycle metadata created by
 * the forgetting/supersession subsystem to lift the *latest truth* above
 * stale-but-matching distractors:
 *
 *   - CHAMPION: the memory is the living winner of a supersession chain
 *     (another row's superseded_by points at it) — it IS the current fact.
 *   - TIME-BOUND: the memory carries a future expires_at — a bounded-time
 *     fact that is still valid, exactly what temporal questions probe for.
 *   - RECENCY: 1/(1 + ageDays) from created_at — newer evidence ranks a
 *     little higher for "where does X live now" style questions.
 *
 * Deterministic (no LLM), metadata-only, and self-limiting: the boost adds
 * at most `delta` (default 0.15) of the [0,1] relevance score, so it nudges
 * ordering among already-relevant candidates — it never rescues an
 * irrelevant memory past a relevant one. Non-temporal queries are returned
 * unchanged (only annotated with temporal_boost: 0).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} query
 * @param {Array<Object>} results — search results (id + numeric score or FTS rank)
 * @param {Object} [opts] — { delta? (default 0.15), enabled? (default true) }
 * @returns {Array<Object>} results with temporal_boost attached, re-sorted when active
 */
function applyTemporalBoost(db, query, results, opts = {}) {
  if (!Array.isArray(results) || results.length === 0) return results || [];
  if (opts.enabled === false || !isTemporalQuery(query)) {
    return results.map(r => ({ ...r, temporal_boost: 0 }));
  }
  const delta = opts.delta == null ? 0.15 : Math.max(0, Math.min(0.5, opts.delta));
  const now = Date.now();

  // Pull temporal metadata for exactly the candidate ids (single query each
  // for facts and champion pointers — no N+1).
  const meta = new Map();
  const ids = results.map(r => r.id).filter(id => id != null);
  if (db && ids.length > 0) {
    const ph = ids.map(() => '?').join(',');
    try {
      for (const row of db.prepare(`SELECT id, expires_at, created_at FROM observations WHERE id IN (${ph})`).all(...ids)) {
        meta.set(row.id, row);
      }
    } catch { /* metadata unavailable — recency from result rows only */ }
    try {
      const champs = new Set(
        db.prepare(`SELECT DISTINCT superseded_by FROM observations WHERE is_active = 0 AND superseded_by IN (${ph})`).all(...ids).map(r => r.superseded_by)
      );
      for (const [id, m] of meta) m.isChampion = champs.has(id);
    } catch { /* champion signal unavailable */ }
  }

  const clamp01 = v => Math.max(0, Math.min(1, v));
  const boosted = results.map(r => {
    const m = meta.get(r.id) || {};

    // RECENCY — 1 today → 0.5 after a day → 0.17 after a month.
    let recency = 0;
    const createdMs = _parseSQLiteDate(m.created_at);
    if (!Number.isNaN(createdMs)) {
      const ageDays = Math.max(0, (now - createdMs) / 86400000);
      recency = 1 / (1 + ageDays);
    }

    const boost = clamp01(
      0.6 * recency +
      (m.isChampion ? 0.25 : 0) +
      (m.expires_at && Date.parse(m.expires_at) > now ? 0.15 : 0)
    );

    const out = { ...r, temporal_boost: Math.round(boost * 1000) / 1000 };
    if (boost > 0) {
      if (typeof r.rerank_score === 'number') {
        out.rerank_score = Math.round(clamp01(r.rerank_score + boost * delta) * 1000) / 1000;
      } else if (typeof r.combined_score === 'number') {
        out.combined_score = Math.round(clamp01(r.combined_score + boost * delta) * 1000) / 1000;
      }
    }
    // Keyword-only path: results carry a raw FTS5 rank (NEGATIVE; more
    // negative = better bm25 match). Convert to a positive "bigger is
    // better" score for every row — including boost 0 — so the re-sort
    // preserves the baseline FTS ordering and the boost only nudges it.
    // RANK_SCALE bounds the nudge to <1 rank position (delta ≤ 0.5).
    if (typeof r.rank === 'number') {
      const RANK_SCALE = 5;
      out.temporal_rank_score = Math.abs(r.rank) + boost * delta * RANK_SCALE;
    }
    return out;
  });

  // Re-sort only when the boost can change ordering. Hybrid/reranked results
  // sort by their adjusted numeric score; keyword-only results by the
  // converted temporal_rank_score (falls back to existing order).
  const hasNumeric = boosted.some(r => typeof r.rerank_score === 'number' || typeof r.combined_score === 'number');
  const hasRankScore = boosted.some(r => typeof r.temporal_rank_score === 'number');
  if (hasNumeric) {
    boosted.sort((a, b) => {
      const sa = typeof a.rerank_score === 'number' ? a.rerank_score : (typeof a.combined_score === 'number' ? a.combined_score : null);
      const sb = typeof b.rerank_score === 'number' ? b.rerank_score : (typeof b.combined_score === 'number' ? b.combined_score : null);
      if (sa != null && sb != null) return sb - sa;
      if (sa != null) return -1;
      if (sb != null) return 1;
      return 0;
    });
  } else if (hasRankScore) {
    boosted.sort((a, b) => {
      const sa = typeof a.temporal_rank_score === 'number' ? a.temporal_rank_score : null;
      const sb = typeof b.temporal_rank_score === 'number' ? b.temporal_rank_score : null;
      if (sa != null && sb != null) return sb - sa;
      if (sa != null) return -1;
      if (sb != null) return 1;
      return 0;
    });
  }
  return boosted;
}

/**
 * Diversify retrieval so one dominant cluster cannot hide dissenting or
 * orthogonal evidence. Maximal marginal relevance is deterministic and works
 * with keyword-only results by using token overlap as a similarity proxy.
 *
 * @param {Array<Object>} results
 * @param {Object} [opts] { limit?, lambda?, blindSpotThreshold? }
 * @returns {Array<Object>} results annotated with coverage fields
 */
function diversifyResults(results, opts = {}) {
  if (!Array.isArray(results) || results.length === 0) return results || [];
  const limit = opts.limit || results.length;
  const lambda = opts.lambda == null ? 0.72 : Math.max(0, Math.min(1, opts.lambda));
  const selected = [];
  const remaining = results.map((result, index) => ({ result, index }));
  const tokens = result => new Set(String((result.title || '') + ' ' + (result.preview || result.content || '')).toLowerCase().split(/\\W+/).filter(t => t.length > 2));
  const similarity = (a, b) => {
    const ta = tokens(a), tb = tokens(b);
    if (!ta.size || !tb.size) return 0;
    let intersection = 0;
    for (const token of ta) if (tb.has(token)) intersection++;
    return intersection / Math.max(ta.size, tb.size);
  };
  while (selected.length < limit && remaining.length > 0) {
    let best = null;
    for (const candidate of remaining) {
      const relevance = typeof candidate.result.rerank_score === 'number'
        ? candidate.result.rerank_score
        : (typeof candidate.result.combined_score === 'number' ? candidate.result.combined_score : 1 / (candidate.index + 1));
      const redundancy = selected.length === 0 ? 0 : Math.max(...selected.map(s => similarity(candidate.result, s.result)));
      const score = lambda * relevance - (1 - lambda) * redundancy;
      if (!best || score > best.score) best = { candidate, score, redundancy };
    }
    const picked = best.candidate;
    picked.result.coverage_score = Math.round(best.score * 1000) / 1000;
    picked.result.redundancy_score = Math.round(best.redundancy * 1000) / 1000;
    selected.push(picked);
    remaining.splice(remaining.indexOf(picked), 1);
  }
  return selected.map(({ result }) => result);
}

/**
 * Append a bounded blind-spot probe when retrieval is weak, novel, or
 * one-sided. This makes uncertainty explicit instead of silently treating a
 * top-k hit as complete coverage.
 */
function buildCoverageReport(query, results, opts = {}) {
  const hits = Array.isArray(results) ? results : [];
  const threshold = opts.blindSpotThreshold == null ? 0.45 : opts.blindSpotThreshold;
  const topScore = hits.reduce((max, r) => Math.max(max,
    Number(r.rerank_score ?? r.combined_score ?? r.semantic_score ?? 0)), 0);
  const uniqueTypes = new Set(hits.map(r => r.type).filter(Boolean));
  const hasContradiction = hits.some(r => Number(r.outcome_weight) < 0 || r.type === 'error');
  const blindSpots = [];
  if (hits.length === 0 || topScore < threshold) blindSpots.push('low_evidence');
  if (hits.length > 0 && uniqueTypes.size === 1) blindSpots.push('single_memory_type');
  if (hits.length > 0 && !hasContradiction) blindSpots.push('no_dissenting_evidence');
  return {
    query,
    resultCount: hits.length,
    topScore: Math.round(topScore * 1000) / 1000,
    coverage: blindSpots.length === 0 ? 'covered' : 'partial',
    blindSpots,
    probe: blindSpots.length > 0 ? {
      type: 'coverage',
      query: `What evidence could disprove or qualify: ${query}`,
      rationale: blindSpots.join(', '),
      status: 'open',
    } : null,
  };
}

function attachOutcomeFields(db, results, opts = {}) {
  if (!db || !results || results.length === 0) return results || [];
  let stats = null;
  try {
    const { memoryOutcomeStats } = require('./self-improve');
    stats = memoryOutcomeStats(db, opts.project, { minRuns: opts.minRuns });
  } catch { stats = null; }
  if (!stats || stats.size === 0) {
    return results.map(r => ({ ...r, outcome_weight: 0, outcome_runs: 0 }));
  }
  return results.map(r => {
    const st = stats.get(r.id);
    return {
      ...r,
      outcome_weight: Math.round((st ? st.weight : 0) * 1000) / 1000,
      outcome_runs: st ? st.runs : 0,
    };
  });
}

module.exports = {
  sanitizeDate,
  buildWhereClause,
  keywordSearch,
  applyOutcomeWeights,
  attachOutcomeFields,
  diversifyResults,
  buildCoverageReport,
  semanticSearch,
  hybridSearch,
  rerankResults,
  isTemporalQuery,
  applyTemporalBoost,
};
