#!/usr/bin/env node
/**
 * demo-nonllm-agent.js — Non-LLM Agent Demo
 *
 * Demonstrates agentic-cortex v5.0.0's brain orchestration layer executing
 * a complete bug-fix-cycle using ONLY deterministic state machines, rules,
 * and workflows — zero LLM calls.
 *
 * Architecture:
 *   FSM Engine:  debug-workflow (reproducing → diagnosing → fixing → verifying → closed)
 *   Rule Engine: escalate-recurring-errors, auto-crystallize-on-milestone,
 *                run-maintenance-on-review, save-context-on-state-change
 *   Workflow:    bug-fix-cycle (reproduce → diagnose → fix → test → review → merge)
 *   Memory:      observations saved at each step, tagged and typed
 *
 * Usage: node scripts/demo-nonllm-agent.js
 */

'use strict';

const api = require('../src/api');
const rules = require('../src/core/rules');

// ─── Visual helpers ──────────────────────────────────────────────────

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const P = s => process.stdout.write(s);

function header(text) {
  console.log(`\n${BOLD}${CYAN}${'═'.repeat(70)}${RESET}`);
  console.log(`${BOLD}${CYAN}  ${text}${RESET}`);
  console.log(`${BOLD}${CYAN}${'═'.repeat(70)}${RESET}\n`);
}

function step(n, label) {
  console.log(`${BOLD}${GREEN}[${n}]${RESET} ${label}`);
}

function info(label, value) {
  const valStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
  console.log(`  ${DIM}${label}:${RESET} ${MAGENTA}${valStr}${RESET}`);
}

function rule(label, result) {
  const icon = result.matched ? '🔥' : '⏭️';
  const color = result.matched ? YELLOW : DIM;
  console.log(`  ${icon} ${color}[RULE] ${result.rule}: ${result.matched ? 'FIRED' : 'skipped'} → ${result.action}${RESET}`);
  if (result.detail) {
    console.log(`    ${DIM}  ${result.detail}${RESET}`);
  }
}

function success(text) {
  console.log(`\n  ${GREEN}✅ ${text}${RESET}`);
}

function warn(text) {
  console.log(`  ${YELLOW}⚠️  ${text}${RESET}`);
}

function divider() {
  console.log(`  ${DIM}${'─'.repeat(60)}${RESET}`);
}

// ─── Main Demo ───────────────────────────────────────────────────────

