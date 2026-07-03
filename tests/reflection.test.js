'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../src/core/db');

// ── Mock LLM ─────────────────────────────────────────────────────────
const sessionModule = require('../src/core/session');
const originalCallLLM = sessionModule.callLLM;
let mockLLMResponse = null;
let llmCallCount = 0;

sessionModule.callLLM = async function () {
  llmCallCount++;
  if (mockLLMResponse instanceof Error) throw mockLLMResponse;
  return mockLLMResponse;
};

// ── Mock embedding.computeEmbedding ───────────────────────────────────
const embeddingModule = require('../src/core/embedding');
const originalComputeEmbedding = embeddingModule.computeEmbedding;
embeddingModule.computeEmbedding = async function (text) {
  // Return a deterministic "embedding" based on text length (not real, just for testing)
  const vec = new Array(8).fill(0);
  for (let i = 0; i < text.length && i < 8; i++) {
    vec[i] = text.charCodeAt(i) / 255;
  }
  return vec;
};

// Load module under test
const reflection = require('../src/core/reflection');

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  return db;
}

// Helper: insert an observation with embedding
function insertObs(db, project, type, title, content, confidence, embedding) {
  const r = db.prepare(
    'INSERT INTO observations (project_path, type, title, content, confidence, embedding) VALUES (?,?,?,?,?,?)'
  ).run(project, type, title, content, confidence || 100, JSON.stringify(embedding || new Array(8).fill(0)));
  return Number(r.lastInsertRowid);
}

// ─── findSimilarClusters ─────────────────────────────────────────────

describe('findSimilarClusters', () => {
  it('should cluster identical observations together', () => {
    const obs = [
      { id: 1, embedding: [1, 0, 0], title: 'A', content: 'A' },
      { id: 2, embedding: [1, 0, 0], title: 'B', content: 'B' },
    ];

    const clusters = reflection.findSimilarClusters(obs);
    assert.equal(clusters.length, 1, 'Identical vectors should form one cluster');
    assert.equal(clusters[0].length, 2);
  });

  it('should separate dissimilar observations', () => {
    const obs = [
      { id: 1, embedding: [1, 0, 0], title: 'A', content: 'A' },
      { id: 2, embedding: [0, 1, 0], title: 'B', content: 'B' },
    ];

    const clusters = reflection.findSimilarClusters(obs);
    assert.equal(clusters.length, 0, 'Orthogonal vectors should not cluster');
  });

  it('should respect threshold', () => {
    // Similar vectors (cos ~0.98)
    const obs = [
      { id: 1, embedding: [1, 0.1, 0], title: 'A', content: 'A' },
      { id: 2, embedding: [1, 0.05, 0], title: 'B', content: 'B' },
    ];

    // Default threshold 0.85 — should cluster
    const clusters = reflection.findSimilarClusters(obs);
    assert.equal(clusters.length, 1);

    // Higher threshold 0.999 — should not cluster (vectors aren't THAT similar)
    const clusters2 = reflection.findSimilarClusters(obs, 0.999);
    assert.equal(clusters2.length, 0);
  });

  it('should handle empty array', () => {
    const clusters = reflection.findSimilarClusters([]);
    assert.deepEqual(clusters, []);
  });

  it('should handle single observation', () => {
    const obs = [{ id: 1, embedding: [1, 2, 3], title: 'A', content: 'A' }];
    const clusters = reflection.findSimilarClusters(obs);
    assert.equal(clusters.length, 0, 'Single observation cannot form a cluster');
  });

  it('should form multiple independent clusters', () => {
    const obs = [
      { id: 1, embedding: [1, 0, 0], title: 'A', content: 'A' },
      { id: 2, embedding: [1, 0, 0], title: 'A2', content: 'A2' }, // Cluster 1
      { id: 3, embedding: [0, 1, 0], title: 'B', content: 'B' },
      { id: 4, embedding: [0, 1, 0], title: 'B2', content: 'B2' }, // Cluster 2
    ];

    const clusters = reflection.findSimilarClusters(obs);
    assert.equal(clusters.length, 2, 'Should form 2 independent clusters');
  });

  it('should not reuse the same observation across clusters', () => {
    const obs = [
      { id: 1, embedding: [1, 0, 0], title: 'A', content: 'A' },
      { id: 2, embedding: [1, 0, 0], title: 'B', content: 'B' },
      { id: 3, embedding: [1, 0, 0], title: 'C', content: 'C' },
    ];

    const clusters = reflection.findSimilarClusters(obs);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].length, 3);
  });
});

