/**
 * provider-adapter.js — Standard memory-provider adapter + recall@k harness.
 *
 * The gap supermemory exposed: AC's memory quality claims were self-referential.
 * This module makes agentic-cortex a pluggable memory provider with the same
 * minimal surface external benchmarks (MemoryBench-style) expect:
 *
 *   addMemories(texts, opts)   → ingest a batch of conversation/fact texts
 *   search(query, opts)        → retrieve relevant memories (ranked)
 *   profile(opts)              → one-call static+dynamic profile
 *   reset(opts)                → clear provider state for a clean run
 *
 * Any harness that speaks this interface (ours, MemoryBench's, or your own)
 * can now measure agentic-cortex's recall head-to-head against Mem0, Zep,
 * supermemory, etc. on the same fixture.
 *
 * Also includes a self-contained recall@k suite over a deterministic fixture
 * covering the categories supermemory reports on: single-hop, multi-hop,
 * temporal reasoning, and knowledge updates.
 *
 * Usage:
 *   node cli.js bench-provider              # run the built-in suite
 *   node src/bench/provider-adapter.js      # same, direct
 *
 * @module bench/provider-adapter
 */

'use strict';

// ─── Provider adapter (MemoryBench-compatible surface) ───────────────

/**
 * Wrap a running agentic-cortex API as a standard memory provider.
 * Scoped to one project path so benchmark runs are hermetic.
 *
 * @param {Object} api — agentic-cortex API (src/api/index.js exports)
 * @param {Object} [opts] — { project?: string }
 * @returns {Object} provider with addMemories/search/profile/reset
 */
function createProvider(api, opts) {
  opts = opts || {};
  const project = opts.project || `bench-provider-${Date.now()}`;

  return {
    name: 'agentic-cortex',
    project,

    /** Ingest a batch of texts (conversation transcripts or standalone facts). */
    async addMemories(texts, addOpts) {
      addOpts = addOpts || {};
      const saved = [];
      for (const text of texts) {
        saved.push(await api.save({
          title: (addOpts.titlePrefix || 'memory') + ': ' + String(text).slice(0, 60),
          content: String(text),
          type: addOpts.type || 'fact',
          tags: ['benchmark', 'provider-adapter'],
          project,
          skipSupersede: !addOpts.allowSupersede,
          skipDedup: !addOpts.allowDedup,
          importance: 5,
          confidence: 100,
          provenance: 'observed',
        }));
      }
      return saved;
    },

    /** Retrieve ranked memories for a query. Returns plain strings (evidence). */
    async searchMemories(query, searchOpts) {
      searchOpts = searchOpts || {};
      const results = await api.search(query, {
        project,
        limit: searchOpts.k || 10,
        rerank: !!searchOpts.rerank,
      });
      return results.map(r => ({
        id: r.id,
        text: r.preview || r.title || '',
        score: r.rerank_score ?? r.combined_score ?? r.semantic_score ?? null,
        created_at: r.created_at,
      }));
    },

    /** One-call profile (static + dynamic), supermemory-compatible shape. */
    async getProfile(profileOpts) {
      const p = await api.profile({ project, q: profileOpts && profileOpts.q });
      return { static: p.static, dynamic: p.dynamic, tokens: p.tokens };
    },

    /** Soft-reset: forget everything saved under this benchmark project scope. */
    async reset() {
      const rows = api.list({ project, limit: 10000 });
      for (const r of rows) {
        try { await api.forget(r.id, { hard: true }); } catch { /* already gone */ }
      }
      return { reset: true, project };
    },
  };
}

// ─── Built-in recall@k fixture ───────────────────────────────────────

/**
 * Deterministic fixture (no LLM, no network). Each case:
 *   facts      — ingested verbatim
 *   query      — retrieval question
 *   expectAny  — substrings; a hit at rank ≤ k means recall
 *   category   — one of single_hop | multi_hop | temporal | knowledge_update
 */
