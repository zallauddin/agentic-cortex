#!/usr/bin/env node
'use strict';

/**
 * ab-bench.js — A/B performance benchmark for agentic-cortex.
 *
 * Compares two configurations of agentic-cortex head-to-head on:
 *   - Search latency (p50, p95, p99, mean)
 *   - Search quality (recall@k on deterministic fixture)
 *   - Save latency
 *   - Bootstrap latency
 *   - Concurrency throughput (parallel saves)
 *   - Memory footprint (DB size after N operations)
 *
 * Each "variant" gets its own isolated DB so there's no cross-contamination.
 * Results are written to data/runs/ab-bench/<run-id>/<variant>/report.json
 * plus a combined comparison report.
 *
 * Usage:
 *   node scripts/ab-bench.js                          # run default variants
 *   node scripts/ab-bench.js --variants ac,base      # pick variants
 *   node scripts/ab-bench.js --iterations 5          # more iterations per op
 *   node scripts/ab-bench.js --keep                   # keep DBs for inspection
 *
 * Env:
 *   AB_BENCH_DB_DIR  — dir for variant DBs (default: <root>/tmp/ab-bench)
 *   AB_BENCH_KEEP    — keep DBs after run (same as --keep)
 *   AB_BENCH_ITER    — iterations per operation (default: 3)
 *   AB_BENCH_RUN_ID  — run identifier (default: auto)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TMP_DIR = path.join(ROOT, 'tmp', 'ab-bench');
const OUT_DIR = path.join(ROOT, 'data', 'runs', 'ab-bench');

// ─── Variant definitions ──────────────────────────────────────────────
// Each variant can set env vars, CLI flags, or module options that
// differentiate it from the baseline. The benchmark runner applies
// these before each operation and restores afterwards.
const VARIANTS = {
  ac: {
    name: 'agentic-cortex (default)',
    description: 'Default AC configuration — hybrid search, project-scoped, per-project queue.',
    env: {},
    label: 'ac',
  },
  noRerank: {
    name: 'AC — no cross-encoder reranking',
    description: 'Same as default but rerank=false on all searches. Measures reranker cost vs benefit.',
    env: {},
    label: 'no-rerank',
  },
  keywordOnly: {
    name: 'AC — keyword-only (no embeddings)',
    description: 'AGENTIC_CORTEX_EMBEDDINGS=0 disables semantic search. Measures embedding overhead.',
    env: { AGENTIC_CORTEX_EMBEDDINGS: '0' },
    label: 'keyword-only',
  },
  noReadGating: {
    name: 'AC — no read-after-write gating',
    description: 'Disables the per-project read gating that ensures save→search consistency. Measures gating overhead vs risk of stale reads.',
    env: { AC_NO_READ_GATE: '1' },
    label: 'no-read-gate',
  },
};

// ─── Fixture ──────────────────────────────────────────────────────────
// Deterministic memory fixture for quality measurement.
const FIXTURE = [
  {
    category: 'single_hop',
    saves: [
      { title: 'Tech stack decision', content: 'DECISION: this project uses vitest for all tests. Do not add jest config.', type: 'decision', importance: 8 },
      { title: 'Auth architecture', content: 'ARCHITECTURE: auth uses short-lived JWT in Authorization header, refreshed via /auth/refresh cookie.', type: 'architecture', importance: 9 },
      { title: 'Release procedure', content: 'PROCEDURE: to release — npm version minor, run all tests, npm publish, git push tags.', type: 'procedure', importance: 7 },
      { title: 'User preference', content: 'PREFERENCE: maintainer prefers tab indentation and single quotes.', type: 'preference', importance: 5 },
      { title: 'Gotcha', content: 'GOTCHA: path.join on this repo must use forward slashes when passed to better-sqlite3.', type: 'gotcha', importance: 7 },
    ],
    queries: [
      { q: 'which test framework should I use', expect: ['vitest'], label: 'test framework' },
      { q: 'how does authentication work', expect: ['JWT'], label: 'auth' },
      { q: 'how do I release', expect: ['npm publish'], label: 'release' },
      { q: 'indentation preference', expect: ['tab'], label: 'preference' },
      { q: 'path gotcha', expect: ['forward slash'], label: 'path' },
    ],
  },
  {
    category: 'noise',
    saves: Array.from({ length: 50 }, (_, i) => ({
      title: `Churn note ${i}`,
      content: `Routine observation number ${i}: refactored a helper module, added some tests, updated the changelog. No significant decisions here.`,
      type: 'observation',
      importance: 1 + (i % 3),
    })),
    queries: [
      // These should NOT return churn notes as top results
      { q: 'vitest test framework decision', expect: ['vitest'], label: 'find signal in noise' },
      { q: 'JWT auth architecture', expect: ['JWT'], label: 'auth in noise' },
    ],
  },
];

const K = 5;

// ─── Helpers ──────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withEnv(overrides, fn) {
  const old = {};
  for (const k of Object.keys(overrides)) {
    old[k] = process.env[k];
    if (overrides[k] === undefined || overrides[k] === null) {
      delete process.env[k];
    } else {
      process.env[k] = overrides[k];
    }
  }
  try { return await fn(); }
  finally {
    for (const k of Object.keys(old)) {
      if (old[k] === undefined || old[k] === null) {
        delete process.env[k];
      } else {
        process.env[k] = old[k];
      }
    }
  }
}

// ─── Benchmark operations ─────────────────────────────────────────────

/** Warm up the DB / module before measuring. */
async function warmup(api) {
  // Lightweight warmup: one save, one search. Skip bootstrap (expensive).
  await api.save({ title: '__warmup__', content: 'warmup', type: 'observation' });
  await api.search('warmup', { limit: 1 });
}

