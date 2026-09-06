'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Manifest module is pure/deterministic — no DB needed.
const manifest = require('../src/core/manifest');

describe('manifest — agent capability manifest + framework auto-discovery', () => {
  /** @type {string} temp project dir */
  let projectDir;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-manifest-test-'));
  });

  afterEach(() => {
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  describe('getManifest', () => {
    it('emits a schema-versioned, machine-readable manifest', () => {
      const m = manifest.getManifest({ project: projectDir });

      assert.equal(m.manifest, 'agentic-cortex-capability-manifest');
      assert.equal(m.schemaVersion, '1.0.0');
      assert.equal(m.agent.name, 'agentic-cortex');
      assert.ok(m.agent.version, 'has package version');
      assert.ok(Array.isArray(m.transports) || Array.isArray(m.agent.transports));
    });

    it('inventories capabilities with id, version, description, exposedVia', () => {
      const m = manifest.getManifest({ project: projectDir });
      assert.ok(Array.isArray(m.capabilities));
      assert.ok(m.capabilities.length >= 35, 'expected 35+ capabilities, got ' + m.capabilities.length);

      for (const cap of m.capabilities) {
        assert.ok(cap.id, 'capability has id');
        assert.ok(cap.version, 'capability has version');
        assert.ok(cap.description, 'capability has description');
        assert.ok(Array.isArray(cap.exposedVia) && cap.exposedVia.length > 0, cap.id + ' exposedVia');
      }

      // Spot-check the flagship capabilities
      const ids = m.capabilities.map(c => c.id);
      assert.ok(ids.includes('memory.typed'), 'typed memory');
      assert.ok(ids.includes('code.task-scoped-injection'), 'code injection');
      assert.ok(ids.includes('reasoning.prm'), 'PRM');
      assert.ok(ids.includes('audit.conflict-resolution'), 'Dempster-Shafer');
      assert.ok(ids.includes('orchestration.swarm'), 'swarm');
      assert.ok(ids.includes('learning.self-improve'), 'self-improve');
    });

    it('declares interfaces and composition roles', () => {
      const m = manifest.getManifest({ project: projectDir });
      assert.ok(m.interfaces.mcp.command === 'agentic-cortex-mcp');
      assert.ok(m.interfaces.node.require === 'agentic-cortex');
      assert.ok(m.interfaces.cli.binary === 'agentic-cortex');
      assert.ok(Array.isArray(m.composition.providesTo));
      assert.ok(Array.isArray(m.composition.consumes));
    });
  });

  describe('writeManifestFile', () => {
    it('writes agentic-cortex.manifest.json to the project', () => {
      const res = manifest.writeManifestFile({ project: projectDir });
      assert.equal(res.ok, true);
      assert.ok(fs.existsSync(res.file));

      const parsed = JSON.parse(fs.readFileSync(res.file, 'utf-8'));
      assert.equal(parsed.schemaVersion, '1.0.0');
      assert.equal(parsed.agent.name, 'agentic-cortex');
    });

    it('honors an explicit file override', () => {
      const custom = path.join(projectDir, 'custom-manifest.json');
      const res = manifest.writeManifestFile({ project: projectDir, file: custom });
      assert.equal(res.ok, true);
      assert.ok(fs.existsSync(custom));
    });
  });

  describe('discoverFrameworks', () => {
    it('detects a project-scoped Claude Code .mcp.json', () => {
      fs.writeFileSync(
        path.join(projectDir, '.mcp.json'),
        JSON.stringify({ mcpServers: { 'agentic-cortex': { type: 'stdio', command: 'agentic-cortex-mcp', args: [] } } })
      );

      const found = manifest.discoverFrameworks({ project: projectDir });
      const cc = found.find(f => f.id === 'claude-code');

      assert.ok(cc, 'claude-code discovered');
      assert.equal(cc.scope, 'project');
      assert.ok(cc.evidence.projectConfig.some(p => p.endsWith('.mcp.json')));
      assert.equal(cc.evidence.registeredMcp.length, 1);
      assert.equal(cc.evidence.registeredMcp[0].name, 'agentic-cortex');
    });

    it('detects Cursor and OpenCode configs', () => {
      fs.mkdirSync(path.join(projectDir, '.cursor'), { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, '.cursor/mcp.json'),
        JSON.stringify({ mcpServers: { 'agentic-cortex': { type: 'stdio', command: 'agentic-cortex-mcp' } } })
      );
      fs.writeFileSync(
        path.join(projectDir, 'opencode.json'),
        JSON.stringify({ mcp: { 'agentic-cortex': { type: 'local', command: ['agentic-cortex-mcp'], enabled: true } } })
      );

      const found = manifest.discoverFrameworks({ project: projectDir });
      const ids = found.map(f => f.id);
      assert.ok(ids.includes('cursor'));
      assert.ok(ids.includes('opencode'));
    });

    it('returns empty when nothing is present', () => {
      const found = manifest.discoverFrameworks({ project: projectDir });
      // May still see generic-mcp (always listed) — but only with real evidence.
      for (const f of found) {
        assert.ok(
          f.evidence.projectConfig.length > 0 || f.evidence.userConfig.length > 0 ||
          Object.keys(f.evidence.env).length > 0 || f.evidence.registeredMcp.length > 0 ||
          (f.evidence.commands || []).length > 0,
          f.id + ' has evidence'
        );
      }
    });
  });

  describe('composeWithFramework', () => {
    it('returns wiring for claude-code', () => {
      const plan = manifest.composeWithFramework('claude-code', { project: projectDir });
      assert.equal(plan.ok, true);
      assert.equal(plan.framework.id, 'claude-code');
      assert.ok(plan.wiring.mcpConfig.mcpServers['agentic-cortex']);
      assert.ok(plan.wiring.memoryTools.includes('memory_bootstrap'));
      assert.ok(plan.wiring.auditTools.includes('memory_resolve_conflict'));
      assert.ok(plan.wiring.reasoningTools.includes('memory_tree_search'));
    });

    it('rejects removed legacy framework identifiers', () => {
      const plan = manifest.composeWithFramework('legacy-agent-id', { project: projectDir });
      assert.equal(plan.ok, false);
    });

    it('errors on unknown frameworks with a hint', () => {
      const plan = manifest.composeWithFramework('not-a-framework');
      assert.equal(plan.ok, false);
      assert.ok(plan.known.includes('claude-code'));
    });

    it('accepts a discovered framework object directly', () => {
      fs.writeFileSync(
        path.join(projectDir, '.mcp.json'),
        JSON.stringify({ mcpServers: { 'agentic-cortex': { type: 'stdio', command: 'agentic-cortex-mcp' } } })
      );
      const [discovered] = manifest.discoverFrameworks({ project: projectDir });
      const plan = manifest.composeWithFramework(discovered, { project: projectDir });
      assert.equal(plan.ok, true);
      assert.equal(plan.framework.id, discovered.id);
    });
  });
});
