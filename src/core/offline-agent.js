'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const codeIndex = require('./code-index');

const CAPABILITY_MATRIX = [
  { id: 'memory.search', label: 'Memory/search', offline: true, mechanism: 'SQLite FTS5, filters, deterministic ranking' },
  { id: 'code.index', label: 'Repository/code indexing', offline: true, mechanism: 'Static graph and symbol index' },
  { id: 'analysis.graph', label: 'Dependency and structural analysis', offline: true, mechanism: 'Import graph, symbol metadata, git history' },
  { id: 'research.collect', label: 'Local research collection', offline: true, mechanism: 'Files, indexed documents, deterministic extraction' },
  { id: 'research.interpret', label: 'Open-ended research interpretation', offline: false, mechanism: 'Requires an LLM or human-provided rules' },
  { id: 'reasoning.deterministic', label: 'Rule/evidence reasoning', offline: true, mechanism: 'Deterministic reasoner, FSM, rules, workflows' },
  { id: 'coding.transform', label: 'Constrained code transformations', offline: true, mechanism: 'Validated exact replacements and generated patches' },
  { id: 'coding.novel', label: 'Novel arbitrary code generation', offline: false, mechanism: 'Requires an LLM, template, or recorded skill' },
  { id: 'verification.commands', label: 'Tests/typecheck/lint commands', offline: true, mechanism: 'Child-process execution with captured results' },
  { id: 'verification.semantic', label: 'Semantic review of unknown behavior', offline: false, mechanism: 'Requires rules, tests, or an LLM' },
  { id: 'file.change', label: 'Safe file changes', offline: true, mechanism: 'Workspace-bounded, backup-aware exact edits' },
  { id: 'task.planning', label: 'Deterministic task planning', offline: true, mechanism: 'Repository signals, task keywords, workflow DAG' },
];

function auditCapabilities() {
  return {
    mode: 'offline-first',
    llmRequiredForAllTasks: false,
    capabilities: CAPABILITY_MATRIX.map(c => ({ ...c })),
    offlineCount: CAPABILITY_MATRIX.filter(c => c.offline).length,
    llmAssistedCount: CAPABILITY_MATRIX.filter(c => !c.offline).length,
    limitation: 'Offline mode completes bounded, testable, rule-driven tasks. Novel code design and open-ended interpretation require a skill, template, human input, or optional LLM.',
  };
}

function resolveInside(project, filePath) {
  const root = path.resolve(project || process.cwd());
  const target = path.resolve(root, filePath);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('File path escapes project root: ' + filePath);
  return target;
}

function readJsonIfExists(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function detectPackageScripts(project) {
  const pkg = readJsonIfExists(path.join(project, 'package.json'));
  return pkg && pkg.scripts ? pkg.scripts : {};
}

function planTask(project, task, opts = {}) {
  const root = path.resolve(project || process.cwd());
  const text = String(task || '').trim();
  if (!text) throw new Error('task is required');
  const scripts = detectPackageScripts(root);
  const files = codeIndex.gitChangedFiles(root);
  const keywords = text.toLowerCase();
  const checks = [];
  if (scripts.test && /test|bug|fix|regression|verify/.test(keywords)) checks.push({ command: 'npm', args: ['test'], reason: 'project test script' });
  if (scripts.typecheck) checks.push({ command: 'npm', args: ['run', 'typecheck'], reason: 'project typecheck script' });
  if (scripts.lint) checks.push({ command: 'npm', args: ['run', 'lint'], reason: 'project lint script' });
  if (checks.length === 0 && scripts.test) checks.push({ command: 'npm', args: ['test'], reason: 'default verification' });
  return {
    mode: 'offline',
    project: root,
    task: text,
    repository: { changedFiles: files, packageScripts: Object.keys(scripts) },
    steps: [
      { id: 'inspect', action: 'inspect_repository', status: 'planned' },
      { id: 'change', action: 'apply_declared_changes', status: opts.changes ? 'ready' : 'blocked', reason: opts.changes ? 'explicit changes supplied' : 'offline mode will not invent code' },
      ...checks.map((c, i) => ({ id: 'check-' + i, action: 'run_check', ...c, status: 'planned' })),
    ],
    limitations: ['No arbitrary code is invented offline; provide exact replacements, a template, or a registered skill.'],
  };
}

function applyChanges(project, changes = []) {
  const root = path.resolve(project || process.cwd());
  if (!Array.isArray(changes) || changes.length === 0) return { changed: [], skipped: [] };
  const changed = [];
  const skipped = [];
  for (const change of changes) {
    if (!change || !change.file || typeof change.oldText !== 'string' || typeof change.newText !== 'string') {
      skipped.push({ change, reason: 'requires file, oldText, and newText' });
      continue;
    }
    const file = resolveInside(root, change.file);
    if (!fs.existsSync(file)) { skipped.push({ file: change.file, reason: 'file does not exist' }); continue; }
    const before = fs.readFileSync(file, 'utf8');
    const occurrences = before.split(change.oldText).length - 1;
    if (occurrences !== 1) { skipped.push({ file: change.file, reason: occurrences === 0 ? 'oldText not found' : 'oldText is ambiguous', occurrences }); continue; }
    const backup = file + '.offline-backup';
    fs.writeFileSync(backup, before, 'utf8');
    fs.writeFileSync(file, before.replace(change.oldText, change.newText), 'utf8');
    changed.push({ file: path.relative(root, file), backup: path.relative(root, backup) });
  }
  return { changed, skipped };
}

function runCheck(project, check, opts = {}) {
  const root = path.resolve(project || process.cwd());
  const command = check.command || 'npm';
  const args = Array.isArray(check.args) ? check.args : [];
  const started = Date.now();
  try {
    const stdout = execFileSync(command, args, { cwd: root, encoding: 'utf8', timeout: opts.timeoutMs || 120000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { command, args, ok: true, exitCode: 0, stdout: stdout.slice(-8000), stderr: '', durationMs: Date.now() - started };
  } catch (err) {
    return { command, args, ok: false, exitCode: typeof err.status === 'number' ? err.status : 1, stdout: String(err.stdout || '').slice(-8000), stderr: String(err.stderr || err.message || '').slice(-8000), durationMs: Date.now() - started };
  }
}

function executeTask(project, task, opts = {}) {
  const plan = planTask(project, task, opts);
  const changes = applyChanges(plan.project, opts.changes || []);
  const checks = [];
  if (opts.verify !== false) {
    for (const step of plan.steps.filter(s => s.action === 'run_check')) {
      const result = runCheck(plan.project, step);
      checks.push({ ...step, result });
      if (!result.ok && opts.stopOnFailure !== false) break;
    }
  }
  return { plan, changes, checks, verified: checks.length > 0 ? checks.every(c => c.result.ok) : changes.changed.length === 0, status: checks.some(c => !c.result.ok) ? 'failed_verification' : 'completed' };
}

module.exports = { CAPABILITY_MATRIX, auditCapabilities, planTask, applyChanges, runCheck, executeTask };
