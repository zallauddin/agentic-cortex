/**
 * yoink-lessons.test.js — Tests for the YOINK-inspired v7.5.0 features:
 * settleable claims (parse, refusals, settlement), confidence calibration
 * (gap + Brier from feedback events), the dead-memory audit, the
 * tamper-evident eval-log chain, and the vault rebuild.
 *
 * @module tests/yoink-lessons
 */

'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getDb } = require('../src/core/db');
const claims = require('../src/core/claims');
const calibration = require('../src/core/calibration');
const selfImprove = require('../src/core/self-improve');
const coreExport = require('../src/core/export');

const PROJECT = '/tmp/ac-yoink-test-proj';

process.env.AGENTIC_CORTEX_DB = process.env.AGENTIC_CORTEX_DB ||
  os.tmpdir().replace(/\\/g, '/') + '/ac-yoink-test-' + process.pid + '-' + Date.now() + '.db';

let db;

// ─── Claim parsing ───────────────────────────────────────────────────────

describe('claims.parseTest', () => {
  it('parses every supported op', () => {
    for (const [str, op, args] of [['gte 10', 'gte', [10]], ['lte 3.5', 'lte', [3.5]], ['gt 0', 'gt', [0]], ['lt 2', 'lt', [2]], ['eq 1', 'eq', [1]], ['between 2 4', 'between', [2, 4]]]) {
      const t = claims.parseTest(str);
      assert.ok(t, str);
      assert.equal(t.op, op);
      assert.deepEqual(t.args, args);
    }
  });

  it('refuses ungradeable tests', () => {
    assert.equal(claims.parseTest('goes up'), null);
    assert.equal(claims.parseTest('moon'), null);
    assert.equal(claims.parseTest('gte'), null);
    assert.equal(claims.parseTest('between 2'), null);
    assert.equal(claims.parseTest(''), null);
  });

  it('applies tests correctly', () => {
    assert.equal(claims.applyTest(claims.parseTest('gte 10000000'), 10000000), true);
    assert.equal(claims.applyTest(claims.parseTest('gte 10000000'), 8412998), false);
    assert.equal(claims.applyTest(claims.parseTest('between 2 4'), 3), true);
    assert.equal(claims.applyTest(claims.parseTest('between 2 4'), 5), false);
  });
});

describe('claims.parseSource', () => {
  it('parses the four source kinds', () => {
    assert.equal(claims.parseSource('file:data/readings.json#txcount').scheme, 'file');
    assert.equal(claims.parseSource('csv:bars.csv#close@2026-10-01').scheme, 'csv');
    assert.equal(claims.parseSource('chain:robinhood-testnet/eth_blockNumber').scheme, 'chain');
    assert.equal(claims.parseSource('manual:https://example.com/x').scheme, 'manual');
  });

  it('refuses non-sources', () => {
    assert.equal(claims.parseSource('nowhere'), null);
    assert.equal(claims.parseSource('gossip:coffee-machine'), null);
    assert.equal(claims.parseSource(''), null);
  });
});

// ─── Validation: the refusals ────────────────────────────────────────────

describe('claims.validateClaim (the refusals)', () => {
  const future = '2099-01-01';
  const now = new Date('2026-09-20T12:00:00Z');

  it('accepts a complete gradeable claim', () => {
    const v = claims.validateClaim({ claim: 'tx count at or above 10M', settles: future, reads: 'file:data.json#n', test: 'gte 10000000' }, { now });
    assert.equal(v.ok, true);
    assert.equal(v.meta.settles, future);
  });

  it('refuses a claim with no test', () => {
    const v = claims.validateClaim({ claim: 'x', settles: future, reads: 'file:d.json#n' }, { now });
    assert.equal(v.ok, false);
    assert.ok(v.errors.join(' ').includes('no test'));
  });

  it('refuses "it will moon" with the reason stated', () => {
    const v = claims.validateClaim({ claim: 'it will moon', settles: future, reads: 'chain:n/eth_blockNumber', test: 'goes up' }, { now });
    assert.equal(v.ok, false);
    assert.ok(v.errors.join(' ').includes('goes up'));
  });

  it('refuses betting on yesterday — past settle dates', () => {
    const v = claims.validateClaim({ claim: 'x', settles: '2020-01-01', reads: 'file:d.json#n', test: 'gte 5' }, { now });
    assert.equal(v.ok, false);
    assert.ok(v.errors.join(' ').includes('yesterday'));
  });

  it("refuses 'nowhere' as a source", () => {
    const v = claims.validateClaim({ claim: 'x', settles: future, reads: 'nowhere', test: 'gte 5' }, { now });
    assert.equal(v.ok, false);
    assert.ok(v.errors.join(' ').includes('nowhere'));
  });

  it('refuses a dateless claim', () => {
    const v = claims.validateClaim({ claim: 'x', reads: 'file:d.json#n', test: 'gte 5' }, { now });
    assert.equal(v.ok, false);
    assert.ok(v.errors.join(' ').includes('no settle date'));
  });

  it('refuses an empty claim attempt outright', () => {
    const v = claims.validateClaim({}, { now });
    assert.equal(v.ok, false);
    assert.deepEqual(v.errors, []);
  });
});