// ─── pickCanonical ────────────────────────────────────────────────────

describe('pickCanonical', () => {
  it('should pick highest confidence observation', () => {
    const cluster = [
      { id: 1, confidence: 70, created_at: '2024-01-01' },
      { id: 2, confidence: 90, created_at: '2024-01-01' },
      { id: 3, confidence: 80, created_at: '2024-01-01' },
    ];

    const canonical = reflection.pickCanonical(cluster);
    assert.equal(canonical.id, 2);
  });

  it('should pick most recent when confidence is tied', () => {
    const cluster = [
      { id: 1, confidence: 80, created_at: '2024-01-01T00:00:00Z' },
      { id: 2, confidence: 80, created_at: '2024-06-15T00:00:00Z' },
    ];

    const canonical = reflection.pickCanonical(cluster);
    assert.equal(canonical.id, 2, 'More recent should win on tie');
  });

  it('should handle single-element cluster', () => {
    const cluster = [{ id: 42, confidence: 100, created_at: '2024-01-01' }];
    const canonical = reflection.pickCanonical(cluster);
    assert.equal(canonical.id, 42);
  });
});

// ─── generateConsolidatedSummary ──────────────────────────────────────

describe('generateConsolidatedSummary', () => {
  beforeEach(() => { llmCallCount = 0; mockLLMResponse = null; });

  it('should use LLM to generate summary', async () => {
    mockLLMResponse = JSON.stringify({
      title: 'Consolidated: Redis decision',
      content: 'We decided to use Redis for all caching needs across the application.',
    });

    const cluster = [
      { type: 'decision', title: 'Use Redis', content: 'Redis for cache layer' },
      { type: 'decision', title: 'Redis confirmed', content: 'Redis is the final choice' },
    ];

    const result = await reflection.generateConsolidatedSummary(cluster);
    assert.ok(result.title.includes('Redis'));
    assert.ok(result.content.includes('Redis'));
    assert.equal(llmCallCount, 1);
  });

  it('should fallback to concatenation when LLM fails', async () => {
    mockLLMResponse = new Error('LLM unavailable');

    const cluster = [
      { type: 'observation', title: 'Item 1', content: 'Content one' },
      { type: 'observation', title: 'Item 2', content: 'Content two' },
    ];

    const result = await reflection.generateConsolidatedSummary(cluster);
    assert.ok(result.title, 'Fallback should produce a title');
    assert.ok(result.content.includes('Content one'), 'Fallback should include cluster content');
    assert.ok(result.content.includes('Content two'));
  });

  it('should fallback when LLM returns invalid JSON', async () => {
    mockLLMResponse = 'not json at all';

    const cluster = [
      { type: 'observation', title: 'Test', content: 'Test content' },
    ];

    const result = await reflection.generateConsolidatedSummary(cluster);
    assert.ok(result.title);
  });
});

// ─── consolidateMemories ──────────────────────────────────────────────

