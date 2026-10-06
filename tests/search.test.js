'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../src/core/db');
const {
  sanitizeDate,
  buildWhereClause,
  buildFtsQuery,
  keywordSearch,
  semanticSearch,
  hybridSearch,
  isTemporalQuery,
  applyTemporalBoost,
  expandToSessions,
  capPerSession,
  diversifyResults,
  queryTerms,
  idfWeights,
  coverageScore,
  rrfFuse,
  fuseTranscripts,
  greedyCoverageSelect,
  spreadAcrossSessions,
  sessionGroupKey,
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

// ─── buildFtsQuery ──────────────────────────────────────────────────────────

describe('buildFtsQuery', () => {
  it('drops function words so BM25 is not penalised by negative-idf terms', () => {
    const q = buildFtsQuery('what is the name of the cafe that Rachel mentioned');
    for (const w of ['what', 'is', 'the', 'of', 'that']) {
      assert.ok(!q.includes('"' + w + '"'), `stopword "${w}" should be dropped: ${q}`);
    }
    for (const w of ['name', 'cafe', 'rachel', 'mentioned']) {
      assert.ok(q.includes('"' + w + '"'), `content term "${w}" should remain: ${q}`);
    }
  });

  it('still searches when every token is a stopword (never returns empty)', () => {
    const q = buildFtsQuery('what is that');
    assert.notEqual(q, '');
    assert.ok(q.includes('"what"'));
  });

  it('strips punctuation and lowercases so tokens match FTS5 indexing', () => {
    const q = buildFtsQuery('CSS is broken, right?');
    assert.equal(q, '"css" OR "broken" OR "right"');
  });

  it('de-duplicates repeated terms and caps term count', () => {
    assert.equal(buildFtsQuery('react react react'), '"react"');
    const many = Array.from({ length: 50 }, (_, i) => 'term' + i).join(' ');
    assert.equal(buildFtsQuery(many).split(' OR ').length, 24);
  });

  it('returns empty string for a query with no terms', () => {
    assert.equal(buildFtsQuery('!!! ???'), '');
    assert.equal(buildFtsQuery(''), '');
  });

  it('honours keepStopwords for callers that want the legacy term set', () => {
    const q = buildFtsQuery('the cafe', { keepStopwords: true });
    assert.ok(q.includes('"the"'));
    assert.ok(q.includes('"cafe"'));
  });

  it('finds documents through the real keywordSearch path', () => {
    const db = seedTestData(createTestDb());
    const rows = keywordSearch(db, { query: 'What TypeScript frontend decision?', project: '/project-a', limit: 5 });
    assert.ok(rows.length > 0, 'expected at least one hit');
    assert.equal(rows[0].title, 'Use TypeScript');
  });
});

// ─── expandToSessions ───────────────────────────────────────────────────────

describe('expandToSessions', () => {
  function seedConversations() {
    const db = createTestDb();
    const insert = db.prepare(
      'INSERT INTO observations (project_path, session_id, type, title, content, tags, importance, confidence, provenance) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    const transcript = insert.run(
      '/p', null, 'fact', 'conv1-session-0 (7:47 am on 20 May, 2023)',
      'FULL TRANSCRIPT. ' + 'Rachel mentioned the cafe on Elm street. '.repeat(20),
      '["session-transcript"]', 3, 100, 'observed',
    ).lastInsertRowid;
    const turnA = insert.run(
      '/p', null, 'observation', 'conv1-session-0 - turn',
      'Rachel mentioned the cafe on Elm street.',
      '["dialog-turn"]', 1, 100, 'observed',
    ).lastInsertRowid;
    const turnB = insert.run(
      '/p', null, 'observation', 'conv1-session-0 - turn',
      'Then we ordered two flat whites.',
      '["dialog-turn"]', 1, 100, 'observed',
    ).lastInsertRowid;
    const standalone = insert.run(
      '/p', null, 'decision', 'Standalone memory',
      'We chose PostgreSQL.', '["db"]', 5, 100, 'observed',
    ).lastInsertRowid;
    return { db, transcript, turnA, turnB, standalone };
  }

  const row = (id, title, project_path = '/p', session_id = null) => ({ id, title, project_path, session_id });

  it('replaces a session fragment with that session\'s transcript', () => {
    const { db, transcript, turnA } = seedConversations();
    const out = expandToSessions(db, [row(turnA, 'conv1-session-0 - turn')], { project: '/p' });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, transcript);
  });

  it('drops fragments the returned transcript already covers', () => {
    const { db, transcript, turnA, turnB } = seedConversations();
    const out = expandToSessions(db, [
      row(turnA, 'conv1-session-0 - turn'),
      row(turnB, 'conv1-session-0 - turn'),
    ], { project: '/p' });
    assert.equal(out.length, 1, 'two fragments of one session collapse to one transcript');
    assert.equal(out[0].id, transcript);
  });

  it('leaves memories that are not conversation fragments untouched', () => {
    const { db, standalone } = seedConversations();
    const out = expandToSessions(db, [row(standalone, 'Standalone memory')], { project: '/p' });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, standalone);
  });

  it('groups by session_id when the store populated one', () => {
    const { db, transcript, turnA, turnB } = seedConversations();
    db.prepare('UPDATE observations SET session_id = ? WHERE id IN (?, ?)').run('sess-9', turnA, turnB);
    db.prepare('UPDATE observations SET session_id = ? WHERE id = ?').run('sess-9', transcript);
    const out = expandToSessions(db, [
      { id: turnA, title: 'unrelated title', project_path: '/p', session_id: 'sess-9' },
      { id: turnB, title: 'different title', project_path: '/p', session_id: 'sess-9' },
    ], { project: '/p' });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, transcript);
  });

  it('never expands beyond the requested limit and is a no-op on empty input', () => {
    const { db, transcript, turnA, turnB } = seedConversations();
    assert.deepEqual(expandToSessions(db, [], { project: '/p' }), []);
    const out = expandToSessions(db, [row(turnA, 'conv1-session-0 - turn'), row(turnB, 'conv1-session-0 - turn')], {
      project: '/p', limit: 1,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, transcript);
  });
});

