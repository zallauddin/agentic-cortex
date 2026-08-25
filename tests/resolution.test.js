'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../src/core/db');
const resolution = require('../src/core/resolution');
const reflection = require('../src/core/reflection');

// Memory safety: never load the real ~400MB embedding model in tests.
// Deterministic embedding stub + embeddings disabled.
const embedding = require('../src/core/embedding');
embedding.computeEmbedding = async function (text) {
  return Array.from({ length: 16 }, (_, i) => ((text || '').length + i) % 7);
};
process.env.AGENTIC_CORTEX_EMBEDDINGS = process.env.AGENTIC_CORTEX_EMBEDDINGS || '0';

/** Create a fresh in-memory DB with the full schema. */
function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  return db;
}

/** Insert a raw observation row directly (bypasses API, keeps tests hermetic). */
function insertObs(db, project, { type = 'decision', title, content, confidence = 70, accessCount = 0 }) {
  const r = db.prepare(
    `INSERT INTO observations (project_path, type, title, content, confidence, provenance, is_active, access_count)
     VALUES (?, ?, ?, ?, ?, 'explicit', 1, ?)`
  ).run(project, type, title, content, confidence, accessCount);
  return db.prepare('SELECT * FROM observations WHERE id = ?').get(Number(r.lastInsertRowid));
}

const PROJECT = '/proj/resolution-test';

