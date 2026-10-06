#!/usr/bin/env node
'use strict';
/**
 * longmemeval-h2h.js — LongMemEval retrieval head-to-head (no LLM judge).
 *
 * Scores two providers on the SAME sampled questions with the SAME
 * deterministic metric as scripts/memorybench-head-to-head.js:
 *
 *   agentic-cortex  — top-10 already retrieved by the real MemoryBench
 *                     harness search phase (results/<qid>.json), produced by
 *                     `run -p agentic-cortex -b longmemeval -s 5`.
 *   filesystem      — MemoryBench's filesystem algorithm (term-coverage +
 *                     freq bonus), re-run here at session level and at
 *                     message (turn) level over each question's haystack.
 *
 * Metric: hit@10 — >=50% of ground-truth answer words (len>2) appear
 * anywhere in the top-10 context blob. Identical matcher to the LoCoMo
 * head-to-head so the two reports are comparable. No LLM judge: this
 * measures retrieval recall, not answer accuracy.
 *
 * Env: MB_ROOT (memorybench clone), RUN_DIR (harness run dir with results/),
 *      OUT_DIR, K
 */

const fs = require('fs');
const path = require('path');
const { evaluate, isScorable } = require('./lib/bench-metric');

const MB_ROOT = process.env.MB_ROOT || 'C:/Users/user/AppData/Local/Temp/memorybench';
const RUN_DIR =
  process.env.RUN_DIR || path.join(MB_ROOT, 'data', 'runs', 'ac-lme-1');
const DATASET_PATH =
  process.env.DATASET_PATH ||
  path.join(MB_ROOT, 'data', 'benchmarks', 'longmemeval', 'datasets', 'longmemeval_s_cleaned.json');
const OUT_DIR = process.env.OUT_DIR || path.join(RUN_DIR, 'h2h');
const K = parseInt(process.env.K || '10', 10);
// AC's search returns only a 300-char preview; hydrate the full stored
// content by id so the metric scores the same evidence a real consumer gets
// (memory_search -> memory_get). Rank order is untouched.
const AC_DB = process.env.AC_DB || '';
let acGet = null;
if (AC_DB) {
  const Database = require('better-sqlite3');
  const db = new Database(AC_DB, { readonly: true });
  const stmt = db.prepare('SELECT content FROM observations WHERE id = ?');
  acGet = (id) => {
    try { const r = stmt.get(Number(id)); return r ? r.content : null; } catch { return null; }
  };
  console.error(`AC hydration: ${AC_DB}`);
}

// ── Dataset ───────────────────────────────────────────────────────────
const dataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8'));
const byId = new Map(dataset.map((it) => [it.question_id, it]));
console.error(`dataset: ${dataset.length} questions at ${DATASET_PATH}`);

const resultsDir = path.join(RUN_DIR, 'results');
const resultFiles = fs.readdirSync(resultsDir).filter((f) => f.endsWith('.json'));
console.error(`harness results: ${resultFiles.length} questions`);

// ── Deterministic evaluation (identical to head-to-head v3) ───────────
// evaluate() comes from ./lib/bench-metric (shared matcher + scorbility).

// ── Filesystem runner (MemoryBench algorithm; session | turn units) ──
// Faithful mirror of memorybench src/providers/filesystem/index.ts:
// tokenize() and scoreDocument() are copied verbatim (term coverage +
// min(freq/100, 0.1) capped at 1.0), and selection matches its
// score>0 filter, matchCount tiebreak and chronological score=0 fill.
function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1);
}
function scoreDocument(queryTerms, docText) {
  if (queryTerms.length === 0) return { score: 0, matchCount: 0 };
  const docLower = docText.toLowerCase();
  let matchCount = 0;
  let totalFrequency = 0;
  for (const term of queryTerms) {
    if (docLower.includes(term)) {
      matchCount++;
      let idx = 0;
      let count = 0;
      while ((idx = docLower.indexOf(term, idx)) !== -1) { count++; idx += term.length; }
      totalFrequency += count;
    }
  }
  const termCoverage = matchCount / queryTerms.length;
  const frequencyBonus = Math.min(totalFrequency / 100, 0.1);
  return { score: Math.min(termCoverage + frequencyBonus, 1.0), matchCount };
}
function fsScoreDocs(docs, question) {
  const queryTerms = tokenize(question);
  const scored = docs.map((d) => ({ doc: d, ...scoreDocument(queryTerms, d.content) }));
  scored.sort((a, b) => b.score - a.score || b.matchCount - a.matchCount);
  const limit = K;
  const positive = scored.filter((r) => r.score > 0);
  const chosen =
    positive.length >= limit
      ? positive.slice(0, limit)
      : [...positive, ...scored.filter((r) => r.score === 0)].slice(0, limit);
  return chosen.map((s) => s.doc.content);
}
function buildDocs(item, unit) {
  const docs = [];
  item.haystack_sessions.forEach((session, i) => {
    const msgs = Array.isArray(session) ? session : [];
    if (unit === 'session') {
      docs.push({
        id: item.haystack_session_ids[i] || 'sess' + i,
        content: msgs.map((m) => `[${m.role}]: ${m.content}`).join('\n'),
      });
    } else {
      for (const m of msgs) {
        const text = (m.content || '').trim();
        if (text.length < 30) continue;
        docs.push({ id: (item.haystack_session_ids[i] || 'sess' + i) + '#' + docs.length, content: `[${m.role}]: ${text}` });
      }
    }
  });
  return docs;
}

