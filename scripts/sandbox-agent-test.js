#!/usr/bin/env node
'use strict';
/**
 * sandbox-agent-test.js — Controlled, sandboxed validation of agentic-cortex
 * as session/long-term memory for AI coding agents.
 *
 * Simulates realistic agent behavior through the REAL integration surfaces:
 *   - MCP stdio server (spawned subprocess, JSON-RPC 2.0) — the exact channel
 *     Claude Code / Cursor / OpenCode use
 *   - CLI (mcp-config, bootstrap, health) — the manual-detection path
 *
 * Hermetic by construction:
 *   - AGENTIC_CORTEX_DB → fresh temp SQLite file (never the user's real DB)
 *   - AGENTIC_CORTEX_PROJECT → fake project dirs inside a temp sandbox root
 *   - Every spawned MCP server = one "agent session"; a new spawn = agent restart
 *
 * Usage: node scripts/sandbox-agent-test.js [--keep]
 * Writes: data/runs/sandbox-agent/report.json + prints pass/fail table.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MCP_SERVER = path.join(ROOT, 'src', 'mcp', 'server.js');
const CLI = path.join(ROOT, 'cli.js');
const SESSION_TIMEOUT_MS = 120000;

// ─────────────────────────────────────────────────────────────────────
// Sandbox construction
// ─────────────────────────────────────────────────────────────────────

const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-agent-sandbox-'));
const dbPath = path.join(sandboxRoot, 'memory.db').replace(/\\/g, '/');
const projectA = path.join(sandboxRoot, 'project-alpha');
const projectB = path.join(sandboxRoot, 'project-beta');

for (const dir of [projectA, projectB]) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
}
fs.writeFileSync(path.join(projectA, 'package.json'), JSON.stringify({ name: 'project-alpha', version: '1.0.0' }, null, 2));
fs.writeFileSync(path.join(projectA, 'src', 'index.js'), 'module.exports = { greet: (n) => "hello " + n };\n');
fs.writeFileSync(path.join(projectB, 'package.json'), JSON.stringify({ name: 'project-beta', version: '0.1.0' }, null, 2));

// ─────────────────────────────────────────────────────────────────────
// Result collection
// ─────────────────────────────────────────────────────────────────────

const results = [];
function check(scenario, name, pass, evidence) {
  results.push({ scenario, name, pass: !!pass, evidence: typeof evidence === 'string' ? evidence.slice(0, 400) : evidence });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log('  [' + tag + '] ' + scenario + ' :: ' + name);
  if (!pass && typeof evidence === 'string') console.log('         ↳ ' + evidence.slice(0, 300));
}
const section = (s) => console.log('\n══ ' + s + ' ══');

// ─────────────────────────────────────────────────────────────────────
// MCP client — spawn server, speak JSON-RPC, collect responses
// (one spawn == one agent session; stdin end == agent disconnects)
// ─────────────────────────────────────────────────────────────────────

function sandboxEnv(projectDir, extra) {
  return Object.assign({}, process.env, {
    AGENTIC_CORTEX_DB: dbPath,
    AGENTIC_CORTEX_PROJECT: projectDir,
  }, extra || {});
}

function mcpSession(projectDir, calls, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const child = spawn('node', [MCP_SERVER], {
      cwd: projectDir,
      env: sandboxEnv(projectDir, opts.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const responses = new Map();
    let stdoutBuf = '';
    let stderrTail = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) { finished = true; child.kill(); finish(); }
    }, SESSION_TIMEOUT_MS);

    function finish() {
      clearTimeout(timer);
      resolve({ responses, stderrTail, exitCode: child.exitCode, killed: finished && child.exitCode === null });
    }

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg;
        try { msg = JSON.parse(trimmed); } catch { continue; }
        if (msg.id !== undefined && msg.id !== null) responses.set(msg.id, msg);
      }
    });
    child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-2000); });
    child.on('error', (err) => { if (!finished) { finished = true; stderrTail += String(err); finish(); } });
    child.on('close', () => { if (!finished) { finished = true; finish(); } });

    // Handshake + calls, then close stdin (server drains and exits)
    const wire = [];
    wire.push(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sandbox-agent', version: '1.0.0' } } }));
    wire.push(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    calls.forEach((c, i) => {
      wire.push(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: c.name, arguments: c.args || {} } }));
    });
    child.stdin.write(wire.join('\n') + '\n');
    child.stdin.end();
  });
}

function unwrap(resp) {
  // tools/call result → content text
  if (!resp) return { ok: false, error: 'no response' };
  if (resp.error) return { ok: false, error: JSON.stringify(resp.error) };
  const r = resp.result;
  if (r && r.isError) {
    const txt = (r.content || []).map(c => c.text || '').join('');
    return { ok: false, error: txt || 'tool reported isError' };
  }
  const text = (r && r.content || []).map(c => c.text || '').join('');
  return { ok: true, text };
}

/** Pull an observation id out of a save response (JSON blob or prose). */
function extractId(text) {
  const m = /"id"\s*:\s*(\d+)/.exec(text) || /(?:id|ID)\s*[:= #]+(\d+)/.exec(text);
  return m ? parseInt(m[1], 10) : null;
}

/** Pull a session id out of a session_start response. */
function extractSessionId(text) {
  const m = /"session_id"\s*:\s*"([^"]+)"/.exec(text) || /"id"\s*:\s*"([^"]+)"/.exec(text);
  return m ? m[1] : null;
}

function runCli(args, projectDir, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI].concat(args), {
      cwd: projectDir || ROOT,
      env: sandboxEnv(projectDir || ROOT),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs || 60000);
    child.stdout.on('data', c => out += c);
    child.stderr.on('data', c => err += c);
    child.on('close', () => { clearTimeout(timer); resolve({ out, err, code: child.exitCode }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ out, err: err + String(e), code: -1 }); });
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────
// Scenarios
// ─────────────────────────────────────────────────────────────────────

