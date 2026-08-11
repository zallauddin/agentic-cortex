/**
 * prompts.js — Prompt Template Registry for agentic-cortex.
 *
 * Layer 1 of the 5-Layer Graph Engineering framework:
 * "Prompt Engineering — Teaching AI How to Think"
 *
 * Previously, all prompts were inline strings scattered across modules.
 * This module extracts them into a centralized, versioned registry so
 * prompts can be:
 *   - Retrieved by name (single source of truth)
 *   - Versioned (track changes over time)
 *   - Evolved based on outcomes (A/B tested with eval log feedback)
 *   - Extended with custom templates at runtime
 *
 * Each template has:
 *   - name: Unique identifier
 *   - version: Semver-ish version (1.0, 1.1, etc.)
 *   - systemPrompt: System message
 *   - userPromptTemplate: Template with {{placeholder}} variables
 *   - defaults: Default LLM params (temperature, maxTokens, timeout)
 *   - description: What this prompt is used for
 *   - outcomeTracking: Whether to tag LLM calls with this prompt ID for eval
 *
 * @module core/prompts
 */

'use strict';

/** @type {Map<string, Object>} In-memory prompt template registry */
const _templates = new Map();

/** @type {number} Version counter for custom templates */
let _customVersionCounter = 0;

// ─── Built-in Prompt Templates ──────────────────────────────────────

