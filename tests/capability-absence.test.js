/**
 * capability-absence.test.js — YOINK-style capability-absence enforcement.
 *
 * YOINK's chain reader is read-only "because the capability is absent from
 * the source — and a test parses the file to prove the words are not there."
 * These tests do the same for agentic-cortex's guarantees:
 *
 *   1. The ~400MB embedding model is NEVER auto-loaded. Automatic paths
 *      (save/search/bootstrap) must not pull @xenova/transformers into the
 *      require cache unless the operator opted in.
 *   2. The seed sanitizer is fail-closed: credential-class content never
 *      leaves, and an internal sanitizer error blocks the export entirely.
 *   3. The claims chain reader is read-only by ABSENCE: no write/sign method
 *      names appear anywhere in src/core/claims.js — a test parses the file
 *      to prove the words are not there.
 *
 * @module tests/capability-absence
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AGENTIC_CORTEX_DB = process.env.AGENTIC_CORTEX_DB ||
  os.tmpdir().replace(/\\/g, '/') + '/ac-capabsence-test-' + process.pid + '-' + Date.now() + '.db';
// Hard-opt-out for this suite: guarantees the automatic path is exercised.
delete process.env.AGENTIC_CORTEX_EMBEDDINGS;

const repoRoot = path.resolve(__dirname, '..');

// ─── 1. Embedding model never auto-loads ─────────────────────────────────

describe('capability absence: embedding model never auto-loads', () => {
  it('automatic save/search paths keep @xenova/transformers out of the require cache', async () => {
    const api = require('../src/api');
    const project = '/tmp/ac-capabsence-proj';

    await api.save({ title: 'Auto path check', content: 'saved without the 400MB model', type: 'observation', project, skipDedup: true, skipSupersede: true });
    await api.search('auto path check', { project });
    await api.bootstrap({ project });

    const loaded = Object.keys(require.cache).filter(k => /xenova|transformers/i.test(k));
    assert.equal(loaded.length, 0, 'embedding stack must not load without AGENTIC_CORTEX_EMBEDDINGS=1; got: ' + loaded.join(', '));
  });

  it('computeEmbedding stays cheap (fails fast) when embeddings are off', async () => {
    const { computeEmbedding } = require('../src/core/embedding');
    await assert.rejects(() => computeEmbedding('anything'), /disabled|embedding/i);
    const loaded = Object.keys(require.cache).filter(k => /xenova|transformers/i.test(k));
    assert.equal(loaded.length, 0);
  });
});

// ─── 2. Seed sanitizer fail-closed ───────────────────────────────────────

describe('capability absence: seed sanitizer never lets credentials travel', () => {
  const sanitizer = require('../src/core/seed-sanitizer');

  const CREDENTIAL_FIXTURES = [
    '-----BEGIN RSA PRIVATE KEY-----\\nMIIEpAIBAAKCAQEA7fake\\n-----END RSA PRIVATE KEY-----',
    '-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBg\\n-----END PRIVATE KEY-----',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'AKIAIOSFODNN7EXAMPLE',
    'ghp_16CharactersGeneratingToken9999',
  ];

  it('blocks or redacts credential-class content', () => {
    for (const secret of CREDENTIAL_FIXTURES) {
      const seed = { title: 'Leaky memory', content: 'config uses ' + secret + ' for deploy', type: 'fact', project_path: '/tmp/x' };
      const verdict = sanitizer.screenSeed(seed);
      const out = sanitizer.sanitizeSeed(seed);
      const serialized = JSON.stringify({ verdict, out });
      const bare = secret.split('\\n')[0];
      assert.ok(!serialized.includes(bare), 'credential class leaked: ' + bare.slice(0, 24));
      // Every credential-class fixture must be either hard-blocked or redacted.
      const neutralized = verdict.allowed === false || out.ok !== true || !out.seed.content.includes(bare);
      assert.ok(neutralized, 'credential class neither blocked nor redacted: ' + bare.slice(0, 24));
    }
  });

  it('fail-closed: non-seedable types are refused with a reason', () => {
    const broken = { title: 'x', content: 'y', type: 'observation', project_path: '/tmp/x' };
    const verdict = sanitizer.screenSeed(broken);
    assert.equal(verdict.allowed, false);
    assert.ok(verdict.reason && verdict.reason.length > 0);
  });
});

// ─── 3. Chain reader is read-only by absence ─────────────────────────────

describe('capability absence: claims chain reader cannot move money', () => {
  const FORBIDDEN = [
    'eth_sendRawTransaction',
    'eth_sendTransaction',
    'eth_sign',
    'eth_signTransaction',
    'eth_accounts',
    'personal_sign',
    'privateKey',
    'private_key',
    'wallet',
  ];

  it('src/core/claims.js parses clean — the write capability is absent from the source', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'src/core/claims.js'), 'utf8');
    const found = FORBIDDEN.filter(w => src.includes(w));
    assert.deepEqual(found, [], 'forbidden capability strings found in claims.js: ' + found.join(', '));
  });

  it('only whitelisted read methods are permitted by the reader', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'src/core/claims.js'), 'utf8');
    assert.ok(src.includes('eth_blockNumber'), 'reader must know how to read a block number');
    assert.ok(src.includes('READ_ONLY_METHODS'), 'reader must gate on a read-only method allowlist');
  });
});
