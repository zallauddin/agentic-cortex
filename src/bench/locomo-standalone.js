/**
 * locomo-standalone.js — LoCoMo Benchmark (Database-Free, v3).
 *
 * v3 improvements over v2:
 *   Step 1: BGE-large-en-v1.5 (1024-dim) — richer semantic embeddings
 *   Step 2: BM25 + lemmatization — proper sparse retrieval
 *   Step 3: Cross-turn entity graph — 2-hop boosting for multi-hop questions
 *
 * Usage:
 *   node src/bench/locomo-standalone.js [--top-k 200] [--conversations 0-9] [--model bge-large] [--method v3|v2]
 *
 * @module bench/locomo-standalone
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CATEGORY_NAMES = { 1: 'single_hop', 2: 'temporal', 3: 'multi_hop', 4: 'commonsense', 5: 'adversarial' };
const TOP_K = 200;

// Signal weights
const W_SEMANTIC = 0.60;
const W_KEYWORD = 0.40;
const ENTITY_BOOST = 1.30;
const ENTITY_2HOP_BOOST = 1.10; // Boost for turns connected via shared entities (Step 3)
const TEMPORAL_BOOST = 1.15;

// BM25 parameters
const BM25_K1 = 1.2;
const BM25_B = 0.75;

// ─── Embedding (Step 1: BGE-large support) ──────────────────────────

const _embeddingCache = new Map();
let _embedPipelineSingleton = null;
let _currentModel = null;

async function embed(text, modelName) {
  const key = (modelName || 'default') + '::' + text.slice(0, 200);
  if (_embeddingCache.has(key)) return _embeddingCache.get(key);

  // Get or create pipeline for the requested model
  if (!_embedPipelineSingleton || modelName !== _currentModel) {
    _currentModel = modelName;
    const { pipeline } = require('@xenova/transformers');
    _embedPipelineSingleton = await pipeline('feature-extraction', modelName);
  }

  const result = await _embedPipelineSingleton(text, { pooling: 'mean', normalize: true });
  const vec = Array.from(result.data);
  _embeddingCache.set(key, vec);
  return vec;
}

function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Step 2: BM25 + Lemmatization ───────────────────────────────────

/**
 * Lightweight rule-based lemmatizer.
 * Handles common English inflections without external dependencies.
 * Returns the base form (lemma) of a word.
 */
