/**
 * embedding.js — Embedding engine for agentic-cortex.
 *
 * Provides text embedding via @xenova/transformers (BGE-base-en-v1.5),
 * cross-encoder reranking (MS-MARCO MiniLM), vector similarity computation,
 * a lazy-initialized pipeline singleton per model, and an LRU embedding
 * result cache to avoid redundant model inference.
 *
 * @module core/embedding
 */

'use strict';

const { EMBED_MODEL, RERANK_MODEL } = require('./constants');

// ─── Pipeline singletons ──────────────────────────────────────────

/** @type {Function|null} Lazy singleton for the feature-extraction pipeline */
let _embedPipeline = null;

/** @type {Function|null} Lazy singleton for the text-classification (cross-encoder) pipeline */
let _rerankPipeline = null;

/**
 * Get or create the embedding pipeline (lazy singleton).
 * Downloads the model (~400MB) on first run; subsequent runs are instant.
 *
 * @returns {Promise<Function>} The feature-extraction pipeline
 * @throws {Error} If @xenova/transformers is not installed
 */
async function getEmbedPipeline() {
  if (_embedPipeline) return _embedPipeline;
  try {
    const { pipeline } = require('@xenova/transformers');
    _embedPipeline = await pipeline('feature-extraction', EMBED_MODEL);
    return _embedPipeline;
  } catch (err) {
    console.error('Embedding model not available. Run: npm install @xenova/transformers');
    console.error('First run downloads the model (~400MB for BGE-base). Subsequent runs are instant.');
    throw err;
  }
}

/**
 * Get or create the cross-encoder reranker pipeline (lazy singleton).
 * The cross-encoder scores (query, document) pairs for relevance and is
 * much more accurate than bi-encoder cosine similarity but slower per pair.
 * Downloads the model (~90MB) on first run.
 *
 * @returns {Promise<Function>} The text-classification pipeline (cross-encoder)
 * @throws {Error} If @xenova/transformers is not installed
 */
async function getRerankPipeline() {
  if (_rerankPipeline) return _rerankPipeline;
  try {
    const { pipeline } = require('@xenova/transformers');
    _rerankPipeline = await pipeline('text-classification', RERANK_MODEL);
    return _rerankPipeline;
  } catch (err) {
    console.error('Reranker model not available. Run: npm install @xenova/transformers');
    console.error('First run downloads the model (~90MB). Subsequent runs are instant.');
    throw err;
  }
}

// ─── LRU embedding cache ─────────────────────────────────────────

/** @type {number} Maximum cache entries before eviction */
const CACHE_MAX_SIZE = parseInt(process.env.AGENTIC_CORTEX_EMBED_CACHE_SIZE || '500', 10) || 500;

/** @type {Map<string, number[]>} LRU cache: text → embedding vector */
const _embedCache = new Map();

/** @type {{ hits: number, misses: number }} Cache hit/miss counters */
const _cacheStats = { hits: 0, misses: 0 };

/**
 * Get an entry from the LRU cache.
 * Moves the entry to the end (most-recently-used) on hit.
 *
 * @param {string} key - Cache key (text content)
 * @returns {number[]|undefined} Cached embedding vector, or undefined on miss
 */
function _cacheGet(key) {
  if (_embedCache.has(key)) {
    const value = _embedCache.get(key);
    // Move to end (most recently used)
    _embedCache.delete(key);
    _embedCache.set(key, value);
    _cacheStats.hits++;
    return value;
  }
  _cacheStats.misses++;
  return undefined;
}

/**
 * Store an entry in the LRU cache.
 * Evicts the oldest entry if the cache is at max capacity.
 *
 * @param {string} key - Cache key (text content)
 * @param {number[]} value - Embedding vector to cache
 */
function _cacheSet(key, value) {
  if (_embedCache.has(key)) {
    _embedCache.delete(key);
  } else if (_embedCache.size >= CACHE_MAX_SIZE) {
    // Evict least-recently-used (first entry in Map iteration order)
    const oldest = _embedCache.keys().next().value;
    _embedCache.delete(oldest);
  }
  _embedCache.set(key, value);
}

// ─── Core embedding functions ────────────────────────────────────

/**
 * Compute a 768-dimensional embedding vector for the given text.
 * Uses mean pooling and L2 normalization. Results are cached in-process
 * so repeated calls for identical text skip model inference.
 *
 * @param {string} text - The text to embed
 * @returns {Promise<number[]>} The embedding vector
 */
