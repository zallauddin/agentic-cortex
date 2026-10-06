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
/**
 * English function words. FTS5 ships no stopword list, and its BM25 idf for a
 * term present in most documents is *negative* — so quoting "the", "is",
 * "what" into an OR query does not merely add noise, it actively subtracts
 * score from documents that contain them. Dropping them is pure query hygiene.
 */
const FTS_STOPWORDS = new Set((
  'a an and are as at be but by for from had has have he her his i if in into is it its me my of on or our ' +
  'she so that the their them they this to was we were what when where which who will with you your about ' +
  'after before over under again then too very can just not no do does did done been being am than out up ' +
  'down off own same all any both each few more most other such only now'
).split(/\s+/));

/**
 * Tokenise a free-text query into ranked-search terms.
 *
 * @param {string} rawQuery
 * @param {Object} [opts] — { keepStopwords?, maxTerms? }
 * @returns {string[]} lowercased, de-duplicated, stopword-filtered terms
 */
function queryTerms(rawQuery, opts = {}) {
  const safe = String(rawQuery || '').replace(/["']/g, '');
  let terms = [...new Set(safe.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))];
  if (terms.length === 0) return [];
  if (!opts.keepStopwords) {
    const filtered = terms.filter(t => !FTS_STOPWORDS.has(t));
    if (filtered.length > 0) terms = filtered;
  }
  const maxTerms = opts.maxTerms || 24;
  if (terms.length > maxTerms) terms = terms.slice(0, maxTerms);
  return terms;
}

/**
 * Build the FTS5 MATCH expression for a free-text query.
 *
 * Tokenises on non-alphanumerics (so punctuation never leaks into a phrase),
 * lowercases, de-duplicates and caps term count to bound query size, then ORs
 * the terms — OR keeps recall high for conversational questions where any
 * single distinctive word is a good anchor, while BM25 still ranks by how
 * many rare terms a document matches.
 *
 * Stopwords are dropped unless that would leave nothing to match (a query of
 * only function words still searches, rather than silently returning []), and
 * can be kept entirely with `opts.keepStopwords`.
 *
 * @param {string} rawQuery
 * @param {Object} [opts] — { keepStopwords?: boolean, maxTerms?: number }
 * @returns {string} FTS5 MATCH expression, or '' when the query has no terms
 */
function buildFtsQuery(rawQuery, opts = {}) {
  const terms = queryTerms(rawQuery, opts);
  return terms.map(t => '"' + t + '"').join(' OR ');
}

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

  const ftsQuery = buildFtsQuery(opts.query, opts);
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
  const tokens = result => new Set(String((result.title || '') + ' ' + (result.preview || result.content || '')).toLowerCase().split(/\W+/).filter(t => t.length > 2));
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

/**
 * Group key for a conversation memory: the row's `session_id` when the store
 * populated one, otherwise the title with the adapter's ` (date)` / ` - turn`
 * suffixes stripped. Returns null for memories that are not fragments of a
 * larger conversation (they are never grouped or expanded).
 */
function sessionGroupKey(row) {
  if (!row) return null;
  if (row.session_id) return String(row.session_id);
  const title = String(row.title || '');
  if (!title) return null;
  const key = title.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s*-\s*turn\s*$/, '').trim();
  // Only treat it as a fragment when the title actually had one of those
  // suffixes — otherwise every unrelated memory would collapse into one group.
  const grouped = key !== title;
  return grouped ? key : null;
}

/**
 * Parent-document expansion ("give me the whole conversation, not the line
 * that matched").
 *
 * Stores that keep both a full session transcript and its individual turns
 * otherwise spend most of top-k on several turns from the same session. This
 * replaces the first hit of each session with that session's transcript —
 * which already contains every other hit from it — and drops the now-covered
 * duplicates, so k slots span k conversations instead of 1.
 *
 * Measured on the benchmark corpora (scripts/strategy-sweep.js): recall
 * never regresses, and LongMemEval context falls because duplicate turns are
 * removed. Deliberately opt-in via `opts.expandSessions`: it trades returned
 * count for a much larger payload per result.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<Object>} results — ranked search results (id, title, project_path)
 * @param {Object} [opts] — { limit?, project? }
 * @returns {Array<Object>} expanded results, capped at limit
 */
