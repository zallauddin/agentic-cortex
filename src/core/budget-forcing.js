/**
 * budget-forcing.js — s1-style Budget Forcing for agentic-cortex.
 *
 * Implements the Budget Forcing mechanism from Muennighoff et al. (s1, 2025):
 * directly manipulate the reasoning depth by controlling when the model is
 * allowed to stop generating.
 *
 * In the original s1 paper, this is done via token-level suppression during
 * auto-regressive decoding. Since agentic-cortex calls LLMs via HTTP API,
 * we implement the equivalent via:
 *
 *   1. Lower-Bound Forcing (Enforce Deep Thought):
 *      After the model responds, if its response is too short (below B_min tokens),
 *      we append a continuation prompt like "Wait, let me double check..." and
 *      call the LLM again with the full conversation context, forcing additional
 *      reasoning steps.
 *
 *   2. Upper-Bound Truncation (Prevent Infinite Loop):
 *      After B_max accumulated tokens, we inject "Therefore, the final answer is:"
 *      as a hard stop, forcing the model to synthesize its reasoning into an answer.
 *
 *   3. Sequential Deepening:
 *      Multiple rounds of forced continuation, each time appending a doubt/introspection
 *      heuristic to make the model reconsider and extend its reasoning chain.
 *
 * Budget forcing differs from tree search and self-consistency:
 *   - Tree search: multiple parallel branches (breadth)
 *   - Self-consistency: multiple independent full chains (breadth)
 *   - Budget forcing: single sequential chain, forced deeper (depth)
 *
 * @module core/budget-forcing
 */

'use strict';

const { callLLM } = require('./session');

// Lazy-loaded dependencies
let _prompts = null;
let _saveFn = null;

function _getPrompts() {
  if (!_prompts) _prompts = require('./prompts');
  return _prompts;
}

// ─── Budget Forcing Configuration ─────────────────────────────────

const DEFAULT_CONFIG = {
  minTokens: 200,        // B_min: minimum reasoning tokens before allowed to stop
  maxTokens: 6000,       // B_max: hard cap — inject conclusion after this
  maxRounds: 5,          // Maximum forced continuation rounds (prevent infinite loops)
  continuationTokens: 500, // Token budget per continuation round
  temperatureBase: 0.6,  // Base temperature for first round
  temperatureDecay: 0.91, // Multiplicative decay per round (cools as certainty grows)
};

// Continuation heuristics: prompts appended when min depth not reached
const CONTINUATION_HEURISTICS = [
  'Wait, let me double-check this step. Are there any edge cases I missed?',
  'Hmm, I should reconsider my approach from a different angle.',
  'Let me verify my reasoning. Is there a more elegant or robust solution?',
  'I might be overlooking something important. Let me think about this more carefully.',
  'Let me examine potential failure modes of this solution.',
  'Before finalizing, let me consider the opposite perspective.',
  'Wait — I should also consider the performance and security implications.',
  'Let me step back and think about this more systematically.',
];

// Conclusion prompts: injected when max depth reached
const CONCLUSION_PROMPTS = [
  'Therefore, after careful analysis, the final answer is:',
  'To summarize my reasoning and provide a definitive answer:',
  'Based on the analysis above, the correct solution is:',
  'Having examined this from multiple angles, I conclude:',
];

// ─── Token Estimation ─────────────────────────────────────────────

/**
 * Rough token count estimation (~4 chars per token, conservative).
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

// ─── Continuation Round ───────────────────────────────────────────

/**
 * Execute a single forced continuation round.
 * Appends a doubt heuristic to the conversation and calls LLM again.
 *
 * @param {Array<{role: string, content: string}>} messages — Full conversation so far
 * @param {Object} opts
 * @param {number} opts.maxTokens — Token budget for this round
 * @param {number} opts.temperature — Temperature for this round
 * @param {number} opts.roundIndex — Which continuation round (for heuristic selection)
 * @returns {Promise<{ response: string, tokensEstimate: number } | null>}
 */
