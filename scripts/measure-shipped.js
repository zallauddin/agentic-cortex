#!/usr/bin/env node
'use strict';
/**
 * measure-shipped.js — score the REAL `api.search()` path on a MemoryBench run.
 *
 * strategy-sweep.js is a faithful *stand-in* for keyword search; this script
 * removes the last bit of doubt by driving `src/api/index.js` itself — the
 * same entry point MemoryBench's agentic-cortex adapter calls — with a given
 * combination of hardening flags, hydrating full content by id (search -> get,
 * the way real consumers use AC) and scoring with the shared metric.
 *
 * Questions, ground truth and the exact project path each container was
 * ingested under all come from the harness's own `results/*.json`, so the
 * measurement reproduces the benchmark conditions instead of approximating
 * them (no dataset file, no guessed project root).
 *
 * Usage:
 *   AC_DB=/tmp/ac-mb-long.db \
 *   RUN_DIR=C:/.../data/runs/ac-lme-1 \
 *   [FUSE=1] [CAP=3] [LIMIT=10] [RERANK=1] [TYPES=<substr>] [OUT=...] \
 *   node scripts/measure-shipped.js
 *
 * Reports accuracy over scorable questions (lib/bench-metric), total context
 * handed to the answerer, and a per-category breakdown.
 */

const path = require('path');
const fs = require('fs');
const { evaluate, isScorable } = require('./lib/bench-metric');
// Shared with the selection policies so this census cannot drift from what
// capPerSession / spreadAcrossSessions actually group by.
const { sessionGroupKey } = require('../src/core/search');

const AC_DB = process.env.AC_DB;
const RUN_DIR = process.env.RUN_DIR;
if (!AC_DB || !RUN_DIR) {
  console.error('usage: AC_DB=... RUN_DIR=... [FUSE=1] [CAP=3] [LIMIT=10] node scripts/measure-shipped.js');
  process.exit(2);
}

const FUSE = process.env.FUSE !== '0';
const CAP = process.env.CAP == null ? 3 : Number(process.env.CAP);
const LIMIT = parseInt(process.env.LIMIT || '10', 10);
const RERANK = process.env.RERANK !== '0';
const TXN = process.env.TXN ? parseInt(process.env.TXN, 10) : undefined;
const MINCOV = process.env.MINCOV ? parseFloat(process.env.MINCOV) : undefined;
const TEMPORAL = process.env.TEMPORAL === '1';
const SEL = process.env.SEL || '';
const MIND = process.env.MIND ? parseInt(process.env.MIND, 10) : undefined;
const EXPAND = process.env.EXPAND === '1';
const DIV = process.env.DIV ? parseFloat(process.env.DIV) : undefined;
const ONLY_TYPE = process.env.TYPES || '';

// The API resolves its DB from env, so this must be set before requiring it.
process.env.AGENTIC_CORTEX_DB = AC_DB;
const api = require(path.join(__dirname, '..', 'src', 'api', 'index.js'));
const Database = require('better-sqlite3');

const db = new Database(AC_DB, { readonly: true });
const hydrateStmt = db.prepare('SELECT content FROM observations WHERE id = ?');
// Project root the harness ingested under — every container path in the DB
// starts with it, so it is read back from the data rather than assumed.
const projectRoot = db
  .prepare('SELECT project_path FROM observations ORDER BY id LIMIT 1')
  .get().project_path.replace(/[\\/][^\\/]+$/, '');

function hydrate(r) {
  if (r.content && r.content.length > 300) return r.content;
  try {
    const row = hydrateStmt.get(Number(r.id));
    return row ? row.content : (r.preview || '');
  } catch { return r.preview || ''; }
}

