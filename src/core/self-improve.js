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
const conflict = require('./conflict');
const { checkConflicts } = conflict;
const { addRelation } = require('./relations');
const hooks = require('./hooks');
const recovery = require('./recovery');

// Lazy-loaded prompt registry (Layer 1: Prompt Engineering)
let _prompts = null;
function _getPrompts() {
  if (!_prompts) _prompts = require('./prompts');
  return _prompts;
}

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
  const successIndicators = ['pass', 'passed', 'success', 'succeeded', 'successful', 'ok', 'completed', 'works', 'fixed', 'resolved', 'done', 'created', 'updated', 'implemented', 'verified'];
  const failureIndicators = ['fail', 'failed', 'error', 'errors', 'crash', 'broke', 'broken', 'rejected', 'timeout', 'rollback', 'revert'];

  // Word-boundary match so "failures"/"past-failure" don't trip on "fail",
  // and "errors" in a success sentence isn't silently missed.
  const matches = (word) => new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(text);
  const succeeded = successIndicators.some(matches);
  const failed = failureIndicators.some(matches);

  if (succeeded && !failed) return 'success';
  if (failed) return 'failure';
  return 'neutral';
}

/**
 * Classify an outcome text as success, failure, or neutral using an LLM.
 * Falls back to keyword-based classification if the LLM is unavailable or
 * returns invalid output.
 *
 * When a database handle is supplied, results (including the keyword fallback)
 * are absorbed into the LLM negative cache, so identical outcome text
 * resolves deterministically without re-invoking the LLM.
 *
 * @param {string} outcomeText - The outcome content to classify
 * @param {import('better-sqlite3').Database} [db] - Optional DB for deterministic LLM caching
 * @returns {Promise<'success'|'failure'|'neutral'>} Classification result
 */
