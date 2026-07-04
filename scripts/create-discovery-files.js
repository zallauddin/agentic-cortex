#!/usr/bin/env node
/**
 * create-discovery-files.js — Shared module for creating multi-agent discovery files.
 *
 * Creates files that various AI coding agents automatically read at session start:
 *   - .claude/CLAUDE.md  (Claude Code)
 *   - .cursor/rules/agentic-cortex.mdc  (Cursor, alwaysApply: true)
 *   - .opencode/agentic-cortex.md  (OpenCode / Codebuff)
 *
 * Each file points to knowledge.md as the authoritative source for:
 *   - Pre-loaded coding standards (DRY, KISS, SOLID, Clean Code, Karpathy)
 *   - Session memories from previous work
 *   - Codebase structure graph
 *   - Auto-save protocol instructions
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
  const knowledgeRel = './knowledge.md';

  // ── Claude Code (.claude/CLAUDE.md) ──
  const claudeDir = path.join(projectDir, '.claude');
  const claudePath = path.join(claudeDir, 'CLAUDE.md');
  if (!fs.existsSync(claudePath)) {
    try {
      if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(claudePath, [
        '# Agentic Cortex — Persistent Agent Memory',
        '',
        'This project uses agentic-cortex for persistent, self-improving agent memory.',
        '',
        '**IMPORTANT:** Read `' + knowledgeRel + '` at the start of every session. It contains:',
        '- Pre-loaded coding standards (DRY, KISS, SOLID, Clean Code, Karpathy)',
        '- Session memories from previous work',
        '- Codebase structure graph',
        '- Auto-save protocol instructions',
        '',
        '## Quick Start',
        '```bash',
        'agentic-cortex save "title" "content" --type decision --importance 8',
        'agentic-cortex search "query" --project .',
        'agentic-cortex context --project .',
        '```',
        '',
        'You MUST save observations automatically whenever you make decisions, fix bugs, discover context, or learn something new.',
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
        'description: Auto-injected agent memory system — provides session context, coding standards, and codebase graph',
        'alwaysApply: true',
        '---',
        '',
        '# Agentic Cortex Memory System',
        '',
        'This project uses agentic-cortex for persistent agent memory. Read `' + knowledgeRel + '` at session start.',
        '',
        '**Auto-save protocol:** After making decisions, fixing bugs, discovering context, or learning new things, run:',
        '```bash',
        'agentic-cortex save "title" "content" --type <type> --importance <1-10>',
        '```',
        '',
        '**Search past memories:**',
        '```bash',
        'agentic-cortex search "query" --project .',
        '```',
        '',
        '**Get full context (coding standards + sessions + observations):**',
        '```bash',
        'agentic-cortex context --project .',
        '```',
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
        '# Agentic Cortex — Auto-Injected Agent Memory',
        '',
        'agentic-cortex provides persistent, self-improving memory for AI coding agents.',
        '',
        '**Read `' + knowledgeRel + '` at session start for full context.**',
        '',
        '## Commands',
        '- `agentic-cortex save "title" "content" --type decision` — Save observations',
        '- `agentic-cortex search "query"` — Search memories',
        '- `agentic-cortex context` — Get full context injection',
        '- `agentic-cortex feedback <id> --type helpful` — Reinforce useful memories',
        '- `agentic-cortex standards` — View pre-loaded coding standards',
        '',
        '## MCP Server',
        'Start with: `agentic-cortex-mcp`',
        'Provides 35+ tools including memory_save, memory_search, memory_standards, memory_context.',
      ].join('\n'), 'utf-8');
      created.push('.opencode/agentic-cortex.md');
    } catch { /* ignore */ }
  }

  return created;
}

module.exports = { createDiscoveryFiles };