// ── Run both providers over the same questions ───────────────────────
const perQuestion = [];
for (const f of resultFiles) {
  const res = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf-8'));
  const item = byId.get(res.questionId);
  if (!item) {
    console.error(`  skip ${res.questionId}: not in dataset`);
    continue;
  }
  const gt = item.answer;
  const acContents = (res.results || []).map((r) => {
    if (!acGet) return r.content || '';
    const full = acGet(r.id);
    return full && full.length > (r.content || '').length ? full : (r.content || '');
  });
  const fsSession = fsScoreDocs(buildDocs(item, 'session'), res.question);
  const fsTurn = fsScoreDocs(buildDocs(item, 'turn'), res.question);
  const chars = (arr) => arr.reduce((a, c) => a + String(c).length, 0);
  const hayChars = item.haystack_sessions.reduce(
    (a, s) => a + s.reduce((b, m) => b + String(m.content || '').length, 0),
    0,
  );
  perQuestion.push({
    questionId: res.questionId,
    type: item.question_type,
    question: res.question,
    scorable: isScorable(item.answer),
    hits: {
      'agentic-cortex@default': evaluate(acContents, gt),
      'filesystem@session': evaluate(fsSession, gt),
      'filesystem@turn': evaluate(fsTurn, gt),
    },
    contextChars: {
      'agentic-cortex@default': chars(acContents),
      'filesystem@session': chars(fsSession),
      'filesystem@turn': chars(fsTurn),
      haystack: hayChars,
    },
    latencies: { 'agentic-cortex@default': res.durationMs },
  });
}

// ── Aggregate ─────────────────────────────────────────────────────────
const providers = ['agentic-cortex@default', 'filesystem@session', 'filesystem@turn'];
function summarize(rows) {
  const out = {};
  const scored = rows.filter((r) => r.scorable);
  for (const p of providers) {
    const hits = scored.filter((r) => r.hits[p]).length;
    out[p] = {
      recallAtK: scored.length ? Math.round((hits / scored.length) * 1000) / 10 : 0,
      hits,
      total: scored.length,
      rawHits: rows.filter((r) => r.hits[p]).length,
      rawTotal: rows.length,
    };
  }
  return out;
}
const overall = summarize(perQuestion);
const types = [...new Set(perQuestion.map((r) => r.type))];
const byType = {};
for (const t of types) byType[t] = summarize(perQuestion.filter((r) => r.type === t));

// Context cost: recall is meaningless without the token budget it was bought
// with. FS@session ranks whole sessions, so its top-10 can be a large slice of
// the corpus; AC's top-10 is ~1% of it.
const median = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const mean = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);
const ctx = {};
for (const p of providers) {
  const chars = perQuestion.map((r) => r.contextChars[p]);
  ctx[p] = { medianChars: median(chars), meanChars: mean(chars) };
}
const acChars = perQuestion.map((r) => r.contextChars['agentic-cortex@default']);
const fsSChars = perQuestion.map((r) => r.contextChars['filesystem@session']);
const fsTChars = perQuestion.map((r) => r.contextChars['filesystem@turn']);
const hayChars = perQuestion.map((r) => r.contextChars.haystack);
const contextCost = {
  ...ctx,
  medianHaystackChars: median(hayChars),
  medianPctOfHaystack: {
    'agentic-cortex@default': median(acChars.map((c, i) => Math.round((100 * c) / hayChars[i]))),
    'filesystem@session': median(fsSChars.map((c, i) => Math.round((100 * c) / hayChars[i]))),
    'filesystem@turn': median(fsTChars.map((c, i) => Math.round((100 * c) / hayChars[i]))),
  },
  fsSessionVsAcRatio: median(fsSChars.map((c, i) => Math.round(c / Math.max(acChars[i], 1)))),
  fsTurnVsAcRatio: median(fsTChars.map((c, i) => Math.round(c / Math.max(acChars[i], 1)))),
  note: 'context chars placed in the prompt per question; lower is cheaper',
};

