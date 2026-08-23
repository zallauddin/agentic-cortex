/**
 * reflexion-loop.js — In-Context Self-Correction for agentic-cortex.
 *
 * Implements the Reflexion pattern (Shinn et al., 2023): convert failed
 * reasoning paths into natural language memory, preventing repeated mistakes
 * within the same execution episode.
 *
 * Unlike the existing self-improve.js (which generates "learnings" from errors
 * across sessions), reflexion is SESSION-SCOPED and IMMEDIATE:
 *   - After a reasoning branch fails verification, extract WHY it failed
 *   - Save as a temporary context observation tagged with the session
 *   - Next branches of the tree search automatically pick this up via memory
 *   - Prevents the agent from trying the same failed approach twice
 *
 * This creates a "working memory" effect: the agent remembers its recent
 * mistakes and adjusts behavior accordingly, all without weight updates.
 *
 * @module core/reflexion-loop
 */

'use strict';

const { callLLM } = require('./session');

// Lazy-loaded dependencies
let _saveFn = null;
let _searchFn = null;

// Per-session reflexion context (in-memory)
// Key: sessionId, Value: Array<{ failedPath, error, critique, savedObsId }>
const _sessionReflexions = new Map();
const MAX_REFLEXIONS_PER_SESSION = 20;

// ─── Reflexion Extraction (LLM) ────────────────────────────────────

/**
 * Extract a structured critique from a failed reasoning path.
 * Uses the LLM to analyze WHY the path failed, not just THAT it failed.
 *
 * @param {Object} params
 * @param {string} params.failedPath — The reasoning steps that failed
 * @param {string} params.verificationError — Why PRM rejected it
 * @param {string} params.problem — Original problem
 * @param {string} params.strategy — What approach was tried
 * @returns {Promise<{ critique: string, avoidPattern: string, suggestAlternative: string }>}
 */
async function extractCritique({ failedPath, verificationError, problem, strategy }) {
  const messages = [
    {
      role: 'system',
      content: `You analyze failed reasoning paths and extract actionable critiques.
Given a problem, a failed reasoning attempt, and why it was rejected, identify:
1. The root cause of the reasoning failure
2. A pattern to AVOID in future attempts
3. A suggested alternative approach

Be specific and concise. The critique will be used by the same agent to avoid repeating this mistake.

Respond ONLY with valid JSON:
{
  "critique": "Why this path failed (1-2 sentences)",
  "avoidPattern": "A generalizable pattern to avoid (e.g., 'Don't assume X is always true')",
  "suggestAlternative": "A concrete alternative approach to try"
}`,
    },
    {
      role: 'user',
      content: `Problem: ${problem}\n\nFailed approach: ${strategy}\n\nReasoning path:\n${failedPath}\n\nReason for rejection: ${verificationError}`,
    },
  ];

  try {
    const result = await callLLM(messages, {
      temperature: 0.2,
      maxTokens: 500,
      timeout: 15000,
    });

    const parsed = JSON.parse(result || '{}');
    return {
      critique: parsed.critique || 'Failed reasoning path',
      avoidPattern: parsed.avoidPattern || '',
      suggestAlternative: parsed.suggestAlternative || '',
    };
  } catch {
    return {
      critique: `Approach failed: ${verificationError}`,
      avoidPattern: strategy,
      suggestAlternative: 'Try a different approach',
    };
  }
}

// ─── Reflexion Management ─────────────────────────────────────────

/**
 * Record a reflexion for a failed reasoning path.
 * Extracts critique, saves as context observation, and stores in session state.
 *
 * @param {Object} params
 * @param {string} params.sessionId — Current session ID
 * @param {string} params.problem — Original problem
 * @param {string} params.failedPath — The reasoning steps that failed
 * @param {string} params.verificationError — Why it was rejected
 * @param {string} params.strategy — What approach was tried
 * @param {string} params.project — Project path
 * @param {Object} [params.db] — Database
 * @returns {Promise<{ reflexion: Object, savedObsId: number|null }>}
 */
