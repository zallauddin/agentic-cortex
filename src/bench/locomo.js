/**
 * locomo.js — LoCoMo Benchmark Runner for agentic-cortex.
 *
 * Runs the LoCoMo (Long-Term Conversational Memory) benchmark against
 * agentic-cortex's hybrid search pipeline.
 *
 * Pipeline:
 *   1. Load locomo10.json (10 conversations, ~300 QA pairs)
 *   2. Ingest each conversation's sessions as observations into memory
 *   3. For each QA pair, search our memory store for relevant facts
 *   4. Score: retrieval recall (did we find the evidence?) + optional LLM judge
 *
 * Scores are written to the immutable evaluation_log for tracking over time.
 *
 * Usage:
 *   node src/bench/locomo.js [--conversations 0-9] [--top-k 10] [--judge]
 *
 * @module bench/locomo
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Scoring Constants ──────────────────────────────────────────────

const CATEGORY_NAMES = {
  1: 'single_hop',
  2: 'temporal',
  3: 'multi_hop',
  4: 'commonsense',
  5: 'adversarial',
};

// ─── Core: Ingest Conversation ──────────────────────────────────────

/**
 * Ingest one LoCoMo conversation into agentic-cortex's memory store.
 *
 * For each session, we create one observation per dialog turn (or cluster
 * turns into session-level observations). We also save LoCoMo's pre-extracted
 * observations if available.
 *
 * @param {Object} api - agentic-cortex API module
 * @param {Object} conv - LoCoMo conversation object
 * @param {string} project - Project path for this benchmark run
 * @returns {Promise<{sessionCount: number, obsCount: number}>}
 */
async function ingestConversation(api, conv, project) {
  const convo = conv.conversation;
  const sampleId = conv.sample_id;
  let sessionCount = 0;
  let obsCount = 0;

  // Ingest each session as chunks of dialog
  for (const key of Object.keys(convo)) {
    if (!key.startsWith('session_') || key.endsWith('_date_time')) continue;
    const sessionData = convo[key];
    const dateTime = convo[key + '_date_time'] || 'unknown';

    if (!Array.isArray(sessionData)) continue;
    sessionCount++;

    // Build session text by concatenating dialog turns
    const speakerA = convo.speaker_a || 'Speaker A';
    const speakerB = convo.speaker_b || 'Speaker B';
    const turns = sessionData.map(turn => {
      const speaker = turn.speaker || 'unknown';
      const text = turn.text || '';
      return `[${speaker}]: ${text}`;
    });
    const sessionText = turns.join('\n');

    // Save as a fact-type observation: the complete session transcript
    await api.save({
      title: `${sampleId} - ${key} (${dateTime})`,
      content: sessionText,
      type: 'fact',
      tags: ['locomo', 'benchmark', sampleId, key, 'session-transcript'],
      project,
      importance: 3,
      confidence: 100,
      provenance: 'observed',
    });
    obsCount++;

    // Also save individual dialog turns as observations for finer-grained retrieval
    // (only for turns that contain substantive information)
    for (const turn of sessionData) {
      const text = (turn.text || '').trim();
      if (text.length < 30) continue; // Skip greetings and very short turns

      await api.save({
        title: `${sampleId} - ${turn.dia_id}`,
        content: `[${turn.speaker || 'unknown'}]: ${text}`,
        type: 'observation',
        tags: ['locomo', 'benchmark', sampleId, 'dialog-turn', turn.dia_id],
        project,
        importance: 1,
        confidence: 100,
        provenance: 'observed',
      });
      obsCount++;
    }
  }

  // Also ingest pre-extracted observations from LoCoMo if available
  if (conv.observation && Array.isArray(conv.observation)) {
    for (const obs of conv.observation) {
      if (obs.content && obs.content.trim().length > 10) {
        await api.save({
          title: `${sampleId} - fact: ${(obs.content || '').slice(0, 60)}`,
          content: obs.content,
          type: 'fact',
          tags: ['locomo', 'benchmark', sampleId, 'extracted-fact'],
          project,
          importance: 5,
          confidence: 90,
          provenance: 'inferred',
        });
        obsCount++;
      }
    }
  }

  return { sessionCount, obsCount };
}

// ─── Core: Evaluate Retrieval ───────────────────────────────────────

/**
 * Compute retrieval recall: for a given QA pair, does our search find
 * the ground-truth evidence dialog turns?
 *
 * We can't exactly match dia_ids unless we tag them, so we use a
 * two-pronged approach:
 *   1. Keyword overlap: does any top-k result mention the answer content?
 *   2. Evidence match: does any top-k result contain the evidence dia_id?
 *
 * @param {Object} api - agentic-cortex API module
 * @param {Object} qa - LoCoMo QA pair { question, answer, evidence, category }
 * @param {number} topK - Number of results to retrieve
 * @param {string} project - Project path
 * @returns {Promise<{recall: number, evidenceMatch: number, answerMatch: number, topResults: Array}>}
 */