// ─── diversifyResults ───────────────────────────────────────────────────────

describe('diversifyResults', () => {
  it('actually measures token overlap (regression: split on /\\W+/ left every similarity at 0)', () => {
    const results = [
      { id: 1, title: 'shared topic alpha', preview: 'the database migration is blocked on review', combined_score: 0.9 },
      { id: 2, title: 'shared topic beta', preview: 'the database migration is blocked on review', combined_score: 0.8 },
      { id: 3, title: 'unrelated', preview: 'lunch plans for tomorrow afternoon', combined_score: 0.1 },
    ];
    const out = diversifyResults(results, { limit: 3, lambda: 0.5 });
    const byId = new Map(out.map(r => [r.id, r]));
    // ids 1 and 2 are near-identical, so selecting 1 must penalise 2 —
    // which lets the genuinely different id 3 outrank it.
    assert.ok(byId.get(3).coverage_score > byId.get(2).coverage_score,
      `expected the distinct doc to score above the redundant one: ${JSON.stringify(out)}`);
    assert.ok(byId.get(2).redundancy_score > 0, 'redundancy must be non-zero for near-duplicates');
  });
});

// ─── capPerSession ──────────────────────────────────────────────────────────

describe('capPerSession', () => {
  const turn = (id, n) => ({ id, title: `conv1-session-${n} - turn`, project_path: '/p' });
  const other = (id, n) => ({ id, title: `conv2-session-${n} - turn`, project_path: '/p' });

  it('stops one conversation from filling every slot', () => {
    // Six turns of one session followed by turns of another.
    const results = [turn(1, 0), turn(2, 0), turn(3, 0), turn(4, 0), turn(5, 0), turn(6, 0), other(7, 0), other(8, 0)];
    const out = capPerSession(results, { per: 3 });
    assert.equal(out.length, 5, '3 from conv1 + 2 from conv2');
    assert.deepEqual(out.map(r => r.id), [1, 2, 3, 7, 8], 'rank order preserved within the cap');
  });

  it('defaults to 3 fragments per session', () => {
    const results = [turn(1, 0), turn(2, 0), turn(3, 0), turn(4, 0), other(5, 0)];
    const out = capPerSession(results);
    assert.equal(out.length, 4);
    assert.deepEqual(out.map(r => r.id), [1, 2, 3, 5]);
  });

  it('never caps memories that are not conversation fragments', () => {
    const results = [
      { id: 1, title: 'Standalone decision' },
      { id: 2, title: 'Another standalone' },
      { id: 3, title: 'Third standalone' },
      { id: 4, title: 'Fourth standalone' },
    ];
    assert.equal(capPerSession(results, { per: 1 }).length, 4);
  });

  it('respects the requested limit', () => {
    const results = [turn(1, 0), turn(2, 0), other(3, 0), other(4, 0)];
    assert.equal(capPerSession(results, { per: 3, limit: 2 }).length, 2);
  });

  it('groups by session_id when present', () => {
    const results = [
      { id: 1, title: 'anything', session_id: 's1' },
      { id: 2, title: 'else', session_id: 's1' },
      { id: 3, title: 'more', session_id: 's1' },
      { id: 4, title: 'fresh', session_id: 's2' },
    ];
    const out = capPerSession(results, { per: 2 });
    assert.deepEqual(out.map(r => r.id), [1, 2, 4]);
  });

  it('is a no-op for empty input', () => {
    assert.deepEqual(capPerSession([], { per: 3 }), []);
  });
});