const report = {
  title: 'LongMemEval retrieval head-to-head: agentic-cortex vs filesystem (no LLM judge)',
  version: 1,
  harness: 'supermemoryai/memorybench',
  harnessRunId: path.basename(RUN_DIR),
  dataset: 'xiaowu0162/longmemeval-cleaned (longmemeval_s_cleaned.json, 500 questions)',
  k: K,
  questions: perQuestion.length,
  questionsScored: perQuestion.filter((q) => q.scorable).length,
  questionsUnscorable: perQuestion.filter((q) => !q.scorable).map((q) => q.questionId),
  sampling: '5 per category, consecutive (harness sampling)',
  ranAt: new Date().toISOString(),
  evaluation:
    'deterministic hit@k: >=50% ground-truth answer word overlap (words len>2) in top-k context — same matcher as the LoCoMo head-to-head; retrieval recall, not LLM-judged answer accuracy. Questions whose answer has no word longer than 2 chars (e.g. "2", "25") are EXCLUDED from the denominator, not counted as misses: word-overlap cannot judge them (see scripts/lib/bench-metric.js). providers.*.rawHits/rawTotal preserve the unfiltered counts.',
  hydration: acGet
    ? `full content hydrated by id from ${AC_DB} (AC search returns 300-char previews; rank order unchanged)`
    : 'none (AC preview content as returned by search)',
  baselineDefinition:
    'filesystem = MemoryBench\'s own scoring algorithm (tokenize/scoreDocument/selection copied verbatim from src/providers/filesystem/index.ts) run over RAW session transcripts. The harness\'s native FilesystemProvider.ingest() first LLM-condenses each session via extractMemories(..., maxTokens: 2000) and stores that instead — this run had no LLM available for extraction, so filesystem@session carries more text per unit than the native provider would, and its context cost is an upper bound relative to it.',
  providers: overall,
  byType,
  contextCost,
  details: perQuestion,
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));

console.log('');
console.log('='.repeat(76));
console.log('  LongMemEval retrieval head-to-head — hit@' + K + ' (no LLM judge)');
console.log('  harness: supermemoryai/memorybench | run: ' + path.basename(RUN_DIR) + ' | questions: ' + perQuestion.length + ' (scored ' + perQuestion.filter((q) => q.scorable).length + ', excluded ' + perQuestion.filter((q) => !q.scorable).length + ')');
console.log('='.repeat(76));
for (const p of providers) {
  const s = overall[p];
  console.log('  ' + p.padEnd(26) + String(s.recallAtK).padStart(5) + '%  (' + s.hits + '/' + s.total + ' scored; raw ' + s.rawHits + '/' + s.rawTotal + ')');
}
console.log('-'.repeat(76));
console.log('  by question type (recall%):');
const col = (name) => name.replace('agentic-cortex@default', 'AC').replace('filesystem@session', 'FS@sess').replace('filesystem@turn', 'FS@turn');
console.log('    ' + ''.padEnd(26) + providers.map((p) => col(p).padEnd(9)).join(''));
for (const t of types) {
  console.log('    ' + t.padEnd(26) + providers.map((p) => String(byType[t][p].recallAtK + '%').padEnd(9)).join(''));
}
console.log('-'.repeat(76));
console.log('  context cost per question (chars placed in prompt):');
for (const p of providers) {
  console.log(
    '    ' + p.padEnd(26) +
    (ctx[p].medianChars + ' med / ' + ctx[p].meanChars + ' mean').padEnd(28) +
    contextCost.medianPctOfHaystack[p] + '% of haystack',
  );
}
console.log(
  '    FS@session costs ' + contextCost.fsSessionVsAcRatio +
  'x AC\'s context; FS@turn costs ' + contextCost.fsTurnVsAcRatio + 'x',
);
console.log('='.repeat(76));
console.log('  report: ' + path.join(OUT_DIR, 'report.json'));