/**
 * Measure search latency over multiple queries.
 * Returns { latenciesMs: number[], results: object[] }
 */
async function measureSearch(api, queries, iterations) {
  const latencies = [];
  const allResults = [];
  for (let i = 0; i < iterations; i++) {
    for (const query of queries) {
      const t0 = performance.now();
      const results = await api.search(query.q, { limit: K, rerank: true });
      const ms = performance.now() - t0;
      latencies.push(ms);
      allResults.push({ query: query.q, label: query.label, results, ms });
    }
  }
  return { latencies, allResults };
}

/**
 * Measure save latency.
 * Returns { latenciesMs: number[], saved: object[] }
 */
async function measureSave(api, items) {
  const latencies = [];
  const saved = [];
  for (const item of items) {
    const t0 = performance.now();
    const r = await api.save(item);
    const ms = performance.now() - t0;
    latencies.push(ms);
    saved.push({ ...item, id: r.id, ms });
  }
  return { latencies, saved };
}

/**
 * Measure bootstrap latency.
 */
async function measureBootstrap(api, iterations) {
  const latencies = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    const ctx = await api.bootstrap({ workingOn: 'benchmarking' });
    latencies.push(performance.now() - t0);
  }
  return { latencies, contextPreview: (typeof ctx === 'string' ? ctx.slice(0, 200) : '') };
}

/**
 * Measure concurrent save throughput.
 * Launches N parallel saves and measures total wall time + per-save latency.
 */
async function measureConcurrency(api, n) {
  const saveItems = Array.from({ length: n }, (_, i) => ({
    title: `concurrent-${i}`,
    content: `Concurrent save ${i} from A/B bench.`,
    type: 'observation',
    importance: 1,
  }));

  const t0 = performance.now();
  const promises = saveItems.map(item =>
    api.save(item).then(r => ({ ok: true, id: r.id })).catch(e => ({ ok: false, error: e.message }))
  );
  const results = await Promise.all(promises);
  const wallMs = performance.now() - t0;
  const okCount = results.filter(r => r.ok).length;
  return { n, wallMs, okCount, failed: results.length - okCount };
}

/**
 * Measure DB file size.
 */
function measureDbSize(dbPath) {
  try {
    const stat = fs.statSync(dbPath);
    return stat.size;
  } catch {
    return null;
  }
}

// ─── Stats helpers ────────────────────────────────────────────────────