function expandToSessions(db, results, opts = {}) {
  if (!Array.isArray(results) || results.length === 0) return results || [];
  if (!db) return results;
  const limit = opts.limit || results.length;
  const out = [];
  const expanded = new Set();

  let parentStmt = null;
  const parentByKey = new Map();

  for (const r of results) {
    if (out.length >= limit) break;
    const key = sessionGroupKey(r);
    if (!key) {
      out.push(r);
      continue;
    }
    if (expanded.has(key)) continue; // already covered by this session's transcript
    expanded.add(key);

    let parent = parentByKey.get(key);
    if (parent === undefined) {
      parent = null;
      try {
        if (!parentStmt) {
          parentStmt = db.prepare(
            'SELECT id, title, session_id, project_path FROM observations ' +
            'WHERE is_active = 1 AND project_path = ? AND ' +
            "(session_id = ? OR (session_id IS NULL AND title LIKE ?)) " +
            'ORDER BY length(content) DESC LIMIT 1'
          );
        }
        const project = r.project_path || opts.project;
        if (project) parent = parentStmt.get(project, key, key + ' (%') || null;
      } catch { parent = null; }
      parentByKey.set(key, parent);
    }

    // Only replace when the parent really is a bigger document than the hit:
    // a self-match (the hit IS the transcript) must not be treated as a parent.
    if (parent && parent.id !== r.id) {
      out.push({ ...r, id: parent.id, title: parent.title, session_id: parent.session_id, project_path: parent.project_path });
    } else {
      out.push(r);
    }
  }
  return out;
}

/**
 * Breadth control: allow at most `per` results from any one conversation.
 *
 * A single OR-query over a long conversation matches many of its turns, so a
 * plain top-k can be filled with near-duplicates of one session and crowd out
 * every other conversation. Capping fragments per session spreads k slots
 * across k conversations without discarding within-session evidence the way
 * strict deduplication does.
 *
 * Measured on both benchmark corpora (scripts/strategy-sweep.js): at `per=3`
 * recall rises on LongMemEval-S and LoCoMo simultaneously, with only a small
 * context increase — strict deduplication (per=1) instead *lost* 13 points on
 * LoCoMo, because its answers need several turns of the same conversation.
 *
 * @param {Array<Object>} results — ranked results carrying `title` or `session_id`
 * @param {Object} [opts] — { per? (default 3), limit? }
 * @returns {Array<Object>} results with per-session duplicates removed
 */
function capPerSession(results, opts = {}) {
  if (!Array.isArray(results) || results.length === 0) return results || [];
  const per = Math.max(1, opts.per == null ? 3 : opts.per);
  const limit = opts.limit || results.length;
  const counts = new Map();
  const out = [];
  for (const r of results) {
    if (out.length >= limit) break;
    const key = sessionGroupKey(r);
    // Non-conversation memories are never capped — the rule is about
    // conversations, not about unrelated memories that happen to co-occur.
    if (!key) {
      out.push(r);
      continue;
    }
    const n = counts.get(key) || 0;
    if (n >= per) continue;
    counts.set(key, n + 1);
    out.push(r);
  }
  return out;
}

/**
 * Smoothed BM25 IDF for each query term within one project.
 *
 * FTS5's own idf goes *negative* for a term present in most documents, which
 * is the defect `buildFtsQuery` works around for query construction. Ranking
 * needs the opposite sign convention — a ubiquitous term must contribute
 * little, never subtract — so this uses `log(1 + (N - df + 0.5) / (df + 0.5))`,
 * which is always positive.
 *
 * @param {Database} db
 * @param {string} project
 * @param {string[]} terms
 * @returns {Map<string, number>} term → weight (0.1 floor so nothing is inert)
 */
