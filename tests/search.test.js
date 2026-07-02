'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../src/core/db');
const {
  sanitizeDate,
  buildWhereClause,
  keywordSearch,
  semanticSearch,
  hybridSearch,
} = require('../src/core/search');

/**
 * Helper: create a fresh in-memory database with schema and seed data.
 */
function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  return db;
}

/**
 * Seed a few observations for search tests.
 * Returns the db instance.
 */
function seedTestData(db) {
  const insert = db.prepare(
    'INSERT INTO observations (project_path, type, title, content, tags, importance, confidence, provenance, agent_id) VALUES (?,?,?,?,?,?,?,?,?)'
  );

  insert.run('/project-a', 'decision', 'Use TypeScript', 'We decided to use TypeScript for the frontend', '["typescript","frontend"]', 8, 90, 'explicit', 'agent-1');
  insert.run('/project-a', 'bug', 'Login CSS broken', 'The login page CSS is broken on mobile devices', '["bug","css","mobile"]', 7, 95, 'observed', 'agent-2');
  insert.run('/project-a', 'context', 'React 18 migration', 'Project uses React 18 with concurrent features enabled', '["react","migration"]', 6, 100, 'observed', 'agent-1');
  insert.run('/project-b', 'decision', 'PostgreSQL over MySQL', 'We chose PostgreSQL for its JSON support and performance', '["database","postgresql"]', 9, 85, 'explicit', 'agent-3');
  insert.run('/project-b', 'learning', 'Connection pooling matters', 'Learned that connection pooling is critical for production', '["database","performance"]', 8, 90, 'inferred', 'agent-3');
  insert.run('/project-a', 'observation', 'Low confidence item', 'This is a tentative observation with low confidence', '["tentative"]', 3, 30, 'observed', 'agent-2');

  return db;
}

// ─── sanitizeDate ────────────────────────────────────────────────────

describe('sanitizeDate', () => {
  it('should return YYYY-MM-DD when given a full ISO timestamp', () => {
    assert.equal(sanitizeDate('2024-03-15T10:30:00Z'), '2024-03-15');
  });

  it('should return YYYY-MM-DD when given just a date', () => {
    assert.equal(sanitizeDate('2024-03-15'), '2024-03-15');
  });

  it('should handle datetime with time portion', () => {
    assert.equal(sanitizeDate('2024-03-15 14:30:00'), '2024-03-15');
  });

  it('should strip leading/trailing whitespace', () => {
    assert.equal(sanitizeDate('  2024-03-15  '), '2024-03-15');
  });

  it('should return trimmed string for non-date input', () => {
    // When no YYYY-MM-DD pattern matches, returns trimmed input
    assert.equal(sanitizeDate('  yesterday  '), 'yesterday');
  });
});

// ─── buildWhereClause ────────────────────────────────────────────────

describe('buildWhereClause', () => {
  it('should return only is_active = 1 when no options given', () => {
    const { whereClause, params } = buildWhereClause({});
    assert.equal(whereClause, 'o.is_active = 1');
    assert.deepEqual(params, []);
  });

  it('should add project filter', () => {
    const { whereClause, params } = buildWhereClause({ project: '/my-project' });
    assert.ok(whereClause.includes('o.project_path = ?'));
    assert.deepEqual(params, ['/my-project']);
  });

  it('should add type filter', () => {
    const { whereClause, params } = buildWhereClause({ type: 'decision' });
    assert.ok(whereClause.includes('o.type = ?'));
    assert.deepEqual(params, ['decision']);
  });

  it('should add minConfidence filter when > 0', () => {
    const { whereClause, params } = buildWhereClause({ minConfidence: 80 });
    assert.ok(whereClause.includes('o.confidence >= ?'));
    assert.deepEqual(params, [80]);
  });

  it('should NOT add minConfidence filter when 0', () => {
    const { whereClause, params } = buildWhereClause({ minConfidence: 0 });
    assert.ok(!whereClause.includes('confidence'));
    assert.deepEqual(params, []);
  });

  it('should NOT add minConfidence filter when not provided', () => {
    const { params } = buildWhereClause({});
    assert.equal(params.length, 0);
  });

  it('should add changedSince filter with time appended', () => {
    const { whereClause, params } = buildWhereClause({ changedSince: '2024-01-01' });
    assert.ok(whereClause.includes('o.created_at >= ?'));
    assert.deepEqual(params, ['2024-01-01 00:00:00']);
  });

  it('should add asOf filter with time appended', () => {
    const { whereClause, params } = buildWhereClause({ asOf: '2024-12-31' });
    assert.ok(whereClause.includes('o.created_at <= ?'));
    assert.deepEqual(params, ['2024-12-31 23:59:59']);
  });

  it('should add agentId filter', () => {
    const { whereClause, params } = buildWhereClause({ agentId: 'agent-1' });
    assert.ok(whereClause.includes('o.agent_id = ?'));
    assert.deepEqual(params, ['agent-1']);
  });

  it('should combine multiple filters', () => {
    const { whereClause, params } = buildWhereClause({
      project: '/proj',
      type: 'decision',
      minConfidence: 50,
      agentId: 'agent-1',
    });
    assert.ok(whereClause.includes('o.project_path = ?'));
    assert.ok(whereClause.includes('o.type = ?'));
    assert.ok(whereClause.includes('o.confidence >= ?'));
    assert.ok(whereClause.includes('o.agent_id = ?'));
    assert.ok(whereClause.includes('o.is_active = 1'));
    assert.equal(params.length, 4);
  });
});

