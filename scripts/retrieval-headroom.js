#!/usr/bin/env node
'use strict';
/**
 * retrieval-headroom.js — WHY does a question miss, not just THAT it misses.
 *
 * For every question, three nested oracles are computed over the same corpus:
 *
 *   oracle@corpus  some document in the project contains >=50% of the
 *                  ground-truth answer words          -> retrieval CAN succeed
 *   oracle@50      one of FTS5's top-50 candidates does -> the ranking stage
 *                  (which cuts to k) has the evidence available
 *   actual@10      the shipped top-10 does             -> what we score
 *
 * The gaps localize the failure:
 *   actual@10 < oracle@50        -> RANKING problem. Better ordering of the
 *                                   same candidates (rerank, rank fusion,
 *                                   pseudo-relevance feedback) wins here.
 *   oracle@50  < oracle@corpus   -> VOCABULARY problem. FTS5 never surfaces
 *                                   the right doc at all: the query and the
 *                                   evidence share no terms. Needs semantic
 *                                   retrieval / query expansion, not ranking.
 *   oracle@corpus is false       -> UNREACHABLE at any k. Either the metric's
 *                                   50% threshold is unachievable for that
 *                                   answer shape, or the answer words simply
 *                                   are not in the corpus (multi-session
 *                                   answers that span more than k docs).
 *
 * Env: K (default 10), CANDIDATES (default 50)
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { answerWords, coversWords, isScorable } = require('./lib/bench-metric');

const K = parseInt(process.env.K || '10', 10);
const CANDIDATES = parseInt(process.env.CANDIDATES || '50', 10);
const MB_ROOT = process.env.MB_ROOT || 'C:/Users/user/AppData/Local/Temp/memorybench';
const TMP = process.env.TMPDB || 'C:/Users/user/AppData/Local/Temp';

const CORPORA = [
  {
    name: 'LongMemEval-S',
    db: path.join(TMP, 'ac-mb-long.db'),
    results: path.join(MB_ROOT, 'data/runs/ac-lme-1/results'),
    dataset: path.join(MB_ROOT, 'data/benchmarks/longmemeval/datasets/longmemeval_s_cleaned.json'),
  },
  {
    name: 'LoCoMo smoke',
    db: path.join(TMP, 'ac-mb-smoke.db'),
    results: path.join(MB_ROOT, 'data/runs/ac-smoke1/results'),
    dataset: null,
  },
];

/** >=50% of answer words present in `blob` — the shipped metric. */
const covers = coversWords;

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

let anyFailure = false;

