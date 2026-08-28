'use strict';

const assert = require('assert');
const { describe, it, beforeEach } = require('node:test');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../src/core/db');
const selfImprove = require('../src/core/self-improve');
const search = require('../src/core/search');

// Frontier 2/3: deterministic anti-blind-spot retrieval checks.
describe('coverage-aware retrieval', () => {
  it('diversifies repeated clusters and reports missing dissent', () => {
    const results = [
      { id: 1, title: 'retry policy', type: 'fact', combined_score: 0.95 },
      { id: 2, title: 'retry policy details', type: 'fact', combined_score: 0.94 },
      { id: 3, title: 'retry outage failure', type: 'error', combined_score: 0.70 },
    ];
    const diversified = search.diversifyResults(results, { limit: 3, lambda: 0.5 });
    assert.equal(diversified.length, 3);
    assert.equal(diversified[0].id, 1);
    assert.ok(diversified.some(r => r.id === 3), 'dissenting evidence remains visible');
    const report = search.buildCoverageReport('retry policy', diversified);
    assert.equal(report.coverage, 'covered');
    assert.equal(report.probe, null);
  });

  it('creates an explicit probe for empty or one-sided retrieval', () => {
    const report = search.buildCoverageReport('new migration risk', [{ id: 1, type: 'fact', combined_score: 0.8 }]);
    assert.equal(report.coverage, 'partial');
    assert.ok(report.blindSpots.includes('single_memory_type'));
    assert.ok(report.blindSpots.includes('no_dissenting_evidence'));
    assert.equal(report.probe.status, 'open');
    assert.match(report.probe.query, /disprove or qualify/);
  });
});

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  return db;
}

