'use strict';

/**
 * wireup.js — Hard wireup of agentic-cortex into every detected coding agent.
 *
 * Detection alone ("here is what you could write") still leaves the user to
 * ask the agent for integration. This module CLOSES the loop: it merges the
 * AC MCP registration into every detected agent's JSON config, drops the
 * version-stamped instruction section into the agent's instruction file,
 * and reports exactly what it did. Idempotent and non-destructive:
 *
 *   - JSON configs: read → merge under the framework's server key → write.
 *     Existing sibling servers are preserved untouched.
 *   - Instruction files: version-stamped <!-- agentic-cortex:start --> marker
 *     section; same-version = skip, new version = replace in place, other
 *     content = append (never overwritten).
 *   - YAML/TOML frameworks (Codex, Continue, Goose, aider): AC never
 *     auto-merges structured non-JSON formats — it emits the exact stanza
 *     for the user/agent to paste, and still wires the instruction file.
 *   - Failures are per-framework: one broken config never blocks the rest.
 *
 * @module core/wireup
 */

const fs = require('fs');
const path = require('path');
const manifest = require('./manifest');

const PACKAGE_VERSION = require('../../package.json').version;

// ─── Instruction section (token-dense, per-agent boilerplate) ───────

/**
 * The canonical instruction block that tells an agent AC is taking care of
 * memory + sessions + machine-wide knowledge. Kept short on purpose: this
 * lands in every session's context.
 * @param {string} agentName — human name, used in one header line
 * @returns {string}
 */
function instructionSection(agentName) {
  return [
    'agentic-cortex (v' + PACKAGE_VERSION + ') is wired up for ' + agentName + '.',
    'AC owns memory, sessions, and machine-wide knowledge for this machine — do NOT re-implement any of it.',
    '',
    'SESSION START (mandatory): call MCP tool `memory_bootstrap` with no arguments.',
    'It returns structured XML: actionable insights, task-relevant memories, warnings,',
    'coding standards, codebase graph, and the machine-wide global vault.',
    '',
    'DURING WORK: call `memory_save({ content, type? })` after every decision, fix,',
    'discovery, or gotcha. Type auto-detects. Ask AC before re-deriving knowledge:',
    '`memory_search({ query })` for this project, `memory_search_all` machine-wide.',
    '',
    'SESSION END: `memory_feedback({ id, type })` on memories that helped or misled,',
    'and `session_end` so lessons crystallize. Battle-tested learnings auto-promote to',
    'the machine-wide vault; sanitized seeds may sync to the team memory repo.',
    '',
    'If a memory looks stale or contradicts the code, trust the code and report the',
    'conflict via `memory_conflicts` / `memory_resolve_conflict` — never silently ignore it.',
  ].join('\n');
}

// ─── JSON config merge ──────────────────────────────────────────────

/**
 * Merge AC's server entry into a JSON MCP config. Preserves every other
 * server and top-level key. Overwrites a previous agentic-cortex entry
 * (stale wiring refreshes) but keeps the rest of the file byte-identical
 * in meaning.
 * @param {string} absPath
 * @param {string} key — e.g. 'mcpServers'
 * @param {Object} serverConfig
 * @returns {{ changed: boolean, error?: string }}
 */
function mergeMcpJson(absPath, key, serverConfig) {
  let config = {};
  if (fs.existsSync(absPath)) {
    try {
      config = JSON.parse(fs.readFileSync(absPath, 'utf-8')) || {};
      if (typeof config !== 'object' || Array.isArray(config)) throw new Error('not an object');
    } catch (err) {
      return { changed: false, error: 'existing config is not valid JSON (' + err.message + ') — refusing to overwrite' };
    }
  }
  if (!config[key] || typeof config[key] !== 'object') config[key] = {};
  const before = JSON.stringify(config[key]['agentic-cortex'] || null);
  config[key]['agentic-cortex'] = serverConfig;
  const changed = before !== JSON.stringify(serverConfig);
  if (changed) {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  }
  return { changed };
}

// ─── Version-stamped instruction section writer ─────────────────────

/**
 * Write/refresh a version-stamped AC section in an instruction file.
 * Mirrors create-discovery-files.js marker semantics, but tolerates
 * multiple stacked AC sections (older versions) by replacing only the
 * newest and leaving unrelated user content alone.
 * @param {string} absPath
 * @param {string} content — section body (without markers)
 * @returns {'created'|'updated'|'unchanged'|'appended'}
 */
