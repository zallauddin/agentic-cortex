'use strict';
/**
 * Fake agent worker for tests. Usage: node fake-worker.js <markerFile> <mode>
 *   mode 'ok'      → writes marker, prints output, exit 0
 *   mode 'fail'    → writes marker, prints error, exit 1
 *   mode 'timeout' → hangs (for timeout tests)
 *
 * The swarm passes the persona prompt via AGENTIC_CORTEX_WORKER_PROMPT.
 */
const fs = require('fs');
const path = require('path');

const marker = process.argv[2] || 'worker-ran.txt';
const mode = process.argv[3] || 'ok';
const cwd = process.cwd();
const prompt = process.env.AGENTIC_CORTEX_WORKER_PROMPT || '';

fs.writeFileSync(path.join(cwd, marker), JSON.stringify({
  ran: true,
  mode,
  prompt: prompt.slice(0, 300),
}, null, 2));

if (mode === 'fail') {
  process.stderr.write('FAKE WORKER FAILED as instructed\n');
  process.exit(1);
}

if (mode === 'timeout') {
  setInterval(() => {}, 1000); // hang until the executor kills us
  return; // never reaches exit(0)
}

process.stdout.write('FAKE WORKER OK — marker ' + marker + '\n');
process.exit(0);
