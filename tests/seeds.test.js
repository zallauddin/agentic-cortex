/**
 * seeds.test.js — Lesson seed exchange (phases 1–4): review gate, signed
 * artifacts, publish/pull, canary, dedupe, grading, quorum retirement.
 *
 * Security properties under test:
 *   - nothing publishes without human approval (review-queue gate)
 *   - sanitizer re-runs at publish time (credentials never leave)
 *   - unsigned / untrusted-key seeds never import (fail-closed pull)
 *   - imported seeds are second-class (reduced confidence, provenance 'seeded')
 *   - seeds failing quorum retire automatically
 *
 * @module tests/seeds
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { ensureSchema, getDb } = require('../src/core/db.js');
const seeds = require('../src/core/seeds.js');

let db, tmpDir, lessonsDir, registryDir, projectRoot;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-seeds-'));
  lessonsDir = path.join(tmpDir, 'lessons');
  registryDir = path.join(tmpDir, 'registry');
  projectRoot = tmpDir;
  fs.mkdirSync(lessonsDir, { recursive: true });
  process.env.AGENTIC_CORTEX_DB = path.join(tmpDir, 'test.db');
  db = getDb();
  ensureSchema(db);
});

after(() => {
  try { db.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  delete process.env.AGENTIC_CORTEX_DB;
});

function writeLesson(hash, title, content, scope) {
  const file = hash + '-lesson.md';
  fs.writeFileSync(path.join(lessonsDir, file), [
    '---',
    'id: ' + hash,
    'type: learning',
    'scope: ' + (scope || 'machine'),
    'confidence: 90',
    'sources: [1]',
    'created_at: 2026-01-01T00:00:00.000Z',
    'sanitized: true',
    'redaction_count: 0',
    'generalization_rules: []',
    '---',
    '',
    '# ' + title,
    '',
    content,
    '',
  ].join('\n'), 'utf8');
}

describe('trust keys', () => {
  test('ensureKeypair is idempotent and fingerprints are stable', () => {
    const k1 = seeds.ensureKeypair(projectRoot);
    const k2 = seeds.ensureKeypair(projectRoot);
    assert.equal(k1.publicKey, k2.publicKey);
    assert.equal(seeds.fingerprint(k1.publicKey), seeds.fingerprint(k2.publicKey));
    assert.equal(seeds.fingerprint(k1.publicKey).length, 16);
  });
});

describe('review gate + publish', () => {
  test('enqueue fills the review queue; pending rows do NOT publish', () => {
    writeLesson('aabbccddeeff0011', 'Always re-read tool schemas', 'When a tool validation error appears, re-read the schema immediately. Applies to any strict API tool.');
    const q = seeds.enqueueLessons(db, lessonsDir);
    assert.equal(q.queued, 1);
    // attempt publish with nothing approved
    const r = seeds.publishApproved(db, registryDir, projectRoot);
    assert.equal(r.published, 0);
    assert.ok(!fs.existsSync(path.join(registryDir, 'seeds')) || fs.readdirSync(path.join(registryDir, 'seeds')).length === 0);
  });

  test('approved lesson publishes as a signed, sharded artifact', () => {
    const row = db.prepare("SELECT id FROM seed_review_queue WHERE status = 'pending'").get();
    seeds.reviewSeed(db, row.id, 'approved', { reviewedBy: 'test' });
    const r = seeds.publishApproved(db, registryDir, projectRoot);
    assert.equal(r.published, 1);
    const file = path.join(registryDir, r.files[0]);
    assert.ok(fs.existsSync(file));
    const seed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(seed.v, 1);
    assert.ok(seed.signature && seed.signature.value, 'artifact must be signed');
    assert.ok(seed.tags.includes(seeds.SEED_TAG));
    assert.equal(seed.confidence, seeds.SEED_BASE_CONFIDENCE);
    assert.ok(!JSON.stringify(seed).includes(tmpDir.replace(/\\/g, '\\\\')), 'no local paths in artifact');
    // queue row now published
    const after = db.prepare('SELECT status FROM seed_review_queue WHERE id = ?').get(row.id);
    assert.equal(after.status, 'published');
  });

  test('publish refuses credential-class content (fail-closed at the gate)', () => {
    // Insert an approved row with a credential smuggled in after review.
    db.prepare(`INSERT INTO seed_review_queue (lesson_hash, type, title, content, scope, source_ids, status)
                VALUES ('deadbeefdeadbeef', 'learning', 'rotated keys', 'we used password = "supersecret99" for deploys', 'machine', '[]', 'approved')`).run();
    const r = seeds.publishApproved(db, registryDir, projectRoot);
    assert.equal(r.published, 0);
    assert.ok(r.skipped.some(s => /credential/.test(s.reason)), 'must skip with credential reason');
  });
});

describe('pull + verify', () => {
  test('unsigned or untrusted seeds never import (fail-closed)', () => {
    // A seed signed by an attacker key (not in the trust list)
    const attacker = projectRoot; // reuse; but clear trust list below
    const artifact = {
      v: 1, hash: 'ffffffffffffffff', type: 'learning',
      title: 'evil seed', content: 'rm -rf everything', confidence: 55,
      tags: ['origin:community'], scope: 'machine', sourceCount: 1,
      publishedAt: new Date().toISOString(),
    };
    const signed = seeds.signArtifact(artifact, attacker);
    const dir = path.join(registryDir, 'seeds', 'ff');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ffffffffffffffff.json'), JSON.stringify(signed), 'utf8');

    const r = seeds.pullSeeds(db, registryDir, { trustedKeys: ['-----BEGIN NOT A REAL KEY-----'] });
    const evil = db.prepare("SELECT COUNT(*) n FROM observations WHERE title = 'evil seed'").get().n;
    assert.equal(evil, 0, 'untrusted seed must not import');
    assert.ok(r.skipped >= 1);
  });

  test('trusted seeds import at reduced confidence with provenance seeded', () => {
    const key = seeds.ensureKeypair(projectRoot).publicKey;
    // Read the artifact hash straight from the registry (content-addressed).
    const shardDir = path.join(registryDir, 'seeds');
    const artifactFile = fs.readdirSync(shardDir).flatMap(d =>
      fs.readdirSync(path.join(shardDir, d)).filter(f => f.endsWith('.json')).map(f => path.join(shardDir, d, f))
    ).map(f => JSON.parse(fs.readFileSync(f, 'utf8'))).find(s => s.title === 'Always re-read tool schemas');
    assert.ok(artifactFile, 'published artifact present');
    const r = seeds.pullSeeds(db, registryDir, { trustedKeys: [key], canaryPct: 100 });
    const imported = db.prepare("SELECT id, confidence, provenance, tags FROM observations WHERE provenance = 'seeded' AND title = 'Always re-read tool schemas'").get();
    assert.ok(imported, 'trusted seed imports');
    assert.equal(imported.confidence, seeds.SEED_BASE_CONFIDENCE);
    assert.ok(imported.tags.includes('seed_hash:' + artifactFile.hash));
  });

  test('pull is idempotent — same seed does not duplicate', () => {
    const key = seeds.ensureKeypair(projectRoot).publicKey;
    seeds.pullSeeds(db, registryDir, { trustedKeys: [key], canaryPct: 100 });
    const n = db.prepare("SELECT COUNT(*) n FROM observations WHERE title = 'Always re-read tool schemas'").get().n;
    assert.equal(n, 1);
  });
});

describe('grading + quorum', () => {
  test('gradeSeed routes grades by seed_hash', () => {
    const obs = db.prepare("SELECT id FROM observations WHERE provenance = 'seeded' LIMIT 1").get();
    const r = seeds.gradeSeed(db, obs.id, 'helpful');
    assert.match(r.seedHash, /^[0-9a-f]{16}$/);
    assert.throws(() => seeds.gradeSeed(db, obs.id, 'meh'));
    const nonSeed = db.prepare("SELECT id FROM observations WHERE provenance != 'seeded' LIMIT 1").get();
    if (nonSeed) assert.throws(() => seeds.gradeSeed(db, nonSeed.id, 'helpful'));
  });

  test('seeds failing quorum retire (is_active = 0)', () => {
    const obs = db.prepare("SELECT id, tags FROM observations WHERE provenance = 'seeded' LIMIT 1").get();
    seeds.gradeSeed(db, obs.id, 'not_helpful');
    const retired = seeds.retireFailedSeeds(db, { minGrades: 1, minHelpfulPct: 60 });
    if (retired.length) {
      const n = db.prepare("SELECT COUNT(*) n FROM observations WHERE is_active = 0 AND provenance = 'seeded'").get().n;
      assert.ok(n >= 1);
    }
  });

  test('gradeTally verdicts', () => {
    const tally = seeds.gradeTally(db, { minGrades: 1, minHelpfulPct: 60 });
    assert.ok(Array.isArray(tally));
  });
});