async function recordReflexion({ sessionId, problem, failedPath, verificationError, strategy, project, db = null }) {
  // Extract critique via LLM
  const critique = await extractCritique({ failedPath, verificationError, problem, strategy });

  // Save as context observation
  let savedObsId = null;
  if (_saveFn) {
    try {
      const obs = await _saveFn({
        project,
        type: 'context',
        title: `Reflexion: ${critique.avoidPattern.slice(0, 60) || 'failed path'}`,
        content: [
          `Problem: ${problem}`,
          `Failed approach: ${strategy}`,
          `Critique: ${critique.critique}`,
          `AVOID: ${critique.avoidPattern}`,
          `TRY INSTEAD: ${critique.suggestAlternative}`,
        ].join('\n'),
        tags: ['reflexion', 'self-correction', sessionId, 'auto-capture'],
        importance: 8,
        provenance: 'inferred',
        confidence: 85,
      });
      savedObsId = obs?.id || null;
    } catch {}
  }

  const reflexion = {
    failedPath,
    verificationError,
    strategy,
    critique,
    savedObsId,
    recordedAt: new Date().toISOString(),
  };

  // Store in session state
  if (!_sessionReflexions.has(sessionId)) {
    _sessionReflexions.set(sessionId, []);
  }
  const sessionList = _sessionReflexions.get(sessionId);
  sessionList.push(reflexion);

  // Trim if too many (keep most recent)
  while (sessionList.length > MAX_REFLEXIONS_PER_SESSION) {
    sessionList.shift();
  }

  return { reflexion, savedObsId };
}

/**
 * Get all reflexions for a session.
 * @param {string} sessionId
 * @returns {Array<Object>}
 */
function getSessionReflexions(sessionId) {
  return _sessionReflexions.get(sessionId) || [];
}

/**
 * Build a context string from session reflexions for injection into prompts.
 * This is the "working memory" that prevents repeated mistakes.
 *
 * @param {string} sessionId
 * @param {number} [limit=5] — Max reflexions to include
 * @returns {string}
 */
function buildReflexionContext(sessionId, limit = 5) {
  const reflexions = getSessionReflexions(sessionId).slice(-limit);
  if (reflexions.length === 0) return '';

  const lines = ['## What NOT to Try (from recent failures):'];
  for (const r of reflexions) {
    if (r.critique?.avoidPattern) {
      lines.push(`- AVOID: ${r.critique.avoidPattern}`);
    }
    if (r.critique?.suggestAlternative) {
      lines.push(`- INSTEAD: ${r.critique.suggestAlternative}`);
    }
  }

  return lines.join('\n');
}

/**
 * Build a concise reflexion summary for tree-search branch generation.
 * Used to steer the LLM away from failed approaches.
 *
 * @param {string} sessionId
 * @returns {string}
 */
function buildAvoidPatterns(sessionId) {
  const reflexions = getSessionReflexions(sessionId);
  if (reflexions.length === 0) return '';

  return reflexions
    .map(r => r.critique?.avoidPattern)
    .filter(Boolean)
    .join('; ');
}

/**
 * Clear session reflexions (e.g., when session ends).
 * @param {string} sessionId
 */
function clearSession(sessionId) {
  _sessionReflexions.delete(sessionId);
}

// ─── Reflexion-Aware Search Enhancement ────────────────────────────

/**
 * Filter out branches that match known avoid patterns.
 * Used by tree-search.js to prevent generating the same failed approaches.
 *
 * @param {string} sessionId
 * @param {Array<{ content: string }>} branches — Candidate branches
 * @returns {Array<{ content: string, filtered: boolean }>}
 */
function filterBranches(sessionId, branches) {
  const avoidPatterns = getSessionReflexions(sessionId)
    .map(r => r.critique?.avoidPattern)
    .filter(Boolean);

  if (avoidPatterns.length === 0) {
    return branches.map(b => ({ ...b, filtered: false }));
  }

  return branches.map(branch => {
    const content = (branch.content || '').toLowerCase();
    const matchesAvoid = avoidPatterns.some(pattern => {
      const words = pattern.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const matchCount = words.filter(w => content.includes(w)).length;
      return matchCount >= Math.ceil(words.length * 0.5);
    });

    return { ...branch, filtered: matchesAvoid };
  });
}

// ─── Dependency Injection ──────────────────────────────────────────

function setSaveFunction(fn) { _saveFn = fn; }
function setSearchFunction(fn) { _searchFn = fn; }

// ─── Exports ────────────────────────────────────────────────────────

module.exports = {
  extractCritique,
  recordReflexion,
  getSessionReflexions,
  buildReflexionContext,
  buildAvoidPatterns,
  filterBranches,
  clearSession,
  setSaveFunction,
  setSearchFunction,
};
