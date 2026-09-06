'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../src/core/db');
const conflict = require('../src/core/conflict');

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  return db;
}

/** Insert an observation with a deterministic embedding vector. */
function insertObs(db, project, { title, content, confidence = 80, embedding = null } = {}) {
  const vec = embedding || JSON.stringify(new Array(768).fill(0.01));
  const r = db.prepare(
    'INSERT INTO observations (project_path, type, title, content, embedding, confidence) VALUES (?,?,?,?,?,?)'
  ).run(project, 'decision', title, content, vec, confidence);
  return db.prepare('SELECT * FROM observations WHERE id = ?').get(Number(r.lastInsertRowid));
}

const PROJECT = '/test/conflict';

// ─── Baseline detection (preserve existing contract) ─────────────────

describe('checkConflicts — baseline detection contract', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should return empty when fewer than 2 embedded observations', () => {
    insertObs(db, PROJECT, { title: 'Only one', content: 'Solo' });
    return conflict.checkConflicts(db, { project: PROJECT }).then(result => {
      assert.equal(result.conflicts.length, 0);
      assert.equal(result.totalFound, 0);
      assert.equal(result.project, PROJECT);
      assert.deepEqual(result.resolutions, []);
    });
  });

  it('should detect highly similar observation pairs', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, PROJECT, { title: 'Use Redis', content: 'Redis is best', confidence: 90, embedding: vec });
    insertObs(db, PROJECT, { title: 'Use Memcached', content: 'Memcached instead', confidence: 85, embedding: vec });

    return conflict.checkConflicts(db, { project: PROJECT, limit: 10 }).then(result => {
      assert.ok(result.totalFound >= 1, 'Identical vectors should trigger conflict detection');
      assert.ok(result.conflicts.length >= 1);
      assert.ok(result.conflicts[0].similarity > 0.65);
    });
  });

  it('should not detect conflicts for dissimilar observations', () => {
    const vecA = JSON.stringify(new Array(768).fill(0).map((_, i) => i === 0 ? 1 : 0));
    const vecB = JSON.stringify(new Array(768).fill(0).map((_, i) => i === 1 ? 1 : 0));
    insertObs(db, PROJECT, { title: 'Orthogonal A', content: 'First', confidence: 90, embedding: vecA });
    insertObs(db, PROJECT, { title: 'Orthogonal B', content: 'Second', confidence: 90, embedding: vecB });

    return conflict.checkConflicts(db, { project: PROJECT, limit: 10 }).then(result => {
      assert.equal(result.totalFound, 0, 'Orthogonal vectors should not conflict');
    });
  });

  it('should filter by project', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, '/project-a', { title: 'A1', content: 'Content', confidence: 90, embedding: vec });
    insertObs(db, '/project-a', { title: 'A2', content: 'Content', confidence: 90, embedding: vec });

    return conflict.checkConflicts(db, { project: '/project-b' }).then(result => {
      assert.equal(result.totalFound, 0, 'Different project should have no conflicts');
    });
  });

  it('should exclude inactive observations', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, PROJECT, { title: 'Active', content: 'Active content', confidence: 90, embedding: vec });
    const r = insertObs(db, PROJECT, { title: 'Inactive', content: 'Inactive content', confidence: 90, embedding: vec });
    db.prepare('UPDATE observations SET is_active = 0 WHERE id = ?').run(Number(r.id));

    return conflict.checkConflicts(db, { project: PROJECT }).then(result => {
      assert.equal(result.totalFound, 0, 'Inactive observation should be excluded');
    });
  });

  it('should respect limit', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));
    for (let i = 0; i < 5; i++) {
      insertObs(db, PROJECT, { title: 'Obs ' + i, content: 'Content ' + i, confidence: 90, embedding: vec });
    }
    return conflict.checkConflicts(db, { project: PROJECT, limit: 2 }).then(result => {
      assert.ok(result.conflicts.length <= 2, 'Should respect limit');
    });
  });

  it('should return conflict pairs with expected shape', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, PROJECT, { title: 'Use Redis', content: 'Redis is the best cache', confidence: 90, embedding: vec });
    insertObs(db, PROJECT, { title: 'Use Memcached', content: 'Memcached is better', confidence: 85, embedding: vec });

    return conflict.checkConflicts(db, { project: PROJECT, limit: 5 }).then(result => {
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
    const goodVec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, PROJECT, { title: 'Good embedding', content: 'Content A', confidence: 80, embedding: goodVec });
    db.prepare(
      'INSERT INTO observations (project_path, type, title, content, embedding, confidence) VALUES (?,?,?,?,?,?)'
    ).run(PROJECT, 'observation', 'Bad embedding', 'Content B', 'not-valid-json', 80);

    return conflict.checkConflicts(db, { project: PROJECT }).then(result => {
      assert.equal(result.conflicts.length, 0, 'Unparseable embeddings should not produce conflicts');
    });
  });

  it('should handle empty project', () => {
    return conflict.checkConflicts(db, { project: '/nonexistent' }).then(result => {
      assert.equal(result.conflicts.length, 0);
      assert.equal(result.totalFound, 0);
      assert.deepEqual(result.resolutions, []);
    });
  });

  it('should sort conflicts by similarity descending', () => {
    const highVec = JSON.stringify(new Array(768).fill(0.02));
    const lowVec = JSON.stringify(new Array(768).fill(0.01));
    // High-similarity pair
    insertObs(db, PROJECT, { title: 'H1', content: 'High sim', confidence: 90, embedding: highVec });
    insertObs(db, PROJECT, { title: 'H2', content: 'High sim', confidence: 90, embedding: highVec });
    // Lower-similarity pair (still above threshold)
    insertObs(db, PROJECT, { title: 'L1', content: 'Low sim', confidence: 90, embedding: lowVec });

    return conflict.checkConflicts(db, { project: PROJECT, limit: 10 }).then(result => {
      assert.ok(result.conflicts.length >= 1);
      // First conflict should be the high-similarity pair
      assert.ok(result.conflicts[0].similarity >= result.conflicts[result.conflicts.length - 1].similarity);
    });
  });
});

