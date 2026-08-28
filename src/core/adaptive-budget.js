/**
 * adaptive-budget.js — Compute-optimal allocation for test-time reasoning.
 *
 * Implements the key insight from Snell et al. (2024): allocate more inference
 * compute to harder problems. Instead of a fixed beam width or token budget,
 * this module estimates problem difficulty from memory and adjusts:
 *   - Beam width (number of reasoning branches)
 *   - Search depth (max reasoning chain length)
 *   - Token budget (max LLM tokens to spend on reasoning)
 *   - PRM verification intensity (verify all steps vs only leaves)
 *
 * Difficulty is estimated deterministically from:
 *   - Memory similarity (have we solved similar problems?)
 *   - Historical failure rate (how often have similar approaches failed?)
 *   - Codebase complexity (graph density around affected files)
 *   - Reflexion count (how many self-corrections in this session?)
 *
 * @module core/adaptive-budget
 */

'use strict';

// ─── Difficulty Estimation ─────────────────────────────────────────

/**
 * Estimate problem difficulty deterministically (zero LLM cost).
 *
 * @param {Object} params
 * @param {string} params.problem — Problem description
 * @param {string} params.project — Project path
 * @param {Array} [params.memories] — Relevant memories from search
 * @param {number} [params.reflexionCount] — How many self-corrections this session
 * @param {Object} [params.db] — Database for querying historical data
 * @returns {{ score: number, factors: Object }}
 */
function estimateDifficulty({ problem = '', project = '', memories = [], reflexionCount = 0, db = null }) {
  let score = 0;
  const factors = {};

  // Factor 1: Memory similarity — fewer similar memories = harder
  const relevantMemories = memories.filter(m => {
    const text = ((m.title || '') + ' ' + (m.content || '')).toLowerCase();
    const problemWords = problem.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const matchCount = problemWords.filter(w => text.includes(w)).length;
    return matchCount >= 2;
  });

  const similarCount = relevantMemories.length;
  const coverage = relevantMemories.length > 0
    ? new Set(relevantMemories.map(m => m.type).filter(Boolean)).size
    : 0;
  // Novelty is not the only risk: a one-sided, single-type retrieval is a
  // blind spot even when it contains many near-duplicates.
  const memoryScore = similarCount === 0 ? 4 : similarCount === 1 ? 2 : similarCount === 2 ? 1 : 0;
  const coveragePenalty = similarCount > 0 && coverage <= 1 ? 1 : 0;
  score += coveragePenalty;
  score += memoryScore;
  factors.memorySimilarity = { count: similarCount, score: memoryScore, typeCoverage: coverage, coveragePenalty };

  // Factor 2: Historical failure rate — more failures = harder
  const failureMemories = relevantMemories.filter(m => m.type === 'error');
  const failureScore = Math.min(failureMemories.length, 3);
  score += failureScore;
  factors.failureRate = { failures: failureMemories.length, score: failureScore };

  // Factor 3: Reflexion count — more corrections needed = harder
  const reflexionScore = Math.min(reflexionCount, 4);
  score += reflexionScore;
  factors.reflexionCount = { count: reflexionCount, score: reflexionScore };

  // Factor 4: Problem complexity signals from text
  const complexitySignals = [
    /\b(?:edge case|corner case|race condition|concurrent|async|timeout|race)\b/i,
    /\b(?:refactor|restructure|reorganize|architect)\b/i,
    /\b(?:security|auth|encrypt|permission|access control)\b/i,
    /\b(?:migration|upgrade|breaking change|backward compat)\b/i,
    /\b(?:performance|optimize|bottleneck|memory leak)\b/i,
  ];
  const signalMatches = complexitySignals.filter(p => p.test(problem)).length;
  const complexityScore = Math.min(signalMatches * 2, 4);
  score += complexityScore;
  factors.problemComplexity = { signals: signalMatches, score: complexityScore };

  // Factor 5: DB-based historical data (optional)
  if (db) {
    try {
      const recentErrors = db.prepare(
        `SELECT COUNT(*) as c FROM observations 
         WHERE project_path = ? AND type = 'error' AND is_active = 1 
         AND created_at > datetime('now', '-7 days')`
      ).get(project);
      const errorRate = Math.min(recentErrors.c, 10);
      const historicalScore = errorRate > 5 ? 3 : errorRate > 2 ? 1 : 0;
      score += historicalScore;
      factors.historicalErrors = { count: recentErrors.c, score: historicalScore };
    } catch {}
  }

  // Normalize to 0-10 range
  const normalizedScore = Math.min(Math.round(score), 10);

  return { score: normalizedScore, factors };
}

// ─── Budget Calculation ────────────────────────────────────────────

/**
 * Calculate the adaptive compute budget based on difficulty score.
 *
 * @param {number} difficultyScore — 0-10 difficulty score
 * @param {Object} [overrides] — Override specific budget parameters
 * @returns {{ beamWidth: number, maxDepth: number, tokenBudget: number, verifyAllSteps: boolean, strategy: string }}
 */
