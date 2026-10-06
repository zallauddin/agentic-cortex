#!/usr/bin/env node
'use strict';
/**
 * Cross-check MEMORYBENCH.md prose against data/runs/longmemeval-h2h/report.json.
 *
 * Guards the two ways this document has actually drifted before:
 *   1. a number in prose that no longer matches the regenerated report, and
 *   2. a stale figure left behind after a metric change.
 * It therefore asserts both directions — the new values ARE present, and the
 * superseded ones are NOT.
 */
const fs = require('fs');
const doc = fs.readFileSync('MEMORYBENCH.md', 'utf8');
const r = require('../data/runs/longmemeval-h2h/report.json');

const ac = r.providers['agentic-cortex@default'];
const fss = r.providers['filesystem@session'];
const fst = r.providers['filesystem@turn'];
const ctx = (k) => r.contextCost[k].medianChars;

const checks = [
  // ── report (fixed metric: scorable questions only) ──────────────────────
  ['report AC 80/20', ac.recallAtK === 80 && ac.hits === 20],
  ['report FS 92/23', fss.recallAtK === 92 && fss.hits === 23],
  ['report FSt 64/16', fst.recallAtK === 64 && fst.hits === 16],
  ['report scored 25 of 30', r.questionsScored === 25 && r.questions === 30],
  ['report lists the 5 unscorable', Array.isArray(r.questionsUnscorable) && r.questionsUnscorable.length === 5],
  ['ctx AC 32465', ctx('agentic-cortex@default') === 32465],
  ['ctx FS 138744', ctx('filesystem@session') === 138744],
  ['ctx FSt 21037', ctx('filesystem@turn') === 21037],
  ['haystack 492759', r.contextCost.medianHaystackChars === 492759],
  ['pct AC 7', r.contextCost.medianPctOfHaystack['agentic-cortex@default'] === 7],
  ['pct FS 28', r.contextCost.medianPctOfHaystack['filesystem@session'] === 28],
  ['ratio 4x', r.contextCost.fsSessionVsAcRatio === 4],
  ['multi-session 25 vs 75 in report',
    r.byType['multi-session']['agentic-cortex@default'].recallAtK === 25 &&
    r.byType['multi-session']['filesystem@session'].recallAtK === 75],

  // ── doc carries the regenerated values ──────────────────────────────────
  ['doc AC 80% (20/25 scored)', doc.includes('**80%** (20/25 scored)')],
  ['doc FS 92% (23/25 scored)', doc.includes('**92%** (23/25 scored)')],
  ['doc FSt 64% (16/25 scored)', doc.includes('**64%** (16/25 scored)')],
  ['doc ctx 32,465', doc.includes('32,465 chars')],
  ['doc gap 12 pts', doc.includes('**12 pts** behind')],
  ['doc 16 pts worse', doc.includes('**16 pts worse** (64% vs 80%)')],
  ['doc locomo smoke 58.3 (7/12)', doc.includes('**58.3%** (7/12 scored)')],
  ['doc per-type multi-session 25 / 75', doc.includes('| multi-session | 25% | **75%** | 0% |')],
  ['doc hardening before/after LME', doc.includes('72% (18/25) | **80% (20/25)**')],
  ['doc hardening before/after LoCoMo', doc.includes('41.7% (5/12) | **50% (6/12)**')],

  // ── the three documented sections exist and are linked ──────────────────
  ['hardening heading', doc.includes('### Hardening round (2026-10-06): what was actually wrong')],
  ['hardening anchor link', doc.includes('#hardening-round-2026-10-06-what-was-actually-wrong')],
  ['metric-fix heading', doc.includes('### Metric fix (2026-10-06): short answers were auto-failed')],
  ['metric-fix anchor link', doc.includes('#metric-fix-2026-10-06-short-answers-were-auto-failed')],
  ['metric-fix points at shared matcher', doc.includes('scripts/lib/bench-metric.js')],
  ['safety-net section', doc.includes('### Recall safety net (2026-10-06): a search could return nothing')],
  ['fusion section marked opt-in', doc.includes('### Transcript-channel fusion (2026-10-06) — implemented, **opt-in only**')],
  ['fusion table shows both configs', doc.includes('| shipped (safety net only) | 80% | **58.3%**')],
  ['reproduce commands documented', doc.includes('node scripts/measure-shipped.js')],

  // ── the executable formula ────────────────────────────────────────────
  ['benchmark-loop section', doc.includes('## The benchmark loop')],
  ['benchmark-loop script cited', doc.includes('scripts/benchmark-loop.js')],
  ['four phases documented', ['**1. Reproduce**', '**2. Measure**', '**3. Verdict**', '**4. Next**'].every((s) => doc.includes(s))],
  ['context budget gate documented', doc.includes('+50% context budget')],
  ['frontier row TXN=10', doc.includes('| `maxTranscripts: 10` | **88%** | 58.3% | 107,107 (+239%) |')],
  ['frontier flags TXN=4 regression', doc.includes('| `maxTranscripts: 4` | 84% | **50% — regression** | 66,457 |')],
  ['next hypothesis documented', doc.includes('`multi-hop` on LoCoMo smoke')],
  ['loop exit contract documented', doc.includes('--selftest-drift') && doc.includes('**2** published baseline no longer reproduced')],
  ['fusion no longer claims every guard fails', !doc.includes('Every guard that stops the')],

  // ── round 3: the rejected hypothesis ────────────────────────────────────
  ['three cycles documented', doc.includes('**Three cycles run 2026-10-06**')],
  ['round-3 verdict section', doc.includes('### Round 3 verdict: the hypothesis was rejected, and the reason is upstream')],
  ['diagnosis script cited', doc.includes('scripts/spread-diagnose.js')],
  ['spread floor 7 rejected row', doc.includes('| spread floor 7 | **−8** | **−8.3** | REJECTED (regression) |')],
  ['upstream cause named', doc.includes('`reachable=NO` means the answer\'s wording never made it into a memory')],
  ['round-4 brief is ingestion', doc.includes('extraction coverage at ingest time')],
  ['spread kept as guarantee not points', doc.includes('cuts') && doc.includes('6/30 → 0/30')],
  ['rejected candidate documented', doc.includes('Rejected') && doc.includes('16.7')],
  ['three defects documented',
    doc.includes('buildFtsQuery()') && doc.includes('capPerSession()') && doc.includes('/\\\\W+/')],

  // ── superseded figures must be gone from current-tense claims ───────────
  ['no stale AC 63.3% (19/30) row', !doc.includes('**63.3%** (19/30)')],
  ['no stale FS 66.7% (20/30) row', !doc.includes('**66.7%** (20/30)')],
  ['no stale gap 3.4 pts', !doc.includes('**3.4 pts**')],
  ['no stale 10.0 pts worse', !doc.includes('**10.0 pts worse**')],
  ['no stale locomo 40.0 (6/15) as retrieval', !doc.includes('**40.0%** (6/15)')],
  ['no stale "0% for every provider"', !doc.includes('multi-session` is still 0% for every provider')],
];

let bad = 0;
for (const [name, ok] of checks) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name);
  if (!ok) bad++;
}

// Markdown table integrity: every row of a table must match its header's pipe count.
const L = doc.split('\n');
let tables = 0;
for (let i = 0; i < L.length; i++) {
  const isHeader = /^\|.*\|\s*$/.test(L[i]) && /^\|[\s:-]+\|/.test(L[i + 1] || '');
  if (!isHeader) continue;
  tables++;
  const cols = (L[i].match(/\|/g) || []).length;
  let k = i + 1;
  while (k < L.length && /^\|.*\|\s*$/.test(L[k])) {
    const c = (L[k].match(/\|/g) || []).length;
    if (c !== cols) { console.log(`  FAIL table row ${k + 1}: ${c} pipes, header ${cols}`); bad++; }
    k++;
  }
}
console.log(`  tables checked: ${tables}`);
console.log(bad === 0 ? `\nALL ${checks.length} CHECKS PASSED` : `\n${bad} CHECK(S) FAILED`);
process.exit(bad ? 1 : 0);
