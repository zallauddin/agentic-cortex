/**
 * failure-classifier.js — Deterministic failure condition classification + retry gating.
 *
 * Ported from auton/core/lessons.py. When an operation fails, we classify the
 * error into a condition family (network, timeout, file, element, app, auth,
 * parse, other) and extract a probe target (URL, path, app name). The retry
 * gate only offers a re-run when a live probe confirms the underlying cause
 * has changed — so we never blindly push guaranteed-repeat failures.
 *
 * Scope is inherently per-project (project_path), so lessons never leak across
 * projects. A later SUCCESS decays the lesson (counter-evidence).
 *
 * Zero LLM: everything is regex + deterministic probes (HTTP HEAD, socket
 * connect, filesystem stat, which/command lookup).
 *
 * @module core/failure-classifier
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');

// ─── Condition families ──────────────────────────────────────────────

const FAMILIES = [
  'network',   // DNS, connection refused, timeout to a URL/IP
  'timeout',    // operation took too long (non-network)
  'file',       // missing file, no such path, permission denied on read
  'element',    // UI element/selector not found
  'app',        // binary not installed / not found on PATH
  'auth',       // 401/403, permission denied, credentials
  'parse',      // unrecognized command / syntax error
  'other',      // fallback (time-based cooldown)
];

const FAMILY_SET = new Set(FAMILIES);

// ─── Pattern matching per family ─────────────────────────────────────

const PATTERNS = {
  auth: /\b(401|403|unauthorized|permission denied|not authorized|requires confirmation|authentication|credential|access denied|login|unauthenticated)\b/i,
  network: /\b(timed out|timeout|connection refused|connection reset|dns|network|offline|unreachable|no internet|econnrefused|enotfound|econnreset|etimedout)\b/i,
  timeout: /\b(timed out|timeout|took too long|too slow|hung|deadline exceeded|timed? ?out)\b/i,
  file: /\b(no such file|does not exist|missing|not found|failed to open|unable to open|directory|enoent|eperm|eaccess)\b/i,
  element: /\b(element|selector|control|button|field|link|tab)\b.{0,60}\b(not found|not visible|could not (?:be )?(?:find|found)|no such|missing)\b/i,
  app: /\b(not installed|no application|not found in path|unknown application|command not found|is not recognized)\b/i,
  parse: /\b(didn't understand|unknown command|unrecognized|invalid command|unknown intent|syntax error|cannot parse)\b/i,
};

const URL_RE = /https?:\/\/[^\s'"<>]+/i;
const PATH_RE = /(?:[A-Za-z]:[/\\][^\s'"<>|]+|[/\\][^\s'"<>|]{2,})/;

// ─── Kind suggestions ─────────────────────────────────────────────────

const KIND_SUGGESTIONS = {
  network: 'check the network (or whether the target is up), then retry',
  timeout: 'retry with a longer wait or a lighter target',
  file: 'check the path exists (create it if needed) before retrying',
  element: 'wait for the page/UI to load, then retry with the right selector',
  app: 'install the app (or fix its path) before retrying',
  auth: 'fix the credentials / approve access before retrying',
  parse: 'rephrase the command — it is not recognized',
  other: 'check the inputs and retry',
};

// ─── Classification ───────────────────────────────────────────────────

/**
 * Classify an error message into (condition_kind, probe_target, suggestion).
 * Best-effort and conservative: unknown messages fall back to 'other'.
 *
 * @param {string} message — error message to classify
 * @returns {{ kind: string, target: string, suggestion: string }}
 */
