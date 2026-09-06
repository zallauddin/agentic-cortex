/**
 * conflict.js — Conflict detection for agentic-cortex.
 *
 * Detects potentially contradictory observations using semantic similarity
 * (cosine similarity > 0.65 on embeddings) and optional LLM verification.
 * Pairs with high similarity but different content are flagged as conflicts.
 *
 * Utopia-inspired improvements over the fresh-uncached winner-takes-LLM baseline:
 *  1. Semantic cache — conflict detection results are cached by project + embedding
 *     hash + threshold so repeated scans of the same observation set skip O(n²)
 *     pair comparison entirely. Cache is invalidated when new observations are added
 *     (detected via embedding hash change) or when the threshold changes.
 *  2. Confidence floor — low-confidence observations (below opts.confidenceFloor)
 *     are filtered out BEFORE pair comparison, so noisy/uncertain memories don't
 *     waste cycle time or produce spurious conflict pairs.
 *  3. LLM batching — instead of firing one LLM call per conflict pair, pairs are
 *     batched into groups of opts.batchSize and verified with a single multi-pair
 *     prompt, reducing LLM round-trips from O(pairs) to O(pairs/batchSize).
 *  4. Third outcome: "keep both / leave open" — when the LLM says the pair is NOT
 *     a contradiction AND the similarity is below the "likely same topic" ceiling,
 *     the pair is tagged outcome:"open" rather than forcing a winner-takes-all
 *     resolution. This preserves genuinely distinct but related observations.
 *
 * @module core/conflict
 */

'use strict';

const { cosineSimilarity } = require('./embedding');

/** Runtime-accessible callLLM so tests can patch session.callLLM and have conflict.js pick it up.
 *  Same pattern as resolution.js: the test reloads this module after patching session. */
function _callLLM() { return require('./session').callLLM; }

// ─── Semantic cache ─────────────────────────────────────────────────

/** @type {Map<string, { conflicts: Array, totalFound: number, embeddingHash: string, threshold: number, confidenceFloor: number }>} */
const _conflictCache = new Map();

/**
 * Compute a stable hash of the active embedded observation set for a project.
 * Used as part of the cache key: if the set of embeddded observations changes,
 * the cache is stale and must be recomputed.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @returns {string} Hex hash of sorted id→embedding-preview pairs
 */
function _embeddingSetHash(db, project) {
  const rows = db.prepare(
    "SELECT id, embedding FROM observations WHERE project_path = ? AND is_active = 1 AND embedding IS NOT NULL ORDER BY id"
  ).all(project);
  if (rows.length === 0) return '';

  const parts = [];
  for (const r of rows) {
    try {
      const vec = JSON.parse(r.embedding);
      // Use a short fingerprint: first 8 dims + length + id
      const dims = vec.slice(0, 8).map(v => v.toFixed(4)).join(',');
      parts.push(r.id + ':' + dims + ':' + vec.length);
    } catch {
      parts.push(r.id + '::');
    }
  }
  const payload = parts.join('|');
  // Simple hash: sum of char codes mod a large prime, hex-encoded
  let hash = 0;
  for (let i = 0; i < payload.length; i++) {
    hash = ((hash * 31) + payload.charCodeAt(i)) >>> 0;
  }
  return (hash >>> 0).toString(16);
}

/** Clear the conflict detection cache (called when observations are added/removed). */
function clearConflictCache() {
  _conflictCache.clear();
}

/**
 * Get cached conflict detection results if the cache key matches.
 *
 * @param {string} project
 * @param {number} threshold
 * @param {number} confidenceFloor
 * @param {string} embeddingHash
 * @returns {Object|undefined}
 */
function _cacheGet(project, threshold, confidenceFloor, embeddingHash) {
  const key = project + '|' + threshold + '|' + confidenceFloor + '|' + embeddingHash;
  const entry = _conflictCache.get(key);
  if (!entry) return undefined;
  // Cache is valid only if the embedding set hasn't changed since caching
  if (entry.embeddingHash !== embeddingHash) return undefined;
  if (entry.threshold !== threshold) return undefined;
  if (entry.confidenceFloor !== confidenceFloor) return undefined;
  return entry;
}

/**
 * Store conflict detection results in the semantic cache.
 *
 * @param {string} project
 * @param {number} threshold
 * @param {number} confidenceFloor
 * @param {string} embeddingHash
 * @param {Object} result
 */
function _cacheSet(project, threshold, confidenceFloor, embeddingHash, result) {
  const key = project + '|' + threshold + '|' + confidenceFloor + '|' + embeddingHash;
  _conflictCache.set(key, {
    conflicts: result.conflicts,
    totalFound: result.totalFound,
    embeddingHash,
    threshold,
    confidenceFloor,
  });
}