function idfWeights(db, project, terms) {
  const weights = new Map();
  if (!project || !Array.isArray(terms) || terms.length === 0) return weights;
  let total = 0;
  try {
    total = db
      .prepare('SELECT count(*) AS n FROM observations WHERE project_path = ? AND is_active = 1')
      .get(project).n;
  } catch (e) { total = 0; }
  if (!total) return weights;
  let dfStmt = null;
  try {
    dfStmt = db.prepare(
      'SELECT count(*) AS n FROM observations_fts fts JOIN observations o ON o.id = fts.rowid ' +
      'WHERE observations_fts MATCH ? AND o.project_path = ? AND o.is_active = 1'
    );
  } catch (e) { return weights; }
  for (const t of terms) {
    let df = 0;
    try { df = dfStmt.get('"' + String(t).replace(/"/g, '') + '"', project).n; } catch (e) { df = 0; }
    const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
    weights.set(t, Math.max(0.1, idf));
  }
  return weights;
}

/**
 * IDF-weighted fraction of query terms present in a document.
 *
 * This is deliberately length-*unaware*: it is the ranking function that
 * filesystem@session uses to good effect, and the one BM25's length
 * normalisation replaces. A 13K-char transcript containing every query term
 * scores 1.0 here but gets pushed past rank 50 by BM25 (observed ranks 58,
 * 143, 187 on LongMemEval) where no downstream reranker can reach it.
 *
 * @param {string} docText
 * @param {string[]} terms
 * @param {Map<string, number>} idf
 * @param {{ normalize?: boolean }} [opts] — divide by log-length (usually worse)
 * @returns {number} coverage in [0, 1]
 */
function coverageScore(docText, terms, idf, opts = {}) {
  if (!Array.isArray(terms) || terms.length === 0) return 0;
  const lower = String(docText || '').toLowerCase();
  if (!lower) return 0;
  let hit = 0;
  let total = 0;
  const seen = new Set();
  for (const t of terms) {
    const w = idf && idf.get ? (idf.get(t) || 0.1) : 1;
    total += w;
    if (seen.has(t)) continue;
    if (lower.includes(t)) { hit += w; seen.add(t); }
  }
  let score = total > 0 ? hit / total : 0;
  if (opts.normalize && score > 0) score = score / Math.log10(10 + lower.length / 200);
  return score;
}

/**
 * Reciprocal rank fusion of several rankings (Cormack 2009, k=60).
 *
 * RRF is used rather than score averaging because the two channels are not on
 * comparable scales: FTS returns BM25 rank (unbounded, negative-trending) and
 * the transcript channel returns a coverage ratio in [0, 1]. RRF needs only
 * the orderings, and is robust when one channel is much noisier than the other.
 *
 * @param {Array<Array<Object>>} rankLists
 * @param {number} limit
 * @returns {Array<Object>} fused rows, deduplicated by `id` when present
 */
function rrfFuse(rankLists, limit) {
  const byKey = new Map();
  (rankLists || []).forEach((list, li) => {
    (list || []).forEach((row, i) => {
      // Two channels can return *different objects* for the same observation;
      // keying on identity would then emit it twice and waste a result slot.
      const key = row && row.id != null ? 'id:' + row.id : row;
      const s = 1 / (60 + i + 1);
      const prev = byKey.get(key);
      if (prev) {
        prev.score += s;
        // Keep the better-ranked instance of a duplicated row.
        if (i < prev.idx) { prev.idx = i; prev.row = row; }
      } else {
        byKey.set(key, { row, score: s, idx: i, li });
      }
    });
  });
  return [...byKey.values()]
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .map((x) => x.row)
    .slice(0, limit);
}

/**
 * Second retrieval channel: rank every conversation transcript in the project
 * by query coverage, then fuse it with the BM25 candidate list.
 *
 * AC stores conversations at two granularities (turn fragments *and* whole
 * session transcripts), so it can afford the view that fixes BM25's length
 * normalisation without giving up turn-level precision — the two channels are
 * complementary, which is why fusing beats either alone on both benchmark
 * corpora. Cheap by construction: one table scan of ~40 transcripts per query.
 *
 * @param {Database} db
 * @param {Array<Object>} results — BM25 candidate list (already cap-limited)
 * @param {{ project: string, terms: string[], limit?: number, maxTranscripts?: number, fill?: boolean, idf?: Map }} opts
 *   `fill: true` keeps zero-coverage transcripts too — used to top up a short
 *   candidate list rather than to rerank a healthy one.
 * @returns {Array<Object>} RRF-fused rows
 */
function fuseTranscripts(db, results, opts = {}) {
  const project = opts.project;
  const terms = Array.isArray(opts.terms) ? opts.terms : [];
  if (!project || terms.length === 0) return results || [];
  const idf = opts.idf || idfWeights(db, project, terms);
  let transcripts = [];
  try {
    transcripts = db
      .prepare(
        'SELECT id, title, project_path, content, substr(content, 1, 300) AS preview, tags, session_id ' +
        'FROM observations WHERE project_path = ? AND is_active = 1 AND tags LIKE ?'
      )
      .all(project, '%session-transcript%');
  } catch (e) {
    return results || [];
  }
  if (!transcripts.length) return results || [];
  const ranked = transcripts
    .map((row) => ({ row, cov: coverageScore(row.content, terms, idf) }))
    .sort((a, b) => b.cov - a.cov)
    // Zero-coverage rows carry no relevance signal, so they only enter when
    // the caller is topping up an undersized result set — surfacing *some*
    // conversation beats returning nothing at all. `minCoverage` is the same
    // idea applied to rerank mode: a transcript the query barely touches is
    // redundant with the fragments already retrieved, and costs a whole
    // session's worth of context to prove it.
    .filter((x) => opts.fill || (x.cov > 0 && (opts.minCoverage == null || x.cov >= opts.minCoverage)))
    .map((x) => x.row);
  if (!ranked.length) return results || [];
  // Budget the second channel: each admitted transcript is a whole session,
  // so it costs several fragments' worth of context. `maxTranscripts` bounds
  // how many the channel may put forward, keeping the fusion from doubling
  // context for a recall gain that a handful of transcripts already delivers.
  const admitted = opts.maxTranscripts > 0 ? ranked.slice(0, opts.maxTranscripts) : ranked;
  const limit = opts.limit || (results || []).length + admitted.length;
  const fused = rrfFuse([results || [], admitted], limit);
  return fused.length > 0 ? fused : results || [];
}

/**
 * Greedy query-term coverage selection (set-cover over the query's terms).
 *
 * Different *hops* of a multi-hop question are different terms landing in
 * different documents, and different sessions of a multi-session question
 * carry different terms too. Ranking by global relevance therefore spends
 * several slots re-proving the same sub-fact. This picks the candidate that
 * covers the most still-uncovered query term first, tie-breaking on rank, so
 * the k slots jointly maximise what the question asked about.
 *
 * Content is hydrated by id: `search()` returns 300-char previews, and
 * measuring coverage on a preview would systematically favour short turns
 * over long transcripts — the exact length bias BM25 already has.
 *
 * @param {Database} db
 * @param {Array<Object>} results — ranked candidate pool
 * @param {{ terms: string[], limit?: number }} opts
 * @returns {Array<Object>} at most `limit` results, in selection order
 */
function greedyCoverageSelect(db, results, opts = {}) {
  const terms = Array.isArray(opts.terms) ? opts.terms : [];
  const limit = opts.limit || results.length;
  if (!Array.isArray(results) || results.length === 0) return results || [];
  if (terms.length === 0 || results.length <= limit) return results.slice(0, limit);

  let contentStmt = null;
  try { contentStmt = db.prepare('SELECT content FROM observations WHERE id = ?'); } catch { /* fall back to previews */ }
  const textOf = (r) => {
    if (r.content && r.content.length > 300) return String(r.content).toLowerCase();
    if (contentStmt) {
      try {
        const row = contentStmt.get(Number(r.id));
        if (row) return String(row.content).toLowerCase();
      } catch { /* fall through */ }
    }
    return String(r.preview || '').toLowerCase();
  };

  const remaining = results.map((r) => ({ r, text: textOf(r) }));
  const covered = new Set();
  const chosen = [];
  while (chosen.length < limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestGain = -1;
    for (let i = 0; i < remaining.length; i++) {
      let gain = 0;
      for (const t of terms) if (!covered.has(t) && remaining[i].text.includes(t)) gain++;
      // Strict `>` keeps the earliest (highest-ranked) candidate on ties.
      if (gain > bestGain) { bestGain = gain; bestIdx = i; }
    }
    // Nothing new to cover anywhere: fall back to raw rank order.
    const pick = bestGain > 0 ? bestIdx : 0;
    const item = remaining.splice(pick, 1)[0];
    for (const t of terms) if (item.text.includes(t)) covered.add(t);
    chosen.push(item.r);
  }
  return chosen;
}

/**
 * Enforce a floor on how many distinct conversations occupy the top-k.
 *
 * `capPerSession` only *limits* how much one conversation can dominate; it
 * cannot guarantee that a second conversation gets in at all. This takes the
 * ranked top-k and, whenever it spans fewer than `minDistinct` conversations,
 * evicts the weakest member of the most over-represented conversation to make
 * room for the best unused candidate from an unseen one.
 *
 * Deliberately conservative — it never removes a conversation's only member,
 * never touches non-conversation memories, and only ever trades a *duplicate*
 * for a *new* conversation. LoCoMo answers need several turns of the same
 * conversation, so a stricter policy (1 per conversation) measures 25 pts
 * worse; this is the smallest intervention that can still add diversity.
 *
 * @param {Array<Object>} results — ranked, already cap-limited candidates
 * @param {{ limit?: number, minDistinct?: number }} opts
 * @returns {Array<Object>} at most `limit` results, original rank order kept
 */
function spreadAcrossSessions(results, opts = {}) {
  if (!Array.isArray(results) || results.length === 0) return results || [];
  const limit = opts.limit || results.length;
  const minDistinct = opts.minDistinct == null ? 0 : opts.minDistinct;
  const chosen = results.slice(0, limit);
  if (minDistinct <= 1 || chosen.length === 0) return chosen;

  // Positions of conversation members inside `chosen`, grouped by session.
  const byKey = new Map();
  chosen.forEach((r, i) => {
    const k = sessionGroupKey(r);
    if (!k) return; // non-conversation memory: never a donor, never counted
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(i);
  });
  const distinct = () => byKey.size;
  if (distinct() >= minDistinct) return chosen;

  // Unused candidates beyond the cut, grouped by the conversation they'd add.
  const poolByKey = new Map();
  results.slice(limit).forEach((r, j) => {
    const k = sessionGroupKey(r);
    if (!k || byKey.has(k)) return; // only conversations not yet represented
    if (!poolByKey.has(k)) poolByKey.set(k, []);
    poolByKey.get(k).push(limit + j);
  });

  const keep = new Set(chosen.map((_, i) => i));
  while (distinct() < minDistinct) {
    const incomingKey = poolByKey.keys().next().value;
    if (incomingKey == null) break;
    // Donor must have >1 member, otherwise evicting it loses a conversation.
    let donor = null;
    for (const [k, idxs] of byKey) {
      // byKey is a Map — index it with .get(), not property access.
      const donorLen = donor == null ? 0 : byKey.get(donor).length;
      if (idxs.length >= 2 && idxs.length > donorLen) donor = k;
    }
    if (donor == null) break;
    const evicted = byKey.get(donor).pop();
    keep.delete(evicted);
    const added = poolByKey.get(incomingKey).shift();
    keep.add(added);
    byKey.set(incomingKey, [added]);
    poolByKey.delete(incomingKey);
    if (byKey.get(donor).length === 0) byKey.delete(donor);
  }
  // `keep` holds indices into `results` (the promoted rows sit beyond `limit`),
  // so map them back to rows rather than filtering `chosen`, which would
  // silently discard every promoted row.
  return [...keep]
    .filter((i) => i >= 0 && i < results.length)
    .sort((a, b) => a - b)
    .map((i) => results[i]);
}

module.exports = {
  sanitizeDate,
  buildWhereClause,
  buildFtsQuery,
  queryTerms,
  idfWeights,
  coverageScore,
  rrfFuse,
  fuseTranscripts,
  keywordSearch,
  expandToSessions,
  capPerSession,
  greedyCoverageSelect,
  spreadAcrossSessions,
  sessionGroupKey,
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