function lemmatize(word) {
  const w = word.toLowerCase();
  // Irregular forms (common conversational words)
  const IRREG = {
    'ran': 'run', 'running': 'run', 'runs': 'run',
    'went': 'go', 'going': 'go', 'goes': 'go', 'gone': 'go',
    'was': 'be', 'were': 'be', 'been': 'be', 'being': 'be', 'am': 'be', 'are': 'be', 'is': 'be',
    'had': 'have', 'has': 'have', 'having': 'have',
    'did': 'do', 'does': 'do', 'doing': 'do', 'done': 'do',
    'said': 'say', 'says': 'say', 'saying': 'say',
    'got': 'get', 'gets': 'get', 'getting': 'get',
    'took': 'take', 'takes': 'take', 'taking': 'take', 'taken': 'take',
    'made': 'make', 'makes': 'make', 'making': 'make',
    'knew': 'know', 'knows': 'know', 'known': 'know',
    'thought': 'think', 'thinks': 'think', 'thinking': 'think',
    'came': 'come', 'comes': 'come', 'coming': 'come',
    'gave': 'give', 'gives': 'give', 'giving': 'give', 'given': 'give',
    'told': 'tell', 'tells': 'tell', 'telling': 'tell',
    'felt': 'feel', 'feels': 'feel', 'feeling': 'feel',
    'found': 'find', 'finds': 'find', 'finding': 'find',
    'bought': 'buy', 'buys': 'buy', 'buying': 'buy',
    'brought': 'bring', 'brings': 'bring', 'bringing': 'bring',
    'spoke': 'speak', 'speaks': 'speak', 'speaking': 'speak', 'spoken': 'speak',
    'wrote': 'write', 'writes': 'write', 'writing': 'write', 'written': 'write',
    'chose': 'choose', 'chooses': 'choose', 'choosing': 'choose', 'chosen': 'choose',
    'drove': 'drive', 'drives': 'drive', 'driving': 'drive', 'driven': 'drive',
    'ate': 'eat', 'eats': 'eat', 'eating': 'eat', 'eaten': 'eat',
    'saw': 'see', 'sees': 'see', 'seeing': 'see', 'seen': 'see',
    'met': 'meet', 'meets': 'meet', 'meeting': 'meet',
    'began': 'begin', 'begins': 'begin', 'beginning': 'begin', 'begun': 'begin',
    'left': 'leave', 'leaves': 'leave', 'leaving': 'leave',
    'children': 'child', 'people': 'person', 'women': 'woman', 'men': 'man',
    'mice': 'mouse', 'teeth': 'tooth', 'feet': 'foot',
    'better': 'good', 'best': 'good', 'worse': 'bad', 'worst': 'bad',
    'more': 'many', 'most': 'many', 'less': 'little', 'least': 'little',
    'myself': 'me', 'yourself': 'you', 'himself': 'he', 'herself': 'she',
    'ourselves': 'we', 'yourselves': 'you', 'themselves': 'they',
  };
  if (IRREG[w]) return IRREG[w];

  // Rule-based suffix stripping
  if (w.endsWith('sses') || w.endsWith('shes') || w.endsWith('ches') || w.endsWith('xes') || w.endsWith('zes')) return w.slice(0, -2);
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('ves') && w.length > 4) return w.slice(0, -3) + 'f';
  if (w.endsWith('ses') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 4) return w.slice(0, -1);
  if (w.endsWith('ing') && w.length > 5) {
    const stem = w.slice(0, -3);
    if (stem.endsWith('nn') || stem.endsWith('tt') || stem.endsWith('mm')) return stem.slice(0, -1);
    return stem;
  }
  if (w.endsWith('ed') && w.length > 4) {
    const stem = w.slice(0, -2);
    if (stem.endsWith('nn') || stem.endsWith('tt') || stem.endsWith('mm')) return stem.slice(0, -1);
    if (stem.endsWith('i')) return stem.slice(0, -1) + 'y';
    return stem;
  }
  if (w.endsWith('er') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('est') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('ly') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ment') && w.length > 6) return w.slice(0, -4);
  if (w.endsWith('ness') && w.length > 6) return w.slice(0, -4);
  if (w.endsWith('tion') && w.length > 6) return w.slice(0, -4);
  if (w.endsWith('able') && w.length > 6) return w.slice(0, -4);

  return w;
}

/** Tokenize + lemmatize text, return array of lemmas. */
function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1)
    .map(lemmatize);
}

/**
 * Build BM25 index from turns.
 * Returns { idf, docLen, avgdl, docTerms } for scoring.
 */
function buildBM25(turns) {
  const N = turns.length;
  const docTerms = turns.map(t => tokenize(t.text));
  const docLen = docTerms.map(dt => dt.length);
  const avgdl = docLen.reduce((a, b) => a + b, 0) / N;

  // Document frequency per lemma
  const df = new Map();
  for (const dt of docTerms) {
    const seen = new Set(dt);
    for (const w of seen) df.set(w, (df.get(w) || 0) + 1);
  }

  // IDF per lemma
  const idf = new Map();
  for (const [w, d] of df) {
    idf.set(w, Math.log((N - d + 0.5) / (d + 0.5) + 1));
  }

  return { idf, docLen, avgdl, docTerms };
}

/**
 * BM25 score for one document given query lemmas.
 */
function bm25Score(queryLemmas, docIdx, bm25) {
  const { idf, docLen, avgdl, docTerms } = bm25;
  const dt = docTerms[docIdx];
  const dl = docLen[docIdx];
  const tfMap = new Map();
  for (const w of dt) tfMap.set(w, (tfMap.get(w) || 0) + 1);

  let score = 0;
  for (const qw of queryLemmas) {
    const tf = tfMap.get(qw) || 0;
    if (tf === 0) continue;
    const idfVal = idf.get(qw) || 0;
    const numerator = tf * (BM25_K1 + 1);
    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl));
    score += idfVal * (numerator / denominator);
  }
  return score;
}

/**
 * Normalize BM25 scores to 0-1 range for fusion.
 */
function normalizeBM25(scores) {
  if (scores.length === 0) return scores;
  const max = Math.max(...scores);
  if (max === 0) return scores;
  return scores.map(s => s / max);
}

// ─── Simple keyword overlap (v2 method, kept for comparison) ────────

