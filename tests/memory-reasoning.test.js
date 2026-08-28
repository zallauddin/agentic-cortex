'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const prm = require('../src/core/prm');
const treeSearch = require('../src/core/tree-search');
const { ensureSchema } = require('../src/core/db');

const dbs = [];

function createTestDb() {
  const db = new Database(':memory:');
  ensureSchema(db);
  dbs.push(db);
  return db;
}

beforeEach(() => { dbs.length = 0; });
afterEach(() => {
  for (const db of dbs.splice(0)) {
    try { db.close(); } catch { /* ignore */ }
  }
});

/** A memory-shaped search result. */
function mem(overrides = {}) {
  return {
    id: Math.floor(Math.random() * 1e6),
    title: 'title',
    content: 'content',
    confidence: 80,
    type: 'fact',
    ...overrides,
  };
}

// ─── PRM: memory as a bidirectional scorer ────────────────────────────

describe('PRM memory evidence (verifyAgainstMemory)', () => {
  it('boosts a step corroborated by a confident, same-polarity memory', async () => {
    const searchFn = async () => [
      mem({
        type: 'fact',
        title: 'retry policy',
        content: 'the retry loop uses exponential backoff with jitter and a five second cap',
        confidence: 85,
      }),
    ];
    // Step and memory share the claim (no negation on either side) and
    // overlap on retry/backoff/jitter vocabulary.
    const r = await prm.verifyAgainstMemory('the retry loop uses exponential backoff with jitter', 'p', { searchFn });
    assert.equal(r.valid, true);
    assert.equal(r.corroboratingMemories.length, 1, 'matching-polarity memory corroborates');
    assert.equal(r.contradictingMemories.length, 0);
    assert.ok(r.score >= 0.85, 'corroboration raises the base 0.8 by 0.05: got ' + r.score);
    assert.ok(r.reason.includes('Corroborated by 1'), 'reason names the corroboration');
  });

  it('penalizes a step contradicted by an opposite-polarity learning', async () => {
    const searchFn = async () => [
      mem({
        type: 'learning',
        title: 'retry loop outage',
        content: 'the retry loop is NOT stable — it caused repeated outages and must not be deployed',
        confidence: 90,
      }),
    ];
    // Step asserts stability; the learning denies it (polarity differs).
    const r = await prm.verifyAgainstMemory('the retry loop is stable and safe to deploy', 'p', { searchFn });
    assert.equal(r.contradictingMemories.length, 1, 'opposite-polarity learning contradicts');
    assert.equal(r.corroboratingMemories.length, 0);
    assert.ok(r.score < 0.5, 'contradiction drops the step below the bar: got ' + r.score);
    assert.ok(r.reason.includes('contradicting'), 'reason names the contradiction');
  });

  it('uses pre-retrieved memories without re-searching (tree-search threading)', async () => {
    let calls = 0;
    const searchFn = async () => { calls++; return []; };
    const evidence = [mem({ type: 'standard', title: 'gateway', content: 'gateway timeouts should use exponential backoff', confidence: 90 })];
    const r = await prm.verifyAgainstMemory('gateway timeouts should use exponential backoff', 'p', { searchFn, memories: evidence });
    assert.equal(calls, 0, 'searchFn not called when memories are pre-provided');
    assert.equal(r.corroboratingMemories.length, 1);
    assert.ok(r.score >= 0.85);
  });

  it('stays neutral and marks the evidence as a blind spot when no search is available', async () => {
    const r = await prm.verifyAgainstMemory('any step', 'p', { searchFn: null });
    assert.equal(r.valid, true);
    assert.equal(r.score, 0.5);
    assert.equal(r.blindSpot, true);
    assert.deepEqual(r.evidenceCoverage, { resultCount: 0, types: [], hasDissent: false });
  });

  it('marks one-sided evidence as a blind spot instead of calling it complete', async () => {
    const r = await prm.verifyAgainstMemory('retry uses exponential backoff', 'p', {
      searchFn: async () => [mem({ type: 'fact', title: 'retry', content: 'retry uses exponential backoff', confidence: 90 })],
    });
    assert.equal(r.blindSpot, true);
    assert.deepEqual(r.evidenceCoverage.types, ['fact']);
    assert.equal(r.evidenceCoverage.hasDissent, false);
  });
});

// ─── PRM: outcome-weighted corroboration ─────────────────────────────