// ─── Settlement ──────────────────────────────────────────────────────────

describe('settlement', () => {
  before(() => {
    db = getDb();
    // Fixture data for file:/csv: sources
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-yoink-src-'));
    fs.writeFileSync(path.join(dir, 'readings.json'), JSON.stringify({ chain: { block: 8412998 } }));
    fs.writeFileSync(path.join(dir, 'bars.csv'), 'date,close\n2099-01-01,123.5\n');
    global.__yoinkSrcDir = dir;
  });

  async function saveClaim(overrides) {
    const r = await require('../src/api').save({
      title: 'Test claim',
      content: 'A claim about the future',
      type: 'commitment',
      project: PROJECT,
      skipDedup: true,
      skipSupersede: true,
      claim: 'block is high',
      settles: '2099-01-01',
      reads: 'file:' + path.join(global.__yoinkSrcDir, 'readings.json').replace(/\\/g, '/') + '#chain.block',
      test: 'gte 8000000',
      ...overrides,
    });
    return r;
  }

  it('save stores an open claim and returns it', async () => {
    const r = await saveClaim();
    assert.equal(r.claim.test, 'gte 8000000');
    const row = db.prepare('SELECT claim_meta, claim_status FROM observations WHERE id = ?').get(r.id);
    assert.equal(row.claim_status, 'open');
    assert.ok(JSON.parse(row.claim_meta).claim);
  });

  it('save refuses partial claims (settles without test)', async () => {
    await assert.rejects(
      () => saveClaim({ test: undefined }),
      /claim refused/
    );
  });

  it('settleDue reads a file source, applies the test, writes the outcome', async () => {
    const r = await saveClaim({ test: 'gte 8000000' });
    const result = await claims.settleDue(db, { project: PROJECT, now: new Date('2100-01-02T00:00:00Z') });
    const settled = result.settled.find(s => s.id === r.id);
    assert.ok(settled, 'claim should settle');
    assert.equal(settled.outcome, true);
    const row = db.prepare('SELECT claim_status, tags FROM observations WHERE id = ?').get(r.id);
    assert.equal(row.claim_status, 'settled');
    assert.ok(JSON.parse(row.tags).includes('claim-true'));
    const rec = db.prepare('SELECT * FROM claim_settlements WHERE observation_id = ?').get(r.id);
    assert.equal(rec.outcome, 1);
  });

  it('a settled claim cannot be settled again', async () => {
    const r = await saveClaim({ test: 'gte 1' });
    await claims.settleDue(db, { project: PROJECT, now: new Date('2100-01-02T00:00:00Z') });
    assert.throws(() => claims.settleWithValue(db, r.id, 5), /cannot be settled again/);
  });

  it('a false outcome writes claim-false', async () => {
    const r = await saveClaim({ test: 'lte 1' });
    await claims.settleDue(db, { project: PROJECT, now: new Date('2100-01-02T00:00:00Z') });
    const row = db.prepare('SELECT tags FROM observations WHERE id = ?').get(r.id);
    assert.ok(JSON.parse(row.tags).includes('claim-false'));
  });

  it('an unreadable source stays open rather than settling on a guess', async () => {
    const r = await saveClaim({ reads: 'file:/nonexistent/path.json#n', test: 'gte 1' });
    const result = await claims.settleDue(db, { project: PROJECT, now: new Date('2100-01-02T00:00:00Z') });
    const stayed = result.stayedOpen.find(o => o.id === r.id);
    assert.ok(stayed, 'should stay open');
    const row = db.prepare('SELECT claim_status FROM observations WHERE id = ?').get(r.id);
    assert.equal(row.claim_status, 'open');
  });

  it('csv source resolves a column on a date', async () => {
    const v = await claims.readSource('csv:' + path.join(global.__yoinkSrcDir, 'bars.csv').replace(/\\/g, '/') + '#close@2099-01-01', { project: PROJECT });
    assert.equal(v.value, 123.5);
  });

  it('manual source cannot be read by the machine', async () => {
    const v = await claims.readSource('manual:https://example.com/x');
    assert.ok(v.error && v.error.includes('manual'));
  });

  it('save-time sanity gate warns on prediction-shaped content without a claim', async () => {
    const r = await require('../src/api').save({
      title: 'Roadmap',
      content: 'We will ship v8 by 2099-01-01',
      type: 'commitment',
      project: PROJECT,
      skipDedup: true,
      skipSupersede: true,
    });
    assert.ok(r.warnings && r.warnings.length > 0, 'should warn');
    assert.ok(r.warnings[0].includes('verifiable claim'));
  });
});

// ─── Calibration ─────────────────────────────────────────────────────────

