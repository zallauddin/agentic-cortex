#!/usr/bin/env node
'use strict';
/**
 * benchmark-loop.js — a repeatable formula for moving benchmark numbers.
 *
 * WHY THIS EXISTS
 *   Benchmark tuning becomes curve-fitting the moment it runs on one corpus,
 *   against a stand-in for the shipped code path, with a metric that quietly
 *   disagrees with the documentation. This script is the opposite: a fixed
 *   procedure every run is judged by, so "improve the numbers" is a loop
 *   instead of a mood.
 *
 * THE FORMULA (each phase is a gate, not a suggestion)
 *
 *   1. REPRODUCE  — re-measure the published baseline through api.search
 *                   (the entry point the adapter calls), and require it to
 *                   equal BOTH the number in MEMORYBENCH.md and the number in
 *                   the committed report. Drift here invalidates every later
 *                   claim, so the loop exits 2 rather than continue.
 *   2. MEASURE    — run each candidate config through that same path on every
 *                   corpus that still has a hermetic DB. Missing corpora are
 *                   skipped loudly, never silently.
 *   3. VERDICT    — a candidate is adopted only if it improves at least one
 *                   corpus and regresses NONE. One corpus is a hypothesis;
 *                   two agreeing is evidence. Context cost is gated, not just
 *                   reported: a candidate that buys recall by flooding the
 *                   prompt is surfaced as OVER BUDGET and never auto-adopted,
 *                   because '4x the context for +8 points' is a product
 *                   decision, not a benchmark win.
 *   4. NEXT       — name the weakest question type that still has headroom,
 *                   which is where the next candidate must come from.
 *
 * GUARDS ENFORCED BY CONSTRUCTION
 *   - same k, same metric, same corpus for every arm (never compare across k;
 *     raising k inflates recall for free and is not an improvement).
 *   - the measurement drives `api.search`, not a reimplementation of it.
 *   - content is hydrated by id, because search() returns 300-char previews.
 *
 * Exit codes: 0 loop completed · 1 no usable corpus / measurement failed
 *             2 published baseline no longer reproduced (drift).
 *
 * Usage: node scripts/benchmark-loop.js [--quick] [--selftest-drift]
 *   --quick          baseline + first candidate only (smoke the loop itself)
 *   --selftest-drift deliberately corrupt the expected baseline; the loop
 *                     MUST then exit 2. Proves the drift gate can fire — a
 *                     gate that has never been seen to trigger is a claim,
 *                     not a check.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MB_ROOT = process.env.MB_ROOT || path.join(os.tmpdir(), 'memorybench');
const TMP = process.env.AC_TMP || os.tmpdir();
const QUICK = process.argv.includes('--quick');
/** Max context growth a candidate may carry before it needs human sign-off. */
const CONTEXT_BUDGET = Number(process.env.LOOP_CTX_BUDGET || 0.5);

/**
 * Corpora that exist right now, each with the number MEMORYBENCH.md publishes
 * for it. `expect` is asserted against a fresh measurement AND against the
 * doc text — both must hold.
 */
const CORPORA = [
  {
    name: 'LongMemEval-S',
    db: path.join(TMP, 'ac-mb-long.db'),
    runDir: path.join(MB_ROOT, 'data', 'runs', 'ac-lme-1'),
    docPattern: /\*\*80%\*\* \(20\/25 scored\)/,
    expect: { pct: 80.0, hits: 20, scored: 25 },
  },
  {
    name: 'LoCoMo smoke',
    db: path.join(TMP, 'ac-mb-smoke.db'),
    runDir: path.join(MB_ROOT, 'data', 'runs', 'ac-smoke1'),
    docPattern: /\*\*58\.3%\*\* \(7\/12 scored\)/,
    expect: { pct: 58.3, hits: 7, scored: 12 },
  },
];

/**
 * Candidate configurations. Only options that change *retrieval policy* —
 * never k, never the metric. `id` is what appears in the verdict table.
 */