// ─── Constants ──────────────────────────────────────────────────────

/** Default cosine similarity threshold for conflict detection. */
const DEFAULT_SIMILARITY_THRESHOLD = 0.65;

/** Default minimum confidence for an observation to be considered for conflict detection. */
const DEFAULT_CONFIDENCE_FLOOR = 30;

/** Default batch size for LLM contradiction verification. */
const DEFAULT_BATCH_SIZE = 5;

/** Similarity ceiling above which two observations are likely the same topic
 *  (not "keep both" candidates — they should be consolidated instead). */
const KEEP_BOTH_SIMILARITY_CEILING = 0.85;

// ─── Main detection function ────────────────────────────────────────

/**
 * Detect conflicting observations within a project.
 *
 * Utopia-inspired enhancements over the naive baseline:
 *  - Semantic cache: repeated scans skip O(n²) pair comparison.
 *  - Confidence floor: low-confidence noise is filtered before pairing.
 *  - LLM batching: N pairs → ceil(N/batchSize) LLM calls instead of N.
 *  - "Keep both / leave open" outcome: pairs that are similar-but-not-contradictory
 *    and below the consolidation ceiling are tagged outcome:"open" instead of
 *    being forced through winner-takes-all resolution.
 *
 * @param {import('better-sqlite3').Database} db - Database instance
 * @param {Object} opts - Conflict detection options
 * @param {string} [opts.project] - Project path to scan (defaults to AGENTIC_CORTEX_PROJECT or cwd)
 * @param {number} [opts.limit=10] - Maximum number of conflict pairs to return
 * @param {boolean} [opts.autoResolve=false] - Enable LLM contradiction verification
 * @param {number} [opts.threshold=0.65] - Cosine similarity threshold for conflict candidate
 * @param {number} [opts.confidenceFloor=30] - Minimum confidence to include an observation
 * @param {number} [opts.batchSize=5] - Number of pairs per LLM batch prompt
 * @returns {{ conflicts: Array<Object>, totalFound: number, project: string, resolutions: Array }}
 */
async function checkConflicts(db, opts) {
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const limit = opts.limit || 10;
  const threshold = opts.threshold != null ? opts.threshold : DEFAULT_SIMILARITY_THRESHOLD;
  const confidenceFloor = opts.confidenceFloor != null ? opts.confidenceFloor : DEFAULT_CONFIDENCE_FLOOR;
  const batchSize = opts.batchSize != null ? opts.batchSize : DEFAULT_BATCH_SIZE;

  // Fetch embedded observations for the project, applying the confidence floor
  const embedded = db.prepare(
    'SELECT id, type, title, content, confidence, provenance, embedding ' +
    'FROM observations WHERE project_path = ? AND is_active = 1 AND embedding IS NOT NULL ' +
    'AND confidence >= ? ' +
    'ORDER BY id DESC LIMIT 200'
  ).all(project, confidenceFloor);

  if (embedded.length < 2) {
    return { conflicts: [], totalFound: 0, project, resolutions: [] };
  }

  // Semantic cache check: if the embedding set hash matches a prior scan,
  // return the cached result without recomputing O(n²) pairs.
  // Only use cache when NOT doing autoResolve (LLM verification changes things).
  const embeddingHash = _embeddingSetHash(db, project);
  if (!opts.autoResolve) {
    const cached = _cacheGet(project, threshold, confidenceFloor, embeddingHash);
    if (cached) {
      const cachedCopy = cached.conflicts.map(c => ({ ...c }));
      return { conflicts: cachedCopy, totalFound: cached.totalFound, project, resolutions: [] };
    }
  }

  // ── Pair comparison (O(n²) over embedded observations) ──
  const conflicts = [];
  for (let i = 0; i < embedded.length; i++) {
    for (let j = i + 1; j < embedded.length; j++) {
      try {
        const vecA = JSON.parse(embedded[i].embedding);
        const vecB = JSON.parse(embedded[j].embedding);
        const sim = cosineSimilarity(vecA, vecB);

        // High similarity but potentially conflicting
        if (sim > threshold) {
          conflicts.push({
            a: {
              id: embedded[i].id,
              type: embedded[i].type,
              title: embedded[i].title,
              confidence: embedded[i].confidence,
              preview: embedded[i].content.slice(0, 150),
            },
            b: {
              id: embedded[j].id,
              type: embedded[j].type,
              title: embedded[j].title,
              confidence: embedded[j].confidence,
              preview: embedded[j].content.slice(0, 150),
            },
            similarity: Math.round(sim * 1000) / 1000,
          });
        }
      } catch {
        // Skip pairs with unparseable embeddings
      }
    }
  }

  conflicts.sort((a, b) => b.similarity - a.similarity);
  const top = conflicts.slice(0, limit);

  // Store in cache (before LLM verification, so the pair list is cached
  // even when LLM is unavailable). Only cache when NOT doing autoResolve.
  if (!opts.autoResolve) {
    _cacheSet(project, threshold, confidenceFloor, embeddingHash, {
      conflicts: top,
      totalFound: conflicts.length,
    });
  }

  // ── LLM verification with batching ──
  if (opts.autoResolve && top.length > 0) {
    await _verifyBatches(db, project, top, batchSize);

    // After LLM verification, cache the results (with LLM annotations)
    _cacheSet(project, threshold, confidenceFloor, embeddingHash, {
      conflicts: top,
      totalFound: conflicts.length,
    });
  }

  // ── Evidence-theoretic auto-resolution ──
  const resolutions = [];
  if (opts.autoResolve) {
    try {
      const resolution = require('./resolution');
      const corr = resolution.computeCorroboration(db, project);
      for (const c of top) {
        if (c.llm_contradiction === false) {
          // LLM says these are NOT contradictory.
          // Tag as "open" if similarity is below the consolidation ceiling,
          // otherwise flag for consolidation (same topic, different details).
          if (c.similarity < KEEP_BOTH_SIMILARITY_CEILING) {
            c.outcome = 'open'; // keep both, leave the question open
          } else {
            c.outcome = 'consolidate'; // same topic — candidate for merge
          }
          continue;
        }
        if (c.llm_contradiction === null || c.llm_contradiction === undefined) {
          // LLM unavailable or response missing — inconclusive
          c.outcome = 'inconclusive';
          continue;
        }
        // c.llm_contradiction === true — real contradiction, resolve it
        const fullA = db.prepare('SELECT * FROM observations WHERE id = ?').get(c.a.id);
        const fullB = db.prepare('SELECT * FROM observations WHERE id = ?').get(c.b.id);
        if (!fullA || !fullB) continue;
        const res = await resolution.resolveConflict(db, {
          project,
          a: fullA,
          b: fullB,
          corroboration: corr,
          resolutionType: 'adjudicated',
        });
        resolutions.push(res);
        c.outcome = res.status === 'resolved' ? 'resolved' : 'undecidable';
      }
    } catch {
      // auto-resolve unavailable — fall back to flagged-only outcomes
      for (const c of top) {
        if (!c.outcome) c.outcome = 'unresolved';
      }
    }
  }

  return { conflicts: top, totalFound: conflicts.length, project, resolutions };
}

