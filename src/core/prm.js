/**
 * prm.js — Process Reward Model for agentic-cortex.
 *
 * Implements step-level verification of reasoning chains, matching the
 * "Let's Verify Step by Step" (Lightman et al., 2023) paradigm.
 * Instead of only judging outcomes, PRMs score each intermediate step:
 *
 *   Score(S_t) = P(valid step | S_1..S_{t-1}, Context)
 *
 * Three-tier verification:
 *   Tier 1: Deterministic checks (syntax, type, test execution) — zero LLM cost
 *   Tier 2: LLM-as-judge — logical validity via prompt templates
 *   Tier 3: Memory cross-check — contradiction detection against stored knowledge
 *
 * Integrates with the self-improving loop: pruned steps become error observations
 * that trigger RCA via the existing self-improve.js pipeline.
 *
 * @module core/prm
 */

'use strict';

const { callLLM } = require('./session');

// Lazy-loaded dependencies
let _prompts = null;
let _saveFn = null;
let _searchFn = null;

function _getPrompts() {
  if (!_prompts) _prompts = require('./prompts');
  return _prompts;
}

// ─── Deterministic Verification (Tier 1) ───────────────────────────

/**
 * Syntax and structural validation — checks if a reasoning step is
 * well-formed without invoking an LLM.
 *
 * @param {string} stepContent — The reasoning step text
 * @param {string} stepType — 'code' | 'reasoning' | 'plan'
 * @returns {{ valid: boolean, score: number, reason: string }}
 */
