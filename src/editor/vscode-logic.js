/**
 * vscode-logic.js — Core auto-capture logic for VS Code / Cursor extensions.
 *
 * This module provides the core event handlers that a VS Code extension
 * would wire up. It maps editor events (file save, terminal command,
 * git operations, workspace open/close) to agentic-cortex API calls.
 *
 * Designed to be required by a VS Code extension's activate() function.
 * The extension host provides the vscode API — this file just contains
 * the logic that maps events to memory operations.
 *
 * Usage from a VS Code extension:
 *
 *   const vscode = require('vscode');
 *   const cortex = require('agentic-cortex/src/editor/vscode-logic');
 *
 *   function activate(context) {
 *     cortex.init({ vscode, projectPath: vscode.workspace.rootPath });
 *     cortex.registerHandlers(context);
 *   }
 *
 * @module editor/vscode-logic
 */

'use strict';

/** @type {Object|null} Reference to VS Code API (injected by extension host) */
let _vscode = null;

/** @type {Object|null} Reference to agentic-cortex API */
let _api = null;

/** @type {string|null} Current project path */
let _projectPath = null;

/** @type {string|null} Active session ID */
let _activeSessionId = null;

/** @type {Map<string, number>} File change debounce timers (auto-cleaned) */
const _saveDebounceTimers = new Map();
const MAX_DEBOUNCE_TIMERS = 200;

/** @type {string[]} Batched file saves pending flush */
let _pendingSaves = [];

/** @type {NodeJS.Timeout|null} Save batch timer */
let _saveBatchTimer = null;

const SAVE_DEBOUNCE_MS = 5000; // 5 second batch window for file saves

/**
 * Initialize the editor integration.
 * @param {Object} opts
 * @param {Object} opts.vscode - The VS Code API object
 * @param {string} [opts.projectPath] - Project root path
 * @param {Object} [opts.api] - agentic-cortex API (auto-loaded if omitted)
 */
function init(opts) {
  _vscode = opts.vscode;
  _projectPath = opts.projectPath || (_vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath) || process.cwd();

  // Lazy-load the API if not provided
  if (opts.api) {
    _api = opts.api;
  } else {
    try {
      _api = require('../api');
    } catch {
      console.error('[cortex:vscode] Could not load agentic-cortex API');
    }
  }

  console.log('[cortex:vscode] Initialized for ' + _projectPath);
}

/**
 * Register all auto-capture event handlers with VS Code.
 * Call this from your extension's activate() function.
 * @param {Object} context - VS Code ExtensionContext for disposables
 */
function registerHandlers(context) {
  if (!_vscode || !_api) {
    console.error('[cortex:vscode] Not initialized. Call init() first.');
    return;
  }

  const subs = context.subscriptions;

  // ── Workspace open: start a session ──
  _onWorkspaceOpen();
  subs.push(_vscode.workspace.onDidChangeWorkspaceFolders(() => {
    // End previous session before starting a new one on workspace change
    _onDeactivate();
    _onWorkspaceOpen();
  }));

  // ── File save: record as artifact observation ──
  subs.push(_vscode.workspace.onDidSaveTextDocument((doc) => _onFileSave(doc)));
  subs.push(_vscode.workspace.onDidCloseTextDocument((doc) => _flushPendingSaves()));

  // ── Terminal commands: record execution ──
  subs.push(_vscode.window.onDidOpenTerminal((terminal) => _onTerminalOpen(terminal)));
  subs.push(_vscode.window.onDidCloseTerminal((terminal) => _onTerminalClose(terminal)));

  // ── Git operations: listen for git extension events ──
  subs.push(_vscode.workspace.onDidChangeTextDocument((e) => _onDocumentChange(e)));

  // ── Extension deactivate: end session ──
  subs.push({ dispose: () => _onDeactivate() });

  console.log('[cortex:vscode] Auto-capture handlers registered');
}

// ─── Event Handlers ──────────────────────────────────────────────

function _onWorkspaceOpen() {
  if (!_api || !_projectPath) return;
  try {
    const result = _api.startSession({
      project: _projectPath,
      name: require('path').basename(_projectPath),
      prompt: 'VS Code / Cursor editing session',
    });
    _activeSessionId = result.session_id;
    console.log('[cortex:vscode] Session started: ' + _activeSessionId);
  } catch (err) {
    console.error('[cortex:vscode] Session start failed:', err.message);
  }
}

function _onDeactivate() {
  if (!_api || !_activeSessionId) return;
  _flushPendingSaves();
  try {
    _api.endSession(_activeSessionId, 'Editor session ended');
    console.log('[cortex:vscode] Session ended: ' + _activeSessionId);
  } catch {}
}