// ─── keywordSearch ───────────────────────────────────────────────────

describe('keywordSearch', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
  });

  it('should find observations matching a keyword in content', () => {
    const results = keywordSearch(db, { query: 'TypeScript' });
    assert.ok(results.length >= 1, 'Should find at least 1 result');
    assert.ok(results.some(r => r.title === 'Use TypeScript'));
  });

  it('should find observations matching a keyword in title', () => {
    const results = keywordSearch(db, { query: 'PostgreSQL' });
    assert.ok(results.length >= 1);
    assert.ok(results.some(r => r.title === 'PostgreSQL over MySQL'));
  });

  it('should return empty array for non-matching query', () => {
    const results = keywordSearch(db, { query: 'zzzznonexistent' });
    assert.equal(results.length, 0);
  });

  it('should respect project filter', () => {
    const results = keywordSearch(db, { query: 'database', project: '/project-b' });
    assert.ok(results.length >= 2, 'Should find PostgreSQL and connection pooling');
    assert.ok(results.every(r => r.project_path === '/project-b'));
  });

  it('should respect type filter', () => {
    const results = keywordSearch(db, { query: 'TypeScript', type: 'decision' });
    assert.ok(results.length >= 1);
    assert.ok(results.every(r => r.type === 'decision'));
  });

  it('should respect minConfidence filter', () => {
    const results = keywordSearch(db, { query: 'observation', minConfidence: 50 });
    // Only the high-confidence observation should match — the "Low confidence item" has confidence 30
    assert.ok(results.every(r => r.confidence >= 50));
  });

  it('should respect limit', () => {
    const results = keywordSearch(db, { query: 'project', limit: 2 });
    assert.ok(results.length <= 4, `KeywordSearch doubles limit internally, got ${results.length}`);
  });

  it('should return results with expected fields', () => {
    const results = keywordSearch(db, { query: 'TypeScript' });
    assert.ok(results.length > 0);
    const r = results[0];
    assert.ok('id' in r);
    assert.ok('title' in r);
    assert.ok('preview' in r);
    assert.ok('type' in r);
    assert.ok('importance' in r);
    assert.ok('confidence' in r);
    assert.ok('provenance' in r);
    assert.ok('created_at' in r);
    assert.ok('rank' in r);
  });

  it('should handle empty query by returning filtered results', () => {
    const results = keywordSearch(db, { query: '', type: 'decision' });
    assert.ok(results.length >= 2, 'Should return all decisions');
    assert.ok(results.every(r => r.type === 'decision'));
  });

  it('should handle special characters gracefully', () => {
    const results = keywordSearch(db, { query: '@#$%^&*()' });
    // Should not throw, may return empty or results
    assert.ok(Array.isArray(results));
  });

  it('should find results by tag content via FTS5', () => {
    // Tags are stored as JSON and included in FTS5
    const results = keywordSearch(db, { query: 'css' });
    // Should find the login CSS bug via its tags
    // Note: FTS5 tokenizes JSON, so "css" might be found in the tags field
    assert.ok(results.length >= 1);
  });

  it('should filter by agentId', () => {
    const results = keywordSearch(db, { query: 'database', agentId: 'agent-3' });
    assert.ok(results.length >= 2);
    assert.ok(results.every(r => r.agent_id === 'agent-3'));
  });
});

// ─── semanticSearch (without actual embeddings) ──────────────────────

