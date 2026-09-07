/**
 * examples/mcp-demo.js — Wire an AI coding agent to AC over MCP (stdio).
 *
 * Speaks real MCP JSON-RPC against src/mcp/server.js, the same way Claude
 * Code / Cursor / OpenCode / any MCP client does after AC's `wireup`:
 *
 *   1. initialize handshake
 *   2. tools/list                → discovers the memory/reasoning tools
 *   3. tools/call memory_save    → writes an observation into the vault
 *   4. tools/call memory_search  → reads it back ranked
 *
 * Run:  node examples/mcp-demo.js
 */

'use strict';

const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Give the child its own throwaway vault.
process.env.AGENTIC_CORTEX_DB = path.join(os.tmpdir(), 'ac-mcp-demo-' + Date.now() + '.db');

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp', 'server.js')], {
  env: { ...process.env },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let nextId = 1;
const pending = new Map();

let stdoutBuf = '';
server.stdout.on('data', (chunk) => {
  stdoutBuf += chunk.toString();
  let idx;
  // Responses can exceed the pipe chunk size — keep partial lines buffered.
  while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
    const line = stdoutBuf.slice(0, idx);
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout: ' + method)), 15000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function main() {
  // 1. Initialize handshake
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'ac-mcp-demo', version: '1.0.0' },
  });
  console.log('Initialized:', init.result?.serverInfo?.name ?? '(server)', '\n');

  // 2. Discover tools
  const tools = await rpc('tools/list', {});
  const names = (tools.result?.tools || []).map((t) => t.name);
  console.log('Discovered', names.length, 'MCP tools, e.g.:', names.slice(0, 8).join(', '), '…\n');

  // 3. Save an observation through MCP
  const saved = await rpc('tools/call', {
    name: 'memory_save',
    arguments: {
      title: 'MCP demo observation',
      content: 'Saved through the MCP stdio transport exactly like Claude Code, Cursor, or OpenCode would after running `agentic-cortex wireup`.',
      type: 'learning',
      tags: ['demo', 'mcp'],
    },
  });
  console.log('memory_save →', (saved.result?.content?.[0]?.text || '').slice(0, 120), '\n');

  // 4. Search it back
  const found = await rpc('tools/call', {
    name: 'memory_search',
    arguments: { query: 'MCP demo observation', limit: 3 },
  });
  console.log('memory_search →', (found.result?.content?.[0]?.text || '').slice(0, 300), '\n');

  console.log('✔ MCP demo complete. Vault:', process.env.AGENTIC_CORTEX_DB);
  server.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error('Demo failed:', err);
  server.kill();
  process.exit(1);
});
