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

  // ── Test-Time Compute Reasoning (Phase 20) ─────────────────────
  'generate-reasoning-branches': {
    name: 'generate-reasoning-branches',
    version: '1.0',
    description: 'Generate multiple candidate reasoning steps for tree search',
    systemPrompt: `You are a reasoning engine that explores multiple solution paths.
Given a problem and the reasoning chain so far, generate DIFFERENT candidate next steps.
Each candidate should represent a DISTINCT approach.

Respond ONLY with valid JSON: {"branches": [{"content": "step text", "type": "reasoning|code|plan"}]}`,
    userPromptTemplate: `Problem: {{problem}}

{{chainContext}}

Generate {{branchCount}} candidate next steps, each with a distinct approach:
1. The most obvious/straightforward step
2. A creative/unconventional approach
3. The most conservative/safe step

Respond with JSON: {"branches": [{"content": "...", "type": "..."}]}`,
    defaults: { temperature: 0.7, maxTokens: 2000, timeout: 30000 },
    outcomeTracking: true,
  },

  'verify-reasoning-step': {
    name: 'verify-reasoning-step',
    version: '1.0',
    description: 'Score a reasoning step using LLM-as-judge (Process Reward Model)',
    systemPrompt: `You are a Process Reward Model (PRM) that verifies reasoning steps.
Evaluate whether this step is a VALID logical deduction given the prior context.

Scoring:
- 0.0-0.2: Clearly invalid (false claim, logical fallacy)
- 0.3-0.4: Likely invalid (unjustified assumption)
- 0.5-0.6: Neutral (plausible but unverified)
- 0.7-0.8: Likely valid (sound reasoning, supported by evidence)
- 0.9-1.0: Clearly valid (proven by evidence)

Respond ONLY with valid JSON: {"score": 0.0-1.0, "valid": true/false, "reason": "brief explanation"}`,
    userPromptTemplate: `Problem: {{problem}}

{{priorContext}}

Step to verify:
{{stepContent}}`,
    defaults: { temperature: 0, maxTokens: 200, timeout: 15000 },
    outcomeTracking: true,
  },

  'synthesize-solution': {
    name: 'synthesize-solution',
    version: '1.0',
    description: 'Merge insights from multiple explored reasoning paths into a final solution',
    systemPrompt: `You synthesize a final solution from multiple explored reasoning paths.
Combine the best parts of each path while discarding flawed reasoning.

Respond ONLY with valid JSON: {"solution": "final answer", "confidence": 0.0-1.0, "paths_used": ["description of which paths contributed"]}`,
    userPromptTemplate: `Problem: {{problem}}

Explored paths:
{{paths}}

Synthesize the best solution from these explorations:`,
    defaults: { temperature: 0.2, maxTokens: 2000, timeout: 30000 },
    outcomeTracking: true,
  },

  'reflexion-critique': {
    name: 'reflexion-critique',
    version: '1.0',
    description: 'Critique a failed reasoning path to extract learnings for self-correction',
    systemPrompt: `You analyze failed reasoning paths and extract actionable critiques.
Identify the root cause, a pattern to avoid, and a suggested alternative.

Respond ONLY with valid JSON:
{"critique": "why it failed", "avoidPattern": "pattern to avoid", "suggestAlternative": "alternative approach"}`,
    userPromptTemplate: `Problem: {{problem}}

Failed approach: {{strategy}}

Reasoning path:
{{failedPath}}

Reason for rejection: {{verificationError}}

Extract a critique to help the agent avoid this mistake:`,
    defaults: { temperature: 0.2, maxTokens: 500, timeout: 15000 },
    outcomeTracking: true,
  },

  'check-goal-reached': {
    name: 'check-goal-reached',
    version: '1.0',
    description: 'Determine if a reasoning chain has reached a solution',
    systemPrompt: `You determine if a reasoning chain has reached a solution.
The chain has reached a goal if it contains a concrete answer that resolves the problem.

Respond ONLY with valid JSON: {"reached": true/false, "confidence": 0.0-1.0, "reason": "brief"}`,
    userPromptTemplate: `Problem: {{problem}}

Reasoning chain:
{{chain}}

Has this chain reached a solution?`,
    defaults: { temperature: 0, maxTokens: 150, timeout: 10000 },
    outcomeTracking: false,
  },

  // ── Swarm persona execution templates ───────────────────────────
  'swarm-analyze': {
    name: 'swarm-analyze',
    version: '1.0',
    description: 'Analyzer persona: read shared brain and produce findings about what exists and what is missing',
    systemPrompt: `You are the ANALYZER persona in a multi-agent swarm. Your job is to read the shared brain (provided as context) and produce structured findings.

Output valid JSON:
{"findings": ["finding 1", ...], "gaps": ["gap 1", ...], "existingAssets": ["asset 1", ...], "recommendations": ["rec 1", ...]}`,
    userPromptTemplate: `Goal: {{goal}}

Shared brain context:
{{context}}

Analyze what already exists and what is missing to achieve this goal.`,
    defaults: { temperature: 0.3, maxTokens: 1000, timeout: 30000 },
    outcomeTracking: true,
  },
  'swarm-plan': {
    name: 'swarm-plan',
    version: '1.0',
    description: 'Planner persona: turn analysis into an ordered implementation plan',
    systemPrompt: `You are the PLANNER persona. Given analysis findings, produce an ordered implementation plan.

Output valid JSON:
{"steps": [{"order": 1, "action": "...", "rationale": "..."}], "estimatedComplexity": "low|medium|high"}`,
    userPromptTemplate: `Goal: {{goal}}

Analysis findings:
{{analysis}}

Create an ordered implementation plan.`,
    defaults: { temperature: 0.3, maxTokens: 1500, timeout: 30000 },
    outcomeTracking: true,
  },
  'swarm-implement': {
    name: 'swarm-implement',
    version: '1.0',
    description: 'Coder persona: implement a specific step from the plan',
    systemPrompt: `You are the CODER persona. Implement the given task step. Be precise and concrete.

Output valid JSON:
{"implementation": "code or description of changes", "rationale": "why this approach", "edgeCases": ["case 1", ...]}`,
    userPromptTemplate: `Goal: {{goal}}

Plan step to implement:
{{step}}

Relevant context:
{{context}}

Implement this step.`,
    defaults: { temperature: 0.3, maxTokens: 2000, timeout: 60000 },
    outcomeTracking: true,
  },
  'swarm-review': {
    name: 'swarm-review',
    version: '1.0',
    description: 'Reviewer persona: review implementation against standards and past failures',
    systemPrompt: `You are the REVIEWER persona. Review the implementation against known standards, past failures, and best practices.

Output valid JSON:
{"approved": true/false, "issues": ["issue 1", ...], "suggestions": ["suggestion 1", ...], "score": 0-100}`,
    userPromptTemplate: `Goal: {{goal}}

Implementation to review:
{{implementation}}

Standards and past failures to check against:
{{context}}

Review this implementation.`,
    defaults: { temperature: 0.2, maxTokens: 1000, timeout: 30000 },
    outcomeTracking: true,
  },
  'swarm-verify': {
    name: 'swarm-verify',
    version: '1.0',
    description: 'Verifier persona: verify the final result end-to-end',
    systemPrompt: `You are the VERIFIER persona. Verify that the completed work actually solves the original goal.

Output valid JSON:
{"verified": true/false, "gaps": ["remaining gap", ...], "confidence": 0.0-1.0, "summary": "brief verification summary"}`,
    userPromptTemplate: `Goal: {{goal}}

Completed results from all roles:
{{results}}

Verify that the goal has been achieved end-to-end.`,
    defaults: { temperature: 0.1, maxTokens: 800, timeout: 30000 },
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
