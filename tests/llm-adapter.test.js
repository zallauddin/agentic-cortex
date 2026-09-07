'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

describe('llm-adapter — provider abstraction', () => {
  let adapter;
  const savedEnv = {};

  beforeEach(() => {
    savedEnv.provider = process.env.AGENTIC_CORTEX_LLM_PROVIDER;
    savedEnv.model = process.env.AGENTIC_CORTEX_LLM_MODEL;
    savedEnv.key = process.env.AGENTIC_CORTEX_LLM_API_KEY;
    savedEnv.baseUrl = process.env.AGENTIC_CORTEX_LLM_BASE_URL;
    process.env.AGENTIC_CORTEX_DB = path.join(os.tmpdir(), 'adapter-test-' + Date.now() + '.db');
    adapter = require('../src/core/llm-adapter');
  });

  afterEach(() => {
    process.env.AGENTIC_CORTEX_LLM_PROVIDER = savedEnv.provider;
    process.env.AGENTIC_CORTEX_LLM_MODEL = savedEnv.model;
    process.env.AGENTIC_CORTEX_LLM_API_KEY = savedEnv.key;
    process.env.AGENTIC_CORTEX_LLM_BASE_URL = savedEnv.baseUrl;
    delete process.env.AGENTIC_CORTEX_DB;
  });

  it('off provider always returns null (deterministic mode)', async () => {
    process.env.AGENTIC_CORTEX_LLM_PROVIDER = 'off';
    const out = await adapter.callProvider([{ role: 'user', content: 'hi' }]);
    assert.equal(out, null);
  });

  it('llmStatus reports the off provider as available', async () => {
    process.env.AGENTIC_CORTEX_LLM_PROVIDER = 'off';
    const s = await adapter.llmStatus();
    assert.equal(s.provider, 'off');
    assert.equal(s.available, true);
  });

  it('llmStatus reports base url and model for openai provider', async () => {
    process.env.AGENTIC_CORTEX_LLM_PROVIDER = 'openai';
    process.env.AGENTIC_CORTEX_LLM_BASE_URL = 'http://127.0.0.1:99999/';
    process.env.AGENTIC_CORTEX_LLM_MODEL = 'test-model';
    const s = await adapter.llmStatus();
    assert.equal(s.provider, 'openai');
    assert.equal(s.baseUrl, 'http://127.0.0.1:99999/');
    assert.equal(s.model, 'test-model');
  });

  it('unreachable openai endpoint returns null instead of throwing', async () => {
    process.env.AGENTIC_CORTEX_LLM_PROVIDER = 'openai';
    process.env.AGENTIC_CORTEX_LLM_BASE_URL = 'http://127.0.0.1:9'; // nothing listens
    const out = await adapter.callProvider([{ role: 'user', content: 'hi' }], { timeout: 2000 });
    assert.equal(out, null);
  });

  it('unknown provider throws with the known list', () => {
    process.env.AGENTIC_CORTEX_LLM_PROVIDER = 'bogus';
    assert.throws(() => adapter.providerName(), /Unknown AGENTIC_CORTEX_LLM_PROVIDER "bogus"/);
  });

  it('registerProvider accepts custom adapters and callProvider routes to them', async () => {
    adapter.registerProvider('custom-test', {
      available: () => true,
      async complete(messages, opts) {
        return 'echo:' + messages.map((m) => m.content).join('|') + ':' + (opts.tag || '');
      },
    });
    process.env.AGENTIC_CORTEX_LLM_PROVIDER = 'custom-test';
    const out = await adapter.callProvider([{ role: 'user', content: 'a' }], { tag: 't' });
    assert.equal(out, 'echo:a:t');
  });

  it('adapter contract: empty/whitespace results become null', async () => {
    adapter.registerProvider('empty-test', {
      available: () => true,
      async complete() { return '   '; },
    });
    process.env.AGENTIC_CORTEX_LLM_PROVIDER = 'empty-test';
    assert.equal(await adapter.callProvider([{ role: 'user', content: 'x' }]), null);
  });

  it('flattenMessages folds a chat into a single local-model prompt', () => {
    const p = adapter._flattenMessages([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);
    assert.equal(p, 'be brief\n\nq1\nAnswer: a1\nq2');
  });

  it('session.callLLM delegates to the provider (off → null)', async () => {
    process.env.AGENTIC_CORTEX_LLM_PROVIDER = 'off';
    const session = require('../src/core/session');
    assert.equal(await session.callLLM([{ role: 'user', content: 'hi' }]), null);
  });
});

describe('log — structured logger', () => {
  const saved = {};
  let log;

  beforeEach(() => {
    saved.log = process.env.AGENTIC_CORTEX_LOG;
    saved.level = process.env.AGENTIC_CORTEX_LOG_LEVEL;
    log = require('../src/core/log');
  });

  afterEach(() => {
    process.env.AGENTIC_CORTEX_LOG = saved.log;
    process.env.AGENTIC_CORTEX_LOG_LEVEL = saved.level;
  });

  function capture(fn) {
    const chunks = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (c) => { chunks.push(String(c)); return true; };
    try { fn(); } finally { process.stderr.write = orig; }
    return chunks.join('');
  }

  it('json mode emits one parseable object per line', () => {
    process.env.AGENTIC_CORTEX_LOG = 'json';
    const out = capture(() => log.info('hello', { count: 3 }));
    const rec = JSON.parse(out.trim());
    assert.equal(rec.level, 'info');
    assert.equal(rec.msg, 'hello');
    assert.equal(rec.count, 3);
    assert.ok(rec.ts);
  });

  it('errors serialize into message+code in json mode', () => {
    process.env.AGENTIC_CORTEX_LOG = 'json';
    const err = new Error('boom');
    err.code = 'E_TEST';
    const out = capture(() => log.error('failed', { err }));
    const rec = JSON.parse(out.trim());
    assert.equal(rec.err.message, 'boom');
    assert.equal(rec.err.code, 'E_TEST');
  });

  it('pretty mode includes level and message', () => {
    process.env.AGENTIC_CORTEX_LOG = 'pretty';
    const out = capture(() => log.warn('careful', { detail: 1 }));
    assert.match(out, /\[.*\] WARN careful/);
    assert.match(out, /"detail":1/);
  });

  it('log level filtering suppresses debug by default', () => {
    process.env.AGENTIC_CORTEX_LOG = 'json';
    delete process.env.AGENTIC_CORTEX_LOG_LEVEL;
    const out = capture(() => log.debug('quiet'));
    assert.equal(out, '');
  });
});