function calculateBudget(difficultyScore = 0, overrides = {}) {
  const d = Math.max(0, Math.min(10, difficultyScore));

  // Beam width: 1 (easy) to 5 (hard)
  // Easy problems: single-path is optimal (greedy decode)
  // Hard problems: wider exploration finds better solutions
  const beamWidth = overrides.beamWidth ||
    (d <= 2 ? 1 : d <= 4 ? 2 : d <= 6 ? 3 : d <= 8 ? 4 : 5);

  // Search depth: 2 (easy) to 8 (hard)
  const maxDepth = overrides.maxDepth ||
    (d <= 1 ? 2 : d <= 3 ? 3 : d <= 5 ? 5 : d <= 7 ? 6 : 8);

  // Token budget: 500 (easy) to 12000 (hard)
  // Snell et al. found diminishing returns beyond ~15K tokens
  const tokenBudget = overrides.tokenBudget ||
    Math.min(500 + d * 1200, 12000);

  // PRM verification: for easy problems, verify only at leaves (cheaper)
  // For hard problems, verify every step (prune early)
  const verifyAllSteps = overrides.verifyAllSteps !== undefined
    ? overrides.verifyAllSteps
    : d >= 4;

  // Strategy selection based on difficulty
  // Self-consistency: best for high-variance problems (arithmetic, multi-step logic)
  //   where individual chain accuracy drops exponentially per step
  // Budget-forcing: best for medium problems needing deeper analysis of a single path
  // MCTS: best for hard problems needing broad exploration
  // Beam: balanced for medium problems
  // Greedy: best for easy/trivial problems
  const strategy = overrides.strategy ||
    (d <= 1 ? 'greedy' : d <= 3 ? 'beam' : d <= 6 ? 'self-consistency' : d <= 8 ? 'budget-force' : 'mcts');

  // Self-consistency specific: number of independent chains to sample
  const scSamples = overrides.scSamples ||
    (d <= 3 ? 3 : d <= 5 ? 5 : d <= 7 ? 10 : 20);

  // Budget-forcing specific: min reasoning tokens before allowing stop
  const bfMinTokens = overrides.bfMinTokens ||
    (d <= 4 ? 100 : d <= 6 ? 300 : d <= 8 ? 500 : 1000);

  return {
    beamWidth,
    maxDepth,
    tokenBudget,
    verifyAllSteps,
    strategy,
    difficultyScore: d,
    // Self-consistency parameters
    scSamples,
    scTemperature: overrides.scTemperature || (d <= 4 ? 0.6 : 0.8),
    scPrmWeighting: overrides.scPrmWeighting !== undefined ? overrides.scPrmWeighting : (d >= 4),
    // Budget-forcing parameters
    bfMinTokens,
    bfMaxTokens: overrides.bfMaxTokens || Math.min(tokenBudget * 2, 16000),
    bfMaxRounds: overrides.bfMaxRounds || (d <= 4 ? 3 : 5),
  };
}

// ─── Adaptive Token Budget Allocator ────────────────────────────────

/**
 * Track token spend per reasoning trace and enforce the budget.
 * Returns remaining tokens and whether budget is exhausted.
 *
 * @param {Object} state — { spent: number, budget: number }
 * @param {number} stepTokens — Tokens consumed by this step
 * @returns {{ remaining: number, exhausted: boolean, utilization: number }}
 */
function trackBudget(state, stepTokens) {
  const spent = (state.spent || 0) + stepTokens;
  const budget = state.budget || 2000;
  const remaining = Math.max(0, budget - spent);
  const utilization = budget > 0 ? spent / budget : 0;

  return {
    spent,
    budget,
    remaining,
    exhausted: remaining <= 0,
    utilization: Math.round(utilization * 100) / 100,
  };
}

// ─── UCT Score (for MCTS) ─────────────────────────────────────────

/**
 * Calculate Upper Confidence bound for Trees (UCT) score.
 * Used by tree-search.js for MCTS node selection.
 *
 * UCT(node) = Q(node) + c * sqrt(ln(N(parent)) / N(node))
 *
 * @param {Object} params
 * @param {number} params.qValue — Average reward (from PRM scores)
 * @param {number} params.visitCount — Times this node was visited
 * @param {number} params.parentVisits — Times parent was visited
 * @param {number} [params.explorationConstant=1.414] — Exploration weight (sqrt(2))
 * @returns {number} UCT score (higher = more promising)
 */
function uctScore({ qValue = 0, visitCount = 0, parentVisits = 0, explorationConstant = 1.414 }) {
  if (visitCount === 0) return Infinity; // Unexplored nodes always explored first
  if (parentVisits === 0) return qValue;

  const exploitation = qValue;
  const exploration = explorationConstant * Math.sqrt(Math.log(parentVisits) / visitCount);

  return exploitation + exploration;
}

// ─── Exports ────────────────────────────────────────────────────────

module.exports = {
  estimateDifficulty,
  calculateBudget,
  trackBudget,
  uctScore,
};
