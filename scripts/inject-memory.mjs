#!/usr/bin/env node
/**
 * inject-memory.mjs — Auto-inject memory context AND codebase graph into knowledge.md
 * 
 * Two-layer injection:
 *   1. Session memories from agentic-cortex (persistent cross-session agent memory)
 *   2. Codebase structure graph (deterministic, cached, no LLM cost)
 *
 * Run this before launching your AI coding agent to pre-load full context.
 * Usage: node scripts/inject-memory.mjs [project-path]
 */

import { execFileSync, execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

// Resolve script directory for ESM compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// DON'T use resolve() — it converts forward slashes to backslashes on Windows,
// breaking the path match against the database which stores forward slashes.
const rawPath = process.argv[2] || process.cwd();
const projectPath = rawPath.replace(/\\/g, '/');
// Resolve agentic-cortex CLI: prefer locally installed, fall back to global, then homedir
const localCliPath = join(rawPath, 'node_modules', 'agentic-cortex', 'cli.js');
const globalCliPath = execSync('npm root -g', { encoding: 'utf-8' }).trim()
  .replace(/\\/g, '/') + '/agentic-cortex/cli.js';
const homedirCliPath = join(homedir(), '.agentic-cortex', 'cli.js');
const memCli = existsSync(localCliPath) ? localCliPath
  : existsSync(globalCliPath) ? globalCliPath
  : (() => {
    try {
      const whichPath = execSync('which agentic-cortex 2>/dev/null || where agentic-cortex 2>nul', { encoding: 'utf-8' }).trim();
      return whichPath || localCliPath;
    } catch { return localCliPath; }
  })();
const knowledgePath = join(rawPath, 'knowledge.md');
const graphScript = join(__dirname, 'generate-graph.mjs');

if (!existsSync(knowledgePath)) {
  console.error('[inject-memory] knowledge.md not found at', knowledgePath);
  process.exit(1);
}

if (!existsSync(memCli)) {
  console.error('[inject-memory] agentic-cortex CLI not found at', memCli);
  process.exit(1);
}

// ─── Layer 1: Session memories from agentic-cortex ──────────────────

// Accept an optional --query argument for adaptive context retrieval.
// Usage: node inject-memory.mjs [project-path] [--query "what I'm working on"]
// Supports both --query value and --query=value syntax
let taskQuery = '';
const queryIdx = process.argv.findIndex(a => a === '--query' || a.startsWith('--query='));
if (queryIdx !== -1) {
  const arg = process.argv[queryIdx];
  if (arg.startsWith('--query=')) {
    taskQuery = arg.slice('--query='.length);
  } else if (queryIdx + 1 < process.argv.length) {
    taskQuery = process.argv[queryIdx + 1];
  }
}

let sessionContext = '';
try {
  const contextArgs = [memCli, 'context', projectPath];
  // Pass --query for adaptive context if available (Phase 1: task-aware retrieval)
  if (taskQuery) {
    contextArgs.push('--query', taskQuery);
  }
  sessionContext = execFileSync('node', contextArgs, {
    encoding: 'utf-8',
    timeout: 30000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
} catch (err) {
  if (err.stdout) {
    sessionContext = err.stdout.toString().trim();
  }
  if (!sessionContext) {
    console.error('[inject-memory] Failed to generate session context:', (err.message || '').split('\n')[0]);
    // Non-fatal — proceed with graph alone
  }
}

const hasMemories = sessionContext && !sessionContext.includes('_No previous memory for this project yet._');

if (taskQuery) {
  console.error('[inject-memory] Task-aware context generated for query: "' + taskQuery + '"');
}

// ─── Layer 2: Codebase structure graph ────────────────────────────

let graphContext = '';
try {
  graphContext = execSync(`node "${graphScript}" --output xml`, {
    encoding: 'utf-8',
    timeout: 30000,
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: rawPath,
  }).trim();
} catch (err) {
  console.error('[inject-memory] Failed to generate codebase graph:', (err.message || '').split('\n')[0]);
  // Non-fatal — proceed with memories alone
}

// ─── Build combined context ──────────────────────────────────────

if (!hasMemories && !graphContext) {
  console.log('[inject-memory] No memories or graph to inject. Skipping.');
  process.exit(0);
}

const timestamp = new Date().toISOString();
let combined = `\n<!-- Auto-injected by agentic-cortex at ${timestamp} -->\n\n`;

if (hasMemories) {
  combined += sessionContext + '\n';
}

if (graphContext) {
  combined += graphContext + '\n';
}

// ─── Inject into knowledge.md ────────────────────────────────────

let knowledge = readFileSync(knowledgePath, 'utf-8');

const startMarker = '<!-- MEMORY_CONTEXT_START -->';
const endMarker = '<!-- MEMORY_CONTEXT_END -->';

const startIdx = knowledge.indexOf(startMarker);
const endIdx = knowledge.indexOf(endMarker);

if (startIdx === -1 || endIdx === -1) {
  console.error('[inject-memory] Could not find MEMORY_CONTEXT_START/END markers in knowledge.md');
  process.exit(1);
}

const before = knowledge.slice(0, startIdx + startMarker.length);
const after = knowledge.slice(endIdx);

knowledge = before + combined + after;
writeFileSync(knowledgePath, knowledge, 'utf-8');

console.log('[inject-memory] Injected into knowledge.md:');
console.log('[inject-memory]   Session memories: ' + (hasMemories ? `${sessionContext.length} chars` : 'none'));
console.log('[inject-memory]   Codebase graph:   ' + (graphContext ? `${graphContext.length} chars` : 'none'));
console.log('[inject-memory]   Total injected:   ' + combined.length + ' chars');
console.log('[inject-memory] Project: ' + projectPath);
