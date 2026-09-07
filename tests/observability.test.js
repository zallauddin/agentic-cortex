'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

function startServer(port) {
  const env = {
    ...process.env,
    AGENTIC_CORTEX_DB: path.join(os.tmpdir(), 'obs-test-' + Date.now() + '-' + port + '.db'),
    AGENTIC_CORTEX_LOG: 'json',
  };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'cli.js'), 'serve', String(port)], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  return child;
}

async function waitReady(port, child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited early: ' + child.exitCode);
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/health');
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('server did not become ready');
}

describe('observability — serve endpoints', () => {
  it('/health includes llm provider status and uptime', async () => {
    const port = 39791;
    const child = startServer(port);
    try {
      await waitReady(port, child);
      const res = await fetch('http://127.0.0.1:' + port + '/health');
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.status, 'ok');
      assert.equal(typeof body.uptime_s, 'number');
      assert.ok(body.llm);
      assert.equal(body.llm.provider, 'openai'); // default provider
      assert.equal(typeof body.llm.available, 'boolean');
    } finally {
      child.kill();
    }
  });

  it('/metrics serves Prometheus format and JSON on ?format=json', async () => {
    const port = 39792;
    const child = startServer(port);
    try {
      await waitReady(port, child);
      const prom = await fetch('http://127.0.0.1:' + port + '/metrics');
      assert.equal(prom.status, 200);
      assert.match(prom.headers.get('content-type') || '', /text\/plain/);
      const text = await prom.text();
      assert.match(text, /^# TYPE ac_uptime_seconds gauge$/m);
      assert.match(text, /^ac_observations_total \d+$/m);
      assert.match(text, /^ac_db_size_bytes \d+$/m);

      const jres = await fetch('http://127.0.0.1:' + port + '/metrics?format=json');
      const j = await jres.json();
      assert.equal(typeof j.uptime_seconds, 'number');
      assert.equal(typeof j.sessions_total, 'number');
      assert.ok('db_size_bytes' in j);
    } finally {
      child.kill();
    }
  });
});
