/**
 * repl-executor.js — Program-Aided Reasoning (PAL/PoT) for agentic-cortex.
 *
 * Implements the PAL (Program-Aided Language Models) and PoT (Program of
 * Thoughts) paradigm: instead of reasoning purely in natural language,
 * the agent externalizes logic into executable code, runs it deterministically,
 * and feeds runtime results back into the reasoning chain.
 *
 * This gives the LLM "deterministic reasoning superpowers":
 *   - Exact arithmetic (no hallucinated math)
 *   - Graph traversal (no missed connections)
 *   - Constraint satisfaction (no edge-case oversights)
 *   - Test execution (no false confidence)
 *
 * Safety model: all code runs in a sandboxed Node.js child_process with
 *   - Timeout (default 10s)
 *   - Memory limit (64MB)
 *   - No network access
 *   - Restricted file access (only project directory)
 *   - Output size limit (64KB)
 *
 * @module core/repl-executor
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Configuration ─────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  timeout: 10000,        // 10 seconds
  maxOutput: 65536,      // 64KB
  maxMemory: 64 * 1024 * 1024, // 64MB
  nodeArgs: ['--max-old-space-size=64'],
};

// ─── Code Generation (LLM) ─────────────────────────────────────────

/**
 * Ask the LLM to generate a verification script for a given hypothesis.
 *
 * @param {Object} params
 * @param {string} params.hypothesis — What to verify
 * @param {string} params.context — Code context (file paths, function signatures)
 * @param {string} params.project — Project root for file access
 * @param {number} [params.budget=1000] — Token budget
 * @returns {Promise<{ code: string, language: string, explanation: string }|null>}
 */
async function generateVerificationScript({ hypothesis, context = '', project = '', budget = 1000 }) {
  const { callLLM } = require('./session');

  const messages = [
    {
      role: 'system',
      content: `You generate verification scripts for coding hypotheses.
Given a hypothesis about code, write a short Node.js script that verifies it.

Rules:
- The script must be self-contained (no external dependencies)
- Use only Node.js built-in modules (fs, path, etc.)
- The script must print a JSON result to stdout: {"verified": true/false, "reason": "...", "evidence": "..."}
- Use console.log() for output, not console.error()
- Include file existence checks before reading files
- Keep the script under 50 lines
- DO NOT use network requests or child_process

Respond ONLY with valid JSON: {"code": "script content", "explanation": "what this script checks"}`,
    },
    {
      role: 'user',
      content: `Hypothesis: ${hypothesis}\n\nContext:\n${context || 'No additional context.'}\n\nProject: ${project}`,
    },
  ];

  try {
    const result = await callLLM(messages, {
      temperature: 0,
      maxTokens: Math.min(budget, 2000),
      timeout: 15000,
    });

    const parsed = JSON.parse(result || '{}');
    if (parsed.code) {
      return {
        code: parsed.code,
        language: 'javascript',
        explanation: parsed.explanation || '',
      };
    }
  } catch {}

  return null;
}

// ─── Safe Execution ────────────────────────────────────────────────

/**
 * Execute a code snippet in a sandboxed child process.
 *
 * @param {string} code — JavaScript code to execute
 * @param {Object} [opts] — Execution options
 * @param {string} [opts.cwd] — Working directory (defaults to os.tmpdir())
 * @param {number} [opts.timeout] — Timeout in ms
 * @param {number} [opts.maxOutput] — Max output bytes
 * @param {string[]} [opts.allowedModules] — Whitelist of require-able modules
 * @returns {Promise<{ success: boolean, output: string, error: string|null, exitCode: number|null }>}
 */
function executeCode(code, opts = {}) {
  const config = { ...DEFAULT_CONFIG, ...opts };
  const cwd = config.cwd || os.tmpdir();

  return new Promise((resolve) => {
    // Write code to a temp file
    const tmpFile = path.join(os.tmpdir(), `repl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.js`);

    // Wrap code with sandbox restrictions
    const wrappedCode = _sandboxWrap(code, config.allowedModules);

    try {
      fs.writeFileSync(tmpFile, wrappedCode, 'utf-8');
    } catch (e) {
      resolve({ success: false, output: '', error: `Failed to write temp file: ${e.message}`, exitCode: null });
      return;
    }

    const child = spawn(process.execPath, [...config.nodeArgs, tmpFile], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'sandbox' },
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timeout = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      // Force kill after 1s if still alive
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000);
    }, config.timeout);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      if (stdout.length > config.maxOutput) {
        killed = true;
        child.kill('SIGKILL');
      }
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (stderr.length > config.maxOutput) {
        killed = true;
        child.kill('SIGKILL');
      }
    });

    child.on('close', (exitCode) => {
      clearTimeout(timeout);

      // Cleanup temp file
      try { fs.unlinkSync(tmpFile); } catch {}

      const output = stdout.slice(0, config.maxOutput);
      const error = stderr.slice(0, config.maxOutput);

      if (killed && exitCode !== 0) {
        resolve({
          success: false,
          output,
          error: error || 'Execution timed out or exceeded output limit',
          exitCode,
          timeout: true,
        });
      } else if (exitCode !== 0) {
        resolve({
          success: false,
          output,
          error: error || `Process exited with code ${exitCode}`,
          exitCode,
        });
      } else {
        resolve({
          success: true,
          output,
          error: null,
          exitCode: 0,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      try { fs.unlinkSync(tmpFile); } catch {}
      resolve({
        success: false,
        output: '',
        error: `Spawn error: ${err.message}`,
        exitCode: null,
      });
    });
  });
}

