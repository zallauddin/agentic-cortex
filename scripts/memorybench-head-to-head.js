#!/usr/bin/env node
'use strict';
/**
 * head-to-head.js — Granularity-controlled head-to-head on LoCoMo (no LLM judge).
 *
 * v3 — adds the real supermemory cloud provider (when SUPERMEMORY_API_KEY is set)
 * to the v2 granularity-controlled matrix.
 *
 *   filesystem@session  — MemoryBench's native filesystem provider (19 session docs)
 *   ac@session          — AC search restricted to session-transcript rows (19 docs)
 *   filesystem@turn     — same algorithm over ~415 per-turn docs
 *   ac@turn             — AC search restricted to dialog-turn rows (~415 docs)
 *   supermemory@session — supermemory cloud (hybrid search), same session haystack
 *
 * Supermemory design (cost-bounded, faithful):
 *   - Container scoping per CONVERSATION (`ac-h2h-<sampleId>`): all questions of a
 *     conversation share the same haystack sessions, so per-conversation containers
 *     give exactly the search scope the harness's per-question containers give, at
 *     4×19=76 ingest calls instead of N×19.
 *   - Ingest/search logic mirrors memorybench's SupermemoryProvider (same SDK v4:
 *     add → poll documents.get until done → search.memories hybrid).
 *   - Deterministic stratified sample (SM_SAMPLE_PER_CAT per category, default 5)
 *     keeps cloud calls bounded; the three-way table is computed on the sampled
 *     subset with AC/FS restricted to the same questions. AC/FS full-600 matrix
 *     is still reported for continuity with v2.
 *   - Checkpoint cache (supermemory-cache.json): re-runs reuse prior search
 *     results; only new questions hit the API. SM_FRESH=1 forces a re-run.
 *
 * Metric: hit@10 — >=50% ground-truth word overlap (words len>2) in top-10 context.
 *
 * Env: MB_ROOT, AC_DB, AC_PROJECT_ROOT, RUN_ID, OUT_DIR,
 *      SUPERMEMORY_API_KEY, SM_SAMPLE_PER_CAT, SM_FRESH
 */

const fs = require('fs');
const path = require('path');

const MB_ROOT = process.env.MB_ROOT || 'C:/Users/user/AppData/Local/Temp/memorybench';
const AC_DB = process.env.AC_DB || 'C:/Users/user/AppData/Local/Temp/ac-bench-h2-1789185422.db';
const AC_PROJECT_ROOT = process.env.AC_PROJECT_ROOT || 'D:/sourcecode/agentic-cortex';
const RUN_ID = process.env.RUN_ID || 'ac-harness-smoke';
const LOCOMO_PATH = path.join(MB_ROOT, 'data', 'benchmarks', 'locomo', 'locomo10.json');
const OUT_DIR = process.env.OUT_DIR || path.join(MB_ROOT, 'data', 'runs', 'ac-compare');
const K = 10;
const SM_API_KEY = process.env.SUPERMEMORY_API_KEY || '';
const SM_SAMPLE_PER_CAT = parseInt(process.env.SM_SAMPLE_PER_CAT || '5', 10);
const SM_FRESH = process.env.SM_FRESH === '1';
const SM_CACHE_PATH = path.join(OUT_DIR, 'supermemory-cache.json');

const { createRequire } = require('module');
const req = createRequire(path.join(MB_ROOT, 'package.json'));
const Database = req(path.join(AC_PROJECT_ROOT, 'node_modules', 'better-sqlite3'));

// ── Load LoCoMo ──────────────────────────────────────────────────────
const CATEGORY_NAMES = { 1: 'single_hop', 2: 'multi_hop', 3: 'temporal', 4: 'world_knowledge', 5: 'adversarial' };
const dataset = JSON.parse(fs.readFileSync(LOCOMO_PATH, 'utf-8'));

