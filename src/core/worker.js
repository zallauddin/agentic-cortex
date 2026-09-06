/**
 * worker.js — Real agent-process workers for swarm task execution.
 *
 * Turns a swarm persona from a *logical* agent (in-process reasoning engine
 * producing text) into a *real* agent: a headless subprocess of an installed
 * coding-agent harness with file
 * editing, shell, and test-running tools — so the coder persona actually
 * edits files and the tester actually runs tests.
 *
 * The capability manifest (./manifest) is the source of truth for WHAT is on
 * this machine (discoverFrameworks) and HOW to compose with each framework
 * (composeWithFramework → the MCP wiring + tool lists). This module adds the
 * launch layer: per-framework CLI templates, binary resolution, spawn with
 * timeout, and structured results that feed the swarm failure loop
 * (classify → retry with backoff → replan → escalate).
 *
 * Worker selection (in order of precedence):
 *   1. opts.worker           — explicit { command, args?, env?, timeoutMs?, cwd?, framework? }
 *   2. opts.workerFramework  — framework id ('claude-code', 'opencode', 'cursor')
 *   3. env AGENTIC_CORTEX_WORKER — framework id, 'off', or JSON worker config
 *
 * Worker mode is opt-in:
 *   - opts.workerMode = 'process' | 'in-process'
 *   - env AGENTIC_CORTEX_WORKER_MODE = 'process' | 'in-process'
 *   - setting AGENTIC_CORTEX_WORKER (non-off) implies mode 'process'.
 * Default is 'in-process' (the reasoning engines) so nothing spawns
 * unexpectedly.
 *
 * @module core/worker
 */

'use strict';

const { execFile, execSync } = require('child_process');
const path = require('path');
const manifest = require('./manifest');

// ─── Framework launcher registry ──────────────────────────────────────

/**
 * Per-framework launch templates. `buildArgs(prompt, opts)` returns the argv
 * for the headless agent CLI. Override anything via opts.worker.
 */
const WORKER_FRAMEWORKS = {
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    buildArgs: (prompt, opts) => [
      '-p', prompt,
      '--output-format', 'json',
      '--permission-mode', opts.permissionMode || 'acceptEdits',
    ],
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    buildArgs: (prompt) => ['run', prompt],
  },
  cursor: {
    id: 'cursor',
    name: 'Cursor',
    command: 'cursor-agent',
    buildArgs: (prompt) => ['run', prompt],
  },
  'gemini-cli': {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    command: 'gemini',
    buildArgs: (prompt) => ['-p', prompt, '--yolo'],
  },
  codex: {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    command: 'codex',
    buildArgs: (prompt) => ['exec', '--full-auto', prompt],
  },
  'copilot-cli': {
    id: 'copilot-cli',
    name: 'GitHub Copilot CLI',
    command: 'copilot',
    buildArgs: (prompt) => ['--prompt', prompt, '--allow-all-tools'],
  },
  'amazon-q': {
    id: 'amazon-q',
    name: 'Amazon Q Developer',
    command: 'q',
    buildArgs: (prompt) => ['chat', '--no-interactive', prompt],
  },
  goose: {
    id: 'goose',
    name: 'Goose (Block)',
    command: 'goose',
    buildArgs: (prompt) => ['run', '--text', prompt],
  },
  amp: {
    id: 'amp',
    name: 'Amp (Sourcegraph)',
    command: 'amp',
    buildArgs: (prompt) => ['--dangerously-allow-all', prompt],
  },
  crush: {
    id: 'crush',
    name: 'Crush (Charm)',
    command: 'crush',
    buildArgs: (prompt) => ['run', prompt],
  },
  // Cortex (the deterministic os/code-quality agent). Its worker bin is a
  // subprocess that boots the real cortex machinery (memory consult → FSM →
  // codemod → verify → learn) for each swarm persona role, so a swarm task
  // executes as a separate cortex agent process rather than an in-process
  // reasoning engine.
  //
  // Requires the cortex `bin` on PATH (e.g. `npm link` in cortex-os-agent).
  // If not linked, pass an explicit { command: 'node', args: [workerPath, …] }
  // via opts.worker — swarm-commander.jss does exactly that so no global link
  // is required.
  cortex: {
    id: 'cortex',
    name: 'Cortex (deterministic agent)',
    command: 'cortex',
    buildArgs: (prompt) => ['worker', '-p', prompt, '--json'],
  },
};