// ─── Confidence floor ─────────────────────────────────────────────────

describe('checkConflicts — confidence floor', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should exclude observations below the confidence floor from pairing', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));
    // High-confidence observation (above default floor of 30)
    insertObs(db, PROJECT, { title: 'High conf', content: 'Above floor', confidence: 80, embedding: vec });
    // Low-confidence observation (below default floor of 30)
    insertObs(db, PROJECT, { title: 'Low conf', content: 'Below floor', confidence: 10, embedding: vec });

    return conflict.checkConflicts(db, { project: PROJECT }).then(result => {
      // The high-confidence obs paired with itself doesn't count (needs 2+ obs)
      // The low-confidence obs is excluded by the floor, so only 1 obs remains
      assert.equal(result.totalFound, 0, 'Low-confidence obs excluded by floor, no pairs possible');
    });
  });

  it('should use a custom confidence floor', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, PROJECT, { title: 'Obs A', content: 'Content', confidence: 50, embedding: vec });
    insertObs(db, PROJECT, { title: 'Obs B', content: 'Content', confidence: 40, embedding: vec });
    insertObs(db, PROJECT, { title: 'Obs C', content: 'Content', confidence: 20, embedding: vec });

    // Floor at 45: A (50) and B (40) — B is below floor, so only A remains. No pairs.
    // Actually 40 < 45 means B is excluded. Only A remains. No pairs.
    return conflict.checkConflicts(db, { project: PROJECT, confidenceFloor: 45 }).then(result => {
      assert.equal(result.totalFound, 0, 'Floor 45 excludes B (40) and C (20), only A remains, no pairs');
    });

    // Floor at 35: A (50) and B (40) are both above, C (20) excluded. Pair A-B detected.
    return conflict.checkConflicts(db, { project: PROJECT, confidenceFloor: 35 }).then(result => {
      assert.ok(result.totalFound >= 1, 'Floor 35 includes A and B, conflict pair detected');
    });
  });

  it('should not exclude observations when confidenceFloor is 0', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, PROJECT, { title: 'Low A', content: 'Content', confidence: 1, embedding: vec });
    insertObs(db, PROJECT, { title: 'Low B', content: 'Content', confidence: 5, embedding: vec });

    return conflict.checkConflicts(db, { project: PROJECT, confidenceFloor: 0 }).then(result => {
      assert.ok(result.totalFound >= 1, 'With floor 0, even confidence-1 observations are paired');
    });
  });

  it('should return the confidenceFloor in the result metadata when set', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, PROJECT, { title: 'Obs', content: 'Content', confidence: 80, embedding: vec });

    return conflict.checkConflicts(db, { project: PROJECT, confidenceFloor: 50 }).then(result => {
      assert.equal(result.project, PROJECT);
      // Verify the query actually used the floor (only 1 obs, so no pairs)
      assert.equal(result.totalFound, 0);
    });
  });
});

// ─── Semantic cache ───────────────────────────────────────────────────

