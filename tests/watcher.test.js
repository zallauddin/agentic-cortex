'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Mock fs before loading watcher ─────────────────────────────
const originalWatch = fs.watch;
const originalReaddirSync = fs.readdirSync;
const originalStatSync = fs.statSync;
const originalExistsSync = fs.existsSync;

let mockWatchCallback = null;

fs.watch = function (targetDir, opts, callback) {
  mockWatchCallback = typeof opts === 'function' ? opts : callback;
  return { close: () => {}, ref() { return this; }, unref() { return this; } };
};

fs.readdirSync = function () { return []; };
fs.statSync = function () { return { mtimeMs: 0 }; };
fs.existsSync = function (p) { return true; };

// Load module with mocked fs
delete require.cache[require.resolve('../src/core/watcher')];
const watcher = require('../src/core/watcher');

// ─── Tests ─────────────────────────────────────────────────────────

describe('startWatching', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-watch-test-'));
    mockWatchCallback = null;
    watcher.setAPI(null);
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    if (watcher.getStatus().running) watcher.stopWatching();
  });

  it('should start watching and return status', async () => {
    const result = await watcher.startWatching(tmpDir, { debounceMs: 500 });
    assert.equal(result.status, 'watching');
    assert.ok(result.watching);
    assert.equal(result.debounceMs, 500);
  });

  it('should start watching without error', async () => {
    await watcher.startWatching(tmpDir, { debounceMs: 100 });
    const status = watcher.getStatus();
    assert.equal(status.running, true);
    assert.ok(status.watching);
  });

  it('should restart if already running', async () => {
    await watcher.startWatching(tmpDir);
    assert.equal(watcher.getStatus().running, true);
    await watcher.startWatching(tmpDir);
    assert.equal(watcher.getStatus().running, true);
  });
});

describe('stopWatching', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-watch-test-'));
    watcher.setAPI(null);
    mockWatchCallback = null;
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    if (watcher.getStatus().running) watcher.stopWatching();
  });

  it('should set running to false', async () => {
    await watcher.startWatching(tmpDir);
    watcher.stopWatching();
    assert.equal(watcher.getStatus().running, false);
  });

  it('should be safe to call when not watching', () => {
    watcher.stopWatching();
    assert.equal(watcher.getStatus().running, false);
  });
});

describe('getStatus', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-watch-test-'));
    watcher.setAPI(null);
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    if (watcher.getStatus().running) watcher.stopWatching();
  });

  it('should return expected shape when stopped', () => {
    const status = watcher.getStatus();
    assert.ok('running' in status);
    assert.ok('watching' in status);
    assert.ok('pendingChanges' in status);
    assert.ok('debounceMs' in status);
    assert.equal(status.running, false);
  });

  it('should return running=true when watching', async () => {
    await watcher.startWatching(tmpDir);
    const status = watcher.getStatus();
    assert.equal(status.running, true);
  });
});

describe('setAPI', () => {
  it('should accept an API object', () => {
    assert.doesNotThrow(() => watcher.setAPI({ save() {}, startSession() {} }));
  });

  it('should accept null', () => {
    assert.doesNotThrow(() => watcher.setAPI(null));
  });
});

describe('module exports', () => {
  it('should export all functions', () => {
    assert.equal(typeof watcher.startWatching, 'function');
    assert.equal(typeof watcher.stopWatching, 'function');
    assert.equal(typeof watcher.getStatus, 'function');
    assert.equal(typeof watcher.setAPI, 'function');
  });
});

// ─── Cleanup ───────────────────────────────────────────────────────
afterEach(() => {
  fs.watch = originalWatch;
  fs.readdirSync = originalReaddirSync;
  fs.statSync = originalStatSync;
  fs.existsSync = originalExistsSync;
});