describe('PRM outcome-weighted corroboration', () => {
  // Corroborating memory: same polarity, confident fact, high overlap.
  const fact = (overrides = {}) => mem({
    type: 'fact',
    title: 'retry policy',
    content: 'the retry loop uses exponential backoff with jitter',
    confidence: 85,
    ...overrides,
  });
  const step = 'the retry loop uses exponential backoff with jitter';

  it('a proven-good memory corroborates stronger than an unproven one', async () => {
    // Same bearing memory; the proven-good one has a weight record attached
    // directly (as api.search would after applyOutcomeWeights).
    const proven = await prm.verifyAgainstMemory(step, 'p', {
      searchFn: async () => [fact({ outcome_weight: 1, outcome_runs: 3 })],
    });
    const baseline = await prm.verifyAgainstMemory(step, 'p', {
      searchFn: async () => [fact({})],
    });
    assert.ok(proven.score > baseline.score,
      'proven-good corroboration outranks unproven: ' + proven.score + ' vs ' + baseline.score);
    assert.ok(proven.outcomeBoosted, 'proven-good boosts the outcome flag');
    assert.equal(proven.corroboratingMemories[0].boost, 0.05 + 1 * 0.05, 'weight 1 → +0.05 boost');
  });

  it('a proven-bad memory corroborates weaker than an unproven one', async () => {
    const bad = await prm.verifyAgainstMemory(step, 'p', {
      searchFn: async () => [fact({ outcome_weight: -1, outcome_runs: 3 })],
    });
    const baseline = await prm.verifyAgainstMemory(step, 'p', {
      searchFn: async () => [fact({})],
    });
    assert.ok(bad.score < baseline.score,
      'proven-bad corroboration outranks baseline down: ' + bad.score + ' vs ' + baseline.score);
    assert.ok(bad.outcomeBoosted, 'proven-bad also flags outcome weighting');
    assert.equal(bad.corroboratingMemories[0].boost, 0, 'weight -1 → baseline boost canceled (0)');
  });

  it('reads outcome stats from the db when memories carry no weight', async () => {
    const db = createTestDb();
    const selfImprove = require('../src/core/self-improve');
    // Seed two observations: one proven-good, one never evaluated.
    const ins = db.prepare(
      'INSERT INTO observations (project_path, type, title, content, tags, importance, confidence, provenance, agent_id) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    const goodId = Number(ins.run('p', 'fact', 'retry policy', 'the retry loop uses exponential backoff with jitter', '[]', 7, 85, 'observed', 'a').lastInsertRowid);
    ins.run('p', 'fact', 'retry policy copy', 'the retry loop uses exponential backoff', '[]', 7, 85, 'observed', 'a');
    for (let i = 0; i < 2; i++) {
      selfImprove.writeEvalLog(db, { project: 'p', intentContent: 'i', actionContent: 'a', outcomeContent: 'o', verdict: 'SUCCESS', injectedObservationIds: [goodId] });
    }

    const searchFn = async () => [mem({ id: goodId, type: 'fact', title: 'retry policy', content: 'the retry loop uses exponential backoff with jitter', confidence: 85 })];
    const r = await prm.verifyAgainstMemory(step, 'p', { db, searchFn });
    assert.ok(r.outcomeBoosted, 'db-provided outcome stats applied');
    assert.equal(r.corroboratingMemories[0].outcome_weight, 1, 'weight from db correlation');
    assert.equal(r.corroboratingMemories[0].outcome_runs, 2);
  });

  it('stays boolean-neutral when only unproven memories corroborate', async () => {
    const r = await prm.verifyAgainstMemory(step, 'p', {
      searchFn: async () => [fact({})],
    });
    assert.equal(r.outcomeBoosted, false, 'no weight signal → not outcome-boosted');
  });
});

describe('PRM verifyStep with memory evidence', () => {
  it('carries corroboration into the combined tier score', async () => {
    const searchFn = async () => [
      mem({ type: 'fact', title: 'backoff', content: 'the retry strategy uses exponential backoff with jitter', confidence: 88 }),
    ];
    const verification = await prm.verifyStep({
      stepContent: 'the retry strategy uses exponential backoff with jitter because the gateway failed under load',
      priorSteps: [],
      problem: 'harden the gateway retry loop',
      project: 'p',
      searchFn,
    });
    assert.ok(verification.details.memory, 'memory tier present in details');
    assert.equal(verification.details.memory.corroboratingMemories.length, 1, 'brain evidence flows into step verification');
    assert.ok(verification.valid, 'corroborated step verifies');
    assert.ok(verification.score >= 0.5, 'combined score reflects the memory boost');
  });

  it('verifyChain threads the same evidence across every step', async () => {
    const searchFn = async () => [
      mem({ type: 'decision', title: 'backoff', content: 'we decided retries use exponential backoff with jitter', confidence: 90 }),
    ];
    const r = await prm.verifyChain({
      steps: ['the retry strategy uses exponential backoff with jitter', 'backoff with jitter prevents thundering herd'],
      problem: 'harden the gateway retry loop',
      project: 'p',
      searchFn,
    });
    assert.equal(r.steps.length, 2);
    for (const s of r.steps) {
      assert.ok(s.reason, 'each step carries a verdict');
    }
  });

  it('verifyStep weights corroboration via outcomeStats threaded from db', async () => {
    const db = createTestDb();
    const selfImprove = require('../src/core/self-improve');
    const ins = db.prepare(
      'INSERT INTO observations (project_path, type, title, content, tags, importance, confidence, provenance, agent_id) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    const goodId = Number(ins.run('p', 'fact', 'backoff', 'the retry strategy uses exponential backoff with jitter', '[]', 7, 88, 'observed', 'a').lastInsertRowid);
    selfImprove.writeEvalLog(db, { project: 'p', intentContent: 'i', actionContent: 'a', outcomeContent: 'o', verdict: 'SUCCESS', injectedObservationIds: [goodId] });
    selfImprove.writeEvalLog(db, { project: 'p', intentContent: 'i', actionContent: 'a', outcomeContent: 'o', verdict: 'SUCCESS', injectedObservationIds: [goodId] });

    const searchFn = async () => [mem({ id: goodId, type: 'fact', title: 'backoff', content: 'the retry strategy uses exponential backoff with jitter', confidence: 88 })];
    const verification = await prm.verifyStep({
      stepContent: 'the retry strategy uses exponential backoff with jitter because the gateway failed under load',
      priorSteps: [],
      problem: 'harden the gateway retry loop',
      project: 'p',
      db,
      searchFn,
    });
    assert.ok(verification.valid);
    assert.equal(verification.details.memory.corroboratingMemories[0].outcome_weight, 1,
      'db-correlated proven-good weight threads through verifyStep');
    assert.equal(verification.details.memory.outcomeBoosted, true);
  });
});

// ─── tree-search: node scoring argues from memory ────────────────────

describe('tree-search memory-grounded scoring', () => {
  it('threads one brain consult into every node and branch', async () => {
    const db = createTestDb();
    let calls = 0;
    const searchFn = async () => {
      calls++;
      return [mem({
        type: 'fact',
        title: 'token budget',
        content: 'the token budget calculation caps total tokens per session at one hundred thousand',
        confidence: 85,
      })];
    };

    const trace = await treeSearch.search({
      problem: 'optimize the token budget calculation',
      project: 'p',
      strategy: 'beam',
      db,
      searchFn,
      budgetOverrides: { beamWidth: 2, maxDepth: 2, tokenBudget: 100000 },
    });

    assert.equal(calls, 1, 'the brain is consulted once per search, not once per node');
    assert.ok(trace.tree.length > 1, 'search produced nodes');

    // Every verified node carries the memory evidence it was scored against.
    const verified = trace.tree.filter(n => n.verificationResult && n.verificationResult.reason);
    assert.ok(verified.length > 0, 'nodes were verified');
    const withEvidence = verified.filter(n =>
      n.verificationResult.memory &&
      (n.verificationResult.memory.corroborating || []).length > 0);
    assert.ok(withEvidence.length > 0, 'at least one node was corroborated by the brain evidence');
  });

  it('generateBranches accepts memory evidence without breaking the LLM fallback', async () => {
    const branches = await treeSearch.generateBranches({
      problem: 'optimize the token budget calculation',
      currentChain: [],
      branchCount: 2,
      budget: 500,
      memories: [mem({ type: 'fact', title: 'token budget', content: 'the token budget calculation caps tokens per session', confidence: 85 })],
    });
    assert.ok(Array.isArray(branches) && branches.length > 0, 'fallback branches still produced');
    assert.ok(branches.every(b => b.content && b.type), 'each branch well-formed');
  });
});