const resultsDir = path.join(RUN_DIR, 'results');
const files = fs.readdirSync(resultsDir).filter((f) => f.endsWith('.json'));
const items = files.map((f) => JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf-8')))
  .filter((it) => !ONLY_TYPE || ONLY_TYPE.split(',').some((t) => String(it.questionType || '').includes(t.trim())));

(async () => {
  const rows = [];
  for (const it of items) {
    const project = path.join(projectRoot, it.containerTag);
    let results = [];
    try {
      results = await api.search(it.question, {
        project,
        limit: LIMIT,
        rerank: RERANK,
        maxPerSession: CAP || undefined,
        fuseTranscripts: FUSE,
        maxTranscripts: TXN,
        minCoverage: MINCOV,
        diversityLambda: DIV,
        temporalBoost: TEMPORAL,
        expandSessions: EXPAND,
        selectionPolicy: SEL || undefined,
        minDistinctSessions: MIND,
      });
    } catch (e) {
      console.error(`search failed for ${it.questionId}: ${e.message}`);
      continue;
    }
    const contents = results.map(hydrate);
    const gt = it.groundTruth;
    const scorable = isScorable(gt);
    if (process.env.DEBUG === '1') {
      const txIds = new Set(
        db.prepare("SELECT id FROM observations WHERE project_path = ? AND tags LIKE '%session-transcript%'")
          .all(project).map((r) => String(r.id))
      );
      const marks = results.map((r, i) => `${i + 1}${txIds.has(String(r.id)) ? 'TX' : '--'}:${r.id}`).join(' ');
      console.log(`${it.questionId} [${it.questionType}] hit=${!!(scorable && evaluate(contents, gt))} => ${marks}`);
    }
    rows.push({
      id: it.questionId,
      type: it.questionType || '',
      scorable,
      hit: scorable && evaluate(contents, gt),
      ctx: contents.reduce((s, c) => s + c.length, 0),
      n: results.length,
      // How many distinct conversations the top-k actually spans — the
      // precondition `minDistinctSessions` operates on.
      sessions: new Set(results.map((r) => sessionGroupKey(r)).filter(Boolean)).size,
      gt: String(gt),
    });
  }

  const sc = rows.filter((r) => r.scorable);
  const hits = sc.filter((r) => r.hit).length;
  const ctx = sc.map((r) => r.ctx).sort((a, b) => a - b);
  const med = ctx.length ? ctx[Math.floor(ctx.length / 2)] : 0;

  console.log(`\n=== api.search  fuse=${FUSE} txN=${TXN == null ? 'all' : TXN} cap=${CAP} limit=${LIMIT} sel=${SEL || 'rank'} mind=${MIND == null ? '-' : MIND} expand=${EXPAND} ===`);
  console.log(`project root: ${projectRoot}`);
  console.log(`questions: ${rows.length}  scorable: ${sc.length}  hits: ${hits}`);
  console.log(`ACCURACY: ${sc.length ? ((hits / sc.length) * 100).toFixed(1) : '0.0'}%  (${hits}/${sc.length})`);
  console.log(`unscorable (excluded from denominator): ${rows.length - sc.length}`);
  console.log(`context chars: total ${ctx.reduce((a, b) => a + b, 0)}  median ${med}`);
  const sess = rows.map((r) => r.sessions).sort((a, b) => a - b);
  if (sess.length) {
    console.log(`distinct conversations in top-${LIMIT}: ` +
      `min ${sess[0]} median ${sess[Math.floor(sess.length / 2)]} max ${sess[sess.length - 1]}  ` +
      `| below 5: ${sess.filter((s) => s < 5).length}/${sess.length}`);
  }

  const byType = new Map();
  for (const r of sc) {
    const t = r.type || '(none)';
    if (!byType.has(t)) byType.set(t, { n: 0, h: 0 });
    const b = byType.get(t);
    b.n++;
    if (r.hit) b.h++;
  }
  for (const [t, b] of [...byType].sort()) {
    console.log(`  ${t.padEnd(30)} ${((b.h / b.n) * 100).toFixed(1).padStart(5)}%  (${b.h}/${b.n})`);
  }

  if (process.env.OUT) {
    fs.writeFileSync(process.env.OUT, JSON.stringify({ fused: FUSE, txN: TXN, cap: CAP, limit: LIMIT, rows }, null, 2));
    console.log(`wrote ${process.env.OUT}`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