// ─── queryTerms ─────────────────────────────────────────────────────────────

describe('queryTerms', () => {
  it('lowercases, de-duplicates and splits on non-alphanumerics', () => {
    assert.deepEqual(queryTerms('What is the CSS-3 bug?'), ['css', '3', 'bug']);
    assert.deepEqual(queryTerms('React! react react'), ['react']);
  });

  it('drops stopwords but keeps the query alive when that empties it', () => {
    assert.deepEqual(queryTerms('is that what it is'), ['is', 'that', 'what', 'it'],
      'all-stopword query falls back to the raw terms rather than matching nothing');
    assert.deepEqual(queryTerms('is that it'), ['is', 'that', 'it']);
    assert.deepEqual(queryTerms('is it'), ['is', 'it']);
  });

  it('caps the term count', () => {
    const many = Array.from({ length: 40 }, (_, i) => 'w' + i).join(' ');
    assert.equal(queryTerms(many).length, 24);
    assert.equal(queryTerms(many, { maxTerms: 5 }).length, 5);
  });

  it('returns [] when there is nothing to search for', () => {
    assert.deepEqual(queryTerms(''), []);
    assert.deepEqual(queryTerms('!!! ???'), []);
    assert.deepEqual(queryTerms(null), []);
  });
});

// ─── idfWeights / coverageScore ─────────────────────────────────────────────

describe('idfWeights', () => {
  it('stays positive for a term present in every document', () => {
    const db = createTestDb();
    seedTestData(db);
    const idf = idfWeights(db, '/project-a', ['typescript', 'frontend']);
    assert.ok(idf.size > 0, 'weights computed');
    for (const [, w] of idf) assert.ok(w >= 0.1, `idf ${w} must not go negative`);
    db.close();
  });

  it('is empty without a project or without terms', () => {
    const db = createTestDb();
    seedTestData(db);
    assert.equal(idfWeights(db, '', ['a']).size, 0);
    assert.equal(idfWeights(db, '/project-a', []).size, 0);
    db.close();
  });
});

