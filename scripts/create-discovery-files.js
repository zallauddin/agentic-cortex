#!/usr/bin/env node
/**
 * create-discovery-files.js — Shared module for creating multi-agent discovery files.
 *
 * Creates files that various AI coding agents automatically read at session start:
 *   - AGENTS.md             (OpenCode, Claude Code — canonical MCP-first discovery)
 *   - .claude/CLAUDE.md     (Claude Code)
 *   - .cursor/rules/agentic-cortex.mdc  (Cursor, alwaysApply: true)
 *   - .opencode/agentic-cortex.md  (OpenCode / Codebuff)
 *
 * Also creates MCP server configuration files:
 *   - .mcp.json  (Claude Code)
 *   - .cursor/mcp.json  (Cursor)
 *   - opencode.json  (OpenCode)
 *
 * Each file contains self-contained, token-dense instructions
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

// ── Package version (never hardcode) ──
const PACKAGE_VERSION = require('../package.json').version;

// ── All 43 MCP tool names, grouped by category ──
const MCP_TOOLS = {
  core: [
    'memory_save', 'memory_search', 'memory_get', 'memory_list', 'memory_edit',
    'memory_forget', 'memory_context', 'memory_reflect', 'memory_conflicts',
    'memory_export', 'memory_import', 'memory_health', 'memory_embed',
    'memory_relate', 'memory_graph', 'memory_hook', 'memory_share',
    'memory_feedback', 'memory_trail'
  ],
  advanced: [
    'memory_learn_from_error', 'memory_record_action', 'memory_transfer_knowledge',
    'memory_machine_vault', 'memory_promote_global', 'memory_search_all',
    'memory_ingest_transcript', 'memory_utility_stats', 'memory_freshness',
    'memory_maintenance', 'memory_analytics', 'memory_standards',
    'memory_auto_capture', 'memory_skill_list', 'memory_skill_search',
    'memory_daily_summary'
  ],
  session: [
    'session_start', 'session_end', 'session_summarize',
    'agent_session_start', 'agent_session_end', 'agent_list_sessions',
    'memory_shared_get'
  ],
  bootstrap: [
    'memory_bootstrap'
  ]
};

const MCP_TOOL_COUNT = 43; // 19 core + 16 advanced + 7 session + 1 bootstrap

/**
 * Create multi-agent discovery files in the project directory.
 * Idempotent — safe to re-run. Uses version-stamped markers to track
 * which version of the agentic-cortex section is present in each file.
 *
 * Also configures MCP server connections for AI coding tools.
 *
 * @param {string} projectDir - Project root directory
 * @returns {string[]} List of created file paths (relative to project)
 */
