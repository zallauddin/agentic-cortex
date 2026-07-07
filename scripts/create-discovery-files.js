#!/usr/bin/env node
/**
 * create-discovery-files.js — Shared module for creating multi-agent discovery files.
 *
 * Creates files that various AI coding agents automatically read at session start:
 *   - .claude/CLAUDE.md  (Claude Code)
 *   - .cursor/rules/agentic-cortex.mdc  (Cursor, alwaysApply: true)
 *   - .opencode/agentic-cortex.md  (OpenCode / Codebuff)
 *
 * Each file contains self-contained, token-dense XML-structured instructions
 * optimized for LLM consumption — not human readability.
 *
 * Used by:
 *   - cli.js (setup command)
 *   - scripts/auto-setup.js (postinstall hook)
 *
 * @module scripts/create-discovery-files
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Create multi-agent discovery files in the project directory.
 * Idempotent — won't overwrite existing files.
 *
 * @param {string} projectDir - Project root directory
 * @returns {string[]} List of created file paths (relative to project)
 */
function createDiscoveryFiles(projectDir) {
  const created = [];

  // ── Claude Code (.claude/CLAUDE.md) ──
  const claudeDir = path.join(projectDir, '.claude');
  const claudePath = path.join(claudeDir, 'CLAUDE.md');
  if (!fs.existsSync(claudePath)) {
    try {
      if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(claudePath, [
        '<agentic_cortex>',
        'agentic-cortex is installed. Persistent, self-improving memory across sessions.',
        '',
        '<bootstrap>agentic-cortex bootstrap</bootstrap>',
        'Run with zero args at session start. System infers your task from session, git branch, recent activity.',
        'Returns XML-tagged context: actionable insights, task-relevant memories (hybrid search + reranking),',
        'warnings, coding standards, codebase graph, machine-wide global vault.',
        'MCP: memory_bootstrap() — no args needed.',
        '',
        '<auto_save>',
        'Save after: decisions, bug fixes, discoveries, learnings, preferences, feature completions, gotchas.',
        'Command: agentic-cortex save "title" "content"',
        'Type auto-detected. Override: --type TYPE --importance 1-10 --confidence 0-100 --tags "t1,t2"',
        '',
        'Triggers: decision|90 error|95 context|80 preference|100 fact|85 event|95 learning|75 instruction|90',
        '</auto_save>',
        '',
        '<commands>',
        'bootstrap: agentic-cortex bootstrap',
        'save: agentic-cortex save "title" "content"',
        'search: agentic-cortex search "query" --project .',
        'machine-search: agentic-cortex machine-search "query"',
        'machine-memory: agentic-cortex machine-memory [--analytics]',
        'forget: agentic-cortex forget <id> [--hard]',
        'feedback: agentic-cortex feedback <id> --type helpful|incorrect',
        'standards: agentic-cortex standards --search "topic"',
        '</commands>',
        '',
        '<memory_types>instruction fact decision goal commitment preference relationship context event learning observation artifact error</memory_types>',
        '',
        '<mcp>agentic-cortex-mcp — 39+ tools. memory_bootstrap() first.</mcp>',
        '',
        'Read knowledge.md for injected context (coding standards, session memories, codebase graph).',
        '</agentic_cortex>',
      ].join('\n'), 'utf-8');
      created.push('.claude/CLAUDE.md');
    } catch { /* ignore */ }
  }

  // ── Cursor (.cursor/rules/agentic-cortex.mdc) ──
  const cursorDir = path.join(projectDir, '.cursor', 'rules');
  const cursorPath = path.join(cursorDir, 'agentic-cortex.mdc');
  if (!fs.existsSync(cursorPath)) {
    try {
      if (!fs.existsSync(cursorDir)) fs.mkdirSync(cursorDir, { recursive: true });
      fs.writeFileSync(cursorPath, [
        '---',
        'description: agentic-cortex — persistent self-improving agent memory with bootstrap, auto-save, cross-project immune system',
        'alwaysApply: true',
        '---',
        '',
        '<agentic_cortex>',
        '<bootstrap>agentic-cortex bootstrap</bootstrap>',
        'Zero args. Infers task from session/git/recent activity. Returns structured XML context.',
        '',
        '<auto_save>',
        'Save automatically after: decisions, bug fixes, discoveries, learnings, preferences.',
        'Command: agentic-cortex save "title" "content"',
        'Type auto-detected. Triggers: decision|90 error|95 context|80 preference|100 fact|85 event|95 learning|75 instruction|90',
        '</auto_save>',
        '',
        '<commands>',
        'bootstrap: agentic-cortex bootstrap',
        'save: agentic-cortex save "title" "content"',
        'search: agentic-cortex search "query" --project .',
        'machine-search: agentic-cortex machine-search "query"',
        'machine-memory: agentic-cortex machine-memory [--analytics]',
        'forget: agentic-cortex forget <id> [--hard]',
        'feedback: agentic-cortex feedback <id> --type helpful|incorrect',
        'standards: agentic-cortex standards --search "topic"',
        '</commands>',
        '',
        '<mcp>agentic-cortex-mcp — 39+ tools. memory_bootstrap() first.</mcp>',
        '</agentic_cortex>',
      ].join('\n'), 'utf-8');
      created.push('.cursor/rules/agentic-cortex.mdc');
    } catch { /* ignore */ }
  }

  // ── OpenCode (.opencode/agentic-cortex.md) ──
  const opencodeDir = path.join(projectDir, '.opencode');
  const opencodePath = path.join(opencodeDir, 'agentic-cortex.md');
  if (!fs.existsSync(opencodePath)) {
    try {
      if (!fs.existsSync(opencodeDir)) fs.mkdirSync(opencodeDir, { recursive: true });
      fs.writeFileSync(opencodePath, [
        '<agentic_cortex>',
        'Persistent, self-improving agent memory. Installed globally.',
        '',
        '<bootstrap>agentic-cortex bootstrap</bootstrap>',
        'Zero args. Infers task. Returns XML context with memories, insights, warnings, global vault, graph.',
        '',
        '<auto_save>',
        'Save automatically. Never wait. Command: agentic-cortex save "title" "content"',
        'Type auto-detected. Triggers (type|confidence): decision|90 error|95 context|80 preference|100 fact|85 event|95 learning|75 instruction|90',
        '</auto_save>',
        '',
        '<commands>',
        'bootstrap: agentic-cortex bootstrap',
        'save: agentic-cortex save "title" "content"',
        'search: agentic-cortex search "query" --project .',
        'machine-search: agentic-cortex machine-search "query"',
        'machine-memory: agentic-cortex machine-memory [--analytics]',
        'forget: agentic-cortex forget <id> [--hard]',
        'feedback: agentic-cortex feedback <id> --type helpful|incorrect',
        'answer: agentic-cortex answer "question" --project .',
        'standards: agentic-cortex standards --search "topic"',
        'daily-summary: agentic-cortex daily-summary --project .',
        '</commands>',
        '',
        '<memory_types>instruction fact decision goal commitment preference relationship context event learning observation artifact error</memory_types>',
        '',
        '<mcp>agentic-cortex-mcp — 39+ tools. memory_bootstrap() with no args first.</mcp>',
        '</agentic_cortex>',
      ].join('\n'), 'utf-8');
      created.push('.opencode/agentic-cortex.md');
    } catch { /* ignore */ }
  }

  return created;
}

module.exports = { createDiscoveryFiles };