function simpleKeywordScore(query, turnText) {
  const qWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const tWords = new Set(turnText.toLowerCase().split(/\s+/));
  if (qWords.length === 0) return 0;
  const matched = qWords.filter(w => tWords.has(w) || [...tWords].some(tw => tw.includes(w) || w.includes(tw)));
  return matched.length / qWords.length;
}

// ─── Entity Extraction ──────────────────────────────────────────────

const ENTITY_PATTERNS = [
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g,
  /\b([A-Z][a-z]{3,})\b/g,
  /\b(adoption|interview|certification|graduation|wedding|birthday|concert|parade|race|hike|camping|roadtrip|therapy|support\s+group|pride\s+parade|pride|school|college|university|counseling|mentor|agency|application|volunteer|charity)\b/gi,
  /\b(daughter|son|husband|wife|partner|friend|family|mom|dad|parent|child|kid|brother|sister)\b/gi,
  /\b(transgender|lgbtq|lgbt|queer|gay|lesbian|bisexual|non-binary)\b/gi,
];

function extractEntities(text) {
  const entities = new Set();
  for (const pattern of ENTITY_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const entity = match[2] || match[1] || match[0];
      if (entity && entity.length > 2) entities.add(entity.toLowerCase());
    }
  }
  return [...entities];
}

function entityOverlap(queryEntities, turnEntities) {
  if (queryEntities.length === 0 || turnEntities.length === 0) return 0;
  const qSet = new Set(queryEntities);
  const matched = turnEntities.filter(e => qSet.has(e) || [...qSet].some(qe => e.includes(qe) || qe.includes(e)));
  return matched.length / Math.max(queryEntities.length, 1);
}

// ─── Step 3: Entity Graph (2-hop boosting) ──────────────────────────

/**
 * Build entity adjacency: for each turn, find other turns that share entities.
 * Returns Map<turnIndex, Set<connectedTurnIndex>>
 */
function buildEntityGraph(turns) {
  const graph = new Map();
  for (let i = 0; i < turns.length; i++) {
    graph.set(i, new Set());
    const ei = new Set(turns[i].entities);
    if (ei.size === 0) continue;
    for (let j = 0; j < turns.length; j++) {
      if (i === j) continue;
      for (const e of turns[j].entities) {
        if (ei.has(e)) { graph.get(i).add(j); break; }
      }
    }
  }
  return graph;
}

// ─── Temporal Scoring ───────────────────────────────────────────────

const MONTH_NAMES = ['january','february','march','april','may','june','july','august','september','october','november','december'];

function extractDateTokens(text) {
  const lower = text.toLowerCase();
  const tokens = [];
  for (const month of MONTH_NAMES) { if (lower.includes(month)) tokens.push(month); }
  for (const m of lower.matchAll(/\b(20\d{2})\b/g)) tokens.push(m[1]);
  for (const rel of ['last week','last month','last year','last weekend','yesterday','tomorrow','today','next week','next month']) {
    if (lower.includes(rel)) tokens.push(rel);
  }
  return [...new Set(tokens)];
}

function temporalScore(query, turnText) {
  const qDates = extractDateTokens(query);
  if (qDates.length === 0 && !/(when|before|after|date|time|year|month|week|day|ago|last|next)/i.test(query)) return 0;
  const tDates = extractDateTokens(turnText);
  if (qDates.length === 0) return 0.5;
  const matched = qDates.filter(d => tDates.includes(d));
  return matched.length > 0 ? 1.0 : 0.1;
}

// ─── Core: Load & Extract ───────────────────────────────────────────

function extractTurns(conv) {
  const convo = conv.conversation;
  const turns = [];
  for (const key of Object.keys(convo)) {
    if (!key.startsWith('session_') || key.endsWith('_date_time')) continue;
    const data = convo[key];
    if (!Array.isArray(data)) continue;
    const dateTime = convo[key + '_date_time'] || 'unknown';
    for (const turn of data) {
      const text = (turn.text || '').trim();
      if (text.length < 10) continue;
      turns.push({
        dia_id: turn.dia_id || 'unknown', text, sessionKey: key, dateTime,
        speaker: turn.speaker || 'unknown', entities: [], dateTokens: [],
      });
    }
  }
  for (const t of turns) {
    t.entities = extractEntities(t.text);
    t.dateTokens = extractDateTokens(t.text);
  }
  return turns;
}

// ─── Benchmark Runner ───────────────────────────────────────────────