function _onFileSave(doc) {
  if (!_api || !_projectPath) return;
  const filePath = doc.uri.fsPath;

  // Skip files outside the project
  if (!filePath.startsWith(_projectPath)) return;

  // Prune stale debounce timers periodically to prevent memory leak
  if (_saveDebounceTimers.size > MAX_DEBOUNCE_TIMERS) {
    const keys = [..._saveDebounceTimers.keys()];
    for (const k of keys.slice(0, 100)) {
      clearTimeout(_saveDebounceTimers.get(k));
      _saveDebounceTimers.delete(k);
    }
  }

  // Batch saves: debounce to avoid spamming observations
  _pendingSaves.push(filePath);

  if (_saveBatchTimer) clearTimeout(_saveBatchTimer);
  _saveBatchTimer = setTimeout(() => _flushPendingSaves(), SAVE_DEBOUNCE_MS);
}

function _flushPendingSaves() {
  if (_pendingSaves.length === 0) return;
  if (_saveBatchTimer) { clearTimeout(_saveBatchTimer); _saveBatchTimer = null; }

  const files = [...new Set(_pendingSaves)];
  _pendingSaves = [];

  const relPaths = files.map(f => {
    try { return require('path').relative(_projectPath, f); } catch { return f; }
  }).slice(0, 20);

  const content = 'Saved ' + files.length + ' file(s):\n' +
    relPaths.map(f => '- ' + f).join('\n') +
    (files.length > 20 ? '\n... and ' + (files.length - 20) + ' more' : '');

  try {
    const result = _api.save({
      project: _projectPath,
      type: 'event',
      title: 'Files saved',
      content,
      importance: 3,
      provenance: 'observed',
      tags: ['auto-capture', 'editor', 'file-save'],
      session: _activeSessionId,
    });
    console.log('[cortex:vscode] Auto-saved observation #' + result.id);
  } catch (err) {
    console.error('[cortex:vscode] Auto-save failed:', err.message);
  }
}

/** @type {Map<number, string>} Terminal ID -> last command buffer */
const _terminalCommands = new Map();

function _onTerminalOpen(terminal) {
  // Listen for data written to terminal (command execution)
  // NOTE: VS Code doesn't directly expose terminal commands via stable API.
  // Extensions typically use terminal.sendText() or shell integration API.
  // This is a best-effort hook that extensions can extend.
  console.log('[cortex:vscode] Terminal opened: ' + (terminal.name || 'unnamed'));
}

function _onTerminalClose(terminal) {
  console.log('[cortex:vscode] Terminal closed: ' + (terminal.name || 'unnamed'));
}

/**
 * Record a terminal command execution manually.
 * Call this from your extension's terminal integration code.
 * @param {string} command - The command that was run
 * @param {number} [exitCode] - Exit code (0 = success)
 * @param {string} [output] - Command output summary
 */
function recordTerminalCommand(command, exitCode, output) {
  if (!_api || !_projectPath) return;

  const status = exitCode === 0 ? 'succeeded' : 'failed (exit ' + exitCode + ')';
  const content = 'Ran: `' + command + '` — ' + status +
    (output ? '\nOutput: ' + output.slice(0, 300) : '');

  try {
    _api.save({
      project: _projectPath,
      type: 'event',
      title: 'Terminal: ' + command.split(' ')[0],
      content,
      importance: 3,
      provenance: 'observed',
      tags: ['auto-capture', 'terminal', exitCode === 0 ? 'success' : 'failure'],
      session: _activeSessionId,
    });
  } catch (err) {
    console.error('[cortex:vscode] Terminal record failed:', err.message);
  }
}

/**
 * Record a git operation manually.
 * Call from extension's git integration.
 * @param {string} operation - e.g., 'commit', 'push', 'pull', 'checkout'
 * @param {string} [details] - Commit message, branch name, etc.
 */
function recordGitOperation(operation, details) {
  if (!_api || !_projectPath) return;

  const content = 'Git ' + operation + (details ? ': ' + details : '');

  try {
    _api.save({
      project: _projectPath,
      type: 'event',
      title: 'Git: ' + operation,
      content,
      importance: 5,
      provenance: 'observed',
      tags: ['auto-capture', 'git', operation],
      session: _activeSessionId,
    });
  } catch (err) {
    console.error('[cortex:vscode] Git record failed:', err.message);
  }
}

function _onDocumentChange(e) {
  // Hook for document changes — can be extended to track significant edits
}

/**
 * Manually save an observation from the editor.
 * @param {Object} opts - Same as api.save() opts
 */
function saveMemory(opts) {
  if (!_api) throw new Error('API not initialized');
  opts.project = opts.project || _projectPath;
  opts.session = opts.session || _activeSessionId;
  return _api.save(opts);
}

module.exports = {
  init,
  registerHandlers,
  recordTerminalCommand,
  recordGitOperation,
  saveMemory,
};
