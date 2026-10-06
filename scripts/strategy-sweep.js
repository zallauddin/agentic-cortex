#!/usr/bin/env node
'use strict';
/**
 * strategy-sweep.js — measure retrieval-hardening candidates on real AC data,
 * across BOTH benchmark corpora that still have hermetic DBs on this machine:
 *
 *   LongMemEval-S  (ac-mb-long.db,  30 questions)
 *   LoCoMo smoke   (ac-mb-smoke.db, 15 questions)  <- cross-dataset check
 *
 * Mirrors src/core/search.js keywordSearch() (the methodology MEMORYBENCH.md
 * already documents) so query-construction variants can be compared without
 * mutating core first. Ordering downstream of FTS rank is inert in the current
 * pipeline for keyword-only search: rerankResults soft-fails while embeddings
 * are off (score stays 0), applyOutcomeWeights is all-zero on a fresh DB, and
 * diversifyResults' token regex splits on /\\W+/ (a literal backslash) so MMR
 * redundancy is always 0 and it degenerates to plain relevance order. So
 * "FTS rank order" is a faithful stand-in for api.search()'s output.
 *
 * Every variant is scored with the SAME deterministic metric as
 * scripts/longmemeval-h2h.js (hit@10 = >=50% ground-truth word overlap), and
 * reports context cost alongside recall so a win bought with more text is
 * visible as such.
 *
 * Env: K (default 10), OVERFETCH (default 40)
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { evaluate, isScorable } = require('./lib/bench-metric');

const K = parseInt(process.env.K || '10', 10);
const OVERFETCH = parseInt(process.env.OVERFETCH || '40', 10);
const MB_ROOT = process.env.MB_ROOT || 'C:/Users/user/AppData/Local/Temp/memorybench';
const TMP = process.env.TMPDB || 'C:/Users/user/AppData/Local/Temp';

const CORPORA = [
  { name: 'LongMemEval-S', db: path.join(TMP, 'ac-mb-long.db'), results: path.join(MB_ROOT, 'data/runs/ac-lme-1/results') },
  { name: 'LoCoMo smoke', db: path.join(TMP, 'ac-mb-smoke.db'), results: path.join(MB_ROOT, 'data/runs/ac-smoke1/results') },
];

// ── stopwords (English function words; FTS5 has no built-in list) ──────────
const STOPWORDS = new Set(
  ('a an and are as at be but by for from had has have he her his i if in into is it its me my of on or our ' +
    'she so that the their them they this to was we were what when where which who will with you your about ' +
    'after before over under again then too very can just not no do does did done been being am than out up ' +
    'down off own same all any both each few more most other such only now')
    .split(/\s+/)
);

// ── query builders ─────────────────────────────────────────────────────────
/** Current production behaviour: sanitize quotes, split on spaces, quote each. */
function queryLegacy(q) {
  const safe = String(q).replace(/["']/g, '').trim();
  return safe.split(' ').map((w) => '"' + w + '"').join(' OR ');
}

/** Alphanumeric tokens, lowercased, deduped, punctuation stripped. */
function queryClean(q, { dropStopwords = false } = {}) {
  const safe = String(q).replace(/["']/g, '');
  let terms = [...new Set(safe.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))];
  if (terms.length === 0) return queryLegacy(q);
  if (dropStopwords) {
    const filtered = terms.filter((w) => !STOPWORDS.has(w));
    if (filtered.length > 0) terms = filtered;
  }
  if (terms.length > 24) terms = terms.slice(0, 24);
  return terms.map((w) => '"' + w + '"').join(' OR ');
}

// evaluate() is the shared matcher — see ./lib/bench-metric.js

function sessionKey(title) {
  return String(title || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s*-\s*turn\s*$/, '')
    .trim();
}

const median = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

// ── rerank stage: everything below reorders the SAME candidate set ─────────

/** Document frequency of each query term within one project (for IDF). */
function makeIdf(db) {
  const dfStmt = db.prepare(
    'SELECT count(*) n FROM observations_fts fts JOIN observations o ON o.id = fts.rowid ' +
      'WHERE observations_fts MATCH ? AND o.project_path = ? AND o.is_active = 1'
  );
  const nStmt = db.prepare(
    'SELECT count(*) n FROM observations WHERE project_path = ? AND is_active = 1'
  );
  const cache = new Map();
  return (project, terms) => {
    const key = project + '|' + terms.join(',');
    if (cache.has(key)) return cache.get(key);
    let N = 0;
    try { N = nStmt.get(project).n; } catch { N = 0; }
    const idf = new Map();
    for (const t of terms) {
      let df = 0;
      try { df = dfStmt.get('"' + t + '"', project).n; } catch { df = 0; }
      // Smoothed BM25 idf — always positive, unlike FTS5's raw form.
      idf.set(t, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
    }
    cache.set(key, idf);
    return idf;
  };
}

/** IDF-weighted share of the query terms a document actually contains.
 *  With `norm` the score is divided by a log length penalty so a long session
 *  transcript cannot win simply by containing every word somewhere. */
function coverageOf(docText, terms, idf, norm) {
  const text = String(docText);
  const lower = text.toLowerCase();
  let hit = 0;
  let total = 0;
  const seen = new Set();
  for (const t of terms) {
    const w = idf.get(t) || 0;
    total += w;
    if (seen.has(t)) continue;
    if (lower.includes(t)) { hit += w; seen.add(t); }
  }
  let score = total > 0 ? hit / total : 0;
  if (norm && score > 0) score = score / Math.log10(10 + text.length / 200);
  return score;
}

/** Reciprocal rank fusion of several rankings (Cormack 2009, k=60). */
function rrfFuse(rankLists, limit) {
  const score = new Map();
  const firstSeen = new Map();
  rankLists.forEach((list, li) => {
    list.forEach((row, i) => {
      const s = 1 / (60 + i + 1);
      score.set(row, (score.get(row) || 0) + s);
      if (!firstSeen.has(row)) firstSeen.set(row, { row, idx: i, list: li });
    });
  });
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || firstSeen.get(a[0]).idx - firstSeen.get(b[0]).idx)
    .map(([row]) => row)
    .slice(0, limit);
}

/**
 * RM3-lite pseudo-relevance feedback: assume the top-m candidates are
 * relevant, harvest their most distinctive terms, and re-query. The expanded
 * ranking is then fused with the original so a bad feedback round can only
 * hurt as much as RRF lets it.
 */
function rm3Expand(db, project, rows, terms, idf, m = 5, x = 8) {
  const freq = new Map();
  const stop = new Set(['the', 'and', 'for', 'you', 'that', 'with', 'this', 'was', 'have', 'not', 'are', 'but', 'they', 'his', 'her', 'from']);
  for (const r of rows.slice(0, m)) {
    const row = db.prepare('SELECT content FROM observations WHERE id = ?').get(r.id);
    if (!row) continue;
    for (const w of String(row.content).toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length < 3 || stop.has(w) || terms.includes(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  const expansion = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, x)
    .map(([w]) => w);
  if (expansion.length === 0) return [];
  const q = [...terms, ...expansion].map((t) => '"' + t + '"').join(' OR ');
  try {
    return db
      .prepare(
        'SELECT o.id, o.title, o.project_path, substr(o.content, 1, 300) as preview, rank FROM observations_fts fts JOIN observations o ON o.id = fts.rowid ' +
          'WHERE observations_fts MATCH ? AND o.project_path = ? AND o.is_active = 1 ORDER BY rank LIMIT 50'
      )
      .all(q, project);
  } catch { return []; }
}

/**
 * MMR as diversifyResults() *should* behave: its shipped regex splits on
 * /\\W+/ (literal backslash + W), which never matches, so every similarity
 * comes out 0 and MMR degenerates to plain relevance order. This uses the
 * intended /\W+/ tokenisation so we can measure what fixing it would do.
 */
function mmrSelect(rows, limit, lambda) {
  const tokensOf = (r) =>
    new Set(
      String((r.title || '') + ' ' + (r.preview || '') + ' ' + (r.content || ''))
        .toLowerCase()
        .split(/\W+/)
        .filter((t) => t.length > 2),
    );
  const cache = new Map(rows.map((r) => [r, tokensOf(r)]));
  const sim = (a, b) => {
    const ta = cache.get(a);
    const tb = cache.get(b);
    if (!ta.size || !tb.size) return 0;
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter++;
    return inter / Math.max(ta.size, tb.size);
  };
  const selected = [];
  const remaining = rows.slice();
  while (selected.length < limit && remaining.length > 0) {
    let best = null;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      const relevance = 1 / (rows.indexOf(c) + 1);
      const redundancy = selected.length === 0 ? 0 : Math.max(...selected.map((s) => sim(c, s)));
      const score = lambda * relevance - (1 - lambda) * redundancy;
      if (!best || score > best.score) best = { i, score };
    }
    selected.push(remaining[best.i]);
    remaining.splice(best.i, 1);
  }
  return selected;
}

// ── variant definitions ────────────────────────────────────────────────────
/** Query terms (same tokenisation as queryClean), used for coverage scoring. */
function termsOf(q) {
  const safe = String(q || '').replace(/["']/g, '');
  let terms = [...new Set(safe.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))];
  const stop = new Set(STOPWORDS);
  const filtered = terms.filter((t) => !stop.has(t));
  if (filtered.length > 0) terms = filtered;
  return terms.slice(0, 24);
}

const VARIANTS = [
  { name: 'A baseline (legacy query)', build: (q) => queryLegacy(q), limit: K },
  { name: 'B clean-nostop query', build: (q) => queryClean(q, { dropStopwords: true }), limit: K },
  { name: 'C clean + 2 fragments/session', build: (q) => queryClean(q, { dropStopwords: true }), limit: OVERFETCH, cap: 2 },
  { name: 'D clean + 3 fragments/session', build: (q) => queryClean(q, { dropStopwords: true }), limit: OVERFETCH, cap: 3 },
  { name: 'E clean + expand (shipped)', build: (q) => queryClean(q, { dropStopwords: true }), limit: K, expand: true },
  { name: 'F clean + expand + breadth', build: (q) => queryClean(q, { dropStopwords: true }), limit: OVERFETCH, expand: true, breadth: true },
  { name: 'G clean + strict dedupe (LME best)', build: (q) => queryClean(q, { dropStopwords: true }), limit: 80, cap: 1 },
  { name: 'H clean + MMR(fixed regex)', build: (q) => queryClean(q, { dropStopwords: true }), limit: K, mmr: true },
  { name: 'I BM25 top-50 control', build: (q) => queryClean(q, { dropStopwords: true }), limit: 50, cut: 'bm25' },
  { name: 'J IDF-coverage rerank', build: (q) => queryClean(q, { dropStopwords: true }), limit: 50, cut: 'idf' },
  { name: 'K RRF(bm25, coverage)', build: (q) => queryClean(q, { dropStopwords: true }), limit: 50, cut: 'rrf' },
  { name: 'L RM3-lite + RRF', build: (q) => queryClean(q, { dropStopwords: true }), limit: 50, cut: 'rm3' },
  { name: 'M cap3 + RRF', build: (q) => queryClean(q, { dropStopwords: true }), limit: 50, cap: 3, cut: 'rrf' },
  { name: 'N cap3 + IDF-cov', build: (q) => queryClean(q, { dropStopwords: true }), limit: 50, cap: 3, cut: 'idf' },
  { name: 'O cap3 + RRF (len-norm cov)', build: (q) => queryClean(q, { dropStopwords: true }), limit: 50, cap: 3, cut: 'rrf', norm: true },
  { name: 'P two-channel RRF (frag+session)', build: (q) => queryClean(q, { dropStopwords: true }), limit: 50, cut: 'twochan' },
  { name: 'Q two-channel + coverage RRF', build: (q) => queryClean(q, { dropStopwords: true }), limit: 50, cut: 'twochan2' },
  { name: 'R two-channel + cap3', build: (q) => queryClean(q, { dropStopwords: true }), limit: 50, cap: 3, cut: 'twochan' },
  { name: 'S IDF-cov @200 candidates', build: (q) => queryClean(q, { dropStopwords: true }), limit: 200, cut: 'idf' },
  { name: 'T cap3 + IDF-cov @200', build: (q) => queryClean(q, { dropStopwords: true }), limit: 200, cap: 3, cut: 'idf' },
  { name: 'U two-channel @200', build: (q) => queryClean(q, { dropStopwords: true }), limit: 200, cut: 'twochan' },
  { name: 'V coverage over ALL transcripts + FTS', build: (q) => queryClean(q, { dropStopwords: true }), limit: 50, cut: 'alltx' },
  { name: 'W all-transcripts + cap3', build: (q) => queryClean(q, { dropStopwords: true }), limit: 50, cap: 3, cut: 'alltx' },
];

/**
 * Ranking-stage variants: take the same over-fetched candidate set (ranked by
 * FTS5 BM25) and decide how to cut it to k. This is exactly where the headroom
 * measured by scripts/retrieval-headroom.js lives — on LongMemEval the
 * vocabulary gap is 0, so only ordering of existing candidates can move the
 * number.
 */
function cutStage(rows, v, db, project, question, idfFor) {
  const terms = termsOf(question);
  const idf = idfFor(project, terms);
  const cov = (r) => coverageOf(r.full || r.preview, terms, idf, v.norm);
  const byCoverage = [...rows].sort((a, b) => cov(b) - cov(a));

  if (v.cut === 'bm25') return rows.slice(0, K);
  if (v.cut === 'idf') return byCoverage.slice(0, K);
  if (v.cut === 'rrf') return rrfFuse([rows, byCoverage], K);
  if (v.cut === 'rm3') {
    const expanded = rm3Expand(db, project, rows, terms, idf);
    return expanded.length ? rrfFuse([rows, expanded], K) : rows.slice(0, K);
  }
  // Two-channel retrieval: AC stores each conversation BOTH as a full
  // transcript and as individual turns. BM25 length-normalisation buries the
  // transcripts (they run ~10-20K chars), so the document that actually
  // contains the answer ranks 58-187 and never reaches k. Running a second
  // pass restricted to transcripts and fusing it with the fragment ranking
  // lets each granularity vote — this is the structural advantage AC has over
  // a single-granularity store, and the benchmark's filesystem@session wins
  // precisely by scoring sessions.
  // Full-coverage transcript channel: rank EVERY conversation transcript in
  // the project by query coverage, not just the ones bm25 happened to match.
  // This is the move that closes the gap to filesystem@session — bm25's
  // length normalisation pushes a 13K-char transcript holding the answer past
  // rank 50 (observed: 58, 143, 187), so no downstream reranker can ever see
  // it. Scoring all transcripts directly is what filesystem@session does to
  // good effect, and it is cheap: ~40 documents per question.
  if (v.cut === 'alltx') {
    const tx = allTranscripts(db, project);
    const txByCoverage = [...tx].sort((a, b) => cov(b) - cov(a));
    const fused = rrfFuse([rows, txByCoverage], K);
    return fused.length >= K ? fused : rows.slice(0, K);
  }
  if (v.cut === 'twochan' || v.cut === 'twochan2') {
    const sessionRows = sessionChannel(db, project, terms, v.limit || 50);
    const lists = [rows, sessionRows];
    if (v.cut === 'twochan2') lists.push(byCoverage);
    const fused = rrfFuse(lists, K);
    return fused.length >= K ? fused : rrfFuse([rows, sessionRows], K);
  }
  return rows.slice(0, K);
}

/** Every conversation transcript in a project, for full-coverage ranking. */
function allTranscripts(db, project) {
  try {
    return db
      .prepare(
        'SELECT id, title, project_path, substr(content, 1, 300) as preview, content as full ' +
          "FROM observations WHERE project_path = ? AND is_active = 1 AND tags LIKE '%session-transcript%'"
      )
      .all(project);
  } catch { return []; }
}

/** Second retrieval channel: BM25 over conversation transcripts only. */
function sessionChannel(db, project, terms, limit) {
  const q = terms.map((t) => '"' + t + '"').join(' OR ');
  if (!q) return [];
  try {
    return db
      .prepare(
        'SELECT o.id, o.title, o.project_path, substr(o.content, 1, 300) as preview, o.content as full, rank ' +
          'FROM observations_fts fts JOIN observations o ON o.id = fts.rowid ' +
          "WHERE observations_fts MATCH ? AND o.project_path = ? AND o.is_active = 1 AND o.tags LIKE '%session-transcript%' " +
          'ORDER BY rank LIMIT ?'
      )
      .all(q, project, limit);
  } catch { return []; }
}

/** Cap fragments per session across a whole candidate pool (no k cut). */
function capPool(rows, per) {
  const counts = new Map();
  const out = [];
  for (const r of rows) {
    const key = sessionKey(r.title);
    const n = counts.get(key) || 0;
    if (n >= per) continue;
    counts.set(key, n + 1);
    out.push(r);
  }
  return out;
}

function applyVariant(rows, v, db, project) {
  if (v.mmr) rows = mmrSelect(rows, K, 0.72);
  if (v.cap) {
    // Keep up to `cap` fragments from each session — preserves the
    // within-session evidence that strict dedupe throws away (which is what
    // cost it 13 points on LoCoMo) while still spreading across sessions.
    const per = new Map();
    const out = [];
    for (const r of rows) {
      const key = sessionKey(r.title);
      const n = per.get(key) || 0;
      if (n >= v.cap) continue;
      per.set(key, n + 1);
      out.push(r);
      if (out.length >= K) break;
    }
    return out;
  }
  if (v.expand) {
    // Shipped behaviour: first hit of each session becomes that session's
    // transcript; fragments the transcript covers are dropped.
    const out = [];
    const seen = new Set();
    for (const r of rows) {
      const key = sessionKey(r.title);
      if (seen.has(key)) continue;
      seen.add(key);
      const transcript = db
        .prepare(
          "SELECT id, title FROM observations WHERE project_path = ? AND is_active = 1 AND tags LIKE '%session-transcript%' AND title LIKE ? ORDER BY length(content) DESC LIMIT 1"
        )
        .get(project, key + ' (%');
      out.push(transcript ? { id: transcript.id, title: transcript.title } : r);
      if (out.length >= K) break;
    }
    if (!v.breadth) return out;
    // Breadth fill: top up toward K *distinct* sessions with the best
    // fragment from sessions not already represented (targets the
    // multi-session / temporal questions that a single OR-query clusters).
    const have = new Set(out.map((r) => sessionKey(r.title)));
    for (const r of rows) {
      if (out.length >= K) break;
      const key = sessionKey(r.title);
      if (have.has(key)) continue;
      have.add(key);
      out.push(r);
    }
    return out;
  }
  return rows.slice(0, K);
}

// ── run ────────────────────────────────────────────────────────────────────
let anyFailure = false;
const summary = [];

for (const corpus of CORPORA) {
  if (!fs.existsSync(corpus.db) || !fs.existsSync(corpus.results)) {
    console.error(`SKIP ${corpus.name}: missing db or results`);
    continue;
  }
  const db = new Database(corpus.db, { readonly: true });
  const contentStmt = db.prepare('SELECT content FROM observations WHERE id = ?');
  const ftsStmt = db.prepare(
    'SELECT o.id, o.title, o.project_path, substr(o.content, 1, 300) as preview, o.content as full, rank FROM observations_fts fts JOIN observations o ON o.id = fts.rowid ' +
      'WHERE observations_fts MATCH ? AND o.project_path = ? AND o.is_active = 1 ORDER BY rank LIMIT ?'
  );
  const idfFor = makeIdf(db);

  const questions = fs
    .readdirSync(corpus.results)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(corpus.results, f), 'utf-8')));

  const stats = {};
  for (const v of VARIANTS) stats[v.name] = { hits: 0, chars: [], sessions: [], types: {} };
  let scored = 0;
  let excluded = [];

  for (const res of questions) {
    const project = path.join(MB_ROOT, res.containerTag);
    const gt = res.groundTruth;
    if (!isScorable(gt)) { excluded.push(res.questionId); continue; }
    scored++;
    for (const v of VARIANTS) {
      let rows = [];
      try {
        rows = ftsStmt.all(v.build(res.question), project, v.limit);
      } catch (err) {
        console.error(`FTS error (${corpus.name}): ${err.message}`);
        anyFailure = true;
      }
      let chosen;
      if (v.cut) {
        const pool = v.cap ? capPool(rows, v.cap) : rows;
        chosen = cutStage(pool, v, db, project, res.question, idfFor);
      } else {
        chosen = applyVariant(rows, v, db, project);
      }
      const contents = chosen.map((r) => (contentStmt.get(r.id) || { content: '' }).content);
      const hit = evaluate(contents, gt);
      const s = stats[v.name];
      if (hit) s.hits++;
      s.chars.push(contents.reduce((a, c) => a + c.length, 0));
      s.sessions.push(new Set(chosen.map((r) => sessionKey(r.title))).size);
      const t = res.questionType || 'unknown';
      s.types[t] = s.types[t] || { h: 0, n: 0 };
      s.types[t].n++;
      if (hit) s.types[t].h++;
    }
  }

  const total = scored;
  const basePct = Math.round((stats[VARIANTS[0].name].hits / (total || 1)) * 1000) / 10;

  console.log('');
  console.log('='.repeat(100));
  console.log(`  ${corpus.name}  |  hit@${K} = >=50% ground-truth word overlap  |  scored ${total}/${questions.length} (excluded ${excluded.length}: ${excluded.join(', ') || 'none'})`);
  console.log('='.repeat(100));
  console.log('  ' + 'variant'.padEnd(38) + 'hit@K'.padEnd(10) + 'ctx(med)'.padEnd(12) + 'sess'.padEnd(7) + 'delta');
  console.log('-'.repeat(100));
  for (const v of VARIANTS) {
    const s = stats[v.name];
    const pct = Math.round((s.hits / total) * 1000) / 10;
    const d = Math.round((pct - basePct) * 10) / 10;
    console.log(
      '  ' +
        v.name.padEnd(38) +
        (pct + '%').padEnd(10) +
        String(median(s.chars)).padEnd(12) +
        String(median(s.sessions)).padEnd(7) +
        (d === 0 ? '—' : (d > 0 ? '+' : '') + d),
    );
  }
  console.log('-'.repeat(100));
  const typeNames = [...new Set(Object.values(stats).flatMap((s) => Object.keys(s.types)))];
  console.log('  by type (hit@K):  ' + VARIANTS.map((v, i) => String.fromCharCode(65 + i)).join('   '));
  for (const t of typeNames) {
    let line = '    ' + t.padEnd(30);
    for (const v of VARIANTS) {
      const e = stats[v.name].types[t];
      line += (e ? Math.round((e.h / e.n) * 100) + '%' : '—').padEnd(7);
    }
    console.log(line);
  }
  console.log('='.repeat(100));

  summary.push({ corpus: corpus.name, total, base: basePct, stats });
  db.close();
}

// ── cross-corpus verdict ───────────────────────────────────────────────────
console.log('');
console.log('  CROSS-CORPUS VERDICT (hit@K delta vs baseline; context ratio vs baseline)');
console.log('-'.repeat(100));
for (let i = 0; i < VARIANTS.length; i++) {
  const v = VARIANTS[i];
  const parts = [];
  let improved = 0;
  let cheaper = true;
  for (const s of summary) {
    const b = s.stats[VARIANTS[0].name];
    const cur = s.stats[v.name];
    const bp = (b.hits / s.total) * 100;
    const cp = (cur.hits / s.total) * 100;
    parts.push(`${s.corpus} ${Math.round((cp - bp) * 10) / 10 >= 0 ? '+' : ''}${Math.round((cp - bp) * 10) / 10}`);
    if (cp >= bp) improved++;
    if (median(cur.chars) > median(b.chars)) cheaper = false;
  }
  const noRegression = improved === summary.length;
  const tag = i === 0 ? '(baseline)' : noRegression ? (cheaper ? 'WINS' : 'win/more-ctx') : 'regression';
  console.log('  ' + String.fromCharCode(65 + i) + ' ' + v.name.padEnd(38) + parts.join('  ').padEnd(34) + tag);
}
console.log('-'.repeat(100));
process.exit(anyFailure ? 1 : 0);