function createDiscoveryFiles(projectDir) {
  const created = [];
  const version = PACKAGE_VERSION;

  // ═══════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════

  /** Safely read and parse a JSON file, returning {} on error or missing file. */
  const readJSON = (filePath) => {
    try {
      if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch { /* invalid JSON, treat as empty */ }
    return {};
  };

  /**
   * Write MCP server config for a given tool file.
   * Idempotent — skips if agentic-cortex already configured.
   * @param {string} fileName - Config file name (e.g. '.mcp.json')
   * @param {string} mcpKey - Top-level key (e.g. 'mcpServers')
   * @param {object} serverConfig - Server configuration object
   * @returns {boolean} true if config was written
   */
  const writeMCPConfig = (fileName, mcpKey, serverConfig) => {
    const filePath = path.join(projectDir, fileName);
    const config = readJSON(filePath);
    if (!config[mcpKey]) config[mcpKey] = {};
    if (config[mcpKey]['agentic-cortex']) return false; // already configured

    config[mcpKey]['agentic-cortex'] = serverConfig;
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return true;
  };

  /**
   * Ensure "AGENTS.md" is in the opencode.json instructions array.
   * Creates the array if missing.
   * @param {string} filePath - Path to opencode.json
   */
  const ensureInstructionsEntry = (filePath) => {
    try {
      const config = readJSON(filePath);
      if (!Array.isArray(config.instructions)) config.instructions = [];
      if (!config.instructions.includes('AGENTS.md')) {
        config.instructions.push('AGENTS.md');
        fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
      }
    } catch { /* ignore */ }
  };

  /**
   * Write or update a version-stamped section in a file.
   *
   * Marker format:
   *   <!-- agentic-cortex:start:vX.Y.Z -->
   *   ... content ...
   *   <!-- agentic-cortex:end -->
   *
   * Behavior:
   * - File doesn't exist: create it with the section content
   * - Marker found, same version: skip (already up to date)
   * - Marker found, different version: replace the marked section
   * - No marker found: append the section to existing content
   *
   * @param {string} filePath - Full path to the file
   * @param {string} sectionContent - Content to include between markers
   * @returns {'created'|'unchanged'|'updated'|'appended'}
   */
  const writeSection = (filePath, sectionContent) => {
    const startMarker = `<!-- agentic-cortex:start:v${version} -->`;
    const endMarker = `<!-- agentic-cortex:end -->`;
    const fullSection = `${startMarker}\n${sectionContent}\n${endMarker}\n`;

    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, fullSection, 'utf-8');
      return 'created';
    }

    const existing = fs.readFileSync(filePath, 'utf-8');

    // Look for any existing agentic-cortex marker (any version)
    const startPattern = /<!-- agentic-cortex:start:v[\d.]+ -->/;
    const endPattern = /<!-- agentic-cortex:end -->/;

    const startMatch = existing.match(startPattern);
    const endMatch = existing.match(endPattern);

    if (startMatch && endMatch) {
      const startIdx = existing.indexOf(startMatch[0]);
      const endIdx = existing.indexOf(endMatch[0]) + endMatch[0].length;

      // Extract the version from the existing marker
      const versionMatch = startMatch[0].match(/v([\d.]+)/);
      const existingVersion = versionMatch ? versionMatch[1] : '';

      if (existingVersion === version) {
        return 'unchanged'; // Already up to date
      }

      // Replace the entire marked section (inclusive)
      const before = existing.slice(0, startIdx);
      const after = existing.slice(endIdx);
      fs.writeFileSync(filePath, before + fullSection + after, 'utf-8');
      return 'updated';
    }

    // No marker found — append to existing content
    const separator = existing.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(filePath, existing + separator + fullSection, 'utf-8');
    return 'appended';
  };

  // ═══════════════════════════════════════════════════════════════════
  // MCP Server Configuration Files
  // ═══════════════════════════════════════════════════════════════════

  // ── Claude Code (.mcp.json) ──
  try {
    if (writeMCPConfig('.mcp.json', 'mcpServers', { type: 'stdio', command: 'agentic-cortex-mcp', args: [] })) {
      created.push('.mcp.json');
      console.error('[agentic-cortex]   configured MCP server in .mcp.json for Claude Code');
    }
  } catch (err) {
    console.error('[agentic-cortex]   .mcp.json config skipped: ' + err.message);
  }

  // ── Cursor (.cursor/mcp.json) ──
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
  try {
    if (writeMCPConfig('opencode.json', 'mcp', { type: 'local', command: ['agentic-cortex-mcp'], enabled: true })) {
      created.push('opencode.json');
      console.error('[agentic-cortex]   configured MCP server in opencode.json for OpenCode');
    }
    // Ensure AGENTS.md is in the instructions array so OpenCode loads it
    ensureInstructionsEntry(path.join(projectDir, 'opencode.json'));
  } catch (err) {
    console.error('[agentic-cortex]   opencode.json config skipped: ' + err.message);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Discovery Files (LLM instructions)
  // ═══════════════════════════════════════════════════════════════════

  // ── Shared tool list string (reused across files) ──
  const toolListCore = 'Memory core: ' + MCP_TOOLS.core.join(', ');
  const toolListAdvanced = 'Memory advanced: ' + MCP_TOOLS.advanced.join(', ');
  const toolListSession = 'Session: ' + MCP_TOOLS.session.join(', ');
  const toolListBootstrap = 'Bootstrap: ' + MCP_TOOLS.bootstrap.join(', ');

  // ── 1. AGENTS.md (root — canonical MCP-first discovery for OpenCode + Claude Code) ──
  try {
    const agentsMdContent = [
      '# agentic-cortex',
      '',
      'Persistent, self-improving memory system for AI coding agents. ' + MCP_TOOL_COUNT + ' MCP tools.',
      '',
      '## Session Start (MANDATORY)',
      '',
      'Call the MCP tool `memory_bootstrap` with no arguments at session start to load context.',
      '',
      'Returns XML-tagged context: actionable insights, task-relevant memories (hybrid search + reranking),',
      'warnings, coding standards, codebase graph, machine-wide global vault.',
      '',
      '**Fallback (CLI):** `agentic-cortex bootstrap`',
      '',
      '## Auto-Save',
      '',
      'Use MCP tool `memory_save({ content, type?, importance?, confidence?, tags? })` after:',
      'decisions, bug fixes, discoveries, learnings, preferences, feature completions, gotchas.',
      '',
      '**Fallback (CLI):** `agentic-cortex save "title" "content"`',
      '',
      'Type auto-detected. Triggers: decision|90 error|95 context|80 preference|100 fact|85 event|95 learning|75 instruction|90',
      '',
      '## All ' + MCP_TOOL_COUNT + ' MCP Tools',
      '',
      '### ' + toolListCore + ' (' + MCP_TOOLS.core.length + ')',
      '',
      '### ' + toolListAdvanced + ' (' + MCP_TOOLS.advanced.length + ')',
      '',
      '### ' + toolListSession + ' (' + MCP_TOOLS.session.length + ')',
      '',
      '### ' + toolListBootstrap + ' (' + MCP_TOOLS.bootstrap.length + ')',
      '',
      '## Key Operations',
      '',
      '| Operation | MCP Tool | CLI Fallback |',
      '|-----------|----------|--------------|',
      '| Bootstrap | `memory_bootstrap({})` | `agentic-cortex bootstrap` |',
      '| Save | `memory_save({ content, type? })` | `agentic-cortex save "t" "c"` |',
      '| Search | `memory_search({ query })` | `agentic-cortex search "q" --project .` |',
      '| Search all projects | `memory_search_all({ query })` | `agentic-cortex machine-search "q"` |',
      '| Global vault | `memory_machine_vault({})` | `agentic-cortex machine-memory` |',
      '| Promote | `memory_promote_global({ id })` | — |',
      '| Reflect | `memory_reflect({})` | — |',
      '| Feedback | `memory_feedback({ id, type })` | `agentic-cortex feedback <id> --type helpful|incorrect` |',
      '| Context | `memory_context({})` | — |',
      '| Forget | `memory_forget({ id })` | `agentic-cortex forget <id> [--hard]` |',
      '| Standards | `memory_standards({ action: "search", query })` | `agentic-cortex standards --search "topic"` |',
      '| Conflicts | `memory_conflicts({})` | — |',
      '| Health | `memory_health({})` | — |',
      '| Daily summary | `memory_daily_summary({})` | `agentic-cortex daily-summary` |',
      '',
      '## Memory Types',
      '',
      'instruction fact decision goal commitment preference relationship context event learning observation artifact error',
      '',
      'MCP: agentic-cortex-mcp — ' + MCP_TOOL_COUNT + ' tools. Configured in .mcp.json, .cursor/mcp.json, opencode.json.',
      '',
      'Read knowledge.md for injected context (coding standards, session memories, codebase graph).',
    ].join('\n');

    const agentsPath = path.join(projectDir, 'AGENTS.md');
    const result = writeSection(agentsPath, agentsMdContent);
    if (result !== 'unchanged') created.push('AGENTS.md');
  } catch (err) {
    console.error('[agentic-cortex]   AGENTS.md skipped: ' + err.message);
  }

  // ── 2. Claude Code (.claude/CLAUDE.md) — CLI-first, tool list included ──
  try {
    const claudeDir = path.join(projectDir, '.claude');
    if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });

    const claudeMdContent = [
      '<agentic_cortex>',
      'agentic-cortex is installed. Persistent, self-improving memory across sessions.',
      'MCP server is configured in .mcp.json — ' + MCP_TOOL_COUNT + ' tools available directly.',
      '',
      '<bootstrap>',
      'PREFERRED: Use MCP tool memory_bootstrap({}) — no args needed. Returns structured XML context.',
      'FALLBACK CLI: agentic-cortex bootstrap',
      '</bootstrap>',
      '',
      'MCP tools (' + MCP_TOOL_COUNT + ' total):',
      toolListCore + ',',
      toolListAdvanced + ',',
      toolListSession + ',',
      toolListBootstrap + '.',
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
      '  memory_reflect({}) | memory_feedback({ id, type }) | memory_context({}) | memory_health({})',
      '  memory_export({}) | memory_import({}) | memory_conflicts({}) | memory_list({})',
      'CLI fallback: agentic-cortex bootstrap | save "t" "c" | search "q" --project .',
      '  agentic-cortex machine-search "q" | machine-memory [--analytics]',
      '  agentic-cortex forget <id> | feedback <id> --type helpful|incorrect',
      '  agentic-cortex standards --search "topic"',
      '</commands>',
      '',
      '<memory_types>instruction fact decision goal commitment preference relationship context event learning observation artifact error</memory_types>',
      '',
      '<mcp>agentic-cortex-mcp configured in .mcp.json. ' + MCP_TOOL_COUNT + ' tools on stdio JSON-RPC.</mcp>',
      '',
      'Read knowledge.md for injected context (coding standards, session memories, codebase graph).',
      '</agentic_cortex>',
    ].join('\n');

    const claudePath = path.join(claudeDir, 'CLAUDE.md');
    const result = writeSection(claudePath, claudeMdContent);
    if (result !== 'unchanged') created.push('.claude/CLAUDE.md');
  } catch (err) {
    console.error('[agentic-cortex]   .claude/CLAUDE.md skipped: ' + err.message);
  }

  // ── 3. Cursor (.cursor/rules/agentic-cortex.mdc) — CLI-first, tool list included ──
  try {
    const cursorDir = path.join(projectDir, '.cursor', 'rules');
    if (!fs.existsSync(cursorDir)) fs.mkdirSync(cursorDir, { recursive: true });

    const cursorMdcContent = [
      '---',
      'description: agentic-cortex — persistent self-improving agent memory with bootstrap, auto-save, cross-project immune system',
      'alwaysApply: true',
      '---',
      '',
      '<agentic_cortex>',
      '',
      '<bootstrap>',
      'PREFERRED: Use MCP tool memory_bootstrap({}) — no args needed. Returns structured XML context.',
      'FALLBACK CLI: agentic-cortex bootstrap',
      '</bootstrap>',
      '',
      'MCP tools (' + MCP_TOOL_COUNT + ' total):',
      toolListCore + ',',
      toolListAdvanced + ',',
      toolListSession + ',',
      toolListBootstrap + '.',
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
      '  memory_reflect({}) | memory_feedback({ id, type }) | memory_context({}) | memory_health({})',
      'CLI fallback: agentic-cortex bootstrap | save "t" "c" | search "q" --project .',
      '  agentic-cortex machine-search "q" | machine-memory [--analytics]',
      '  agentic-cortex forget <id> | feedback <id> --type helpful|incorrect',
      '  agentic-cortex standards --search "topic"',
      '</commands>',
      '',
      '<mcp>agentic-cortex-mcp configured in .cursor/mcp.json. ' + MCP_TOOL_COUNT + ' tools on stdio JSON-RPC.</mcp>',
      '</agentic_cortex>',
    ].join('\n');

    const cursorPath = path.join(cursorDir, 'agentic-cortex.mdc');
    const result = writeSection(cursorPath, cursorMdcContent);
    if (result !== 'unchanged') created.push('.cursor/rules/agentic-cortex.mdc');
  } catch (err) {
    console.error('[agentic-cortex]   .cursor/rules/agentic-cortex.mdc skipped: ' + err.message);
  }

  // ── 4. OpenCode (.opencode/agentic-cortex.md) — MCP-first ──
  try {
    const opencodeDir = path.join(projectDir, '.opencode');
    if (!fs.existsSync(opencodeDir)) fs.mkdirSync(opencodeDir, { recursive: true });

    const opencodeMdContent = [
      '<agentic_cortex>',
      'Persistent, self-improving agent memory. MCP server configured in opencode.json.',
      MCP_TOOL_COUNT + ' MCP tools available.',
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
      '<all_' + MCP_TOOL_COUNT + '_mcp_tools>',
      '',
      toolListCore + ' (' + MCP_TOOLS.core.length + ')',
      '',
      toolListAdvanced + ' (' + MCP_TOOLS.advanced.length + ')',
      '',
      toolListSession + ' (' + MCP_TOOLS.session.length + ')',
      '',
      toolListBootstrap + ' (' + MCP_TOOLS.bootstrap.length + ')',
      '',
      '</all_' + MCP_TOOL_COUNT + '_mcp_tools>',
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
      '<mcp>' + MCP_TOOL_COUNT + ' tools via opencode.json mcp config. Run agentic-cortex-mcp locally.</mcp>',
      '</agentic_cortex>',
    ].join('\n');

    const opencodePath = path.join(opencodeDir, 'agentic-cortex.md');
    const result = writeSection(opencodePath, opencodeMdContent);
    if (result !== 'unchanged') created.push('.opencode/agentic-cortex.md');
  } catch (err) {
    console.error('[agentic-cortex]   .opencode/agentic-cortex.md skipped: ' + err.message);
  }

  return created;
}

module.exports = { createDiscoveryFiles };
