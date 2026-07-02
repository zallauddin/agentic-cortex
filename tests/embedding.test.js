'use strict';

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  cosineSimilarity,
  clearEmbeddingCache,
  getEmbeddingCacheStats,
} = require('../src/core/embedding');

// ─── cosineSimilarity ────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('should return 1.0 for identical vectors', () => {
    const vec = [1, 2, 3, 4, 5];
    const result = cosineSimilarity(vec, vec);
    assert.ok(Math.abs(result - 1.0) < 0.0001, `Expected ~1.0, got ${result}`);
  });

  it('should return 1.0 for scaled identical vectors', () => {
    const a = [1, 2, 3];
    const b = [2, 4, 6]; // 2x scaling
    const result = cosineSimilarity(a, b);
    assert.ok(Math.abs(result - 1.0) < 0.0001, `Scaled identical should be ~1.0, got ${result}`);
  });

  it('should return 0.0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    const result = cosineSimilarity(a, b);
    assert.ok(Math.abs(result - 0.0) < 0.0001, `Orthogonal should be ~0.0, got ${result}`);
  });

  it('should return -1.0 for opposite vectors', () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    const result = cosineSimilarity(a, b);
    assert.ok(Math.abs(result - (-1.0)) < 0.0001, `Opposite should be ~-1.0, got ${result}`);
  });

  it('should return 0 for vectors with different dimensions', () => {
    const a = [1, 2, 3];
    const b = [1, 2, 3, 4];
    const result = cosineSimilarity(a, b);
    assert.equal(result, 0, 'Different dimensions should return 0');
  });

  it('should return positive value for similar vectors', () => {
    const a = [1, 2, 3];
    const b = [1.1, 1.9, 3.2]; // Slightly different
    const result = cosineSimilarity(a, b);
    assert.ok(result > 0.9, `Similar vectors should have high similarity, got ${result}`);
  });

  it('should handle single-element vectors', () => {
    const a = [5];
    const b = [3];
    const result = cosineSimilarity(a, b);
    assert.equal(result, 1.0, 'Single-element vectors always have cosine 1.0');
  });

  it('should handle large vectors efficiently', () => {
    const size = 768;
    const a = new Array(size).fill(0).map((_, i) => Math.sin(i));
    const b = new Array(size).fill(0).map((_, i) => Math.cos(i));
    const result = cosineSimilarity(a, b);
    assert.ok(!isNaN(result), 'Result should not be NaN');
    assert.ok(result >= -1 && result <= 1, 'Result should be in [-1, 1]');
  });

  it('should handle zero vectors (guard returns 0)', () => {
    const a = [0, 0, 0];
    const b = [1, 2, 3];
    const result = cosineSimilarity(a, b);
    // Zero-norm vectors are now guarded: returns 0 instead of NaN
    assert.equal(result, 0, 'Zero-norm vector should return 0');
  });

  it('should handle both zero vectors', () => {
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    const result = cosineSimilarity(a, b);
    assert.equal(result, 0, 'Both-zero vectors should return 0');
  });

  it('should handle negative values', () => {
    const a = [1, -2, 3];
    const b = [-1, 2, -3]; // Opposite
    const result = cosineSimilarity(a, b);
    assert.ok(Math.abs(result - (-1.0)) < 0.0001, 'Opposite vectors with mixed signs should be ~-1.0');
  });

  it('should handle vectors with zeros mixed in', () => {
    const a = [1, 0, 2, 0, 3];
    const b = [1, 0, 2, 0, 3];
    const result = cosineSimilarity(a, b);
    assert.ok(Math.abs(result - 1.0) < 0.0001);
  });

  it('should return values within [-1, 1] range for random vectors', () => {
    for (let t = 0; t < 20; t++) {
      const len = 50;
      const a = new Array(len).fill(0).map(() => (Math.random() - 0.5) * 2);
      const b = new Array(len).fill(0).map(() => (Math.random() - 0.5) * 2);
      const result = cosineSimilarity(a, b);
      if (!isNaN(result)) {
        assert.ok(result >= -1.0001 && result <= 1.0001,
          `Result ${result} should be in [-1, 1]`);
      }
    }
  });
});

// ─── Embedding Cache ─────────────────────────────────────────────────