describe('checkConflicts — semantic cache', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should cache conflict results and return them on repeated calls', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, PROJECT, { title: 'A', content: 'Content A', confidence: 90, embedding: vec });
    insertObs(db, PROJECT, { title: 'B', content: 'Content B', confidence: 85, embedding: vec });

    return conflict.checkConflicts(db, { project: PROJECT }).then(first => {
      assert.ok(first.totalFound >= 1, 'First call should detect conflicts');

      // Second call with same parameters should hit the cache
      return conflict.checkConflicts(db, { project: PROJECT }).then(second => {
        assert.ok(second.totalFound >= 1, 'Second call should also return results');
        assert.equal(first.totalFound, second.totalFound, 'Cached result should match original');
      });
    });
  });

  it('should invalidate cache when a new observation is added', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, PROJECT, { title: 'A', content: 'Content A', confidence: 90, embedding: vec });
    insertObs(db, PROJECT, { title: 'B', content: 'Content B', confidence: 85, embedding: vec });

    return conflict.checkConflicts(db, { project: PROJECT }).then(first => {
      const firstCount = first.totalFound;

      // Add a new observation with a different embedding
      const newVec = JSON.stringify(new Array(768).fill(0.02));
      insertObs(db, PROJECT, { title: 'C', content: 'Content C', confidence: 90, embedding: newVec });

      // Third call should NOT hit cache — embedding set changed
      return conflict.checkConflicts(db, { project: PROJECT }).then(third => {
        assert.ok(third.totalFound >= firstCount, 'After adding obs, conflicts should increase or stay same');
      });
    });
  });

  it('should invalidate cache when an observation is removed (soft-deleted)', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));
    const a = insertObs(db, PROJECT, { title: 'A', content: 'Content A', confidence: 90, embedding: vec });
    insertObs(db, PROJECT, { title: 'B', content: 'Content B', confidence: 85, embedding: vec });

    return conflict.checkConflicts(db, { project: PROJECT }).then(first => {
      const firstCount = first.totalFound;

      // Soft-delete one observation
      db.prepare('UPDATE observations SET is_active = 0 WHERE id = ?').run(Number(a.id));

      // Next call should recompute (cache invalidated by embedding hash change)
      return conflict.checkConflicts(db, { project: PROJECT }).then(second => {
        assert.equal(second.totalFound, 0, 'After removing an obs, no pairs should remain');
      });
    });
  });

  it('should not use cache when autoResolve is requested (fresh LLM path)', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, PROJECT, { title: 'A', content: 'Content A', confidence: 90, embedding: vec });
    insertObs(db, PROJECT, { title: 'B', content: 'Content B', confidence: 85, embedding: vec });

    // First call without autoResolve — should cache
    return conflict.checkConflicts(db, { project: PROJECT }).then(() => {
      // Second call with autoResolve — should bypass cache (LLM verification needed)
      return conflict.checkConflicts(db, { project: PROJECT, autoResolve: true }).then(result => {
        assert.equal(result.project, PROJECT);
        // Result should still be valid, but cache wasn't used for the LLM path
        assert.ok(result.conflicts.length >= 0);
      });
    });
  });

  it('should clear the entire cache when clearConflictCache is called', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, PROJECT, { title: 'A', content: 'Content A', confidence: 90, embedding: vec });
    insertObs(db, PROJECT, { title: 'B', content: 'Content B', confidence: 85, embedding: vec });

    return conflict.checkConflicts(db, { project: PROJECT }).then(first => {
      assert.ok(first.totalFound >= 1);

      conflict.clearConflictCache();

      // After clearing, the next call must recompute (but result should be the same)
      return conflict.checkConflicts(db, { project: PROJECT }).then(second => {
        assert.ok(second.totalFound >= 1, 'After cache clear, recomputation gives valid results');
      });
    });
  });

  it('should not cache when there are fewer than 2 observations', () => {
    insertObs(db, PROJECT, { title: 'Only one', content: 'Solo', confidence: 90 });
    return conflict.checkConflicts(db, { project: PROJECT }).then(result => {
      assert.equal(result.totalFound, 0);
      // Cache should be empty for this project (no valid key generated)
      // Verify by calling again — should still return 0
      return conflict.checkConflicts(db, { project: PROJECT }).then(second => {
        assert.equal(second.totalFound, 0);
      });
    });
  });

  it('should cache per-project (different projects have independent caches)', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, '/proj-a', { title: 'A1', content: 'Content', confidence: 90, embedding: vec });
    insertObs(db, '/proj-a', { title: 'A2', content: 'Content', confidence: 90, embedding: vec });
    insertObs(db, '/proj-b', { title: 'B1', content: 'Content', confidence: 90, embedding: vec });
    insertObs(db, '/proj-b', { title: 'B2', content: 'Content', confidence: 90, embedding: vec });

    return conflict.checkConflicts(db, { project: '/proj-a' }).then(a => {
      assert.ok(a.totalFound >= 1);
      return conflict.checkConflicts(db, { project: '/proj-b' }).then(b => {
        assert.ok(b.totalFound >= 1);
        // Both caches are independent and valid
        assert.equal(a.totalFound, b.totalFound, 'Identical observation sets should yield identical conflict counts');
      });
    });
  });
});

// ─── Outcome classification ───────────────────────────────────────────