async function computeEmbedding(text) {
  const cached = _cacheGet(text);
  if (cached) return cached;

  const pipe = await getEmbedPipeline();
  const result = await pipe(text, { pooling: 'mean', normalize: true });
  const vec = Array.from(result.data);
  _cacheSet(text, vec);
  return vec;
}

/**
 * Compute cosine similarity between two vectors.
 * Returns 0 if dimensions differ (different models produce meaningless scores).
 *
 * @param {number[]} a - First embedding vector
 * @param {number[]} b - Second embedding vector
 * @returns {number} Cosine similarity in range [-1, 1]
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  // Guard against zero-norm vectors (division by zero → NaN).
  // A vector with zero magnitude has no direction, so similarity is 0.
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── Cache management ───────────────────────────────────────────

/**
 * Clear the embedding result cache and reset hit/miss counters.
 */
function clearEmbeddingCache() {
  _embedCache.clear();
  _cacheStats.hits = 0;
  _cacheStats.misses = 0;
}

/**
 * Get embedding cache statistics.
 *
 * @returns {{ size: number, maxSize: number, hits: number, misses: number }}
 */
function getEmbeddingCacheStats() {
  return {
    size: _embedCache.size,
    maxSize: CACHE_MAX_SIZE,
    hits: _cacheStats.hits,
    misses: _cacheStats.misses,
  };
}

// ─── Cross-encoder reranking ─────────────────────────────────────

/**
 * Rerank a list of documents for relevance to a query using a cross-encoder
 * model. The model takes (query, document) pairs and returns a calibrated
 * relevance score per pair. Cross-encoders are more accurate than bi-encoder
 * cosine similarity but slower per query-document pair, so this is meant to
 * be applied AFTER an initial candidate retrieval (FTS5/hybrid/semantic)
 * to a small top-N set (typically 10–50 documents).
 *
 * Each input `document` should be a string; titles are prepended with "Title: "
 * to give the model context. A short preview of `preview` field is used if
 * `content` is absent.
 *
 * @param {string} query - The search query
 * @param {Array<{id: number, title?: string|null, content?: string|null, preview?: string|null}>} documents
 *   - The candidate documents to rerank
 * @returns {Promise<Array<{id: number, score: number, rank: number}>>}
 *   - New ordering with calibrated scores, sorted by score descending
 */
async function rerank(query, documents) {
  if (!documents || documents.length === 0) return [];
  const pipe = await getRerankPipeline();

  // Build (query, document) pairs for the cross-encoder.
  const texts = documents.map((doc) => {
    const titlePart = doc.title ? `Title: ${doc.title}. ` : '';
    const bodyPart = doc.content || doc.preview || '';
    const truncated = bodyPart.length > 512 ? bodyPart.slice(0, 512) : bodyPart;
    return `${query} [SEP] ${titlePart}${truncated}`;
  });

  let outputs;
  try {
    outputs = await pipe(texts);
  } catch (err) {
    console.error('[rerank] Cross-encoder inference failed:', err.message);
    // On failure, return identity ordering with neutral scores so the
    // caller still gets a usable result.
    return documents.map((doc, i) => ({ id: doc.id, score: 0, rank: i }));
  }

  // Cross-encoder outputs: [{label, score}, ...] — one per input.
  // MS-MARCO MiniLM uses label 'LABEL_0' with logits in roughly [-10, 10].
  // Sigmoid-normalize to [0, 1] for a calibrated probability-like score.
  const scored = outputs.map((out, i) => {
    const raw = typeof out === 'object' && out !== null && typeof out.score === 'number' ? out.score : 0;
    // Sigmoid: 1 / (1 + e^-x) — clamps extreme logits to [0, 1].
    const calibrated = 1 / (1 + Math.exp(-raw));
    return { id: documents[i].id, score: calibrated };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s, i) => ({ ...s, rank: i }));
}

/**
 * Dispose all pipeline resources to free memory.
 * Call this when shutting down the system.
 */
function disposePipelines() {
  _embedPipeline = null;
  _rerankPipeline = null;
  _embedCache.clear();
  _cacheStats.hits = 0;
  _cacheStats.misses = 0;
}

module.exports = {
  getEmbedPipeline,
  getRerankPipeline,
  computeEmbedding,
  cosineSimilarity,
  rerank,
  clearEmbeddingCache,
  getEmbeddingCacheStats,
  disposePipelines,
};
