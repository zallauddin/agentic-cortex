/**
 * seed-log.test.js — Trust plane: Merkle-chained seed log with signed heads.
 *
 * Properties under test:
 *   chain       — appends link correctly; any retroactive edit breaks
 *                 verification at exactly the edited seq (tamper-EVIDENT).
 *   fail-closed — a broken log refuses new appends and refuses head signing.
 *   heads       — signed by the hub key; untrusted/garbage heads rejected.
 *   gossip      — witnesses keep the highest seq per hub; a hub re-signing
 *                 the same seq with a different hash is flagged as a conflict
 *                 (the fraud alarm).
 *   proofs      — inclusion spans verify against a trusted observed head.
 *
 * @module tests/seed-log
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const seedLog = require('../src/core/seed-log.js');
const seeds = require('../src/core/seeds.js');

let tmpDir, registryDir, projectRoot, hubKey;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-seedlog-'));
  registryDir = path.join(tmpDir, 'registry');
  projectRoot = tmpDir;
  hubKey = seeds.ensureKeypair(projectRoot).publicKey;
});

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('chain append + verify', () => {
  test('appends link correctly and the log verifies intact', () => {
    const a = seedLog.appendLogEntry(registryDir, { action: 'publish', seedHash: 'aaaaaaaaaaaaaaaa' });
    const b = seedLog.appendLogEntry(registryDir, { action: 'publish', seedHash: 'bbbbbbbbbbbbbbbb' });
    const c = seedLog.appendLogEntry(registryDir, { action: 'retire', seedHash: 'bbbbbbbbbbbbbbbb' });
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    assert.equal(c.seq, 3);
    assert.equal(b.entryHash.slice(0, 8), seedLog.readLog(registryDir).entries[1].entryHash.slice(0, 8));

    const log = seedLog.readLog(registryDir);
    assert.equal(log.chainBroken, false);
    assert.equal(log.length, 3);
    assert.equal(log.entries[0].prevHash, ''); // chain anchor = empty string
    assert.equal(log.entries[1].prevHash, log.entries[0].entryHash);
  });

  test('rejects malformed entries before writing', () => {
    assert.throws(() => seedLog.appendLogEntry(registryDir, { action: 'explode', seedHash: 'aaaaaaaaaaaaaaaa' }));
    assert.throws(() => seedLog.appendLogEntry(registryDir, { action: 'publish', seedHash: 'not-a-hash' }));
  });

  test('tamper-evident: editing one line breaks verification at exactly that seq', () => {
    const file = path.join(registryDir, 'log', 'log.jsonl');
    const original = fs.readFileSync(file, 'utf8');
    const lines = original.split('\n');
    const e = JSON.parse(lines[1]); // seq 2
    e.action = 'retire';            // retroactive edit
    lines[1] = JSON.stringify(e);
    fs.writeFileSync(file, lines.join('\n'), 'utf8');

    const log = seedLog.readLog(registryDir);
    assert.equal(log.chainBroken, true);
    assert.equal(log.brokenAt, 2);
    assert.equal(log.length, 1); // entries before the break still parse

    fs.writeFileSync(file, original, 'utf8'); // restore
    assert.equal(seedLog.readLog(registryDir).chainBroken, false);
  });

  test('fail-closed: a broken log refuses new appends and refuses head signing', () => {
    const file = path.join(registryDir, 'log', 'log.jsonl');
    const original = fs.readFileSync(file, 'utf8');
    const lines = original.split('\n');
    const e = JSON.parse(lines[0]);
    e.seedHash = 'cccccccccccccccc'; // edit seq 1: poisons the whole chain
    lines[0] = JSON.stringify(e);
    fs.writeFileSync(file, lines.join('\n'), 'utf8');

    assert.throws(() => seedLog.appendLogEntry(registryDir, { action: 'publish', seedHash: 'dddddddddddddddd' }), /broken log/);
    assert.throws(() => seedLog.signHead(registryDir, projectRoot), /broken log/);

    fs.writeFileSync(file, original, 'utf8'); // restore
  });
});

describe('signed heads', () => {
  test('head is signed by the hub key and verifies against the trusted key', () => {
    const head = seedLog.signHead(registryDir, projectRoot);
    assert.equal(head.seq, 3);
    assert.equal(head.hubId, seeds.fingerprint(hubKey));
    assert.equal(seedLog.verifyHead(head, [hubKey]).ok, true);
  });

  test('untrusted hub, missing signature, and garbage all fail closed', () => {
    const head = seedLog.signHead(registryDir, projectRoot);
    assert.equal(seedLog.verifyHead(head, ['-----BEGIN OTHER KEY-----']).ok, false);
    assert.equal(seedLog.verifyHead({ ...head, signature: undefined }, [hubKey]).ok, false);
    const forged = { ...head, seq: 999 };
    assert.equal(seedLog.verifyHead(forged, [hubKey]).ok, false);
    assert.equal(seedLog.verifyHead(null, [hubKey]).ok, false);
  });

  test('signed head covers the hash — editing headHash invalidates the signature', () => {
    const head = seedLog.signHead(registryDir, projectRoot);
    const tampered = { ...head, headHash: 'f'.repeat(64) };
    assert.equal(seedLog.verifyHead(tampered, [hubKey]).ok, false);
  });
});

describe('gossip: witness reconciliation', () => {
  test('keeps the highest seq per hub; normal lag is not a conflict', () => {
    const head3 = seedLog.signHead(registryDir, projectRoot); // seq 3
    const r1 = seedLog.observeHeads(projectRoot, [head3], [hubKey]);
    assert.equal(r1.witnesses, 1);
    assert.equal(r1.conflicts.length, 0);

    // stale head (same seq, same hash) re-observed — lag, not fraud
    const r2 = seedLog.observeHeads(projectRoot, [head3], [hubKey]);
    assert.equal(r2.conflicts.length, 0);

    // advance the log, observe the newer head
    seedLog.appendLogEntry(registryDir, { action: 'publish', seedHash: 'eeeeeeeeeeeeeeee' });
    const head4 = seedLog.signHead(registryDir, projectRoot);
    assert.equal(head4.seq, 4);
    const r3 = seedLog.observeHeads(projectRoot, [head4], [hubKey]);
    assert.equal(r3.witnesses, 1);
    assert.equal(r3.conflicts.length, 0);

    // stale-but-valid head arrives late — ignored, no conflict, no rollback
    const r4 = seedLog.observeHeads(projectRoot, [head3], [hubKey]);
    assert.equal(r4.conflicts.length, 0);
    const witnessed = JSON.parse(fs.readFileSync(path.join(projectRoot, '.cortex', 'seed-log-heads.json'), 'utf8'));
    assert.equal(witnessed[head3.hubId].seq, 4);
  });

  test('FRAUD ALARM: same seq, different headHash → conflict recorded', () => {
    const head = seedLog.signHead(registryDir, projectRoot); // seq 5 (current)
    const evil = { ...head, headHash: 'a'.repeat(64) };      // same seq, different history — signature still valid because we re-sign? No:
    // A truly malicious hub would re-sign with its own (still trusted) key:
    const seedsCore = require('../src/core/seeds.js');
    const signedEvil = seedsCore.signArtifact; void signedEvil;
    // Re-sign the tampered head manually with the hub key to simulate a
    // malicious-but-trusted hub rewriting history.
    const crypto = require('node:crypto');
    const privPath = path.join(projectRoot, '.cortex', 'keys', 'signing.key');
    evil.signature = crypto.sign(null, Buffer.from(JSON.stringify({ ...evil, signature: undefined })), crypto.createPrivateKey(fs.readFileSync(privPath, 'utf8'))).toString('base64');

    const r = seedLog.observeHeads(projectRoot, [evil], [hubKey]);
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0].hubId, head.hubId);
    assert.equal(r.conflicts[0].seq, head.seq);
    assert.equal(r.conflicts[0].seenHash, 'a'.repeat(64));
    // and the witness file still holds OUR honest hash for that seq
    const witnessed = JSON.parse(fs.readFileSync(path.join(projectRoot, '.cortex', 'seed-log-heads.json'), 'utf8'));
    assert.equal(witnessed[head.hubId].headHash, head.headHash);
  });
});

describe('inclusion proofs', () => {
  test('proof verifies against the trusted observed head', () => {
    const head = seedLog.signHead(registryDir, projectRoot);
    seedLog.observeHeads(projectRoot, [head], [hubKey]);

    const proof = seedLog.inclusionProof(registryDir, 'aaaaaaaaaaaaaaaa');
    assert.equal(proof.ok, true);
    assert.equal(proof.fromSeq, 1);

    const v = seedLog.verifyInclusion(registryDir, 'aaaaaaaaaaaaaaaa', proof, head, [hubKey]);
    assert.equal(v.ok, true);
    assert.equal(v.seq, 1);

    const proof2 = seedLog.inclusionProof(registryDir, 'eeeeeeeeeeeeeeee');
    const v2 = seedLog.verifyInclusion(registryDir, 'eeeeeeeeeeeeeeee', proof2, head, [hubKey]);
    assert.equal(v2.ok, true);
    assert.equal(v2.seq, head.seq); // latest append
  });

  test('absent seed, untrusted head, stale head, and broken log all fail closed', () => {
    const head = seedLog.signHead(registryDir, projectRoot);
    const proof = seedLog.inclusionProof(registryDir, 'aaaaaaaaaaaaaaaa');

    assert.equal(seedLog.verifyInclusion(registryDir, 'ffffffffffffffff', proof, head, [hubKey]).ok, false);
    assert.equal(seedLog.verifyInclusion(registryDir, 'aaaaaaaaaaaaaaaa', proof, head, ['-----BEGIN NOPE-----']).ok, false);
    assert.equal(seedLog.verifyInclusion(registryDir, 'aaaaaaaaaaaaaaaa', null, head, [hubKey]).ok, false);

    // stale head: verifier holds head@3 but proof spans to seq 5
    const staleHead = { ...head, seq: 3 };
    assert.equal(seedLog.verifyInclusion(registryDir, 'aaaaaaaaaaaaaaaa', proof, staleHead, [hubKey]).ok, false);

    // broken log refuses proof generation
    const file = path.join(registryDir, 'log', 'log.jsonl');
    const original = fs.readFileSync(file, 'utf8');
    const lines = original.split('\n');
    const e = JSON.parse(lines[2]);
    e.publishedAt = '1999-01-01T00:00:00.000Z';
    lines[2] = JSON.stringify(e);
    fs.writeFileSync(file, lines.join('\n'), 'utf8');
    assert.equal(seedLog.inclusionProof(registryDir, 'aaaaaaaaaaaaaaaa').ok, false);
    fs.writeFileSync(file, original, 'utf8');
  });
});

describe('publish integration', () => {
  test('publishApproved appends to the hub log automatically', () => {
    const seedsDir = path.join(registryDir, 'seeds');
    const before = seedLog.readLog(registryDir).length;
    void seedsDir;
    // Publish a fresh approved lesson through the full pipeline
    const lessonsDir = path.join(tmpDir, 'lessons2');
    fs.mkdirSync(lessonsDir, { recursive: true });
    fs.writeFileSync(path.join(lessonsDir, 'f0f0f0f0f0f0f0f0-l.md'), [
      '---', 'id: f0f0f0f0f0f0f0f0', 'type: learning', 'scope: machine', 'confidence: 90',
      'sources: [1]', 'created_at: 2026-01-01T00:00:00.000Z', 'sanitized: true',
      'redaction_count: 0', 'generalization_rules: []', '---', '',
      '# Universal tool lesson', '', 'Always pin your dependency versions in CI and locally.', '',
    ].join('\n'), 'utf8');
    const { getDb, ensureSchema } = require('../src/core/db.js');
    process.env.AGENTIC_CORTEX_DB = path.join(tmpDir, 'pub.db');
    const db = getDb();
    ensureSchema(db);
    seeds.enqueueLessons(db, lessonsDir);
    const row = db.prepare("SELECT id FROM seed_review_queue WHERE status = 'pending'").get();
    seeds.reviewSeed(db, row.id, 'approved', { reviewedBy: 'test' });
    const r = seeds.publishApproved(db, registryDir, projectRoot);
    assert.equal(r.published, 1);

    const after = seedLog.readLog(registryDir);
    assert.equal(after.chainBroken, false);
    assert.equal(after.length, before + 1);
    assert.equal(after.entries[after.length - 1].action, 'publish');
    // and the log head still signs
    const head = seedLog.signHead(registryDir, projectRoot);
    assert.equal(head.seq, after.length);
  });
});