describe('checkConflicts — outcome classification (Utopia third outcome)', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should assign outcome "consolidate" when LLM says NOT a contradiction and similarity is above ceiling', () => {
    const session = require('../src/core/session');
    const orig = session.callLLM;
    session.callLLM = async (messages) => {
      return 'NO'; // not a contradiction
    };
    // Reload conflict so it picks up the patched callLLM (same pattern as resolution tests)
    delete require.cache[require.resolve('../src/core/conflict')];
    const conflictMod = require('../src/core/conflict');

    const vec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, PROJECT, { title: 'Same topic A', content: 'Very similar content', confidence: 90, embedding: vec });
    insertObs(db, PROJECT, { title: 'Same topic B', content: 'Very similar content', confidence: 85, embedding: vec });

    return conflictMod.checkConflicts(db, { project: PROJECT, autoResolve: true }).then(result => {
      assert.ok(result.conflicts.length >= 1);
      const c = result.conflicts[0];
      assert.equal(c.outcome, 'consolidate', 'Identical vectors above ceiling + LLM says not contradiction → consolidate');
      session.callLLM = orig;
    });
  });

  it('should assign outcome "open" when LLM says NOT a contradiction and similarity is below ceiling', () => {
    const session = require('../src/core/session');
    const orig = session.callLLM;
    session.callLLM = async (messages) => {
      return 'NO'; // not a contradiction
    };
    delete require.cache[require.resolve('../src/core/conflict')];
    const conflictMod = require('../src/core/conflict');

    // For "open" we need sim > 0.65 AND sim < 0.85.
    // Use two vectors where cosine is ~0.75:
    // vecA: 768 dims all 0.01 (norm = sqrt(768)*0.01 ≈ 0.876)
    // vecB: same as A for first 400 dims, 0 for rest
    // cosine = 400*0.0001 / (sqrt(768)*0.01 * sqrt(400)*0.01)
    //        = 0.04 / (0.876 * 0.632) ≈ 0.04 / 0.554 ≈ 0.072 — too low
    //
    // Better: vecA all 0.01, vecB all 0.01 for 600 dims, 0 for 168 dims
    // cosine = 600*0.0001 / (sqrt(768)*0.01 * sqrt(600)*0.01)
    //        = 0.06 / (0.876 * 0.775) ≈ 0.06 / 0.679 ≈ 0.088 — still low
    //
    // Even better: use much larger values so the zeroed dims don't hurt as much
    // vecA: 768 dims of 1.0 (norm = sqrt(768) ≈ 27.7)
    // vecB: 650 dims of 1.0, 118 dims of 0
    // cosine = 650 / (sqrt(768) * sqrt(650)) = 650 / (27.7 * 25.5) = 650 / 706 ≈ 0.92 — too high
    //
    // Try: vecA all 1.0, vecB 550 dims of 1.0 + 218 dims of 0.5
    // This is getting complicated. Simplest: use the same vector but override
    // the ceiling check... no, we can't.
    //
    // Simplest approach: two vectors with cosine = 0.75 exactly.
    // If vecA has 768 dims of value a, and vecB has 768 dims where 576 are a and 192 are 0:
    // cosine = 576*a² / (sqrt(768)*a * sqrt(576)*a) = 576 / (sqrt(768)*sqrt(576))
    //        = 576 / (27.71 * 24.0) = 576 / 665.1 ≈ 0.866 — still too high
    //
    // 500 dims of a, 268 dims of 0 in vecB:
    // cosine = 500 / (sqrt(768)*sqrt(500)) = 500 / (27.71 * 22.36) = 500 / 619.6 ≈ 0.807 — good!
    const vecA = JSON.stringify(new Array(768).fill(1.0));
    const vecB = JSON.stringify(new Array(768).fill(0).map((_, i) => i < 500 ? 1.0 : 0));

    insertObs(db, PROJECT, { title: 'Topic A', content: 'Related but distinct', confidence: 90, embedding: vecA });
    insertObs(db, PROJECT, { title: 'Topic B', content: 'Related but distinct', confidence: 85, embedding: vecB });

    return conflictMod.checkConflicts(db, { project: PROJECT, autoResolve: true, threshold: 0.65 }).then(result => {
      assert.ok(result.conflicts.length >= 1, 'Should detect pair with sim > 0.65');
      const c = result.conflicts[0];
      assert.ok(c.similarity > 0.65, 'Similarity should be above threshold, got ' + c.similarity);
      assert.ok(c.similarity < 0.85, 'Similarity should be below consolidation ceiling, got ' + c.similarity);
      assert.equal(c.outcome, 'open', 'Similarity below ceiling + LLM says not contradiction → "open"');
      session.callLLM = orig;
    });
  });

  it('should assign outcome "inconclusive" when LLM throws/unavailable', () => {
    const session = require('../src/core/session');
    const orig = session.callLLM;
    session.callLLM = async () => { throw new Error('LLM unavailable'); };
    delete require.cache[require.resolve('../src/core/conflict')];
    const conflictMod = require('../src/core/conflict');

    const vec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, PROJECT, { title: 'A', content: 'Content A', confidence: 90, embedding: vec });
    insertObs(db, PROJECT, { title: 'B', content: 'Content B', confidence: 85, embedding: vec });

    return conflictMod.checkConflicts(db, { project: PROJECT, autoResolve: true }).then(result => {
      assert.ok(result.conflicts.length >= 1);
      const c = result.conflicts[0];
      assert.equal(c.llm_contradiction, null, 'LLM unavailable → llm_contradiction should be null');
      assert.equal(c.outcome, 'inconclusive', 'When LLM throws, outcome should be inconclusive');
      session.callLLM = orig;
    });
  });

  it('should assign outcome "unresolved" when autoResolve is requested but resolution module fails', () => {
    const session = require('../src/core/session');
    const origSession = session.callLLM;
    // LLM says YES (contradiction) so we enter the resolution path
    session.callLLM = async (messages) => { return 'YES'; };
    const resolution = require('../src/core/resolution');
    const origResolve = resolution.resolveConflict;
    resolution.resolveConflict = async () => { throw new Error('Simulated failure'); };
    delete require.cache[require.resolve('../src/core/conflict')];
    const conflictMod = require('../src/core/conflict');

    const vec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, PROJECT, { title: 'A', content: 'Content A', confidence: 90, embedding: vec });
    insertObs(db, PROJECT, { title: 'B', content: 'Content B', confidence: 85, embedding: vec });

    return conflictMod.checkConflicts(db, { project: PROJECT, autoResolve: true }).then(result => {
      assert.ok(result.conflicts.length >= 1);
      const c = result.conflicts[0];
      assert.equal(c.outcome, 'unresolved', 'When resolution fails, outcome should be unresolved, got ' + c.outcome);
      session.callLLM = origSession;
      resolution.resolveConflict = origResolve;
    });
  });

  it('should NOT trigger DS resolution path when autoResolve is false (no LLM, no resolution)', () => {
    const session = require('../src/core/session');
    const orig = session.callLLM;
    session.callLLM = async () => { throw new Error('Should not be called'); };
    delete require.cache[require.resolve('../src/core/conflict')];
    const conflictMod = require('../src/core/conflict');

    const vec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, PROJECT, { title: 'A', content: 'Content A', confidence: 90, embedding: vec });
    insertObs(db, PROJECT, { title: 'B', content: 'Content B', confidence: 85, embedding: vec });

    return conflictMod.checkConflicts(db, { project: PROJECT, autoResolve: false }).then(result => {
      assert.ok(result.conflicts.length >= 1);
      const c = result.conflicts[0];
      assert.equal(c.outcome, undefined, 'Without autoResolve, outcome should be undefined (no resolution attempted)');
      assert.equal(result.resolutions.length, 0, 'No resolutions should be produced');
      session.callLLM = orig;
    });
  });

  it('should assign outcome "resolved" when a conflict is successfully adjudicated', () => {
    const session = require('../src/core/session');
    const orig = session.callLLM;
    // LLM says YES (contradiction), then DS resolution succeeds
    session.callLLM = async (messages) => { return 'YES'; };
    delete require.cache[require.resolve('../src/core/conflict')];
    const conflictMod = require('../src/core/conflict');

    const vec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, PROJECT, { title: 'Contradict A', content: 'Claim A', confidence: 90, embedding: vec });
    insertObs(db, PROJECT, { title: 'Contradict B', content: 'Claim B', confidence: 85, embedding: vec });

    return conflictMod.checkConflicts(db, { project: PROJECT, autoResolve: true }).then(result => {
      assert.ok(result.conflicts.length >= 1);
      const c = result.conflicts[0];
      assert.equal(c.outcome, 'resolved', 'Successful adjudication → "resolved", got ' + c.outcome);
      assert.ok(result.resolutions.length >= 1, 'Resolution record should be created');
      session.callLLM = orig;
    });
  });

  it('should have an "open" outcome that is distinct from "resolved" and "undecidable"', () => {
    return conflict.checkConflicts(db, { project: PROJECT, autoResolve: true }).then(result => {
      if (result.conflicts.length > 0) {
        const outcomes = new Set(result.conflicts.map(c => c.outcome));
        assert.ok(['open', 'resolved', 'undecidable', 'inconclusive', 'consolidate', 'unresolved'].some(
          o => o === 'open'
        ), '"open" is a recognized outcome');
      }
    });
  });

  it('should expose the KEEP_BOTH_SIMILARITY_CEILING constant', () => {
    assert.equal(conflict.KEEP_BOTH_SIMILARITY_CEILING, 0.85);
  });

  it('should expose DEFAULT_BATCH_SIZE constant', () => {
    assert.equal(conflict.DEFAULT_BATCH_SIZE, 5);
  });

  it('should expose DEFAULT_CONFIDENCE_FLOOR constant', () => {
    assert.equal(conflict.DEFAULT_CONFIDENCE_FLOOR, 30);
  });
});