async function s1_detection() {
  section('S1 · Agent detection & onboarding');
  // 1a. CLI mcp-config works (agents discover how to wire AC in)
  const cfg = await runCli(['mcp-config', '--agent', 'claude'], projectA);
  check('S1', 'mcp-config emits valid MCP wiring', cfg.code === 0 && cfg.out.includes('mcpServers') && cfg.out.includes('agentic-cortex'),
    cfg.code !== 0 ? ('exit ' + cfg.code + ' stderr: ' + cfg.err.slice(0, 200)) : 'ok');

  // 1b. MCP handshake + tool discovery
  const t0 = Date.now();
  const s = await mcpSession(projectA, [{ name: 'memory_health', args: {} }]);
  const handshakeMs = Date.now() - t0;
  const init = s.responses.get(0);
  check('S1', 'MCP initialize handshake succeeds', !!(init && init.result && init.result.serverInfo),
    init ? JSON.stringify(init).slice(0, 200) : 'no initialize response');
  const health = unwrap(s.responses.get(1));
  check('S1', 'memory_health responds on fresh DB', health.ok, health.error || '');
  check('S1', 'session startup latency reasonable (<15s incl. node boot)', handshakeMs < 15000, handshakeMs + 'ms');

  // 1c. tools/list — the discovery surface an agent sees
  const s2 = await mcpSession(projectA, []);
  // tools/list isn't a tools/call; do a raw probe session instead
  const probe = await new Promise((resolve) => {
    const child = spawn('node', [MCP_SERVER], { cwd: projectA, env: sandboxEnv(projectA), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', c => out += c);
    child.stderr.on('data', c => err += c);
    child.on('close', () => resolve({ out, err }));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    child.stdin.end();
  });
  let toolNames = [];
  let bootstrapDesc = '';
  try {
    for (const line of probe.out.split('\n')) {
      const m = line.trim() && JSON.parse(line.trim());
      if (m && m.id === 2 && m.result && m.result.tools) {
        toolNames = m.result.tools.map(t => t.name);
        const b = m.result.tools.find(t => t.name === 'memory_bootstrap');
        bootstrapDesc = b ? b.description : '';
      }
    }
  } catch (e) { /* captured below */ }
  check('S1', 'tools/list exposes a rich toolset (>=20 tools)', toolNames.length >= 20, 'got ' + toolNames.length + ': ' + toolNames.slice(0, 10).join(','));
  check('S1', 'memory_bootstrap present with session-start guidance', /FIRST|session start/i.test(bootstrapDesc), bootstrapDesc.slice(0, 200));
  return { toolNames };
}

async function s2_coldStart() {
  section('S2 · Cold start (empty memory)');
  const t0 = Date.now();
  const s = await mcpSession(projectA, [{ name: 'memory_bootstrap', args: {} }]);
  const ms = Date.now() - t0;
  const boot = unwrap(s.responses.get(1));
  check('S2', 'bootstrap on empty project succeeds without error', boot.ok, boot.error || '');
  if (boot.ok) {
    check('S2', 'bootstrap returns structured context (XML)', boot.text.includes('<'), 'no markup in: ' + boot.text.slice(0, 150));
    check('S2', 'cold-start bootstrap latency < 15s', ms < 15000, ms + 'ms');
    return { coldText: boot.text, coldMs: ms };
  }
  return {};
}

async function s3_inSession() {
  section('S3 · Within-session memory (save → recall mid-task)');
  const saves = [
    { name: 'memory_save', args: { title: 'Use vitest not jest', content: 'DECISION: this project uses vitest for all tests. Do not add jest config.', type: 'decision', importance: 8 } },
    { name: 'memory_save', args: { title: 'Windows path gotcha', content: 'GOTCHA: path.join on this repo must use forward slashes when passed to better-sqlite3.', type: 'gotcha', importance: 7 } },
    { name: 'memory_save', args: { title: 'API auth scheme', content: 'ARCHITECTURE: auth uses short-lived JWT in Authorization header, refreshed via /auth/refresh cookie.', type: 'architecture', importance: 9 } },
    { name: 'memory_save', args: { title: 'Release procedure', content: 'PROCEDURE: to release — npm version minor, run all tests, npm publish, git push tags.', type: 'procedure', steps: ['npm version minor', 'run tests', 'npm publish'] } },
    { name: 'memory_save', args: { title: 'User prefers tabs', content: 'PREFERENCE: maintainer prefers tab indentation and single quotes.', type: 'preference', importance: 5 } },
  ];
  const s = await mcpSession(projectA, saves.concat([
    { name: 'memory_search', args: { query: 'test framework vitest jest', limit: 5 } },
    { name: 'memory_search', args: { query: 'authentication JWT authorization', limit: 5 } },
  ]));
  let allOk = true;
  for (let i = 0; i < saves.length; i++) {
    const r = unwrap(s.responses.get(i + 1));
    if (!r.ok) allOk = false;
    check('S3', 'save "' + saves[i].args.title + '"', r.ok, r.error || '');
  }
  const search1 = unwrap(s.responses.get(6));
  check('S3', 'search "which test framework" retrieves the vitest decision', search1.ok && /vitest/i.test(search1.text), search1.ok ? search1.text.slice(0, 250) : search1.error);
  const search2 = unwrap(s.responses.get(7));
  check('S3', 'search "how does authentication work" retrieves the JWT architecture note', search2.ok && /JWT|auth/i.test(search2.text), search2.ok ? search2.text.slice(0, 250) : search2.error);
  // Round-trip: get back the release-procedure row by the id the server returned
  const savedId = extractId(unwrap(s.responses.get(4)).text);
  if (savedId) {
    const g = await mcpSession(projectA, [{ name: 'memory_get', args: { id: savedId } }]);
    const got = unwrap(g.responses.get(1));
    check('S3', 'memory_get by returned id round-trips full content (id=' + savedId + ')', got.ok && /npm publish|Release procedure/i.test(got.text), got.ok ? got.text.slice(0, 150) : got.error);
  } else {
    check('S3', 'memory_get by returned id round-trips full content', false, 'could not parse an id from save response: ' + unwrap(s.responses.get(4)).text.slice(0, 200));
  }
}

async function s4_sessionLifecycle() {
  section('S4 · Session lifecycle tracking');
  const s = await mcpSession(projectA, [
    { name: 'session_start', args: { prompt: 'Fix the flaky vitest timeout in src/index.test.js' } },
  ]);
  const start = unwrap(s.responses.get(1));
  check('S4', 'session_start returns a session id', start.ok && /session|id/i.test(start.text), start.error || start.text.slice(0, 150));
  const sid = extractSessionId(start.text);

  // One agent session: start → work (save) → end with summary
  const s2 = await mcpSession(projectA, [
    { name: 'session_start', args: { prompt: 'Fix the flaky vitest timeout in src/index.test.js' } },
    { name: 'memory_save', args: { title: 'Timeout was 2s too low', content: 'The flaky test failed because global setup took 1.9s and timeout was 2s. Raised to 10s.', type: 'bugfix' } },
  ]);
  const liveSid = extractSessionId(unwrap(s2.responses.get(1)).text);
  const endCalls = [
    { name: 'session_end', args: { summary: 'Fixed flaky test by raising timeout to 10s; root cause was slow global setup.' } },
  ];
  if (liveSid) endCalls[0].args.sessionId = liveSid;
  else if (sid) endCalls[0].args.sessionId = sid;
  const s3 = await mcpSession(projectA, endCalls);
  const end = unwrap(s3.responses.get(1));
  check('S4', 'session_end accepts summary', end.ok, end.error || '');
  // New spawn: timeline + profile should reflect the ended session
  const s4b = await mcpSession(projectA, [
    { name: 'memory_context', args: {} },
    { name: 'memory_profile', args: {} },
  ]);
  const ctx = unwrap(s4b.responses.get(1));
  check('S4', 'memory_context lists the recorded session', ctx.ok && /flaky|timeout|vitest/i.test(ctx.text), ctx.ok ? ctx.text.slice(0, 250) : ctx.error);
  const prof = unwrap(s4b.responses.get(2));
  check('S4', 'memory_profile returns project-scoped activity', prof.ok, prof.error || prof.text.slice(0, 120));
}

async function s5_crossSession() {
  section('S5 · Memory across sessions (agent restart)');
  // Brand-new spawned process = agent restarted days later, same project
  const s = await mcpSession(projectA, [
    { name: 'memory_bootstrap', args: { workingOn: 'adding a new endpoint' } },
    { name: 'memory_search', args: { query: 'release procedure steps', limit: 3 } },
    { name: 'memory_search', args: { query: 'tabs or spaces indentation preference', limit: 3 } },
  ]);
  const boot = unwrap(s.responses.get(1));
  const bootText = boot.ok ? boot.text : '';
  const checks = [
    ['vitest decision survived restart', /vitest/i.test(bootText)],
    ['JWT architecture note survived restart', /JWT/i.test(bootText)],
    ['release procedure survived restart', /release|npm publish/i.test(bootText)],
  ];
  check('S5', 'bootstrap after restart injects prior-session facts', boot.ok && checks.every(c => c[1]),
    boot.ok ? 'missing: ' + checks.filter(c => !c[1]).map(c => c[0]).join('; ') + ' — text: ' + bootText.slice(0, 300) : boot.error);
  const rel = unwrap(s.responses.get(2));
  check('S5', 'search recalls release procedure across sessions', rel.ok && /npm publish|npm version/i.test(rel.text), rel.ok ? rel.text.slice(0, 200) : rel.error);
  const pref = unwrap(s.responses.get(3));
  check('S5', 'search recalls preference across sessions', pref.ok && /tab/i.test(pref.text), pref.ok ? pref.text.slice(0, 200) : pref.error);
}

async function s6_crossProject() {
  section('S6 · Cross-project isolation & machine-wide recall');
  // Distinct fact in project B
  const sB = await mcpSession(projectB, [
    { name: 'memory_save', args: { title: 'Beta uses pnpm', content: 'DECISION: project-beta uses pnpm as its package manager, never npm.', type: 'decision', importance: 8 } },
    { name: 'memory_bootstrap', args: { workingOn: 'refactor build scripts' } },
    { name: 'memory_search', args: { query: 'vitest test framework', limit: 5 } },
    { name: 'memory_search', args: { query: 'package manager', limit: 5 } },
  ]);
  const bootB = unwrap(sB.responses.get(2));
  const bootBText = bootB.ok ? bootB.text : '';
  check('S6', 'project B bootstrap does NOT leak project A facts (vitest)', bootB.ok && !/vitest/i.test(bootBText),
    bootB.ok ? (/vitest/i.test(bootBText) ? 'LEAK: vitest found in B bootstrap' : 'clean') : bootB.error);
  const leak = unwrap(sB.responses.get(3));
  check('S6', 'project B search does not return A\'s vitest decision', leak.ok && !/vitest/i.test(leak.text),
    leak.ok ? (/vitest/i.test(leak.text) ? 'LEAK in search results' : 'clean') : leak.error);
  const own = unwrap(sB.responses.get(4));
  check('S6', 'project B search finds its own pnpm decision', own.ok && /pnpm/i.test(own.text), own.ok ? own.text.slice(0, 200) : own.error);

  // Machine-wide recall FROM project B's context: A's facts are findable on demand
  const machineTools = await findMachineTools();
  if (machineTools.searchAll) {
    const sX = await mcpSession(projectB, [{ name: machineTools.searchAll, args: { query: 'test framework vitest', limit: 5 } }]);
    const x = unwrap(sX.responses.get(1));
    check('S6', 'machine-wide search finds project A facts from project B', x.ok && /vitest/i.test(x.text), x.ok ? x.text.slice(0, 200) : x.error);
  } else {
    check('S6', 'machine-wide search tool available', false, 'no machine/search-all tool found in: ' + machineTools.names.join(','));
  }
}

async function findMachineTools() {
  const probe = await new Promise((resolve) => {
    const child = spawn('node', [MCP_SERVER], { cwd: projectA, env: sandboxEnv(projectA), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', c => out += c);
    child.on('close', () => resolve(out));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'p', version: '0' } } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    child.stdin.end();
  });
  const names = [];
  for (const line of probe.split('\n')) {
    try {
      const m = JSON.parse(line.trim());
      if (m && m.id === 2 && m.result && m.result.tools) m.result.tools.forEach(t => names.push(t.name));
    } catch { /* skip */ }
  }
  const searchAll = names.find(n => /machine.*(search|memory)|search.*all|all.*project/i.test(n)) ||
    names.find(n => /machine/i.test(n));
  const promote = names.find(n => /promote/i.test(n));
  return { names, searchAll, promote };
}

async function s6b_globalVault(promoteTool) {
  section('S6b · Machine-global vault (promote + recall anywhere)');
  if (!promoteTool) {
    check('S6b', 'promote-to-global tool available', false, 'missing tool');
    return;
  }
  const sA = await mcpSession(projectA, [
    { name: 'memory_save', args: { title: 'MACHINE LESSON: always pin CI node version', content: 'Lesson learned across projects: always pin the Node version in CI config to avoid surprise breakage.', type: 'learning', importance: 9, confidence: 95 } },
  ]);
  const saveR = unwrap(sA.responses.get(1));
  check('S6b', 'save machine lesson in project A', saveR.ok, saveR.error || '');
  // Promote requires confidence>=85 & utility>=10 — use force if the tool takes it
  const sP = await mcpSession(projectA, [{ name: promoteTool, args: { id: 6, force: true } }]);
  const pr = unwrap(sP.responses.get(1));
  check('S6b', 'promote observation to global vault', pr.ok, pr.error || pr.text.slice(0, 150));
  const machineTools = await findMachineTools();
  const sB = await mcpSession(projectB, [
    { name: machineTools.searchAll, args: { query: 'pin node version CI', limit: 5 } },
  ]);
  const got = unwrap(sB.responses.get(1));
  check('S6b', 'global vault fact recallable from a DIFFERENT project', got.ok && /pin|node|CI/i.test(got.text), got.ok ? got.text.slice(0, 250) : got.error);
}

async function s7_longHorizon() {
  section('S7 · Long-horizon (10 sessions, 30 memories, maintenance cycle)');
  const critical = [
    { title: 'CRITICAL: db migrations are forward-only', content: 'DECISION: database migrations in this project are forward-only, never editable after merge. Rollback is a new migration.', type: 'decision', importance: 10, confidence: 100 },
    { title: 'CRITICAL: never touch generated/, client code', content: 'GOTCHA: the generated/ directory is regenerated by codegen; editing it is always overwritten. Client code lives in src/client.', type: 'gotcha', importance: 10, confidence: 100 },
    { title: 'CRITICAL: deploy requires ENV freeze', content: 'PROCEDURE: production deploys require an ENV freeze window announced in #ops 24h ahead.', type: 'procedure', importance: 10, confidence: 100 },
  ];
  // Session 1: plant the critical facts
  const s1 = await mcpSession(projectA, critical.map(c => ({ name: 'memory_save', args: c })));
  const plantOk = critical.every((c, i) => unwrap(s1.responses.get(i + 1)).ok);
  check('S7', 'plant 3 critical facts in session 1', plantOk, JSON.stringify(s1.responses.size) + ' responses');

  // Sessions 2..10: routine churn (3 memories each, low importance)
  let churnFails = 0;
  for (let day = 2; day <= 10; day++) {
    const calls = [];
    for (let k = 0; k < 3; k++) {
      calls.push({ name: 'memory_save', args: { title: 'Day ' + day + ' note ' + k, content: 'Routine work note for day ' + day + ' item ' + k + ': refactored helper module, added test coverage.', type: 'observation', importance: 2 } });
    }
    const s = await mcpSession(projectA, calls);
    for (let k = 0; k < 3; k++) {
      if (!unwrap(s.responses.get(k + 1)).ok) churnFails++;
    }
  }
  check('S7', '9 churn sessions × 3 saves all succeed (27 saves)', churnFails === 0, churnFails + ' failures');

  // Maintenance cycle (freshness/auto-archive) — the thing that could evict critical facts
  const m = await mcpSession(projectA, [{ name: 'memory_maintenance', args: {} }]);
  const maint = unwrap(m.responses.get(1));
  check('S7', 'maintenance cycle runs without error', maint.ok, maint.error || '');

  // Fresh agent session: are the critical facts still retrievable?
  const f = await mcpSession(projectA, [
    { name: 'memory_search', args: { query: 'migrations forward-only rollback', limit: 5 } },
    { name: 'memory_search', args: { query: 'generated directory codegen editing', limit: 5 } },
    { name: 'memory_search', args: { query: 'production deploy ENV freeze window', limit: 5 } },
    { name: 'memory_bootstrap', args: { workingOn: 'planning a schema change and deploy' } },
  ]);
  const q1 = unwrap(f.responses.get(1));
  check('S7', 'critical fact 1 (migrations) retrievable after churn+maintenance', q1.ok && /forward-only/i.test(q1.text), q1.ok ? q1.text.slice(0, 200) : q1.error);
  const q2 = unwrap(f.responses.get(2));
  check('S7', 'critical fact 2 (generated/) retrievable', q2.ok && /codegen|generated/i.test(q2.text), q2.ok ? q2.text.slice(0, 200) : q2.error);
  const q3 = unwrap(f.responses.get(3));
  check('S7', 'critical fact 3 (deploy freeze) retrievable', q3.ok && /freeze|ops/i.test(q3.text), q3.ok ? q3.text.slice(0, 200) : q3.error);
  const fb = unwrap(f.responses.get(4));
  check('S7', 'bootstrap after 30 memories + maintenance still surfaces critical facts', fb.ok && /forward-only|freeze|codegen/i.test(fb.text), fb.ok ? fb.text.slice(0, 300) : fb.error);
}

async function s8_concurrency() {
  section('S8 · Concurrent agents on the same project');
  const mkCalls = (tag) => {
    const calls = [];
    for (let i = 0; i < 10; i++) {
      calls.push({ name: 'memory_save', args: { title: tag + ' concurrent save ' + i, content: 'Concurrent write test from agent ' + tag + ' item ' + i + ': sharing the project memory store safely.', type: 'observation' } });
    }
    return calls;
  };
  const [r1, r2] = await Promise.all([
    mcpSession(projectA, mkCalls('agent-1')),
    mcpSession(projectA, mkCalls('agent-2')),
  ]);
  let ok1 = 0, ok2 = 0;
  for (let i = 0; i < 10; i++) { if (unwrap(r1.responses.get(i + 1)).ok) ok1++; if (unwrap(r2.responses.get(i + 1)).ok) ok2++; }
  check('S8', 'agent-1: 10/10 saves succeed under concurrency', ok1 === 10, ok1 + '/10 — stderr: ' + r1.stderrTail.slice(-150));
  check('S8', 'agent-2: 10/10 saves succeed under concurrency', ok2 === 10, ok2 + '/10 — stderr: ' + r2.stderrTail.slice(-150));
  const v = await mcpSession(projectA, [{ name: 'memory_search', args: { query: 'concurrent write test', limit: 25 } }]);
  const vr = unwrap(v.responses.get(1));
  const n = vr.ok ? (vr.text.match(/concurrent save/gi) || []).length : 0;
  check('S8', 'all 20 concurrent writes are durable and searchable', vr.ok && n >= 20, 'found ' + n + ' matching results; stderr: ' + v.stderrTail.slice(-150));
}

async function s9_robustness() {
  section('S9 · Robustness & lifecycle edges');
  // Plant a row and use its real id for edit/feedback/forget
  const plant = await mcpSession(projectA, [
    { name: 'memory_save', args: { title: 'To be edited', content: 'Initial content v1', type: 'observation' } },
  ]);
  const rid = extractId(unwrap(plant.responses.get(1)).text);
  if (!rid) {
    check('S9', 'plant row for lifecycle tests', false, 'no id parsed: ' + unwrap(plant.responses.get(1)).text.slice(0, 200));
    return;
  }
  const s = await mcpSession(projectA, [
    { name: 'memory_search', args: { query: '', limit: 5 } },
    { name: 'memory_search', args: { query: '???**++ unicode—café 日本語 quotes', limit: 5 } },
    { name: 'memory_edit', args: { id: rid, title: 'Edited title', content: 'Edited content v2 with more detail' } },
    { name: 'memory_feedback', args: { id: rid, type: 'helpful', reason: 'test feedback' } },
    { name: 'memory_forget', args: { id: rid } },
    { name: 'memory_search', args: { query: 'Edited content v2', limit: 5 } },
  ]);
  const empty = unwrap(s.responses.get(1));
  check('S9', 'empty query does not crash (graceful)', empty.ok || /required|invalid/i.test(empty.error || ''), empty.ok ? 'ok' : (empty.error || '').slice(0, 120));
  const weird = unwrap(s.responses.get(2));
  check('S9', 'unicode/Fts-hostile query does not crash', weird.ok, weird.error ? weird.error.slice(0, 150) : '');
  const edit = unwrap(s.responses.get(3));
  check('S9', 'memory_edit updates content (versioned)', edit.ok, edit.error || '');
  const fb = unwrap(s.responses.get(4));
  check('S9', 'feedback round-trips', fb.ok, fb.error || '');
  const fg = unwrap(s.responses.get(5));
  check('S9', 'memory_forget soft-deletes', fg.ok, fg.error || '');
  const after = unwrap(s.responses.get(6));
  check('S9', 'forgotten memory no longer returned by search', after.ok && !/Edited content v2/i.test(after.text),
    after.ok ? (cerr(after.text)) : after.error);
  function cerr(t) { return /Edited content v2/i.test(t) ? 'LEAK: forgotten memory still searchable' : 'clean'; }
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  AC agent-memory sandbox test — hermetic, real MCP/CLI   ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('sandbox: ' + sandboxRoot);
  console.log('db:      ' + dbPath);

  const keep = process.argv.includes('--keep');
  const mt = await findMachineTools();

  await s1_detection();
  await s2_coldStart();
  await s3_inSession();
  await s4_sessionLifecycle();
  await s5_crossSession();
  await s6_crossProject();
  await s6b_globalVault(mt.promote);
  await s7_longHorizon();
  await s8_concurrency();
  await s9_robustness();

  // ── Report ──
  const pass = results.filter(r => r.pass).length;
  const fail = results.length - pass;
  const byScenario = {};
  for (const r of results) {
    byScenario[r.scenario] = byScenario[r.scenario] || { pass: 0, fail: 0 };
    byScenario[r.scenario][r.pass ? 'pass' : 'fail']++;
  }

  console.log('\n══════════════ SUMMARY ══════════════');
  for (const [sc, c] of Object.entries(byScenario)) {
    console.log('  ' + sc.padEnd(6) + ' ' + c.pass + ' pass / ' + c.fail + ' fail');
  }
  console.log('  TOTAL: ' + pass + '/' + results.length + ' checks passed (' + fail + ' failed) in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

  // DB-level evidence for the report
  let dbStats = null;
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    dbStats = {
      observations: db.prepare('SELECT COUNT(*) c FROM observations').get().c,
      active: db.prepare('SELECT COUNT(*) c FROM observations WHERE is_active = 1').get().c,
      sessions: db.prepare('SELECT COUNT(*) c FROM sessions').get().c,
      projects: db.prepare('SELECT COUNT(DISTINCT project_path) c FROM observations').get().c,
    };
    db.close();
  } catch (e) { dbStats = { error: e.message }; }

  const report = {
    timestamp: new Date().toISOString(),
    version: require(path.join(ROOT, 'package.json')).version,
    sandbox: { root: sandboxRoot, db: dbPath, projectA, projectB, kept: keep },
    durationMs: Date.now() - t0,
    summary: { total: results.length, pass, fail, byScenario },
    dbStats,
    checks: results,
  };
  const outDir = path.join(ROOT, 'data', 'runs', 'sandbox-agent');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\nreport → data/runs/sandbox-agent/report.json');

  if (!keep) {
    try { fs.rmSync(sandboxRoot, { recursive: true, force: true }); } catch { /* windows lock */ }
  } else {
    console.log('sandbox kept at ' + sandboxRoot);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