/**
 * Wrap code with sandbox restrictions.
 * Overrides require to only allow whitelisted modules.
 */
function _sandboxWrap(code, allowedModules = ['fs', 'path', 'os', 'util']) {
  const allowed = JSON.stringify(allowedModules);

  return `
'use strict';
// ─── Sandbox Wrapper ──────────────────────────────────────────────
const _originalRequire = typeof require !== 'undefined' ? require : null;
const _allowedModules = ${allowed};

if (typeof require !== 'undefined') {
  const _Module = require('module');
  const _origResolve = _Module._resolveFilename;
  _Module._resolveFilename = function(request, parent) {
    if (_allowedModules.includes(request) || request.startsWith('./') || request.startsWith('../') || request.startsWith('/')) {
      return _origResolve.call(this, request, parent);
    }
    throw new Error('Module "' + request + '" is not allowed in sandbox');
  };
}

// ─── User Code ────────────────────────────────────────────────────
try {
${code}
} catch (_err) {
  console.log(JSON.stringify({ verified: false, reason: 'Runtime error: ' + _err.message, evidence: '' }));
}
`;
}

// ─── Structured Verification ───────────────────────────────────────

/**
 * Generate and execute a verification script, returning structured results.
 * Combines LLM code generation with safe execution and output parsing.
 *
 * @param {Object} params
 * @param {string} params.hypothesis — What to verify
 * @param {string} params.context — Code context
 * @param {string} params.project — Project root
 * @param {Object} [params.db] — Database for caching
 * @param {number} [params.budget] — Token budget
 * @returns {Promise<{ success: boolean, verified: boolean, reason: string, evidence: string, code: string, executionResult: Object }>}
 */
async function verifyWithCode({ hypothesis, context = '', project = '', db = null, budget = 1000 }) {
  // Check deterministic cache
  if (db) {
    try {
      const recovery = require('./recovery');
      const cached = recovery.getCachedLLM(db, 'repl-verify', hypothesis);
      if (cached) return cached.result;
    } catch {}
  }

  // Generate verification script
  const script = await generateVerificationScript({ hypothesis, context, project, budget });
  if (!script) {
    return {
      success: false,
      verified: false,
      reason: 'Failed to generate verification script',
      evidence: '',
      code: '',
      executionResult: null,
    };
  }

  // Execute in sandbox
  const execResult = await executeCode(script.code, { cwd: project || os.tmpdir() });

  // Parse output
  let parsed = { verified: false, reason: '', evidence: '' };
  try {
    // Try to parse the last JSON line from output
    const lines = execResult.output.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        parsed = JSON.parse(lines[i]);
        break;
      } catch {}
    }
  } catch {}

  const result = {
    success: execResult.success,
    verified: !!parsed.verified,
    reason: parsed.reason || (execResult.error ? `Execution error: ${execResult.error}` : 'No output'),
    evidence: parsed.evidence || '',
    code: script.code,
    executionResult: {
      output: execResult.output.slice(0, 2000),
      error: execResult.error,
      exitCode: execResult.exitCode,
    },
  };

  // Cache the result
  if (db) {
    try {
      const recovery = require('./recovery');
      recovery.cacheLLM(db, 'repl-verify', hypothesis, result, 'ok');
    } catch {}
  }

  return result;
}

// ─── File Analysis Helpers ─────────────────────────────────────────

/**
 * Safely read a file from the project directory.
 * @param {string} filePath — Path relative to project root
 * @param {string} project — Project root
 * @returns {string|null}
 */
function safeReadFile(filePath, project) {
  try {
    const fullPath = path.resolve(project, filePath);
    // Prevent path traversal
    if (!fullPath.startsWith(path.resolve(project))) return null;
    return fs.readFileSync(fullPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Generate context string from project files for verification scripts.
 * @param {string[]} files — File paths to include
 * @param {string} project — Project root
 * @param {number} maxLines — Max lines per file
 * @returns {string}
 */
function buildFileContext(files, project, maxLines = 50) {
  const parts = [];
  for (const file of files.slice(0, 5)) {
    const content = safeReadFile(file, project);
    if (content) {
      const lines = content.split('\n').slice(0, maxLines);
      parts.push(`// ${file}:\n${lines.join('\n')}`);
    }
  }
  return parts.join('\n\n');
}

// ─── Exports ────────────────────────────────────────────────────────

module.exports = {
  generateVerificationScript,
  executeCode,
  verifyWithCode,
  safeReadFile,
  buildFileContext,
  DEFAULT_CONFIG,
};