describe('consolidateMemories', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    llmCallCount = 0;
    mockLLMResponse = null;
  });

  it('should return empty for DB with fewer than 2 observations', async () => {
    const result = await reflection.consolidateMemories(db, { project: '/test' });
    assert.equal(result.clusters, 0);
    assert.equal(result.merged, 0);
    assert.equal(result.archived, 0);
  });

  it('should return empty for no similar observations', async () => {
    insertObs(db, '/test', 'observation', 'Topic A', 'Content A', 80, [1, 0, 0, 0, 0, 0, 0, 0]);
    insertObs(db, '/test', 'observation', 'Topic B', 'Content B', 80, [0, 1, 0, 0, 0, 0, 0, 0]);

    const result = await reflection.consolidateMemories(db, { project: '/test', threshold: 0.95 });
    assert.equal(result.clusters, 0);
  });

  it('should consolidate similar observations', async () => {
    mockLLMResponse = JSON.stringify({
      title: 'Consolidated: Cache decision',
      content: 'Redis was chosen as the primary cache after evaluating options.',
    });

    // Two identical-content observations (same vector)
    insertObs(db, '/test', 'decision', 'Cache Option A', 'Use Redis for caching', 90, [1, 1, 1, 1, 1, 1, 1, 1]);
    insertObs(db, '/test', 'decision', 'Cache Option B', 'Use Redis for caching', 80, [1, 1, 1, 1, 1, 1, 1, 1]);

    const result = await reflection.consolidateMemories(db, { project: '/test' });

    assert.ok(result.clusters >= 1);
    assert.ok(result.merged >= 1);
    assert.ok(result.archived >= 1);
  });

  it('should not modify DB in dryRun mode', async () => {
    mockLLMResponse = JSON.stringify({
      title: 'Consolidated',
      content: 'Should not be applied.',
    });

    insertObs(db, '/test', 'decision', 'A', 'Content', 80, [1, 1, 1, 1, 1, 1, 1, 1]);
    insertObs(db, '/test', 'decision', 'B', 'Content', 70, [1, 1, 1, 1, 1, 1, 1, 1]);

    const activeBefore = db.prepare('SELECT COUNT(*) as c FROM observations WHERE is_active = 1').get().c;
    await reflection.consolidateMemories(db, { project: '/test', dryRun: true });
    const activeAfter = db.prepare('SELECT COUNT(*) as c FROM observations WHERE is_active = 1').get().c;

    assert.equal(activeBefore, activeAfter, 'Dry run should not modify active observations');
  });
});

// ─── promotePatterns ──────────────────────────────────────────────────

describe('promotePatterns', () => {
  let db;
  let savedItems;

  beforeEach(() => {
    db = createTestDb();
    llmCallCount = 0;
    mockLLMResponse = null;
    savedItems = [];
    reflection.setSaveFunction(async (opts) => {
      savedItems.push(opts);
      return { id: savedItems.length, status: 'saved' };
    });
  });

  afterEach(() => {
    reflection.setSaveFunction(null);
  });

  it('should return empty when fewer than minCount observations', async () => {
    insertObs(db, '/test', 'observation', 'A', 'Content', 80);
    insertObs(db, '/test', 'observation', 'B', 'Content', 80);

    const result = await reflection.promotePatterns(db, { project: '/test', minCount: 3 });
    assert.equal(result.promoted, 0);
    assert.equal(result.patterns.length, 0);
  });

  it('should detect recurring tags', async () => {
    // Insert 3 observations all tagged "bug"
    for (let i = 0; i < 3; i++) {
      const r = db.prepare(
        'INSERT INTO observations (project_path, type, title, content, tags) VALUES (?,?,?,?,?)'
      ).run('/test', 'observation', 'Bug ' + i, 'Bug description ' + i, JSON.stringify(['bug']));
    }

    mockLLMResponse = JSON.stringify({
      title: 'Pattern: bug',
      content: 'Bug appears frequently in the codebase.',
      tags: ['pattern', 'bug', 'tag'],
    });

    const result = await reflection.promotePatterns(db, { project: '/test', minCount: 3 });

    assert.ok(result.patterns.length >= 1);
    const bugPattern = result.patterns.find(p => p.theme === 'bug');
    assert.ok(bugPattern, 'Should detect "bug" tag pattern');
    assert.equal(bugPattern.count, 3);
  });

  it('should detect recurring types', async () => {
    for (let i = 0; i < 5; i++) {
      insertObs(db, '/test', 'error', 'Error ' + i, 'Error details ' + i, 80);
    }

    mockLLMResponse = JSON.stringify({
      title: 'Pattern: error',
      content: 'Many errors observed.',
      tags: ['pattern', 'error', 'type'],
    });

    const result = await reflection.promotePatterns(db, { project: '/test', minCount: 3 });

    const errorPattern = result.patterns.find(p => p.theme === 'error' && p.type === 'type');
    assert.ok(errorPattern);
    assert.equal(errorPattern.count, 5);
  });

  it('should promote pattern into a learning observation', async () => {
    for (let i = 0; i < 4; i++) {
      const r = db.prepare(
        'INSERT INTO observations (project_path, type, title, content, tags) VALUES (?,?,?,?,?)'
      ).run('/test', 'observation', 'Item ' + i, 'Content ' + i, JSON.stringify(['cache']));
    }

    mockLLMResponse = JSON.stringify({
      title: 'Pattern: cache',
      content: 'Cache-related decisions appear frequently.',
      tags: ['pattern', 'cache', 'tag'],
    });

    await reflection.promotePatterns(db, { project: '/test', minCount: 3 });

    assert.ok(savedItems.length >= 1, 'Should save at least one promoted pattern');
    assert.equal(savedItems[0].type, 'learning');
    assert.ok(savedItems[0].title.includes('cache'));
  });

  it('should not promote patterns without a save function', async () => {
    reflection.setSaveFunction(null);

    for (let i = 0; i < 3; i++) {
      db.prepare(
        'INSERT INTO observations (project_path, type, title, content, tags) VALUES (?,?,?,?,?)'
      ).run('/test', 'observation', 'Item ' + i, 'Content ' + i, JSON.stringify(['theme']));
    }

    mockLLMResponse = JSON.stringify({
      title: 'Pattern: theme',
      content: 'Pattern content',
      tags: ['pattern', 'theme'],
    });

    await reflection.promotePatterns(db, { project: '/test', minCount: 3 });
    assert.equal(savedItems.length, 0, 'Should not save without save function');
  });

  it('should handle LLM errors when generating pattern summary', async () => {
    for (let i = 0; i < 3; i++) {
      db.prepare(
        'INSERT INTO observations (project_path, type, title, content, tags) VALUES (?,?,?,?,?)'
      ).run('/test', 'observation', 'Item ' + i, 'Content ' + i, JSON.stringify(['test-theme']));
    }

    mockLLMResponse = new Error('LLM error');

    const result = await reflection.promotePatterns(db, { project: '/test', minCount: 3 });
    assert.ok(result.patterns.length >= 1);
    assert.ok(result.promoted >= 1, 'Should still promote with fallback summary');
  });
});