const CANDIDATES = [
  { id: 'baseline (shipped)', shipped: true, env: { FUSE: '0' } },
  { id: 'cap 2/session', env: { FUSE: '0', CAP: '2' } },
  { id: 'cap 5/session', env: { FUSE: '0', CAP: '5' } },
  { id: 'parent-doc expand', env: { FUSE: '0', EXPAND: '1' } },
  { id: 'fuse transcripts', env: { FUSE: '1', TXN: '4' } },
  // Round 2 — hypothesis-driven, from Phase 4: multi-session / multi-hop need
  // evidence from *different* conversations, so the candidates below all buy
  // cross-session breadth rather than more of one conversation.
  { id: 'cap 1/session', env: { FUSE: '0', CAP: '1' } },
  { id: 'fuse TXN 8', env: { FUSE: '1', TXN: '8' } },
  { id: 'fuse+cap 2', env: { FUSE: '1', TXN: '4', CAP: '2' } },
  { id: 'expand+fuse', env: { FUSE: '1', TXN: '4', EXPAND: '1' } },
  // Round 3 — hypothesis-driven from Phase 4 (multi-hop / multi-session):
  // evidence for those questions sits in DIFFERENT conversations, so these
  // candidates change which of the pooled candidates occupy the k slots
  // instead of how many are retrieved. `spread` enforces a floor on distinct
  // conversations; `coverage` picks by marginal query-term gain, so each hop
  // or session gets its own slot.
  { id: 'spread floor 5', env: { FUSE: '0', SEL: 'spread', MIND: '5' } },
  { id: 'spread floor 7', env: { FUSE: '0', SEL: 'spread', MIND: '7' } },
  { id: 'coverage selection', env: { FUSE: '0', SEL: 'coverage' } },
  { id: 'coverage+spread 5', env: { FUSE: '0', SEL: 'coverage+spread', MIND: '5' } },
];