async function run(opts = {}) {
  const dataPath = opts.dataPath || path.join(__dirname, 'locomo10.json');
  const topK = opts.topK || TOP_K;
  const conversations = opts.conversations || null;
  const modelName = opts.model || 'Xenova/bge-large-en-v1.5';
  const method = opts.method || 'v3'; // v2 = old keyword, v3 = BM25 + entity graph

  if (!fs.existsSync(dataPath)) throw new Error(`Dataset not found at ${dataPath}`);
  const dataset = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  const convs = conversations ? conversations.map(i => dataset[i]).filter(Boolean) : dataset;

  const isV2 = method === 'v2';

  console.error(`📊 LoCoMo Standalone ${method.toUpperCase()} — agentic-cortex`);
  console.error(`   Conversations:  ${convs.length}`);
  console.error(`   Top-K:          ${topK}`);
  console.error(`   Embedding:      ${modelName}`);
  if (isV2) {
    console.error(`   Keyword:        simple overlap (v2)`);
    console.error(`   Entity:         1-hop boost only (v2)`);
  } else {
    console.error(`   Keyword:        BM25 + lemmatization (v3)`);
    console.error(`   Entity:         2-hop graph boosting (v3)`);
  }
  console.error(`   Temporal:       date extraction boost\n`);

  const allResults = [];
  const categoryScores = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  const startTime = Date.now();

  for (let ci = 0; ci < convs.length; ci++) {
    const conv = convs[ci];
    const sampleId = conv.sample_id;
    const qaList = conv.qa || [];
    const turns = extractTurns(conv);

    console.error(`  [${ci + 1}/${convs.length}] ${sampleId}: ${turns.length} turns, ${qaList.length} QA`);

    // Build BM25 index (v3) or not (v2)
    let bm25 = null;
    if (!isV2) {
      console.error(`    Building BM25 index...`);
      bm25 = buildBM25(turns);
    }

    // Build entity graph (v3 only — Step 3)
    let entityGraph = null;
    if (!isV2 && turns.some(t => t.entities.length > 0)) {
      entityGraph = buildEntityGraph(turns);
    }

    // Embed all turns
    console.error(`    Embedding ${turns.length} turns (${modelName.split('/').pop()})...`);
    const turnEmbeddings = [];
    for (let ti = 0; ti < turns.length; ti++) {
      if (ti % 50 === 0) process.stderr.write(`\r      ${ti}/${turns.length}...`);
      turnEmbeddings.push(await embed(turns[ti].text, modelName));
    }
    console.error(`\r      ${turns.length}/${turns.length} done.`);

    // Pre-compute BM25 scores for all turns against all queries (v3 only)
    let bm25ScoresAll = null;
    if (!isV2 && bm25) {
      console.error(`    Pre-computing BM25 query scores...`);
      bm25ScoresAll = qaList.map(qa => {
        const qLemmas = tokenize(qa.question);
        const scores = turns.map((_, ti) => bm25Score(qLemmas, ti, bm25));
        return normalizeBM25(scores);
      });
    }

    // Evaluate
    console.error(`    Evaluating ${qaList.length} QA pairs...`);
    for (let qi = 0; qi < qaList.length; qi++) {
      const qa = qaList[qi];
      if (qi % 20 === 0) process.stderr.write(`\r      ${qi}/${qaList.length}...`);

      const qEmbedding = await embed(qa.question, modelName);
      const qEntities = extractEntities(qa.question);

      // Score every turn
      const scored = turns.map((turn, ti) => {
        const semScore = cosineSim(qEmbedding, turnEmbeddings[ti]);

        let kwScore;
        if (isV2 || !bm25ScoresAll) {
          kwScore = simpleKeywordScore(qa.question, turn.text);
        } else {
          kwScore = bm25ScoresAll[qi][ti];
        }

        const entScore = entityOverlap(qEntities, turn.entities);
        const tmpScore = temporalScore(qa.question, turn.text);

        // Base fusion: semantic + keyword
        let hybrid = W_SEMANTIC * semScore + W_KEYWORD * kwScore;

        // 1-hop entity boost
        if (entScore > 0) hybrid *= ENTITY_BOOST;

        // Step 3: 2-hop entity graph boost (v3 only)
        if (!isV2 && entityGraph && entScore > 0) {
          const connected = entityGraph.get(ti);
          if (connected && connected.size > 0) {
            // Apply small boost — this turn is connected to entity-matching turns
            hybrid *= (1 + 0.05 * Math.min(connected.size, 5));
          }
        }

        // Temporal boost
        if (tmpScore > 0.8) hybrid *= TEMPORAL_BOOST;

        return { ...turn, index: ti, semScore, kwScore, entScore, tmpScore, hybrid };
      });

      // Also boost 2-hop turns: turns connected to entity-matching turns (v3 only)
      if (!isV2 && entityGraph && qEntities.length > 0) {
        const directMatches = new Set();
        for (let ti = 0; ti < turns.length; ti++) {
          if (entityOverlap(qEntities, turns[ti].entities) > 0) directMatches.add(ti);
        }
        if (directMatches.size > 0) {
          const twoHop = new Set();
          for (const di of directMatches) {
            const conn = entityGraph.get(di);
            if (conn) for (const ci of conn) twoHop.add(ci);
          }
          // Boost 2-hop turns
          for (const ti of twoHop) {
            if (!directMatches.has(ti)) {
              scored[ti].hybrid *= ENTITY_2HOP_BOOST;
              scored[ti].twoHopBoost = true;
            }
          }
        }
      }

      // Sort and take top-K
      scored.sort((a, b) => b.hybrid - a.hybrid);
      const topResults = scored.slice(0, topK);

      // Evidence match
      const evidence = qa.evidence || [];
      let evidenceMatch = 0;
      for (const r of topResults) {
        if (evidence.includes(r.dia_id)) { evidenceMatch = 1; break; }
      }

      allResults.push({
        sampleId, question: qa.question.slice(0, 80),
        answer: String(qa.answer).slice(0, 80),
        categoryId: qa.category, category: CATEGORY_NAMES[qa.category] || 'unknown',
        evidence, recall: evidenceMatch,
        topDiaId: topResults[0]?.dia_id || '',
      });

      if (categoryScores[qa.category] != null) {
        categoryScores[qa.category].push(evidenceMatch);
      }
    }
    console.error(`\r      ${qaList.length}/${qaList.length} done.`);
  }

  const computeStats = (scores) => {
    if (scores.length === 0) return { count: 0, recall: 0 };
    const r = scores.reduce((a, b) => a + b, 0) / scores.length;
    return { count: scores.length, recall: Math.round(r * 10000) / 100 };
  };

  const totalRecall = allResults.filter(r => r.recall).length / Math.max(allResults.length, 1);

  const results = {
    benchmark: `locomo-standalone-${method}`,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    config: { topK, model: modelName, method },
    overall: { totalQA: allResults.length, recall: Math.round(totalRecall * 10000) / 100 },
    byCategory: {},
    details: allResults,
  };
  for (const cat of [1, 2, 3, 4, 5]) {
    results.byCategory[CATEGORY_NAMES[cat]] = computeStats(categoryScores[cat] || []);
  }

  return results;
}

