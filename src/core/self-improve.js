/**
 * self-improve.js — Self-improving agentic loop for agentic-cortex.
 *
 * Detects shortcomings (errors, contradictions, gaps), performs root cause
 * analysis via LLM, and generates automatic improvements ("learnings").
 * Operates continuously via the hooks system — no manual invocation needed.
 *
 * Five core operations:
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
 * 4. spawnExperiment — When recurring errors are detected (same tag 3+ times),
 *    creates a structured experiment with hypothesis, isolated variable,
 *    and fixed metric (AutoGTM's single-variable experiment pattern).
 *
 * 5. writeEvalLog — Immutable append-only audit trail for every evaluation
 *    (AutoGTM's results.tsv pattern applied to self-improvement).
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

// Track error tags per project for experiment spawning (recurring error detection)
const _errorTagCounts = new Map();
const EXPERIMENT_SPAWN_THRESHOLD = 3;

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
        // Write immutable eval log entry for crystallize's verification count
        try {
          writeEvalLog(db, {
            project: newObs.project_path || process.cwd(),
            intentId: learning.id,
            intentContent: learning.content,
            outcomeId: newObs.id,
            outcomeContent: (newObs.content || '').slice(0, 500),
            verdict: 'REINFORCE',
            verdictReason: parsed.reason || '',
            confidenceDelta: 5,
          });
        } catch { /* best-effort */ }
      } else if (parsed.verdict === 'CONTRADICT' && learning.confidence < 85) {
        // Only downgrade non-hardened learnings
        db.prepare('UPDATE observations SET confidence = MAX(confidence - 15, 10) WHERE id = ?')
          .run(learning.id);
        // Write immutable eval log entry
        try {
          writeEvalLog(db, {
            project: newObs.project_path || process.cwd(),
            intentId: learning.id,
            intentContent: learning.content,
            outcomeId: newObs.id,
            outcomeContent: (newObs.content || '').slice(0, 500),
            verdict: 'CONTRADICT',
            verdictReason: parsed.reason || '',
            confidenceDelta: -15,
          });
        } catch { /* best-effort */ }
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

      let confidenceDelta = 0;
      if (succeeded && !failed) {
        // Boost intent and action confidence — evidence of correctness
        db.prepare('UPDATE observations SET confidence = MIN(confidence + 3, 100) WHERE id = ?').run(intent.id);
        db.prepare('UPDATE observations SET confidence = MIN(confidence + 5, 100) WHERE id = ?').run(action.id);
        confidenceDelta = 3;
      } else if (failed) {
        // Downgrade confidence — strategy didn't work
        db.prepare('UPDATE observations SET confidence = MAX(confidence - 10, 10) WHERE id = ?').run(action.id);
        if (intent.confidence > 50) {
          db.prepare('UPDATE observations SET confidence = MAX(confidence - 5, 10) WHERE id = ?').run(intent.id);
        }
        confidenceDelta = -10;
      }

      // ── Pattern 3: Append-only immutable evaluation log (AutoGTM's results.tsv) ──
      try {
        writeEvalLog(db, {
          project: obs.project_path,
          intentId: intent.id,
          intentContent: intent.content,
          actionId: action.id,
          actionContent: action.content,
          outcomeId: obs.id,
          outcomeContent: outcomeText,
          verdict: result.toUpperCase(),
          confidenceDelta,
        });
      } catch { /* best-effort */ }
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

  // Hook 5: Recurring error detection → Auto-spawn experiments (AutoGTM's hypothesis testing)
  hooks.registerHook('post_save', async (obs, ctx, db) => {
    if (obs.type !== 'error' || !obs.project_path || !obs.tags) return;
    try {
      const tags = Array.isArray(obs.tags) ? obs.tags : JSON.parse(obs.tags || '[]');
      for (const tag of tags) {
        if (tag === 'auto-capture' || tag === 'error-report' || tag === 'rca') continue;
        const key = obs.project_path + '::' + tag;
        const count = (_errorTagCounts.get(key) || 0) + 1;
        _errorTagCounts.set(key, count);
        // Prune periodically
        if (_errorTagCounts.size > 200) {
          const keys = [..._errorTagCounts.keys()];
          for (const k of keys.slice(0, 50)) _errorTagCounts.delete(k);
        }
        if (count === EXPERIMENT_SPAWN_THRESHOLD) {
          console.warn('[self-improve] Recurring error tag "%s" detected (%d times), spawning experiment...', tag, count);
          await spawnExperiment(db, { project: obs.project_path, errorTag: tag });
        }
      }
    } catch { /* best-effort */ }
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
  _verifiedRecently.clear();
}

// ─── 5. Experiment Spawning (AutoGTM's Hypothesis Testing) ──────────

/**
 * Spawn a structured experiment when recurring errors are detected.
 *
 * AutoGTM pattern: isolated single-variable hypothesis testing.
 * When errors with the same tag appear 3+ times, this creates an
 * experiment observation with:
 *   - hypothesis: What we think the fix is
 *   - variable_changed: The ONE thing we're changing
 *   - fixed_metric: The constant ruler to measure against
 *   - before_state: Current failing state
 *
 * The agent is expected to report back via recordAction() with the
 * experiment as the intent, so Hook 3 can evaluate the outcome.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} opts
 * @param {string} opts.project - Project path
 * @param {string} opts.errorTag - The recurring error tag
 * @returns {Promise<Object|null>} Created experiment observation or null
 */
async function spawnExperiment(db, opts = {}) {
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const errorTag = opts.errorTag || 'unknown';

  // Find recent errors with this tag
  const recentErrors = db.prepare(
    "SELECT id, title, content, tags FROM observations WHERE project_path = ? AND type = 'error' AND is_active = 1 AND tags LIKE ? ORDER BY created_at DESC LIMIT 3"
  ).all(project, '%' + errorTag + '%');

  if (recentErrors.length < 2) return null;

  // Check if we already spawned an experiment for this tag recently
  const existing = db.prepare(
    "SELECT id FROM observations WHERE project_path = ? AND type = 'experiment' AND is_active = 1 AND tags LIKE ? AND created_at > datetime('now', '-7 days')"
  ).get(project, '%' + errorTag + '%');
  if (existing) return null;

  // Generate experiment via LLM
  const prompt = `You are designing a controlled experiment to fix a recurring error. Follow the scientific method: change ONE variable at a time, measure against a fixed metric.

Recurring error tag: "${errorTag}"

Recent occurrences:
${recentErrors.map((e, i) => `${i + 1}. ${e.title || 'Error'}: ${e.content.slice(0, 300)}`).join('\n\n')}

Return JSON:
- hypothesis: What you believe will fix this (max 200 chars)
- variable_changed: The ONE thing to change (max 100 chars)
- fixed_metric: The constant metric to measure success against (e.g., "build success", "test passes", "no TypeError")
- before_state: Current failing behavior (max 200 chars)
- expected_after: What success looks like (max 200 chars)`;

  let experiment;
  try {
    const result = await callLLM([
      { role: 'system', content: 'You design controlled software engineering experiments. Respond ONLY with valid JSON.' },
      { role: 'user', content: prompt },
    ], { temperature: 0.2, maxTokens: 800, timeout: 30000 });
    experiment = JSON.parse(result || '{}');
  } catch {
    experiment = {
      hypothesis: 'Change the approach to fix recurring ' + errorTag,
      variable_changed: 'approach',
      fixed_metric: 'error resolution',
      before_state: recentErrors[0]?.content?.slice(0, 200) || 'Recurring error',
      expected_after: 'Error no longer occurs',
    };
  }

  if (!_saveFn) return null;

  const experimentObs = await _saveFn({
    project,
    type: 'experiment',
    title: 'Experiment: ' + (experiment.hypothesis || 'Fix ' + errorTag).slice(0, 80),
    content: `## Hypothesis\n${experiment.hypothesis || 'N/A'}\n\n## Variable Changed\n${experiment.variable_changed || 'N/A'}\n\n## Fixed Metric\n${experiment.fixed_metric || 'N/A'}\n\n## Before State\n${experiment.before_state || 'N/A'}\n\n## Expected After\n${experiment.expected_after || 'N/A'}`,
    tags: [errorTag, 'experiment', 'auto-spawned', 'hypothesis-test'],
    confidence: 70,
    importance: 8,
    provenance: 'inferred',
    steps: [
      '1. Apply the variable change described in the hypothesis',
      '2. Test against the fixed metric',
      '3. Report outcome via recordAction (intent=this experiment, action=what you did, outcome=result)',
    ],
    triggers: [errorTag],
  });

  if (experimentObs && experimentObs.id) {
    // Link errors to experiment
    for (const e of recentErrors) {
      try {
        await addRelation(db, { sourceId: experimentObs.id, targetId: e.id, relationType: 'derives_from', confidence: 85 });
      } catch {}
    }
  }

  console.warn('[self-improve] Experiment spawned for tag "%s": #%d', errorTag, experimentObs?.id);
  return experimentObs;
}

// ─── 6. Immutable Evaluation Log (AutoGTM's results.tsv) ─────────────

/**
 * Write an immutable row to the evaluation_log table.
 * This is AutoGTM's append-only results.tsv pattern — every evaluation
 * is preserved forever for auditing, benchmarking, and plateau detection.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} entry
 * @param {string} entry.project - Project path
 * @param {number} [entry.intentId] - Intent observation ID
 * @param {string} [entry.intentContent] - Intent text (truncated)
 * @param {number} [entry.actionId] - Action observation ID
 * @param {string} [entry.actionContent] - Action text (truncated)
 * @param {number} [entry.outcomeId] - Outcome observation ID
 * @param {string} [entry.outcomeContent] - Outcome text (truncated)
 * @param {string} entry.verdict - SUCCESS, FAILURE, NEUTRAL, REINFORCE, CONTRADICT
 * @param {string} [entry.verdictReason] - Reason for verdict
 * @param {number} [entry.confidenceDelta] - Confidence delta applied
 * @param {string} [entry.variableChanged] - What variable was changed (for experiments)
 */
function writeEvalLog(db, entry) {
  db.prepare(
    'INSERT INTO evaluation_log (project_path, intent_id, intent_content, action_id, action_content, outcome_id, outcome_content, llm_verdict, verdict_reason, confidence_delta, variable_changed) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    entry.project || process.cwd(),
    entry.intentId || null,
    (entry.intentContent || '').slice(0, 500),
    entry.actionId || null,
    (entry.actionContent || '').slice(0, 500),
    entry.outcomeId || null,
    (entry.outcomeContent || '').slice(0, 500),
    entry.verdict || 'UNKNOWN',
    (entry.verdictReason || '').slice(0, 300) || null,
    entry.confidenceDelta || 0,
    (entry.variableChanged || '').slice(0, 200) || null,
  );
}

/**
 * Query the evaluation log with optional filters.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} [opts]
 * @param {string} [opts.project] - Project path
 * @param {string} [opts.verdict] - Filter by verdict
 * @param {number} [opts.limit=50] - Max rows
 * @returns {Array<Object>}
 */
function getEvaluationLog(db, opts = {}) {
  const project = opts.project || null;
  const verdict = opts.verdict || null;
  const limit = opts.limit || 50;

  let sql = 'SELECT * FROM evaluation_log WHERE 1=1';
  const params = [];
  if (project) { sql += ' AND project_path = ?'; params.push(project); }
  if (verdict) { sql += ' AND llm_verdict = ?'; params.push(verdict); }
  sql += ' ORDER BY evaluated_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

/**
 * Get evaluation log summary stats for a project.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @returns {{total: number, successRate: number, avgConfidenceDelta: number, recentVerdicts: Array}}
 */
function getEvalLogStats(db, project) {
  const total = db.prepare('SELECT COUNT(*) as c FROM evaluation_log WHERE project_path = ?').get(project).c;
  if (total === 0) return { total: 0, successRate: 0, avgConfidenceDelta: 0, recentVerdicts: [] };

  const successCount = db.prepare("SELECT COUNT(*) as c FROM evaluation_log WHERE project_path = ? AND llm_verdict = 'SUCCESS'").get(project).c;
  const avgDelta = db.prepare('SELECT AVG(confidence_delta) as avg FROM evaluation_log WHERE project_path = ?').get(project).avg || 0;
  const recent = db.prepare('SELECT llm_verdict, confidence_delta, evaluated_at FROM evaluation_log WHERE project_path = ? ORDER BY evaluated_at DESC LIMIT 10').all(project);

  return {
    total,
    successRate: Math.round((successCount / total) * 10000) / 100,
    avgConfidenceDelta: Math.round(avgDelta * 100) / 100,
    recentVerdicts: recent,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────

module.exports = {
  classifyOutcome,
  learnFromError,
  autoResolveConflicts,
  verifyLearning,
  spawnExperiment,
  writeEvalLog,
  getEvaluationLog,
  getEvalLogStats,
  initHooks,
  setSaveFunction,
  resetState,
};