const conversations = new Map();
for (const item of dataset) {
  const conv = item.conversation;
  const sessions = [];
  for (let i = 1; i <= 100; i++) {
    const key = 'session_' + i;
    if (!conv[key]) break;
    const data = conv[key];
    if (!Array.isArray(data)) continue;
    sessions.push({
      id: item.sample_id + '-' + key,
      date: conv[key + '_date_time'] || '',
      // Same unified-message mapping as MemoryBench's LoCoMo loader:
      // speaker_a -> user, everyone else -> assistant.
      messages: data.map(t => ({
        role: t.speaker === conv.speaker_a ? 'user' : 'assistant',
        content: t.text || '',
        speaker: t.speaker || '?',
        dia_id: t.dia_id || '',
      })),
      turns: data.map(t => ({ speaker: t.speaker || '?', text: t.text || '', dia_id: t.dia_id || '' })),
    });
  }
  conversations.set(item.sample_id, { speakerA: conv.speaker_a, speakerB: conv.speaker_b, sessions });
}

const db = new Database(AC_DB, { readonly: true });
const containerRows = db.prepare(
  "SELECT DISTINCT project_path FROM observations WHERE project_path LIKE ?"
).all('%' + RUN_ID);
const availableQids = new Set(containerRows.map(r => {
  const base = r.project_path.split(/[\\/]/).pop();
  return base.replace('-' + RUN_ID, '');
}));

const questions = [];
for (const item of dataset) {
  (item.qa || []).forEach((qa, i) => {
    const qid = item.sample_id + '-q' + i;
    if (!availableQids.has(qid)) return;
    questions.push({
      questionId: qid,
      sampleId: item.sample_id,
      question: qa.question,
      groundTruth: String(qa.answer),
      evidence: qa.evidence || [],
      category: CATEGORY_NAMES[qa.category] || 'unknown',
      sessions: conversations.get(item.sample_id).sessions,
    });
  });
}
console.error('Questions with harness-ingested AC containers: ' + questions.length +
  ' (conversations: ' + [...new Set(questions.map(q => q.sampleId))].join(', ') + ')');

// ── Deterministic evaluation (identical for every provider) ──────────
function evaluate(hitContents, q) {
  const blob = hitContents.join(' ').toLowerCase();
  const gt = q.groundTruth.toLowerCase();
  let hit = false;
  if (gt.length > 3) {
    const words = gt.split(/\s+/).filter(w => w.length > 2);
    if (words.length > 0) {
      const matched = words.filter(w => blob.includes(w)).length;
      hit = matched >= Math.ceil(words.length * 0.5);
    }
  }
  if (!hit && q.evidence.length) {
    hit = q.evidence.some(eid => hitContents.some(c => c.toLowerCase().includes(String(eid).toLowerCase())));
  }
  return hit;
}

// ── AC runner (unit: 'session' | 'turn') ─────────────────────────────
const TAG_FOR_UNIT = { session: 'session-transcript', turn: 'dialog-turn' };

function ftsQuery(question) {
  return question.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function runAC(unit) {
  const tagFilter = TAG_FOR_UNIT[unit];
  const results = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (i % 100 === 0) console.error('  ac@' + unit + ' searching ' + i + '/' + questions.length + '...');
    const container = q.questionId + '-' + RUN_ID;
    const projectPath = path.join(AC_PROJECT_ROOT, container);
    const t0 = Date.now();
    let hits = [];
    try {
      const ftsMatch = ftsQuery(q.question).split(' ').filter(Boolean).map(w => '"' + w + '"').join(' OR ');
      const sql = tagFilter
        ? `SELECT o.title, o.content FROM observations_fts fts
           JOIN observations o ON o.id = fts.rowid
           WHERE observations_fts MATCH ? AND o.project_path = ? AND o.is_active = 1
             AND o.tags LIKE ?
           ORDER BY rank LIMIT ?`
        : `SELECT o.title, o.content FROM observations_fts fts
           JOIN observations o ON o.id = fts.rowid
           WHERE observations_fts MATCH ? AND o.project_path = ? AND o.is_active = 1
           ORDER BY rank LIMIT ?`;
      const args = tagFilter ? [ftsMatch, projectPath, '%' + tagFilter + '%', K] : [ftsMatch, projectPath, K];
      hits = db.prepare(sql).all(...args);
    } catch (e) {
      hits = [];
    }
    if (hits.length === 0) {
      try {
        const sql = tagFilter
          ? "SELECT title, content FROM observations WHERE project_path = ? AND is_active = 1 AND tags LIKE ? LIMIT ?"
          : "SELECT title, content FROM observations WHERE project_path = ? AND is_active = 1 LIMIT ?";
        const args = tagFilter ? [projectPath, '%' + tagFilter + '%', K] : [projectPath, K];
        hits = db.prepare(sql).all(...args);
      } catch (e) {
        hits = [];
      }
    }
    const latency = Date.now() - t0;
    const contents = hits.map(h => '[' + (h.title || '') + '] ' + (h.content || ''));
    results.push({
      questionId: q.questionId, category: q.category,
      hit: evaluate(contents, q), latencyMs: latency, returned: hits.length,
      top: contents.slice(0, 3).map(c => c.slice(0, 90)),
    });
  }
  return results;
}