// ─── CLI ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = { topK: TOP_K, method: 'v3', model: 'Xenova/bge-large-en-v1.5' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--top-k') opts.topK = parseInt(args[++i], 10);
    else if (args[i] === '--conversations') opts.conversations = args[++i].split(',').map(Number);
    else if (args[i] === '--model') opts.model = args[++i];
    else if (args[i] === '--method') opts.method = args[++i];
  }

  run(opts).then(r => {
    console.log('═══════════════════════════════════════════');
    console.log(`  LoCoMo ${r.config.method.toUpperCase()} — agentic-cortex`);
    console.log(`  ${r.config.model.split('/').pop()}`);
    console.log('═══════════════════════════════════════════');
    console.log(`  Evidence Recall:  ${r.overall.recall}%`);
    for (const [name, stats] of Object.entries(r.byCategory)) {
      console.log(`  ${name.padEnd(16)} ${stats.recall}%  (${stats.count} QA)`);
    }
    console.log(`  Total QA:         ${r.overall.totalQA}`);
    console.log(`  Duration:         ${(r.durationMs / 1000).toFixed(1)}s`);
    console.log(`  Top-K:            ${r.config.topK}`);
    console.log(`  Model:            ${r.config.model}`);
    console.log('═══════════════════════════════════════════');
    process.exit(0);
  }).catch(err => { console.error('Failed:', err.message); process.exit(1); });
}

module.exports = { run };
