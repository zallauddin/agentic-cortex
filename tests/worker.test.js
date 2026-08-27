'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const worker = require('../src/core/worker');

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-worker.js');

let tmpDirs = [];

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-test-'));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => { tmpDirs = []; });

afterEach(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ─── workerMode resolution ────────────────────────────────────────────

describe('worker: workerMode', () => {
  afterEach(() => {
    delete process.env.AGENTIC_CORTEX_WORKER;
    delete process.env.AGENTIC_CORTEX_WORKER_MODE;
  });

  it('defaults to in-process (nothing spawns unexpectedly)', () => {
    assert.equal(worker.workerMode({}), 'in-process');
  });

  it('honors opts.workerMode', () => {
    assert.equal(worker.workerMode({ workerMode: 'process' }), 'process');
    assert.equal(worker.workerMode({ workerMode: 'in-process' }), 'in-process');
  });

  it('setting AGENTIC_CORTEX_WORKER implies process mode', () => {
    process.env.AGENTIC_CORTEX_WORKER = 'claude-code';
    assert.equal(worker.workerMode({}), 'process');
  });

  it('AGENTIC_CORTEX_WORKER=off stays in-process', () => {
    process.env.AGENTIC_CORTEX_WORKER = 'off';
    assert.equal(worker.workerMode({}), 'in-process');
  });
});

// ─── resolveWorker ────────────────────────────────────────────────────

describe('worker: resolveWorker', () => {
  it('resolves an explicit worker config with absolute node binary', () => {
    const spec = worker.resolveWorker({
      worker: { command: process.execPath, args: [FIXTURE, 'a.txt', 'ok'], timeoutMs: 5000 },
      project: process.cwd(),
    });
    assert.ok(spec);
    assert.equal(spec.command, process.execPath);
    assert.equal(spec.available, true);
    assert.deepEqual(spec.argsPreview, [FIXTURE, 'a.txt', 'ok']);
    assert.equal(spec.timeoutMs, 5000);
    assert.equal(spec.cwd, path.resolve(process.cwd()));
  });

  it('substitutes the __PROMPT__ placeholder (standalone or embedded)', () => {
    const spec = worker.resolveWorker({
      worker: { command: process.execPath, args: ['-e', 'console.log(__PROMPT__)', '--marker=__PROMPT__'] },
    });
    assert.deepEqual(spec.argsBuilder('HELLO', {}), ['-e', 'console.log(HELLO)', '--marker=HELLO']);
  });

  it('resolves by framework id via the registry', () => {
    const spec = worker.resolveWorker({ workerFramework: 'opencode' });
    assert.ok(spec);
    assert.equal(spec.frameworkId, 'opencode');
    assert.deepEqual(spec.argsPreview, ['run', '<prompt>']);
    assert.ok(spec.plan && spec.plan.ok, 'compose plan attached from the capability manifest');
  });

  it('returns null for an unknown framework id', () => {
    assert.equal(worker.resolveWorker({ workerFramework: 'no-such-agent' }), null);
  });

  it('returns null when nothing is configured', () => {
    assert.equal(worker.resolveWorker({}), null);
  });
});

// ─── runWorker ────────────────────────────────────────────────────────

describe('worker: runWorker', () => {
  it('runs a worker that succeeds — real side effect in the project cwd', async () => {
    const project = tmpProject();
    const spec = worker.resolveWorker({
      worker: { command: process.execPath, args: [FIXTURE, 'coder-marker.txt', 'ok'], cwd: project, timeoutMs: 10000 },
    });
    const res = await worker.runWorker(spec, 'you are the coder — edit files', {});
    assert.equal(res.ok, true);
    assert.equal(res.exitCode, 0);
    assert.match(res.output, /FAKE WORKER OK/);
    const marker = JSON.parse(fs.readFileSync(path.join(project, 'coder-marker.txt'), 'utf-8'));
    assert.equal(marker.ran, true);
    assert.match(marker.prompt, /coder/);
  });

  it('classifies a non-zero exit as failure with stderr context', async () => {
    const project = tmpProject();
    const spec = worker.resolveWorker({
      worker: { command: process.execPath, args: [FIXTURE, 'fail-marker.txt', 'fail'], cwd: project, timeoutMs: 10000 },
    });
    const res = await worker.runWorker(spec, 'prompt', {});
    assert.equal(res.ok, false);
    assert.equal(res.exitCode, 1);
    assert.match(res.error, /FAKE WORKER FAILED/);
  });

  it('kills a hung worker after the timeout', async () => {
    const project = tmpProject();
    const spec = worker.resolveWorker({
      worker: { command: process.execPath, args: [FIXTURE, 'hang-marker.txt', 'timeout'], cwd: project, timeoutMs: 200 },
    });
    const res = await worker.runWorker(spec, 'prompt', {});
    assert.equal(res.ok, false);
    assert.equal(res.timedOut, true);
    assert.match(res.error, /timed out after 200ms/);
    assert.equal(res.exitCode, 'timeout');
  });

  it('reports ENOENT when the command does not exist', async () => {
    const spec = worker.resolveWorker({
      worker: { command: 'definitely-not-a-real-binary-xyz', args: [] },
    });
    const res = await worker.runWorker(spec, 'prompt', {});
    assert.equal(res.ok, false);
  });
});

// ─── workerInfo ───────────────────────────────────────────────────────

describe('worker: workerInfo', () => {
  afterEach(() => {
    delete process.env.AGENTIC_CORTEX_WORKER;
    delete process.env.AGENTIC_CORTEX_WORKER_MODE;
  });

  it('reports disabled by default with discovery list', () => {
    const info = worker.workerInfo({ project: process.cwd() });
    assert.equal(info.enabled, false);
    assert.equal(info.mode, 'in-process');
    assert.equal(info.resolved, null);
    assert.ok(Array.isArray(info.discoveredFrameworks));
  });

  it('reports the resolved worker when process mode is active', () => {
    process.env.AGENTIC_CORTEX_WORKER = 'claude-code';
    const info = worker.workerInfo({ project: process.cwd() });
    assert.equal(info.enabled, true);
    assert.ok(info.resolved);
    assert.equal(info.resolved.framework, 'claude-code');
    assert.ok(info.resolved.command.endsWith('claude'), 'resolves the real binary path');
    assert.ok(Array.isArray(info.resolved.memoryTools));
  });
});