describe('calibration', () => {
  it('gradeBucket computes said/right/gap/brier', () => {
    const g = calibration.gradeBucket([
      { p: 0.75, outcome: 0 }, // said 75%, wrong
      { p: 0.25, outcome: 0 }, // said 25%, right
    ]);
    assert.equal(g.graded, 2);
    assert.equal(g.said, 50);
    assert.equal(g.right, 0);
    assert.equal(g.gap, 50);
    // brier = (0.75² + 0.25²)/2 = 0.3125 (rounded to 4 decimals)
    assert.equal(g.brier, 0.3125);
  });

  it('perfect calibration scores brier 0 and gap 0', () => {
    const g = calibration.gradeBucket([
      { p: 1, outcome: 1 }, { p: 0, outcome: 0 },
    ]);
    assert.equal(g.brier, 0);
    assert.equal(g.gap, 0);
  });

  it('report grades from feedback events with confidence snapshots', async () => {
    const api = require('../src/api');
    const a = await api.save({ title: 'Fact A', content: 'Fact A content', type: 'fact', project: PROJECT, confidence: 90, skipDedup: true, skipSupersede: true });
    const b = await api.save({ title: 'Fact B', content: 'Fact B content', type: 'fact', project: PROJECT, confidence: 20, skipDedup: true, skipSupersede: true });
    await api.feedback(a.id, { type: 'incorrect' });  // said 90, was wrong
    await api.feedback(b.id, { type: 'helpful' });    // said 20, was right

    const report = api.getCalibration({ project: PROJECT });
    assert.equal(report.record.graded, 2);
    assert.equal(report.record.said, 55);
    assert.equal(report.record.right, 50);
    assert.ok(Math.abs(report.record.gap - 5) < 0.01);
    assert.ok(report.byType.fact, 'per-type record exists');
    assert.ok(report.note.includes('feedback events'));
  });
});

// ─── Dead-memory audit ───────────────────────────────────────────────────

describe('dead-memory audit', () => {
  it('counts never-retrieved, unlinked, ungraded memories as dead', async () => {
    const api = require('../src/api');
    await api.save({ title: 'Orphan note ' + Date.now(), content: 'nothing links to me', type: 'observation', project: PROJECT, skipDedup: true, skipSupersede: true });
    // Force age beyond minAgeDays
    db.prepare("UPDATE observations SET created_at = datetime('now', '-30 days') WHERE title LIKE 'Orphan note%'").run();
    const audit = api.deadMemories({ project: PROJECT, minAgeDays: 1 });
    assert.ok(audit.dead >= 1);
    assert.ok(audit.total >= audit.dead);
    assert.equal(typeof audit.deadSharePct, 'number');
    assert.ok(audit.sample.length <= audit.dead);
  });
});

// ─── Tamper-evident eval log chain ───────────────────────────────────────

describe('eval-log hash chain', () => {
  it('writes a linked hash chain that verifies', () => {
    db.prepare('DELETE FROM evaluation_log').run();
    selfImprove.writeEvalLog(db, { project: PROJECT, verdict: 'SUCCESS', intentContent: 'i1', actionContent: 'a1', confidenceDelta: 1 });
    selfImprove.writeEvalLog(db, { project: PROJECT, verdict: 'FAILURE', intentContent: 'i2', actionContent: 'a2', confidenceDelta: -1 });
    const chain = selfImprove.verifyEvalLogChain(db, PROJECT);
    assert.equal(chain.ok, true);
    assert.equal(chain.checked, 2);
  });

  it('names the exact row after a single retroactive edit', () => {
    // The edit people actually make: change a verdict after a bad outcome.
    db.prepare("UPDATE evaluation_log SET llm_verdict = 'NEUTRAL' WHERE id = (SELECT MIN(id) FROM evaluation_log)").run();
    const chain = selfImprove.verifyEvalLogChain(db, PROJECT);
    assert.equal(chain.ok, false);
    assert.ok(chain.brokenAt != null);
    assert.ok(chain.reason.includes('edited after the fact'));
  });
});

// ─── Rebuild ─────────────────────────────────────────────────────────────

describe('rebuild from export', () => {
  it('wipes and rebuilds the vault from a JSON export, preserving claims', async () => {
    const api = require('../src/api');
    const before = await api.save({
      title: 'Survivor claim', content: 'rebuilt from export', type: 'commitment', project: PROJECT,
      claim: 'x', settles: '2099-01-01', reads: 'file:r.json#n', test: 'gte 1',
      skipDedup: true, skipSupersede: true,
    });
    const exported = coreExport.exportJSON(db, { project: PROJECT });

    const result = await coreExport.rebuildFromJSON(db, exported, { project: PROJECT });
    assert.ok(result.wiped.observations >= 1);
    assert.ok(result.saved >= 1);

    const row = db.prepare('SELECT claim_meta, claim_status FROM observations WHERE title = ?').get('Survivor claim');
    assert.ok(row, 'memory survived the rebuild');
    assert.equal(row.claim_status, 'open');
    assert.ok(JSON.parse(row.claim_meta).test);
    void before;
  });
});