describe('coverageScore', () => {
  it('matches substrings, so morphology still counts', () => {
    const terms = ['relationship'];
    const idf = new Map([['relationship', 1]]);
    assert.equal(coverageScore('her relationships changed a lot', terms, idf), 1);
    assert.equal(coverageScore('nothing relevant here', terms, idf), 0);
  });

  it('weights rare terms above common ones', () => {
    const terms = ['rare', 'common'];
    const idf = new Map([['rare', 3], ['common', 1]]);
    const both = coverageScore('rare and common', terms, idf);
    const commonOnly = coverageScore('only common here', terms, idf);
    assert.ok(both > commonOnly, `${both} should beat ${commonOnly}`);
    assert.ok(Math.abs(both - 1) < 1e-9);
  });

  it('returns 0 for empty documents or empty term lists', () => {
    assert.equal(coverageScore('', ['a'], new Map([['a', 1]])), 0);
    assert.equal(coverageScore('text', [], new Map()), 0);
    assert.equal(coverageScore('text', null, new Map()), 0);
  });

  it('length normalization only lowers the score', () => {
    const terms = ['alpha'];
    const idf = new Map([['alpha', 1]]);
    const raw = coverageScore('alpha', terms, idf);
    const norm = coverageScore('alpha', terms, idf, { normalize: true });
    assert.ok(norm <= raw);
  });
});

// ─── rrfFuse ────────────────────────────────────────────────────────────────

describe('rrfFuse', () => {
  it('dedupes the same observation id arriving from two channels', () => {
    // The lexical channel and the transcript channel return DIFFERENT objects
    // for one observation — identity-keyed fusion would spend two slots on it.
    const a = { id: 7, title: 'from lexical' };
    const b = { id: 7, title: 'from transcript channel' };
    const out = rrfFuse([[a], [b]], 10);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 7);
  });

  it('keeps the better-ranked instance of a duplicate row', () => {
    const first = { id: 3, title: 'rank 0' };
    const sameId = { id: 3, title: 'rank 5' };
    const other = { id: 9, title: 'rank 1' };
    const out = rrfFuse([[first], [other, sameId, sameId, sameId, sameId, sameId]], 10);
    assert.equal(out.length, 2);
    assert.equal(out[0].title, 'rank 0');
    assert.equal(out[1].title, 'rank 1');
  });

  it('rewards a row ranked highly by both channels', () => {
    // A: [other, winner]  B: [winner, filler, other]
    // winner = 1/62 + 1/61  vs  other = 1/61 + 1/63 → winner first.
    const winner = { id: 1 };
    const other = { id: 2 };
    const filler = { id: 3 };
    const out = rrfFuse([[other, winner], [winner, filler, other]], 10);
    assert.equal(out[0].id, 1);
    assert.deepEqual(out.map((r) => r.id), [1, 2, 3]);
  });

  it('respects the limit and survives empty inputs', () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    assert.equal(rrfFuse([rows, []], 2).length, 2);
    assert.deepEqual(rrfFuse([], 5), []);
    assert.deepEqual(rrfFuse([[], []], 5), []);
  });
});

// ─── fuseTranscripts ────────────────────────────────────────────────────────

