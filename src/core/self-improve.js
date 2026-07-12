/**
 * self-improve.js — Self-improving agentic loop for agentic-cortex.
 *
 * Detects shortcomings (errors, contradictions, gaps), performs root cause
 * analysis via LLM, and generates automatic improvements ("learnings").
 * Operates continuously via the hooks system — no manual invocation needed.
 *
 * Three core operations:
 *
 * 1. learnFromError — When an 'error' observation is saved, triggers RCA
 *    via LLM and generates a 'learning' observation with the systemic fix.
 *
 * 2. autoResolveConflicts — Detects contradictory observations via the
 *    conflict module, uses LLM to determine the correct version, adjusts
 *    confidence scores, and creates a learning from the resolution.
 *
 * 3. verifyLearning — When new observations contradict or reinforce a
 *    previous learning, adjusts the learning's confidence up or down.
 *    High-confidence learnings become "rules"; low-confidence ones decay.
 *
 * Integration: initHooks() registers post_save hooks so the loop is
 * always running — every save triggers self-improvement checks.
 *
 * @module core/self-improve
 */

'use strict';

const { callLLM } = require('./session');
const { checkConflicts } = require('./conflict');
const { addRelation } = require('./relations');
const hooks = require('./hooks');

// Injected save function (avoids circular dependency on src/api)
let _saveFn = null;

// Track already-analyzed error IDs to prevent duplicate RCA
const _analyzedErrorIds = new Set();
const MAX_ANALYZED_CACHE = 200;

// Track save counts per project for periodic conflict checks (every ~30 saves)
const _projectSaveCounts = new Map();
const MAX_SAVE_COUNTS = 50;

// Track whether the last classifyOutcome call used the keyword fallback
let _lastClassificationFallback = false;

// Gap 7: deterministic verification — per-learning debounce cache (learningId → lastVerifiedAt ms)
const _verifiedRecently = new Map();
const VERIFY_DEBOUNCE_MS = 60000; // skip re-verifying same learning within 60s

// ─── Outcome Classification ─────────────────────────────────────────

/**
 * Keyword-based fallback classifier for outcome text.
 * Preserved from the original Hook 3 implementation for use when the LLM
 * is unavailable or returns unparseable output.
 *
 * @param {string} outcomeText - The outcome content to classify
 * @returns {'success'|'failure'|'neutral'} Classification result
 */
function _keywordClassify(outcomeText) {
  const text = (outcomeText || '').toLowerCase();
  const successIndicators = ['pass', 'success', 'ok', 'completed', 'works', 'fixed', 'resolved', 'done', 'created', 'updated'];
  const failureIndicators = ['fail', 'error', 'crash', 'broke', 'failed', 'rejected', 'timeout', 'rollback', 'revert'];

  const succeeded = successIndicators.some(w => text.includes(w));
  const failed = failureIndicators.some(w => text.includes(w));

  if (succeeded && !failed) return 'success';
  if (failed) return 'failure';
  return 'neutral';
}

/**
 * Classify an outcome text as success, failure, or neutral using an LLM.
 * Falls back to keyword-based classification if the LLM is unavailable or
 * returns invalid output.
 *
 * @param {string} outcomeText - The outcome content to classify
 * @returns {Promise<'success'|'failure'|'neutral'>} Classification result
 */
