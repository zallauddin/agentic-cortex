#!/usr/bin/env node
/**
 * auto-setup.js — Postinstall auto-discovery for agentic-cortex.
 *
 * Runs automatically when agentic-cortex is installed as a dependency
 * (npm install agentic-cortex). Checks if knowledge.md exists in the
 * parent project and creates it if not, installs git hooks, and generates
 * the codebase graph. Zero user action needed.
 *
 * Triggered by: package.json "postinstall" script
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Shared discovery files module (also used by cli.js setup command)
const { createDiscoveryFiles } = require('./create-discovery-files');

// --- H1: Detect parent project directory across npm / yarn berry / bun ---

/**
 * Walk upward from this package's directory looking for a parent project's
 * package.json (one whose name isn't agentic-cortex itself).
 * @returns {string|null} The parent project directory, or null if not found
 */
function detectParentProject() {
  // npm_config_local_prefix: yarn berry / bun
  if (process.env.npm_config_local_prefix) {
    return process.env.npm_config_local_prefix;
  }
  // Walk upward from __dirname looking for package.json that isn't ours
  let dir = path.resolve(__dirname, '..');
  for (let i = 0; i < 10; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.name !== 'agentic-cortex' && !pkg.name.startsWith('agentic-cortex-')) {
          return dir;
        }
      } catch {
        // Corrupt package.json — keep walking
      }
    }
    dir = parent;
  }
  return null;
}

// INIT_CWD is set by npm; npm_config_local_prefix covers yarn berry / bun;
// detectParentProject() walks upward as a last resort.
const projectDir = process.env.INIT_CWD
  || process.env.npm_config_local_prefix
  || detectParentProject()
  || process.cwd();

// Only run auto-setup if we're being installed INTO another project
// (not when agentic-cortex installs its own dev dependencies)
const isDependencyInstall = projectDir !== path.resolve(__dirname, '..');
if (!isDependencyInstall) {
  // We're in agentic-cortex's own directory — skip
  process.exit(0);
}

const knowledgePath = path.join(projectDir, 'knowledge.md');
const templatePath = path.join(__dirname, '..', 'templates', 'knowledge.md');
const cliPath = path.resolve(__dirname, '..', 'cli.js');

// --- M4: Only skip knowledge.md creation when file already exists ---
// Always run git hooks and discovery files (both are idempotent).
// FORCE_SETUP=1 forces a full re-run even when knowledge.md exists.

const skipKnowledge = fs.existsSync(knowledgePath) && process.env.FORCE_SETUP !== '1';

console.error('[agentic-cortex] Auto-setup triggered by postinstall in ' + projectDir);

let criticalError = false;

// --- Steps that are skipped when knowledge.md already exists ---

if (!skipKnowledge) {
  // Step 1: Create knowledge.md from template
  try {
    if (fs.existsSync(templatePath)) {
      fs.copyFileSync(templatePath, knowledgePath);
      console.error('[agentic-cortex]   created knowledge.md');
    } else {
      // Minimal fallback
      const minimal = '# Agentic Cortex Memory Instructions\n\n## Persistent Memory\n\nUse `agentic-cortex save` to persist observations.\nAt session start, check below for injected context.\n\n<!-- MEMORY_CONTEXT_START -->\n<!-- MEMORY_CONTEXT_END -->\n';
      fs.writeFileSync(knowledgePath, minimal, 'utf-8');
      console.error('[agentic-cortex]   created minimal knowledge.md (template not found)');
    }
  } catch (err) {
    console.error('[agentic-cortex]   knowledge.md creation FAILED: ' + err.message);
    criticalError = true;
  }

  // Step 2: Generate codebase graph (non-critical)
  try {
    const graphScript = path.join(__dirname, 'generate-graph.mjs');
    if (fs.existsSync(graphScript)) {
      execSync('node "' + graphScript + '" --output xml', {
        encoding: 'utf-8',
        timeout: 30000,
        cwd: projectDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      console.error('[agentic-cortex]   codebase graph generated');
    }
  } catch (err) {
    console.error('[agentic-cortex]   graph generation skipped: ' + (err.message || '').split('\n')[0]);
  }

  // Step 3: Inject context (non-critical)
  try {
    const injectScript = path.join(__dirname, 'inject-memory.mjs');
    if (fs.existsSync(injectScript)) {
      execSync('node "' + injectScript + '" "' + projectDir.replace(/\\/g, '/') + '"', {
        encoding: 'utf-8',
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      console.error('[agentic-cortex]   context injected into knowledge.md');
    }
  } catch (err) {
    if (err.stdout) process.stderr.write(err.stdout.toString());
    console.error('[agentic-cortex]   injection completed with warnings');
  }
} else {
  console.error('[agentic-cortex] knowledge.md already exists at ' + knowledgePath + ' — skipping knowledge.md creation, graph gen, and injection');
}

// --- Steps that ALWAYS run (idempotent) ---

// Step 4: Install git hooks
try {
  const gitDir = path.join(projectDir, '.git');
  if (fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory()) {
    const hookDir = path.join(gitDir, 'hooks');
    if (!fs.existsSync(hookDir)) fs.mkdirSync(hookDir, { recursive: true });

    // C3 + H2: Use absolute path to cli.js; redirect stderr to log file
    const hookContent = '#!/bin/sh\n# Auto-generated by agentic-cortex auto-setup\nnode "' + cliPath + '" inject >> "$HOME/.agentic-cortex/hooks.log" 2>&1 || true\n';
    const hookNames = ['post-merge', 'post-checkout', 'post-rewrite', 'post-commit'];
    let installed = 0;
    for (const hookName of hookNames) {
      const hookPath = path.join(hookDir, hookName);
      if (!fs.existsSync(hookPath)) {
        fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
        installed++;
      }
    }
    if (installed > 0) {
      console.error('[agentic-cortex]   installed ' + installed + ' git hooks');
    }
  }
} catch (err) {
  console.error('[agentic-cortex]   git hooks skipped: ' + err.message);
}

// Step 5: Create multi-agent discovery files (non-critical but always run)
try {
  const created = createDiscoveryFiles(projectDir);
  for (const f of created) {
    console.error('[agentic-cortex]   created ' + f);
  }
} catch (err) {
  console.error('[agentic-cortex]   discovery files FAILED: ' + err.message);
  criticalError = true;
}

// --- C4: Exit with appropriate code ---
if (criticalError) {
  console.error('[agentic-cortex] Auto-setup finished with critical errors — see above');
  process.exit(1);
}

console.error('[agentic-cortex] Auto-setup complete! Agent context is ready.');
console.log(JSON.stringify({
  status: 'auto_setup_complete',
  project: projectDir,
  knowledgeMd: knowledgePath,
  message: 'agentic-cortex is now active in this project. Agents will discover it automatically.',
}));
process.exit(0);