// ─── archiveSuperseded ────────────────────────────────────────────────

describe('archiveSuperseded', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should return empty when no superseded relations exist', async () => {
    const result = await reflection.archiveSuperseded(db, { project: '/test' });
    assert.equal(result.candidates, 0);
    assert.equal(result.archived, 0);
  });

  it('should archive observations with supersedes relations', async () => {
    const idA = insertObs(db, '/test', 'decision', 'Old decision', 'Old content', 70);
    const idB = insertObs(db, '/test', 'decision', 'New decision', 'New content', 95);

    // Create supersedes relation: B supersedes A
    db.prepare(
      'INSERT INTO memory_relations (source_id, target_id, relation_type, confidence) VALUES (?,?,?,?)'
    ).run(idB, idA, 'supersedes', 90);

    // Update A's created_at to be old (30+ days ago)
    db.prepare("UPDATE observations SET created_at = datetime('now', '-60 days') WHERE id = ?").run(idA);

    const result = await reflection.archiveSuperseded(db, { project: '/test' });
    assert.equal(result.candidates, 1);
    assert.equal(result.archived, 1);

    const archived = db.prepare('SELECT is_active FROM observations WHERE id = ?').get(idA);
    assert.equal(archived.is_active, 0);
  });

  it('should not archive recent observations', async () => {
    const idA = insertObs(db, '/test', 'decision', 'Old', 'Content', 70);
    const idB = insertObs(db, '/test', 'decision', 'New', 'Content', 95);

    db.prepare(
      'INSERT INTO memory_relations (source_id, target_id, relation_type, confidence) VALUES (?,?,?,?)'
    ).run(idB, idA, 'supersedes', 90);

    // A was created today — should not be archived
    const result = await reflection.archiveSuperseded(db, { project: '/test', maxAgeDays: 30 });
    assert.equal(result.candidates, 0, 'Recent observation should not be candidate for archive');
  });

  it('should respect dryRun mode', async () => {
    const idA = insertObs(db, '/test', 'decision', 'Old', 'Content', 70);
    const idB = insertObs(db, '/test', 'decision', 'New', 'Content', 95);

    db.prepare(
      'INSERT INTO memory_relations (source_id, target_id, relation_type, confidence) VALUES (?,?,?,?)'
    ).run(idB, idA, 'supersedes', 90);

    db.prepare("UPDATE observations SET created_at = datetime('now', '-60 days') WHERE id = ?").run(idA);

    const result = await reflection.archiveSuperseded(db, { project: '/test', dryRun: true });
    assert.ok(result.candidates >= 1);
    assert.equal(result.archived, 0, 'Dry run should not actually archive');

    const obs = db.prepare('SELECT is_active FROM observations WHERE id = ?').get(idA);
    assert.equal(obs.is_active, 1, 'Observation should still be active after dry run');
  });
});