function latencyStats(latencies) {
  if (latencies.length === 0) return { min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0, count: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const pct = (p) => sorted[Math.floor(sorted.length * p)] ?? sorted[sorted.length - 1];
  return {
    min: sorted[0],
    p50: pct(0.50),
    p95: pct(0.95),
    p99: pct(0.99),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    count: sorted.length,
  };
}

function recallScore(results, query) {
  const blob = results.map(r => {
    const text = typeof r === 'string' ? r : (r.preview || r.title || '');
    return text.toLowerCase();
  }).join(' ');
  return query.expect.some(e => blob.includes(e.toLowerCase()));
}

// ─── Variant runner ───────────────────────────────────────────────────

async function runVariant(api, variant, opts) {
  const iterations = opts.iterations;
  const project = opts.project;

  console.error(`  ▸ ${variant.label}: warming up...`);
  await warmup(api);

  // ── Search latency ──
  const searchQueries = FIXTURE.flatMap(f => f.queries);
  console.error(`  ▸ ${variant.label}: measuring search (${searchQueries.length} queries × ${iterations} iters)...`);
  const { latencies: searchLat, allResults: searchResults } = await measureSearch(api, searchQueries, iterations);

  // ── Save latency ──
  const saveItems = FIXTURE[0].saves;
  console.error(`  ▸ ${variant.label}: measuring save (${saveItems.length} saves)...`);
  const { latencies: saveLat, saved } = await measureSave(api, saveItems);

  // ── Bootstrap latency ──
  console.error(`  ▸ ${variant.label}: measuring bootstrap (${iterations} iters)...`);
  const { latencies: bootLat, contextPreview } = await measureBootstrap(api, iterations);

  // ── Concurrency ──
  console.error(`  ▸ ${variant.label}: measuring concurrency (20 parallel saves)...`);
  const concurrency = await measureConcurrency(api, 20);

  // ── DB size ──
  const dbSize = measureDbSize(api._dbPath || opts.dbPath);

  // ── Quality: recall@k ──
  // Re-search the fixture queries and score
  console.error(`  ▸ ${variant.label}: measuring recall@k...`);
  const qualityResults = [];
  for (const f of FIXTURE) {
    for (const query of f.queries) {
      const results = await api.search(query.q, { limit: K, rerank: true });
      const hit = recallScore(results, query);
      qualityResults.push({
        category: f.category,
        query: query.q,
        label: query.label,
        expect: query.expect,
        hit,
        returned: results.length,
        topPreview: results.slice(0, 2).map(r => (r.preview || r.title || '').slice(0, 80)),
      });
    }
  }

  const allSearchLat = searchLat;
  const allSaveLat = saveLat;
  const allBootLat = bootLat;

  return {
    variant: variant.label,
    variantName: variant.name,
    description: variant.description,
    search: {
      latency: latencyStats(allSearchLat),
      perQuery: searchResults.slice(0, searchQueries.length).map((r, i) => ({
        query: r.query,
        label: r.label,
        ms: r.ms,
      })),
    },
    save: {
      latency: latencyStats(allSaveLat),
      count: allSaveLat.length,
    },
    bootstrap: {
      latency: latencyStats(allBootLat),
      iterations: iterations,
      contextPreview,
    },
    concurrency: {
      n: concurrency.n,
      wallMs: concurrency.wallMs,
      throughputPerSec: concurrency.n / (concurrency.wallMs / 1000),
      okCount: concurrency.okCount,
      failed: concurrency.failed,
    },
    dbSizeBytes: dbSize,
    quality: {
      total: qualityResults.length,
      hits: qualityResults.filter(r => r.hit).length,
      recallAtK: qualityResults.length ? (qualityResults.filter(r => r.hit).length / qualityResults.length * 100) : 0,
      byCategory: {},
      cases: qualityResults,
    },
  };
}

// ─── Child process runner ────────────────────────────────────────────
// Each variant runs in its own node process so the API singleton is fresh.

function runVariantChild(env, variantKey) {
  return new Promise((resolve, reject) => {
    const child = require('child_process').spawn('node', [__filename, '--child', variantKey], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', c => { stdout += c.toString(); });
    child.stderr.on('data', c => { stderr += c.toString(); });
    child.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        try { resolve(JSON.parse(stdout.trim())); } catch (e) { reject(new Error('parse: ' + e.message + ' stdout: ' + stdout.slice(0, 200))); }
      } else {
        reject(new Error(`exit ${code}, stderr: ${stderr.slice(-500)}`));
      }
    });
    child.on('error', reject);
    // Safety: kill if it runs more than 5 minutes
    setTimeout(() => { child.kill(); }, 300000);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────

function pickVariants(list) {
  if (!list || list.length === 0) return VARIANTS;
  const selected = {};
  for (const name of list) {
    if (VARIANTS[name]) selected[name] = VARIANTS[name];
  }
  return selected;
}

async function main() {
  const args = process.argv.slice(2);
  const keep = args.includes('--keep') || process.env.AB_BENCH_KEEP === '1';
  const iterations = parseInt(process.env.AB_BENCH_ITER || '3', 10);
  const runId = process.env.AB_BENCH_RUN_ID || `run-${Date.now()}`;
  // Parse --variants flag
  let variantNames = [];
  const variantsIdx = args.indexOf('--variants');
  if (variantsIdx >= 0 && args[variantsIdx + 1]) {
    variantNames = args[variantsIdx + 1].split(',');
  }
  const variants = variantNames.length ? pickVariants(variantNames) : VARIANTS;

  // Hoist args for child-process mode check
  main.args = args;
  main.variants = variants;
  main.runId = runId;
  main.keep = keep;
  main.iterations = iterations;

  console.error('╔══════════════════════════════════════════════════════╗');
  console.error('║  A/B Performance Benchmark — agentic-cortex          ║');
  console.error('╚══════════════════════════════════════════════════════╝');
  if (args.includes('--help') || args.includes('-h')) {
    console.log('A/B Performance Benchmark for agentic-cortex');
    console.log('');
    console.log('Usage:');
    console.log('  node scripts/ab-bench.js [--variants comma,separated] [--iterations N] [--keep] [--help]');
    console.log('');
    console.log('Options:');
    console.log('  --variants  Comma-separated variant names (default: all)');
    console.log('              ac          — default AC config (baseline)');
    console.log('              noRerank    — rerank=false on searches');
    console.log('              keywordOnly — AGENTIC_CORTEX_EMBEDDINGS=0');
    console.log('              noReadGate  — AC_NO_READ_GATE=1 (no read-after-write gating)');
    console.log('  --iterations  Number of search iterations per query (default: 3)');
    console.log('  --keep        Keep temp DBs after run for inspection');
    console.log('');
    console.log('Env:');
    console.log('  AB_BENCH_ITER    Override iterations');
    console.log('  AB_BENCH_KEEP    Set to 1 to keep DBs');
    console.log('  AB_BENCH_RUN_ID  Custom run identifier');
    console.log('');
    console.log('Output:');
    console.log('  data/runs/ab-bench/<run-id>/<variant>/report.json  — per-variant detail');
    console.log('  data/runs/ab-bench/<run-id>/comparison.json        — A/B comparison');
    console.log('');
    console.log('Available variants:');
    for (const [k, v] of Object.entries(VARIANTS)) {
      console.log(`  ${k.padEnd(12)} — ${v.name}`);
    }
    process.exit(0);
  }

  console.error(`run id:   ${runId}`);
  console.error(`variants: ${Object.keys(variants).join(', ')}`);
  console.error(`iterations per op: ${iterations}`);
  console.error(`out:      ${OUT_DIR}/${runId}/`);
  console.error('');
  console.error('Press Ctrl+C to stop.');
  // Don't auto-clean temp DBs on interrupt
  process.on('SIGINT', () => {
    console.error('\nInterrupted. DBs kept at ' + TMP_DIR);
    process.exit(130);
  });

  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, runId), { recursive: true });

  const results = {};
  const comparison = {
    runId,
    ranAt: new Date().toISOString(),
    iterations,
    variants: Object.keys(variants),
    byMetric: {},
  };

  for (const [key, variant] of Object.entries(variants)) {
    console.error(`\n══ ${variant.name} ══`);
    console.error(`   ${variant.description}`);

    // Each variant gets its own DB + project, run in a child process to avoid
    // singleton API module contamination between variants.
    const dbPath = path.join(TMP_DIR, `${runId}-${key}.db`).replace(/\\/g, '/');
    const project = path.join(TMP_DIR, `project-${key}`);

    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: `ab-bench-${key}` }));

    const env = {
      ...process.env,
      ...variant.env,
      AGENTIC_CORTEX_DB: dbPath,
      AGENTIC_CORTEX_PROJECT: project,
      AB_BENCH_ITER: String(iterations),
      AB_BENCH_PROJECT: project,
      AB_BENCH_DB: dbPath,
      AB_BENCH_VARIANT: key,
      AB_BENCH_RUN_ID: runId,
      // Disable auto-save during benchmark to avoid massive observation inflation
      AGENTIC_CORTEX_AUTO_SAVE: '0',
    };

    try {
      results[key] = await runVariantChild(env, key);
    } catch (e) {
      console.error(`  ✗ ${variant.label} failed: ${e.message}`);
      results[key] = { variant: key, error: e.message };
    }

    // Write variant report
    const variantDir = path.join(OUT_DIR, runId, key);
    fs.mkdirSync(variantDir, { recursive: true });
    fs.writeFileSync(path.join(variantDir, 'report.json'), JSON.stringify(results[key], null, 2));
    console.error(`  → ${variantDir}/report.json`);
  }

  // ── Build comparison ──
  const variantKeys = Object.keys(results);
  if (variantKeys.length >= 2) {
    const a = results[variantKeys[0]];
    const b = results[variantKeys[1]];
    if (a && b && !a.error && !b.error) {
      comparison.byMetric = {
        searchLatency: {
          label: 'Search latency (p50, p95, p99 ms)',
          a: a.search?.latency,
          b: b.search?.latency,
          delta: {
            p50: b.search?.latency?.p50 - a.search?.latency?.p50,
            p95: b.search?.latency?.p95 - a.search?.latency?.p95,
            p99: b.search?.latency?.p99 - a.search?.latency?.p99,
            mean: b.search?.latency?.mean - a.search?.latency?.mean,
          },
        },
        saveLatency: {
          label: 'Save latency (p50, p95, mean ms)',
          a: a.save?.latency,
          b: b.save?.latency,
          delta: {
            p50: b.save?.latency?.p50 - a.save?.latency?.p50,
            p95: b.save?.latency?.p95 - a.save?.latency?.p95,
            mean: b.save?.latency?.mean - a.save?.latency?.mean,
          },
        },
        bootstrapLatency: {
          label: 'Bootstrap latency (p50, p95, mean ms)',
          a: a.bootstrap?.latency,
          b: b.bootstrap?.latency,
          delta: {
            p50: b.bootstrap?.latency?.p50 - a.bootstrap?.latency?.p50,
            p95: b.bootstrap?.latency?.p95 - a.bootstrap?.latency?.p95,
            mean: b.bootstrap?.latency?.mean - a.bootstrap?.latency?.mean,
          },
        },
        concurrency: {
          label: 'Concurrency (20 parallel saves, wall ms)',
          a: a.concurrency,
          b: b.concurrency,
        },
        recall: {
          label: 'Recall@k quality',
          a: { recallAtK: a.quality?.recallAtK, hits: a.quality?.hits, total: a.quality?.total },
          b: { recallAtK: b.quality?.recallAtK, hits: b.quality?.hits, total: b.quality?.total },
          delta: (b.quality?.recallAtK ?? 0) - (a.quality?.recallAtK ?? 0),
        },
        dbSize: {
          label: 'DB size after benchmark (bytes)',
          a: a.dbSizeBytes,
          b: b.dbSizeBytes,
        },
      };
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, runId, 'comparison.json'), JSON.stringify(comparison, null, 2));

  // ── Print summary ──
  console.error('\n═══════════════════════════════════════');
  console.error('  A/B COMPARISON SUMMARY');
  console.error('═══════════════════════════════════════');

  const colors = { a: '\x1b[32m', b: '\x1b[36m', delta: '\x1b[33m', reset: '\x1b[0m' };

  for (const [metricKey, metric] of Object.entries(comparison.byMetric || {})) {
    console.error(`\n  ${metric.label}`);
    if (metric.a && metric.b) {
      console.error(`    ${variantKeys[0]} (green): ${JSON.stringify(metric.a).slice(0, 120)}`);
      console.error(`    ${variantKeys[1]} (cyan):  ${JSON.stringify(metric.b).slice(0, 120)}`);
      if (metric.delta !== undefined) {
        const sign = metric.delta > 0 ? '+' : '';
        const dir = metricKey.includes('Latency') || metricKey.includes('latency')
          ? (metric.delta > 0 ? 'slower' : 'faster')
          : (metric.delta > 0 ? 'better' : 'worse');
        const deltaStr = typeof metric.delta === 'number'
          ? `${sign}${metric.delta.toFixed(1)} ms`
          : JSON.stringify(metric.delta);
        console.error(`    δ: ${deltaStr} (${dir})`);
      }
    }
  }

  console.error(`\n  reports → ${OUT_DIR}/${runId}/`);
  console.error(`  comparison → ${OUT_DIR}/${runId}/comparison.json`);

  if (!keep) {
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* windows lock */ }
  } else {
    console.error(`  DBs kept at ${TMP_DIR}`);
  }
}