function classifyFailure(message) {
  const msg = message || '';
  const low = msg.toLowerCase();

  // Parse: unrecognized command
  if (PATTERNS.parse.test(low)) {
    return { kind: 'parse', target: '', suggestion: KIND_SUGGESTIONS.parse };
  }

  // Auth: permission/credential
  if (PATTERNS.auth.test(low)) {
    return { kind: 'auth', target: '', suggestion: KIND_SUGGESTIONS.auth };
  }

  // Network: URL-based or connectivity
  const url = URL_RE.exec(msg);
  if (url || PATTERNS.network.test(low) && !PATTERNS.file.test(low)) {
    return {
      kind: 'network',
      target: url ? url[0] : '',
      suggestion: KIND_SUGGESTIONS.network,
    };
  }

  // Timeout (non-network)
  if (PATTERNS.timeout.test(low) && !PATTERNS.network.test(low)) {
    return { kind: 'timeout', target: '', suggestion: KIND_SUGGESTIONS.timeout };
  }

  // Element: UI selector not found
  if (PATTERNS.element.test(low)) {
    const m = msg.match(/#[\w-]+/) || msg.match(/['"]([^'"]{1,60})['"]/);
    return {
      kind: 'element',
      target: m ? m[0].replace(/['"]/g, '') : '',
      suggestion: KIND_SUGGESTIONS.element,
    };
  }

  // File: path does not exist
  if (PATTERNS.file.test(low)) {
    const m = PATH_RE.exec(msg);
    return {
      kind: 'file',
      target: m ? m[0].replace(/['"]/g, '') : '',
      suggestion: KIND_SUGGESTIONS.file,
    };
  }

  // App: not installed
  if (PATTERNS.app.test(low)) {
    return { kind: 'app', target: '', suggestion: KIND_SUGGESTIONS.app };
  }

  // Fallback
  return { kind: 'other', target: '', suggestion: KIND_SUGGESTIONS.other };
}

// ─── Live condition probing ───────────────────────────────────────────

const RETRY_COOLDOWN_S = 60.0;

/**
 * Check whether the underlying condition behind a failure has changed.
 * Returns (cleared, detail). The corrected re-run is only OFFERED when
 * `cleared` is true.
 *
 * @param {Object} lesson — { kind, target, lastFailedAt, resolved }
 * @param {number} [cooldownS=60] — min seconds since failure for transient
 * @returns {{ cleared: boolean, detail: string }}
 */
function probeCleared(lesson, cooldownS = RETRY_COOLDOWN_S) {
  if (lesson.resolved) {
    return { cleared: true, detail: 'you marked it resolved' };
  }

  const kind = lesson.kind || lesson.condition_kind || 'other';
  const target = lesson.target || lesson.condition_target || '';
  let elapsed = Infinity;
  try {
    if (lesson.lastFailedAt || lesson.last_failed_at) {
      elapsed = (Date.now() - new Date(lesson.lastFailedAt || lesson.last_failed_at).getTime()) / 1000;
    }
  } catch { /* keep Infinity */ }
  const remaining = cooldownS - elapsed;

  switch (kind) {
    case 'network': {
      // Try HTTP HEAD to the target URL first, then generic DNS probe
      if (target && (target.startsWith('http://') || target.startsWith('https://'))) {
        try {
          return httpProbe(target);
        } catch {
          // fall through to DNS probe
        }
      }
      // Generic connectivity probe: can we reach a public DNS server?
      return tcpProbe('8.8.8.8', 53, 2)
        ? { cleared: true, detail: 'the network is back' }
        : { cleared: false, detail: 'the network still looks down' };
    }

    case 'file': {
      if (target) {
        if (fs.existsSync(target)) {
          return { cleared: true, detail: `'${target}' exists now` };
        }
        return { cleared: false, detail: `'${target}' still does not exist` };
      }
      return { cleared: false, detail: 'the missing file/path may still be missing' };
    }

    case 'app': {
      let available = false;
      if (target) {
        if (target.includes('/') || target.includes('\\') || target.toLowerCase().endsWith('.exe') || target.toLowerCase().endsWith('.bat') || target.toLowerCase().endsWith('.cmd')) {
          available = fs.existsSync(target);
        } else {
          available = whichSync(target) !== null;
        }
      }
      if (available) {
        return { cleared: true, detail: `'${target}' is available now` };
      }
      if (remaining <= 0) {
        return { cleared: true, detail: 'enough time has passed since the failure' };
      }
      return { cleared: false, detail: `'${target || 'the app'}' may still be unavailable` };
    }

    case 'auth':
      return { cleared: false, detail: 'it still needs your approval — mark resolved or re-approve' };

    case 'parse':
      return { cleared: false, detail: 'the command is still not recognized — rephrase it' };

    // timeout / element / other: transient, cleared by cooldown
    default:
      if (remaining <= 0) {
        return { cleared: true, detail: 'enough time has passed since the failure' };
      }
      return { cleared: false, detail: `waiting for the retry window (${Math.max(0, Math.ceil(remaining))}s left)` };
  }
}

// ─── Probe helpers ────────────────────────────────────────────────────

function httpProbe(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https://') ? https : http;
    const req = lib.request(url, { method: 'HEAD', timeout: 3000 }, (res) => {
      res.resume();
      resolve({ cleared: true, detail: `the target is reachable again (${res.statusCode})` });
    });
    req.on('error', () => resolve({ cleared: false, detail: 'the target is still unreachable' }));
    req.on('timeout', () => { req.destroy(); resolve({ cleared: false, detail: 'the target is still unreachable' }); });
    req.end();
  });
}

function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => { sock.destroy(); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, host);
  });
}

