/**
 * seed-crdt.test.js — Federated grade counters (phase 3b).
 *
 * Properties under test:
 *   CRDT laws:    merge is commutative, associative, idempotent — replicas
 *                 converge regardless of sync order or duplication.
 *   Privacy:      state files contain only anonymous machine UUIDs and
 *                 counter increments — no hostnames, users, paths, content.
 *   Quorum:       computed locally from MERGED state; promote/retire verdicts
 *                 match thresholds; retireSeed deactivates failed seeds.
 *   Transport:    syncGrades merges all replica files in the registry clone
 *                 and writes back exactly one file per machine.
 *
 * @module tests/seed-crdt
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const crdt = require('../src/core/seed-crdt.js');
const { ensureSchema, getDb } = require('../src/core/db.js');

let db, tmpDir, registryDir;

const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const M3 = '33333333-3333-4333-8333-333333333333';
const S1 = 'aaaaaaaaaaaaaaaa';
const S2 = 'bbbbbbbbbbbbbbbb';

function stateOf(...entries) {
  let s = crdt.emptyState();
  for (const [machine, seed, grade] of entries) crdt.recordGrade(s, machine, seed, grade);
  return s;
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-crdt-'));
  registryDir = path.join(tmpDir, 'registry');
  process.env.AGENTIC_CORTEX_DB = path.join(tmpDir, 'test.db');
  db = getDb();
  ensureSchema(db);
});

after(() => {
  try { db.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  delete process.env.AGENTIC_CORTEX_DB;
});

describe('CRDT laws', () => {
  test('merge is commutative: merge(a,b) == merge(b,a)', () => {
    const a = stateOf([M1, S1, 'helpful']);
    const b = stateOf([M2, S1, 'not_helpful'], [M2, S2, 'helpful']);
    assert.deepEqual(crdt.mergeStates(a, b), crdt.mergeStates(b, a));
  });

  test('merge is idempotent: merge(a,a) == a', () => {
    const a = stateOf([M1, S1, 'helpful'], [M1, S1, 'helpful'], [M2, S1, 'not_helpful']);
    assert.deepEqual(crdt.mergeStates(a, a), a);
  });

  test('merge is associative: merge(merge(a,b),c) == merge(a,merge(b,c))', () => {
    const a = stateOf([M1, S1, 'helpful']);
    const b = stateOf([M2, S1, 'helpful']);
    const c = stateOf([M3, S1, 'not_helpful'], [M3, S2, 'helpful']);
    assert.deepEqual(crdt.mergeStates(crdt.mergeStates(a, b), c), crdt.mergeStates(a, crdt.mergeStates(b, c)));
  });

  test('replicas converge regardless of sync order', () => {
    const s1 = stateOf([M1, S1, 'helpful'], [M1, S2, 'not_helpful']);
    const s2 = stateOf([M2, S1, 'helpful']);
    const s3 = stateOf([M3, S1, 'not_helpful'], [M3, S2, 'helpful'], [M3, S2, 'helpful']);
    // three different gossip orders
    const o1 = crdt.mergeAll([s1, crdt.mergeAll([s2, s3])]);
    const o2 = crdt.mergeAll([s3, crdt.mergeAll([s2, s1])]);
    const o3 = crdt.mergeAll([crdt.mergeAll([s3, s1]), s2]);
    assert.deepEqual(o1, o2);
    assert.deepEqual(o1, o3);
    const agg = crdt.aggregate(o1);
    assert.equal(agg[S1].helpful, 2);
    assert.equal(agg[S1].not_helpful, 1);
    assert.equal(agg[S1].machines, 3);
    assert.equal(agg[S2].helpful, 2); // M3 graded twice — counter accumulates events; merge dedupes replication, not events
  });

  test('re-delivering an old state never decreases counts', () => {
    const fresh = stateOf([M1, S1, 'helpful'], [M2, S1, 'helpful']);
    const stale = stateOf([M1, S1, 'helpful']);
    assert.deepEqual(crdt.mergeStates(fresh, stale), fresh);
  });
});

describe('privacy', () => {
  test('state files carry only UUIDs + counters — no content or identity', () => {
    const machineId = crdt.ensureMachineId(tmpDir);
    const s = crdt.loadOwnState(registryDir, machineId);
    crdt.recordGrade(s, machineId, S1, 'helpful');
    crdt.saveOwnState(registryDir, machineId, s);
    const raw = fs.readFileSync(path.join(registryDir, 'grades', machineId + '.json'), 'utf8');
    assert.ok(!raw.includes(os.hostname()));
    assert.ok(!raw.includes(require('os').userInfo().username));
    assert.ok(!raw.includes(tmpDir.replace(/\\/g, '')));
    assert.ok(!/[A-Za-z]:\\\\/.test(raw), 'no paths in state');
    const parsed = JSON.parse(raw);
    assert.ok(parsed.counters[S1].helpful[machineId] >= 1);
    // machine id is a random UUID, not derived from hostname/user
    assert.match(machineId, /^[0-9a-f-]{36}$/);
  });

  test('machine id is stable across calls', () => {
    assert.equal(crdt.ensureMachineId(tmpDir), crdt.ensureMachineId(tmpDir));
  });
});

describe('local quorum from merged state', () => {
  test('verdicts: below minMachines keep, helpful promote, hostile retire', () => {
    const state = crdt.mergeAll([
      stateOf([M1, S1, 'helpful']),
      stateOf([M2, S1, 'helpful']),
      stateOf([M3, S1, 'helpful']),
      // S2: 3 machines, 1/3 helpful → retire
      stateOf([M1, S2, 'not_helpful']),
      stateOf([M2, S2, 'not_helpful']),
      stateOf([M3, S2, 'helpful']),
    ]);
    const q = crdt.quorum(state, { minMachines: 3, minHelpfulPct: 60 });
    const byHash = Object.fromEntries(q.map(r => [r.seedHash, r]));
    assert.equal(byHash[S1].verdict, 'promote');
    assert.equal(byHash[S2].verdict, 'retire');
    // a seed graded by only 2 machines stays 'keep' regardless
    const partial = crdt.mergeAll([stateOf([M1, 'cccccccccccccccc', 'not_helpful']), stateOf([M2, 'cccccccccccccccc', 'not_helpful'])]);
    assert.equal(crdt.quorum(partial, { minMachines: 3 })[0].verdict, 'keep');
  });
});

describe('syncGrades over the registry clone', () => {
  test('merges all replica files, writes back one file per machine, retires failed seeds', () => {
    // two foreign replicas "git-pulled" into the registry + our own via gradeSeed
    fs.mkdirSync(path.join(registryDir, 'grades'), { recursive: true });
    fs.writeFileSync(path.join(registryDir, 'grades', M1 + '.json'), JSON.stringify(stateOf([M1, S1, 'helpful'], [M1, S2, 'not_helpful'])));
    fs.writeFileSync(path.join(registryDir, 'grades', M2 + '.json'), JSON.stringify(stateOf([M2, S1, 'helpful'], [M2, S2, 'not_helpful'])));

    // local vault: an imported seed for S2 so retirement has something to hit
    db.prepare(`INSERT INTO observations (project_path, type, title, content, tags, importance, confidence, provenance, is_active)
                VALUES ('/p', 'learning', 'seed S2', 'body', '["origin:community","seed_hash:${S2}"]', 4, 55, 'seeded', 1)`).run();
    const obsId = db.prepare("SELECT id FROM observations WHERE title = 'seed S2'").get().id;

    // our machine grades S2 not_helpful through the real gradeSeed path —
    // now 3 machines have graded S2 and quorum applies
    const seedsCore = require('../src/core/seeds.js');
    seedsCore.gradeSeed(db, obsId, 'not_helpful', { registry: registryDir, projectRoot: tmpDir });

    const r = crdt.syncGrades(db, registryDir, { projectRoot: tmpDir, minMachines: 3, minHelpfulPct: 60 });
    assert.equal(r.replicas, 3); // M1, M2, ours
    assert.equal(r.seedsTracked, 2);
    const byHash = Object.fromEntries(r.quorum.map(q => [q.seedHash, q]));
    assert.equal(byHash[S1].verdict, 'promote');   // S1 has no local obs; verdict only
    assert.equal(byHash[S2].verdict, 'retire');
    assert.ok(r.retired.includes(S2));
    const after = db.prepare('SELECT is_active FROM observations WHERE id = ?').get(obsId);
    assert.equal(after.is_active, 0);
    // our replica file exists, others untouched
    const files = fs.readdirSync(path.join(registryDir, 'grades'));
    assert.equal(files.length, 3);
    assert.ok(files.includes(crdt.ensureMachineId(tmpDir) + '.json'));
  });

  test('sync is idempotent — running twice changes nothing', () => {
    const before = JSON.parse(fs.readFileSync(path.join(tmpDir, '.cortex', 'seed-grades-merged.json'), 'utf8'));
    crdt.syncGrades(db, registryDir, { projectRoot: tmpDir, minMachines: 3, minHelpfulPct: 60 });
    const after = JSON.parse(fs.readFileSync(path.join(tmpDir, '.cortex', 'seed-grades-merged.json'), 'utf8'));
    assert.deepEqual(before, after);
  });
});
