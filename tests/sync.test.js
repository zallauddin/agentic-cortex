'use strict';

/**
 * sync.test.js — Cross-machine knowledge transfer via the __global__ vault.
 *
 * Simulates two independent machines (isolated $HOME/$USERPROFILE and DBs)
 * sharing a single "team memory repo" (a local bare git repo):
 *
 *   Machine A: observations promoted to __global__ → syncPush() exports them
 *              as .cortex/global/*.md and pushes to the team repo.
 *   Machine B: fresh DB, no prior knowledge → syncPull() clones the team repo
 *              and seeds its __global__ vault.
 *
 * This proves the git-sync pipeline makes the machine-wide vault portable
 * across machines without any shared database or LLM.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const { ensureSchema } = require('../src/core/db');
const { syncPull, syncPush } = require('../src/sync/git-sync');
const { decodeMarkdown, encodeObservation } = require('../src/sync/markdown-codec');

// Stub the embedding pipeline: syncPull re-embeds imported observations in the
// background. A deterministic, cheap stub keeps the test fast and offline.
const embedding = require('../src/core/embedding');
embedding.computeEmbedding = async function (text) {
  return Array.from({ length: 16 }, (_, i) => ((text || '').length + i) % 7);
};

// Ensure git commits succeed even on machines without a global git identity.
process.env.GIT_AUTHOR_NAME = process.env.GIT_AUTHOR_NAME || 'Cortex Sync Test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_AUTHOR_EMAIL || 'cortex-sync-test@example.com';
process.env.GIT_COMMITTER_NAME = process.env.GIT_COMMITTER_NAME || 'Cortex Sync Test';
process.env.GIT_COMMITTER_EMAIL = process.env.GIT_COMMITTER_EMAIL || 'cortex-sync-test@example.com';

// ─── Helpers ─────────────────────────────────────────────────────────

/** Run a git command without a shell (avoids cross-platform quoting issues). */
function git(args, opts) {
  return execFileSync('git', args, { stdio: 'pipe', encoding: 'utf-8', ...(opts || {}) });
}

/** Create an isolated in-memory DB with the full agentic-cortex schema. */
function makeDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  return db;
}

/** Insert a promoted observation into the __global__ vault. Returns its id. */
function insertGlobalObs(db, { type, title, content, tags, steps }) {
  const r = db.prepare(
    `INSERT INTO observations (project_path, project_scope, type, title, content, tags, importance, confidence, provenance, steps)
     VALUES ('__global__', 'global', ?, ?, ?, ?, ?, ?, 'observed', ?)`
  ).run(type, title, content, JSON.stringify(tags || []), 8, 95, steps ? JSON.stringify(steps) : null);
  return Number(r.lastInsertRowid);
}

/** Create a bare "team memory repo" seeded with one initial commit. */
function createTeamRepo() {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-sync-team-'));
  git(['init', '--bare', '--quiet', bare]);

  const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-sync-seed-'));
  git(['init', '--quiet', seed]);
  git(['config', 'user.email', 'cortex-sync-test@example.com'], { cwd: seed });
  git(['config', 'user.name', 'Cortex Sync Test'], { cwd: seed });
  fs.writeFileSync(path.join(seed, 'README.md'), '# team memory repo\n');
  git(['add', 'README.md'], { cwd: seed });
  git(['commit', '--quiet', '-m', 'seed'], { cwd: seed });
  git(['remote', 'add', 'origin', bare], { cwd: seed });
  git(['push', '--quiet', 'origin', 'HEAD'], { cwd: seed });
  fs.rmSync(seed, { recursive: true, force: true });

  return bare;
}

// ─── Env isolation between machines ──────────────────────────────────

const SAVED_ENV = {};
function snapshotEnv() {
  for (const key of ['USERPROFILE', 'HOME', 'AGENTIC_CORTEX_MEMORY_REPO']) {
    SAVED_ENV[key] = process.env[key];
  }
}
function restoreEnv() {
  for (const key of Object.keys(SAVED_ENV)) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key];
  }
}