function whichSync(cmd) {
  try {
    const result = process.platform === 'win32'
      ? execSync(`where ${cmd}`, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
      : execSync(`which ${cmd}`, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return result.trim() || null;
  } catch {
    return null;
  }
}

// ─── DB-backed store (failure_lessons table) ──────────────────────────

const MAX_LESSONS = 200;

/**
 * Record a failure in the database — upserts the lesson, increments count,
 * and evicts oldest past the cap.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} params
 * @param {string} params.commandKey — normalized command key
 * @param {string} params.errorText — error message to classify
 * @param {string} [params.project] — project path
 * @param {string} [params.suggestion] — explicit suggestion (overrides classified)
 * @returns {{ kind: string, target: string, suggestion: string, count: number }}
 */
function recordFailure(db, { commandKey, errorText, project, suggestion }) {
  const proj = project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const { kind, target, suggestion: autoSugg } = classifyFailure(errorText);
  const sugg = (suggestion || autoSugg || '').slice(0, 300);
  const tgt = (target || '').slice(0, 200);
  const sig = (errorText || '').slice(0, 300);
  const now = new Date().toISOString();

  const existing = db.prepare(
    `SELECT id, count FROM failure_lessons WHERE project_path = ? AND command_key = ?`
  ).get(proj, commandKey);

  if (existing) {
    db.prepare(`
      UPDATE failure_lessons SET
        error_signature = ?,
        count = count + 1,
        condition_kind = ?,
        condition_target = ?,
        suggestion = COALESCE(NULLIF(?, ''), suggestion),
        resolved = 0,
        last_failed_at = ?
      WHERE id = ?
    `).run(sig, kind, tgt, sugg, now, existing.id);
  } else {
    db.prepare(`
      INSERT INTO failure_lessons (project_path, command_key, error_signature, count, condition_kind, condition_target, suggestion, resolved, last_failed_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, 0, ?)
    `).run(proj, commandKey, sig, kind, tgt, sugg, now);
  }

  // Evict oldest past cap
  const rows = db.prepare(
    `SELECT id FROM failure_lessons WHERE project_path = ? ORDER BY last_failed_at DESC LIMIT -1 OFFSET ?`
  ).all(proj, MAX_LESSONS);
  const delStmt = db.prepare(`DELETE FROM failure_lessons WHERE id = ?`);
  for (const row of rows) delStmt.run(row.id);

  const count = db.prepare(
    `SELECT count FROM failure_lessons WHERE project_path = ? AND command_key = ?`
  ).get(proj, commandKey);

  return { kind, target, suggestion: sugg, count: count ? count.count : 1 };
}

/**
 * Record a success — decrements failure count; removes the lesson when count reaches 0.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} commandKey
 * @param {string} [project]
 */
function recordSuccess(db, commandKey, project) {
  const proj = project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  db.prepare(
    `UPDATE failure_lessons SET count = count - 1 WHERE project_path = ? AND command_key = ?`
  ).run(proj, commandKey);
  db.prepare(
    `DELETE FROM failure_lessons WHERE project_path = ? AND command_key = ? AND count <= 0`
  ).run(proj, commandKey);
}

/**
 * Get a specific failure lesson.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} commandKey
 * @param {string} [project]
 * @returns {Object|null}
 */
function getLesson(db, commandKey, project) {
  const proj = project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  return db.prepare(
    `SELECT * FROM failure_lessons WHERE project_path = ? AND command_key = ?`
  ).get(proj, commandKey) || null;
}

/**
 * List all failure lessons for a project.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @param {number} [opts.limit=100]
 * @returns {Array<Object>}
 */
function listLessons(db, opts = {}) {
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const limit = opts.limit || 100;
  return db.prepare(
    `SELECT * FROM failure_lessons WHERE project_path = ? ORDER BY last_failed_at DESC LIMIT ?`
  ).all(proj, limit);
}

/**
 * Check whether a lesson's underlying condition has cleared (live probe).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} commandKey
 * @param {string} [project]
 * @returns {Promise<{ cleared: boolean, detail: string, lesson: Object|null }>}
 */
async function checkRetryCleared(db, commandKey, project) {
  const lesson = getLesson(db, commandKey, project);
  if (!lesson) {
    return { cleared: true, detail: 'no failure lesson exists', lesson: null };
  }
  const { cleared, detail } = probeCleared({
    kind: lesson.condition_kind,
    target: lesson.condition_target,
    lastFailedAt: lesson.last_failed_at,
    resolved: !!lesson.resolved,
  });
  return { cleared, detail, lesson };
}

/**
 * Mark a lesson as resolved (user override).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} commandKey
 * @param {string} [project]
 * @returns {boolean} — whether a row was updated
 */
function markResolved(db, commandKey, project) {
  const proj = project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const result = db.prepare(
    `UPDATE failure_lessons SET resolved = 1 WHERE project_path = ? AND command_key = ?`
  ).run(proj, commandKey);
  return result.changes > 0;
}

/**
 * Get aggregate stats on failure lessons.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} [project]
 * @returns {{ total: number, byKind: Object, resolved: number, avgCount: number }}
 */
function lessonStats(db, project) {
  const proj = project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const rows = db.prepare(
    `SELECT condition_kind, COUNT(*) as cnt, SUM(count) as total_failures, SUM(resolved) as resolved_cnt
     FROM failure_lessons WHERE project_path = ? GROUP BY condition_kind`
  ).all(proj);
  const byKind = {};
  let total = 0;
  let resolved = 0;
  for (const r of rows) {
    byKind[r.condition_kind] = { count: r.cnt, totalFailures: r.total_failures, resolved: r.resolved_cnt };
    total += r.cnt;
    resolved += r.resolved_cnt;
  }
  const avgRow = db.prepare(
    `SELECT AVG(count) as avg FROM failure_lessons WHERE project_path = ?`
  ).get(proj);
  return {
    total,
    resolved,
    byKind,
    avgCount: avgRow ? Math.round((avgRow.avg || 0) * 10) / 10 : 0,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────

module.exports = {
  FAMILIES,
  FAMILY_SET,
  classifyFailure,
  probeCleared,
  recordFailure,
  recordSuccess,
  getLesson,
  listLessons,
  checkRetryCleared,
  markResolved,
  lessonStats,
  KIND_SUGGESTIONS,
};