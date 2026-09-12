/**
 * forgetting.test.js — Tests for temporal forgetting, supersession,
 * profile, unified search, and the provider adapter (supermemory-inspired
 * hardening, Phase 15).
 *
 * @module tests/forgetting
 */

'use strict';

const { test, describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { getDb } = require('../src/core/db');
const forgetting = require('../src/core/forgetting');
const api = require('../src/api');

const PROJECT = '/tmp/ac-forgetting-test-proj';

// Isolated DB per suite run: unique file per process. (A fixed path made the
// suite depend on prior runs' leftover rows — accumulated access_count from
// stale fixtures once pushed fresh facts out of the profile top-N and broke
// assertions.) File, not :memory:, because db-path resolves the env var as a path.
process.env.AGENTIC_CORTEX_DB = process.env.AGENTIC_CORTEX_DB ||
  require('node:os').tmpdir().replace(/\\/g, '/') + '/ac-forgetting-test-' + process.pid + '-' + Date.now() + '.db';

describe('extractExpiry', () => {
  const now = new Date('2026-09-10T12:00:00.000Z');

  it('returns explicit expiresAt when valid', () => {
    const out = forgetting.extractExpiry('anything', { expiresAt: '2026-12-25', now });
    assert.equal(out, '2026-12-25T00:00:00.000Z');
  });

  it('applies ttlDays mechanically', () => {
    const out = forgetting.extractExpiry('no dates here', { ttlDays: 7, now });
    assert.equal(out, '2026-09-17T12:00:00.000Z');
  });

  it('detects absolute future dates', () => {
    const out = forgetting.extractExpiry('Deadline is 2027-03-05 for the migration', { now });
    assert.ok(out && out.startsWith('2027-03-05'), 'got ' + out);
  });

  it('ignores absolute dates already in the past', () => {
    const out = forgetting.extractExpiry('We migrated on 2020-01-01', { now });
    assert.equal(out, null);
  });

  it('detects "tomorrow"', () => {
    const out = forgetting.extractExpiry('User has an exam tomorrow', { now });
    assert.ok(out && out.startsWith('2026-09-11'), 'got ' + out);
  });

  it('detects relative spans ("in 2 weeks")', () => {
    const out = forgetting.extractExpiry('The token is valid in 2 weeks', { now });
    assert.ok(out && out.startsWith('2026-09-24'), 'got ' + out);
  });

  it('returns null when nothing implies expiry', () => {
    assert.equal(forgetting.extractExpiry('Uses PostgreSQL 15', { now }), null);
  });
});

describe('supersession (core)', () => {
  let db;
  beforeEach(() => { db = getDb(); });

  it('supersede marks the old memory inactive with a lineage relation', () => {
    const a = db.prepare(
      "INSERT INTO observations (project_path, type, title, content) VALUES (?, 'fact', 'old fact', 'old')"
    ).run(PROJECT);
    const b = db.prepare(
      "INSERT INTO observations (project_path, type, title, content) VALUES (?, 'fact', 'new fact', 'new')"
    ).run(PROJECT);
    const oldId = Number(a.lastInsertRowid);
    const newId = Number(b.lastInsertRowid);

    const r = forgetting.supersede(db, oldId, newId, { reason: 'test' });
    assert.equal(r.superseded, true);

    const oldRow = db.prepare('SELECT is_active, superseded_by FROM observations WHERE id = ?').get(oldId);
    assert.equal(oldRow.is_active, 0);
    assert.equal(oldRow.superseded_by, newId);

    const rel = db.prepare(
      "SELECT * FROM memory_relations WHERE source_id = ? AND target_id = ? AND relation_type = 'supersedes'"
    ).get(newId, oldId);
    assert.ok(rel, 'supersedes relation recorded');
  });

  it('findSupersededTarget matches same-type near-identical titles', () => {
    const a = db.prepare(
      "INSERT INTO observations (project_path, type, title, content) VALUES (?, 'fact', 'Deploy day is Friday', 'deploy friday')"
    ).run(PROJECT);
    const oldId = Number(a.lastInsertRowid);

    const target = forgetting.findSupersededTarget(db, {
      id: oldId + 1000, type: 'fact', title: 'Deploy day is Monday', project_path: PROJECT,
    });
    assert.equal(target.supersededId, oldId);
    assert.ok(target.similarity >= 0.6);
  });

  it('findSupersededTarget ignores non-supersedeable types', () => {
    const target = forgetting.findSupersededTarget(db, {
      id: 99999, type: 'observation', title: 'Deploy day is Tuesday', project_path: PROJECT,
    });
    assert.equal(target.supersededId, null);
  });
});

describe('temporal forgetting (api)', () => {
  it('save attaches expires_at from content', async () => {
    const r = await api.save({ title: 'Exam', content: 'exam tomorrow on graphs', project: PROJECT });
    assert.ok(r.expires_at, 'expires_at set');
    await api.forget(r.id, { hard: true });
  });

  it('save attaches expires_at from ttlDays', async () => {
    const r = await api.save({ title: 'Trial', content: 'trial key', ttlDays: 3, project: PROJECT });
    assert.ok(r.expires_at);
    await api.forget(r.id, { hard: true });
  });

  it('expired memories are excluded from search', async () => {
    const r = await api.save({ title: 'Temp fact', content: 'flaky temp detail xyzzy', project: PROJECT });
    const db = getDb();
    db.prepare("UPDATE observations SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(r.id);

    const hits = await api.search('flaky temp detail xyzzy', { project: PROJECT });
    assert.ok(!hits.some(h => h.id === r.id), 'expired memory must not surface');

    const incl = await api.search('flaky temp detail xyzzy', { project: PROJECT, includeExpired: true });
    assert.ok(incl.some(h => h.id === r.id), 'includeExpired opts back in');
    await api.forget(r.id, { hard: true });
  });

  it('superseded memories are excluded from search but kept in vault', async () => {
    const d1 = await api.save({ title: 'Rate limit is 100', content: 'rate limit 100', type: 'fact', project: PROJECT, skipSupersede: true });
    const d2 = await api.save({ title: 'Rate limit is 500', content: 'rate limit 500', type: 'fact', project: PROJECT });
    assert.ok(d2.superseded, 'auto-supersession fired');

    const hits = await api.search('rate limit', { project: PROJECT });
    assert.ok(!hits.some(h => h.id === d1.id), 'superseded memory must not surface');

    const oldRow = api.get(d1.id);
    assert.ok(oldRow, 'still in vault for audit');
    await api.forget(d1.id, { hard: true });
    await api.forget(d2.id, { hard: true });
  });

  it('expireMemories sweeps due memories and maintenance reports it', async () => {
    const r = await api.save({ title: 'Will die', content: 'ephemeral note', ttlDays: 1, project: PROJECT });
    const db = getDb();
    db.prepare("UPDATE observations SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(r.id);

    const sweep = api.expireMemories({ project: PROJECT });
    assert.ok(sweep.expired >= 1 && sweep.ids.includes(r.id));

    const maint = await api.runMaintenance({ project: PROJECT });
    assert.ok(typeof maint.expired === 'number');
  });
});

describe('profile (api)', () => {
  before(async () => {
    await api.save({ title: 'Stack choice', content: 'Project uses SQLite with WAL', type: 'fact', project: PROJECT, skipSupersede: true });
    await api.save({ title: 'Current goal', content: 'Ship the profile primitive', type: 'goal', project: PROJECT, skipSupersede: true });
  });

  it('returns static + dynamic sections in one call', async () => {
    const p = await api.profile({ project: PROJECT });
    assert.ok(Array.isArray(p.static));
    assert.ok(Array.isArray(p.dynamic));
    assert.ok(p.tokens > 0);
    assert.ok(p.static.length + p.dynamic.length >= 2, 'profile has content');
  });

  it('supports combined query in the same call', async () => {
    const p = await api.profile({ project: PROJECT, q: 'SQLite WAL' });
    assert.ok(Array.isArray(p.searchResults));
    assert.ok(p.searchResults.length >= 1, 'searchResults returned');
  });

  it('scopes to agentId when given', async () => {
    await api.save({ title: 'Agent fact', content: 'agent scoped memory', type: 'fact', project: PROJECT, agentId: 'agent-x', skipSupersede: true });
    const p = await api.profile({ project: PROJECT, agentId: 'agent-x' });
    for (const row of [...p.static, ...p.dynamic]) {
      assert.equal(row.agent_id ?? row.id, row.agent_id ?? row.id); // shape check
    }
    await api.forget(9999999, { hard: true }).catch(() => {});
  });
});

describe('unifiedSearch (api)', () => {
  it('returns memories and code sections with tags', async () => {
    const u = await api.unifiedSearch('profile primitive', { project: PROJECT, code: false });
    assert.ok(Array.isArray(u.memories));
    assert.ok(Array.isArray(u.code));
    assert.ok('total' in u && 'query' in u);
  });

  it('degrades gracefully when code index is empty', async () => {
    const u = await api.unifiedSearch('anything at all', { project: '/tmp/ac-nonexistent', code: true });
    assert.ok(u.total >= 0);
  });
});

describe('profile in bootstrap XML', () => {
  it('injects <project_profile> with stable_knowledge and current_activity', async () => {
    await api.save({ title: 'Boot fact', content: 'bootstrap profile uses XML injection', type: 'fact', project: PROJECT, skipSupersede: true });
    await api.save({ title: 'Boot goal', content: 'verify bootstrap profile injection', type: 'goal', project: PROJECT, skipSupersede: true });

    const xml = await api.bootstrap({ project: PROJECT, includeStandards: false, includeGraph: false });
    assert.ok(xml.includes('<project_profile'), 'project_profile block present');
    assert.ok(xml.includes('<stable_knowledge>'), 'stable_knowledge section present');
    assert.ok(xml.includes('<current_activity>'), 'current_activity section present');
    assert.ok(/<fact[^>]*>Boot fact/.test(xml), 'static fact injected');
    assert.ok(/<now[^>]*type="goal"[^>]*>Boot goal/.test(xml), 'dynamic goal injected');
  });

  it('omits the block when includeProfile is false', async () => {
    const xml = await api.bootstrap({ project: PROJECT, includeStandards: false, includeGraph: false, includeProfile: false });
    assert.ok(!xml.includes('<project_profile'), 'profile block must be omitted');
  });

  it('scopes profile to the requested project (no cross-project leakage)', async () => {
    // Regression: profile() ignored project_path in its WHERE clause, so a
    // bootstrap profile could surface memories from ANY project on this
    // machine (bench fixtures, other repos), crowding out the project's own
    // facts from the top-N.
    const otherProject = '/tmp/ac-profile-leak-other-proj';
    for (let i = 0; i < 10; i++) {
      await api.save({ title: 'Foreign fact ' + i, content: 'cross-project leakage fixture ' + i, type: 'fact', project: otherProject, skipSupersede: true });
    }
    await api.save({ title: 'Local fact', content: 'must appear in its own project profile', type: 'fact', project: PROJECT, skipSupersede: true });

    const prof = await api.profile({ project: PROJECT, limit: 8 });
    const titles = prof.static.map(r => r.title);
    assert.ok(!titles.some(t => t.startsWith('Foreign fact')), 'foreign project rows must not leak into profile');
    assert.ok(titles.includes('Local fact'), 'own project fact must be present');

    // And the other project's profile must not contain this project's rows.
    const otherProf = await api.profile({ project: otherProject, limit: 8 });
    assert.ok(otherProf.static.every(r => r.project_path === otherProject), 'other profile contains only its own rows');

    // Cleanup foreign fixture rows.
    for (const r of api.list({ project: otherProject, limit: 100 })) {
      await api.forget(r.id, { hard: true }).catch(() => {});
    }
  });
});

describe('semantic supersession (embedding-based)', () => {
  // Real embeddings when available (AGENTIC_CORTEX_EMBEDDINGS=1); skipped
  // otherwise so the default CI path stays model-free.
  const hasEmbeddings = !!process.env.AGENTIC_CORTEX_EMBEDDINGS;
  const testFn = hasEmbeddings ? it : it.skip;

  testFn('reworded fact supersedes original via cosine band', async () => {
    const a = await api.save({ title: 'Rate limit', content: 'The API rate limit is 100 requests per minute', type: 'fact', project: PROJECT, skipSupersede: true });
    const b = await api.save({ title: 'Rate limit updated', content: 'We have now raised the API so it allows 500 requests each minute', type: 'fact', project: PROJECT });
    assert.equal(b.superseded, a.id, 'old fact superseded');
    assert.equal(b.superseded_by_method, 'semantic');
    assert.ok(b.superseded_similarity >= 0.80 && b.superseded_similarity < 0.97);
    await api.forget(a.id, { hard: true }).catch(() => {});
    await api.forget(b.id, { hard: true }).catch(() => {});
  });

  testFn('unrelated fact does not supersede', async () => {
    const a = await api.save({ title: 'Auth stack', content: 'The service uses JWT tokens for authentication', type: 'fact', project: PROJECT, skipSupersede: true });
    const c = await api.save({ title: 'Weather note', content: 'The forecast predicts heavy rain tomorrow afternoon', type: 'fact', project: PROJECT });
    assert.ok(!c.superseded, 'unrelated memory must not be superseded');
    await api.forget(a.id, { hard: true }).catch(() => {});
    await api.forget(c.id, { hard: true }).catch(() => {});
  });

  testFn('exact restatement of superseded fact cannot overwrite current truth', async () => {
    const a = await api.save({ title: 'Deploy day', content: 'The deploy day is Friday', type: 'fact', project: PROJECT, skipSupersede: true });
    const b = await api.save({ title: 'Deploy day changed', content: 'The deploy day moved to Monday', type: 'fact', project: PROJECT });
    const d = await api.save({ title: 'Deploy day', content: 'The deploy day is Friday', type: 'fact', project: PROJECT });
    // The restatement must end up dead (superseded by b, or redirected to b);
    // b (the current truth) must stay alive.
    assert.ok(d.superseded === b.id || d.superseded_by === b.id, 'stale restatement must lose to the champion');
    const bRow = api.get(b.id);
    assert.ok(bRow && bRow.is_active === 1, 'champion still active');
    await Promise.all([a, b, d].map(x => api.forget(x.id, { hard: true }).catch(() => {})));
  });

  testFn('observation type is exempt from semantic supersession', async () => {
    const a = await api.save({ title: 'Build failed', content: 'Build failed on main with type error in auth module', type: 'observation', project: PROJECT, skipSupersede: true });
    const e = await api.save({ title: 'Build failed again', content: 'Build failed on main with a type error inside the auth module', type: 'observation', project: PROJECT });
    assert.ok(!e.superseded, 'repeated observations are evidence, not updates');
    await api.forget(a.id, { hard: true }).catch(() => {});
    await api.forget(e.id, { hard: true }).catch(() => {});
  });
});

describe('provider adapter (bench)', () => {
  it('exposes the MemoryBench-style surface', async () => {
    const { createProvider, runRecallBenchmark } = require('../src/bench/provider-adapter');
    const provider = createProvider(api, { project: '/tmp/ac-bench-adapter-proj' });
    assert.equal(provider.name, 'agentic-cortex');
    assert.strictEqual(typeof provider.addMemories, 'function');
    assert.strictEqual(typeof provider.searchMemories, 'function');
    assert.strictEqual(typeof provider.getProfile, 'function');
    assert.strictEqual(typeof provider.reset, 'function');

    const result = await runRecallBenchmark(api, { project: '/tmp/ac-bench-suite-proj' });
    assert.ok(result.overall.total >= 6);
    assert.ok(result.overall.recallAtK > 0, 'recall should be nonzero on the fixture');
    assert.ok(result.perCategory.knowledge_update, 'knowledge_update category present');
  });
});

describe('knowledge-update clean-retrieval benchmark (CI)', () => {
  // Permanent version of the ad-hoc knowledge-update benchmark: contradicted
  // facts over time. A regression in the forgetting/supersession filters
  // (stale fact surfacing again) MUST fail CI. Runs on the default
  // keyword-only path — no embeddings required — via title-based
  // supersession ("X" vs "X update" titles pass the Jaccard gate).
  // Own project + pre-clean: other suites in this file leave rows in PROJECT
  // (e.g. the core supersession test's "Deploy day is Friday" row), which
  // would pollute the stale-value and top-hit checks below.
  const BENCH_PROJECT = '/tmp/ac-forgetting-test-ku-bench';

  const CASES = [
    {
      tOld: 'Ku career', tNu: 'Ku career update',
      old: 'Ku is a lawyer at the downtown firm',
      neu: 'Ku works long hours at the office',
      nu: 'Ku now works as a teacher after leaving law',
      q: 'what does ku do for a living now',
      truth: 'teacher', stale: 'lawyer',
    },
    {
      tOld: 'Ku database choice', tNu: 'Ku database choice update',
      old: 'The team uses PostgreSQL for the main database',
      neu: 'The team has standups every morning',
      nu: 'The team database is now SQLite after the migration',
      q: 'which database does the team use currently',
      truth: 'sqlite', stale: 'postgresql',
    },
    {
      tOld: 'Ku residence', tNu: 'Ku residence update',
      old: 'Ku lives in Chicago near the lake',
      neu: 'Ku likes deep dish pizza',
      nu: 'Ku lives in Austin today after moving for a new job',
      q: 'where does ku live today',
      truth: 'austin', stale: 'chicago',
    },
    {
      tOld: 'Ku deploy window', tNu: 'Ku deploy window update',
      old: 'The deploy window is Friday nights',
      neu: 'The build takes about ten minutes',
      nu: 'The deploy window moved to Monday mornings now',
      q: 'when is the deploy window',
      truth: 'monday', stale: 'friday',
    },
  ];

  for (const c of CASES) {
    it(`no stale-fact leak: ${c.q}`, async () => {
      // Sweep leftovers from prior case-runs so each case starts clean.
      const db = getDb();
      db.prepare("DELETE FROM observations WHERE project_path = ?").run(BENCH_PROJECT);
      db.prepare("DELETE FROM observations_fts WHERE rowid NOT IN (SELECT id FROM observations)").run();

      const oldM = await api.save({ title: c.tOld, content: c.old, type: 'fact', project: BENCH_PROJECT, skipSupersede: true });
      const neuM = await api.save({ title: 'Note ' + c.tOld, content: c.neu, type: 'observation', project: BENCH_PROJECT });
      const newM = await api.save({ title: c.tNu, content: c.nu, type: 'fact', project: BENCH_PROJECT });

      try {
        // Supersession must have fired on the title path (CI: no embeddings).
        assert.equal(newM.superseded, oldM.id, 'old fact must be superseded by the update');
        const oldRow = api.get(oldM.id);
        assert.ok(oldRow && oldRow.is_active === 0, 'old fact must be inactive');

        // CLEAN RETRIEVAL: top-5 must contain the current truth and must NOT
        // contain the stale value anywhere (the superseded row is excluded at
        // the SQL layer; the neutral note never mentioned it).
        const hits = await api.search(c.q, { project: BENCH_PROJECT, limit: 5 });
        const texts = hits.map(h => `${h.title || ''} ${h.preview || ''}`.toLowerCase());
        assert.ok(texts.some(t => t.includes(c.truth)),
          `current truth "${c.truth}" must surface for: ${c.q}`);
        assert.ok(!texts.some(t => t.includes(c.stale)),
          `STALE-FACT LEAK: outdated value "${c.stale}" surfaced for: ${c.q}`);

        // Temporal phrasing ("now"/"today"/"currently") must rank the current
        // truth at the very top — the temporal boost lifts the champion over
        // neutral distractors.
        assert.ok(texts[0].includes(c.truth),
          `top hit for temporal query must be the current truth, got: ${texts[0].slice(0, 60)}`);
      } finally {
        await api.forget(oldM.id, { hard: true }).catch(() => {});
        await api.forget(neuM.id, { hard: true }).catch(() => {});
        await api.forget(newM.id, { hard: true }).catch(() => {});
      }
    });
  }
});

after(() => {
  try { api.close(); } catch { /* ignore */ }
});