function writeInstructionSection(absPath, content) {
  const startMarker = '<!-- agentic-cortex:start:v' + PACKAGE_VERSION + ' -->';
  const fullSection = startMarker + '\n' + content + '\n<!-- agentic-cortex:end -->\n';

  const existing = fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf-8') : '';
  const startRe = /<!-- agentic-cortex:start:v[\d.]+ -->/;
  const endRe = /<!-- agentic-cortex:end -->/;

  const startMatch = existing.match(startRe);
  const endMatch = existing.match(endRe);

  if (startMatch && endMatch) {
    const startIdx = existing.indexOf(startMatch[0]);
    const endIdx = existing.indexOf(endMatch[0]) + endMatch[0].length;
    const versionMatch = startMatch[0].match(/v([\d.]+)/);
    if (versionMatch && versionMatch[1] === PACKAGE_VERSION) return 'unchanged';
    fs.writeFileSync(absPath, existing.slice(0, startIdx) + fullSection + existing.slice(endIdx), 'utf-8');
    return 'updated';
  }

  if (!existing) {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, fullSection, 'utf-8');
    return 'created';
  }

  const separator = existing.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(absPath, existing + separator + '\n' + fullSection, 'utf-8');
  return 'appended';
}

// ─── Main wireup ────────────────────────────────────────────────────

/**
 * Wire AC into every agent framework detected in the project (and their
 * known global config locations).
 *
 * @param {Object} [opts]
 * @param {string} [opts.project] — project root (default cwd)
 * @param {string[]} [opts.only] — restrict to these framework ids
 * @param {string[]} [opts.skip] — skip these framework ids
 * @param {boolean} [opts.dryRun] — report without writing
 * @returns {{ wired: Array, skipped: Array, failed: Array, stanza: Array, dryRun: boolean }}
 */
function wireupAll(opts = {}) {
  const project = path.resolve(opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd());
  const dryRun = !!opts.dryRun;
  const discovered = manifest.discoverFrameworks({ project })
    .filter(f => !opts.only || opts.only.includes(f.id))
    .filter(f => !opts.skip || !opts.skip.includes(f.id));

  const wired = [], skipped = [], failed = [], stanza = [];

  for (const fw of discovered) {
    const plan = manifest.composeWithFramework(fw, { project });
    if (!plan.ok) { failed.push({ id: fw.id, error: plan.error }); continue; }

    const result = { id: fw.id, name: fw.name, mcp: null, instructions: [], notes: [] };

    // 1. MCP registration (JSON-mergeable frameworks)
    if (plan.wiring.mcpFile && plan.wiring.mcpConfig) {
      if (dryRun) {
        result.mcp = 'would merge into ' + plan.wiring.mcpFile;
      } else {
        const existing = fs.existsSync(plan.wiring.mcpFile)
          ? (() => { try { return JSON.parse(fs.readFileSync(plan.wiring.mcpFile, 'utf-8')); } catch { return undefined; } })()
          : {};
        const already = existing && existing[plan.wiring.mcpKey] && existing[plan.wiring.mcpKey]['agentic-cortex'];
        const merge = mergeMcpJson(plan.wiring.mcpFile, plan.wiring.mcpKey, plan.wiring.mcpConfig[plan.wiring.mcpKey]['agentic-cortex']);
        if (merge.error) {
          failed.push({ id: fw.id, error: merge.error });
          continue;
        }
        result.mcp = merge.changed ? 'merged into ' + plan.wiring.mcpFile : (already ? 'already registered in ' + plan.wiring.mcpFile : 'no change');
      }
    } else if (plan.wiring.tomlStanza || plan.wiring.yamlBlock) {
      stanza.push({
        id: fw.id,
        name: fw.name,
        format: plan.wiring.tomlStanza ? 'toml' : 'yaml',
        block: plan.wiring.tomlStanza || plan.wiring.yamlBlock,
        note: plan.strategy,
      });
      result.notes.push('non-JSON config: exact stanza provided for manual/agent paste');
    } else if (plan.wiring.manualMcpConfig) {
      result.notes.push(plan.strategy);
    }

    // 2. Instruction files
    for (const rel of plan.wiring.instructionFiles || []) {
      if (dryRun) {
        result.instructions.push({ file: rel, action: 'would write section' });
        continue;
      }
      try {
        const action = writeInstructionSection(rel, instructionSection(fw.name));
        if (action !== 'unchanged') result.instructions.push({ file: rel, action });
      } catch (err) {
        failed.push({ id: fw.id, error: 'instruction file ' + rel + ': ' + err.message });
      }
    }

    // 3. Framework-specific extras (e.g. opencode instructions array)
    if (plan.wiring.ensureInstructions && !dryRun) {
      try {
        const { file, entry } = plan.wiring.ensureInstructions;
        const abs = path.join(project, file);
        let config = {};
        try { config = JSON.parse(fs.readFileSync(abs, 'utf-8')) || {}; } catch { /* new file */ }
        if (!Array.isArray(config.instructions)) config.instructions = [];
        if (!config.instructions.includes(entry)) {
          config.instructions.push(entry);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, JSON.stringify(config, null, 2) + '\n', 'utf-8');
          result.notes.push('added ' + entry + ' to instructions in ' + file);
        }
      } catch (err) {
        failed.push({ id: fw.id, error: 'ensureInstructions: ' + err.message });
      }
    }

    wired.push(result);
  }

  return { wired, skipped, failed, stanza, dryRun };
}

module.exports = {
  instructionSection,
  mergeMcpJson,
  writeInstructionSection,
  wireupAll,
};
