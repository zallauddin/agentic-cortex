/**
 * watcher.js — File watcher daemon for auto-capture.
 *
 * Watches a directory recursively for file changes and auto-records
 * observations when files are created, modified, or deleted. Debounces
 * rapid changes into batched observations.
 *
 * Usage (via CLI): agentic-cortex watch [dir] [--debounce 10000]
 *
 * @module core/watcher
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.turbo', 'coverage', 'out']);
const SKIP_EXTENSIONS = new Set(['.lock', '.log', '.map', '.pyc', '.class', '.o']);
const WATCH_DEBOUNCE_DEFAULT = 10000; // 10 seconds

/** @type {Set<string>} Pending changed file paths */
let _pendingChanges = new Set();

/** @type {NodeJS.Timeout|null} Debounce timer */
let _debounceTimer = null;

/** @type {number} Current debounce interval */
let _debounceMs = WATCH_DEBOUNCE_DEFAULT;

/** @type {boolean} Whether the watcher is running */
let _running = false;

/** @type {string|null} Project path being watched */
let _watchedProject = null;

/** @type {fs.FSWatcher[]} Active watchers */
let _watchers = [];

/** @type {string|null} Active session ID for the watch period */
let _watchSessionId = null;

/** @type {Object} API reference (injected) */
let _api = null;

/**
 * Inject API reference for saving observations.
 * @param {Object} api - The API module (src/api/index.js)
 */
function setAPI(api) {
  _api = api;
}

/**
 * Start watching a directory for file changes.
 * @param {string} targetDir - Directory to watch
 * @param {Object} [opts] - Options
 * @param {number} [opts.debounceMs] - Debounce interval in ms (default 10000)
 * @param {Function} [opts.onBatch] - Called with batched change summary string
 * @returns {Promise<{status: string, watching: string, debounceMs: number}>}
 */
async function startWatching(targetDir, opts) {
  opts = opts || {};
  _debounceMs = opts.debounceMs || WATCH_DEBOUNCE_DEFAULT;
  _watchedProject = path.resolve(targetDir || process.cwd());

  if (!fs.existsSync(_watchedProject)) {
    throw new Error('Directory not found: ' + _watchedProject);
  }

  if (_running) stopWatching();

  _running = true;
  _pendingChanges = new Set();
  console.error('[agentic-cortex:watch] Watching ' + _watchedProject + ' (debounce: ' + _debounceMs + 'ms)');

  // Auto-start a session for this watch period
  if (_api) {
    try {
      const sess = _api.startSession({
        project: _watchedProject,
        name: path.basename(_watchedProject),
        prompt: 'File watcher daemon auto-capture session',
      });
      _watchSessionId = sess.session_id;
      process.env.AGENTIC_CORTEX_SESSION = sess.session_id;
      console.error('[agentic-cortex:watch] Session started: ' + sess.session_id);
    } catch (err) {
      console.error('[agentic-cortex:watch] Session start failed:', err.message);
    }
  }

  // Start recursive watcher on the target directory
  try {
    const watcher = fs.watch(_watchedProject, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      _onChange(eventType, filename, opts.onBatch);
    });
    _watchers.push(watcher);
  } catch (err) {
    console.error('[agentic-cortex:watch] fs.watch failed, falling back to watchFile:', err.message);
    _watchWithPolling(_watchedProject, opts.onBatch);
  }

  return { status: 'watching', watching: _watchedProject, debounceMs: _debounceMs };
}

/**
 * Stop watching all directories.
 */
function stopWatching() {
  _running = false;
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  for (const w of _watchers) {
    try { w.close(); } catch {}
  }
  _watchers = [];
  _pendingChanges = new Set();

  // End the watch session
  if (_api && _watchSessionId) {
    try {
      _api.endSession(_watchSessionId, 'File watcher daemon stopped');
    } catch {}
  }
  _watchSessionId = null;
  console.error('[agentic-cortex:watch] Stopped watching ' + _watchedProject);
}

/**
 * Internal: handle file change event.
 */
function _onChange(eventType, filename, onBatch) {
  if (!_running) return;

  // Normalize path separators for cross-platform consistency
  const normalized = filename.replace(/\\/g, '/');

  // Skip ignored dirs/files
  const parts = normalized.split('/');
  if (parts.some(p => SKIP_DIRS.has(p))) return;
  const ext = path.extname(normalized).toLowerCase();
  if (SKIP_EXTENSIONS.has(ext)) return;

  _pendingChanges.add(normalized);

  // Reset debounce timer
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => _flushBatch(onBatch), _debounceMs);
}

/**
 * Polling-based alternative when fs.watch with recursive isn't available.
 */
function _watchWithPolling(dir, onBatch) {
  const interval = setInterval(() => {
    if (!_running) { clearInterval(interval); return; }
    try {
      _walkForChanges(dir, '', Date.now() - _debounceMs, onBatch);
    } catch {}
  }, Math.max(_debounceMs, 5000));

  // Keep reference for cleanup
  _watchers.push({ close: () => clearInterval(interval) });
}

/**
 * Walk directory to find recently changed files.
 */
function _walkForChanges(dir, prefix, since, onBatch) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        _walkForChanges(fullPath, relPath, since, onBatch);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SKIP_EXTENSIONS.has(ext)) continue;
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs > since) {
            _pendingChanges.add(relPath);
          }
        } catch {}
      }
    }
  } catch {}
}

/**
 * Flush batched changes: save observation and reset.
 */
function _flushBatch(onBatch) {
  if (_pendingChanges.size === 0) return;

  const changes = [..._pendingChanges].sort();
  const fileList = changes.slice(0, 50).map(f => '- ' + f).join('\n');
  const overflow = changes.length > 50 ? '\n... and ' + (changes.length - 50) + ' more files' : '';

  const summary = 'Modified ' + changes.length + ' file(s) in ' +
    (path.basename(_watchedProject || '')) + ':\n' + fileList + overflow;

  _pendingChanges = new Set();
  _debounceTimer = null;

  if (onBatch) {
    onBatch(summary);
  }

  // Auto-save as observation
  if (_api) {
    try {
      const result = _api.save({
        project: _watchedProject,
        type: 'event',
        title: 'File changes detected',
        content: summary,
        importance: 4,
        session: _watchSessionId,
        provenance: 'observed',
        tags: ['auto-capture', 'file-watcher'],
      });
      console.error('[agentic-cortex:watch] Auto-saved observation #' + result.id);
    } catch (err) {
      console.error('[agentic-cortex:watch] Auto-save failed:', err.message);
    }
  }
}

/**
 * Get watcher status.
 * @returns {{running: boolean, watching: string|null, pendingChanges: number, debounceMs: number}}
 */
function getStatus() {
  return {
    running: _running,
    watching: _watchedProject,
    pendingChanges: _pendingChanges.size,
    debounceMs: _debounceMs,
  };
}

module.exports = {
  startWatching,
  stopWatching,
  getStatus,
  setAPI,
};
