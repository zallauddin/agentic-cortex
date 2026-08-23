/**
 * self-consistency.js — Temperature sampling + majority voting for agentic-cortex.
 *
 * Implements the Self-Consistency paradigm (Wang et al., 2023): instead of
 * one greedy chain, sample N independent reasoning traces with high temperature
 * and aggregate answers via majority vote.
 *
 *   P(y|x) = Σ_z P(y|x,z) P(z|x)           (CoT: marginalize over latent chains)
 *   y* = argmax Σ 𝟙(Extract(z^(i)) = y)    (Self-Consistency: majority vote)
 *
 * This is different from tree-search (which branches a SINGLE root): self-consistency
 * generates N COMPLETELY INDEPENDENT full chains from scratch, each a full
 * root-to-leaf reasoning. This is strictly an inference-time technique — no
 * gradient updates, no weight changes.
 *
 * Why it works: if a model has 80% per-step accuracy on a 5-step problem,
 * a single greedy chain has only 0.8^5 ≈ 32.8% chance of success. But sampling
 * 40 diverse chains and voting over the cluster mode recovers the ground truth
 * with high probability.
 *
 * The PRM-weighted variant weights each vote by the chain's average PRM score
 * so that higher-quality reasoning paths have more influence.
 *
 * @module core/self-consistency
 */

'use strict';

const prm = require('./prm');
const { callLLM } = require('./session');

// Lazy-loaded dependencies
let _prompts = null;
let _saveFn = null;
let _searchFn = null;

function _getPrompts() {
  if (!_prompts) _prompts = require('./prompts');
  return _prompts;
}

// ─── Single Chain Generation ───────────────────────────────────────

/**
 * Generate a single reasoning chain with temperature sampling.
 *
 * @param {Object} params
 * @param {string} params.problem — Problem statement
 * @param {number} [params.temperature=0.7] — Sampling temperature (higher = more diversity)
 * @param {number} [params.maxTokens=2000] — Token budget per chain
 * @param {number} [params.timeout=30000] — Per-chain timeout
 * @returns {Promise<{ chain: string, tokensUsed: number } | null>}
 */
async function generateChain({ problem, temperature = 0.7, maxTokens = 2000, timeout = 30000 }) {
  const messages = [
    {
      role: 'system',
      content: `Solve this problem step by step. End your response with a final answer on its own line, prefixed with "ANSWER:".

Example format:
Step 1: (reasoning)
Step 2: (reasoning)
...
ANSWER: (final answer)`,
    },
    { role: 'user', content: problem },
  ];

  try {
    const result = await callLLM(messages, {
      temperature,
      maxTokens,
      timeout,
    });

    if (!result) return null;

    // Estimate tokens (rough: ~4 chars per token)
    const tokensUsed = Math.ceil((problem.length + (result || '').length) / 4);

    return { chain: result, tokensUsed };
  } catch {
    return null;
  }
}

// ─── Answer Extraction ────────────────────────────────────────────

/**
 * Extract the final answer from a reasoning chain.
 * Looks for "ANSWER:" prefix, then falls back to last non-empty line.
 *
 * @param {string} chain — Full reasoning chain text
 * @returns {string} Extracted answer, or the chain itself if extraction fails
 */
function extractAnswer(chain) {
  if (!chain || typeof chain !== 'string') return '';

  // Primary: explicit "ANSWER:" prefix (case-insensitive, multiline)
  const answerMatch = chain.match(/ANSWER:\s*([^\n]+(?:\n(?!\n)[^\n]+)*)/i);
  if (answerMatch) {
    return answerMatch[1].trim();
  }

  // Secondary: "Final answer:" or "The answer is:"
  const finalMatch = chain.match(/(?:final answer|the answer is)[:\s]\s*([^\n]+(?:\n(?!\n)[^\n]+)*)/i);
  if (finalMatch) {
    return finalMatch[1].trim();
  }

  // Tertiary: "Therefore" or "Conclusion"
  const thereforeMatch = chain.match(/(?:therefore|conclusion)[.,:\s]\s*([^\n]+(?:\n(?!\n)[^\n]+)*)/i);
  if (thereforeMatch) {
    return thereforeMatch[1].trim();
  }

  // Fallback: last non-empty line
  const lines = chain.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 0) {
    return lines[lines.length - 1];
  }

  return chain.trim();
}

// ─── Answer Normalization ─────────────────────────────────────────

/**
 * Normalize an answer for voting. Collapses whitespace, lowercases,
 * strips punctuation from edges, normalizes common number formats.
 *
 * @param {string} answer — Raw extracted answer
 * @returns {string} Normalized answer key for voting
 */