function seedObservation(db, project, title, content, type = 'learning') {
  return Number(
    db.prepare(
      'INSERT INTO observations (project_path, type, title, content, tags, importance, confidence, provenance, agent_id) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(project, type, title, content, '["test"]', 7, 90, 'observed', 'agent-1').lastInsertRowid
  );
}

// ─── writeEvalLog + recordEvalInjections ────────────────────────────

describe('eval-memory injection recording', () => {
  let db;
  const project = '/proj';

  beforeEach(() => { db = createTestDb(); });

  it('records injectedObservationIds when writeEvalLog is called', () => {
    const obsA = seedObservation(db, project, 'Alpha lesson', 'alpha lesson content');
    const obsB = seedObservation(db, project, 'Beta lesson', 'beta lesson content');
    const evalId = selfImprove.writeEvalLog(db, {
      project,
      intentContent: 'fix the bug',
      actionContent: 'applied a patch',
      outcomeContent: 'tests now pass',
      verdict: 'SUCCESS',
      verdictReason: 'verified',
      injectedObservationIds: [obsA, obsB],
    });
    assert.ok(evalId > 0);
    const rows = db.prepare('SELECT observation_id FROM eval_memory_injections WHERE eval_log_id = ? ORDER BY observation_id').all(evalId);
    assert.deepEqual(rows.map(r => r.observation_id), [obsA, obsB]);
  });

  it('dedupes repeated (eval, observation) pairs', () => {
    const obsA = seedObservation(db, project, 'Alpha lesson', 'alpha content');
    selfImprove.recordEvalInjections(db, 99, [obsA, obsA, obsA], { project });
    const n = db.prepare('SELECT COUNT(*) c FROM eval_memory_injections WHERE eval_log_id = 99').get().c;
    assert.equal(n, 1);
  });

  it('skips non-numeric observation ids silently', () => {
    const r = selfImprove.recordEvalInjections(db, 5, [0, 'x', null], { project });
    assert.deepEqual(r, { linked: 0 });
  });
});

// ─── memoryOutcomeStats ─────────────────────────────────────────────

describe('memoryOutcomeStats', () => {
  let db;
  const project = '/proj';

  beforeEach(() => { db = createTestDb(); });

  function seedEvalWithObs(obsId, verdict) {
    return selfImprove.writeEvalLog(db, {
      project,
      intentContent: 'intent',
      actionContent: 'action',
      outcomeContent: 'outcome',
      verdict,
      injectedObservationIds: [obsId],
    });
  }

  it('correlates injected memories with success and failure verdicts', () => {
    const good = seedObservation(db, project, 'Good lesson', 'good content');
    const bad = seedObservation(db, project, 'Bad lesson', 'bad content');
    seedEvalWithObs(good, 'SUCCESS');
    seedEvalWithObs(good, 'REINFORCE');
    seedEvalWithObs(bad, 'FAILURE');
    seedEvalWithObs(bad, 'FAILURE');

    const stats = selfImprove.memoryOutcomeStats(db, project);
    assert.equal(stats.get(good).runs, 2);
    assert.equal(stats.get(good).successes, 2);
    assert.equal(stats.get(good).weight, 1); // 2/2 successes
    assert.equal(stats.get(bad).runs, 2);
    assert.equal(stats.get(bad).failures, 2);
    assert.equal(stats.get(bad).weight, -1); // 0/2 successes
  });

  it('keeps weight zero below the min-runs threshold', () => {
    const once = seedObservation(db, project, 'Once lesson', 'once content');
    seedEvalWithObs(once, 'SUCCESS');
    const stats = selfImprove.memoryOutcomeStats(db, project);
    assert.equal(stats.get(once).runs, 1);
    assert.equal(stats.get(once).weight, 0); // 1 run < minRuns 2
  });

  it('counts NEUTRAL verdicts toward runs but neither side', () => {
    const neutral = seedObservation(db, project, 'Neutral lesson', 'neutral content');
    seedEvalWithObs(neutral, 'NEUTRAL');
    seedEvalWithObs(neutral, 'NEUTRAL');
    const stats = selfImprove.memoryOutcomeStats(db, project, { minRuns: 1 });
    assert.equal(stats.get(neutral).runs, 2);
    assert.equal(stats.get(neutral).successes, 0);
    assert.equal(stats.get(neutral).failures, 0);
    assert.equal(stats.get(neutral).weight, 0); // no signal either way
  });

  it('scopes stats to the given project', () => {
    const other = seedObservation(db, '/other', 'Other lesson', 'other content');
    selfImprove.writeEvalLog(db, {
      project: '/other',
      intentContent: 'intent',
      actionContent: 'action',
      outcomeContent: 'outcome',
      verdict: 'SUCCESS',
      injectedObservationIds: [other],
    });
    selfImprove.writeEvalLog(db, {
      project: '/other',
      intentContent: 'intent',
      actionContent: 'action',
      outcomeContent: 'outcome',
      verdict: 'SUCCESS',
      injectedObservationIds: [other],
    });
    const stats = selfImprove.memoryOutcomeStats(db, project);
    assert.equal(stats.size, 0); // injections recorded under /other, not /proj
  });
});

// ─── applyOutcomeWeights ────────────────────────────────────────────

describe('applyOutcomeWeights', () => {
  let db;
  const project = '/proj';

  beforeEach(() => { db = createTestDb(); });

  function seedEval(obsId, verdict) {
    return selfImprove.writeEvalLog(db, {
      project,
      intentContent: 'i',
      actionContent: 'a',
      outcomeContent: 'o',
      verdict,
      injectedObservationIds: [obsId],
    });
  }

  it('boosts memories injected into successful evals and re-sorts', () => {
    const good = seedObservation(db, project, 'Good lesson', 'good lesson content');
    const plain = seedObservation(db, project, 'Plain lesson', 'plain lesson content');
    seedEval(good, 'SUCCESS');
    seedEval(good, 'SUCCESS');

    const results = [
      { id: plain, title: 'Plain lesson', rerank_score: 0.9 },
      { id: good, title: 'Good lesson', rerank_score: 0.85 },
    ];
    const out = search.applyOutcomeWeights(db, results, { project });
    const byId = Object.fromEntries(out.map(r => [r.id, r]));
    assert.equal(byId[good].outcome_weight, 1);
    assert.equal(byId[good].outcome_runs, 2);
    assert.ok(byId[good].rerank_score > 0.85, 'good memory boosted past plain');
    assert.equal(out[0].id, good, 'boosted memory ranks first');
  });

  it('demotes memories injected into failed evals', () => {
    const bad = seedObservation(db, project, 'Bad lesson', 'bad lesson content');
    const plain = seedObservation(db, project, 'Plain lesson', 'plain lesson content');
    seedEval(bad, 'FAILURE');
    seedEval(bad, 'FAILURE');

    const results = [
      { id: plain, title: 'Plain lesson', rerank_score: 0.5 },
      { id: bad, title: 'Bad lesson', rerank_score: 0.7 },
    ];
    const out = search.applyOutcomeWeights(db, results, { project, delta: 0.3 });
    const byId = Object.fromEntries(out.map(r => [r.id, r]));
    assert.equal(byId[bad].outcome_weight, -1);
    assert.equal(byId[bad].rerank_score, 0.4); // 0.7 - 0.3
    assert.equal(out[0].id, plain, 'plain result outranks demoted one');
  });

  it('attaches zero outcome fields when there is no recorded history', () => {
    const fresh = seedObservation(db, project, 'Fresh lesson', 'fresh lesson content');
    const results = [{ id: fresh, title: 'Fresh lesson', combined_score: 0.4 }];
    const out = search.applyOutcomeWeights(db, results, { project });
    assert.equal(out[0].outcome_weight, 0);
    assert.equal(out[0].outcome_runs, 0);
    assert.equal(out[0].combined_score, 0.4, 'score untouched below threshold');
  });

  it('clamps adjusted scores into [0, 1]', () => {
    const good = seedObservation(db, project, 'Good lesson', 'good lesson content');
    seedEval(good, 'SUCCESS');
    seedEval(good, 'SUCCESS');
    const results = [{ id: good, title: 'Good lesson', rerank_score: 0.98 }];
    const out = search.applyOutcomeWeights(db, results, { project });
    assert.ok(out[0].rerank_score <= 1, 'boost does not exceed 1');
  });

  it('returns the results untouched when stats are empty', () => {
    const results = [{ id: 1, title: 'x', combined_score: 0.3 }];
    const out = search.applyOutcomeWeights(db, results, { project: '/empty' });
    assert.equal(out.length, 1);
    assert.equal(out[0].outcome_weight, 0);
  });

  it('falls back to secondary sort by outcome weight for keyword-only results', () => {
    const good = seedObservation(db, project, 'Good lesson', 'good lesson content');
    seedEval(good, 'SUCCESS');
    seedEval(good, 'SUCCESS');
    const results = [
      { id: 999, title: 'No history' },
      { id: good, title: 'Good lesson' },
    ];
    const out = search.applyOutcomeWeights(db, results, { project });
    assert.equal(out[0].id, good, 'keyword-only result with positive weight sorts first');
  });
});

// ─── attachOutcomeFields ────────────────────────────────────────────

describe('attachOutcomeFields', () => {
  let db;
  const project = '/proj';

  beforeEach(() => { db = createTestDb(); });

  function seedEval(obsId, verdict) {
    selfImprove.writeEvalLog(db, {
      project,
      intentContent: 'i',
      actionContent: 'a',
      outcomeContent: 'o',
      verdict,
      injectedObservationIds: [obsId],
    });
  }

  it('attaches outcome fields without reordering', () => {
    const good = seedObservation(db, project, 'Good lesson', 'good lesson content');
    const plain = seedObservation(db, project, 'Plain lesson', 'plain lesson content');
    seedEval(good, 'SUCCESS');
    seedEval(good, 'SUCCESS');

    const results = [
      { id: plain, title: 'Plain lesson' },
      { id: good, title: 'Good lesson' },
    ];
    const out = search.attachOutcomeFields(db, results, { project });
    // Order preserved — distinct from applyOutcomeWeights.
    assert.deepEqual(out.map(r => r.title), ['Plain lesson', 'Good lesson']);
    const byId = Object.fromEntries(out.map(r => [r.id, r]));
    assert.equal(byId[good].outcome_weight, 1);
    assert.equal(byId[good].outcome_runs, 2);
    assert.equal(byId[plain].outcome_weight, 0);
    assert.equal(byId[plain].outcome_runs, 0);
  });

  it('spans all projects when no project filter is given', () => {
    const goodA = seedObservation(db, '/proj-a', 'Good A', 'good a content');
    seedEval(goodA, 'SUCCESS');
    seedEval(goodA, 'SUCCESS');

    const results = [{ id: goodA, title: 'Good A' }];
    const out = search.attachOutcomeFields(db, results); // no project → cross-project
    assert.equal(out[0].outcome_weight, 1, 'stat found across projects by observation id');
    assert.equal(out[0].outcome_runs, 2);
  });

  it('returns zeros for memories outside the scoped project', () => {
    const goodA = seedObservation(db, '/proj-a', 'Good A', 'good a content');
    for (let i = 0; i < 2; i++) {
      selfImprove.writeEvalLog(db, { project: '/proj-a', intentContent: 'i', actionContent: 'a', outcomeContent: 'o', verdict: 'SUCCESS', injectedObservationIds: [goodA] });
    }
    const results = [{ id: goodA, title: 'Good A' }];
    // Scoped to /proj, but the stat lives under /proj-a → zero.
    const out = search.attachOutcomeFields(db, results, { project: '/proj' });
    assert.equal(out[0].outcome_weight, 0);
    assert.equal(out[0].outcome_runs, 0);
  });
});

// ─── Auto-link: search → pending → writeEvalLog ─────────────────────

describe('auto-link from search to eval', () => {
  let db;
  const project = '/proj';

  beforeEach(() => { db = createTestDb(); });

  function seedEval(verdict, extra = {}) {
    return selfImprove.writeEvalLog(db, {
      project,
      intentContent: 'i',
      actionContent: 'a',
      outcomeContent: 'o',
      verdict,
      ...extra,
    });
  }

  it('links search-returned observations when writeEvalLog gets no explicit ids', () => {
    const obsA = seedObservation(db, project, 'Alpha lesson', 'alpha lesson content');
    const obsB = seedObservation(db, project, 'Beta lesson', 'beta lesson content');
    selfImprove.recordSearchInjections(db, project, [obsA, obsB]);

    const evalId = seedEval('SUCCESS');
    const rows = db.prepare('SELECT observation_id FROM eval_memory_injections WHERE eval_log_id = ? ORDER BY observation_id').all(evalId);
    assert.deepEqual(rows.map(r => r.observation_id), [obsA, obsB], 'pending search results auto-linked');
  });

  it('consumes pending rows after linking — a second eval does not re-link them', () => {
    const obsA = seedObservation(db, project, 'Alpha lesson', 'alpha lesson content');
    selfImprove.recordSearchInjections(db, project, [obsA]);

    const eval1 = seedEval('SUCCESS');
    const eval2 = seedEval('FAILURE');
    const rows = db.prepare('SELECT eval_log_id FROM eval_memory_injections WHERE observation_id = ?').all(obsA);
    assert.deepEqual(rows.map(r => r.eval_log_id), [eval1], 'linked only to the consuming eval');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM pending_eval_injections').get().c, 0, 'pending consumed');
  });

  it('keeps explicit injectedObservationIds authoritative and leaves pending alone', () => {
    const obsA = seedObservation(db, project, 'Alpha lesson', 'alpha lesson content');
    const obsB = seedObservation(db, project, 'Beta lesson', 'beta lesson content');
    selfImprove.recordSearchInjections(db, project, [obsA]);

    const evalId = seedEval('SUCCESS', { injectedObservationIds: [obsB] });
    const rows = db.prepare('SELECT observation_id FROM eval_memory_injections WHERE eval_log_id = ?').all(evalId);
    assert.deepEqual(rows.map(r => r.observation_id), [obsB], 'explicit ids win');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM pending_eval_injections').get().c, 1, 'pending not consumed');
  });

  it('does not link stale pending rows older than the window', () => {
    const obsA = seedObservation(db, project, 'Alpha lesson', 'alpha lesson content');
    selfImprove.recordSearchInjections(db, project, [obsA]);
    // Age the pending row beyond the 60-minute default window.
    db.prepare("UPDATE pending_eval_injections SET searched_at = datetime('now', '-120 minutes')").run();

    const evalId = seedEval('SUCCESS');
    const rows = db.prepare('SELECT observation_id FROM eval_memory_injections WHERE eval_log_id = ?').all(evalId);
    assert.equal(rows.length, 0, 'stale pending not attributed');
  });

  it('respects a custom window via entry.autoLinkWindowMinutes', () => {
    const obsA = seedObservation(db, project, 'Alpha lesson', 'alpha lesson content');
    selfImprove.recordSearchInjections(db, project, [obsA]);
    db.prepare("UPDATE pending_eval_injections SET searched_at = datetime('now', '-30 minutes')").run();

    // Default 60m window would include it; a 10m window excludes it.
    const strict = seedEval('SUCCESS', { autoLinkWindowMinutes: 10 });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM eval_memory_injections WHERE eval_log_id = ?').get(strict).c, 0);
    // Re-search refreshes the timestamp, so a fresh window picks it up.
    selfImprove.recordSearchInjections(db, project, [obsA]);
    const fresh = seedEval('SUCCESS', { autoLinkWindowMinutes: 10 });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM eval_memory_injections WHERE eval_log_id = ?').get(fresh).c, 1);
  });

  it('re-searching refreshes a pending row instead of duplicating it', () => {
    const obsA = seedObservation(db, project, 'Alpha lesson', 'alpha lesson content');
    selfImprove.recordSearchInjections(db, project, [obsA]);
    selfImprove.recordSearchInjections(db, project, [obsA]);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM pending_eval_injections').get().c, 1, 'single pending row');
  });
});

// ─── Session-scoped attribution (endAgentSession) ───────────────────

describe('session-scoped injection attribution', () => {
  let db;
  const project = '/proj';

  beforeEach(() => { db = createTestDb(); });

  it('links an agent\'s own searched observations at session end, scoped to that agent', () => {
    const obsA = seedObservation(db, project, 'Alpha lesson', 'alpha lesson content');
    const obsB = seedObservation(db, project, 'Beta lesson', 'beta lesson content');
    // Agent 'alice' searched A and B during her session.
    selfImprove.recordSearchInjections(db, project, [obsA, obsB], { agentId: 'alice' });

    const evalId = selfImprove.writeEvalLog(db, { project, intentContent: 'i', actionContent: 'a', outcomeContent: 'o', verdict: 'SUCCESS' });
    const res = selfImprove.linkAgentSessionInjections(db, evalId, 'alice', 'sess-1', project);
    assert.equal(res.linked, 2);
    const rows = db.prepare('SELECT observation_id FROM eval_memory_injections WHERE eval_log_id = ? ORDER BY observation_id').all(evalId);
    assert.deepEqual(rows.map(r => r.observation_id), [obsA, obsB]);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM pending_eval_injections').get().c, 0, 'agent rows consumed');
  });

  it('leaves another agent\'s searches untouched at session end', () => {
    const obsA = seedObservation(db, project, 'Alpha lesson', 'alpha lesson content');
    const obsB = seedObservation(db, project, 'Beta lesson', 'beta lesson content');
    selfImprove.recordSearchInjections(db, project, [obsA], { agentId: 'alice' });
    selfImprove.recordSearchInjections(db, project, [obsB], { agentId: 'bob' });

    const evalId = selfImprove.writeEvalLog(db, { project, intentContent: 'i', actionContent: 'a', outcomeContent: 'o', verdict: 'SUCCESS' });
    const res = selfImprove.linkAgentSessionInjections(db, evalId, 'alice', 'sess-1', project);
    assert.equal(res.linked, 1, 'only alice\'s row linked');
    // Bob's row survives.
    assert.deepEqual(db.prepare('SELECT observation_id FROM pending_eval_injections').all().map(r => r.observation_id), [obsB]);
  });

  it('is independent of the time window (links stale agent rows too)', () => {
    const obsA = seedObservation(db, project, 'Alpha lesson', 'alpha lesson content');
    selfImprove.recordSearchInjections(db, project, [obsA], { agentId: 'alice' });
    db.prepare("UPDATE pending_eval_injections SET searched_at = datetime('now', '-5 hours')").run();

    const evalId = selfImprove.writeEvalLog(db, { project, intentContent: 'i', actionContent: 'a', outcomeContent: 'o', verdict: 'SUCCESS' });
    const res = selfImprove.linkAgentSessionInjections(db, evalId, 'alice', 'sess-1', project);
    assert.equal(res.linked, 1, 'session scope ignores the time window');
  });

  it('keeps time-window and agent-scoped rows separate', () => {
    const obsA = seedObservation(db, project, 'Alpha lesson', 'alpha lesson content');
    // Same observation searched both without context and by alice.
    selfImprove.recordSearchInjections(db, project, [obsA]);
    selfImprove.recordSearchInjections(db, project, [obsA], { agentId: 'alice' });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM pending_eval_injections').get().c, 2, 'two scope rows for one observation');

    // endAgentSession consumes only alice's scope.
    // Create the eval WITHOUT triggering the time-window auto-link (pass a
    // nullable marker so writeEvalLog doesn't consume the ''-scope row).
    const evalId = Number(db.prepare(
      "INSERT INTO evaluation_log (project_path, llm_verdict, verdict_reason) VALUES (?, 'SUCCESS', 'test')"
    ).run(project).lastInsertRowid);
    const res = selfImprove.linkAgentSessionInjections(db, evalId, 'alice', 'sess-1', project);
    assert.equal(res.linked, 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM pending_eval_injections').get().c, 1, 'time-window row survives');
  });

  it('re-searching in the same agent scope refreshes, not duplicates', () => {
    const obsA = seedObservation(db, project, 'Alpha lesson', 'alpha lesson content');
    selfImprove.recordSearchInjections(db, project, [obsA], { agentId: 'alice' });
    selfImprove.recordSearchInjections(db, project, [obsA], { agentId: 'alice' });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM pending_eval_injections').get().c, 1);
  });

  it('endAgentSession writes a NEUTRAL eval linking the agent\'s searches', () => {
    // Proves the api-level orchestration: search scoped to agent → endAgentSession
    // writes an eval + links that agent's pending searches.
    const api = require('../src/api');
    const dbMod = require('../src/core/db');
    const orig = dbMod.getDb;
    dbMod.getDb = () => db;
    try {
      const obsA = seedObservation(db, project, 'Alpha lesson', 'alpha lesson content');
      // Start a real agent session so endAgentSession has an active row.
      api.startAgentSession({ agentId: 'alice', sessionId: 'sess-9', project });
      // Simulate a search run under agent 'alice' during the session.
      selfImprove.recordSearchInjections(db, project, [obsA], { agentId: 'alice' });

      const out = api.endAgentSession('alice', 'sess-9');
      assert.equal(out.status, 'ended');
      assert.equal(out.linked, 1, 'session end linked the agent\'s search');
      const evalRow = db.prepare("SELECT * FROM evaluation_log WHERE verdict_reason = 'endAgentSession' ORDER BY id DESC LIMIT 1").get();
      assert.ok(evalRow, 'a NEUTRAL eval row exists from endAgentSession');
      const linked = db.prepare('SELECT observation_id FROM eval_memory_injections WHERE eval_log_id = ?').all(evalRow.id);
      assert.deepEqual(linked.map(r => r.observation_id), [obsA], 'the agent\'s search attributed to its session eval');
    } finally {
      dbMod.getDb = orig;
    }
  });
});

// ─── Eval-log provenance (auto vs manual attribution) ───────────────

describe('eval-log provenance', () => {
  let db;
  const project = '/proj';

  beforeEach(() => { db = createTestDb(); });

  function seedObs(title, content) {
    return seedObservation(db, project, title, content);
  }

  it('labels manual, auto, and session injection sources', () => {
    const obsA = seedObs('A lesson', 'alpha lesson content');
    const obsB = seedObs('B lesson', 'beta lesson content');
    const obsC = seedObs('C lesson', 'gamma lesson content');

    // Manual: explicit injectedObservationIds.
    selfImprove.writeEvalLog(db, { project, intentContent: 'i', actionContent: 'a', outcomeContent: 'o', verdict: 'SUCCESS', injectedObservationIds: [obsA] });
    // Auto: time-window search auto-link.
    selfImprove.recordSearchInjections(db, project, [obsB]);
    selfImprove.writeEvalLog(db, { project, intentContent: 'i', actionContent: 'a', outcomeContent: 'o', verdict: 'SUCCESS' });
    // Session: endAgentSession attribution.
    selfImprove.recordSearchInjections(db, project, [obsC], { agentId: 'alice' });
    const sessEval = selfImprove.writeEvalLog(db, { project, intentContent: 'i', actionContent: 'a', outcomeContent: 'o', verdict: 'SUCCESS' });
    selfImprove.linkAgentSessionInjections(db, sessEval, 'alice', 'sess-1', project);

    const rows = selfImprove.getEvaluationLog(db, { project });
    const byReason = Object.fromEntries(rows.map(r => [r.verdict_reason || r.intent_content, r]));
    // Manual eval (intent 'i', no special reason).
    const manualRow = rows.find(r => r.injectedSources.manual === 1);
    assert.equal(manualRow.injected, 1);
    assert.equal(manualRow.linkProvenance, 'manual');
    assert.equal(manualRow.autoAttributed, false, 'manual not flagged auto');

    const autoRow = rows.find(r => r.injectedSources.auto === 1);
    assert.equal(autoRow.linkProvenance, 'auto');
    assert.equal(autoRow.autoAttributed, true);
    assert.equal(autoRow.clearlyAuto, true);

    const sessionRow = rows.find(r => r.injectedSources.session === 1);
    assert.equal(sessionRow.linkProvenance, 'session');
    assert.equal(sessionRow.viaSession, true);
    assert.equal(sessionRow.autoAttributed, true, 'session is a form of auto-attribution');
  });

  it('flags evals with no injection records as none', () => {
    selfImprove.writeEvalLog(db, { project, intentContent: 'i', actionContent: 'a', outcomeContent: 'o', verdict: 'NEUTRAL' });
    const rows = selfImprove.getEvaluationLog(db, { project });
    const row = rows[0];
    assert.equal(row.injected, 0);
    assert.equal(row.linkProvenance, 'none');
    assert.equal(row.autoAttributed, false);
  });
});

// ─── End-to-end through keywordSearch ───────────────────────────────

describe('outcome weighting through keywordSearch', () => {
  let db;
  const project = '/proj';

  beforeEach(() => { db = createTestDb(); });

  it('lifts a proven memory above a fresher-looking unproven one', () => {
    const proven = seedObservation(db, project, 'Proven auth fix', 'the auth fix that always works');
    const unproven = seedObservation(db, project, 'Unproven auth fix', 'the auth fix that was just tried');
    selfImprove.writeEvalLog(db, {
      project,
      intentContent: 'auth',
      actionContent: 'applied fix',
      outcomeContent: 'works',
      verdict: 'SUCCESS',
      verdictReason: 'ok',
      injectedObservationIds: [proven],
    });
    selfImprove.writeEvalLog(db, {
      project,
      intentContent: 'auth',
      actionContent: 'applied fix',
      outcomeContent: 'works',
      verdict: 'SUCCESS',
      verdictReason: 'ok',
      injectedObservationIds: [proven],
    });

    // raw keyword search returns the unproven one first (newer rowid wins ties)
    const raw = search.keywordSearch(db, { query: 'auth fix', project, limit: 10 });
    const rawOrder = raw.map(r => r.id);
    assert.ok(rawOrder.includes(proven) && rawOrder.includes(unproven));

    const weighted = search.applyOutcomeWeights(db, raw, { project });
    const weightedOrder = weighted.map(r => r.id);
    assert.equal(weightedOrder[0], proven, 'proven memory outranks the unproven one');
  });
});
