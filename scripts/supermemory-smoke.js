#!/usr/bin/env node
'use strict';
/**
 * supermemory-smoke.js — Pre-flight check before adding supermemory to the
 * head-to-head run. Validates the API key, the SDK surface this runner uses,
 * and the full ingest → index → search → cleanup path on ONE tiny session.
 *
 * Usage:  SUPERMEMORY_API_KEY=sk_... node scripts/supermemory-smoke.js
 * Exit 0 = key valid, provider path works, ready for the real run.
 * Exit 1 = something failed; the message says what.
 */

const { createRequire } = require('module');
const path = require('path');
const fs = require('fs');

const MB_ROOT = process.env.MB_ROOT || 'C:/Users/user/AppData/Local/Temp/memorybench';
const req = createRequire(path.join(MB_ROOT, 'package.json'));
const KEY = process.env.SUPERMEMORY_API_KEY || '';

if (!KEY) {
  console.error('FAIL: SUPERMEMORY_API_KEY is not set.');
  console.error('Export it (SUPERMEMORY_API_KEY=sk_...) or put it in /tmp/memorybench/.env.local and re-run.');
  process.exit(1);
}
console.log('key: present, length ' + KEY.length + ', prefix ' + KEY.slice(0, 4) + '...');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const Supermemory = req('supermemory');
  const client = new Supermemory({ apiKey: KEY });
  const container = 'ac-h2h-smoke-' + Date.now();

  // 1. add
  const session = [{
    role: 'user',
    content: 'My name is Spike and I prefer TypeScript with strict mode for all new services.',
  }];
  const addRes = await client.add({
    content: 'Here is the session as a stringified JSON:\n' + JSON.stringify(session),
    containerTags: [container],
    metadata: { sessionId: 'smoke-1' },
  });
  console.log('add: OK, docId=' + addRes.id);

  // 2. await indexing (poll documents.get, harness logic)
  let status = null;
  for (let i = 0; i < 20; i++) {
    const doc = await client.documents.get(addRes.id);
    status = doc.status;
    if (status === 'done' || status === 'failed') break;
    await sleep(1500);
  }
  if (status !== 'done') {
    console.error('FAIL: indexing ended with status=' + status);
    process.exit(1);
  }
  console.log('indexing: done');

  // 3. search (hybrid, same params as the runner)
  const res = await client.search.memories({
    q: 'What language does Spike prefer?',
    containerTags: [container],
    limit: 5,
    threshold: 0.3,
    searchMode: 'hybrid',
    include: { chunks: true },
  });
  const results = res.results || [];
  const blob = results.map(r => r.memory || r.chunk || (r.chunks ? r.chunks.map(c => c.content).join(' ') : '')).join(' ').toLowerCase();
  const found = blob.includes('typescript');
  console.log('search: ' + results.length + ' results, typescript in context: ' + found);
  if (!results.length) {
    console.error('FAIL: search returned 0 results (indexing may not be searchable yet)');
    process.exit(1);
  }

  // 4. cleanup (best-effort — do not fail the smoke test if delete is unsupported)
  try {
    await client.documents.delete(addRes.id);
    console.log('cleanup: deleted smoke doc');
  } catch (e) {
    console.log('cleanup: skipped (' + String(e.message).slice(0, 60) + ') — harmless leftover doc in container ' + container);
  }

  console.log('\nSMOKE PASS — key valid, provider path works. Ready for the real run.');
  process.exit(0);
})().catch(err => {
  const msg = (err && err.message) || String(err);
  if (/api key|unauthorized|401|authentication/i.test(msg)) {
    console.error('FAIL: API key rejected — ' + msg.slice(0, 140));
  } else {
    console.error('FAIL: ' + msg.slice(0, 200));
  }
  process.exit(1);
});