function normalizeAnswer(answer) {
  return answer
    .toLowerCase()
    .trim()
    .replace(/^[\s.,;:!?]+/, '')
    .replace(/[\s.,;:!?]+$/, '')
    .replace(/\s+/g, ' ')
    .replace(/0x([0-9a-f]+)/g, hex => parseInt(hex, 16).toString()) // Normalize hex
    .replace(/\b0+(\.\d+)\b/g, '$1')  // Strip leading zeros
    .replace(/(\d),(?=\d{3}\b)/g, '$1'); // Remove thousands separators
}

// ─── Voting ───────────────────────────────────────────────────────

/**
 * Simple majority vote over extracted answers.
 * Returns the winning answer and vote distribution.
 *
 * @param {Array<{ rawChain: string, answer: string }>} results — Sampled chains with extracted answers
 * @returns {{ winner: string, votes: number, total: number, distribution: Object }}
 */
function simpleVote(results) {
  const counts = {};

  for (const r of results) {
    const key = normalizeAnswer(r.answer);
    if (!key) continue; // Skip empty answers
    counts[key] = (counts[key] || 0) + 1;
    if (!r.normalizedKey) r.normalizedKey = key;
  }

  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const total = results.length;

  if (entries.length === 0) {
    return { winner: '', votes: 0, total, distribution: {} };
  }

  return {
    winner: entries[0][0],
    winnerVotes: entries[0][1],
    total,
    distribution: Object.fromEntries(entries),
  };
}

/**
 * PRM-weighted vote: each chain's vote is weighted by its PRM score.
 * Higher-quality reasoning paths get proportionally more voting power.
 *
 * @param {Array<{ rawChain: string, answer: string, prmScore: number }>} results
 * @returns {{ winner: string, weightedVotes: number, total: number, distribution: Object }}
 */
function prmWeightedVote(results) {
  const weightedCounts = {};
  let totalWeight = 0;

  for (const r of results) {
    const key = normalizeAnswer(r.answer);
    if (!key) continue;
    const weight = Math.max(0.1, r.prmScore || 0.5); // Floor at 0.1 to avoid zero-weight
    weightedCounts[key] = (weightedCounts[key] || 0) + weight;
    totalWeight += weight;
    if (!r.normalizedKey) r.normalizedKey = key;
  }

  const entries = Object.entries(weightedCounts).sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) {
    return { winner: '', weightedVotes: 0, totalWeight, distribution: {} };
  }

  return {
    winner: entries[0][0],
    weightedVotes: Math.round(entries[0][1] * 100) / 100,
    totalWeight: Math.round(totalWeight * 100) / 100,
    distribution: Object.fromEntries(entries.map(([k, w]) => [k, Math.round(w * 100) / 100])),
  };
}

// ─── Main Self-Consistency Pipeline ───────────────────────────────

/**
 * Run self-consistency decoding: sample N independent chains, extract
 * answers, majority-vote. Optionally weight by PRM scores.
 *
 * @param {Object} params
 * @param {string} params.problem — Problem to solve
 * @param {string} [params.project] — Project path (for memory checks)
 * @param {number} [params.samples=5] — Number of independent chains to sample
 * @param {number} [params.temperature=0.8] — Sampling temperature
 * @param {boolean} [params.usePrmWeighting=true] — Weight votes by PRM scores
 * @param {Object} [params.db] — Database
 * @param {Object} [params.searchFn] — Memory search function
 * @returns {Promise<Object>} Self-consistency result
 */