// ── Filesystem runner (MemoryBench algorithm; unit: 'session' | 'turn') ──
function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 1);
}
function runFilesystem(unit) {
  const results = [];
  const docsByConv = new Map();
  for (const q of questions) {
    if (!docsByConv.has(q.sampleId)) {
      let docs;
      if (unit === 'session') {
        docs = q.sessions.map(s => ({
          id: s.id,
          content: s.turns.map(t => '[' + t.speaker + ']: ' + t.text).join('\n'),
        }));
      } else {
        docs = [];
        for (const s of q.sessions) {
          for (const t of s.turns) {
            const text = (t.text || '').trim();
            if (text.length < 30) continue;
            docs.push({ id: t.dia_id || s.id, content: '[' + t.speaker + ']: ' + text });
          }
        }
      }
      docsByConv.set(q.sampleId, docs);
    }
    const docs = docsByConv.get(q.sampleId);
    const queryTerms = tokenize(q.question);
    const scored = docs.map(d => {
      const lower = d.content.toLowerCase();
      let matchCount = 0, totalFreq = 0;
      for (const term of queryTerms) {
        if (lower.includes(term)) {
          matchCount++;
          let idx = 0, count = 0;
          while ((idx = lower.indexOf(term, idx)) !== -1) { count++; idx += term.length; }
          totalFreq += count;
        }
      }
      const coverage = queryTerms.length ? matchCount / queryTerms.length : 0;
      const freqBonus = Math.min(totalFreq / 100, 0.1);
      return { doc: d, score: Math.min(coverage + freqBonus, 1.0) };
    });
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, K);
    const contents = top.map(t => t.doc.content);
    results.push({
      questionId: q.questionId, category: q.category,
      hit: evaluate(contents, q), latencyMs: 0, returned: top.length,
      top: contents.slice(0, 3).map(c => c.slice(0, 90)),
    });
  }
  return results;
}