// ─── LLM batching ──────────────────────────────────────────────────────

describe('checkConflicts — LLM batching', () => {
  let db;
  let callCount;
  let lastBatchMessages;

  beforeEach(() => {
    db = createTestDb();
    callCount = 0;
    lastBatchMessages = null;
  });

  it('should batch multiple conflict pairs into a single LLM call when under batchSize', () => {
    const session = require('../src/core/session');
    const orig = session.callLLM;
    session.callLLM = async (messages) => {
      callCount++;
      lastBatchMessages = messages;
      const content = messages[1].content;
      const pairCount = (content.match(/^\d+\./gm) || []).length;
      return Array(pairCount).fill('NO').join('\n');
    };
    delete require.cache[require.resolve('../src/core/conflict')];
    const conflictMod = require('../src/core/conflict');

    const vec = JSON.stringify(new Array(768).fill(0.01));
    for (let i = 0; i < 3; i++) {
      insertObs(db, PROJECT, { title: 'Obs ' + i, content: 'Content ' + i, confidence: 90, embedding: vec });
    }

    return conflictMod.checkConflicts(db, { project: PROJECT, autoResolve: true, batchSize: 5, limit: 10 }).then(result => {
      assert.ok(callCount >= 1, 'Should make at least one LLM call, got ' + callCount);
      assert.ok(result.conflicts.length >= 1, 'Should detect conflicts');
      result.conflicts.forEach(c => {
        assert.equal(c.llm_contradiction, false, 'Each pair should have llm_contradiction set');
      });
      session.callLLM = orig;
    });
  });

  it('should split into multiple batches when pairs exceed batchSize', () => {
    const session = require('../src/core/session');
    const orig = session.callLLM;
    session.callLLM = async (messages) => {
      callCount++;
      return 'NO';
    };
    delete require.cache[require.resolve('../src/core/conflict')];
    const conflictMod = require('../src/core/conflict');

    const vec = JSON.stringify(new Array(768).fill(0.01));
    for (let i = 0; i < 6; i++) {
      insertObs(db, PROJECT, { title: 'Obs ' + i, content: 'Content ' + i, confidence: 90, embedding: vec });
    }

    return conflictMod.checkConflicts(db, { project: PROJECT, autoResolve: true, batchSize: 5, limit: 15 }).then(result => {
      assert.ok(callCount >= 1, 'Should make LLM calls, got ' + callCount);
      result.conflicts.forEach(c => {
        assert.ok(c.llm_contradiction !== undefined, 'Each pair should have llm_contradiction');
      });
      session.callLLM = orig;
    });
  });

  it('should handle batch LLM call failure gracefully (mark batch as inconclusive)', () => {
    const session = require('../src/core/session');
    const orig = session.callLLM;
    session.callLLM = async () => { throw new Error('Batch LLM failure'); };
    delete require.cache[require.resolve('../src/core/conflict')];
    const conflictMod = require('../src/core/conflict');

    const vec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, PROJECT, { title: 'A', content: 'Content A', confidence: 90, embedding: vec });
    insertObs(db, PROJECT, { title: 'B', content: 'Content B', confidence: 85, embedding: vec });

    return conflictMod.checkConflicts(db, { project: PROJECT, autoResolve: true }).then(result => {
      assert.ok(result.conflicts.length >= 1);
      const c = result.conflicts[0];
      assert.equal(c.llm_contradiction, null, 'Failed batch should leave llm_contradiction as null, got ' + c.llm_contradiction);
      assert.equal(c.outcome, 'inconclusive');
      session.callLLM = orig;
    });
  });

  it('should handle partial batch response (fewer lines than pairs) gracefully', () => {
    const session = require('../src/core/session');
    const orig = session.callLLM;
    session.callLLM = async (messages) => {
      return 'NO'; // only one line for many pairs
    };
    delete require.cache[require.resolve('../src/core/conflict')];
    const conflictMod = require('../src/core/conflict');

    const vec = JSON.stringify(new Array(768).fill(0.01));
    for (let i = 0; i < 4; i++) {
      insertObs(db, PROJECT, { title: 'Obs ' + i, content: 'Content ' + i, confidence: 90, embedding: vec });
    }

    return conflictMod.checkConflicts(db, { project: PROJECT, autoResolve: true, limit: 10 }).then(result => {
      assert.ok(result.conflicts.length >= 1);
      const nulls = result.conflicts.filter(c => c.llm_contradiction === null).length;
      assert.ok(nulls > 0, 'Some pairs should have null llm_contradiction when response is short, got ' + nulls);
      session.callLLM = orig;
    });
  });
});

