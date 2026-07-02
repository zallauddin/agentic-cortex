'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../src/core/db');
const { checkConflicts } = require('../src/core/conflict');

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  return db;
}

// ─── checkConflicts ──────────────────────────────────────────────────

describe('checkConflicts', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
  });

  it('should return empty when fewer than 2 embedded observations', () => {
    db.prepare(
      'INSERT INTO observations (project_path, type, title, content, embedding) VALUES (?,?,?,?,?)'
    ).run('/test', 'decision', 'Only one', 'Content', JSON.stringify(new Array(768).fill(0.01)));

    return checkConflicts(db, { project: '/test' }).then(result => {
      assert.equal(result.conflicts.length, 0);
      assert.equal(result.totalFound, 0);
      assert.equal(result.project, '/test');
    });
  });

  it('should detect highly similar observation pairs', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));

    db.prepare(
      'INSERT INTO observations (project_path, type, title, content, embedding, confidence) VALUES (?,?,?,?,?,?)'
    ).run('/test', 'decision', 'Should use Redis', 'We decided to use Redis for caching', vec, 90);

    db.prepare(
      'INSERT INTO observations (project_path, type, title, content, embedding, confidence) VALUES (?,?,?,?,?,?)'
    ).run('/test', 'decision', 'Should use Memcached', 'We decided to use Memcached instead', vec, 85);

    return checkConflicts(db, { project: '/test', limit: 10 }).then(result => {
      assert.ok(result.totalFound >= 1, 'Identical vectors should trigger conflict detection');
      assert.ok(result.conflicts.length >= 1);
      assert.ok(result.conflicts[0].similarity > 0.65);
    });
  });

  it('should not detect conflicts for dissimilar observations', () => {
    // Create two orthogonal vectors
    const vecA = JSON.stringify(new Array(768).fill(0).map((_, i) => i === 0 ? 1 : 0));
    const vecB = JSON.stringify(new Array(768).fill(0).map((_, i) => i === 1 ? 1 : 0));

    db.prepare(
      'INSERT INTO observations (project_path, type, title, content, embedding, confidence) VALUES (?,?,?,?,?,?)'
    ).run('/test', 'decision', 'Orthogonal A', 'First', vecA, 90);

    db.prepare(
      'INSERT INTO observations (project_path, type, title, content, embedding, confidence) VALUES (?,?,?,?,?,?)'
    ).run('/test', 'observation', 'Orthogonal B', 'Second', vecB, 90);

    return checkConflicts(db, { project: '/test', limit: 10 }).then(result => {
      assert.equal(result.totalFound, 0, 'Orthogonal vectors should not conflict');
    });
  });

  it('should filter by project', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));

    db.prepare(
      'INSERT INTO observations (project_path, type, title, content, embedding) VALUES (?,?,?,?,?)'
    ).run('/project-a', 'decision', 'A1', 'Content', vec);
    db.prepare(
      'INSERT INTO observations (project_path, type, title, content, embedding) VALUES (?,?,?,?,?)'
    ).run('/project-a', 'decision', 'A2', 'Content', vec);

    return checkConflicts(db, { project: '/project-b' }).then(result => {
      assert.equal(result.totalFound, 0, 'Different project should have no conflicts');
    });
  });

  it('should exclude inactive observations', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));

    db.prepare(
      'INSERT INTO observations (project_path, type, title, content, embedding, confidence) VALUES (?,?,?,?,?,?)'
    ).run('/test', 'decision', 'Active', 'Active content', vec, 90);

    const r = db.prepare(
      'INSERT INTO observations (project_path, type, title, content, embedding, confidence) VALUES (?,?,?,?,?,?)'
    ).run('/test', 'decision', 'Inactive', 'Inactive content', vec, 90);

    // Soft-delete the second one
    db.prepare('UPDATE observations SET is_active = 0 WHERE id = ?').run(Number(r.lastInsertRowid));

    return checkConflicts(db, { project: '/test' }).then(result => {
      assert.equal(result.totalFound, 0, 'Inactive observation should be excluded');
    });
  });

  it('should respect limit', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));

    // Create 5 highly similar observations (all same vector)
    for (let i = 0; i < 5; i++) {
      db.prepare(
        'INSERT INTO observations (project_path, type, title, content, embedding, confidence) VALUES (?,?,?,?,?,?)'
      ).run('/test', 'observation', 'Obs ' + i, 'Content ' + i, vec, 90);
    }

    return checkConflicts(db, { project: '/test', limit: 2 }).then(result => {
      assert.ok(result.conflicts.length <= 2, 'Should respect limit');
    });
  });

  it('should return conflict pairs with expected shape', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));

    db.prepare(
      'INSERT INTO observations (project_path, type, title, content, embedding, confidence, provenance) VALUES (?,?,?,?,?,?,?)'
    ).run('/test', 'decision', 'Use Redis', 'Redis is the best cache', vec, 90, 'explicit');

    db.prepare(
      'INSERT INTO observations (project_path, type, title, content, embedding, confidence, provenance) VALUES (?,?,?,?,?,?,?)'
    ).run('/test', 'decision', 'Use Memcached', 'Memcached is better', vec, 85, 'observed');

    return checkConflicts(db, { project: '/test', limit: 5 }).then(result => {
      assert.ok(result.conflicts.length >= 1);
      const c = result.conflicts[0];
      assert.ok('a' in c);
      assert.ok('b' in c);
      assert.ok('similarity' in c);
      assert.ok('id' in c.a);
      assert.ok('type' in c.a);
      assert.ok('title' in c.a);
      assert.ok('confidence' in c.a);
      assert.ok('preview' in c.a);
    });
  });

  it('should handle unparseable embeddings gracefully', () => {
    // One with valid embedding, one with invalid
    const goodVec = JSON.stringify(new Array(768).fill(0.01));

    db.prepare(
      'INSERT INTO observations (project_path, type, title, content, embedding) VALUES (?,?,?,?,?)'
    ).run('/test', 'decision', 'Good embedding', 'Content A', goodVec);

    db.prepare(
      'INSERT INTO observations (project_path, type, title, content, embedding) VALUES (?,?,?,?,?)'
    ).run('/test', 'observation', 'Bad embedding', 'Content B', 'not-valid-json');

    return checkConflicts(db, { project: '/test' }).then(result => {
      assert.equal(result.conflicts.length, 0, 'Unparseable embeddings should not produce conflicts');
    });
  });

  it('should handle empty project', () => {
    return checkConflicts(db, { project: '/nonexistent' }).then(result => {
      assert.equal(result.conflicts.length, 0);
      assert.equal(result.totalFound, 0);
    });
  });
});
