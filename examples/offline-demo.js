/**
 * examples/offline-demo.js — Agentic Cortex with ZERO network, ZERO LLM.
 *
 * Demonstrates that AC's core memory loop works fully offline:
 *   1. save observations       (SQLite vault, no LLM needed)
 *   2. search                  (FTS/keyword — embeddings optional)
 *   3. build agent context     (ranked memory package)
 *   4. session summarize       (deterministic template fallback)
 *
 * The provider is forced to 'off' (see src/core/llm-adapter.js); every
 * reasoning path that would call an LLM falls back to deterministic
 * templates. The vault lives in a throwaway temp DB, so this is safe to run.
 *
 * Run:  node examples/offline-demo.js
 */

'use strict';

const os = require('os');
const path = require('path');

// Fully deterministic mode: force the 'off' provider before loading AC.
process.env.AGENTIC_CORTEX_LLM_PROVIDER = 'off';
process.env.AGENTIC_CORTEX_DB = path.join(os.tmpdir(), 'ac-offline-demo-' + Date.now() + '.db');
process.env.AGENTIC_CORTEX_PROJECT = __dirname;

const api = require('../src/api');

async function main() {
  const adapter = require('../src/core/llm-adapter');
  const status = await adapter.llmStatus();
  console.log('LLM provider:', status.provider, '(all reasoning uses deterministic fallbacks)\n');

  // ── 1. Save observations ────────────────────────────────────────────────
  const saved = [];
  const facts = [
    ['Retry loop causes flaky CI', 'The retry wrapper in deploy.js retries 3 times with no backoff, which hammers the staging API and makes CI flaky. Fix: fixed 1-second delay between attempts.'],
    ['SQLite migrations must be additive', 'Never rewrite an existing column. Add a new column, backfill, then switch reads. Keeps old binaries alive during rolling deploys.'],
    ['Postgres pool sizing rule', 'Pool size ≈ (cores * 2) + spindle. Oversizing the pool caused latency spikes under load testing on the billing service.'],
  ];
  for (const [title, content] of facts) {
    const r = await api.save({ title, content, type: 'learning', tags: ['demo', 'offline'] });
    saved.push(r.id ?? r);
  }
  console.log('Saved', saved.length, 'observations into the vault.');

  // ── 2. Search (FTS/keyword — works with embeddings disabled) ───────────
  const hits = await api.search('retry flaky CI backoff', { limit: 3 });
  console.log('\nSearch "retry flaky CI backoff" →');
  for (const h of hits) console.log('  •', h.title, '(score', Number(h.score ?? 0).toFixed(3) + ')');

  // ── 3. Build agent context (what an MCP client receives pre-prompt) ────
  const pack = await api.context({ project: __dirname });
  const lines = String(pack).split('\n').filter((l) => l.startsWith('- **')).length;
  console.log('\nAgent context package: markdown pack with', lines, 'ranked memories (ready for prompt injection).');

  // ── 4. Session lifecycle with template summarization (no LLM) ──────────
  const sess = api.startSession({ prompt: 'demo: fully offline memory loop' });
  const sum = api.endSession(sess.session_id, '');
  console.log('\nSession', sess.session_id, '→', sum.status);
  console.log('(Summarization fell back to the deterministic template — provider is off.)');

  console.log('\n✔ Offline demo complete. Vault:', process.env.AGENTIC_CORTEX_DB);
  api.close();
}

main().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