async function classifyOutcome(outcomeText) {
  const systemPrompt = `You classify the outcome of a coding action. Respond with a single JSON object.

Classification rules:
- "success" = the action achieved its intended goal (work completed, test passes, bug fixed, build green, key created)
- "failure" = the action did NOT achieve its goal (anything failed, broke, rejected, error, timeout, rollback, didn't work, didn't take, didn't fix)
- "neutral" = outcome is ambiguous or neither success nor failure

CRITICAL rules:
- MUST handle negation: "didn't work", "didn't take", "didn't fix", "didn't pass", "not working" are FAILURES, not successes
- MUST handle implicit failure: "the code crashed after applying" is a FAILURE
- "fixed" alone is success; "didn't fix" is failure

Respond ONLY with: {"outcome":"success|failure|neutral","reason":"brief reason"}`;

  _lastClassificationFallback = false;
  try {
    const result = await callLLM([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Classify this outcome: "${(outcomeText || '').slice(0, 500)}"` },
    ], { temperature: 0, maxTokens: 80, timeout: 8000 });

    const parsed = JSON.parse(result || '{}');
    if (['success', 'failure', 'neutral'].includes(parsed.outcome)) {
      return parsed.outcome;
    }
  } catch {
    // LLM unavailable or parse failed — fall through to keyword fallback
  }

  _lastClassificationFallback = true;
  return _keywordClassify(outcomeText);
}

// ─── 1. Root Cause Analysis from Errors ──────────────────────────────

/**
 * Analyze an error observation and generate a systemic learning/fix.
 * Called automatically by the post_save hook when type='error' is saved.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} errorObs - The error observation that was just saved
 * @returns {Promise<Object|null>} The created learning observation, or null if skipped
 */
async function learnFromError(db, errorObs) {
  if (!errorObs.id) return null;
  if (_analyzedErrorIds.has(errorObs.id)) return null;

  // Clean up the cache periodically
  if (_analyzedErrorIds.size > MAX_ANALYZED_CACHE) {
    const entries = [..._analyzedErrorIds];
    _analyzedErrorIds.clear();
    for (const id of entries.slice(-MAX_ANALYZED_CACHE / 2)) {
      _analyzedErrorIds.add(id);
    }
  }
  _analyzedErrorIds.add(errorObs.id);

  if (!_saveFn) {
    console.warn('[self-improve] No save function injected — cannot save. Call initHooks(saveFn) or setSaveFunction(saveFn) first.');
    return null;
  }

  const prompt = `Analyze this coding agent error and identify the root cause and a systemic fix.

Error: "${errorObs.content}"

Context: This error occurred while a coding agent was working on a software project.
Identify:
1. Root cause: Why did this happen? Was it a knowledge gap, a process flaw, or a code issue?
2. Systemic fix: What rule, check, or practice would prevent this class of error in the future?

Return JSON with:
- title: Short fix title (max 80 chars, e.g., "Always validate input before transform")
- content: The systemic fix described as a rule or practice (max 500 chars)
- confidence: 1-100, how certain you are this fix addresses the root cause
- tags: Array of relevant tags`;

  try {
    const result = await callLLM([
      { role: 'system', content: 'You are a root cause analysis agent for coding workflows. Respond ONLY with valid JSON.' },
      { role: 'user', content: prompt },
    ], { temperature: 0.2, maxTokens: 800, timeout: 60000 });

    const parsed = JSON.parse(result || '{}');
    if (parsed.title && parsed.content) {
      const learning = await _saveFn({
        project: errorObs.project_path,
        type: 'learning',
        title: parsed.title,
        content: parsed.content,
        tags: [...(parsed.tags || []), 'auto-correction', 'rca'],
        confidence: parsed.confidence || 75,
        importance: 8,
        provenance: 'inferred',
        session: errorObs.session_id || null,
      });

      // Create a relation: this learning is derived from the error
      if (learning && learning.id && errorObs.id) {
        try {
          await addRelation(db, {
            sourceId: learning.id,
            targetId: errorObs.id,
            relationType: 'derives_from',
            confidence: 85,
          });
        } catch {}
      }

      return learning;
    }
  } catch (e) {
    console.warn('[self-improve] RCA failed:', e.message);
  }

  return null;
}

// ─── 2. Conflict Auto-Resolution ─────────────────────────────────────

/**
 * Run conflict detection on a project and auto-resolve contradictions.
 * Uses LLM to determine which observation is correct, adjusts confidence,
 * and creates a learning from the resolution.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} opts
 * @param {string} [opts.project] - Project path
 * @param {number} [opts.limit=5] - Max conflicts to resolve
 * @returns {Promise<{resolved: number, conflictsFound: number}>}
 */
async function autoResolveConflicts(db, opts = {}) {
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const limit = opts.limit || 5;

  let conflictResult;
  try {
    conflictResult = await checkConflicts(db, { project, limit, autoResolve: true });
  } catch (e) {
    console.warn('[self-improve] Conflict detection failed:', e.message);
    return { resolved: 0, conflictsFound: 0 };
  }

  const conflicts = conflictResult.conflicts || [];
  let resolved = 0;

  for (const c of conflicts) {
    if (!c.llm_contradiction) continue;

    try {
      // Ask LLM which version is correct
      const prompt = `Two observations appear to contradict each other. Determine which is correct.

A: "${c.a.preview || c.a.content?.slice(0, 300) || ''}"
B: "${c.b.preview || c.b.content?.slice(0, 300) || ''}"

Return JSON:
- correct: "A", "B", or "both_partially"
- reasoning: Brief explanation (max 200 chars)
- resolution: How to reconcile them or which to trust (max 300 chars)`;

      const result = await callLLM([
        { role: 'system', content: 'You resolve knowledge conflicts. Respond ONLY with valid JSON.' },
        { role: 'user', content: prompt },
      ], { temperature: 0.1, maxTokens: 600, timeout: 30000 });

      const decision = JSON.parse(result || '{}');

      if (decision.correct === 'A') {
        // A is correct, downgrade B
        db.prepare('UPDATE observations SET confidence = MAX(confidence / 2, 10) WHERE id = ?')
          .run(c.b.id);
        resolved++;
      } else if (decision.correct === 'B') {
        // B is correct, downgrade A
        db.prepare('UPDATE observations SET confidence = MAX(confidence / 2, 10) WHERE id = ?')
          .run(c.a.id);
        resolved++;
      }

      // Save the resolution as a learning
      if (_saveFn && decision.resolution) {
        await _saveFn({
          project,
          type: 'learning',
          title: 'Conflict resolved: ' + (decision.reasoning || 'Knowledge reconciliation').slice(0, 60),
          content: decision.resolution,
          tags: ['conflict-resolution', 'auto-correction'],
          confidence: 85,
          importance: 7,
          provenance: 'inferred',
        });
      }
    } catch (e) {
      console.warn('[self-improve] Conflict resolution failed:', e.message);
    }
  }

  return { resolved, conflictsFound: conflicts.length };
}

// ─── 3. Learning Verification ────────────────────────────────────────

/**
 * When a new observation is saved, check if it contradicts or reinforces
 * existing learnings. Adjust confidence scores accordingly.
 *
 * High confidence learnings (> 85) harden into "rules" that are less
 * likely to be adjusted. Low confidence learnings (< 30) may be retired.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} newObs - The newly saved observation
 */
async function verifyLearning(db, newObs) {
  // Find learnings in the same project

  const learnings = db.prepare(
    'SELECT id, title, content, confidence FROM observations ' +
    'WHERE project_path = ? AND type = ? AND is_active = 1 ' +
    'AND confidence BETWEEN 20 AND 95 ' +
    'ORDER BY created_at DESC LIMIT 3'
  ).all(newObs.project_path || process.cwd(), 'learning');

  if (learnings.length === 0) return;

  for (const learning of learnings) {
    const nowMs = Date.now();
    if (_verifiedRecently.has(learning.id) && (nowMs - _verifiedRecently.get(learning.id)) < VERIFY_DEBOUNCE_MS) {
      continue; // skip — verified recently, deterministic on other learnings
    }
    try {
      const prompt = `A learning rule exists: "${learning.title}: ${learning.content.slice(0, 200)}"

A new observation was just recorded: "[${newObs.type}] ${newObs.title || ''}: ${(newObs.content || '').slice(0, 200)}"

Does the new observation:
- CONTRADICT the learning (the learning appears wrong or incomplete)?
- REINFORCE the learning (it confirms the learning was correct)?
- NEUTRAL (unrelated)?

Return JSON: { \"verdict\": \"CONTRADICT\"|\"REINFORCE\"|\"NEUTRAL\", \"reason\": \"brief reason\" }`;

      const result = await callLLM([
        { role: 'system', content: 'You verify knowledge against new evidence. Respond ONLY with valid JSON.' },
        { role: 'user', content: prompt },
      ], { temperature: 0.1, maxTokens: 200, timeout: 15000 });

      const parsed = JSON.parse(result || '{}');

      if (parsed.verdict === 'REINFORCE') {
        // Boost confidence, cap at 98
        db.prepare('UPDATE observations SET confidence = MIN(confidence + 5, 98) WHERE id = ?')
          .run(learning.id);
      } else if (parsed.verdict === 'CONTRADICT' && learning.confidence < 85) {
        // Only downgrade non-hardened learnings
        db.prepare('UPDATE observations SET confidence = MAX(confidence - 15, 10) WHERE id = ?')
          .run(learning.id);
      }
      _verifiedRecently.set(learning.id, nowMs);
    } catch (e) {
      // LLM verification is best-effort; failures are silent
    }
  }

  // Prune debounce cache if it grows too large
  if (_verifiedRecently.size > 500) {
    const sortedIds = [..._verifiedRecently.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < 250; i++) _verifiedRecently.delete(sortedIds[i][0]);
  }
}

// ─── 4. Continuous Loop via Hooks ────────────────────────────────────

/**
 * Initialize the self-improving loop by registering hooks.
 * Call once during API initialization. After this, every save triggers
 * improvement checks automatically.
 *
 * @param {Function} saveFn - The API's save() function (injected to avoid circular dependency)
 */
function initHooks(saveFn) {
  _saveFn = saveFn;

  // Hook 1: When an error is saved, trigger RCA
  hooks.registerHook('post_save', async (obs, ctx, db) => {
    if (obs.type === 'error') {
      console.warn('[self-improve] Error detected (#%d), running RCA...', obs.id);
      await learnFromError(db, obs);
    }
  });

  // Hook 2: When any observation is saved, verify existing learnings
  hooks.registerHook('post_save', async (obs, ctx, db) => {
    if (obs.type === 'learning') return; // Don't verify learnings against themselves
    await verifyLearning(db, obs);
  });

  // Hook 3: Evidence-based confidence — when an action outcome is saved, compare to intent
  // Gated by tag check to avoid expensive queries on every save
  hooks.registerHook('post_save', async (obs, ctx, db) => {
    if (!obs.id || !obs.project_path) return;
    // Only run for observations that could be action outcomes
    const obsTags = Array.isArray(obs.tags) ? obs.tags : [];
    const hasActionTags = obsTags.some(t => t === 'outcome' || t === 'action-triplet');
    if (!hasActionTags) return;

    // Find linked actions via 'produces' relation (action → outcome)
    const linkedActions = db.prepare(
      `SELECT a.id, a.title, a.content, a.confidence
       FROM observations a
       JOIN memory_relations r ON r.source_id = a.id
       WHERE r.target_id = ? AND r.relation_type = 'produces' AND a.type = 'action'`
    ).all(obs.id);

    for (const action of linkedActions) {
      // Find the intent that led to this action
      const intent = db.prepare(
        `SELECT i.id, i.title, i.content, i.confidence
         FROM observations i
         JOIN memory_relations r ON r.source_id = i.id
         WHERE r.target_id = ? AND r.relation_type = 'achieves' AND i.type = 'action'`
      ).get(action.id);

      if (!intent) continue;

      // Compare outcome to intent using LLM classifier (with keyword fallback)
      const outcomeText = obs.content || '';
      let result;
      try {
        result = await classifyOutcome(outcomeText);
      } catch {
        result = _keywordClassify(outcomeText);
        _lastClassificationFallback = true;
      }
      console.warn('[self-improve] Hook 3: outcome classified as %s via %s', result, _lastClassificationFallback ? 'keyword-fallback' : 'llm');
      const succeeded = result === 'success';
      const failed = result === 'failure';

      if (succeeded && !failed) {
        // Boost intent and action confidence — evidence of correctness
        db.prepare('UPDATE observations SET confidence = MIN(confidence + 3, 100) WHERE id = ?').run(intent.id);
        db.prepare('UPDATE observations SET confidence = MIN(confidence + 5, 100) WHERE id = ?').run(action.id);
      } else if (failed) {
        // Downgrade confidence — strategy didn't work
        db.prepare('UPDATE observations SET confidence = MAX(confidence - 10, 10) WHERE id = ?').run(action.id);
        if (intent.confidence > 50) {
          db.prepare('UPDATE observations SET confidence = MAX(confidence - 5, 10) WHERE id = ?').run(intent.id);
        }
      }
    }
  });

  // Hook 4: Periodically check for conflicts (every ~30 saves per project, approximate)
  hooks.registerHook('post_save', async (obs, ctx, db) => {
    if (!obs.project_path) return;
    const count = (_projectSaveCounts.get(obs.project_path) || 0) + 1;
    _projectSaveCounts.set(obs.project_path, count);
    // Clean up old entries periodically
    if (_projectSaveCounts.size > MAX_SAVE_COUNTS) {
      const keys = [..._projectSaveCounts.keys()];
      for (const k of keys.slice(0, 20)) _projectSaveCounts.delete(k);
    }
    if (count % 30 === 0) {
      console.warn('[self-improve] Periodic conflict check for %s (%d saves)...', obs.project_path, count);
      await autoResolveConflicts(db, { project: obs.project_path, limit: 3 });
    }
  });

  console.error('[self-improve] Continuous improvement loop initialized');
}

/**
 * Inject the save function (alternative to initHooks if hooks already set up).
 * @param {Function} saveFn
 */
function setSaveFunction(saveFn) {
  _saveFn = saveFn;
}

/**
 * Reset module-level state (for testing). Clears the analyzed error ID cache
 * and project save counts so fresh DBs with reused row IDs don't get skipped.
 */
function resetState() {
  _analyzedErrorIds.clear();
  _projectSaveCounts.clear();
}

// ─── Exports ──────────────────────────────────────────────────────────

module.exports = {
  classifyOutcome,
  learnFromError,
  autoResolveConflicts,
  verifyLearning,
  initHooks,
  setSaveFunction,
  resetState,
};
