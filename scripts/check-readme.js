#!/usr/bin/env node
/**
 * check-readme.js — "The README agrees with the code" (YOINK-inspired).
 *
 * Every measurable claim in README.md is recomputed from the codebase and
 * compared. Exits 1 if any claim has drifted. Run in CI:
 *
 *   node scripts/check-readme.js
 *
 * Checks (extend as the README grows more numbers):
 *   - MCP tool count (TOOLS array in src/mcp/server.js + tool names)
 *   - CLI command count (commands object keys in cli.js)
 *   - test file count (tests/*.test.js)
 *   - memory types count (src/core/constants.js VALID_TYPES)
 *   - prompt template count (src/core/prompts.js)
 *
 * Numeric claims are parsed from the README with regexes listed in CHECKS.
 * If the README no longer contains a claim's pattern, the check is skipped
 * (removing the number removes the obligation).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const readmePath = path.join(root, 'README.md');
const readme = fs.readFileSync(readmePath, 'utf8');

const failures = [];
const skipped = [];

function readSafe(file) {
  try { return fs.readFileSync(path.join(root, file), 'utf8'); } catch { return ''; }
}

/**
 * Count occurrences of a name pattern in a source file's text.
 */
function countMatches(src, regex) {
  const m = src.match(regex);
  return m ? m.length : 0;
}

// ─── MCP tool count ──────────────────────────────────────────────────────
// README claims a specific number of MCP tools. Count the TOOLS array
// entries by `name:` fields inside it (source-parsed — importing the server
// would start the stdio listener).
{
  const serverSrc = readSafe('src/mcp/server.js');
  const toolsBlockMatch = serverSrc.match(/const TOOLS = \[([\s\S]*?)\n\];/);
  if (!toolsBlockMatch) {
    skipped.push('mcp tools: could not locate TOOLS array in src/mcp/server.js');
  } else {
    const actual = countMatches(toolsBlockMatch[1], /\n    name: '/g);
    const readmeMatch = readme.match(/\*\*(\d+)\+? MCP tools?\*\*/i) || readme.match(/(\d+) tools\*\* over stdio/i);
    if (readmeMatch) {
      const claimed = parseInt(readmeMatch[1], 10);
      if (actual !== claimed) {
        failures.push('MCP tools: README says ' + claimed + ', code defines ' + actual + ' (src/mcp/server.js TOOLS array)');
      }
    } else {
      skipped.push('mcp tools: no tool-count claim found in README');
    }
  }
}

// ─── CLI command count ───────────────────────────────────────────────────
{
  const cliSrc = readSafe('cli.js');
  const actual = countMatches(cliSrc, /^commands\.[a-zA-Z_$][\w$]* = \{/gm);
  const readmeMatch = readme.match(/cli\.js<br?\/?>\s*(\d+)\+? commands/i) || readme.match(/cli\.js[^\n]*?(\d+)\+? commands/i);
  if (readmeMatch) {
    const claimed = parseInt(readmeMatch[1], 10);
    if (actual < claimed) {
      failures.push('CLI commands: README says ' + claimed + '+, code defines ' + actual + ' (cli.js commands object)');
    }
  } else {
    skipped.push('cli commands: no command-count claim found in README');
  }
}

// ─── Test count ──────────────────────────────────────────────────────────
{
  const testsDir = path.join(root, 'tests');
  let testFiles = 0;
  try {
    testFiles = fs.readdirSync(testsDir).filter(f => f.endsWith('.test.js')).length;
  } catch { /* no tests dir */ }
  const readmeMatch = readme.match(/~?(\d+)\s+tests/i);
  if (readmeMatch) {
    const claimed = parseInt(readmeMatch[1], 10);
    if (testFiles < claimed) {
      failures.push('test files: README claims ~' + claimed + ' tests, tests/ holds ' + testFiles + ' test files');
    }
  } else {
    skipped.push('test count: no test-count claim found in README');
  }
}

// ─── Memory types ────────────────────────────────────────────────────────
{
  const constantsSrc = readSafe('src/core/constants.js');
  const typesMatch = constantsSrc.match(/const VALID_TYPES = new Set\(\[([\s\S]*?)\]\);/);
  if (typesMatch) {
    const actualUnique = new Set([...typesMatch[1].matchAll(/'([a-z_-]+)'/g)].map(x => x[1])).size;
    // README lists types in the "Memory Types" section; count backticked
    // types on the list line immediately after the header (not the tiered
    // table below it).
    const sectionMatch = readme.match(/## (?:\d+ )?Memory Types\n\n([^\n]+)/);
    if (sectionMatch) {
      const backticked = countMatches(sectionMatch[1], /`[a-z_-]+`/g);
      if (backticked !== actualUnique) {
        failures.push('memory types: README section lists ' + backticked + ', constants.js defines ' + actualUnique + ' unique types');
      }
    } else {
      skipped.push('memory types: no Memory Types section in README');
    }
  } else {
    skipped.push('memory types: could not locate VALID_TYPES in constants.js');
  }
}

// ─── Prompt templates ────────────────────────────────────────────────────
{
  const promptsSrc = readSafe('src/core/prompts.js');
  const actual = countMatches(promptsSrc, /name: '/g);
  const readmeMatch = readme.match(/(\d+) versioned[ ,]/i);
  if (readmeMatch) {
    const claimed = parseInt(readmeMatch[1], 10);
    if (actual !== claimed) {
      failures.push('prompt templates: README says ' + claimed + ', src/core/prompts.js defines ' + actual);
    }
  } else {
    skipped.push('prompt templates: no template-count claim found in README');
  }
}

// ─── Report ──────────────────────────────────────────────────────────────
if (skipped.length > 0) {
  console.log('skipped (no claim in README):');
  for (const s of skipped) console.log('  · ' + s);
}
if (failures.length > 0) {
  console.error('\nREADME disagrees with the code:');
  for (const f of failures) console.error('  ✗ ' + f);
  console.error('\nFix the README or the code — every number above was computed, not written.');
  process.exit(1);
}
console.log('\nREADME agrees with the code.');