// ─── reflect (combined) ───────────────────────────────────────────────

describe('reflect', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    llmCallCount = 0;
    mockLLMResponse = null;
  });

  it('should return results for all three operations', async () => {
    const result = await reflection.reflect(db, { project: '/test', dryRun: true });

    assert.ok('consolidate' in result);
    assert.ok('promote' in result);
    assert.ok('archive' in result);
    assert.equal(result.consolidate.dryRun, true);
    assert.equal(result.promote.dryRun, true);
    assert.equal(result.archive.dryRun, true);
    assert.equal(result.consolidate.clusters, 0);
    assert.equal(result.archive.candidates, 0);
  });

  it('should propagate project to all sub-operations', async () => {
    const result = await reflection.reflect(db, { project: '/special-project', dryRun: true });
    // All operations should return without error
    assert.equal(result.consolidate.clusters, 0);
    assert.equal(result.archive.candidates, 0);
  });
});

// ─── getEmbeddedObservations ──────────────────────────────────────────

describe('getEmbeddedObservations', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should return observations with parsed embeddings', () => {
    insertObs(db, '/test', 'observation', 'Test', 'Content', 80, [0.1, 0.2, 0.3]);

    const result = reflection.getEmbeddedObservations(db, '/test', 10);
    assert.equal(result.length, 1);
    assert.ok(Array.isArray(result[0].embedding));
    assert.equal(result[0].embedding.length, 3);
    assert.ok('preview' in result[0]);
  });

  it('should filter by project', () => {
    insertObs(db, '/project-a', 'observation', 'A', 'Content', 80, [1, 0]);
    insertObs(db, '/project-b', 'observation', 'B', 'Content', 80, [0, 1]);

    const result = reflection.getEmbeddedObservations(db, '/project-a', 10);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'A');
  });

  it('should exclude inactive observations', () => {
    const id = insertObs(db, '/test', 'observation', 'Active', 'Content', 80, [1, 0]);
    insertObs(db, '/test', 'observation', 'Inactive', 'Content', 80, [0, 1]);
    db.prepare('UPDATE observations SET is_active = 0 WHERE title = ?').run('Inactive');

    const result = reflection.getEmbeddedObservations(db, '/test', 10);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Active');
  });

  it('should exclude observations without embeddings', () => {
    const r = db.prepare(
      'INSERT INTO observations (project_path, type, title, content) VALUES (?,?,?,?)'
    ).run('/test', 'observation', 'No embed', 'Content');

    const result = reflection.getEmbeddedObservations(db, '/test', 10);
    assert.equal(result.length, 0, 'Observations without embeddings should be excluded');
  });
});

// ─── Module Exports ───────────────────────────────────────────────────

describe('module exports', () => {
  it('should export all expected functions', () => {
    assert.equal(typeof reflection.consolidateMemories, 'function');
    assert.equal(typeof reflection.promotePatterns, 'function');
    assert.equal(typeof reflection.archiveSuperseded, 'function');
    assert.equal(typeof reflection.reflect, 'function');
    assert.equal(typeof reflection.findSimilarClusters, 'function');
    assert.equal(typeof reflection.pickCanonical, 'function');
    assert.equal(typeof reflection.generateConsolidatedSummary, 'function');
    assert.equal(typeof reflection.getEmbeddedObservations, 'function');
    assert.equal(typeof reflection.setSaveFunction, 'function');
  });

  it('should export default constants', () => {
    assert.ok(reflection.DEFAULT_CONSOLIDATE_THRESHOLD > 0);
    assert.ok(reflection.DEFAULT_PATTERN_MIN_COUNT > 0);
    assert.ok(reflection.DEFAULT_ARCHIVE_AGE_DAYS > 0);
  });
});