// ── Supermemory cloud provider (mirrors harness SupermemoryProvider) ──
function loadSupermemoryCache() {
  try { return JSON.parse(fs.readFileSync(SM_CACHE_PATH, 'utf-8')); }
  catch { return { ingested: {}, searches: {} }; }
}
function saveSupermemoryCache(cache) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(SM_CACHE_PATH, JSON.stringify(cache, null, 2));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runSupermemory(sample) {
  if (!SM_API_KEY) {
    return { skipped: 'no_api_key' };
  }
  const Supermemory = req('supermemory');
  const client = new Supermemory({ apiKey: SM_API_KEY });

  // Conversations covered by the sample
  const sampleConvs = [...new Set(sample.map(q => q.sampleId))];
  const totalSessions = sampleConvs.reduce((s, c) => s + conversations.get(c).sessions.length, 0);
  console.error('  supermemory: ' + sample.length + ' sampled questions across ' + sampleConvs.length +
    ' conversations (' + totalSessions + ' ingest calls + ' + sample.length + ' searches)');

  const cache = SM_FRESH ? { ingested: {}, searches: {} } : loadSupermemoryCache();
  cache.ingested = cache.ingested || {};
  cache.searches = cache.searches || {};

  // ── Ingest: one container per conversation, harness content format ──
  for (const convId of sampleConvs) {
    if (cache.ingested[convId] && cache.ingested[convId].status === 'done') continue;
    const container = 'ac-h2h-' + convId;
    const conv = conversations.get(convId);
    const documentIds = [];

    for (const session of conv.sessions) {
      // Exact content format from memorybench SupermemoryProvider.ingest():
      const sessionStr = JSON.stringify(session.messages).replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const content = session.date
        ? 'Here is the date the following session took place: ' + session.date + '\n\nHere is the session as a stringified JSON:\n' + sessionStr
        : 'Here is the session as a stringified JSON:\n' + sessionStr;
      const res = await client.add({
        content,
        containerTags: [container],
        metadata: { sessionId: session.id, ...(session.date ? { date: session.date } : {}) },
      });
      documentIds.push(res.id);
      await sleep(150); // gentle rate limiting
    }

    // ── awaitIndexing: poll documents.get until done/failed (harness logic) ──
    const pending = new Set(documentIds);
    const failedIds = [];
    let backoffMs = 1000;
    const deadline = Date.now() + 6 * 60 * 1000; // 6 min cap per conversation
    process.stderr.write('  supermemory: indexing ' + convId + ' (' + pending.size + ' docs) ');
    while (pending.size > 0 && Date.now() < deadline) {
      const checks = await Promise.allSettled([...pending].map(id => client.documents.get(id)));
      for (let i = 0; i < checks.length; i++) {
        if (checks[i].status !== 'fulfilled') continue;
        const doc = checks[i].value;
        if (doc.status === 'done' || doc.status === 'failed') {
          pending.delete([...pending][i]);
          if (doc.status === 'failed') failedIds.push(doc.id);
        }
      }
      process.stderr.write('.');
      if (pending.size > 0) { await sleep(backoffMs); backoffMs = Math.min(backoffMs * 1.2, 5000); }
    }
    process.stderr.write(' done' + (failedIds.length ? ' (' + failedIds.length + ' FAILED)' : '') + '\n');
    if (pending.size > 0) {
      console.error('  supermemory: indexing timeout for ' + convId + ' — ' + pending.size + ' docs still pending (continuing)');
    }
    cache.ingested[convId] = { container, status: 'done', documentIds, failedIds };
    saveSupermemoryCache(cache);
  }

  // ── Search: hybrid, containerTags per conversation (harness params) ──
  const results = [];
  for (let i = 0; i < sample.length; i++) {
    const q = sample[i];
    if (cache.searches[q.questionId] && !SM_FRESH) {
      results.push({ ...cache.searches[q.questionId], cached: true });
      continue;
    }
    const container = 'ac-h2h-' + q.sampleId;
    const t0 = Date.now();
    let contents = [];
    try {
      const response = await client.search.memories({
        q: q.question,
        containerTags: [container],
        limit: K,
        threshold: 0.3,
        searchMode: 'hybrid',
        include: { chunks: true },
      });
      const latency = Date.now() - t0;
      contents = (response.results || []).map(r =>
        r.memory || r.chunk || (r.chunks ? r.chunks.map(c => c.content).join(' ') : '') || ''
      );
      const entry = {
        questionId: q.questionId, category: q.category,
        hit: evaluate(contents, q), latencyMs: latency,
        returned: contents.length,
        top: contents.slice(0, 3).map(c => c.slice(0, 90)),
      };
      cache.searches[q.questionId] = entry;
      saveSupermemoryCache(cache);
      results.push(entry);
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (/api key|unauthorized|401/i.test(msg)) {
        return { skipped: 'invalid_api_key', error: msg };
      }
      console.error('  supermemory search failed for ' + q.questionId + ': ' + msg.slice(0, 120));
      results.push({
        questionId: q.questionId, category: q.category,
        hit: false, latencyMs: Date.now() - t0, returned: 0,
        top: ['ERROR: ' + msg.slice(0, 80)],
      });
    }
    await sleep(150);
  }
  return { skipped: null, results };
}

