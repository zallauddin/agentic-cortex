'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const offline = require('../src/core/offline-agent');

describe('offline agent', () => {
  it('reports explicit offline and LLM-boundary capabilities', () => {
    const audit = offline.auditCapabilities();
    assert.equal(audit.mode, 'offline-first');
    assert.ok(audit.capabilities.some(c => c.id === 'coding.transform' && c.offline));
    assert.ok(audit.capabilities.some(c => c.id === 'coding.novel' && !c.offline));
  });

  it('plans from package scripts without an LLM', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-offline-plan-'));
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    const plan = offline.planTask(project, 'fix the bug');
    assert.equal(plan.mode, 'offline');
    assert.ok(plan.steps.some(s => s.action === 'run_check' && s.command === 'npm'));
  });

  it('applies only unique, project-bounded replacements and writes a backup', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-offline-edit-'));
    const file = path.join(project, 'a.txt');
    fs.writeFileSync(file, 'before\n');
    const result = offline.applyChanges(project, [{ file: 'a.txt', oldText: 'before', newText: 'after' }]);
    assert.equal(result.changed.length, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), 'after\n');
    assert.equal(fs.readFileSync(file + '.offline-backup', 'utf8'), 'before\n');
  });

  it('rejects ambiguous replacements without changing the file', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-offline-safe-'));
    const file = path.join(project, 'a.txt');
    fs.writeFileSync(file, 'same\nsame\n');
    const result = offline.applyChanges(project, [{ file: 'a.txt', oldText: 'same', newText: 'changed' }]);
    assert.equal(result.changed.length, 0);
    assert.equal(result.skipped[0].reason, 'oldText is ambiguous');
    assert.equal(fs.readFileSync(file, 'utf8'), 'same\nsame\n');
  });

  it('runs and captures a deterministic check', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-offline-check-'));
    const result = offline.runCheck(project, { command: process.execPath, args: ['-e', 'process.stdout.write("ok")'] });
    assert.equal(result.ok, true);
    assert.equal(result.stdout, 'ok');
  });
});