async function forceContinue(messages, { maxTokens = 500, temperature = 0.5, roundIndex = 0 }) {
  const heuristic = CONTINUATION_HEURISTICS[roundIndex % CONTINUATION_HEURISTICS.length];

  // Append the doubt heuristic as an assistant self-correction
  const extendedMessages = [
    ...messages,
    { role: 'assistant', content: heuristic },
    { role: 'user', content: 'Please continue your analysis. Check your reasoning before giving a final answer.' },
  ];

  try {
    const result = await callLLM(extendedMessages, {
      temperature,
      maxTokens,
      timeout: 30000,
    });

    if (!result) return null;

    return {
      response: result,
      tokensEstimate: estimateTokens(result),
    };
  } catch {
    return null;
  }
}

// ─── Conclusion Synthesis ─────────────────────────────────────────

/**
 * Force conclusion synthesis when the upper budget is reached.
 * Injects a conclusion prompt into the conversation.
 *
 * @param {Array<{role: string, content: string}>} messages — Full conversation
 * @param {string} lastResponse — The last model response
 * @param {number} roundIndex — Which round (for prompt rotation)
 * @returns {Promise<{ conclusion: string, tokensEstimate: number } | null>}
 */
async function forceConclusion(messages, lastResponse, roundIndex = 0) {
  const conclusionPrompt = CONCLUSION_PROMPTS[roundIndex % CONCLUSION_PROMPTS.length];

  const extendedMessages = [
    ...messages,
    { role: 'assistant', content: lastResponse },
    { role: 'user', content: conclusionPrompt },
  ];

  try {
    const result = await callLLM(extendedMessages, {
      temperature: 0.1, // Very low temp for final synthesis
      maxTokens: 800,
      timeout: 30000,
    });

    if (!result) return null;

    return {
      conclusion: result,
      tokensEstimate: estimateTokens(result),
    };
  } catch {
    return null;
  }
}

// ─── Answer Extraction ────────────────────────────────────────────

/**
 * Extract a final answer from the accumulated reasoning chain.
 * Tries multiple strategies in order.
 *
 * @param {string[]} allResponses — All model responses in order
 * @returns {{ answer: string, confidence: number }}
 */
function extractForcedAnswer(allResponses) {
  const fullText = allResponses.join('\n\n');

  // Look for explicit answer markers
  const answerMatch = fullText.match(/ANSWER:\s*([^\n]+(?:\n(?!\n)[^\n]+)*)/i);
  if (answerMatch) {
    return { answer: answerMatch[1].trim(), confidence: 0.85 };
  }

  // Look for conclusion section
  const conclusionMatch = fullText.match(/(?:final answer|conclusion|therefore|to summarize)[:\s]\s*([^\n]+(?:\n(?!\n)[^\n]+)*)/i);
  if (conclusionMatch) {
    return { answer: conclusionMatch[1].trim(), confidence: 0.7 };
  }

  // Last non-empty line of the last response
  const last = allResponses[allResponses.length - 1] || '';
  const lines = last.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 0) {
    return { answer: lines[lines.length - 1], confidence: 0.4 };
  }

  return { answer: 'No clear answer extracted', confidence: 0.1 };
}

// ─── Main Budget-Forcing Pipeline ─────────────────────────────────

/**
 * Run budget-forced reasoning: generate an initial response, then
 * repeatedly force continuation until min depth is reached, capped at
 * max total depth.
 *
 * @param {Object} params
 * @param {string} params.problem — Problem to solve
 * @param {Object} [params.config] — Override default budget forcing config
 * @param {number} [params.config.minTokens] — Minimum reasoning tokens before stopping
 * @param {number} [params.config.maxTokens] — Maximum total tokens before force-synthesizing
 * @param {number} [params.config.maxRounds] — Maximum continuation rounds
 * @param {number} [params.config.temperatureBase] — Starting temperature
 * @returns {Promise<Object>} Budget-forced reasoning result
 */