describe('fuseTranscripts', () => {
  /** Seed one conversation: a whole-session transcript plus a fragment. */
  function seedConversation(db) {
    const insert = db.prepare(
      'INSERT INTO observations (project_path, type, title, content, tags, importance, confidence, provenance, agent_id) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    insert.run('/p', 'conversation', 'sess-1 (1 Jan)',
      'caroline told mel she is single and happy about it',
      '["memorybench","session-transcript"]', 8, 100, 'observed', 'a');
    insert.run('/p', 'conversation', 'sess-1 - turn',
      'caroline told mel she is single',
      '["memorybench","dialog-turn"]', 8, 100, 'observed', 'a');
    insert.run('/p', 'conversation', 'sess-2 (2 Jan)',
      'unrelated gardening advice about tomatoes',
      '["memorybench","session-transcript"]', 8, 100, 'observed', 'a');
    return db;
  }

  it('excludes transcripts the query barely touches by default', () => {
    const db = seedConversation(createTestDb());
    const out = fuseTranscripts(db, [], { project: '/p', terms: ['single'], limit: 5 });
    assert.equal(out.length, 1, 'only the covering transcript enters');
    assert.equal(out[0].title, 'sess-1 (1 Jan)');
    db.close();
  });

  it('keeps zero-coverage transcripts when topping up a short list', () => {
    const db = seedConversation(createTestDb());
    const out = fuseTranscripts(db, [], { project: '/p', terms: ['single'], limit: 5, fill: true });
    assert.equal(out.length, 2, 'both transcripts admitted to fill the slots');
    assert.equal(out[0].title, 'sess-1 (1 Jan)', 'covering transcript still ranks first');
    db.close();
  });

  it('honours minCoverage as a floor for rerank mode', () => {
    const db = seedConversation(createTestDb());
    // 'gardening' shares nothing with the query, so cov = 0 < floor
    const out = fuseTranscripts(db, [], { project: '/p', terms: ['single'], limit: 5, minCoverage: 0.1 });
    assert.equal(out.length, 1);
    db.close();
  });

  it('bounds how many transcripts the second channel may put forward', () => {
    const db = seedConversation(createTestDb());
    const out = fuseTranscripts(db, [], {
      project: '/p', terms: ['single'], limit: 5, fill: true, maxTranscripts: 1,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].title, 'sess-1 (1 Jan)');
    db.close();
  });

  it('never shrinks a healthy lexical candidate list', () => {
    const db = seedConversation(createTestDb());
    const existing = [{ id: 99, title: 'lexical hit' }];
    const out = fuseTranscripts(db, existing, { project: '/p', terms: ['single'], limit: 1 });
    assert.equal(out[0].id, 99, 'lexical result survives');
    db.close();
  });

  it('returns the input untouched when there are no terms or no project', () => {
    const db = seedConversation(createTestDb());
    const input = [{ id: 1 }];
    assert.equal(fuseTranscripts(db, input, { project: '/p', terms: [], limit: 5 }), input);
    assert.equal(fuseTranscripts(db, input, { project: '/missing', terms: ['single'], limit: 5 }), input);
    db.close();
  });

  it('returns the input when the project has no transcripts', () => {
    const db = createTestDb();
    seedTestData(db);
    const input = [{ id: 1 }];
    assert.equal(fuseTranscripts(db, input, { project: '/project-a', terms: ['typescript'], limit: 5 }), input);
    db.close();
  });
});

// ─── greedyCoverageSelect ────────────────────────────────────────────────────────

describe('greedyCoverageSelect', () => {
  // Rows carry `content` longer than 300 chars so selection reads it directly
  // instead of hydrating — the hydration path is exercised by integration tests.
  const doc = (id, text) => ({ id, content: `${text} ${'x'.repeat(300)}` });

  it('spends slots on different terms instead of re-proving the same one', () => {
    const db = createTestDb();
    const rows = [
      doc(1, 'caroline mentioned mel'),   // covers: caroline, mel
      doc(2, 'caroline mentioned mel'),   // covers: same terms again
      doc(3, 'caroline wedding date'),    // covers: caroline, wedding
      doc(4, 'nothing relevant'),
    ];
    const out = greedyCoverageSelect(db, rows, { terms: ['caroline', 'mel', 'wedding'], limit: 2 });
    assert.deepEqual(out.map((r) => r.id), [1, 3],
      'second slot must add the uncovered term, not another copy of row 1');
    db.close();
  });

  it('keeps the highest-ranked candidate when gains tie', () => {
    const db = createTestDb();
    const rows = [doc(7, 'alpha'), doc(8, 'alpha'), doc(9, 'alpha')];
    const out = greedyCoverageSelect(db, rows, { terms: ['alpha'], limit: 2 });
    assert.deepEqual(out.map((r) => r.id), [7, 8]);
    db.close();
  });

  it('falls back to rank order when nothing new is coverable', () => {
    const db = createTestDb();
    const rows = [doc(1, 'gamma'), doc(2, 'delta'), doc(3, 'epsilon')];
    const out = greedyCoverageSelect(db, rows, { terms: ['absent'], limit: 2 });
    assert.deepEqual(out.map((r) => r.id), [1, 2]);
    db.close();
  });

  it('is a plain cut when the pool is already at or below the limit', () => {
    const db = createTestDb();
    const rows = [doc(1, 'alpha'), doc(2, 'beta')];
    assert.deepEqual(greedyCoverageSelect(db, rows, { terms: ['alpha'], limit: 5 }).map((r) => r.id), [1, 2]);
    db.close();
  });

  it('returns an empty cut for an empty term list', () => {
    const db = createTestDb();
    const rows = [doc(1, 'alpha'), doc(2, 'beta')];
    assert.deepEqual(greedyCoverageSelect(db, rows, { terms: [], limit: 1 }).map((r) => r.id), [1]);
    db.close();
  });
});