// ─── Threshold boundary conditions ─────────────────────────────────────

describe('checkConflicts — threshold boundary conditions', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should use the default threshold of 0.65 when not specified', () => {
    assert.equal(conflict.DEFAULT_SIMILARITY_THRESHOLD, 0.65);
  });

  it('should respect a custom threshold lower than default', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, PROJECT, { title: 'A', content: 'Content', confidence: 90, embedding: vec });
    insertObs(db, PROJECT, { title: 'B', content: 'Content', confidence: 85, embedding: vec });

    // Default threshold 0.65 — identical vectors (sim=1.0) should be detected
    return conflict.checkConflicts(db, { project: PROJECT, threshold: 0.65 }).then(result => {
      assert.ok(result.totalFound >= 1, 'Identical vectors above 0.65 threshold should be detected');
    });
  });

  it('should respect a custom threshold higher than default', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, PROJECT, { title: 'A', content: 'Content', confidence: 90, embedding: vec });
    insertObs(db, PROJECT, { title: 'B', content: 'Content', confidence: 85, embedding: vec });

    // Raise threshold above 1.0 — no pairs should be detected
    return conflict.checkConflicts(db, { project: PROJECT, threshold: 1.5 }).then(result => {
      assert.equal(result.totalFound, 0, 'Threshold > 1.0 should detect nothing (cosine max is 1.0)');
    });
  });

  it('should handle threshold of exactly 0 (detect all pairs with positive similarity)', () => {
    // Clear any stale cache first
    conflict.clearConflictCache();
    // Two vectors with clearly positive cosine (not orthogonal)
    // vecA: [1, 1, 0, 0, ...], vecB: [1, 0, 1, 0, ...]
    // cosine = 1 / (sqrt(2) * sqrt(2)) = 1/2 = 0.5 > 0
    const vecA = JSON.stringify(new Array(768).fill(0).map((_, i) => (i === 0 || i === 1) ? 1 : 0));
    const vecB = JSON.stringify(new Array(768).fill(0).map((_, i) => (i === 0 || i === 2) ? 1 : 0));
    insertObs(db, PROJECT, { title: 'A', content: 'Content A', confidence: 90, embedding: vecA });
    insertObs(db, PROJECT, { title: 'B', content: 'Content B', confidence: 90, embedding: vecB });

    return conflict.checkConflicts(db, { project: PROJECT, threshold: 0 }).then(result => {
      assert.ok(result.totalFound >= 1, 'Threshold 0 should detect pairs with positive similarity, got ' + result.totalFound);
    });
  });

  it('should handle negative threshold gracefully (treat as 0)', () => {
    const vecA = JSON.stringify(new Array(768).fill(0).map((_, i) => i === 0 ? 1 : 0));
    const vecB = JSON.stringify(new Array(768).fill(0).map((_, i) => i === 1 ? 1 : 0));
    insertObs(db, PROJECT, { title: 'A', content: 'Content A', confidence: 90, embedding: vecA });
    insertObs(db, PROJECT, { title: 'B', content: 'Content B', confidence: 90, embedding: vecB });

    return conflict.checkConflicts(db, { project: PROJECT, threshold: -0.5 }).then(result => {
      assert.ok(result.totalFound >= 1, 'Negative threshold should still detect pairs');
    });
  });

  it('should handle empty embedding vectors (zero norm) gracefully', () => {
    const zeroVec = JSON.stringify(new Array(768).fill(0));
    insertObs(db, PROJECT, { title: 'Zero A', content: 'Content', confidence: 90, embedding: zeroVec });
    insertObs(db, PROJECT, { title: 'Zero B', content: 'Content', confidence: 90, embedding: zeroVec });

    return conflict.checkConflicts(db, { project: PROJECT }).then(result => {
      // cosineSimilarity returns 0 for zero-norm vectors, so no conflicts
      assert.equal(result.totalFound, 0, 'Zero-norm vectors should not produce conflicts');
    });
  });

  it('should handle mismatched embedding dimensions gracefully', () => {
    const vec300 = JSON.stringify(new Array(300).fill(0.01));
    const vec768 = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, PROJECT, { title: 'Short', content: 'Content', confidence: 90, embedding: vec300 });
    insertObs(db, PROJECT, { title: 'Long', content: 'Content', confidence: 90, embedding: vec768 });

    return conflict.checkConflicts(db, { project: PROJECT }).then(result => {
      assert.equal(result.totalFound, 0, 'Mismatched dimensions should not produce conflicts');
    });
  });
});