const BUILTIN_TEMPLATES = {
  // ── Classification ──────────────────────────────────────────────
  'classify-outcome': {
    name: 'classify-outcome',
    version: '1.0',
    description: 'Classify an action outcome as success, failure, or neutral',
    systemPrompt: `You classify the outcome of a coding action. Respond with a single JSON object.

Classification rules:
- "success" = the action achieved its intended goal (work completed, test passes, bug fixed, build green, key created)
- "failure" = the action did NOT achieve its goal (anything failed, broke, rejected, error, timeout, rollback, didn't work, didn't take, didn't fix)
- "neutral" = outcome is ambiguous or neither success nor failure

CRITICAL rules:
- MUST handle negation: "didn't work", "didn't take", "didn't fix", "didn't pass", "not working" are FAILURES, not successes
- MUST handle implicit failure: "the code crashed after applying" is a FAILURE
- "fixed" alone is success; "didn't fix" is failure

Respond ONLY with: {"outcome":"success|failure|neutral","reason":"brief reason"}`,
    userPromptTemplate: 'Classify this outcome: "{{outcomeText}}"',
    defaults: { temperature: 0, maxTokens: 80, timeout: 8000 },
    outcomeTracking: true,
  },

  // ── Root Cause Analysis ─────────────────────────────────────────
  'rca-from-error': {
    name: 'rca-from-error',
    version: '1.0',
    description: 'Analyze an error and generate a systemic fix/learning',
    systemPrompt: 'You are a root cause analysis agent for coding workflows. Respond ONLY with valid JSON.',
    userPromptTemplate: `Analyze this coding agent error and identify the root cause and a systemic fix.

Error: "{{errorContent}}"

Context: This error occurred while a coding agent was working on a software project.
Identify:
1. Root cause: Why did this happen? Was it a knowledge gap, a process flaw, or a code issue?
2. Systemic fix: What rule, check, or practice would prevent this class of error in the future?

Return JSON with:
- title: Short fix title (max 80 chars, e.g., "Always validate input before transform")
- content: The systemic fix described as a rule or practice (max 500 chars)
- confidence: 1-100, how certain you are this fix addresses the root cause
- tags: Array of relevant tags`,
    defaults: { temperature: 0.2, maxTokens: 800, timeout: 60000 },
    outcomeTracking: true,
  },

  // ── Consolidation ───────────────────────────────────────────────
  'consolidate-observations': {
    name: 'consolidate-observations',
    version: '1.0',
    description: 'Merge multiple related observations into a canonical summary',
    systemPrompt: 'You are a knowledge consolidation assistant. Respond ONLY with valid JSON.',
    userPromptTemplate: `You are consolidating {{count}} related observations into a single canonical entry.
Extract the key facts, remove redundancy, and write a clear, concise summary.

Observations:
{{observations}}

Return JSON with:
- title: Short descriptive title (max 80 chars)
- content: Consolidated content (markdown ok, max 1000 chars)`,
    defaults: { temperature: 0.2, maxTokens: 1500 },
    outcomeTracking: false,
  },

  // ── Pattern Detection ───────────────────────────────────────────
  'promote-pattern': {
    name: 'promote-pattern',
    version: '1.0',
    description: 'Detect recurring patterns and summarize as learning',
    systemPrompt: 'You extract recurring patterns from observations. Respond ONLY with valid JSON.',
    userPromptTemplate: `You noticed a recurring theme "{{theme}}" ({{themeType}}) appearing {{count}} times in recent observations.
Summarize the key pattern/insight in one learning observation.

Sample observations:
{{samples}}

Return JSON with:
- title: "Pattern: {{theme}}" (max 80 chars)
- content: Brief insight (markdown ok, max 1000 chars)
- tags: ["pattern", "{{theme}}", "{{themeType}}"]`,
    defaults: { temperature: 0.3, maxTokens: 1500 },
    outcomeTracking: false,
  },

  // ── Conflict Resolution ─────────────────────────────────────────
  'resolve-conflict': {
    name: 'resolve-conflict',
    version: '1.0',
    description: 'Determine which of two contradictory observations is correct',
    systemPrompt: 'You resolve knowledge conflicts. Respond ONLY with valid JSON.',
    userPromptTemplate: `Two observations appear to contradict each other. Determine which is correct.

A: "{{observationA}}"
B: "{{observationB}}"

Return JSON:
- correct: "A", "B", or "both_partially"
- reasoning: Brief explanation (max 200 chars)
- resolution: How to reconcile them or which to trust (max 300 chars)`,
    defaults: { temperature: 0.1, maxTokens: 600, timeout: 30000 },
    outcomeTracking: true,
  },

  // ── Learning Verification ───────────────────────────────────────
  'verify-learning': {
    name: 'verify-learning',
    version: '1.0',
    description: 'Check if new evidence contradicts or reinforces existing learning',
    systemPrompt: 'You verify knowledge against new evidence. Respond ONLY with valid JSON.',
    userPromptTemplate: `A learning rule exists: "{{learningTitle}}: {{learningContent}}"

A new observation was just recorded: "[{{obsType}}] {{obsTitle}}: {{obsContent}}"

Does the new observation:
- CONTRADICT the learning (the learning appears wrong or incomplete)?
- REINFORCE the learning (it confirms the learning was correct)?
- NEUTRAL (unrelated)?

Return JSON: { "verdict": "CONTRADICT"|"REINFORCE"|"NEUTRAL", "reason": "brief reason" }`,
    defaults: { temperature: 0.1, maxTokens: 200, timeout: 15000 },
    outcomeTracking: true,
  },

  // ── Experiment Design ───────────────────────────────────────────
  'design-experiment': {
    name: 'design-experiment',
    version: '1.0',
    description: 'Design a controlled experiment to fix a recurring error',
    systemPrompt: 'You design controlled software engineering experiments. Respond ONLY with valid JSON.',
    userPromptTemplate: `You are designing a controlled experiment to fix a recurring error. Follow the scientific method: change ONE variable at a time, measure against a fixed metric.

Recurring error tag: "{{errorTag}}"

Recent occurrences:
{{recentErrors}}

Return JSON:
- hypothesis: What you believe will fix this (max 200 chars)
- variable_changed: The ONE thing to change (max 100 chars)
- fixed_metric: The constant metric to measure success against (e.g., "build success", "test passes", "no TypeError")
- before_state: Current failing behavior (max 200 chars)
- expected_after: What success looks like (max 200 chars)`,
    defaults: { temperature: 0.2, maxTokens: 800, timeout: 30000 },
    outcomeTracking: true,
  },

  // ── Skill Extraction ────────────────────────────────────────────
  'extract-skill': {
    name: 'extract-skill',
    version: '1.0',
    description: 'Convert a high-confidence learning into a structured instruction',
    systemPrompt: 'You convert learnings into structured instructions. Respond ONLY with valid JSON.',
    userPromptTemplate: `Convert this high-confidence learning into a structured instruction with actionable steps.

Learning: "{{learningTitle}}: {{learningContent}}"

Return JSON with:
- title: Instruction title (max 80 chars)
- content: Clear instructional content (max 500 chars)
- steps: Array of actionable step strings (3-5 steps)
- triggers: Array of situations that trigger this instruction (e.g., "TypeError", "before PR")
- preconditions: Array of conditions that must be true (e.g., "Node.js >= 18")
- postconditions: Array of expected results (e.g., "No null pointer errors")`,
    defaults: { temperature: 0.2, maxTokens: 1200, timeout: 30000 },
    outcomeTracking: true,
  },

  // ── Crystallize (Layer 1→2) ─────────────────────────────────────
  'crystallize-raw-to-synthesis': {
    name: 'crystallize-raw-to-synthesis',
    version: '1.0',
    description: 'Compress raw observations into a single synthesis',
    systemPrompt: 'You distill multiple observations into a single synthesis. Respond ONLY with valid JSON.',
    userPromptTemplate: `You are compressing {{count}} raw observations about "{{tag}}" into a single synthesis. Extract the key insights, remove redundancy, and write a concise summary.

Observations:
{{observations}}

Return JSON with:
- title: Synthesis title (max 80 chars)
- content: Key insights synthesized (max 800 chars, markdown ok)`,
    defaults: { temperature: 0.2, maxTokens: 1200, timeout: 30000 },
    outcomeTracking: false,
  },

  // ── Plateau Detection ───────────────────────────────────────────
  'analyze-plateau': {
    name: 'analyze-plateau',
    version: '1.0',
    description: 'Analyze stalled improvement and suggest breakthrough strategies',
    systemPrompt: 'You are a meta-cognition agent that detects when improvement has stalled and suggests breakthrough strategies. Respond ONLY with valid JSON.',
    userPromptTemplate: `The evaluation log for project "{{project}}" shows stalled improvement:
- {{totalEvals}} total evaluations over {{windowDays}} days
- Success rate: {{successRate}}% (stalled — previous period was {{previousRate}}%)
- {{plateauDays}} consecutive days with no improvement in success rate

Recent verdict pattern:
{{recentVerdicts}}

Analyze this plateau and suggest a breakthrough strategy.
Return JSON with:
- diagnosis: Why is improvement stalled? (max 200 chars)
- strategy: What new approach should be tried? (max 300 chars)
- variable_to_change: The ONE thing to change next (max 100 chars)
- expected_impact: What improvement to expect (max 150 chars)`,
    defaults: { temperature: 0.4, maxTokens: 1000, timeout: 30000 },
    outcomeTracking: true,
  },
};