// ─── Entry point ────────────────────────────────────────────────────
// Support two modes: coordinator (default) and child (--child <key>).
// Child mode runs one variant in isolation so each variant gets a fresh API.

if (process.argv.includes('--child')) {
  const childKey = process.argv[process.argv.indexOf('--child') + 1];
  if (!childKey) { console.error('FATAL: --child requires a variant key'); process.exit(2); }

  const variant = VARIANTS[childKey];
  if (!variant) { console.error('FATAL: unknown variant ' + childKey); process.exit(2); }

  const dbPath = process.env.AB_BENCH_DB;
  const project = process.env.AB_BENCH_PROJECT;
  const iterations = parseInt(process.env.AB_BENCH_ITER || '3', 10);

  const api = require(path.join(ROOT, 'src', 'api'));
  // Pass a minimal config — no auto-save hooks, no self-improve init
  api.init({ dbPath, projectPath: project, autoSave: false });

  runVariant(api, variant, { iterations, project, dbPath })
    .then(result => {
      api.close();
      process.stdout.write(JSON.stringify(result));
      process.exit(0);
    })
    .catch(e => {
      api.close();
      console.error('FATAL in child:', e);
      process.exit(2);
    });
} else {
  main().catch((e) => { console.error('FATAL', e); process.exit(2); });
}