// ── Deterministic stratified sample for the cloud provider ───────────
function buildSample() {
  const byCat = {};
  for (const q of questions) (byCat[q.category] = byCat[q.category] || []).push(q);
  const sample = [];
  for (const cat of Object.keys(byCat).sort()) {
    if (cat === 'adversarial') continue; // unanswerable by design (no answer text)
    const qs = byCat[cat].slice().sort((a, b) => a.questionId.localeCompare(b.questionId));
    const stride = Math.max(1, Math.floor(qs.length / SM_SAMPLE_PER_CAT));
    for (let i = 0; i < qs.length && sample.filter(s => s.category === cat).length < SM_SAMPLE_PER_CAT; i += stride) {
      sample.push(qs[i]);
    }
  }
  return sample;
}

// ── Stats ─────────────────────────────────────────────────────────────
function summarize(rs) {
  const hits = rs.filter(r => r.hit).length;
  const byCat = {};
  for (const r of rs) {
    byCat[r.category] = byCat[r.category] || { hits: 0, total: 0 };
    byCat[r.category].total++;
    if (r.hit) byCat[r.category].hits++;
  }
  for (const c of Object.keys(byCat)) {
    const h = byCat[c].hits, t = byCat[c].total;
    byCat[c] = { recall: t ? Math.round(h / t * 1000) / 10 : 0, hits: h, total: t };
  }
  const latencies = rs.map(r => r.latencyMs).filter(x => x > 0);
  return {
    recallAtK: rs.length ? Math.round(hits / rs.length * 1000) / 10 : 0,
    hits, total: rs.length,
    byCategory: byCat,
    avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
  };
}
function restrict(results, ids) {
  const set = new Set(ids);
  return results.filter(r => set.has(r.questionId));
}

