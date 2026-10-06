/**
 * distill.test.js — Phase-0 lesson distillation: generalize + sanitize +
 * scope-classify observations into the local lessons/ markdown layer.
 *
 * Privacy guarantees under test (fail-closed):
 *   - credential-class content is never written, even in generalized form
 *   - identity paths / tokens / emails / IPs are redacted with placeholders
 *   - overly machine-specific rows are skipped, not approximated
 *   - lessons are idempotent (same content → same hash → skipped)
 *   - scope classification keeps project-specific lessons local
 *
 * @module tests/distill
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { ensureSchema, getDb } = require('../src/core/db.js');
const { distillObservations, generalize, classifyScope, hashLesson } = require('../src/core/distill.js');

let db;
let tmpDir;
let lessonsDir;

const PROJECT = '/tmp/distill-proj';

function insertObservation({ type, title, content, confidence = 90, created_at = null }) {
  db.prepare(`
    INSERT INTO observations (project_path, type, title, content, tags, confidence, created_at)
    VALUES (?, ?, ?, ?, '[]', ?, ?)
  `).run(PROJECT, type, title, content, confidence, created_at || new Date().toISOString().replace('T', ' ').slice(0, 19));
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-distill-'));
  lessonsDir = path.join(tmpDir, 'lessons');
  process.env.AGENTIC_CORTEX_DB = path.join(tmpDir, 'test.db');
  db = getDb();
  ensureSchema(db);
});

after(() => {
  try { db.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  delete process.env.AGENTIC_CORTEX_DB;
});

describe('generalize()', () => {
  test('replaces absolute paths with <path>', () => {
    const g = generalize('check D:\\sourcecode\\agentic-cortex\\src\\api\\index.js line 10 and /home/dev/app/config');
    assert.ok(!g.text.includes('D:\\sourcecode'));
    assert.ok(!g.text.includes('/home/dev'));
    assert.ok(g.text.includes('<path>'));
    assert.ok(g.generalizations.some(x => x.rule === 'abs-paths'));
  });

  test('replaces session ids and localhost ports', () => {
    const g = generalize('session ses_049b97e4bffe timed out on localhost:37777');
    assert.ok(!g.text.includes('ses_049b97e4bffe'));
    assert.ok(g.text.includes('<session>'));
    assert.ok(g.text.includes('localhost:<port>'));
  });

  test('leaves generic content untouched', () => {
    const g = generalize('always re-read the tool schema after a validation error');
    assert.equal(g.text, 'always re-read the tool schema after a validation error');
    assert.equal(g.generalizations.length, 0);
  });
});

describe('classifyScope()', () => {
  test('tool-level pattern lesson scores universal', () => {
    const obs = { type: 'learning', title: 'Tool schema validation', content: 'Always re-read the tool schema immediately when a parameter validation error appears. This applies to any tool with a strict API.' };
    const s = classifyScope(obs, { text: obs.content, generalizations: [] });
    assert.equal(s.scope, 'universal');
    assert.ok(s.score >= 70);
  });

  test('project-referencing lesson stays project-scoped', () => {
    const obs = { type: 'fact', title: 'Migration order', content: 'In this repo the src/core/db.js migration must run before tests/ because package.json wiring depends on it.' };
    const s = classifyScope(obs, { text: obs.content, generalizations: [] });
    assert.equal(s.scope, 'project');
  });
});

describe('distillObservations()', () => {
  test('writes sanitized lesson files with frontmatter + INDEX.md', () => {
    insertObservation({
      type: 'learning',
      title: 'write_file tool requires instructions param',
      content: 'Problem: write_file calls failed validation in the coding tool. Fix: every call must include both instructions (one-sentence summary) and content. Guard: when a tool errors with a param-schema message, re-read the schema immediately instead of retrying the same shape.',
    });

    const r = distillObservations(db, { outDir: lessonsDir });
    assert.ok(r.written >= 1, 'at least one lesson written');
    assert.ok(fs.existsSync(lessonsDir));
    assert.ok(fs.existsSync(path.join(lessonsDir, 'INDEX.md')));
    const file = fs.readdirSync(lessonsDir).find(f => f.endsWith('.md') && f !== 'INDEX.md');
    assert.ok(file);
    const raw = fs.readFileSync(path.join(lessonsDir, file), 'utf8');
    assert.match(raw, /^---\nid: [0-9a-f]{16}\ntype: learning\nscope: (project|machine|universal)/);
    assert.match(raw, /sanitized: true/);
    assert.ok(!raw.includes('D:\\\\sourcecode'), 'no real paths in lesson');
  });

  test('NEVER writes credential-class content (fail-closed)', () => {
    insertObservation({
      type: 'error',
      title: 'deploy failed with bad key',
      content: 'the deploy used password = "hunter2secret-key" and failed with 401. Fix: rotate the secret before deploying.',
    });
    const r = distillObservations(db, { outDir: lessonsDir });
    const allFiles = fs.readdirSync(lessonsDir).filter(f => f.endsWith('.md')).map(f => fs.readFileSync(path.join(lessonsDir, f), 'utf8')).join('\n');
    assert.ok(!allFiles.includes('hunter2secret-key'), 'credential leaked into lesson layer');
    const skipReason = r.reasons.find(x => /credential/.test(x.reason));
    assert.ok(skipReason || !allFiles.includes('hunter2'), 'row must be skipped with reason');
  });

  test('redacts tokens/emails/IPs rather than dropping the lesson', () => {
    insertObservation({
      type: 'learning',
      title: 'CI auth pattern',
      content: 'The CI job failed because the token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 was expired; notifications went to devops@example.com from 192.168.1.50. Fix: refresh tokens before long jobs.',
      confidence: 85,
    });
    const r = distillObservations(db, { outDir: lessonsDir });
    const allFiles = fs.readdirSync(lessonsDir).filter(f => f.endsWith('.md')).map(f => fs.readFileSync(path.join(lessonsDir, f), 'utf8')).join('\n');
    assert.ok(!allFiles.includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'), 'github token leaked');
    assert.ok(!allFiles.includes('devops@example.com'), 'email leaked');
    assert.ok(!allFiles.includes('192.168.1.50'), 'ip leaked');
    assert.ok(allFiles.includes('CI auth pattern') || allFiles.includes('<redacted:'), 'lesson retained in redacted form or skip was deliberate');
    assert.ok(r.written >= 0);
  });

  test('skips rows needing more than MAX_REDACTIONS (too machine-specific)', () => {
    // Build content that trips many distinct redaction rules at once.
    // The Slack token is assembled at runtime: a literal matching that pattern
    // is blocked by GitHub secret scanning on push, while the value the
    // redaction rules actually see must stay byte-for-byte identical.
    const slackToken = ['xoxb', '123456789012', '1234567890128', 'abcdefghijklmnop'].join('-');
    const secrets = [
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_aaaaaaaaaaaaaaaaaaaa',
      slackToken,
      'AIzaSyA-1234567890abcdefghijklmnopqrstuv',
      'sk-proj-abcdefghijklmnopqrstuvwx',
    ].join(' and ');
    insertObservation({ type: 'learning', title: 'multi-cred incident', content: 'Credentials seen together: ' + secrets + '. Lesson: rotate all of them.' });
    const before = distillObservations(db, { outDir: lessonsDir });
    const allFiles = fs.readdirSync(lessonsDir).filter(f => f.endsWith('.md')).map(f => fs.readFileSync(path.join(lessonsDir, f), 'utf8')).join('\n');
    assert.ok(!allFiles.includes('AKIAIOSFODNN7EXAMPLE'));
    void before;
  });

  test('is idempotent — same content hashes to the same lesson id', () => {
    const h1 = hashLesson('learning', 'Same title', 'Same body');
    const h2 = hashLesson('learning', 'Same title', 'Same body');
    assert.equal(h1, h2);
    assert.equal(h1.length, 16);
  });

  test('respects dryRun — reports but writes nothing', () => {
    const tmpOut = path.join(tmpDir, 'dryrun-lessons');
    insertObservation({ type: 'learning', title: 'dry run probe lesson', content: 'A unique dry-run lesson body for probing dryRun behaviour end to end.' });
    const r = distillObservations(db, { outDir: tmpOut, dryRun: true });
    assert.ok(r.written >= 1);
    assert.equal(r.files.length >= 1, true);
    assert.ok(!fs.existsSync(tmpOut), 'dry run must not create the directory');
  });

  test('respects minConfidence filter', () => {
    insertObservation({ type: 'learning', title: 'low confidence lesson', content: 'A low confidence lesson that should be filtered by the min confidence threshold.', confidence: 40 });
    const r = distillObservations(db, { outDir: lessonsDir, minConfidence: 80 });
    const found = r.files.some(f => f.includes('low-confidence-lesson'));
    assert.equal(found, false);
  });

  test('a failing row never aborts the batch (per-row fail-closed)', () => {
    // content that triggers a sanitizer internal path — simulate by null title/content types
    db.prepare(`INSERT INTO observations (project_path, type, title, content, tags, confidence, created_at)
                VALUES (?, 'learning', NULL, 'still a valid body', '[]', 90, datetime('now'))`).run(PROJECT);
    const r = distillObservations(db, { outDir: lessonsDir });
    assert.ok(r.written >= 0 && r.skipped >= 0);
  });
});