async function evaluateRetrieval(api, qa, topK, project) {
  const question = qa.question;
  const answer = qa.answer;
  const evidence = qa.evidence || [];

  // Search our memory store
  let results;
  try {
    results = await api.search(question, {
      project,
      limit: topK,
      rerank: false, // Don't rerank — we want raw hybrid search performance
    });
  } catch (err) {
    return { recall: 0, evidenceMatch: 0, answerMatch: 0, topResults: [], error: err.message };
  }

  if (!results || results.length === 0) {
    return { recall: 0, evidenceMatch: 0, answerMatch: 0, topResults: [] };
  }

  // Check evidence match: does any top-k result contain a dia_id from evidence?
  let evidenceMatch = 0;
  for (const result of results) {
    const content = (result.content || result.preview || '').toLowerCase();
    const tags = _safeTags(result.tags);
    for (const evId of evidence) {
      if (content.includes(evId.toLowerCase()) || tags.includes(evId)) {
        evidenceMatch = 1;
        break;
      }
    }
    if (evidenceMatch) break;
  }

  // Check answer match: does any top-k result contain the answer substring?
  let answerMatch = 0;
  const answerLower = String(answer).toLowerCase();
  if (answerLower.length > 3) {
    for (const result of results) {
      const content = (result.content || result.preview || '').toLowerCase();
      // Check for answer words in content
      const answerWords = answerLower.split(/\s+/).filter(w => w.length > 2);
      const matchedWords = answerWords.filter(w => content.includes(w));
      if (matchedWords.length >= Math.ceil(answerWords.length * 0.5)) {
        answerMatch = 1;
        break;
      }
    }
  }

  // Primary metric: evidence-based recall (comparable to mem0's approach).
  // Secondary: keyword-overlap (NOT LLM-judged — a loose proxy for context coverage).
  const recall = evidenceMatch;
  const keywordOverlap = answerMatch;

  return {
    recall,
    evidenceMatch,
    keywordOverlap,
    answerMatch,
    topResults: results.slice(0, 3).map(r => ({
      title: r.title || '',
      preview: (r.content || r.preview || '').slice(0, 150),
      score: r.combined_score || r.semantic_score || 0,
    })),
  };
}

// ─── Core: LLM-as-Judge Answer Scoring (Optional) ───────────────────

/**
 * Use an LLM judge to evaluate whether our system would answer the
 * LoCoMo question correctly based on retrieved context.
 *
 * This is optional — requires an LLM to be available.
 *
 * @param {Object} answerCtx - { question, groundTruth, retrievedContext }
 * @returns {Promise<{score: number, judgment: string, reason: string}>}
 */
async function judgeAnswer(answerCtx) {
  try {
    const { callLLM } = require('../core/session');
    const prompt = `You are evaluating a memory retrieval system. Given a question and retrieved context, determine if the context contains enough information to correctly answer the question.

Question: "${answerCtx.question}"
Ground truth answer: "${answerCtx.groundTruth}"
Retrieved context: "${answerCtx.retrievedContext}"

Does the retrieved context contain the necessary information to produce the ground truth answer?
Respond with ONLY a JSON object: {"score": 0.0-1.0, "judgment": "CORRECT"|"PARTIAL"|"INCORRECT", "reason": "brief explanation"}`;

    const result = await callLLM([
      { role: 'system', content: 'You evaluate memory retrieval accuracy. Respond ONLY with valid JSON.' },
      { role: 'user', content: prompt },
    ], { temperature: 0, maxTokens: 200, timeout: 15000 });

    if (!result) return { score: 0, judgment: 'SKIPPED', reason: 'LLM unavailable' };

    const parsed = JSON.parse(result.trim());
    return {
      score: parsed.score || 0,
      judgment: parsed.judgment || 'UNKNOWN',
      reason: parsed.reason || '',
    };
  } catch (err) {
    return { score: 0, judgment: 'ERROR', reason: err.message };
  }
}

// ─── Main Runner ────────────────────────────────────────────────────

/**
 * Run the full LoCoMo benchmark against agentic-cortex.
 *
 * @param {Object} opts
 * @param {string} [opts.dataPath] - Path to locomo10.json
 * @param {number[]} [opts.conversations] - Which conversations to run (0-9)
 * @param {number} [opts.topK=10] - Number of results to retrieve per query
 * @param {boolean} [opts.judge=false] - Whether to use LLM-as-judge for answer scoring
 * @param {boolean} [opts.skipIngest=false] - Skip ingestion (use existing data)
 * @param {Function} [opts.onProgress] - Progress callback ({phase, current, total, message})
 * @returns {Promise<Object>} Benchmark results
 */