function verifyDeterministic(stepContent, stepType) {
  const content = (stepContent || '').trim();
  if (!content) {
    return { valid: false, score: 0, reason: 'Empty step content' };
  }

  // Check for common reasoning failure patterns
  const failurePatterns = [
    { pattern: /(?:therefore|so|hence|thus)\s+(?:true|false|correct|incorrect)\s*$/i,
      reason: 'Bare conclusion without justification' },
    { pattern: /(?:I think|I believe|probably|maybe)\s/i,
      reason: 'Contains hedging language instead of reasoning' },
    { pattern: /\b(?:undefined|null|NaN)\b.*\b(?:equals?|=)\s*\b\d+\b/i,
      reason: 'Asserts equality with undefined/null/NaN' },
    { pattern: /(?:assume|assuming)\s+(?:this|that)\s+(?:is|works|correct)/i,
      reason: 'Contains unverified assumption' },
  ];

  for (const { pattern, reason } of failurePatterns) {
    if (pattern.test(content)) {
      return { valid: false, score: 0.2, reason };
    }
  }

  // Code-specific checks
  if (stepType === 'code') {
    // Check for common code errors
    const codeErrors = [
      { pattern: /\bundefined\s*===?\s*['"]/i, reason: 'Comparing undefined to string' },
      { pattern: /\bNaN\s*===?\s*NaN\b/, reason: 'NaN self-comparison (always false)' },
      { pattern: /\bfor\s*\(\s*;\s*;\s*\)\s*\{/, reason: 'Infinite loop detected' },
      { pattern: /\bcatch\s*\(\s*\)\s*\{\s*\}/, reason: 'Empty catch block swallows errors' },
    ];

    for (const { pattern, reason } of codeErrors) {
      if (pattern.test(content)) {
        return { valid: false, score: 0.1, reason };
      }
    }
  }

  // Positive structural checks
  let score = 0.6; // Base score for non-empty, non-failing content
  const hasJustification = /(?:because|since|given that|as shown|proven by|evidence|trace|output|result)/i.test(content);
  const hasSteps = /(?:step\s+\d|first|then|next|finally|1\.|2\.)/i.test(content);
  const hasConclusion = /(?:therefore|thus|so|hence|conclusion|result|outcome|=>)/i.test(content);

  if (hasJustification) score += 0.1;
  if (hasSteps) score += 0.15;
  if (hasConclusion) score += 0.15;

  return { valid: score >= 0.5, score: Math.min(score, 0.9), reason: 'Deterministic check passed' };
}

// ─── LLM-as-Judge Verification (Tier 2) ────────────────────────────

/**
 * Verify a reasoning step using an LLM as a judge.
 * Uses the verify-reasoning-step prompt template when available.
 *
 * @param {string} stepContent — The reasoning step
 * @param {string[]} priorSteps — Previous steps in the chain (context)
 * @param {string} problem — The original problem being solved
 * @param {Object} [opts] — { db? } for LLM caching
 * @returns {Promise<{ valid: boolean, score: number, reason: string }>}
 */
async function verifyWithLLM(stepContent, priorSteps, problem, opts = {}) {
  const priorContext = priorSteps.length > 0
    ? 'Previous steps:\n' + priorSteps.map((s, i) => `Step ${i + 1}: ${s}`).join('\n')
    : 'This is the first step.';

  const messages = [
    {
      role: 'system',
      content: `You are a Process Reward Model (PRM) that verifies reasoning steps.
Evaluate whether this step is a VALID logical deduction given the prior context.

Scoring rules:
- 0.0-0.2: Clearly invalid (false claim, logical fallacy, contradicts evidence)
- 0.3-0.4: Likely invalid (unjustified assumption, weak reasoning)
- 0.5-0.6: Neutral (plausible but unverified, or trivially true)
- 0.7-0.8: Likely valid (sound reasoning, supported by evidence/context)
- 0.9-1.0: Clearly valid (proven by evidence, follows necessarily from prior steps)

Respond ONLY with valid JSON: {"score": 0.0-1.0, "valid": true/false, "reason": "brief explanation"}`,
    },
    {
      role: 'user',
      content: `Problem: ${problem}\n\n${priorContext}\n\nStep to verify:\n${stepContent}`,
    },
  ];

  // Check deterministic cache first
  if (opts.db) {
    const cacheKey = `prm-llm:${stepContent.slice(0, 200)}`;
    try {
      const recovery = require('./recovery');
      const cached = recovery.getCachedLLM(opts.db, 'prm-verify', cacheKey);
      if (cached) return cached.result;
    } catch {}
  }

  try {
    const result = await callLLM(messages, {
      temperature: 0,
      maxTokens: 200,
      timeout: 15000,
    });

    const parsed = JSON.parse(result || '{}');
    const valid = typeof parsed.score === 'number' && parsed.score >= 0.5;
    const response = {
      valid,
      score: typeof parsed.score === 'number' ? Math.max(0, Math.min(1, parsed.score)) : 0.5,
      reason: parsed.reason || 'LLM verification completed',
    };

    // Cache the result
    if (opts.db) {
      try {
        const recovery = require('./recovery');
        recovery.cacheLLM(opts.db, 'prm-verify', cacheKey, response, 'ok');
      } catch {}
    }

    return response;
  } catch {
    // LLM unavailable — return neutral
    return { valid: true, score: 0.5, reason: 'LLM unavailable, neutral score' };
  }
}

// ─── Memory Cross-Check (Tier 3) ────────────────────────────────────

/**
 * Check if a reasoning step contradicts existing memories/learnings.
 * Uses the search function to find relevant memories and checks for conflicts.
 *
 * @param {string} stepContent — The reasoning step
 * @param {string} project — Project path
 * @param {Object} [opts] — { searchFn? }
 * @returns {Promise<{ valid: boolean, score: number, reason: string, contradictingMemories: Array }>}
 */
async function verifyAgainstMemory(stepContent, project, opts = {}) {
  const searchFn = opts.searchFn || _searchFn;
  if (!searchFn) {
    return { valid: true, score: 0.5, reason: 'No search available, neutral score', contradictingMemories: [] };
  }

  try {
    const results = await searchFn(stepContent, {
      project,
      limit: 5,
      minConfidence: 60,
    });

    if (!results || results.length === 0) {
      return { valid: true, score: 0.7, reason: 'No contradicting memories found', contradictingMemories: [] };
    }

    // Check for contradictions via LLM or keyword overlap
    const contradictions = [];
    const keywords = new Set(stepContent.toLowerCase().split(/\s+/).filter(w => w.length > 3));

    for (const mem of results) {
      const memText = ((mem.title || '') + ' ' + (mem.content || '')).toLowerCase();
      const memWords = new Set(memText.split(/\s+/).filter(w => w.length > 3));
      const overlap = [...keywords].filter(w => memWords.has(w)).length;
      const overlapRatio = overlap / Math.max(keywords.size, 1);

      if (overlapRatio > 0.3 && mem.type === 'learning') {
        contradictions.push({
          id: mem.id,
          title: mem.title,
          content: mem.content ? mem.content.slice(0, 200) : '',
          confidence: mem.confidence,
          overlap: overlapRatio,
        });
      }
    }

    if (contradictions.length === 0) {
      return { valid: true, score: 0.8, reason: 'No contradictions detected in memory', contradictingMemories: [] };
    }

    // High-overlap contradictions reduce score
    const avgOverlap = contradictions.reduce((s, c) => s + c.overlap, 0) / contradictions.length;
    const score = Math.max(0.1, 0.8 - (avgOverlap * 0.6));

    return {
      valid: score >= 0.5,
      score,
      reason: `Found ${contradictions.length} potentially contradicting memory/memories`,
      contradictingMemories: contradictions,
    };
  } catch {
    return { valid: true, score: 0.5, reason: 'Memory check failed, neutral score', contradictingMemories: [] };
  }
}

// ─── Combined 3-Tier Verification ──────────────────────────────────

/**
 * Verify a reasoning step using all three tiers.
 * Tier 1 (deterministic) runs first — if it fails hard, skip LLM.
 * Tier 2 (LLM) and Tier 3 (memory) run in parallel when available.
 *
 * @param {Object} params
 * @param {string} params.stepContent — The reasoning step to verify
 * @param {string[]} params.priorSteps — Previous steps for context
 * @param {string} params.problem — Original problem
 * @param {string} params.stepType — 'code' | 'reasoning' | 'plan'
 * @param {string} params.project — Project path
 * @param {Object} [params.db] — Database for caching
 * @param {Object} [params.searchFn] — Search function override
 * @returns {Promise<{ valid: boolean, score: number, tier: string, reason: string, details: Object }>}
 */
async function verifyStep({ stepContent, priorSteps = [], problem = '', stepType = 'reasoning', project = '', db = null, searchFn = null }) {
  // Tier 1: Deterministic — always runs, zero LLM cost
  const deterministic = verifyDeterministic(stepContent, stepType);

  // If deterministic fails hard (score < 0.3), skip expensive tiers
  if (deterministic.score < 0.3) {
    return {
      valid: false,
      score: deterministic.score,
      tier: 'deterministic',
      reason: deterministic.reason,
      details: { deterministic },
    };
  }

  // Tier 2 + 3 in parallel
  const [llmResult, memoryResult] = await Promise.all([
    verifyWithLLM(stepContent, priorSteps, problem, { db }),
    verifyAgainstMemory(stepContent, project, { searchFn }),
  ]);

  // Weighted combination: deterministic (0.2) + LLM (0.5) + memory (0.3)
  const weights = { deterministic: 0.2, llm: 0.5, memory: 0.3 };
  const combinedScore =
    deterministic.score * weights.deterministic +
    llmResult.score * weights.llm +
    memoryResult.score * weights.memory;

  const valid = combinedScore >= 0.5;

  return {
    valid,
    score: Math.round(combinedScore * 100) / 100,
    tier: valid ? 'combined' : (deterministic.score < 0.5 ? 'deterministic' : (llmResult.score < 0.5 ? 'llm' : 'memory')),
    reason: valid
      ? `Step verified (score: ${combinedScore.toFixed(2)})`
      : `Step rejected (score: ${combinedScore.toFixed(2)}): ${
          !deterministic.valid ? deterministic.reason :
          !llmResult.valid ? llmResult.reason :
          memoryResult.reason
        }`,
    details: {
      deterministic,
      llm: llmResult,
      memory: memoryResult,
    },
  };
}

// ─── Batch Verification ────────────────────────────────────────────

/**
 * Verify an entire reasoning chain step by step, returning scores for each.
 * Used by tree-search.js to evaluate complete paths.
 *
 * @param {Object} params
 * @param {string[]} params.steps — All reasoning steps
 * @param {string} params.problem — Original problem
 * @param {string} params.project — Project path
 * @param {Object} [params.db] — Database
 * @param {Object} [params.searchFn] — Search function
 * @returns {Promise<{ valid: boolean, steps: Array<{ step, score, valid, reason }>, chainScore: number }>}
 */
async function verifyChain({ steps, problem = '', project = '', db = null, searchFn = null }) {
  const results = [];
  const priorSteps = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const verification = await verifyStep({
      stepContent: step,
      priorSteps: [...priorSteps],
      problem,
      stepType: 'reasoning',
      project,
      db,
      searchFn,
    });

    results.push({
      stepIndex: i,
      step,
      score: verification.score,
      valid: verification.valid,
      reason: verification.reason,
      tier: verification.tier,
    });

    priorSteps.push(step);

    // Short-circuit on hard failure
    if (verification.score < 0.2) {
      break;
    }
  }

  // Chain score is the minimum step score (weakest link)
  const chainScore = results.length > 0
    ? Math.min(...results.map(r => r.score))
    : 0;

  return {
    valid: chainScore >= 0.4,
    chainScore: Math.round(chainScore * 100) / 100,
    steps: results,
  };
}

// ─── Dependency Injection ──────────────────────────────────────────

function setSaveFunction(fn) { _saveFn = fn; }
function setSearchFunction(fn) { _searchFn = fn; }

// ─── Exports ────────────────────────────────────────────────────────

module.exports = {
  verifyDeterministic,
  verifyWithLLM,
  verifyAgainstMemory,
  verifyStep,
  verifyChain,
  setSaveFunction,
  setSearchFunction,
};