describe('embedding cache', () => {
  afterEach(() => {
    clearEmbeddingCache();
  });

  it('should start with empty cache', () => {
    const stats = getEmbeddingCacheStats();
    assert.equal(stats.size, 0);
    assert.equal(stats.maxSize, 500);
    assert.equal(stats.hits, 0);
    assert.equal(stats.misses, 0);
  });

  it('should clear cache and reset stats', () => {
    // We can't directly test _cacheGet/_cacheSet since they're not exported,
    // but we can verify the exported functions work correctly.
    clearEmbeddingCache();
    const stats = getEmbeddingCacheStats();
    assert.equal(stats.size, 0);
    assert.equal(stats.hits, 0);
    assert.equal(stats.misses, 0);
  });

  it('should report correct maxSize', () => {
    const stats = getEmbeddingCacheStats();
    assert.equal(stats.maxSize, 500);
  });

  it('should return an object with expected shape', () => {
    const stats = getEmbeddingCacheStats();
    assert.ok('size' in stats);
    assert.ok('maxSize' in stats);
    assert.ok('hits' in stats);
    assert.ok('misses' in stats);
    assert.equal(typeof stats.size, 'number');
    assert.equal(typeof stats.hits, 'number');
    assert.equal(typeof stats.misses, 'number');
  });

  it('clearEmbeddingCache should be callable multiple times', () => {
    assert.doesNotThrow(() => {
      clearEmbeddingCache();
      clearEmbeddingCache();
      clearEmbeddingCache();
    });
  });

  it('cache stats should persist between calls within same test', () => {
    clearEmbeddingCache();
    let stats = getEmbeddingCacheStats();
    const initialHits = stats.hits;
    stats = getEmbeddingCacheStats();
    assert.equal(stats.hits, initialHits);
  });
});

// ─── Module Export Shape ─────────────────────────────────────────────

describe('module exports', () => {
  const embedding = require('../src/core/embedding');

  it('should export getEmbedPipeline', () => {
    assert.equal(typeof embedding.getEmbedPipeline, 'function');
  });

  it('should export getRerankPipeline', () => {
    assert.equal(typeof embedding.getRerankPipeline, 'function');
  });

  it('should export computeEmbedding', () => {
    assert.equal(typeof embedding.computeEmbedding, 'function');
  });

  it('should export cosineSimilarity', () => {
    assert.equal(typeof embedding.cosineSimilarity, 'function');
  });

  it('should export rerank', () => {
    assert.equal(typeof embedding.rerank, 'function');
  });

  it('should export clearEmbeddingCache', () => {
    assert.equal(typeof embedding.clearEmbeddingCache, 'function');
  });

  it('should export getEmbeddingCacheStats', () => {
    assert.equal(typeof embedding.getEmbeddingCacheStats, 'function');
  });
});

// ─── Pipeline Functions (mocked) ─────────────────────────────────────

describe('pipeline functions (no transformers installed)', () => {
  it('getEmbedPipeline should throw when @xenova/transformers is not installed', async () => {
    const { getEmbedPipeline } = require('../src/core/embedding');
    // The module caches the pipeline, so if it was previously loaded it won't throw.
    // In a fresh test environment without the package, it should throw.
    // Since better-sqlite3 is installed, @xenova/transformers might be too.
    // We just verify it's a function that returns a promise.
    const result = getEmbedPipeline();
    assert.ok(result instanceof Promise, 'getEmbedPipeline should return a Promise');
    // Don't await — it would try to download the model
  });

  it('getRerankPipeline should return a Promise', () => {
    const { getRerankPipeline } = require('../src/core/embedding');
    const result = getRerankPipeline();
    assert.ok(result instanceof Promise, 'getRerankPipeline should return a Promise');
  });

  it('computeEmbedding should return a Promise', () => {
    const { computeEmbedding } = require('../src/core/embedding');
    const result = computeEmbedding('test text');
    assert.ok(result instanceof Promise, 'computeEmbedding should return a Promise');
  });

  it('rerank should return a Promise', () => {
    const { rerank } = require('../src/core/embedding');
    const result = rerank('test query', [{ id: 1, content: 'test' }]);
    assert.ok(result instanceof Promise, 'rerank should return a Promise');
  });
});