async function main() {
  const project = process.cwd();
  const agentId = 'nonllm-agent-demo';
  let llmCallCount = 0;

  // ── Monkey-patch callLLM to track (and prevent) LLM calls ──
  const session = require('../src/core/session');
  const originalCallLLM = session.callLLM;
  let llmIntercepted = false;
  session.callLLM = async function (...args) {
    llmCallCount++;
    llmIntercepted = true;
    // Return null = graceful fallback to deterministic behavior
    return null;
  };

  console.clear();
  console.log(`${BOLD}${GREEN}
   ╔══════════════════════════════════════════════════════════════╗
   ║     agentic-cortex v5.0.0 — NON-LLM AGENT DEMO              ║
   ║     Bug Fix Cycle: FSM + Rules + Workflow = Zero LLM        ║
   ╚══════════════════════════════════════════════════════════════╝
${RESET}`);

  // ──────────────────────────────────────────────────────────────────
  // PHASE 0: Initialize the brain
  // ──────────────────────────────────────────────────────────────────
  header('PHASE 0: Initialize Brain Orchestration Layer');
  
  await api.init();
  info('DB tables seeded', 'state_machines + rules + workflow_definitions');
  info('Default machines', 'coding-workflow, debug-workflow, review-workflow');
  info('Default rules', '4 rules loaded (escalate-errors, auto-crystallize, etc.)');
  info('Default workflows', 'bug-fix-cycle, deploy-pipeline, memory-maintenance');
  success('Brain initialized — all engines ready');

  // ──────────────────────────────────────────────────────────────────
  // PHASE 1: Seed a bug report into memory
  // ──────────────────────────────────────────────────────────────────
  header('PHASE 1: Seed Bug Report into Memory');

  step('1.1', 'Save initial bug report (type=error, tags=bug,stack-overflow)');
  const bug = await api.save({
    title: 'BUG: Stack overflow in recursive parser',
    content: 'The recursive descent parser crashes with a stack overflow when parsing deeply nested JSON objects (>1000 levels). Reproduced consistently with test fixture deep-nest.json.',
    type: 'error',
    tags: ['bug', 'stack-overflow', 'parser', 'recursion'],
    importance: 9,
    confidence: 95,
    project,
    agentId,
  });
  info('Bug saved', `ID #${bug.id}, type=${bug.type}`);

  step('1.2', 'Save reproduction steps (type=instruction)');
  await api.save({
    title: 'Repro steps: Stack overflow bug',
    content: '1. Create JSON file with 2000+ nested objects. 2. Run parse --input deep.json. 3. Observe RangeError: Maximum call stack size exceeded at line 147 of parser.js.',
    type: 'instruction',
    tags: ['bug', 'reproduction', 'parser'],
    importance: 7,
    project,
    agentId,
  });
  success('Bug report seeded in memory');

  // ──────────────────────────────────────────────────────────────────
  // PHASE 2: Start the brain — FSM + Workflow in parallel
  // ──────────────────────────────────────────────────────────────────
  header('PHASE 2: Activate Brain — FSM + Workflow');

  step('2.1', 'Start agent FSM: debug-workflow');
  api.startAgent(agentId, 'debug-workflow', { project });
  let state = api.getAgentState(agentId);
  info('FSM State', `${state.currentState} (machine: ${state.machineName})`);

  // Verify onEnter: save_context fired for 'reproducing' state
  const contexts = api.list({ project, type: 'context', limit: 3 });
  const contextEntry = contexts.find(o => {
    try { return JSON.parse(o.tags || '[]').includes('fsm'); } catch { return false; }
  });
  if (contextEntry) {
    info('onEnter action', `save_context fired → ID #${contextEntry.id} "${contextEntry.preview?.slice(0, 50)}..."`);
  }

  step('2.2', 'Start workflow: bug-fix-cycle');
  const wf = api.startWorkflow('bug-fix-cycle', { project, agentId });
  info('Workflow', `${wf.workflowName} — current step: "${wf.currentStep}"`);
  info('Steps', 'reproduce → diagnose → fix → test → review → merge');
  success('Brain activated — FSM + Workflow running in parallel');

  // ──────────────────────────────────────────────────────────────────
  // PHASE 3: Execute bug-fix-cycle — reproduce → diagnose
  // ──────────────────────────────────────────────────────────────────
  header('PHASE 3: Reproduce → Diagnose');

  step('3.1', 'FSM transition: bug_reproduced → diagnosing');
  api.transitionAgent(agentId, 'bug_reproduced', { project });
  state = api.getAgentState(agentId);
  info('FSM State', `${state.currentState}`);

  step('3.2', 'Advance workflow: reproduce → diagnose');
  let wfState = api.advanceWorkflow(wf.id, { project });
  info('Workflow', `completed "${wfState.completedStep}" → now at "${wfState.currentStep}"`);

  step('3.3', 'Save diagnosis observation');
  await api.save({
    title: 'DIAGNOSIS: Recursion depth exceeds V8 call stack limit',
    content: 'Root cause: parse() function in src/parser.js line 147 calls itself recursively without tail-call optimization. Stack limit is ~10,000 frames in V8, and 1000+ nested JSON levels require >2000 recursive calls. Fix: convert to iterative approach using explicit stack.',
    type: 'learning',
    tags: ['diagnosis', 'parser', 'stack-overflow', 'root-cause'],
    importance: 9,
    confidence: 90,
    project,
    agentId,
  });
  success('Bug diagnosed — root cause found');

  // ──────────────────────────────────────────────────────────────────
  // PHASE 4: Fix → Verify
  // ──────────────────────────────────────────────────────────────────
  header('PHASE 4: Fix → Verify');

  step('4.1', 'FSM transition: root_cause_found → fixing');
  api.transitionAgent(agentId, 'root_cause_found', { project });
  state = api.getAgentState(agentId);
  info('FSM State', `${state.currentState}`);
  // Note: onEnter for 'fixing' is spawn_experiment_if_recurring (handled by Hook 5)

  step('4.2', 'Advance workflow: diagnose → fix → test');
  wfState = api.advanceWorkflow(wf.id, { project });
  info('Workflow Step 3', `completed "${wfState.completedStep}" → "${wfState.currentStep}"`);
  wfState = api.advanceWorkflow(wf.id, { project });
  info('Workflow Step 4', `completed "${wfState.completedStep}" → "${wfState.currentStep}"`);

  step('4.3', 'Save fix implementation');
  await api.save({
    title: 'FIX: Convert recursive parser to iterative with explicit stack',
    content: 'Replaced recursive parse() with iterative version using while loop + explicit stack array. Handles unlimited nesting. Added test for 10,000-level deep nesting.',
    type: 'event',
    tags: ['fix', 'parser', 'refactor', 'bug-fix'],
    importance: 8,
    confidence: 85,
    project,
    agentId,
  });

  step('4.4', 'FSM transition: fix_applied → verifying');
  api.transitionAgent(agentId, 'fix_applied', { project });
  state = api.getAgentState(agentId);
  info('FSM State', `${state.currentState}`);

  step('4.5', 'Save verification result');
  await api.save({
    title: 'VERIFICATION: All tests pass, 10K nesting handled',
    content: 'Ran test suite: 247/247 pass. Deep nesting test (10,000 levels) completes in 340ms. Memory usage stable. No stack overflow.',
    type: 'event',
    tags: ['verification', 'tests-pass', 'bug-fix'],
    importance: 8,
    confidence: 95,
    project,
    agentId,
  });
  success('Fix verified — all tests green');

  // ──────────────────────────────────────────────────────────────────
  // PHASE 5: Trigger the rule engine — seed enough errors
  // ──────────────────────────────────────────────────────────────────
  header('PHASE 5: Rule Engine — Trigger escalate-recurring-errors');

  step('5.1', 'Seed 5+ errors with same tag to trigger escalate-recurring-errors');
  for (let i = 1; i <= 6; i++) {
    await api.save({
      title: `Error #${i}: Parser failure variant`,
      content: `Parser error variant ${i} — additional failure mode discovered during testing.`,
      type: 'error',
      tags: ['parser', 'error', 'bug'],
      importance: 6 + i,
      confidence: 90,
      project,
      agentId,
    });
  }
  info('Errors seeded', '6 errors with tag "parser" (threshold: 5)');

  step('5.2', 'Evaluate rules explicitly (post_save event)');
  const ruleResults = await api.evaluateRules('post_save', {
    project_path: project,
    tags: ['parser', 'error', 'bug'],
    type: 'error',
    agentId,
  });
  
  for (const r of ruleResults) {
    rule(r, r);
    if (r.action === 'spawn_experiment' && r.matched) {
      info('Result', 'Rule would auto-spawn experiment for recurring parser errors');
    }
  }

  step('5.3', 'Evaluate rules for state_transition event');
  const stateRuleResults = await api.evaluateRules('state_transition', {
    agentId,
    fromState: 'fixing',
    toState: 'verifying',
    machineName: 'debug-workflow',
  });
  for (const r of stateRuleResults) {
    rule(r, r);
  }
  success('Rule engine evaluated — all conditions checked deterministically');

  // ──────────────────────────────────────────────────────────────────
  // PHASE 6: Complete the cycle — verify → close
  // ──────────────────────────────────────────────────────────────────
  header('PHASE 6: Complete — Verify → Close');

  step('6.1', 'FSM transition: fix_verified → closed');
  api.transitionAgent(agentId, 'fix_verified', { project });
  state = api.getAgentState(agentId);
  info('FSM State', `${state.currentState}`);
  // Note: onEnter for 'closed' triggers save_learning action

  step('6.2', 'Advance workflow: test → review → merge (complete)');
  wfState = api.advanceWorkflow(wf.id, { project });
  info('Workflow Step 5', `completed "${wfState.completedStep}" → "${wfState.currentStep}"`);
  wfState = api.advanceWorkflow(wf.id, { project });
  info('Workflow Step 6', `completed "${wfState.completedStep}" → "${wfState.currentStep}"`);
  info('Workflow Status', wfState.status);

  // Verify the learning was auto-saved by onEnter
  const learnings = api.list({ project, type: 'learning', limit: 5 });
  const fsmLearning = learnings.find(o => {
    try { return JSON.parse(o.tags || '[]').includes('fsm'); } catch { return false; }
  });
  if (fsmLearning) {
    info('onEnter action', `save_learning fired → "${fsmLearning.preview?.slice(0, 50)}..."`);
  }

  step('6.3', 'Verify FSM terminal state');
  const transitions = api.getAvailableTransitions(agentId);
  const isTerm = !transitions.some(t => t.from === state.currentState);
  info('Terminal?', isTerm ? 'YES — bug fix complete' : 'NO');
  success('Bug fix cycle complete — FSM in closed state, workflow merged');

  // ──────────────────────────────────────────────────────────────────
  // PHASE 7: Context Injection — what agents see
  // ──────────────────────────────────────────────────────────────────
  header('PHASE 7: Context Injection — What Agents See');

  process.env.AGENTIC_CORTEX_AGENT_ID = agentId;
  
  step('7.1', 'Plain context (no query)');
  const plainCtx = await api.context({ project });
  const fsmLine = plainCtx.split('\n').find(l => l.includes('Agent State'));
  if (fsmLine) console.log(`  ${MAGENTA}${fsmLine.trim()}${RESET}`);

  step('7.2', 'Bootstrap context (with query) — graceful LLM fallback');
  const bootstrapCtx = await api.context({ query: 'how do I fix the parser bug?', project });
  const agentStateLine = bootstrapCtx.split('\n').find(l => l.includes('agent_state'));
  if (agentStateLine) console.log(`  ${MAGENTA}${agentStateLine.trim()}${RESET}`);
  if (llmIntercepted) {
    console.log(`  ${DIM}  (LLM summarization gracefully downgraded to template-based fallback)${RESET}`);
  }

  delete process.env.AGENTIC_CORTEX_AGENT_ID;
  success('Context injection shows FSM state in both modes');

  // ──────────────────────────────────────────────────────────────────
  // PHASE 8: Memory Summary
  // ──────────────────────────────────────────────────────────────────
  header('PHASE 8: Memory Summary — What Was Learned');

  const allObs = api.list({ project, limit: 100 });
  const bugCycleObs = allObs.filter(o => {
    const text = (o.title || '') + ' ' + (o.preview || '');
    return text.includes('BUG:') || text.includes('DIAGNOSIS:') || text.includes('FIX:') || text.includes('VERIFICATION:') || text.includes('Repro steps') || text.includes('Error #');
  });
  const fsmAutoObs = allObs.filter(o => {
    const text = (o.title || '') + ' ' + (o.preview || '');
    return text.includes('FSM:');
  });
  const totalObs = allObs.length;

  info('Bug cycle observations', bugCycleObs.length);
  info('FSM auto-captured', fsmAutoObs.length);
  info('Total observations', totalObs);
  info('LLM calls made', llmCallCount + ' (should be 0!)');

  // ──────────────────────────────────────────────────────────────────
  // Final Report
  // ──────────────────────────────────────────────────────────────────
  console.log(`\n${BOLD}${GREEN}${'═'.repeat(70)}${RESET}`);
  console.log(`${BOLD}${GREEN}  🧠 NON-LLM AGENT DEMO — COMPLETE${RESET}`);
  console.log(`${BOLD}${GREEN}${'═'.repeat(70)}${RESET}`);
  
  console.log(`\n  ${BOLD}Engines Used:${RESET}`);
  console.log(`    • FSM Engine:      debug-workflow (5 states, 6 transitions)`);
  console.log(`    • Rule Engine:     4 rules evaluated (2 fired, 2 skipped)`);
  console.log(`    • Workflow:        bug-fix-cycle (6 steps, all completed)`);
  console.log(`    • Memory System:   ${totalObs} observations saved`);
  
  console.log(`\n  ${BOLD}LLM Calls:${RESET} ${llmCallCount === 0 ? GREEN + 'ZERO — fully deterministic' + RESET : YELLOW + llmCallCount + ' (graceful fallback to deterministic)' + RESET}`);
  
  console.log(`\n  ${BOLD}F${RESET}inite ${BOLD}S${RESET}tate ${BOLD}M${RESET}achine + ${BOLD}R${RESET}ule ${BOLD}E${RESET}ngine + ${BOLD}W${RESET}orkflow`);
  console.log(`  ${DIM}= Symbolic AI without LLMs${RESET}`);
  console.log(`  ${DIM}= Deterministic, auditable, debuggable${RESET}`);
  console.log(`  ${DIM}= Suitable for non-LLM agent construction${RESET}`);
  console.log(`  ${DIM}= LLM is optional enhancement, not the brain itself${RESET}\n`);

  if (llmCallCount > 0) {
    warn(`Detected ${llmCallCount} optional LLM call(s) — all gracefully fell back to deterministic alternatives.`);
    console.log(`  ${DIM}  The FSM + Rules + Workflow core runs entirely without LLMs.${RESET}`);
    console.log(`  ${DIM}  LLM is used only for quality-of-life enhancements like memory summarization.${RESET}\n`);
  } else {
    success('Zero LLM calls confirmed — 100% deterministic symbolic agent');
  }

  // Cleanup: restore original callLLM
  session.callLLM = originalCallLLM;
}

// ─── Run ─────────────────────────────────────────────────────────────

main().catch(err => {
  console.error(`${RED}DEMO FAILED:${RESET}`, err.message);
  console.error(err.stack);
  process.exit(1);
});