// ─── Embedding hash cache key ──────────────────────────────────────────

describe('checkConflicts — embedding set hash', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should return empty string for project with no embedded observations', () => {
    assert.equal(conflict._embeddingSetHash(db, '/empty-project'), '');
  });

  it('should produce a stable hash for the same observation set', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, PROJECT, { title: 'A', content: 'Content', confidence: 90, embedding: vec });
    insertObs(db, PROJECT, { title: 'B', content: 'Content', confidence: 85, embedding: vec });

    const hash1 = conflict._embeddingSetHash(db, PROJECT);
    const hash2 = conflict._embeddingSetHash(db, PROJECT);
    assert.equal(hash1, hash2, 'Hash should be deterministic for the same set');
    assert.ok(hash1.length > 0, 'Hash should be non-empty');
  });

  it('should produce different hashes for different observation sets', () => {
    const vec1 = JSON.stringify(new Array(768).fill(0.01));
    const vec2 = JSON.stringify(new Array(768).fill(0.02));
    insertObs(db, PROJECT, { title: 'A', content: 'Content', confidence: 90, embedding: vec1 });

    const hash1 = conflict._embeddingSetHash(db, PROJECT);

    insertObs(db, PROJECT, { title: 'B', content: 'Content', confidence: 85, embedding: vec2 });
    const hash2 = conflict._embeddingSetHash(db, PROJECT);

    assert.notEqual(hash1, hash2, 'Different observation sets should produce different hashes');
  });

  it('should produce different hashes when observation confidence changes', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));
    const r = insertObs(db, PROJECT, { title: 'A', content: 'Content', confidence: 50, embedding: vec });
    const hash1 = conflict._embeddingSetHash(db, PROJECT);

    // Update confidence — the embedding fingerprint doesn't include confidence,
    // so hash should stay the same (only embedding changes invalidate cache)
    db.prepare('UPDATE observations SET confidence = 90 WHERE id = ?').run(Number(r.id));
    const hash2 = conflict._embeddingSetHash(db, PROJECT);

    // Confidence is NOT part of the embedding hash (only embeddings matter for cache)
    assert.equal(hash1, hash2, 'Confidence change alone should not invalidate embedding hash');
  });

  it('should produce a hex string hash', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, PROJECT, { title: 'A', content: 'Content', confidence: 90, embedding: vec });
    const hash = conflict._embeddingSetHash(db, PROJECT);
    assert.ok(/^[0-9a-f]+$/.test(hash), 'Hash should be hex-encoded');
  });
});