/** Run measure-shipped.js with an env overlay; returns {stdout, rowsFile}. */
function measure(corpus, env) {
  const outFile = path.join(os.tmpdir(), `bench-loop-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const out = execFileSync(process.execPath, [path.join(__dirname, 'measure-shipped.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      AC_DB: corpus.db,
      RUN_DIR: corpus.runDir,
      OUT: outFile,
      FUSE: '0',
      ...env,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const acc = /ACCURACY:\s+([\d.]+)%\s+\((\d+)\/(\d+)\)/.exec(out);
  const ctx = /context chars: total\s+(\d+)\s+median\s+(\d+)/.exec(out);
  const byType = {};
  for (const line of out.split('\n')) {
    const m = /^\s{2}(\S.*?)\s{2,}([\d.]+)%\s+\((\d+)\/(\d+)\)\s*$/.exec(line);
    if (m) byType[m[1].trim()] = { pct: parseFloat(m[2]), hits: +m[3], n: +m[4] };
  }
  let rows = null;
  try { rows = JSON.parse(fs.readFileSync(outFile, 'utf8')).rows; } catch { /* optional */ }
  fs.rmSync(outFile, { force: true });
  if (!acc) throw new Error(`no ACCURACY line for ${corpus.name} ${JSON.stringify(env)}`);
  return {
    pct: parseFloat(acc[1]),
    hits: +acc[2],
    scored: +acc[3],
    medianCtx: ctx ? +ctx[2] : 0,
    byType,
    rows,
  };
}

function pad(s, n) { return String(s).padEnd(n).slice(0, n); }

// ── Phase 1: reproduce the published baseline ───────────────────────────────
if (process.argv.includes('--selftest-drift')) {
  for (const c of CORPORA) c.expect = { pct: 0, hits: 0, scored: 0 };
  console.log('SELFTEST: expectations deliberately corrupted — exit must be 2');
}
const doc = fs.readFileSync(path.join(ROOT, 'MEMORYBENCH.md'), 'utf8');
const available = CORPORA.filter((c) => fs.existsSync(c.db) && fs.existsSync(path.join(c.runDir, 'results')));
for (const c of CORPORA) {
  if (!available.includes(c)) console.log(`  SKIP ${c.name} — no hermetic DB/run at ${c.db}`);
}
if (available.length === 0) {
  console.error('no usable corpus: nothing can be measured, so nothing can be claimed');
  process.exit(1);
}

console.log('\nPHASE 1 — reproduce the published baseline (drift gate)');
const baseline = {};
let drift = false;
for (const c of available) {
  const got = measure(c, CANDIDATES[0].env);
  baseline[c.name] = got;
  const docOk = c.docPattern.test(doc);
  const numOk = Math.abs(got.pct - c.expect.pct) < 0.05 && got.hits === c.expect.hits && got.scored === c.expect.scored;
  console.log(`  ${docOk && numOk ? 'ok  ' : 'DRIFT'} ${pad(c.name, 18)} measured ${got.pct}% (${got.hits}/${got.scored}) · doc expects ${c.expect.pct}% (${c.expect.hits}/${c.expect.scored}) · doc text ${docOk ? 'present' : 'MISSING'}`);
  if (!docOk || !numOk) drift = true;
}
if (drift) {
  console.error('\nPublished baseline no longer reproduced — MEMORYBENCH.md and the code now disagree.');
  console.error('Reconcile the doc (or the change that broke it) before tuning anything.');
  process.exit(2);
}

if (QUICK) {
  const only = CANDIDATES[1];
  console.log(`\nQUICK mode — measuring only "${only.id}"`);
  for (const c of available) {
    const got = measure(c, only.env);
    console.log(`  ${pad(c.name, 18)} ${got.pct}% (${got.hits}/${got.scored})  ctx ${got.medianCtx}`);
  }
  process.exit(0);
}

// ── Phase 2: candidate matrix on the shipped path ───────────────────────────
console.log(`\nPHASE 2 — candidate matrix (${CANDIDATES.length} configs × ${available.length} corpora)`);
const results = {}; // candId -> corpus -> result
for (const cand of CANDIDATES) {
  results[cand.id] = {};
  for (const c of available) results[cand.id][c.name] = measure(c, cand.env);
}

// ── Phase 3: cross-corpus verdict ───────────────────────────────────────────
console.log(`\nPHASE 3 — verdicts (adopt only if it improves >=1 corpus, regresses NONE,`);
console.log(`          and stays within a +${Math.round(CONTEXT_BUDGET * 100)}% context budget)`);
console.log('  ' + pad('config', 22) + available.map((c) => pad(c.name, 26)).join('') + 'verdict');
const winners = [];
const overBudget = [];
for (const cand of CANDIDATES) {
  const cells = [];
  let improves = 0;
  let regresses = 0;
  let worstCtx = 0;
  for (const c of available) {
    const got = results[cand.id][c.name];
    const base = baseline[c.name];
    const d = Math.round((got.pct - base.pct) * 10) / 10;
    const dc = Math.round(((got.medianCtx - base.medianCtx) / Math.max(1, base.medianCtx)) * 100);
    if (d > 0) improves++;
    if (d < 0) regresses++;
    worstCtx = Math.max(worstCtx, dc);
    cells.push(pad(`${d >= 0 ? '+' : ''}${d} ctx ${dc >= 0 ? '+' : ''}${dc}%`, 26));
  }
  let verdict;
  if (cand.shipped) verdict = 'shipped';
  else if (regresses > 0) verdict = 'REJECTED (regression)';
  else if (improves === 0) verdict = 'neutral';
  else if (worstCtx > CONTEXT_BUDGET * 100) {
    verdict = `OVER BUDGET (needs sign-off)`;
    overBudget.push(cand.id);
  } else {
    verdict = 'ADOPT (no regression)';
    winners.push(cand.id);
  }
  console.log('  ' + pad(cand.id, 22) + cells.join('') + verdict);
}

if (overBudget.length) {
  console.log(`\n  ${overBudget.length} candidate(s) improve recall but exceed the +${Math.round(CONTEXT_BUDGET * 100)}%`);
  console.log('  context budget. Raising the budget is a deliberate product choice:');
  console.log('  LOOP_CTX_BUDGET=2 node scripts/benchmark-loop.js');
}

// ── Phase 4: where the next candidate must come from ────────────────────────
console.log('\nPHASE 4 — next hypothesis (weakest type with headroom, baseline only)');
const weakest = [];
for (const c of available) {
  const t = baseline[c.name].byType;
  for (const [type, v] of Object.entries(t)) weakest.push({ corpus: c.name, type, ...v });
}
weakest.sort((a, b) => a.pct - b.pct || b.n - a.n);
for (const w of weakest.slice(0, 4)) {
  console.log(`  ${pad(w.corpus, 18)} ${pad(w.type, 28)} ${String(w.pct).padStart(5)}%  (${w.hits}/${w.n})`);
}
const worst = weakest[0];
console.log(`\n  → attack "${worst.type}" on ${worst.corpus} (${worst.pct}%): it is the largest`);
console.log('    single source of remaining points, and the fix must clear Phase 3 on');
console.log('    every corpus before it is called an improvement.');

console.log('\nRESULT: ' + (winners.length
  ? `adopt ${winners.length} candidate(s): ${winners.join(', ')}`
  : overBudget.length
    ? `nothing adoptable inside the context budget; ${overBudget.length} candidate(s) await a cost decision`
    : 'no new candidate clears the cross-corpus bar this round'));
process.exit(0);