async function budgetForce({ problem, config = {} }) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const startTime = Date.now();

  // Phase 1: Initial response
  const messages = [
    {
      role: 'system',
      content: `Solve this problem thoroughly. Show ALL your reasoning steps. Consider edge cases, alternative approaches, and verify your logic. End your response with a final answer prefixed by "ANSWER:".

Format:
Step 1: (analysis)
Step 2: (analysis)
...
ANSWER: (final answer)`,
    },
    { role: 'user', content: problem },
  ];

  let currentResponse;
  try {
    currentResponse = await callLLM(messages, {
      temperature: cfg.temperatureBase,
      maxTokens: cfg.continuationTokens,
      timeout: 60000,
    });
  } catch {
    currentResponse = null;
  }

  if (!currentResponse) {
    return {
      problem,
      answer: '',
      confidence: 0,
      status: 'failed',
      error: 'Initial response generation failed',
      rounds: 0,
      totalTokens: 0,
      durationMs: Date.now() - startTime,
    };
  }

  let allResponses = [currentResponse];
  let totalTokens = estimateTokens(currentResponse);
  const conversation = [...messages];

  // Phase 2: Lower-bound forcing — keep going until we hit minTokens
  let roundIndex = 0;
  let forcedArtist = false;

  while (totalTokens < cfg.minTokens && roundIndex < cfg.maxRounds) {
    conversation.push({ role: 'assistant', content: allResponses[allResponses.length - 1] });

    const continuation = await forceContinue(conversation, {
      maxTokens: cfg.continuationTokens,
      temperature: cfg.temperatureBase * Math.pow(cfg.temperatureDecay, roundIndex),
      roundIndex,
    });

    if (!continuation) break;

    allResponses.push(continuation.response);
    totalTokens += continuation.tokensEstimate;
    roundIndex++;

    // Upper-bound check: if we're approaching maxTokens, force conclusion
    if (totalTokens >= cfg.maxTokens * 0.85) {
      forcedArtist = true;
      break;
    }
  }

  // Phase 3: Upper-bound truncation — force conclusion synthesis
  let conclusion = null;
  if (totalTokens >= cfg.maxTokens * 0.85 || roundIndex >= cfg.maxRounds) {
    conversation.push({ role: 'assistant', content: allResponses[allResponses.length - 1] });
    conclusion = await forceConclusion(conversation, allResponses[allResponses.length - 1], roundIndex);
    if (conclusion) {
      allResponses.push(conclusion.conclusion);
      totalTokens += conclusion.tokensEstimate;
    }
    forcedArtist = true;
  }

  // Phase 4: Extract and format answer
  const { answer, confidence } = extractForcedAnswer(allResponses);

  // Phase 5: Build reasoning depth metrics
  const avgTokensPerRound = allResponses.length > 0
    ? Math.round(totalTokens / allResponses.length)
    : 0;
  const depthScore = Math.min(10, Math.round((totalTokens / cfg.minTokens) * 5));

  return {
    problem,
    answer,
    confidence: Math.round(confidence * 100) / 100,
    status: forcedArtist ? 'forced-conclusion' : 'completed',
    rounds: allResponses.length,
    forcedContinuations: roundIndex,
    totalTokens,
    minTokensConfig: cfg.minTokens,
    maxTokensConfig: cfg.maxTokens,
    depthScore,
    avgTokensPerRound,
    temperatureDecay: Math.pow(cfg.temperatureDecay, roundIndex),
    durationMs: Date.now() - startTime,
    method: 's1-budget-forcing',
    responses: allResponses.map((r, i) => ({
      round: i,
      tokenEstimate: estimateTokens(r),
      contentPreview: r.slice(0, 400),
    })),
  };
}

// ─── Budget-Forced Chain Wrapper (for self-consistency integration) ─

/**
 * Generate a single budget-forced chain. Used as a drop-in replacement
 * for self-consistency's generateChain when deeper reasoning is needed.
 *
 * @param {Object} params
 * @param {string} params.problem
 * @param {Object} [params.config]
 * @returns {Promise<{ chain: string, tokensUsed: number } | null>}
 */
async function generateForcedChain({ problem, config = {} }) {
  const result = await budgetForce({ problem, config });

  if (!result || result.status === 'failed') return null;

  const fullChain = result.responses.map(r => r.contentPreview).filter(Boolean).join('\n\n');

  return {
    chain: fullChain,
    tokensUsed: result.totalTokens,
  };
}

// ─── Dependency Injection ──────────────────────────────────────────

function setSaveFunction(fn) { _saveFn = fn; }

// ─── Exports ────────────────────────────────────────────────────────

module.exports = {
  DEFAULT_CONFIG,
  CONTINUATION_HEURISTICS,
  CONCLUSION_PROMPTS,
  estimateTokens,
  forceContinue,
  forceConclusion,
  extractForcedAnswer,
  budgetForce,
  generateForcedChain,
  setSaveFunction,
};