const tempDirs = [];
function tmpHome(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
function setMachine(homeDir) {
  process.env.USERPROFILE = homeDir;
  process.env.HOME = homeDir;
}

beforeEach(snapshotEnv);
afterEach(() => {
  restoreEnv();
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ─── Tests ───────────────────────────────────────────────────────────

describe('cross-machine git-sync of the __global__ vault', () => {
  it('seeds a fresh machine from a pushed team repo', () => {
    const teamRepo = createTeamRepo();
    tempDirs.push(teamRepo);
    process.env.AGENTIC_CORTEX_MEMORY_REPO = teamRepo;

    // ── Machine A: promote + push ──
    setMachine(tmpHome('cortex-sync-a-'));
    const dbA = makeDb();
    const id1 = insertGlobalObs(dbA, {
      type: 'learning',
      title: 'Use parameterized SQL queries',
      content: 'Always use parameterized queries to prevent SQL injection.',
      tags: ['security', 'sql'],
    });
    const id2 = insertGlobalObs(dbA, {
      type: 'decision',
      title: 'Adopt ESLint for linting',
      content: 'We standardize on ESLint with the recommended config.',
      tags: ['tooling'],
      steps: ['install eslint', 'add config'],
    });

    const push = syncPush(dbA, [id1, id2]);
    assert.equal(push.pushed, 2, 'both observations pushed to team repo');
    assert.ok(push.commit, 'push produced a commit hash');
    dbA.close();

    // Machine A's local clone now holds the exported markdown files.
    const aGlobalDir = path.join(process.env.USERPROFILE, '.agentic-cortex', 'memory-repo', '.cortex', 'global');
    const mdFiles = fs.readdirSync(aGlobalDir).filter((f) => f.endsWith('.md'));
    assert.equal(mdFiles.length, 2, 'two markdown files exported to the repo');

    // ── Machine B: fresh DB, pull ──
    setMachine(tmpHome('cortex-sync-b-'));
    const dbB = makeDb();
    const before = dbB.prepare("SELECT COUNT(*) AS c FROM observations WHERE project_path = '__global__'").get().c;
    assert.equal(before, 0, 'machine B starts with an empty __global__ vault');

    // NOTE: only one real syncPull per process is safe here — git-sync
    // debounces pulls to once per 5 minutes (module-level _lastPullTime).
    // Future tests needing a second pull would have to reset that state.
    const pull = syncPull(dbB);
    assert.equal(pull.pulled, 2, 'two files pulled from team repo');
    assert.equal(pull.new, 2, 'two new observations imported');
    assert.equal(pull.updated, 0, 'no updates on a fresh machine');

    const rows = dbB.prepare(
      "SELECT * FROM observations WHERE project_path = '__global__' AND is_active = 1 ORDER BY id"
    ).all();
    assert.equal(rows.length, 2, 'fresh machine has two __global__ observations');

    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]));
    const sec = byTitle['Use parameterized SQL queries'];
    const lint = byTitle['Adopt ESLint for linting'];
    assert.ok(sec, 'security learning imported');
    assert.ok(lint, 'decision imported');

    assert.equal(sec.type, 'learning');
    assert.equal(sec.content, 'Always use parameterized queries to prevent SQL injection.');
    // Germinated seeds carry the 'seed' tag so the lifecycle can decay/expire them.
    assert.deepEqual([...JSON.parse(sec.tags)].sort(), ['security', 'seed', 'sql']);
    assert.equal(sec.project_scope, 'global');
    assert.equal(sec.project_path, '__global__');

    assert.equal(lint.type, 'decision');
    assert.deepEqual([...JSON.parse(lint.tags)].sort(), ['seed', 'tooling']);
    assert.deepEqual(JSON.parse(lint.steps), ['install eslint', 'add config']);
    assert.equal(lint.project_scope, 'global');

    dbB.close();
  });

  it('returns a clear reason when no memory repo is configured (pull)', () => {
    setMachine(tmpHome('cortex-sync-norepo-a-'));
    delete process.env.AGENTIC_CORTEX_MEMORY_REPO;

    const db = makeDb();
    const result = syncPull(db);
    assert.equal(result.pulled, 0);
    assert.match(result.reason, /not set/);
    db.close();
  });

  it('returns a clear reason when no memory repo is configured (push)', () => {
    setMachine(tmpHome('cortex-sync-norepo-b-'));
    delete process.env.AGENTIC_CORTEX_MEMORY_REPO;

    const db = makeDb();
    const result = syncPush(db, []);
    assert.equal(result.pushed, 0);
    assert.match(result.reason, /not set/);
    db.close();
  });
});

describe('markdown-codec line-ending robustness', () => {
  it('decodes CRLF markdown (git core.autocrlf on Windows checkout)', () => {
    const md = encodeObservation({ id: 1, type: 'fact', title: 'Line endings', content: 'Survives CRLF.' });
    const crlf = md.replace(/\n/g, '\r\n');
    const { observation } = decodeMarkdown(crlf);
    assert.equal(observation.title, 'Line endings');
    assert.equal(observation.content, 'Survives CRLF.');
    assert.equal(observation.type, 'fact');
    assert.equal(observation.id, 1);
  });

  it('decodes LF markdown', () => {
    const md = encodeObservation({ id: 2, type: 'decision', title: 'Plain LF', content: 'Plain LF body.' });
    const { observation } = decodeMarkdown(md);
    assert.equal(observation.title, 'Plain LF');
    assert.equal(observation.content, 'Plain LF body.');
    assert.equal(observation.type, 'decision');
  });
});
