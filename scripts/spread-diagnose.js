#!/usr/bin/env node
'use strict';
/**
 * spread-diagnose.js — is a "spread evidence across conversations" candidate
 * even capable of scoring, before any code is written?
 *
 * For every question in a named category, answer three questions in order:
 *
 *   1. REACHABLE  — does the ground truth's answer vocabulary appear anywhere
 *                   in the project at all? If not, no ranking policy can help;
 *                   the gap is vocabulary/extraction and belongs in Phase 4's
 *                   brief as a different kind of work.
 *   2. POOLED     — is an answer-bearing document inside the FTS top-K the
 *                   shipped path already looks at? If yes this is a *ranking*
 *                   problem, and a re-selection policy is the right lever.
 *   3. SPREAD     — how many DISTINCT sessions carry the evidence? If the
 *                   answer sits in one session, cross-conversation spreading
 *                   cannot help and will only cost slots. This is the gate
 *                   that says whether the hypothesis is even plausible.
 *
 * Usage:
 *   node scripts/spread-diagnose.js            # both corpora, named categories
 *   TYPES=multi-session node scripts/spread-diagnose.js
 *
 * Exit 0 if at least one target question is both pooled AND spread across
 * sessions (i.e. a candidate could plausibly win), 1 if none is.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { answerWords, isScorable } = require('./lib/bench-metric');

const MB_ROOT = process.env.MB_ROOT || path.join(os.tmpdir(), 'memorybench');
const TMP = process.env.AC_TMP || os.tmpdir();
const K = parseInt(process.env.K || '50', 10);
const ONLY_TYPES = (process.env.TYPES || '').split(',').map((s) => s.trim()).filter(Boolean);

const TARGETS = [
  { name: 'LoCoMo smoke', db: path.join(TMP, 'ac-mb-smoke.db'), runDir: path.join(MB_ROOT, 'data', 'runs', 'ac-smoke1') },
  { name: 'LongMemEval-S', db: path.join(TMP, 'ac-mb-long.db'), runDir: path.join(MB_ROOT, 'data', 'runs', 'ac-lme-1') },
];

if (!fs.existsSync(require.resolve('better-sqlite3'))) {
  console.error('better-sqlite3 unavailable');
  process.exit(1);
}
const Database = require('better-sqlite3');

let anyPlausible = false;

for (const t of TARGETS) {
  if (!fs.existsSync(t.db) || !fs.existsSync(path.join(t.runDir, 'results'))) {
    console.log(`SKIP ${t.name} (no DB/run)`);
    continue;
  }
  const db = new Database(t.db, { readonly: true });
  const root = db.prepare('SELECT project_path FROM observations ORDER BY id LIMIT 1')
    .get().project_path.replace(/[\\/][^\\/]+$/, '');

  const files = fs.readdirSync(path.join(t.runDir, 'results')).filter((f) => f.endsWith('.json'));
  const items = files.map((f) => JSON.parse(fs.readFileSync(path.join(t.runDir, 'results', f), 'utf8')))
    .filter((it) => isScorable(it.groundTruth))
    .filter((it) => !ONLY_TYPES.length || ONLY_TYPES.includes(it.questionType));

  if (items.length === 0) { db.close(); continue; }
  console.log(`\n=== ${t.name} — ${items.length} question(s)${ONLY_TYPES.length ? ` in [${ONLY_TYPES.join(', ')}]` : ''}`);

  const allObs = db.prepare(
    'SELECT id, title, content, tags FROM observations WHERE project_path = ? AND is_active = 1'
  );
  const ftsStmt = db.prepare(
    'SELECT o.id, o.title FROM observations_fts fts JOIN observations o ON o.id = fts.rowid ' +
    'WHERE observations_fts MATCH ? AND o.project_path = ? AND o.is_active = 1 ORDER BY rank LIMIT ?'
  );
  const sessionKey = (title) => String(title || '')
    .replace(/\s*\([^)]*\)\s*$/, '').replace(/\s*-\s*turn\s*$/, '').trim();

  for (const it of items) {
    const project = path.join(root, it.containerTag);
    const words = answerWords(it.groundTruth);
    let obs;
    try { obs = allObs.all(project); } catch { obs = []; }

    // 1. reachable: which observations contain at least half the answer words?
    const hitsIn = obs.filter((o) => {
      const blob = o.content.toLowerCase();
      const n = words.filter((w) => blob.includes(w)).length;
      return n >= Math.ceil(words.length * 0.5);
    });
    const reachableSessions = new Set(hitsIn.map((o) => sessionKey(o.title)));

    // 2. pooled: does the shipped FTS candidate list contain any of them?
    let pooled = [];
    try {
      const expr = it.question.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)
        .filter(Boolean).slice(0, 24).map((w) => `"${w}"`).join(' OR ');
      if (expr) pooled = ftsStmt.all(expr, project, K).map((r) => r.id);
    } catch { pooled = []; }
    const hitIds = new Set(hitsIn.map((o) => o.id));
    const pooledHit = pooled.filter((id) => hitIds.has(id)).length;

    // 3. spread: distinct sessions carrying the evidence
    const spread = reachableSessions.size;
    const plausible = hitsIn.length > 0 && pooledHit > 0 && spread >= 2;
    if (plausible) anyPlausible = true;

    console.log(
      `  ${plausible ? 'PLAUSIBLE ' : 'blocked    '} ${it.questionId} [${it.questionType}] ` +
      `reachable=${hitsIn.length ? 'yes' : 'NO'} ` +
      `in-pool=${pooledHit}/${pooled.length} ` +
      `sessions-with-evidence=${spread} ` +
      (hitsIn.length ? `(${[...reachableSessions].slice(0, 3).join(' | ').slice(0, 60)})` : '')
    );
  }
  db.close();
}

console.log(anyPlausible
  ? '\nVERDICT: at least one target question is pooled AND spread across sessions — a re-selection policy can plausibly score.'
  : '\nVERDICT: no target question is both inside the candidate pool and spread across sessions. Spreading slots cannot help; the gap is upstream (vocabulary, extraction, or a different k).');
process.exit(anyPlausible ? 0 : 1);