// ─── Template Registry API ──────────────────────────────────────────

/**
 * Get a prompt template by name. Returns built-in or custom template.
 *
 * @param {string} name - Template name (e.g., 'classify-outcome', 'rca-from-error')
 * @returns {Object|undefined} Template definition
 */
function getTemplate(name) {
  return _templates.get(name);
}

/**
 * Register or update a custom prompt template at runtime.
 * Custom templates override built-ins with the same name.
 *
 * @param {Object} def — { name, version?, systemPrompt, userPromptTemplate, defaults?, description?, outcomeTracking? }
 * @returns {Object} Registered template
 */
function defineTemplate(def) {
  if (!def.name || !def.systemPrompt || !def.userPromptTemplate) {
    throw new Error('Template requires: name, systemPrompt, userPromptTemplate');
  }
  _customVersionCounter++;
  const template = {
    name: def.name,
    version: def.version || ('custom-' + _customVersionCounter),
    description: def.description || def.name,
    systemPrompt: def.systemPrompt,
    userPromptTemplate: def.userPromptTemplate,
    defaults: def.defaults || { temperature: 0.3, maxTokens: 2000, timeout: 30000 },
    outcomeTracking: def.outcomeTracking !== false,
    source: 'custom',
  };
  _templates.set(def.name, template);
  return template;
}

/**
 * Render a prompt template by substituting {{placeholders}} with values.
 * Returns the system message and rendered user message.
 *
 * @param {string} templateName — Template name
 * @param {Object} [vars={}] — Variable substitutions
 * @returns {{ system: string, user: string, defaults: Object }|null}
 */
function renderPrompt(templateName, vars = {}) {
  const tpl = _templates.get(templateName);
  if (!tpl) return null;

  const user = tpl.userPromptTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return vars[key] !== undefined ? String(vars[key]) : '';
  });

  return {
    name: templateName,
    version: tpl.version,
    system: tpl.systemPrompt,
    user,
    defaults: { ...tpl.defaults },
    outcomeTracking: tpl.outcomeTracking,
  };
}

/**
 * Build a messages array for callLLM() from a template.
 * Convenience wrapper around renderPrompt.
 *
 * @param {string} templateName
 * @param {Object} [vars={}]
 * @returns {{ messages: Array<{role, content}>, defaults: Object, templateName: string, version: string }|null}
 */
function buildMessages(templateName, vars = {}) {
  const rendered = renderPrompt(templateName, vars);
  if (!rendered) return null;

  return {
    messages: [
      { role: 'system', content: rendered.system },
      { role: 'user', content: rendered.user },
    ],
    defaults: rendered.defaults,
    templateName: rendered.name,
    version: rendered.version,
    outcomeTracking: rendered.outcomeTracking,
  };
}

/**
 * List all registered templates.
 *
 * @returns {Array<{name: string, version: string, description: string, source: string}>}
 */
function listTemplates() {
  return [..._templates.values()].map(t => ({
    name: t.name,
    version: t.version,
    description: t.description,
    source: t.source || 'built-in',
    outcomeTracking: t.outcomeTracking,
  }));
}

/**
 * Reset templates to built-in defaults only (for testing).
 */
function resetTemplates() {
  _templates.clear();
  _customVersionCounter = 0;
  _loadBuiltins();
}

// ─── Initialization ─────────────────────────────────────────────────

function _loadBuiltins() {
  for (const [name, def] of Object.entries(BUILTIN_TEMPLATES)) {
    _templates.set(name, { ...def, source: 'built-in' });
  }
}

// Load built-ins at module init
_loadBuiltins();

// ─── Exports ────────────────────────────────────────────────────────

module.exports = {
  BUILTIN_TEMPLATES,
  getTemplate,
  defineTemplate,
  renderPrompt,
  buildMessages,
  listTemplates,
  resetTemplates,
};