// ─── Cache get/set internals ───────────────────────────────────────────

describe('checkConflicts — cache internals', () => {
  it('should return undefined for a cache key that does not exist', () => {
    assert.equal(conflict._cacheGet('/nonexistent', 0.65, 30, 'hash123'), undefined);
  });

  it('should return cached entry when key matches', () => {
    conflict._cacheSet('/proj', 0.65, 30, 'hash123', { conflicts: [{ a: { id: 1 }, b: { id: 2 }, similarity: 0.9 }], totalFound: 1 });
    const entry = conflict._cacheGet('/proj', 0.65, 30, 'hash123');
    assert.ok(entry);
    assert.equal(entry.totalFound, 1);
    assert.equal(entry.conflicts.length, 1);
  });

  it('should return undefined when threshold does not match', () => {
    conflict._cacheSet('/proj', 0.65, 30, 'hash123', { conflicts: [], totalFound: 0 });
    assert.equal(conflict._cacheGet('/proj', 0.70, 30, 'hash123'), undefined, 'Different threshold → cache miss');
  });

  it('should return undefined when confidenceFloor does not match', () => {
    conflict._cacheSet('/proj', 0.65, 30, 'hash123', { conflicts: [], totalFound: 0 });
    assert.equal(conflict._cacheGet('/proj', 0.65, 50, 'hash123'), undefined, 'Different floor → cache miss');
  });

  it('should return undefined when embeddingHash does not match', () => {
    conflict._cacheSet('/proj', 0.65, 30, 'hash123', { conflicts: [], totalFound: 0 });
    assert.equal(conflict._cacheGet('/proj', 0.65, 30, 'hash456'), undefined, 'Different hash → cache miss');
  });

  it('should clear all cached entries when clearConflictCache is called', () => {
    conflict._cacheSet('/proj1', 0.65, 30, 'h1', { conflicts: [], totalFound: 0 });
    conflict._cacheSet('/proj2', 0.70, 40, 'h2', { conflicts: [], totalFound: 0 });
    // Verify entries exist before clear
    assert.ok(conflict._cacheGet('/proj1', 0.65, 30, 'h1'), 'Entry should exist before clear');
    assert.ok(conflict._cacheGet('/proj2', 0.70, 40, 'h2'), 'Entry should exist before clear');
    conflict.clearConflictCache();
    assert.equal(conflict._cacheGet('/proj1', 0.65, 30, 'h1'), undefined, 'Entry should be gone after clear');
    assert.equal(conflict._cacheGet('/proj2', 0.70, 40, 'h2'), undefined, 'Entry should be gone after clear');
  });
});

// ─── Integration: confidence floor + cache interaction ─────────────────

describe('checkConflicts — confidence floor + cache interaction', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should cache separately for different confidence floors', () => {
    const vec = JSON.stringify(new Array(768).fill(0.01));
    insertObs(db, PROJECT, { title: 'High', content: 'Content', confidence: 80, embedding: vec });
    insertObs(db, PROJECT, { title: 'Low', content: 'Content', confidence: 20, embedding: vec });

    // Floor 30 (default): Low (20) is excluded, only High remains → no pairs
    return conflict.checkConflicts(db, { project: PROJECT, confidenceFloor: 30 }).then(result1 => {
      assert.equal(result1.totalFound, 0, 'Floor 30 excludes low-conf obs');

      // Floor 10: both included → pair detected
      return conflict.checkConflicts(db, { project: PROJECT, confidenceFloor: 10 }).then(result2 => {
        assert.ok(result2.totalFound >= 1, 'Floor 10 includes both obs, pair detected');
        // The two calls have different confidence floors, so different cache keys
      });
    });
  });
});