const FIXTURE = [
  {
    category: 'single_hop',
    facts: [
      'Alice prefers TypeScript with strict mode enabled for all new services.',
      'The team deploys to production every Tuesday afternoon.',
    ],
    query: 'What language does Alice prefer for new services?',
    expectAny: ['TypeScript'],
    k: 5,
  },
  {
    category: 'multi_hop',
    facts: [
      'The payment service depends on the auth service for token validation.',
      'The auth service uses Redis for session storage.',
      'Redis runs on the cache-cluster-2 node in eu-west-1.',
    ],
    query: 'Which infrastructure node validates payment tokens indirectly?',
    expectAny: ['cache-cluster-2', 'Redis'],
    k: 5,
  },
  {
    category: 'temporal',
    facts: [
      'The beta launch was scheduled for 2030-06-15.',
      'The security review must finish before the beta launch.',
    ],
    query: 'When is the beta launch scheduled?',
    expectAny: ['2030-06-15'],
    k: 5,
  },
  {
    category: 'knowledge_update',
    facts: [
      'The API rate limit is 100 requests per minute.',
      'The API rate limit was raised to 500 requests per minute.',
    ],
    query: 'What is the current API rate limit?',
    expectAny: ['500'],
    k: 5,
  },
  {
    category: 'single_hop',
    facts: [
      'Maria handles on-call escalations for the data platform team.',
      'The data platform uses Airflow for orchestration.',
    ],
    query: 'Who handles on-call escalations for the data platform?',
    expectAny: ['Maria'],
    k: 5,
  },
  {
    category: 'knowledge_update',
    facts: [
      'The staging database password rotation happens monthly.',
      'The staging database password rotation moved to quarterly.',
    ],
    query: 'How often does the staging database password rotate now?',
    expectAny: ['quarterly'],
    k: 5,
  },
];

/**
 * Run the recall@k suite against a provider (defaults to local agentic-cortex).
 *
 * @param {Object} api — agentic-cortex API
 * @param {Object} [opts] — { project?, k? }
 * @returns {Promise<Object>} { perCategory, overall, cases, ranAt }
 */
async function runRecallBenchmark(api, opts) {
  opts = opts || {};
  const provider = opts.provider || createProvider(api, { project: opts.project });
  const results = [];

  // Isolation: run in a hermetic project scope
  await provider.reset();

  // Ingest all fixture facts once (single provider session)
  const allFacts = [];
  for (const c of FIXTURE) allFacts.push(...c.facts);
  await provider.addMemories(allFacts, { titlePrefix: 'bench-fact', allowSupersede: true });

  for (const c of FIXTURE) {
    const hits = await provider.searchMemories(c.query, { k: c.k || opts.k || 5 });
    const textBlob = hits.map(h => h.text).join(' ').toLowerCase();
    const hit = c.expectAny.some(e => textBlob.includes(e.toLowerCase()));
    const topScore = hits.length ? hits[0].score : null;
    results.push({
      category: c.category,
      query: c.query,
      hit,
      k: c.k || opts.k || 5,
      returned: hits.length,
      topScore,
      evidence: hits.slice(0, 3).map(h => h.text.slice(0, 80)),
    });
  }

  // Per-category + overall recall
  const perCategory = {};
  for (const r of results) {
    perCategory[r.category] = perCategory[r.category] || { hits: 0, total: 0 };
    perCategory[r.category].total++;
    if (r.hit) perCategory[r.category].hits++;
  }
  for (const cat of Object.keys(perCategory)) {
    const { hits, total } = perCategory[cat];
    perCategory[cat] = { recall: total ? Math.round((hits / total) * 1000) / 10 : 0, hits, total };
  }
  const totalHits = results.filter(r => r.hit).length;

  return {
    provider: provider.name,
    overall: {
      recallAtK: results.length ? Math.round((totalHits / results.length) * 1000) / 10 : 0,
      hits: totalHits,
      total: results.length,
    },
    perCategory,
    cases: results,
    ranAt: new Date().toISOString(),
  };
}

module.exports = { createProvider, runRecallBenchmark, FIXTURE };