const DEFAULT_TIMEOUT_MS = 120000;

// ─── Binary resolution ────────────────────────────────────────────────

/**
 * Resolve a command name to an absolute path via PATH (handles npm shims on
 * Windows where spawn/execFile refuse to run .cmd files without a shell).
 *
 * @param {string} cmd
 * @returns {string|null}
 */
function _resolveBinary(cmd) {
  if (!cmd) return null;
  if (path.isAbsolute(cmd)) return cmd;
  try {
    const result = process.platform === 'win32'
      ? execSync(`where ${cmd}`, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
      : execSync(`which ${cmd}`, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    const first = (result.trim().split(/\r?\n/)[0] || '').trim();
    return first || null;
  } catch {
    return null;
  }
}

// ─── Env-driven worker config ─────────────────────────────────────────

/**
 * Parse AGENTIC_CORTEX_WORKER into a worker config object (or null for off).
 */
function _envWorker() {
  const v = process.env.AGENTIC_CORTEX_WORKER;
  if (!v || v === 'off' || v === '0') return null;
  if (v.trim().startsWith('{')) {
    try { return JSON.parse(v); } catch { /* fall through to framework id */ }
  }
  return { framework: v };
}

/**
 * Resolve the effective worker mode ('process' | 'in-process').
 *
 * @param {Object} [opts]
 * @returns {'process'|'in-process'}
 */
function workerMode(opts = {}) {
  if (opts.workerMode === 'process' || opts.workerMode === 'in-process') return opts.workerMode;
  const envMode = process.env.AGENTIC_CORTEX_WORKER_MODE;
  if (envMode === 'process' || envMode === 'in-process') return envMode;
  const envWorker = _envWorker();
  return envWorker ? 'process' : 'in-process';
}

/**
 * Build a worker spec from an explicit worker config object.
 *
 * @param {Object} cfg — { framework?, command, args?, env?, timeoutMs?, cwd?, permissionMode? }
 * @param {Object} [opts]
 * @returns {Object} worker spec (see resolveWorker)
 */
function _specFromConfig(cfg, opts) {
  const fwId = cfg.framework || 'custom';
  const framework = WORKER_FRAMEWORKS[fwId] || null;
  const command = cfg.command || (framework ? framework.command : null);
  if (!command) return null;

  const project = path.resolve(opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd());
  let argsBuilder;
  if (Array.isArray(cfg.args)) {
    argsBuilder = (prompt) => cfg.args.map(a => (typeof a === 'string' && a.includes('__PROMPT__') ? a.replaceAll('__PROMPT__', prompt) : a));
  } else if (framework && typeof framework.buildArgs === 'function') {
    argsBuilder = (prompt, o) => framework.buildArgs(prompt, o);
  } else {
    argsBuilder = (prompt) => [prompt];
  }

  const binary = _resolveBinary(command);
  const plan = fwId && WORKER_FRAMEWORKS[fwId]
    ? manifest.composeWithFramework(fwId, { project })
    : null;

  return {
    frameworkId: fwId,
    frameworkName: framework ? framework.name : fwId,
    command,
    binary,
    available: !!binary,
    argsBuilder,
    argsPreview: argsBuilder('<prompt>', cfg),
    cwd: cfg.cwd ? path.resolve(cfg.cwd) : project,
    env: cfg.env || {},
    timeoutMs: cfg.timeoutMs || parseInt(process.env.AGENTIC_CORTEX_WORKER_TIMEOUT_MS || '0', 10) || DEFAULT_TIMEOUT_MS,
    permissionMode: cfg.permissionMode,
    plan,
    source: 'explicit',
  };
}

/**
 * Resolve which worker should execute the next task, or null for in-process.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.worker] — explicit worker config
 * @param {string} [opts.workerFramework] — framework id
 * @param {string} [opts.project]
 * @returns {Object|null} worker spec
 */
function resolveWorker(opts = {}) {
  if (opts.worker && typeof opts.worker === 'object') {
    return _specFromConfig(opts.worker, opts);
  }

  let cfg = null;
  if (opts.workerFramework) {
    cfg = { framework: opts.workerFramework };
  } else {
    cfg = _envWorker();
  }
  if (!cfg) return null;

  if (cfg.framework && !cfg.command) {
    const fw = WORKER_FRAMEWORKS[cfg.framework];
    if (!fw) return null;
    return _specFromConfig({ framework: cfg.framework, ...cfg }, opts);
  }
  return _specFromConfig(cfg, opts);
}

// ─── Execution ────────────────────────────────────────────────────────

/**
 * Run a worker subprocess for a task. The prompt is passed as the headless
 * agent's instruction; the working directory is the project, so file edits
 * and test runs land in the real checkout. Enforces a timeout by killing the
 * child (execFile handles the kill); the result is structured for the swarm
 * failure loop.
 *
 * @param {Object} spec — from resolveWorker()
 * @param {string} prompt — the persona task instruction
 * @param {Object} [opts]
 * @param {string} [opts.session]
 * @returns {Promise<{ ok: boolean, output: string, stderr: string, exitCode: number|string, timedOut: boolean, durationMs: number, error: string|null }>}
 */
function runWorker(spec, prompt, opts = {}) {
  return new Promise((resolve) => {
    const args = spec.argsBuilder ? spec.argsBuilder(prompt, opts) : [prompt];
    const env = {
      ...process.env,
      ...spec.env,
      AGENTIC_CORTEX_PROJECT: spec.cwd,
      AGENTIC_CORTEX_WORKER_PROMPT: prompt,
    };
    if (opts.session) env.AGENTIC_CORTEX_SESSION = opts.session;

    const cmd = spec.binary || spec.command;
    const timeoutMs = spec.timeoutMs || DEFAULT_TIMEOUT_MS;
    const t0 = Date.now();

    execFile(cmd, args, {
      cwd: spec.cwd,
      env,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      const durationMs = Date.now() - t0;
      const output = (stdout || '').trim();
      const errText = (stderr || '').trim();
      // Timeout detection: err.killed/signal are unreliable on some platforms
      // (Windows reports nulls), so elapsed-duration is the ground truth.
      const timedOut = !!err && (err.killed === true || err.signal === 'SIGTERM' || err.signal === 'SIGKILL' || durationMs >= timeoutMs);
      if (!err) {
        resolve({ ok: true, output, stderr: errText, exitCode: 0, timedOut: false, durationMs, error: null });
        return;
      }
      const error = timedOut
        ? `worker timed out after ${timeoutMs}ms (${spec.frameworkId || spec.command})`
        : (errText || (err.code != null ? `worker exited with code ${err.code}` : `worker failed: ${err.message}`));
      resolve({
        ok: false,
        output,
        stderr: errText,
        exitCode: timedOut ? 'timeout' : (err.code != null ? err.code : err.signal || 'error'),
        timedOut,
        durationMs,
        error,
      });
    });
  });
}

// ─── Introspection (for CLI/MCP) ──────────────────────────────────────

/**
 * Describe the worker wiring: enabled mode, resolved worker (if any), and
 * which frameworks were discovered on the machine. Read-only, zero side
 * effects — safe for MCP tools and bootstrap.
 *
 * @param {Object} [opts]
 * @returns {Object}
 */
function workerInfo(opts = {}) {
  const mode = workerMode(opts);
  const spec = resolveWorker(opts);
  const project = path.resolve(opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd());
  return {
    enabled: mode === 'process',
    mode,
    workerEnv: process.env.AGENTIC_CORTEX_WORKER || null,
    timeoutEnvMs: process.env.AGENTIC_CORTEX_WORKER_TIMEOUT_MS || null,
    resolved: spec ? {
      framework: spec.frameworkId,
      frameworkName: spec.frameworkName,
      command: spec.binary || spec.command,
      args: spec.argsPreview,
      cwd: spec.cwd,
      timeoutMs: spec.timeoutMs,
      available: spec.available,
      memoryTools: spec.plan && spec.plan.wiring ? (spec.plan.wiring.memoryTools || []) : [],
    } : null,
    discoveredFrameworks: manifest.discoverFrameworks({ project }).map(f => f.id),
  };
}

// ─── Exports ──────────────────────────────────────────────────────────

module.exports = {
  WORKER_FRAMEWORKS,
  DEFAULT_TIMEOUT_MS,
  workerMode,
  resolveWorker,
  runWorker,
  workerInfo,
};