async function runBenchmark(opts = {}) {
  const dataPath = opts.dataPath || path.join(__dirname, 'locomo10.json');
  const topK = opts.topK || 10;
  const useJudge = opts.judge || false;
  const skipIngest = opts.skipIngest || false;
  const onProgress = opts.onProgress || (() => {});

  // Lazy-load API (avoids circular deps)
  const api = require('../api');

  // Load dataset
  if (!fs.existsSync(dataPath)) {
    throw new Error(`LoCoMo dataset not found at ${dataPath}. Download from: https://github.com/snap-research/locomo`);
  }
  const dataset = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

  // Select conversations
  let conversations = dataset;
  if (opts.conversations && opts.conversations.length > 0) {
    conversations = opts.conversations.map(i => dataset[i]).filter(Boolean);
  }

  const project = `__locomo_bench__${Date.now()}`;
  const startTime = Date.now();

  // ── Phase 1: Ingest ──────────────────────────────────────────────
  if (!skipIngest) {
    onProgress({ phase: 'ingest', current: 0, total: conversations.length, message: 'Starting ingestion...' });

    for (let i = 0; i < conversations.length; i++) {
      const conv = conversations[i];
      onProgress({ phase: 'ingest', current: i + 1, total: conversations.length, message: `Ingesting conversation ${conv.sample_id} (${i + 1}/${conversations.length})...` });
      await ingestConversation(api, conv, project);
    }
  }

  // ── Phase 2: Evaluate ─────────────────────────────────────────────
  const allResults = [];
  const categoryScores = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  let totalQA = 0;

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    const qaList = conv.qa || [];

    for (let j = 0; j < qaList.length; j++) {
      const qa = qaList[j];
      totalQA++;

      if (totalQA % 20 === 0) {
        onProgress({ phase: 'evaluate', current: totalQA, total: '?', message: `Evaluating QA ${qa.question.slice(0, 50)}...` });
      }

      const evalResult = await evaluateRetrieval(api, qa, topK, project);
      const result = {
        sampleId: conv.sample_id,
        question: qa.question,
        answer: qa.answer,
        category: CATEGORY_NAMES[qa.category] || 'unknown',
        categoryId: qa.category,
        evidence: qa.evidence,
        recall: evalResult.recall,
        evidenceMatch: evalResult.evidenceMatch,
        keywordOverlap: evalResult.keywordOverlap,
        answerMatch: evalResult.answerMatch,
        topResults: evalResult.topResults,
      };

      // Optional LLM judge
      if (useJudge && evalResult.topResults.length > 0) {
        const context = evalResult.topResults.map(r => r.preview).join('\n---\n');
        const judgment = await judgeAnswer({
          question: qa.question,
          groundTruth: qa.answer,
          retrievedContext: context,
        });
        result.judgeScore = judgment.score;
        result.judgeJudgment = judgment.judgment;
        result.judgeReason = judgment.reason;
      }

      allResults.push(result);
      if (categoryScores[qa.category] != null) {
        categoryScores[qa.category].push(evalResult.recall);
      }
    }
  }

  // ── Phase 3: Compute Scores ───────────────────────────────────────
  const computeStats = (scores) => {
    if (scores.length === 0) return { count: 0, recall: 0, stddev: 0 };
    const recall = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, b) => a + (b - recall) ** 2, 0) / scores.length;
    return {
      count: scores.length,
      recall: Math.round(recall * 10000) / 100,
      stddev: Math.round(Math.sqrt(variance) * 10000) / 100,
    };
  };

  const totalRecall = allResults.reduce((a, r) => a + r.recall, 0) / Math.max(allResults.length, 1);
  const judgeScore = useJudge
    ? allResults.filter(r => r.judgeScore !== undefined).reduce((a, r) => a + r.judgeScore, 0) / Math.max(allResults.filter(r => r.judgeScore !== undefined).length, 1)
    : null;

  const results = {
    benchmark: 'locomo',
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    config: { topK, judge: useJudge, conversations: conversations.length },
    overall: {
      totalQA: allResults.length,
      recall: Math.round(totalRecall * 10000) / 100,
      judgeScore: judgeScore ? Math.round(judgeScore * 10000) / 100 : null,
    },
    byCategory: {},
    details: allResults,
  };
  for (const cat of [1, 2, 3, 4, 5]) {
    results.byCategory[CATEGORY_NAMES[cat]] = computeStats(categoryScores[cat] || []);
  }

  // Save benchmark result to eval log as a learning
  try {
    await api.save({
      title: `LoCoMo Benchmark — Recall ${results.overall.recall}% (${results.overall.totalQA} QA, topK=${topK})`,
      content: `## LoCoMo Benchmark Results\n\n- **Overall Recall:** ${results.overall.recall}%\n- **Single-hop:** ${results.byCategory.single_hop.recall}%\n- **Temporal:** ${results.byCategory.temporal.recall}%\n- **Multi-hop:** ${results.byCategory.multi_hop.recall}%\n- **Duration:** ${results.durationMs}ms\n- **Conversations:** ${conversations.length}\n- **Top-K:** ${topK}\n${useJudge ? `- **Judge Score:** ${results.overall.judgeScore}%` : ''}`,
      type: 'learning',
      tags: ['benchmark', 'locomo', 'evaluation', `recall-${Math.round(totalRecall * 100)}`],
      project,
      importance: 9,
      confidence: 95,
    });
  } catch { /* best-effort — benchmark result save is non-critical */ }

  return results;
}

// ─── Helpers ────────────────────────────────────────────────────────

function _safeTags(tags) {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === 'string') {
    try { return JSON.parse(tags); } catch { return []; }
  }
  return [];
}

// ─── Exports ────────────────────────────────────────────────────────

module.exports = { runBenchmark, ingestConversation, evaluateRetrieval, judgeAnswer };