(async () => {
  const runs = {};

  console.error('[1/5] filesystem @ session-level units (MemoryBench native)...');
  runs['filesystem@session'] = runFilesystem('session');

  console.error('[2/5] agentic-cortex @ session-level units (matched)...');
  runs['agentic-cortex@session'] = await runAC('session');

  console.error('[3/5] filesystem @ turn-level units (matched)...');
  runs['filesystem@turn'] = runFilesystem('turn');

  console.error('[4/5] agentic-cortex @ turn-level units (adapter default)...');
  runs['agentic-cortex@turn'] = await runAC('turn');

  console.error('[5/5] supermemory cloud (session haystack, hybrid search)...');
  const sample = buildSample();
  let smRun = null;
  let smNote = null;
  if (!SM_API_KEY) {
    smNote = 'skipped: SUPERMEMORY_API_KEY not set — set it and re-run to add the cloud row (cached AC/FS results make that a supermemory-only run)';
    console.error('  ' + smNote);
  } else {
    smRun = await runSupermemory(sample);
    if (smRun.skipped) {
      smNote = 'skipped: ' + smRun.skipped + (smRun.error ? ' — ' + smRun.error : '');
      smRun = null;
      console.error('  ' + smNote);
    }
  }

  // Full AC/FS matrix (v2 continuity)
  const providersFull = Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, summarize(v)]));

  // Three-way on the sampled subset (fair cloud-vs-local comparison)
  const sampleIds = sample.map(q => q.questionId);
  const providersSample = {
    'filesystem@session': summarize(restrict(runs['filesystem@session'], sampleIds)),
    'agentic-cortex@session': summarize(restrict(runs['agentic-cortex@session'], sampleIds)),
  };
  if (smRun) providersSample['supermemory@session'] = summarize(smRun.results);

  const report = {
    title: 'MemoryBench Head-to-Head with Granularity Control: agentic-cortex vs filesystem vs supermemory (LoCoMo)',
    version: 3,
    harness: 'supermemoryai/memorybench',
    harnessRunId: RUN_ID,
    dataset: 'snap-research/locomo (locomo10.json)',
    k: K,
    questions: questions.length,
    conversations: [...new Set(questions.map(q => q.sampleId))],
    ranAt: new Date().toISOString(),
    evaluation: 'deterministic hit@k: >=50% ground-truth word overlap in top-k context (evidence dia_id path symmetric/absent for all)',
    supermemory: smRun
      ? {
          ran: true,
          sampleSize: sample.length,
          samplePerCategory: SM_SAMPLE_PER_CAT,
          sampledQuestionIds: sampleIds,
          containerScope: 'per-conversation (ac-h2h-<sampleId>) — same search scope as the harness per-question containers, 76 ingest calls instead of N*19',
          indexing: 'poll documents.get until done/failed (harness logic), 6 min cap per conversation',
          searchParams: 'search.memories {q, containerTags, limit:10, threshold:0.3, searchMode:hybrid, include.chunks}',
          cacheFile: SM_CACHE_PATH,
          cachedSearches: smRun.results.filter(r => r.cached).length,
        }
      : {
          ran: false,
          reason: smNote,
          plannedSampleSize: sample.length,
          samplePerCategory: SM_SAMPLE_PER_CAT,
          plannedSampledQuestionIds: sampleIds,
          containerScope: 'per-conversation (ac-h2h-<sampleId>)',
          cacheFile: SM_CACHE_PATH,
          note: 'set SUPERMEMORY_API_KEY and re-run — AC/FS rows are deterministic and the three-way table will use the recorded planned sample',
        },
    design: {
      controlledVariable: 'document granularity (unit size)',
      matchedPairs: {
        sessionLevel: ['filesystem@session', 'agentic-cortex@session', 'supermemory@session'],
        turnLevel: ['filesystem@turn', 'agentic-cortex@turn'],
      },
      unitCounts: 'session-level: 19 docs per question container; turn-level: ~415 docs (turns >= 30 chars, same threshold as AC adapter)',
      note: 'All providers scored with the identical deterministic matcher. AC/FS run on all 600 questions; supermemory on a deterministic stratified sample — the three-way table compares all providers on the SAME sampled subset.',
    },
    providersFull,
    providersSample,
    details: { ...runs, ...(smRun ? { 'supermemory@session': smRun.results } : {}) },
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));

  console.log('');
  console.log('='.repeat(76));
  console.log('  MemoryBench head-to-head, granularity-controlled - hit@' + K + ' (no LLM judge)');
  console.log('  harness: supermemoryai/memorybench | run: ' + RUN_ID + ' | questions: ' + questions.length);
  console.log('='.repeat(76));

  console.log('  THREE-WAY on supermemory sample (' + sampleIds.length + ' questions, session-level units):');
  for (const [name, s] of Object.entries(providersSample)) {
    console.log('    ' + name.padEnd(24) + ' ' + String(s.recallAtK).padStart(5) + '%  (' + s.hits + '/' + s.total + ')  avg ' + (s.avgLatencyMs ?? '-') + 'ms');
  }
  console.log('-'.repeat(76));
  console.log('  FULL AC/FS matrix (600 questions):');
  for (const [name, s] of Object.entries(providersFull)) {
    const units = name.endsWith('@session') ? '~19' : '~415';
    console.log('    ' + name.padEnd(24) + ' ' + String(s.recallAtK).padStart(5) + '%   ' + units);
  }
  console.log('-'.repeat(76));
  const cats = [...new Set(Object.values(providersSample).flatMap(p => Object.keys(p.byCategory)))];
  console.log('  three-way by category (recall% on sample):');
  console.log('    ' + ''.padEnd(16) + Object.keys(providersSample).map(n => n.replace('agentic-cortex', 'AC').replace('filesystem', 'FS').replace('supermemory', 'SM').padEnd(13)).join(''));
  for (const c of cats) {
    console.log('    ' + c.padEnd(16) + Object.values(providersSample)
      .map(p => String(p.byCategory[c] ? p.byCategory[c].recall + '%' : '-').padEnd(13)).join(''));
  }
  console.log('='.repeat(76));
  if (smNote) console.log('  supermemory: ' + smNote);
  console.log('  report: ' + path.join(OUT_DIR, 'report.json'));
  console.log('');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