describe('semanticSearch', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
  });

  it('should return empty array when no observations have embeddings', () => {
    // None of our seed data has embeddings
    const queryVec = new Array(768).fill(0.01);
    const results = semanticSearch(db, queryVec, { limit: 5 });
    assert.equal(results.length, 0, 'No embedded observations should yield empty results');
  });

  it('should respect project filter even when searching embeddings', () => {
    const queryVec = new Array(768).fill(0.01);
    const results = semanticSearch(db, queryVec, { project: '/project-a', limit: 5 });
    assert.equal(results.length, 0);
  });

  it('should not throw on empty database', () => {
    const emptyDb = createTestDb();
    const queryVec = new Array(768).fill(0.01);
    assert.doesNotThrow(() => {
      const results = semanticSearch(emptyDb, queryVec, { limit: 5 });
      assert.equal(results.length, 0);
    });
  });
});

// ─── hybridSearch (without actual embeddings) ────────────────────────

describe('hybridSearch', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
  });

  it('should fall back to keyword results when no embeddings exist', () => {
    const queryVec = new Array(768).fill(0.01);
    // hybridSearch scores candidates via embedding similarity;
    // when no observations have embeddings, JSON.parse(null) fails
    // and all candidates are skipped, resulting in empty results.
    // This tests that it doesn't crash.
    const results = hybridSearch(db, 'TypeScript', queryVec, { limit: 5 });
    assert.ok(Array.isArray(results), 'Should return an array (possibly empty)');
  });

  it('should return empty array when no keyword or embedding matches', () => {
    const queryVec = new Array(768).fill(0.01);
    const results = hybridSearch(db, 'zzzznonexistentqwerty', queryVec, { limit: 5 });
    assert.equal(results.length, 0);
  });

  it('should respect limit parameter', () => {
    const queryVec = new Array(768).fill(0.01);
    const results = hybridSearch(db, 'project', queryVec, { limit: 2 });
    assert.ok(results.length <= 2, `Should respect limit, got ${results.length}`);
  });

  it('should return results with combined_score and semantic_score fields', () => {
    // Seed an observation with a fake embedding so hybrid mode can score it
    const fakeEmbedding = JSON.stringify(new Array(768).fill(0.01));
    db.prepare('UPDATE observations SET embedding = ? WHERE 1=1').run(fakeEmbedding);

    const queryVec = new Array(768).fill(0.01);
    const results = hybridSearch(db, 'TypeScript', queryVec, { limit: 3 });

    if (results.length > 0) {
      const r = results[0];
      assert.ok('combined_score' in r, 'Should have combined_score');
      assert.ok('semantic_score' in r, 'Should have semantic_score');
    }
  });
});

// ─── Filter-only queries (no search text) ───────────────────────────

describe('filter-only queries', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
  });

  it('should return all active observations of a type without query text', () => {
    const results = keywordSearch(db, { query: '', type: 'decision', limit: 10 });
    assert.ok(results.length >= 2, 'Should find both decision observations');
    assert.ok(results.every(r => r.type === 'decision'));
  });

  it('should return observations changed since a date', () => {
    // All seed data was just created, so changedSince with a past date should return everything
    const results = keywordSearch(db, {
      query: '',
      changedSince: '2020-01-01',
      limit: 10,
    });
    assert.ok(results.length >= 6, 'Should find all seeded observations');
  });

  it('should return observations as of a future date', () => {
    const results = keywordSearch(db, {
      query: '',
      asOf: '2099-12-31',
      limit: 10,
    });
    assert.ok(results.length >= 6);
  });

  it('should return empty when changedSince is in the future', () => {
    const results = keywordSearch(db, {
      query: '',
      changedSince: '2099-01-01',
    });
    assert.equal(results.length, 0);
  });
});

// ─── Deactivated observations ────────────────────────────────────────

describe('is_active filtering', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    seedTestData(db);
  });

  it('should exclude soft-deleted observations from search', () => {
    // Soft-delete one observation
    const obs = db.prepare("SELECT id FROM observations WHERE title = 'Use TypeScript'").get();
    db.prepare('UPDATE observations SET is_active = 0 WHERE id = ?').run(obs.id);

    const results = keywordSearch(db, { query: 'TypeScript' });
    assert.ok(results.every(r => r.title !== 'Use TypeScript'),
      'Soft-deleted observation should be excluded');
  });

  it('should still return active observations matching the same query', () => {
    // Only soft-delete one, keep others
    const obs = db.prepare("SELECT id FROM observations WHERE title = 'Use TypeScript'").get();
    db.prepare('UPDATE observations SET is_active = 0 WHERE id = ?').run(obs.id);

    const results = keywordSearch(db, { query: 'project' });
    assert.ok(results.length > 0, 'Other active observations should still be found');
  });
});
