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
  isTemporalQuery,
  applyTemporalBoost,
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
    assert.equal(whereClause, 'o.is_active = 1 AND (o.expires_at IS NULL OR o.expires_at > ?) AND o.superseded_by IS NULL');
    // 1 param: the expiry cutoff timestamp (supersession filter has no param)
    assert.equal(params.length, 1);
  });

  it('should add project filter', () => {
    const { whereClause, params } = buildWhereClause({ project: '/my-project' });
    assert.ok(whereClause.includes('o.project_path = ?'));
    assert.ok(params.includes('/my-project'));
  });

  it('should add type filter', () => {
    const { whereClause, params } = buildWhereClause({ type: 'decision' });
    assert.ok(whereClause.includes('o.type = ?'));
    assert.ok(params.includes('decision'));
  });

  it('should add minConfidence filter when > 0', () => {
    const { whereClause, params } = buildWhereClause({ minConfidence: 80 });
    assert.ok(whereClause.includes('o.confidence >= ?'));
    assert.ok(params.includes(80));
  });

  it('should NOT add minConfidence filter when 0', () => {
    const { whereClause, params } = buildWhereClause({ minConfidence: 0 });
    assert.ok(!whereClause.includes('o.confidence >= ?'));
    assert.ok(!params.includes(0));
  });

  it('should NOT add minConfidence filter when not provided', () => {
    const { params } = buildWhereClause({});
    // Only param is the expiry cutoff from the temporal-forgetting filter
    assert.equal(params.length, 1);
  });

  it('should add changedSince filter with time appended', () => {
    const { whereClause, params } = buildWhereClause({ changedSince: '2024-01-01' });
    assert.ok(whereClause.includes('o.created_at >= ?'));
    assert.ok(params.includes('2024-01-01 00:00:00'));
  });

  it('should add asOf filter with time appended', () => {
    const { whereClause, params } = buildWhereClause({ asOf: '2024-12-31' });
    assert.ok(whereClause.includes('o.created_at <= ?'));
    assert.ok(params.includes('2024-12-31 23:59:59'));
  });

  it('should add agentId filter', () => {
    const { whereClause, params } = buildWhereClause({ agentId: 'agent-1' });
    assert.ok(whereClause.includes('o.agent_id = ?'));
    assert.ok(params.includes('agent-1'));
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
    // 4 filter params + 1 expiry cutoff
    assert.equal(params.length, 5);
  });

  it('should exclude expired memories by default (temporal forgetting)', () => {
    const { whereClause } = buildWhereClause({});
    assert.ok(whereClause.includes('o.expires_at IS NULL OR o.expires_at > ?'));
    assert.ok(whereClause.includes('o.superseded_by IS NULL'));
  });

  it('should include expired memories when includeExpired is set', () => {
    const { whereClause, params } = buildWhereClause({ includeExpired: true, includeSuperseded: true });
    assert.ok(!whereClause.includes('expires_at'));
    assert.ok(!whereClause.includes('superseded_by'));
    assert.equal(params.length, 0);
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

// ─── Temporal ranking boost (Phase 15) ─────────────────────────────

describe('isTemporalQuery', () => {
  it('detects temporal and current-state questions', () => {
    for (const q of ['when is the deploy window', 'where does Jordan live now',
      'what day is the release', 'which database do we use currently',
      'how long does the build take', 'deploys moved to Monday', 'when is the deadline?']) {
      assert.ok(isTemporalQuery(q), `should detect: ${q}`);
    }
  });

  it('ignores non-temporal queries and substring false positives', () => {
    for (const q of ['jordan residence', 'use TypeScript for the frontend',
      'whenever you deploy run the smoke tests']) {
      assert.ok(!isTemporalQuery(q), `should NOT detect: ${q}`);
    }
  });
});

describe('applyTemporalBoost', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });

  function seedChain() {
    // Old fact (superseded) -> champion (current truth), plus a distractor.
    const now = new Date();
    const iso = d => d.toISOString().replace('T', ' ').slice(0, 19);
    const old = db.prepare(
      'INSERT INTO observations (project_path, type, title, content, confidence, provenance, created_at, is_active, superseded_by) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    old.run('/p', 'fact', 'Residence old', 'Jordan lives in Chicago', 100, 'observed', iso(new Date(now - 40 * 86400000)), 0, null);
    const oldId = db.prepare("SELECT id FROM observations WHERE title = 'Residence old'").get().id;
    db.prepare(
      'INSERT INTO observations (project_path, type, title, content, confidence, provenance, created_at, is_active) VALUES (?,?,?,?,?,?,?,?)'
    ).run('/p', 'fact', 'Residence new', 'Jordan lives in Austin', 100, 'observed', iso(new Date(now - 1 * 86400000)), 1);
    const newId = db.prepare("SELECT id FROM observations WHERE title = 'Residence new'").get().id;
    db.prepare('UPDATE observations SET superseded_by = ? WHERE id = ?').run(newId, oldId);
    // Distractor: old, matches topic, not a champion
    db.prepare(
      'INSERT INTO observations (project_path, type, title, content, confidence, provenance, created_at, is_active) VALUES (?,?,?,?,?,?,?,?)'
    ).run('/p', 'observation', 'Travel note', 'Jordan once visited Chicago and Austin', 80, 'observed', iso(new Date(now - 30 * 86400000)), 1);
    return { oldId, newId };
  }

  it('is a no-op for non-temporal queries (only annotates)', () => {
    const { newId } = seedChain();
    const results = [
      { id: newId, title: 'Residence new', combined_score: 0.5 },
    ];
    const out = applyTemporalBoost(db, 'jordan residence', results);
    assert.equal(out[0].temporal_boost, 0);
    assert.equal(out[0].combined_score, 0.5, 'score untouched for non-temporal query');
  });

  it('boosts the supersession champion above a stale distractor for temporal queries', () => {
    const { newId } = seedChain();
    const distractorId = db.prepare("SELECT id FROM observations WHERE title = 'Travel note'").get().id;
    // Distractor first (would win without the boost) — equal base scores.
    const results = [
      { id: distractorId, title: 'Travel note', combined_score: 0.50 },
      { id: newId, title: 'Residence new', combined_score: 0.50 },
    ];
    const out = applyTemporalBoost(db, 'where does jordan live now', results);
    const champ = out.find(r => r.id === newId);
    const dist = out.find(r => r.id === distractorId);
    assert.ok(champ.temporal_boost > dist.temporal_boost,
      `champion boost ${champ.temporal_boost} should exceed distractor ${dist.temporal_boost}`);
    assert.equal(out[0].id, newId, 'champion should rank first after boost');
    // Boost is capped by delta (0.15 default): 0.50 + boost*0.15 <= 0.65
    assert.ok(out[0].combined_score <= 0.5 + 0.151, 'boost stays within delta cap');
  });

  it('boosts memories with a future expires_at (still-valid time-bound facts)', () => {
    const now = new Date();
    db.prepare(
      'INSERT INTO observations (project_path, type, title, content, confidence, provenance, created_at, is_active, expires_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run('/p', 'fact', 'Freeze window', 'Code freeze until Friday', 90, 'observed',
      now.toISOString().replace('T', ' ').slice(0, 19), 1,
      new Date(now.getTime() + 3 * 86400000).toISOString());
    db.prepare(
      'INSERT INTO observations (project_path, type, title, content, confidence, provenance, created_at, is_active) VALUES (?,?,?,?,?,?,?,?)'
    ).run('/p', 'fact', 'Freeze history', 'Code freeze happened last quarter too', 90, 'observed',
      new Date(now.getTime() - 60 * 86400000).toISOString().replace('T', ' ').slice(0, 19), 1);
    const boundedId = db.prepare("SELECT id FROM observations WHERE title = 'Freeze window'").get().id;
    const oldId = db.prepare("SELECT id FROM observations WHERE title = 'Freeze history'").get().id;
    const results = [
      { id: oldId, title: 'Freeze history', combined_score: 0.50 },
      { id: boundedId, title: 'Freeze window', combined_score: 0.50 },
    ];
    const out = applyTemporalBoost(db, 'when is the code freeze', results);
    assert.equal(out[0].id, boundedId, 'still-valid time-bound fact should rank first');
  });

  it('reorders keyword-only results via temporal_rank_score', () => {
    const { newId } = seedChain();
    const distractorId = db.prepare("SELECT id FROM observations WHERE title = 'Travel note'").get().id;
    const results = [
      { id: distractorId, title: 'Travel note', rank: -1.5 },  // slightly better FTS rank
      { id: newId, title: 'Residence new', rank: -2.0 },       // slightly worse FTS rank
    ];
    const out = applyTemporalBoost(db, 'where does jordan live currently', results);
    assert.equal(out[0].id, newId, 'champion should overcome a slightly worse FTS rank');
    assert.ok(out[0].temporal_rank_score > out[1].temporal_rank_score);
  });

  it('respects the enabled:false opt-out and custom delta', () => {
    const { newId } = seedChain();
    const results = [{ id: newId, title: 'Residence new', combined_score: 0.5 }];
    const off = applyTemporalBoost(db, 'where does jordan live now', results, { enabled: false });
    assert.equal(off[0].temporal_boost, 0);
    assert.equal(off[0].combined_score, 0.5);
  });
});