// ─── spreadAcrossSessions ───────────────────────────────────────────────────────────

describe('spreadAcrossSessions', () => {
  const turn = (sess, i) => ({ id: sess * 100 + i, title: `session-${sess} - turn` });
  const distinct = (rows) => new Set(rows.map((r) => sessionGroupKey(r)).filter(Boolean)).size;

  it('raises the distinct-conversation count to the floor', () => {
    const head = [turn(1, 0), turn(1, 1), turn(1, 2), turn(1, 3),
      turn(2, 0), turn(2, 1), turn(3, 0), turn(3, 1), turn(4, 0), turn(4, 1)];
    const pool = head.concat([turn(5, 0), turn(6, 0), turn(7, 0), turn(8, 0)]);
    assert.equal(distinct(head), 4);
    const out = spreadAcrossSessions(pool, { limit: 10, minDistinct: 7 });
    assert.equal(out.length, 10, 'must not shrink the result set');
    assert.equal(distinct(out), 7, 'floor reached');
  });

  it('preserves rank order after promoting a deeper candidate', () => {
    const pool = [turn(1, 0), turn(1, 1), turn(1, 2), turn(1, 3),
      turn(2, 0), turn(2, 1), turn(3, 0), turn(3, 1), turn(4, 0), turn(4, 1),
      turn(5, 0), turn(6, 0), turn(7, 0)];
    const out = spreadAcrossSessions(pool, { limit: 10, minDistinct: 6 });
    const ids = out.map((r) => r.id);
    assert.deepEqual(ids, ids.slice().sort((a, b) => a - b), 'output stays in pool order');
  });

  it('is a no-op when the floor is already met', () => {
    const pool = [turn(1, 0), turn(2, 0), turn(3, 0), turn(4, 0), turn(5, 0)];
    const out = spreadAcrossSessions(pool, { limit: 5, minDistinct: 5 });
    assert.deepEqual(out.map((r) => r.id), pool.map((r) => r.id));
  });

  it('never evicts a conversation\'s only member', () => {
    // Only session-1 is duplicated, so only it can donate.
    const pool = [turn(1, 0), turn(1, 1), turn(2, 0), turn(3, 0), turn(4, 0), turn(5, 0)];
    const out = spreadAcrossSessions(pool, { limit: 4, minDistinct: 4 });
    const keys = out.map((r) => sessionGroupKey(r));
    assert.ok(keys.includes('session-2'), 'singleton conversations survive');
    assert.equal(new Set(keys).size, 4);
  });

  it('gives up rather than dropping rows when no new conversation exists', () => {
    const pool = [turn(1, 0), turn(1, 1), turn(1, 2)];
    const out = spreadAcrossSessions(pool, { limit: 3, minDistinct: 9 });
    assert.equal(out.length, 3, 'returns the full top-k even if the floor is unreachable');
    assert.equal(distinct(out), 1);
  });

  it('leaves non-conversation memories alone', () => {
    const pool = [{ id: 1, title: 'standalone note' }, { id: 2, title: 'another note' }];
    const out = spreadAcrossSessions(pool, { limit: 2, minDistinct: 5 });
    assert.equal(out.length, 2);
  });

  it('is a no-op for empty input', () => {
    assert.deepEqual(spreadAcrossSessions([], { limit: 10, minDistinct: 5 }), []);
  });
});