describe('resolution — Dempster-Shafer evidence engine', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  describe('dsCombine', () => {
    it('fuses two agreeing channels and amplifies belief (normalized)', () => {
      const r = resolution.dsCombine(0.6, 0.3, 0.7, 0.2);
      // k = 0.6*0.2 + 0.3*0.7 = 0.33
      assert.ok(Math.abs(r.k - 0.33) < 1e-9);
      // m12(A) = (0.42 + 0.06 + 0.07) / 0.67 ≈ 0.8209
      assert.ok(Math.abs(r.mA - 0.8209) < 0.001);
      assert.ok(r.mA > 0.6, 'combined belief exceeds either single channel');
      assert.equal(r.undecidable, false);
    });

    it('returns undecidable on total contradiction (k = 1)', () => {
      const r = resolution.dsCombine(1, 0, 0, 1);
      assert.equal(r.undecidable, true);
      assert.equal(r.k, 1);
    });

    it('passes the first channel through unchanged when the second is fully ignorant', () => {
      const r = resolution.dsCombine(0.6, 0.3, 0, 0);
      assert.equal(r.k, 0);
      assert.ok(Math.abs(r.mA - 0.6) < 1e-9);
      assert.ok(Math.abs(r.mB - 0.3) < 1e-9);
    });
  });

  describe('statisticalMass', () => {
    it('weights confidence, corroboration, and usage', () => {
      // conf 100, no corroboration, no usage → 0.4·1 = 0.4
      const m0 = resolution.statisticalMass({ confidence: 100, access_count: 0 }, 0);
      assert.ok(Math.abs(m0 - 0.4) < 1e-9);
      // corroboration saturates: 1 - 2^-3 = 0.875 → 0.4·1 + 0.4·0.875 = 0.75
      const m3 = resolution.statisticalMass({ confidence: 100, access_count: 0 }, 3);
      assert.ok(Math.abs(m3 - 0.75) < 0.001);
      // clamps to [0.05, 0.95]
      assert.ok(resolution.statisticalMass({ confidence: 1, access_count: 0 }, 0) >= 0.05);
      assert.ok(resolution.statisticalMass({ confidence: 100, access_count: 100 }, 100) <= 0.95);
    });
  });

  describe('computeCorroboration', () => {
    it('counts observations with cosine sim >= 0.9 as agreeing witnesses', async () => {
      // Stub cosineSimilarity deterministically for this test via identical text.
      const a = insertObs(db, PROJECT, { title: 'use postgres', content: 'use postgres for all storage', confidence: 90 });
      const b = insertObs(db, PROJECT, { title: 'use postgres too', content: 'postgres is the storage choice', confidence: 80 });
      const c = insertObs(db, PROJECT, { title: 'use sqlite', content: 'sqlite is better for embedded', confidence: 70 });
      // Give them real embeddings via the stub.
      for (const o of [a, b, c]) {
        const text = [o.title, o.content].filter(Boolean).join('. ');
        db.prepare('UPDATE observations SET embedding = ? WHERE id = ?').run(JSON.stringify(await embedding.computeEmbedding(text)), o.id);
      }
      const corr = resolution.computeCorroboration(db, PROJECT);
      assert.ok(corr.has(a.id));
      assert.ok(corr.has(b.id));
      assert.ok(corr.has(c.id));
    });
  });

  describe('resolveConflict (auto-adjudication, LLM unavailable → statistical-only)', () => {
    it('picks the higher-belief observation, archives the loser, records the resolution with a reason', async () => {
      const strong = insertObs(db, PROJECT, { title: 'use vite', content: 'use vite for the bundler because it is fastest', confidence: 95, accessCount: 10 });
      const weak = insertObs(db, PROJECT, { title: 'use webpack', content: 'use webpack for the bundler because it is familiar', confidence: 50, accessCount: 0 });
      const corr = resolution.computeCorroboration(db, PROJECT);

      const res = await resolution.resolveConflict(db, { project: PROJECT, a: strong, b: weak, corroboration: corr, resolutionType: 'consolidation' });

      assert.equal(res.status, 'resolved');
      assert.equal(res.winnerId, strong.id);
      assert.equal(res.loserId, weak.id);
      assert.ok(res.reason.length > 0, 'deciding evidence must be recorded');

      // Loser archived
      const loser = db.prepare('SELECT * FROM observations WHERE id = ?').get(weak.id);
      assert.equal(loser.is_active, 0);

      // Supersedes edge carries the reason
      const edge = db.prepare(
        "SELECT * FROM memory_relations WHERE source_id = ? AND target_id = ? AND relation_type = 'supersedes'"
      ).get(strong.id, weak.id);
      assert.ok(edge, 'supersedes edge exists');
      assert.ok(edge.reason && edge.reason.length > 0, 'supersedes edge has the reason');

      // Resolution record persisted
      const rec = db.prepare('SELECT * FROM resolution_records WHERE winner_id = ? AND loser_id = ?').get(strong.id, weak.id);
      assert.ok(rec, 'resolution record exists');
      assert.equal(rec.resolution_type, 'consolidation');
      assert.ok(rec.conflict_coefficient >= 0 && rec.conflict_coefficient <= 1);
      assert.ok(rec.combined_belief > 0);
      assert.equal(rec.reason, res.reason);
      assert.ok(Array.isArray(JSON.parse(rec.evidence_ids)));
    });

    it('agreement-weighted boost: clean resolution boosts more than contested one', async () => {
      // Two near-identical claims (clean resolution, k small)
      const a1 = insertObs(db, PROJECT, { title: 'use vitest', content: 'use vitest for unit tests', confidence: 90, accessCount: 5 });
      const a2 = insertObs(db, PROJECT, { title: 'use vitest 2', content: 'vitest for all unit tests', confidence: 85, accessCount: 3 });
      const c1 = resolution.computeCorroboration(db, PROJECT);
      const r1 = await resolution.resolveConflict(db, { project: PROJECT, a: a1, b: a2, corroboration: c1, resolutionType: 'consolidation' });
      assert.ok(r1.confidenceBoost >= 8, 'clean resolution gets near-full boost, got ' + r1.confidenceBoost);
    });

    it('two-shot debate: generates competing cases, then judges with them on record', async () => {
      const session = require('../src/core/session');
      const orig = session.callLLM;
      const calls = [];
      // Shot 1: debate coach returns cases for both sides.
      // Shot 2: judge returns winner A with a deciding evidence.
      session.callLLM = async (messages) => {
        calls.push(messages[messages.length - 1].content || '');
        if (calls.length === 1) {
          return '{"a":"postgres scales and has first-class JSONB","b":"sqlite is zero-config and embeds anywhere"}';
        }
        return '{"winner":"A","confidence":0.85,"reason":"postgres JSONB wins on concurrency"}';
      };
      // resolution.js destructures callLLM at module load — re-require it so
      // the module picks up the patched reference (fresh instance is stateless).
      delete require.cache[require.resolve('../src/core/resolution')];
      const resMod = require('../src/core/resolution');
      try {
        const a = insertObs(db, PROJECT, { title: 'use postgres', content: 'postgres for the store', confidence: 70 });
        const b = insertObs(db, PROJECT, { title: 'use sqlite', content: 'sqlite for the store', confidence: 80 });
        const corr = resMod.computeCorroboration(db, PROJECT);
        const res = await resMod.resolveConflict(db, { project: PROJECT, a, b, corroboration: corr, resolutionType: 'adjudicated' });

        assert.equal(res.winnerId, a.id, 'judge picked A');
        assert.equal(res.reason, 'postgres JSONB wins on concurrency');
        assert.ok(res.debate, 'debate arguments returned');
        assert.equal(res.debate.a, 'postgres scales and has first-class JSONB');
        assert.equal(res.debate.b, 'sqlite is zero-config and embeds anywhere');

        // Debate persisted in the resolution record for auditability
        const rec = db.prepare('SELECT * FROM resolution_records WHERE winner_id = ? AND loser_id = ?').get(a.id, b.id);
        assert.ok(rec.debate, 'debate persisted');
        const stored = JSON.parse(rec.debate);
        assert.equal(stored.a, 'postgres scales and has first-class JSONB');
        assert.equal(stored.b, 'sqlite is zero-config and embeds anywhere');

        // Two calls: debate + judgment
        assert.equal(calls.length, 2);
        const judgePrompt = calls[1];
        assert.ok(judgePrompt.includes('Case for A:'), 'judge saw the generated case for A');
        assert.ok(judgePrompt.includes('Case for B:'), 'judge saw the generated case for B');
      } finally {
        session.callLLM = orig;
        delete require.cache[require.resolve('../src/core/resolution')];
        require('../src/core/resolution'); // restore canonical instance for later tests
      }
    });
  });

  describe('resolveConflict (explicit, human/agent-guided)', () => {
    it('records the supplied reason and type=explicit', async () => {
      const w = insertObs(db, PROJECT, { title: 'win', content: 'the winning claim', confidence: 60 });
      const l = insertObs(db, PROJECT, { title: 'lose', content: 'the losing claim', confidence: 90 });
      const res = await resolution.resolveConflict(db, {
        project: PROJECT,
        a: w,
        b: l,
        explicit: { winnerId: w.id, loserId: l.id, reason: 'architect decided: winner matches the deployment target' },
        resolutionType: 'explicit',
      });
      assert.equal(res.status, 'resolved');
      assert.equal(res.resolutionType, 'explicit');
      assert.equal(res.reason, 'architect decided: winner matches the deployment target');
      const rec = db.prepare('SELECT * FROM resolution_records WHERE winner_id = ? AND loser_id = ?').get(w.id, l.id);
      assert.equal(rec.resolution_type, 'explicit');
      assert.equal(rec.reason, 'architect decided: winner matches the deployment target');
    });
  });

  describe('classifyResolution', () => {
    it('flags high conflict coefficient as weak', () => {
      const cls = resolution.classifyResolution({ conflict_coefficient: 0.8, combined_belief: 0.85 });
      assert.equal(cls.weak, true);
      assert.equal(cls.highConflict, true);
      assert.equal(cls.nearTie, false);
      assert.ok(cls.reasons.length >= 1);
      assert.ok(cls.reasons[0].includes('conflict coefficient'));
    });

    it('flags near-tie combined belief as weak', () => {
      const cls = resolution.classifyResolution({ conflict_coefficient: 0.1, combined_belief: 0.52 });
      assert.equal(cls.weak, true);
      assert.equal(cls.nearTie, true);
      assert.equal(cls.highConflict, false);
    });

    it('flags low winner belief (winner never out-massed loser) as weak', () => {
      // e.g. a human declared the winner with low conviction — belief 0.2
      const cls = resolution.classifyResolution({ conflict_coefficient: 0.36, combined_belief: 0.2 });
      assert.equal(cls.weak, true);
      assert.equal(cls.lowBelief, true);
      assert.equal(cls.nearTie, false);
      assert.equal(cls.highConflict, false);
      assert.ok(cls.reasons.some(r => r.includes('never clearly out-massed')));
    });

    it('treats decisive clean resolutions as solid', () => {
      const cls = resolution.classifyResolution({ conflict_coefficient: 0.1, combined_belief: 0.9 });
      assert.equal(cls.weak, false);
      assert.equal(cls.highConflict, false);
      assert.equal(cls.nearTie, false);
      assert.equal(cls.reasons.length, 0);
    });

    it('boundary: k exactly 0.5 is weak, just under is solid', () => {
      assert.equal(resolution.classifyResolution({ conflict_coefficient: 0.5, combined_belief: 0.9 }).weak, true);
      assert.equal(resolution.classifyResolution({ conflict_coefficient: 0.49, combined_belief: 0.9 }).weak, false);
    });
  });

  describe('getRecentResolutions / resolutionStats', () => {
    it('lists resolutions with winner/loser titles and counts stats', async () => {
      const w = insertObs(db, PROJECT, { title: 'api-first', content: 'api-first architecture', confidence: 90 });
      const l = insertObs(db, PROJECT, { title: 'monolith-first', content: 'monolith-first architecture', confidence: 60 });
      await resolution.resolveConflict(db, {
        project: PROJECT, a: w, b: l,
        explicit: { winnerId: w.id, loserId: l.id, reason: 'team decided api-first' },
        resolutionType: 'explicit',
      });
      const list = resolution.getRecentResolutions(db, PROJECT, 5);
      assert.equal(list.length, 1);
      assert.equal(list[0].winner_title, 'api-first');
      assert.equal(list[0].loser_title, 'monolith-first');
      assert.equal(list[0].reason, 'team decided api-first');
      const stats = resolution.resolutionStats(db, PROJECT);
      assert.equal(stats.total, 1);
      assert.equal(stats.byType[0].resolution_type, 'explicit');
    });
  });

  describe('integration: consolidateMemories uses the evidence engine', () => {
    it('records resolutions during consolidation instead of silent supersede', async () => {
      // Two similar observations with embeddings (needed for clustering)
      const o1 = insertObs(db, PROJECT, { title: 'node 22 lts', content: 'use node 22 lts for the runtime', confidence: 90 });
      const o2 = insertObs(db, PROJECT, { title: 'node 22', content: 'runtime should be node 22', confidence: 80 });
      for (const o of [o1, o2]) {
        const text = [o.title, o.content].filter(Boolean).join('. ');
        db.prepare('UPDATE observations SET embedding = ? WHERE id = ?').run(JSON.stringify(await embedding.computeEmbedding(text)), o.id);
      }
      // Patch out LLM so consolidation doesn't hang on a real model call
      const session = require('../src/core/session');
      const orig = session.callLLM;
      session.callLLM = async () => null;
      try {
        const result = await reflection.consolidateMemories(db, { project: PROJECT, threshold: 0.5 });
        assert.ok(result.merged >= 1);
        assert.ok(result.archived >= 1);
        assert.ok(result.resolutions >= 1, 'consolidation produced resolution records');
        const recs = db.prepare('SELECT * FROM resolution_records WHERE project_path = ?').all(PROJECT);
        assert.ok(recs.length >= 1);
        const edge = db.prepare("SELECT * FROM memory_relations WHERE relation_type = 'supersedes'").get();
        assert.ok(edge && edge.reason && edge.reason.length > 0, 'supersedes edge carries a reason');
      } finally {
        session.callLLM = orig;
      }
    });
  });
});
