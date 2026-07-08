#!/usr/bin/env node
/**
 * create-discovery-files.js — Shared module for creating multi-agent discovery files.
 *
 * Creates files that various AI coding agents automatically read at session start:
 *   - .claude/CLAUDE.md  (Claude Code)
 *   - .cursor/rules/agentic-cortex.mdc  (Cursor, alwaysApply: true)
 *   - .opencode/agentic-cortex.md  (OpenCode / Codebuff)
 *
 * Also creates MCP server configuration files:
 *   - .mcp.json  (Claude Code)
 *   - .cursor/mcp.json  (Cursor)
 *   - opencode.json  (OpenCode)
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
 * Also configures MCP server connections for AI coding tools that require
 * MCP for plugin/addon support (OpenCode) or benefit from direct tool access
 * over shell commands (Claude Code, Cursor).
 *
 * @param {string} projectDir - Project root directory
 * @returns {string[]} List of created file paths (relative to project)
 */
function createDiscoveryFiles(projectDir) {
  const created = [];

  // ═══════════════════════════════════════════════════════════════════
  // MCP Server Configuration Files
  // ═══════════════════════════════════════════════════════════════════

  // ── Helper: safely read/parse JSON file ──
  const readJSON = (filePath) => {
    try {
      if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch { /* invalid JSON, treat as empty */ }
    return {};
  };

  // ── Helper: write MCP config if agentic-cortex not already configured ──
  const writeMCPConfig = (fileName, mcpKey, serverConfig) => {
    const filePath = path.join(projectDir, fileName);
    const config = readJSON(filePath);
    if (!config[mcpKey]) config[mcpKey] = {};
    if (config[mcpKey]['agentic-cortex']) return false; // already configured

    config[mcpKey]['agentic-cortex'] = serverConfig;
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return true;
  };

  // ── Claude Code (.mcp.json) ──
  // Claude can run shell commands, but MCP tools provide direct access
  // without the overhead of spawning a child process for each call.
  try {
    if (writeMCPConfig('.mcp.json', 'mcpServers', { type: 'stdio', command: 'agentic-cortex-mcp', args: [] })) {
      created.push('.mcp.json');
      console.error('[agentic-cortex]   configured MCP server in .mcp.json for Claude Code');
    }
  } catch (err) {
    console.error('[agentic-cortex]   .mcp.json config skipped: ' + err.message);
  }

  // ── Cursor (.cursor/mcp.json) ──
  // Cursor supports MCP via .cursor/mcp.json with the same mcpServers
  // structure as Claude Code. Project-scoped, requires user approval first use.
  try {
    const cursorMcpDir = path.join(projectDir, '.cursor');
    if (!fs.existsSync(cursorMcpDir)) fs.mkdirSync(cursorMcpDir, { recursive: true });
    if (writeMCPConfig('.cursor/mcp.json', 'mcpServers', { type: 'stdio', command: 'agentic-cortex-mcp', args: [] })) {
      created.push('.cursor/mcp.json');
      console.error('[agentic-cortex]   configured MCP server in .cursor/mcp.json for Cursor');
    }
  } catch (err) {
    console.error('[agentic-cortex]   .cursor/mcp.json config skipped: ' + err.message);
  }

  // ── OpenCode (opencode.json) ──
  // OpenCode ONLY supports MCP servers for addons/plugins. Without this,
  // OpenCode cannot use agentic-cortex at all — it can't run shell commands.
  try {
    if (writeMCPConfig('opencode.json', 'mcp', { type: 'local', command: ['agentic-cortex-mcp'], enabled: true })) {
      created.push('opencode.json');
      console.error('[agentic-cortex]   configured MCP server in opencode.json for OpenCode');
    }
  } catch (err) {
    console.error('[agentic-cortex]   opencode.json config skipped: ' + err.message);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Discovery Markdown Files (LLM instructions)
  // ═══════════════════════════════════════════════════════════════════

  // ── Claude Code (.claude/CLAUDE.md) ──
  const claudeDir = path.join(projectDir, '.claude');
  const claudePath = path.join(claudeDir, 'CLAUDE.md');
  if (!fs.existsSync(claudePath)) {
    try {
      if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(claudePath, [
        '<agentic_cortex>',
        'agentic-cortex is installed. Persistent, self-improving memory across sessions.',
        'MCP server is configured in .mcp.json — 39+ tools available directly.',
        '',
        '<bootstrap>',
        'PREFERRED: Use MCP tool memory_bootstrap({}) — no args needed. Returns structured XML context.',
        'FALLBACK CLI: agentic-cortex bootstrap',
        '</bootstrap>',
        'MCP tools: memory_bootstrap, memory_save, memory_search, memory_search_all, memory_machine_vault,',
        'memory_promote_global, memory_reflect, memory_feedback, memory_context, memory_forget, and more.',
        '',
        '<auto_save>',
        'PREFERRED: Use MCP tool memory_save({ content, type?, importance?, confidence?, tags? }).',
        'FALLBACK CLI: agentic-cortex save "title" "content"',
        'Type auto-detected. Triggers: decision|90 error|95 context|80 preference|100 fact|85 event|95 learning|75 instruction|90',
        '</auto_save>',
        '',
        '<commands>',
        'MCP tools (preferred): memory_bootstrap({}) | memory_save({...}) | memory_search({ query })',
        '  memory_search_all({ query }) | memory_machine_vault({}) | memory_promote_global({ id })',
        '  memory_reflect({}) | memory_feedback({ id, type }) | memory_context({})',
        'CLI fallback: agentic-cortex bootstrap | save "t" "c" | search "q" --project .',
        '  agentic-cortex machine-search "q" | machine-memory [--analytics]',
        '  agentic-cortex forget <id> | feedback <id> --type helpful|incorrect',
        '  agentic-cortex standards --search "topic"',
        '</commands>',
        '',
        '<memory_types>instruction fact decision goal commitment preference relationship context event learning observation artifact error</memory_types>',
        '',
        '<mcp>agentic-cortex-mcp configured in .mcp.json. 39+ tools on stdio JSON-RPC.</mcp>',
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
        '<bootstrap>',
        'PREFERRED: Use MCP tool memory_bootstrap({}) — no args needed. Returns structured XML context.',
        'FALLBACK CLI: agentic-cortex bootstrap',
        '</bootstrap>',
        'MCP tools: memory_bootstrap, memory_save, memory_search, memory_search_all, memory_machine_vault,',
        'memory_promote_global, memory_reflect, memory_feedback, memory_context, memory_forget, and more.',
        '',
        '<auto_save>',
        'PREFERRED: Use MCP tool memory_save({ content, type?, importance?, confidence?, tags? }).',
        'FALLBACK CLI: agentic-cortex save "title" "content"',
        'Type auto-detected. Triggers: decision|90 error|95 context|80 preference|100 fact|85 event|95 learning|75 instruction|90',
        '</auto_save>',
        '',
        '<commands>',
        'MCP tools (preferred): memory_bootstrap({}) | memory_save({...}) | memory_search({ query })',
        '  memory_search_all({ query }) | memory_machine_vault({}) | memory_promote_global({ id })',
        '  memory_reflect({}) | memory_feedback({ id, type }) | memory_context({})',
        'CLI fallback: agentic-cortex bootstrap | save "t" "c" | search "q" --project .',
        '  agentic-cortex machine-search "q" | machine-memory [--analytics]',
        '  agentic-cortex forget <id> | feedback <id> --type helpful|incorrect',
        '  agentic-cortex standards --search "topic"',
        '</commands>',
        '',
        '<mcp>agentic-cortex-mcp configured in .cursor/mcp.json. 39+ tools on stdio JSON-RPC.</mcp>',
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
        'Persistent, self-improving agent memory. MCP server configured in opencode.json.',
        '39+ MCP tools available — use memory_bootstrap({}) at session start.',
        '',
        '<bootstrap>',
        'CRITICAL: Call MCP tool memory_bootstrap({}) first — no args needed.',
        'Returns XML context: actionable insights, task-relevant memories, warnings,',
        'coding standards, codebase graph, machine-wide global vault.',
        '</bootstrap>',
        '',
        '<auto_save>',
        'Use MCP tool memory_save({ content, type?, importance?, confidence?, tags? }).',
        'Type auto-detected from content patterns.',
        'Triggers: decision|90 error|95 context|80 preference|100 fact|85 event|95 learning|75 instruction|90',
        '</auto_save>',
        '',
        '<key_tools>',
        'memory_bootstrap({}) — session start context (CRITICAL: call first)',
        'memory_save({ content, type? }) — save observation (type auto-detected)',
        'memory_search({ query, project?, limit? }) — hybrid FTS5 + semantic search',
        'memory_search_all({ query }) — search across ALL projects on this machine',
        'memory_machine_vault({}) — browse machine-wide global vault',
        'memory_promote_global({ id }) — promote to cross-project vault',
        'memory_reflect({}) — consolidate, promote patterns, archive',
        'memory_feedback({ id, type }) — mark helpful or incorrect',
        'memory_context({ project? }) — full project context pack',
        'memory_forget({ id }) — soft-delete (hard: true for permanent)',
        'memory_list({ project?, type?, limit? }) — list with filters',
        'memory_conflicts({}) — detect contradictory observations',
        'memory_standards({ action: "search", query }) — search coding standards',
        'memory_daily_summary({}) — yesterday\'s observations summary',
        '</key_tools>',
        '',
        '<memory_types>instruction fact decision goal commitment preference relationship context event learning observation artifact error</memory_types>',
        '',
        '<mcp>39+ tools via opencode.json mcp config. Run agentic-cortex-mcp locally.</mcp>',
        '</agentic_cortex>',
      ].join('\n'), 'utf-8');
      created.push('.opencode/agentic-cortex.md');
    } catch { /* ignore */ }
  }

  return created;
}

module.exports = { createDiscoveryFiles };