async function classifyOutcome(outcomeText, db) {
  _lastClassificationFallback = false;

  // Deterministic negative cache: identical input resolves without an LLM call.
  if (db) {
    const cached = recovery.getCachedLLM(db, 'classify-outcome', outcomeText);
    if (cached) {
      if (cached.status === 'fallback') _lastClassificationFallback = true;
      return cached.result;
    }
  }

  try {
    const tpl = _getPrompts().buildMessages('classify-outcome', {
      outcomeText: (outcomeText || '').slice(0, 500),
    });
    const result = await callLLM(tpl ? tpl.messages : [
      { role: 'system', content: 'You classify outcomes. Respond ONLY with valid JSON: {"outcome":"success|failure|neutral","reason":"brief reason"}' },
      { role: 'user', content: `Classify this outcome: "${(outcomeText || '').slice(0, 500)}"` },
    ], tpl ? tpl.defaults : { temperature: 0, maxTokens: 80, timeout: 8000 });

    const parsed = JSON.parse(result || '{}');
    if (['success', 'failure', 'neutral'].includes(parsed.outcome)) {
      if (db) recovery.cacheLLM(db, 'classify-outcome', outcomeText, parsed.outcome, 'ok');
      return parsed.outcome;
    }
  } catch {
    // LLM unavailable or parse failed — fall through to keyword fallback
  }

  _lastClassificationFallback = true;
  const fallback = _keywordClassify(outcomeText);
  if (db) recovery.cacheLLM(db, 'classify-outcome', outcomeText, fallback, 'fallback');
  return fallback;
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

  try {
    // LLM-learned fallback loop: absorb the RCA pass into the deterministic
    // cache so identical error content reuses the same analysis forever after
    // (including the negative/fallback outcome when the LLM fails).
    let parsed = null;
    const cached = recovery.getCachedLLM(db, 'rca-from-error', errorObs.content);
    if (cached) {
      parsed = cached.result;
    } else {
      try {
        const tpl = _getPrompts().buildMessages('rca-from-error', {
          errorContent: errorObs.content,
        });
        const result = await callLLM(
          tpl ? tpl.messages : [
            { role: 'system', content: 'You are a root cause analysis agent for coding workflows. Respond ONLY with valid JSON.' },
            { role: 'user', content: `Analyze this error: "${errorObs.content}". Return JSON: {title, content, confidence, tags}` },
          ],
          tpl ? tpl.defaults : { temperature: 0.2, maxTokens: 800, timeout: 60000 },
        );
        parsed = JSON.parse(result || '{}');
      } catch {
        parsed = null;
      }
      // Negative cache: remember the outcome (including null on LLM failure).
      recovery.cacheLLM(db, 'rca-from-error', errorObs.content, parsed, parsed ? 'ok' : 'fallback');
    }

    if (parsed && parsed.title && parsed.content) {
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
 *
 * Utopia-aligned: delegates to the conflict module's batched, cached,
 * outcome-classified detection + Dempster-Shafer resolution engine.
 * No more single-LLM-per-pair bypass.
 *
 * Uses the conflict module's new knobs:
 *   - confidenceFloor: skip low-confidence noise
 *   - batchSize: batch LLM contradiction verification
 *   - threshold: tunable similarity threshold
 *   - autoResolve: run DS resolution on genuine contradictions
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} opts
 * @param {string} [opts.project] - Project path
 * @param {number} [opts.limit=5] - Max conflicts to resolve
 * @param {number} [opts.confidenceFloor] - Minimum confidence for detection (default: conflict.DEFAULT_CONFIDENCE_FLOOR)
 * @param {number} [opts.batchSize] - Pairs per LLM batch (default: conflict.DEFAULT_BATCH_SIZE)
 * @param {number} [opts.threshold] - Similarity threshold (default: conflict.DEFAULT_SIMILARITY_THRESHOLD)
 * @returns {Promise<{resolved: number, conflictsFound: number, open: number, inconclusive: number, consolidate: number}>}
 */
async function autoResolveConflicts(db, opts = {}) {
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const limit = opts.limit || 5;
  const confidenceFloor = opts.confidenceFloor != null ? opts.confidenceFloor : conflict.DEFAULT_CONFIDENCE_FLOOR;
  const batchSize = opts.batchSize != null ? opts.batchSize : conflict.DEFAULT_BATCH_SIZE;
  const threshold = opts.threshold != null ? opts.threshold : conflict.DEFAULT_SIMILARITY_THRESHOLD;

  let conflictResult;
  try {
    // Use the new conflict module: cached detection, batched LLM verification,
    // DS resolution, and outcome classification (open/consolidate/resolved/undecidable).
    conflictResult = await checkConflicts(db, {
      project,
      limit,
      autoResolve: true,
      confidenceFloor,
      batchSize,
      threshold,
    });
  } catch (e) {
    console.warn('[self-improve] Conflict detection failed:', e.message);
    return { resolved: 0, conflictsFound: 0, open: 0, inconclusive: 0, consolidate: 0 };
  }

  const conflicts = conflictResult.conflicts || [];
  let resolved = 0;
  let open = 0;
  let inconclusive = 0;
  let consolidate = 0;

  for (const c of conflicts) {
    // Count outcomes for observability
    if (c.outcome === 'open') { open++; continue; } // keep both — don't force a winner
    if (c.outcome === 'inconclusive') { inconclusive++; continue; } // LLM unavailable — skip
    if (c.outcome === 'consolidate') {
      // Same topic, different details — candidate for consolidation.
      // The resolution module already handled this if autoResolve ran.
      // If no resolution was created (e.g. LLM said not a contradiction),
      // the pair is flagged for the next reflection cycle.
      consolidate++;
      continue;
    }
    if (c.outcome === 'resolved' || c.outcome === 'undecidable') {
      // DS resolution already ran and persisted the resolution record,
      // archived the loser, and boosted the winner's confidence.
      // No need to re-adjudicate with a separate LLM call — that's the Utopia
      // improvement over the fresh-uncached winner-takes-LLM baseline.
      if (c.outcome === 'resolved') resolved++;
      continue;
    }
    // Legacy path: llm_contradiction=true but no outcome set (pre-Utopia conflicts)
    if (c.llm_contradiction) {
      try {
        const resolution = require('./resolution');
        const fullA = db.prepare('SELECT * FROM observations WHERE id = ?').get(c.a.id);
        const fullB = db.prepare('SELECT * FROM observations WHERE id = ?').get(c.b.id);
        if (fullA && fullB) {
          const corr = resolution.computeCorroboration(db, project);
          const res = await resolution.resolveConflict(db, {
            project,
            a: fullA,
            b: fullB,
            corroboration: corr,
            resolutionType: 'adjudicated',
          });
          if (res.status === 'resolved') {
            resolved++;
            // Emit a learning from the resolution (if save fn available)
            if (_saveFn && res.reason) {
              await _saveFn({
                project,
                type: 'learning',
                title: 'Conflict resolved via evidence adjudication: ' + (res.reason || 'Knowledge reconciliation').slice(0, 60),
                content: res.reason + '\n\nWinner: ' + (fullA.title || fullA.id) + ' (combined belief: ' + res.combinedBelief + ', conflict coefficient k: ' + res.conflictCoefficient + ')',
                tags: ['conflict-resolution', 'auto-correction', 'evidence-adjudicated'],
                confidence: Math.round(res.combinedBelief * 100),
                importance: 7,
                provenance: 'inferred',
              });
            }
          }
        }
      } catch (e) {
        console.warn('[self-improve] DS resolution failed for conflict #' + c.a.id + ':', e.message);
      }
    }
  }

  if (resolved > 0 || open > 0 || inconclusive > 0 || consolidate > 0) {
    console.warn('[self-improve] Conflict check: %d resolved, %d open (keep-both), %d inconclusive, %d consolidate, %d total candidates',
      resolved, open, inconclusive, consolidate, conflicts.length);
  }

  return { resolved, conflictsFound: conflicts.length, open, inconclusive, consolidate };
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
      // Deterministic verification cache: same learning + same evidence → same verdict.
      const cacheInput = JSON.stringify({
        learning: learning.content.slice(0, 200),
        obsType: newObs.type,
        obsTitle: newObs.title || '',
        obsContent: (newObs.content || '').slice(0, 200),
      });
      let parsed;
      const cached = recovery.getCachedLLM(db, 'verify-learning', cacheInput);
      if (cached) {
        parsed = cached.result;
      } else {
        const tpl = _getPrompts().buildMessages('verify-learning', {
          learningTitle: learning.title,
          learningContent: learning.content.slice(0, 200),
          obsType: newObs.type,
          obsTitle: newObs.title || '',
          obsContent: (newObs.content || '').slice(0, 200),
        });
        const result = await callLLM(
          tpl ? tpl.messages : [
            { role: 'system', content: 'You verify knowledge against new evidence. Respond ONLY with valid JSON.' },
            { role: 'user', content: `Learning: "${learning.title}". New obs: "${newObs.title}". CONTRADICT/REINFORCE/NEUTRAL?` },
          ],
          tpl ? tpl.defaults : { temperature: 0.1, maxTokens: 200, timeout: 15000 },
        );
        parsed = JSON.parse(result || '{}');
        // Only cache meaningful verdicts; failures stay best-effort.
        if (parsed && parsed.verdict) recovery.cacheLLM(db, 'verify-learning', cacheInput, parsed, 'ok');
      }

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

  // Hook 1: When an error is saved, trigger RCA + seed the recovery layer
  hooks.registerHook('post_save', async (obs, ctx, db) => {
    if (obs.type === 'error') {
      console.warn('[self-improve] Error detected (#%d), running RCA...', obs.id);
      await learnFromError(db, obs);
      // Tier 1: probe-gated retry classification + counter-evidence seeding
      try {
        recovery.recordFailure(db, { project: obs.project_path, errorId: obs.id, errorText: obs.content });
        recovery.registerFailure(db, { project: obs.project_path, errorObs: obs });
      } catch { /* best-effort */ }
    }
  });

  // Hook 1b: When a success is saved, apply counter-evidence decay to prior failures
  hooks.registerHook('post_save', async (obs, ctx, db) => {
    if (obs.type !== 'success' || !obs.project_path) return;
    try {
      const cleared = recovery.applyCounterEvidence(db, { project: obs.project_path, successObs: obs });
      if (cleared.length) {
        console.warn('[recovery] Counter-evidence decay: %d error lesson(s) cleared', cleared.filter(r => r.deleted).length);
      }
    } catch { /* best-effort */ }
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
      // Find the intent that led to this action.
      // Accept intents typed 'action' (legacy) OR 'goal' (semantic intent).
      const intent = db.prepare(
        `SELECT i.id, i.title, i.content, i.confidence
         FROM observations i
         JOIN memory_relations r ON r.source_id = i.id
         WHERE r.target_id = ? AND r.relation_type = 'achieves' AND i.type IN ('action', 'goal')`
      ).get(action.id);

      if (!intent) continue;

      // Compare outcome to intent using LLM classifier (with keyword fallback)
      const outcomeText = obs.content || '';
      let result;
      try {
        result = await classifyOutcome(outcomeText, db);
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
          verdict: result === 'success' ? 'SUCCESS' : result === 'failure' ? 'FAILURE' : 'NEUTRAL',
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

  // Hook 6: Plateau detection — check eval log for stalled improvement (Layer 4: Loop Engineering)
  // Runs on every 50th save to avoid expensive eval log queries on every write
  hooks.registerHook('post_save', async (obs, ctx, db) => {
    if (!obs.project_path) return;
    const count = (_projectSaveCounts.get(obs.project_path) || 0);
    // Check every 50 saves (already tracked in Hook 4)
    if (count % 50 === 0 && count > 0) {
      _prunePlateauCache();
      try {
        const result = await detectPlateau(db, { project: obs.project_path });
        if (result.plateau) {
          console.warn(`[self-improve] ⚠️ Plateau detected for ${obs.project_path}: %.1f%% → %.1f%% (Δ%+.1f%%) over ${Math.round(result.windowSpanDays)} days (${result.totalEvalCount} evals)`,
            result.previousRate * 100, result.currentRate * 100, result.improvementPct * 100);
        }
      } catch { /* best-effort */ }
    }
  });

  console.error('[self-improve] Continuous improvement loop initialized (8 hooks: Error RCA, Counter-evidence decay, Learning verify, Outcome tracking, Conflict check, Experiment spawn, Plateau detect)');
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
  _lastPlateauCheck.clear();
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
  const recentErrorsText = recentErrors.map((e, i) => `${i + 1}. ${e.title || 'Error'}: ${e.content.slice(0, 300)}`).join('\n\n');
  let experiment;
  try {
    const tpl = _getPrompts().buildMessages('design-experiment', {
      errorTag,
      recentErrors: recentErrorsText,
    });
    const result = await callLLM(
      tpl ? tpl.messages : [
        { role: 'system', content: 'You design controlled software engineering experiments. Respond ONLY with valid JSON.' },
        { role: 'user', content: `Design experiment for recurring error "${errorTag}". Recent: ${recentErrorsText}` },
      ],
      tpl ? tpl.defaults : { temperature: 0.2, maxTokens: 800, timeout: 30000 },
    );
    experiment = JSON.parse(result || '{}');
    // If LLM returned empty or invalid, use fallback
    // If LLM returned empty or invalid, use fallback.    // NOTE: if LLM returned valid JSON but none of the expected fields,
    // we still consider it usable if it has at least one structural field.
    // The fallback covers cases where ALL fields are missing.
    if (!experiment || (!experiment.hypothesis && !experiment.title && !experiment.variable_changed && !experiment.fixed_metric && !experiment.before_state && !experiment.expected_after)) {
      experiment = null;
    }
    // If experiment still null but we got a valid JSON response, use whatever
    // fields were present as the experiment content.
    if (!experiment && result && typeof result === 'object') {
      experiment = {
        hypothesis: result.hypothesis || result.title || 'Investigate recurring ' + errorTag,
        variable_changed: result.variable_changed || result.variable || 'approach',
        fixed_metric: result.fixed_metric || result.metric || 'error resolution',
        before_state: result.before_state || result.before || recentErrors[0]?.content?.slice(0, 200) || 'Recurring error',
        expected_after: result.expected_after || result.expected || 'Error no longer occurs',
      };
    }
  } catch {
    experiment = null;
  }
  if (!experiment) {
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
 * @param {number[]} [entry.injectedObservationIds] - Observation IDs that were
 *   injected into this run's context. Recorded in eval_memory_injections so
 *   outcome-weighted retrieval can correlate verdicts with injected memories.
 * @returns {number} The new evaluation_log row id
 */
function writeEvalLog(db, entry) {
  const r = db.prepare(
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
  const evalLogId = Number(r.lastInsertRowid);
  if (entry.injectedObservationIds && entry.injectedObservationIds.length > 0) {
    recordEvalInjections(db, evalLogId, entry.injectedObservationIds, { project: entry.project });
  } else {
    // No manual wiring: attribute the observations search() returned for this
    // project recently — the eval run's context was built from them.
    autoLinkEvalInjections(db, evalLogId, entry.project, { windowMinutes: entry.autoLinkWindowMinutes });
  }
  return evalLogId;
}

/**
 * Record which observations search() returned for a project, marking them
 * as pending attribution to the eval run that consumed them. Each
 * (scope_key, project, observation) triple is stored once; re-searching
 * refreshes the timestamp. The scope is either the plain time-window scope
 * (agentId omitted, scope_key '') OR an agent/session-attributed scope
 * (`agent:<agentId>`), so a session's searches are attributed to THAT agent's
 * eval instead of racing any later eval in the same time window.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project - Project path the search ran under
 * @param {Array<number>} observationIds - Observation ids search() returned
 * @param {Object} [opts] - { agentId? }
 * @returns {{ tracked: number }}
 */
function recordSearchInjections(db, project, observationIds, opts = {}) {
  const agentId = opts.agentId || null;
  const scopeKey = agentId ? 'agent:' + agentId : '';
  const upsert = db.prepare(
    'INSERT INTO pending_eval_injections (project_path, observation_id, scope_key, agent_id, searched_at) VALUES (?, ?, ?, ?, datetime(\'now\')) ' +
    'ON CONFLICT(scope_key, project_path, observation_id) DO UPDATE SET searched_at = datetime(\'now\')'
  );
  let tracked = 0;
  for (const id of (observationIds || [])) {
    const n = Number(id);
    if (!n) continue;
    upsert.run(project || process.cwd(), n, scopeKey, agentId);
    tracked++;
  }
  return { tracked };
}

/**
 * Pale of both scopes into a WHERE fragment. Shared by autoLinkEvalInjections
 * (time-window scope, no agent) and linkAgentSessionInjections.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} evalLogId - evaluation_log row id
 * @param {string[]} observationIds - ids to link
 * @param {string} project - project for the injection rows
 * @param {Object} [opts] - { scopeKey? } extra filter (ANDed) for the pending
 *   DELETE, so only the matching scope's rows are consumed.
 * @returns {{ linked: number }}
 */
function _linkAndConsume(db, evalLogId, observationIds, project, opts = {}) {
  const source = opts.source || 'auto';
  const linked = recordEvalInjections(db, evalLogId, observationIds, { project, source }).linked;
  if (observationIds.length > 0) {
    let sql = 'DELETE FROM pending_eval_injections WHERE observation_id IN (' +
      observationIds.map(() => '?').join(',') + ')';
    const params = [...observationIds];
    if (opts.scopeKey != null) { sql += ' AND scope_key = ?'; params.push(opts.scopeKey); }
    db.prepare(sql).run(...params);
  }
  return { linked };
}

/**
 * Link pending search-returned observations to an eval run and consume them.
 * Only rows searched within `windowMinutes` (default 60) of the eval count,
 * so a stale pending row from an unrelated earlier search is never wrongly
 * attributed. Consumed rows are deleted — one eval per search batch.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} evalLogId - evaluation_log row id
 * @param {string} [project] - Project path; defaults to cwd
 * @param {Object} [opts] - { windowMinutes? }
 * @returns {{ linked: number }}
 */
function autoLinkEvalInjections(db, evalLogId, project, opts = {}) {
  const windowMinutes = opts.windowMinutes == null ? 60 : opts.windowMinutes;
  const proj = project || process.cwd();
  const pending = db.prepare(
    `SELECT observation_id FROM pending_eval_injections
     WHERE project_path = ? AND scope_key = '' AND searched_at >= datetime('now', ?)`
  ).all(proj, '-' + windowMinutes + ' minutes');
  if (pending.length === 0) return { linked: 0 };
  return _linkAndConsume(db, evalLogId, pending.map(p => p.observation_id), proj, { scopeKey: '', source: 'auto' });
}

/**
 * Session-scoped attribution: link the observations an agent searched while
 * its session was active to the eval the agent writes at end of session.
 * Only rows scoped to this agent are touched — another agent's searches (or
 * unattributed time-window searches) are left alone. This replaces the time
 * window as the attribution boundary: whatever THIS agent searched during its
 * session is attributed to THIS agent's eval, with no race against unrelated
 * evals or same-window searches from other agents.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} evalLogId - evaluation_log row id
 * @param {string} agentId - agent whose session is ending
 * @param {string|number} sessionId - session identifier (for provenance)
 * @param {string} [project] - project; defaults to cwd. When omitted, all of
 *   the agent's pending rows across projects are linked.
 * @returns {{ linked: number, sessionId: string|number }}
 */
function linkAgentSessionInjections(db, evalLogId, agentId, sessionId, project = null) {
  const scopeKey = 'agent:' + agentId;
  const params = [scopeKey];
  let sql = `SELECT observation_id FROM pending_eval_injections WHERE scope_key = ?`;
  if (project) { sql += ' AND project_path = ?'; params.push(project); }
  const pending = db.prepare(sql).all(...params);
  if (pending.length === 0) return { linked: 0, sessionId };
  const ids = pending.map(p => p.observation_id);
  const r = _linkAndConsume(db, evalLogId, ids, project || process.cwd(), { scopeKey, source: 'session' });
  r.sessionId = sessionId;
  return r;
}

/**
 * Record which observations were injected into an eval run. Each pair
 * (eval_log_id, observation_id) is stored once — the correlation source for
 * outcome-weighted retrieval.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} evalLogId - evaluation_log row id
 * @param {Array<number>} observationIds - Injected observation ids
 * @param {Object} [opts] - { project? }
 * @returns {{ linked: number }}
 */
function recordEvalInjections(db, evalLogId, observationIds, opts = {}) {
  const project = opts.project || process.cwd();
  // Provenance: 'manual' (explicit ids), 'auto' (time-window link), or
  // 'session' (endAgentSession attribution).
  const source = opts.source || 'manual';
  const ins = db.prepare(
    'INSERT OR IGNORE INTO eval_memory_injections (eval_log_id, observation_id, project_path, source) VALUES (?, ?, ?, ?)'
  );
  let linked = 0;
  for (const id of (observationIds || [])) {
    const n = Number(id);
    if (!n) continue;
    ins.run(Number(evalLogId), n, project, source);
    linked++;
  }
  return { linked };
}

/**
 * Outcome history per injected memory: how often each observation was part
 * of an eval run, and whether those runs succeeded or failed. Closes the
 * eval-log feedback loop — retrieval can boost memories with a proven-good
 * outcome record and demote proven-bad ones.
 *
 * Verdict polarity: SUCCESS/REINFORCE count as success; FAILURE/CONTRADICT
 * as failure; NEUTRAL contributes to runs but neither side. A memory needs
 * `minRuns` (default 2) recorded runs before its weight is non-zero, so a
 * single unlucky eval never reshapes retrieval.
 *
 * PROVENANCE-AWARE weighting (default on): evidence linked through auto or
 * session attribution is less certain about true causation than manually
 * wired `injectedObservationIds`, so each source contributes to the weight
 * scaled by a confidence multiplier — manual 1.0, session 0.6, auto 0.4.
 * The effective weight is the sum of each source's (success-failure) * m
 * divided by the sum of (runs * m), which keeps the result in [-1, 1] while
 * making auto-attributed memories need more evidence to argue either way.
 * The raw per-source counts are always returned so callers can audit, and
 * `weightSources` breaks the final weight down per source.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} [project]
 * @param {Object} [opts] - { minRuns?, weightBySource? (default true),
 *   sourceWeights? ({ manual, session, auto } multipliers, default above) }
 * @returns {Map<number, { runs, successes, failures, successRate,
 *   weight, bySource: { manual: {runs,successes,failures,weightContribution},
 *   session: {...}, auto: {...} }, weightSources: {manual,session,auto} }>}
 */
function memoryOutcomeStats(db, project, opts = {}) {
  const minRuns = opts.minRuns == null ? 2 : opts.minRuns;
  const weightBySource = opts.weightBySource !== false;
  const sw = Object.assign({ manual: 1, session: 0.6, auto: 0.4 }, opts.sourceWeights || {});

  const rows = db.prepare(`
    SELECT i.observation_id, i.source,
      COUNT(*) as runs,
      SUM(CASE WHEN e.llm_verdict IN ('SUCCESS','REINFORCE') THEN 1 ELSE 0 END) as successes,
      SUM(CASE WHEN e.llm_verdict IN ('FAILURE','CONTRADICT') THEN 1 ELSE 0 END) as failures
    FROM eval_memory_injections i
    JOIN evaluation_log e ON e.id = i.eval_log_id
    ${project ? 'WHERE i.project_path = ?' : ''}
    GROUP BY i.observation_id, i.source
  `).all(...(project ? [project] : []));

  // Aggregate per observation across sources.
  const agg = new Map();
  for (const r of rows) {
    const key = r.observation_id;
    if (!agg.has(key)) agg.set(key, { bySource: { manual: { runs: 0, successes: 0, failures: 0 }, session: { runs: 0, successes: 0, failures: 0 }, auto: { runs: 0, successes: 0, failures: 0 } } });
    const a = agg.get(key);
    const src = a.bySource[r.source] || (a.bySource[r.source] = { runs: 0, successes: 0, failures: 0 });
    src.runs += r.runs || 0;
    src.successes += r.successes || 0;
    src.failures += r.failures || 0;
  }

  const stats = new Map();
  for (const [observationId, a] of agg) {
    let runs = 0, successes = 0, failures = 0;
    let wNum = 0, wDen = 0;
    const weightSources = { manual: 0, session: 0, auto: 0 };
    const bySource = {};
    for (const src of ['manual', 'session', 'auto']) {
      const s = a.bySource[src];
      if (!s || s.runs === 0) continue;
      runs += s.runs;
      successes += s.successes;
      failures += s.failures;
      const m = src === 'manual' ? sw.manual : (src === 'session' ? sw.session : sw.auto);
      const net = (s.successes - s.failures) * m;
      const den = s.runs * m;
      wNum += net;
      wDen += den;
      weightSources[src] = net / den; // per-source weight in [-1, 1]
      bySource[src] = { ...s, weightContribution: Math.round(m * 1000) / 1000 };
    }
    const successRate = runs > 0 ? Math.round((successes / runs) * 1000) / 1000 : null;
    // Effective weight: weighted net over weighted runs (each source's runs
    // scaled by its confidence multiplier), clamped to [-1, 1] naturally since
    // |wNum| <= wDen. When down-weighting is disabled, fall back to the plain
    // ratio so legacy behavior is preserved exactly.
    let weight;
    if (runs === 0) {
      weight = 0;
    } else if (!weightBySource) {
      weight = runs >= minRuns ? Math.round(((successes - failures) / runs) * 1000) / 1000 : 0;
    } else {
      weight = runs >= minRuns ? Math.round((wDen > 0 ? (wNum / wDen) : 0) * 1000) / 1000 : 0;
    }
    stats.set(observationId, {
      runs, successes, failures, successRate, weight,
      bySource,
      weightSources,
    });
  }
  return stats;
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

  // Provenance counts per eval: how many fitted observations, broken down by
  // link source. Distinct + they fuel the audit flag below.
  const injSql =
    'SELECT eval_log_id, source, COUNT(*) as cnt ' +
    'FROM eval_memory_injections WHERE eval_log_id IN (' +
    'SELECT id FROM evaluation_log WHERE 1=1' +
    (project ? ' AND project_path = ?' : '') +
    (verdict ? ' AND llm_verdict = ?' : '') +
    ')' +
    'GROUP BY eval_log_id, source';
  const isqlParams = [];
  if (project) isqlParams.push(project);
  if (verdict) isqlParams.push(verdict);
  const injRows = db.prepare(injSql).all(...isqlParams);
  const provenance = new Map(); // eval_log_id -> {auto, session, manual, total}
  for (const row of injRows) {
    const key = row.eval_log_id;
    if (!provenance.has(key)) provenance.set(key, { auto: 0, session: 0, manual: 0, total: 0 });
    const p = provenance.get(key);
    p[row.source] = (p[row.source] || 0) + row.cnt;
    p.total += row.cnt;
  }

  sql += ' ORDER BY evaluated_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params).map(row => {
    const p = provenance.get(row.id) || { auto: 0, session: 0, manual: 0, total: 0 };
    return {
      ...row,
      injected: p.total,
      injectedSources: { manual: p.manual, auto: p.auto, session: p.session },
      // Auto-attributed = linked via search (time-window or session) rather
      // than manually wired injectedObservationIds.
      autoAttributed: p.total > 0 && p.manual === 0,
      clearlyAuto: p.auto > 0,
      viaSession: p.session > 0,
      linkProvenance: p.total === 0 ? 'none' : (p.manual > 0 ? 'manual' : (p.session > 0 ? 'session' : 'auto')),
    };
  });
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

// ─── 7. Plateau Detection (Layer 4: Loop Engineering) ───────────────

/**
 * Default number of days to look back for plateau detection.
 * @type {number}
 */
const PLATEAU_WINDOW_DAYS = 7;

/**
 * Minimum number of evaluations required before checking for plateau.
 * @type {number}
 */
const PLATEAU_MIN_EVALS = 10;

/**
 * Maximum improvement in success rate over the window to consider it "stalled."
 * @type {number}
 */
const PLATEAU_MAX_IMPROVEMENT_PCT = 2;

// Track the last plateau check per project to avoid checking too frequently
const _lastPlateauCheck = new Map();
const PLATEAU_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // Check at most every 6 hours

/**
 * Detect whether improvement has plateaued (stalled) for a project.
 *
 * Examines the evaluation_log: if success rate hasn't improved by more than
 * PLATEAU_MAX_IMPROVEMENT_PCT in the last PLATEAU_WINDOW_DAYS compared to
 * the previous window, the system is stalled.
 *
 * When a plateau is detected, triggers an LLM analysis to suggest a
 * breakthrough strategy and saves it as a 'learning' observation.
 *
 * This is Layer 4 of the Graph Engineering framework: evidence-driven
 * feedback that stops only when objective criteria are met (in this case,
 * improvement in success rate).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} opts
 * @param {string} [opts.project] - Project path
 * @param {number} [opts.windowDays=7] - Days to analyze
 * @param {boolean} [opts.force=false] - Bypass debounce check
 * @returns {Promise<{plateau: boolean, plateauDetected: boolean, diagnosis: string|null, strategy: string|null}>}
 */
async function detectPlateau(db, opts = {}) {
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const windowDays = opts.windowDays || PLATEAU_WINDOW_DAYS;
  const force = opts.force || false;

  // Debounce: don't check more than once per interval unless forced
  if (!force) {
    const lastCheck = _lastPlateauCheck.get(project) || 0;
    if (Date.now() - lastCheck < PLATEAU_CHECK_INTERVAL_MS) {
      return { plateau: false, plateauDetected: false, diagnosis: null, strategy: null, currentRate: null, previousRate: null, improvementPct: null };
    }
  }
  _lastPlateauCheck.set(project, Date.now());

  // Get eval counts for two consecutive windows
  const now = new Date().toISOString();
  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const prevWindowStart = new Date(Date.now() - 2 * windowDays * 24 * 60 * 60 * 1000).toISOString();

  // Current window stats
  const currentTotal = db.prepare(
    'SELECT COUNT(*) as c FROM evaluation_log WHERE project_path = ? AND evaluated_at >= ?'
  ).get(project, windowStart).c;

  if (currentTotal < PLATEAU_MIN_EVALS) {
    return { plateau: false, plateauDetected: false, diagnosis: null, strategy: null, currentRate: null, previousRate: null, improvementPct: null };
  }

  const currentSuccess = db.prepare(
    "SELECT COUNT(*) as c FROM evaluation_log WHERE project_path = ? AND evaluated_at >= ? AND llm_verdict IN ('SUCCESS','REINFORCE')"
  ).get(project, windowStart).c;
  const currentRate = (currentSuccess / currentTotal) * 100;

  // Previous window stats
  const prevTotal = db.prepare(
    'SELECT COUNT(*) as c FROM evaluation_log WHERE project_path = ? AND evaluated_at >= ? AND evaluated_at < ?'
  ).get(project, prevWindowStart, windowStart).c;

  let prevRate = currentRate; // Default: assume same rate
  if (prevTotal > 0) {
    const prevSuccess = db.prepare(
      "SELECT COUNT(*) as c FROM evaluation_log WHERE project_path = ? AND evaluated_at >= ? AND evaluated_at < ? AND llm_verdict IN ('SUCCESS','REINFORCE')"
    ).get(project, prevWindowStart, windowStart).c;
    prevRate = (prevSuccess / prevTotal) * 100;
  }

  // Check if rate is stalled
  const improvement = currentRate - prevRate;
  const isPlateau = improvement <= PLATEAU_MAX_IMPROVEMENT_PCT;

  if (!isPlateau) {
    return { plateau: false, plateauDetected: false, diagnosis: null, strategy: null, currentRate, previousRate: prevRate, improvementPct: improvement, windowSpanDays: windowDays, totalEvalCount: currentTotal };
  }

  // Plateau detected — get recent verdicts for analysis
  const recent = db.prepare(
    'SELECT llm_verdict, confidence_delta, evaluated_at FROM evaluation_log WHERE project_path = ? ORDER BY evaluated_at DESC LIMIT 10'
  ).all(project);
  const recentSummary = recent.map(r => r.llm_verdict + ' (' + (r.confidence_delta >= 0 ? '+' : '') + r.confidence_delta + ')').join(', ');

  console.warn('[self-improve] ⚠️ Plateau detected for %s: %.1f%% → %.1f%% (Δ%+.1f%%) over %d days (%d evals)',
    project, prevRate, currentRate, improvement, windowDays, currentTotal);

  // Try LLM analysis for breakthrough strategy
  let diagnosis = null;
  let strategy = null;
  try {
    const { callLLM } = require('./session');

    const tpl = _getPrompts().buildMessages('analyze-plateau', {
      project: project.replace(/\\/g, '\\\\'),
      totalEvals: String(currentTotal),
      windowDays: String(windowDays),
      successRate: currentRate.toFixed(1),
      previousRate: prevRate.toFixed(1),
      plateauDays: String(windowDays),
      recentVerdicts: recentSummary,
    });

    const result = await callLLM(tpl.messages, tpl.defaults);

    const parsed = JSON.parse(result || '{}');
    diagnosis = parsed.diagnosis || null;
    strategy = parsed.strategy || null;
  } catch (e) {
    console.warn('[self-improve] Plateau analysis failed:', e.message);
    diagnosis = 'Improvement has stalled — success rate flat for ' + windowDays + ' days';
    strategy = 'Consider running a full reflection cycle or trying a different approach';
  }

  // Save plateau alert as a learning observation
  if (_saveFn && strategy) {
    try {
      await _saveFn({
        project,
        type: 'learning',
        title: 'Plateau detected: ' + (diagnosis || 'Improvement stalled').slice(0, 60),
        content: `## Plateau Alert\n\n**Diagnosis:** ${diagnosis || 'N/A'}\n\n**Strategy:** ${strategy || 'N/A'}\n\n**Context:** Success rate ${currentRate.toFixed(1)}% over ${windowDays} days (${currentTotal} evaluations). Previous rate: ${prevRate.toFixed(1)}%.`,
        tags: ['plateau-detected', 'loop-engineering', 'meta-cognition', 'auto-capture'],
        confidence: 75,
        importance: 9,
        provenance: 'inferred',
      });
    } catch { /* best-effort */ }
  }

  return {
    plateau: true,
    plateauDetected: true,
    diagnosis,
    strategy,
    currentRate,
    previousRate: prevRate,
    improvementPct: improvement,
    windowSpanDays: windowDays,
    totalEvalCount: currentTotal,
  };
}

// Prune plateau check cache periodically (called from Hook 4)
function _prunePlateauCache() {
  if (_lastPlateauCheck.size > 50) {
    const keys = [..._lastPlateauCheck.keys()];
    for (const k of keys.slice(0, 20)) _lastPlateauCheck.delete(k);
  }
}

// ─── Exports ──────────────────────────────────────────────────────────

module.exports = {
  classifyOutcome,
  learnFromError,
  autoResolveConflicts,
  verifyLearning,
  spawnExperiment,
  writeEvalLog,
  recordEvalInjections,
  recordSearchInjections,
  autoLinkEvalInjections,
  linkAgentSessionInjections,
  memoryOutcomeStats,
  getEvaluationLog,
  getEvalLogStats,
  detectPlateau,
  initHooks,
  setSaveFunction,
  resetState,
  _prunePlateauCache,

  // Reasoning submodules + plateau constants — re-exported so consumers
  // (integration tests, MCP tools, swarm dispatch) can reach them through
  // one module. prm uses a lazy require internally, so no cycle risk here.
  get treeSearch() { return require('./tree-search'); },
  get prm() { return require('./prm'); },
  get reflexionLoop() { return require('./reflexion-loop'); },
  _keywordClassify,
  PLATEAU_WINDOW_DAYS,
  PLATEAU_MIN_EVALS,
  PLATEAU_MAX_IMPROVEMENT_PCT,
  checkPlateau: detectPlateau,
};