async function selfConsistency({ problem, project = '', samples = 5, temperature = 0.8, usePrmWeighting = true, db = null, searchFn = null }) {
  const startTime = Date.now();
  const results = [];
  let totalTokens = 0;

  // Phase 1: Generate N independent chains (in parallel)
  const chainPromises = [];
  for (let i = 0; i < samples; i++) {
    chainPromises.push(generateChain({
      problem,
      temperature,
      maxTokens: 2000,
      timeout: 30000,
    }));
  }

  const chains = await Promise.all(chainPromises);

  // Phase 2: Extract answers
  for (let i = 0; i < chains.length; i++) {
    const c = chains[i];
    if (!c) continue;

    const answer = extractAnswer(c.chain);
    totalTokens += c.tokensUsed;

    results.push({
      index: i,
      rawChain: c.chain,
      answer,
      normalizedKey: normalizeAnswer(answer),
      tokensUsed: c.tokensUsed,
      prmScore: 0,
    });
  }

  if (results.length === 0) {
    return {
      problem,
      winner: '',
      confidence: 0,
      totalChains: 0,
      successfulChains: 0,
      totalTokens,
      durationMs: Date.now() - startTime,
      method: 'none',
      error: 'All chains failed to generate',
    };
  }

  // Phase 3: Optional PRM scoring of each chain
  if (usePrmWeighting) {
    const prmPromises = results.map(r =>
      prm.verifyChain({
        steps: _splitIntoSteps(r.rawChain),
        problem,
        project,
        db,
        searchFn,
      })
    );

    const prmResults = await Promise.all(prmPromises);
    for (let i = 0; i < results.length; i++) {
      results[i].prmScore = prmResults[i] ? prmResults[i].chainScore : 0.5;
      results[i].prmSteps = prmResults[i] ? prmResults[i].steps : [];
    }
  } else {
    // Without PRM, all chains get equal weight (1.0)
    for (const r of results) r.prmScore = 1.0;
  }

  // Phase 4: Vote
  const voteResult = usePrmWeighting
    ? prmWeightedVote(results)
    : simpleVote(results);

  // Phase 5: Find the best chain for the winning answer (highest PRM score among winners)
  const winningChains = results.filter(r => r.normalizedKey === voteResult.winner);
  const bestChain = winningChains.length > 0
    ? winningChains.reduce((best, cur) => (cur.prmScore || 0) > (best.prmScore || 0) ? cur : best, winningChains[0])
    : results.reduce((best, cur) => (cur.prmScore || 0) > (best.prmScore || 0) ? cur : best, results[0]);

  // Phase 6: Confidence calculation
  const winnerRatio = voteResult.total > 0
    ? (usePrmWeighting
        ? voteResult.weightedVotes / voteResult.totalWeight
        : voteResult.winnerVotes / voteResult.total)
    : 0;

  const avgPrmScore = results.reduce((s, r) => s + (r.prmScore || 0), 0) / results.length;

  // Confidence = winner agreement ratio * average PRM score
  const confidence = Math.round(winnerRatio * avgPrmScore * 100) / 100;

  return {
    problem,
    winner: bestChain.answer,
    winnerChain: bestChain.rawChain,
    winnerPrmScore: bestChain.prmScore,
    confidence,
    totalChains: results.length,
    successfulChains: results.filter(r => r.prmScore >= 0.4).length,
    samplesRequested: samples,
    temperature,
    totalTokens,
    durationMs: Date.now() - startTime,
    method: usePrmWeighting ? 'prm-weighted-majority-vote' : 'simple-majority-vote',
    vote: {
      simple: simpleVote(results),
      weighted: usePrmWeighting ? voteResult : null,
    },
    chains: results.map(r => ({
      index: r.index,
      answer: r.answer,
      normalizedKey: r.normalizedKey,
      prmScore: r.prmScore,
      tokensUsed: r.tokensUsed,
      chainPreview: r.rawChain.slice(0, 300),
    })),
  };
}

// ─── Chain Splitting Helper ───────────────────────────────────────

/**
 * Split a reasoning chain into logical steps for PRM verification.
 * Tries numbered steps first, then falls back to paragraph splitting.
 *
 * @param {string} chain — Full reasoning chain text
 * @returns {string[]} Individual steps
 */
function _splitIntoSteps(chain) {
  if (!chain || typeof chain !== 'string') return [];

  // Try numbered steps: "Step 1:", "1.", "1)"
  const numberedSteps = chain.match(/(?:Step\s+\d+[.:]?|^\d+[.)]\s+)(.+?)(?=\n(?:Step\s+\d+|^\d+[.)]|\n*$))/gms);
  if (numberedSteps && numberedSteps.length >= 2) {
    return numberedSteps.map(s => s.trim()).filter(Boolean);
  }

  // Fallback: split by double newlines
  const paragraphs = chain.split(/\n\s*\n/);
  if (paragraphs.length >= 2) {
    return paragraphs.map(p => p.trim()).filter(Boolean);
  }

  // Last resort: split by single newlines, group into chunks
  const lines = chain.split('\n').map(l => l.trim()).filter(Boolean);
  const steps = [];
  let buffer = '';
  for (const line of lines) {
    if (line.startsWith('ANSWER:') || line.startsWith('ANSWER')) {
      if (buffer.trim()) steps.push(buffer.trim());
      steps.push(line);
      buffer = '';
    } else {
      buffer += (buffer ? ' ' : '') + line;
    }
  }
  if (buffer.trim()) steps.push(buffer.trim());

  return steps.filter(Boolean);
}

// ─── Dependency Injection ──────────────────────────────────────────

function setSaveFunction(fn) { _saveFn = fn; }
function setSearchFunction(fn) { _searchFn = fn; }

// ─── Exports ────────────────────────────────────────────────────────

module.exports = {
  generateChain,
  extractAnswer,
  normalizeAnswer,
  simpleVote,
  prmWeightedVote,
  selfConsistency,
  _splitIntoSteps,
  setSaveFunction,
  setSearchFunction,
};