for (const c of CORPORA) {
  if (!fs.existsSync(c.db) || !fs.existsSync(c.results)) {
    console.error(`SKIP ${c.name}: missing db or results`);
    continue;
  }
  const db = new Database(c.db, { readonly: true });
  const byContent = db.prepare(
    'SELECT content FROM observations WHERE project_path = ? AND is_active = 1'
  );
  const candidateStmt = db.prepare(
    'SELECT o.id, o.content FROM observations_fts fts JOIN observations o ON o.id = fts.rowid ' +
      'WHERE observations_fts MATCH ? AND o.project_path = ? AND o.is_active = 1 ORDER BY rank LIMIT ?'
  );
  const contentById = db.prepare('SELECT content FROM observations WHERE id = ?');

  let byId = new Map();
  if (c.dataset && fs.existsSync(c.dataset)) {
    byId = new Map(JSON.parse(fs.readFileSync(c.dataset, 'utf8')).map((i) => [i.question_id, i]));
  }

  const rows = fs
    .readdirSync(c.results)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(c.results, f), 'utf-8')));

  const stats = {
    n: 0, actual: 0, oracleK: 0, oracleCand: 0, oracleCorpus: 0,
    rankingGap: 0, vocabGap: 0, unreachable: 0,
    byType: {},
  };
  const misses = [];

  for (const res of rows) {
    const gt = byId.size ? (byId.get(res.questionId) || {}).answer : res.groundTruth;
    const words = answerWords(gt);
    if (!isScorable(gt)) continue; // unanswerable / too short for word-overlap
    const project = path.join(MB_ROOT, res.containerTag);
    stats.n++;

    const t = res.questionType || 'unknown';
    stats.byType[t] = stats.byType[t] || { n: 0, actual: 0, oracleCand: 0, oracleCorpus: 0 };

    // 1) shipped top-10 (already materialised by the harness run)
    const topK = (res.results || [])
      .map((r) => (contentById.get(r.id) || { content: '' }).content)
      .join(' ');
    const hitActual = covers(topK, words);

    // 2) FTS candidates (same query construction as core)
    const safe = String(res.question).replace(/["']/g, '');
    const terms = [...new Set(safe.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))]
      .filter((w) => w.length > 0);
    const ftsQuery = terms.length ? terms.map((w) => '"' + w + '"').join(' OR ') : '';
    let candBlob = '';
    try {
      candBlob = candidateStmt
        .all(ftsQuery, project, CANDIDATES)
        .map((r) => r.content)
        .join(' ');
    } catch (err) {
      console.error(`FTS error: ${err.message}`);
      anyFailure = true;
    }
    const hitCand = covers(candBlob, words);

    // 3) whole corpus for this question
    let corpusBlob = '';
    try {
      corpusBlob = byContent.all(project).map((r) => r.content).join(' ');
    } catch (err) {
      console.error(`corpus error: ${err.message}`);
      anyFailure = true;
    }
    const hitCorpus = covers(corpusBlob, words);

    const s = stats.byType[t];
    s.n++;
    if (hitActual) { stats.actual++; s.actual++; }
    if (hitCand) { stats.oracleCand++; s.oracleCand++; }
    if (hitCorpus) { stats.oracleCorpus++; s.oracleCorpus++; }

    if (hitCorpus && !hitCand) stats.vocabGap++;
    else if (hitCand && !hitActual) stats.rankingGap++;
    else if (!hitCorpus) stats.unreachable++;

    if (!hitActual) {
      const matched = words.filter((w) => topK.toLowerCase().includes(w)).length;
      misses.push({
        id: res.questionId,
        type: t,
        matched: `${matched}/${words.length}`,
        corpus: hitCorpus ? 'in-corpus' : 'NOT-in-corpus',
        cand: hitCand ? `top${CANDIDATES}` : 'not-in-candidates',
        gt: String(gt).slice(0, 60),
      });
    }
  }

  console.log('');
  console.log('='.repeat(88));
  console.log(`  ${c.name} — retrieval headroom (answerable questions only, n=${stats.n})`);
  console.log('='.repeat(88));
  console.log(`  actual@${K}                ${pct(stats.actual, stats.n)}%   (${stats.actual}/${stats.n})  <- what we score`);
  console.log(`  oracle@${CANDIDATES} (ranking ceiling)  ${pct(stats.oracleCand, stats.n)}%   (${stats.oracleCand}/${stats.n})`);
  console.log(`  oracle@corpus (retrieval ceiling)     ${pct(stats.oracleCorpus, stats.n)}%   (${stats.oracleCorpus}/${stats.n})`);
  console.log('-'.repeat(88));
  console.log(`  RANKING headroom (in top${CANDIDATES}, not top${K}) : ${stats.rankingGap}  -> better ordering of same candidates`);
  console.log(`  VOCABULARY gap (in corpus, never a candidate)     : ${stats.vocabGap}  -> needs semantic / query expansion`);
  console.log(`  UNREACHABLE (answer words not in corpus)          : ${stats.unreachable}  -> no k fixes this`);
  console.log('-'.repeat(88));
  console.log('  by type:  n   actual  oracle@' + CANDIDATES + '  oracle@corpus');
  for (const [t, s] of Object.entries(stats.byType)) {
    console.log(
      `    ${t.padEnd(28)} ${String(s.n).padEnd(4)}${String(pct(s.actual, s.n) + '%').padEnd(9)}` +
        `${String(pct(s.oracleCand, s.n) + '%').padEnd(12)}${pct(s.oracleCorpus, s.n) + '%'}`
    );
  }
  if (misses.length) {
    console.log('-'.repeat(88));
    console.log(`  misses (${misses.length}):`);
    for (const m of misses) {
      console.log(`    ${m.id.padEnd(16)} ${m.type.padEnd(26)} ${m.matched.padEnd(6)} ${m.cand.padEnd(18)} ${m.corpus}`);
      console.log(`      gt: ${m.gt}`);
    }
  }
  console.log('='.repeat(88));
  db.close();
}

process.exit(anyFailure ? 1 : 0);
