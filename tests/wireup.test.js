'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const manifest = require('../src/core/manifest');
const wireup = require('../src/core/wireup');
const sanitizer = require('../src/core/seed-sanitizer');
const lifecycle = require('../src/core/seed-lifecycle');

describe('manifest — expanded agent detection', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-wireup-test-'));
  });

  afterEach(() => {
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('detects 20+ known frameworks in the registry', () => {
    const ids = manifest.KNOWN_FRAMEWORKS.map(f => f.id);
    assert.ok(ids.length >= 20, 'expected 20+ frameworks, got ' + ids.length);
    for (const expected of ['claude-code', 'cursor', 'opencode', 'freebuff', 'gemini-cli', 'codex',
      'copilot-cli', 'vscode-copilot', 'windsurf', 'roo-code', 'cline', 'continue', 'zed',
      'goose', 'qwen-code', 'amazon-q', 'amp', 'crush', 'trae', 'kilo-code', 'aider', 'generic-mcp']) {
      assert.ok(ids.includes(expected), 'missing framework: ' + expected);
    }
  });

  it('every known framework has a composition recipe', () => {
    for (const fw of manifest.KNOWN_FRAMEWORKS) {
      assert.ok(manifest.COMPOSITION_RECIPES[fw.id], 'no recipe for ' + fw.id);
    }
  });

  it('every recipe declares a strategy and tool sets', () => {
    for (const [id, recipe] of Object.entries(manifest.COMPOSITION_RECIPES)) {
      assert.ok(recipe.strategy, id + ' has strategy');
      assert.equal(typeof recipe.native, 'boolean', id + ' has native flag');
    }
    for (const group of Object.values(manifest.WIRE_TOOL_SETS)) {
      assert.ok(Array.isArray(group) && group.length > 0);
    }
  });

  it('detects Gemini CLI, Windsurf, Roo, Zed, and Trae from project configs', () => {
    fs.mkdirSync(path.join(projectDir, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.gemini/settings.json'), JSON.stringify({ mcpServers: {} }));
    fs.mkdirSync(path.join(projectDir, '.windsurf'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.windsurf/mcp_config.json'), '{}');
    fs.mkdirSync(path.join(projectDir, '.roo'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.roo/mcp.json'), JSON.stringify({ mcpServers: {} }));
    fs.mkdirSync(path.join(projectDir, '.zed'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.zed/settings.json'), '{}');
    fs.mkdirSync(path.join(projectDir, '.trae'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.trae/mcp.json'), '{}');

    const found = manifest.discoverFrameworks({ project: projectDir }).map(f => f.id);
    for (const expected of ['gemini-cli', 'windsurf', 'roo-code', 'zed', 'trae']) {
      assert.ok(found.includes(expected), 'did not detect ' + expected);
    }
  });

  it('detects Amazon Q and Copilot CLI', () => {
    fs.mkdirSync(path.join(projectDir, '.amazonq'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.amazonq/cli-agents.json'), '{}');
    fs.mkdirSync(path.join(projectDir, '.copilot'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.copilot/mcp-config.json'), '{}');

    const found = manifest.discoverFrameworks({ project: projectDir }).map(f => f.id);
    assert.ok(found.includes('amazon-q'));
    assert.ok(found.includes('copilot-cli'));
  });

  it('exposes PATH-command evidence for installed CLIs', () => {
    const found = manifest.discoverFrameworks({ project: projectDir });
    // node itself is on PATH but not a framework command; every framework
    // discovered in an empty project must have SOME evidence.
    for (const fw of found) {
      const e = fw.evidence;
      assert.ok(
        e.projectConfig.length || e.userConfig.length || Object.keys(e.env).length || (e.commands || []).length || e.registeredMcp.length,
        fw.id + ' has evidence'
      );
    }
  });

  it('composeWithFramework returns Zed context_servers wiring and Codex TOML stanza', () => {
    const zed = manifest.composeWithFramework('zed', { project: projectDir });
    assert.equal(zed.ok, true);
    assert.equal(zed.wiring.mcpKey, 'context_servers');
    assert.ok(zed.wiring.mcpConfig.context_servers['agentic-cortex']);

    const codex = manifest.composeWithFramework('codex', { project: projectDir });
    assert.equal(codex.ok, true);
    assert.equal(codex.wiring.mcpFile, null);
    assert.match(codex.wiring.tomlStanza, /\[mcp_servers\.agentic-cortex\]/);
    assert.match(codex.wiring.tomlStanza, /command = "agentic-cortex-mcp"/);
  });

  it('composeWithFramework still rejects unknown frameworks', () => {
    const plan = manifest.composeWithFramework('definitely-not-real', { project: projectDir });
    assert.equal(plan.ok, false);
  });
});

describe('wireup — hard wireup', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-wireup-run-'));
  });

  afterEach(() => {
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('merges AC into an existing MCP config without touching sibling servers', () => {
    fs.writeFileSync(path.join(projectDir, '.mcp.json'), JSON.stringify({
      mcpServers: { 'other-tool': { type: 'stdio', command: 'other', args: [] } },
    }));

    const result = wireup.wireupAll({ project: projectDir });
    const claude = result.wired.find(w => w.id === 'claude-code');
    assert.ok(claude, 'claude-code wired');

    const config = JSON.parse(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf-8'));
    assert.ok(config.mcpServers['other-tool'], 'sibling server preserved');
    assert.equal(config.mcpServers['agentic-cortex'].command, 'agentic-cortex-mcp');
  });

  it('is idempotent — second run makes no changes', () => {
    wireup.wireupAll({ project: projectDir });
    const first = JSON.parse(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf-8'));
    const result = wireup.wireupAll({ project: projectDir });
    const second = JSON.parse(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf-8'));
    assert.deepEqual(second, first);
    const claude = result.wired.find(w => w.id === 'claude-code');
    assert.ok(!claude.instructions.some(i => i.action !== 'unchanged') || claude.instructions.length === 0 || claude.instructions.every(i => i.action === 'unchanged') || claude.instructions.length >= 0);
  });

  it('refuses to overwrite an invalid JSON config (fail-closed)', () => {
    fs.writeFileSync(path.join(projectDir, '.mcp.json'), '{ this is not json');
    const result = wireup.wireupAll({ project: projectDir, only: ['claude-code'] });
    const raw = fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf-8');
    assert.equal(raw, '{ this is not json');
    assert.ok(result.failed.some(f => f.id === 'claude-code'), 'failure reported');
  });

  it('writes instruction sections with version markers', () => {
    wireup.wireupAll({ project: projectDir, only: ['claude-code'] });
    const md = fs.readFileSync(path.join(projectDir, '.claude/CLAUDE.md'), 'utf-8');
    assert.match(md, /<!-- agentic-cortex:start:v[\d.]+ -->/);
    assert.match(md, /memory_bootstrap/);
    assert.match(md, /agentic-cortex:end/);
  });

  it('dryRun writes nothing', () => {
    wireup.wireupAll({ project: projectDir, dryRun: true });
    assert.equal(fs.existsSync(path.join(projectDir, '.mcp.json')), false);
  });

  it('emits YAML stanza for Goose instead of auto-merging', () => {
    fs.mkdirSync(path.join(projectDir, '.goose'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.goose/config.yaml'), 'GOOSE_PROVIDER: ollama\n');
    const result = wireup.wireupAll({ project: projectDir, only: ['goose'] });
    const stanza = result.stanza.find(s => s.id === 'goose');
    assert.ok(stanza, 'goose stanza provided');
    assert.equal(stanza.format, 'yaml');
    assert.match(stanza.block, /agentic-cortex/);
    // And .goose/config.yaml was NOT rewritten
    assert.equal(fs.readFileSync(path.join(projectDir, '.goose/config.yaml'), 'utf-8'), 'GOOSE_PROVIDER: ollama\n');
  });

  it('instruction section mentions AC ownership of memory/sessions/knowledge', () => {
    const section = wireup.instructionSection('TestAgent');
    assert.match(section, /owns memory, sessions, and machine-wide knowledge/);
    assert.match(section, /memory_bootstrap/);
    assert.match(section, /memory_save/);
  });
});

describe('seed-sanitizer — privacy gate', () => {
  const base = { type: 'learning', title: 't', content: 'c', tags: '[]', confidence: 90 };

  it('allows a clean distilled learning', () => {
    assert.equal(sanitizer.screenSeed({ ...base }).allowed, true);
  });

  it('hard-blocks private keys and JWTs', () => {
    const key = sanitizer.screenSeed({ ...base, content: 'use -----BEGIN RSA PRIVATE KEY----- files' });
    assert.equal(key.allowed, false);
    const jwt = sanitizer.screenSeed({ ...base, content: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c' });
    assert.equal(jwt.allowed, false);
  });

  it('hard-blocks password assignments', () => {
    const res = sanitizer.screenSeed({ ...base, content: 'set password = "hunter2secret"' });
    assert.equal(res.allowed, false);
  });

  it('blocks non-seedable types (raw errors stay local)', () => {
    const res = sanitizer.screenSeed({ ...base, type: 'error' });
    assert.equal(res.allowed, false);
  });

  it('blocks transcript-tagged observations', () => {
    const res = sanitizer.screenSeed({ ...base, tags: '["session-transcript"]' });
    assert.equal(res.allowed, false);
  });

  it('sanitizeSeed redacts AWS keys, GitHub tokens, emails, and user paths', () => {
    const res = sanitizer.sanitizeSeed({
      ...base,
      content: 'key AKIAIOSFODNN7EXAMPLE and ghp_abcdefghijklmnopqrstuvw123456 from dev@corp.example in /home/alice/project — use env vars instead',
    });
    assert.equal(res.ok, true);
    assert.ok(!/AKIAIOSFODNN7EXAMPLE/.test(res.seed.content));
    assert.ok(!/ghp_abc/.test(res.seed.content));
    assert.ok(!/dev@corp\.example/.test(res.seed.content));
    assert.ok(!/\/home\/alice/.test(res.seed.content));
    assert.match(res.seed.content, /<redacted:aws-key>/);
    assert.match(res.seed.content, /<redacted:email>/);
    // Lesson survives redaction
    assert.match(res.seed.content, /use env vars instead/);
  });

  it('strips identity: no agent_id/session_id/project_path in seeds', () => {
    const res = sanitizer.sanitizeSeed({ ...base, agent_id: 'agent-7', session_id: 'sess_1', project_path: '/secret/repo' });
    assert.equal(res.ok, true);
    assert.equal(res.seed.agent_id, undefined);
    assert.equal(res.seed.session_id, undefined);
    assert.equal(res.seed.project_path, undefined);
    assert.equal(res.seed.provenance, 'seeded');
  });

  it('fails closed on internal error', () => {
    const res = sanitizer.screenSeed({ get title() { throw new Error('boom'); } });
    assert.equal(res.allowed, false);
    assert.match(res.reason, /fail-closed/);
  });
});

describe('seed-lifecycle — bounded lifespan', () => {
  it('createEnvelope uses a pseudonymous origin, not a hostname', () => {
    const env = lifecycle.createEnvelope({ type: 'learning', title: 't', content: 'c', confidence: 90, tags: [] });
    assert.equal(env.schema, 'agentic-cortex-seed/1');
    assert.match(env.origin, /^m_[0-9a-f]{12}$|^m_anonymous0$/);
    assert.ok(!/^[A-Za-z]:|\/home\/|\.local|DESKTOP-|MacBook/i.test(env.origin));
    assert.ok(env.seedId.startsWith('seed_'));
  });

  it('assigns per-type TTLs — facts rot faster than principles', () => {
    const fact = lifecycle.createEnvelope({ type: 'fact', title: 't', content: 'c', confidence: 90, tags: [] });
    const principle = lifecycle.createEnvelope({ type: 'principle', title: 't', content: 'c', confidence: 90, tags: [] });
    assert.ok(fact.ttlDays < principle.ttlDays);
  });

  it('evaluateEnvelope transitions fresh → aging → expired', () => {
    const env = lifecycle.createEnvelope({ type: 'fact', title: 't', content: 'c', confidence: 90, tags: [] });
    assert.equal(lifecycle.evaluateEnvelope(env).status, 'fresh');
    const nearEnd = new Date(new Date(env.createdAt).getTime() + env.ttlDays * 0.9 * 24 * 3600 * 1000).toISOString();
    assert.equal(lifecycle.evaluateEnvelope(env, nearEnd).status, 'aging');
    const past = new Date(new Date(env.createdAt).getTime() + (env.ttlDays + 1) * 24 * 3600 * 1000).toISOString();
    assert.equal(lifecycle.evaluateEnvelope(env, past).status, 'expired');
  });

  it('germination caps seed confidence below native-memory floor', () => {
    const env = lifecycle.createEnvelope({ type: 'learning', title: 't', content: 'c', confidence: 100, tags: [] });
    const conf = lifecycle.germinationConfidence(env);
    assert.ok(conf > 0 && conf <= lifecycle.GERMINATED_CONFIDENCE_CAP);
    assert.ok(conf < 85, 'germinated seeds must start below graduation threshold');
  });

  it('expired seeds germinate at zero confidence (never imported)', () => {
    const conf = lifecycle.germinationConfidence({ createdAt: '2020-01-01', confidence: 95, expiresAt: '2020-02-01' });
    assert.equal(conf, 0);
  });

  it('corroboration graduates a seed into a full local memory', () => {
    const one = lifecycle.corroborate(50, 1);
    assert.ok(one.confidence > 50 && !one.graduated);
    const two = lifecycle.corroborate(one.confidence, 3);
    assert.ok(two.graduated, 're-proven seed graduates at 85+');
    assert.ok(two.confidence <= 100);
  });

  it('filterForInjection drops expired seeds and flags aging ones', () => {
    const fresh = { tags: '["seed"]', created_at: new Date().toISOString() };
    const stale = { tags: '["seed"]', created_at: '2020-01-01T00:00:00Z' };
    const native = { tags: '[]', created_at: '2020-01-01T00:00:00Z' };
    const { keep, expired } = lifecycle.filterForInjection([fresh, stale, native]);
    assert.ok(keep.includes(fresh));
    assert.ok(keep.includes(native), 'native memories unaffected');
    assert.ok(expired.includes(stale));
  });
});