/**
 * Verify contradiction for multiple conflict pairs in batches using a single
 * multi-pair LLM prompt per batch, reducing round-trips from O(pairs) to
 * O(ceil(pairs/batchSize)).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @param {Array<Object>} pairs - Conflict pairs with a/b/preview/similarity
 * @param {number} batchSize - Pairs per batch
 * @returns {Promise<void>}
 */
async function _verifyBatches(db, project, pairs, batchSize) {
  const batches = [];
  for (let i = 0; i < pairs.length; i += batchSize) {
    batches.push(pairs.slice(i, i + batchSize));
  }

  // Fire all batches in parallel (each batch is one LLM call)
  await Promise.allSettled(
    batches.map(async (batch) => {
      try {
        const pairLines = batch.map((c, idx) =>
          `${idx + 1}. A: ${c.a.preview}\n   B: ${c.b.preview}`
        ).join('\n\n');

        const llmCheck = await _callLLM()([
          { role: 'system', content: 'You detect contradictions between pairs of information. For each pair, answer ONLY "YES" or "NO" on its own line, in order.' },
          { role: 'user', content:
            'Do these pairs of observations contradict each other? Answer YES or NO for each pair, one per line.\n\n' +
            pairLines + '\n\n' +
            'Reply with ONLY lines like:\nYES\nNO\nYES\n... (one per pair, in order)' },
        ], { temperature: 0, maxTokens: 10 * batch.length, timeout: 30000 });

        if (!llmCheck) return; // LLM unavailable

        const lines = String(llmCheck).split('\n').map(l => l.trim().toUpperCase());
        batch.forEach((c, idx) => {
          const answer = idx < lines.length ? lines[idx] : null;
        c.llm_contradiction = answer === 'YES' ? true : (answer === 'NO' ? false : null);
      });
      } catch {
        // Batch failed — mark all pairs in this batch as inconclusive
        batch.forEach(c => { c.llm_contradiction = null; });
      }
    })
  );
}

module.exports = {
  checkConflicts,
  clearConflictCache,
  _embeddingSetHash,
  _cacheGet,
  _cacheSet,
  DEFAULT_SIMILARITY_THRESHOLD,
  DEFAULT_CONFIDENCE_FLOOR,
  DEFAULT_BATCH_SIZE,
  KEEP_BOTH_SIMILARITY_CEILING,
};
