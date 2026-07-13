'use strict';

/**
 * seed-memory-repo.js — One-time migration to seed a team memory repo.
 *
 * Gathers high-confidence observations (errors, learnings, patterns,
 * decisions, gotchas) from ALL projects in the shared agentic-cortex
 * SQLite database and deposits them into a designated Git memory repo
 * as .cortex/global/*.md files.
 *
 * Usage:
 *   node scripts/seed-memory-repo.js <memory-repo-path-or-url>
 *   node scripts/seed-memory-repo.js --dry-run <memory-repo-path-or-url>
 *
 * Or via env var:
 *   AGENTIC_CORTEX_MEMORY_REPO=git@github.com:team/cortex-memory.git node scripts/seed-memory-repo.js
 *
 * Flags:
 *   --dry-run        Preview what would be migrated (no writes)
 *   --min-conf <n>   Minimum confidence threshold (default: 80)
 *   --scan-dir <dir> Also scan a directory for project-local agentic-cortex.db files
 *                    (repeatable; defaults to D:\sourcecode if it exists)
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// ─── Parse args ──────────────────────────────────────────────────────

const args = process.argv.slice(2);
/** Indices of args already consumed by flag parsing */
const consumed = new Set();

const flags = {
  dryRun: args.includes('--dry-run'),
  minConf: 80,
  scanDirs: [],
};
if (flags.dryRun) consumed.add(args.indexOf('--dry-run'));

// Parse --min-conf
const minConfIdx = args.indexOf('--min-conf');
if (minConfIdx !== -1) {
  consumed.add(minConfIdx);
  if (args[minConfIdx + 1] && !args[minConfIdx + 1].startsWith('--')) {
    flags.minConf = parseInt(args[minConfIdx + 1], 10) || 80;
    consumed.add(minConfIdx + 1);
  } else {
    console.error('[seed] WARNING: --min-conf requires a value (using default: 80)');
  }
}

// Parse --scan-dir (repeatable)
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--scan-dir' && args[i + 1] && !args[i + 1].startsWith('--')) {
    flags.scanDirs.push(path.resolve(args[i + 1]));
    consumed.add(i);
    consumed.add(i + 1);
  }
}
// Default: scan D:\sourcecode if it exists and no explicit --scan-dir given
if (flags.scanDirs.length === 0 && process.platform === 'win32') {
  const defaultScan = 'D:\\sourcecode';
  if (fs.existsSync(defaultScan)) flags.scanDirs.push(defaultScan);
}

// Repo path/URL: first non-flag argument or env var (skip consumed indices)
const repoArg = args.find((a, i) => !a.startsWith('--') && !consumed.has(i));
const REPO_URL = repoArg || process.env.AGENTIC_CORTEX_MEMORY_REPO || _readSyncConfig() || null;

/** Read memoryRepo from ~/.agentic-cortex/sync-config.json as fallback */
function _readSyncConfig() {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
    const configPath = path.join(home, '.agentic-cortex', 'sync-config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.memoryRepo && typeof config.memoryRepo === 'string') {
        return config.memoryRepo;
      }
    }
  } catch { /* missing or malformed */ }
  return null;
}

if (!REPO_URL) {
  console.error('Usage: node scripts/seed-memory-repo.js [--dry-run] [--min-conf 80] <memory-repo-path-or-url>');
  console.error('   or: AGENTIC_CORTEX_MEMORY_REPO=<url> node scripts/seed-memory-repo.js');
  process.exit(1);
}

// ─── Load shared modules ─────────────────────────────────────────────

const { getDb } = require('../src/core/db');
const { encodeObservation, generateFilename } = require('../src/sync/markdown-codec');

// ─── Resolve memory repo location ────────────────────────────────────

function getRepoDir() {
  // If REPO_URL is a local path, use it directly
  if (fs.existsSync(REPO_URL) && fs.statSync(REPO_URL).isDirectory()) {
    return path.resolve(REPO_URL);
  }
  // Otherwise clone/cache in ~/.agentic-cortex/memory-repo
  const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
  return path.join(home, '.agentic-cortex', 'memory-repo');
}

function getGlobalDir() {
  return path.join(getRepoDir(), '.cortex', 'global');
}

function shellQuote(str) {
  if (process.platform === 'win32') {
    return '"' + str.replace(/"/g, '\\"') + '"';
  }
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

// ─── Team-worthy observation types ───────────────────────────────────

const TEAM_WORTHY_TYPES = [
  'error',      // Mistakes to avoid
  'failure',    // Failed approaches
  'learning',   // Lessons learned (auto-captured by learnFromError)
  'pattern',    // Recurring patterns (promoted by reflect)
  'decision',   // Architecture/design decisions
  'instruction',// Step-by-step procedures
  'gotcha',     // Platform-specific quirk
  'skill',      // Reusable skill
  'procedure',  // Workflow procedure
];

// ─── Stage 1: Gather candidates from ALL databases ───────────────────

console.error('[seed] Opening agentic-cortex database(s)...\n');

/** @type {Array<Object>} */
let candidates = [];

/**
 * Query a single DB instance and collect candidates.
 * @param {import('better-sqlite3').Database} database
 * @param {string} dbLabel - Human-readable label for log output
 */
function collectFromDb(database, dbLabel) {
  const placeholders = TEAM_WORTHY_TYPES.map(() => '?').join(',');
  const rows = database.prepare(
    `SELECT * FROM observations
     WHERE type IN (${placeholders})
       AND confidence >= ?
       AND is_active = 1
     ORDER BY confidence DESC, project_path`
  ).all(...TEAM_WORTHY_TYPES, flags.minConf);

  console.error('[seed]   %s → %d candidates', dbLabel, rows.length);
  candidates.push(...rows);
}

// 1. Shared (machine-wide) database
let sharedDb;
try {
  sharedDb = getDb();
  collectFromDb(sharedDb, 'shared DB');
} catch (err) {
  console.error('[seed] WARNING: Cannot open shared DB:', err.message);
}

// 2. Project-local databases (--scan-dir)
if (flags.scanDirs.length > 0) {
  console.error('[seed] Scanning for project-local DBs in: %s', flags.scanDirs.join(', '));
  for (const scanDir of flags.scanDirs) {
    const localDbs = _scanForDbs(scanDir, 3);

    for (const dbPath of localDbs) {
      // Skip the shared DB path (already queried)
      if (sharedDb && dbPath === require('../src/core/db-path').getDbPath()) continue;

      try {
        const Database = require('better-sqlite3');
        const localDb = new Database(dbPath);
        localDb.pragma('journal_mode = WAL');
        collectFromDb(localDb, path.relative(scanDir, dbPath));
        localDb.close();
      } catch (err) {
        console.error('[seed]   SKIP %s: %s', path.relative(scanDir, dbPath), err.message.slice(0, 60));
      }
    }
  }
}

// Deduplicate by ID (keep highest confidence if ID appears in multiple DBs)
const seen = new Map();
for (const obs of candidates) {
  const existing = seen.get(obs.id);
  if (!existing || obs.confidence > existing.confidence) {
    seen.set(obs.id, obs);
  }
}
candidates = [...seen.values()].sort((a, b) => b.confidence - a.confidence);

// Keep sharedDb as primary DB for relation lookups during export
const db = sharedDb;
if (!db && candidates.length > 0) {
  console.error('[seed] ERROR: Found candidates in local DBs but shared DB is unavailable (needed for relation lookups).');
  process.exit(1);
}

console.error('[seed] Found %d high-confidence observations (conf ≥ %d) across all projects:\n',
  candidates.length, flags.minConf);

if (candidates.length === 0) {
  console.error('[seed] Nothing to migrate. Exiting.');
  process.exit(0);
}

// Show summary by project
const byProject = {};
for (const obs of candidates) {
  const proj = obs.project_path || '(unknown)';
  if (!byProject[proj]) byProject[proj] = [];
  byProject[proj].push(obs);
}

for (const [proj, obsList] of Object.entries(byProject)) {
  const types = {};
  for (const o of obsList) {
    types[o.type] = (types[o.type] || 0) + 1;
  }
  const breakdown = Object.entries(types)
    .sort((a, b) => b[1] - a[1])
    .map(([t, c]) => t + '×' + c)
    .join(', ');
  console.error('  %s  →  %d obs  (%s)', proj, obsList.length, breakdown);
}

// ─── Helper: recursive scan for project-local DBs (up to maxDepth levels) ──

/**
 * Recursively scan a directory for agentic-cortex.db files.
 * Zero-dependency — uses only fs.readdirSync.
 *
 * @param {string} dir - Directory to scan
 * @param {number} maxDepth - Max recursion depth (prevents infinite descent)
 * @param {number} [currentDepth=0] - Internal recursion tracker
 * @returns {string[]} Absolute paths to found DB files
 */
function _scanForDbs(dir, maxDepth, currentDepth) {
  currentDepth = currentDepth || 0;
  if (currentDepth > maxDepth) return [];

  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Check for DB in this directory
        const dbPath = path.join(fullPath, 'agentic-cortex.db');
        if (fs.existsSync(dbPath)) {
          results.push(dbPath);
        }
        // Recurse into subdirectories
        results.push(..._scanForDbs(fullPath, maxDepth, currentDepth + 1));
      }
    }
  } catch { /* permission denied, empty dir, etc. */ }
  return results;
}

console.error('');

// ─── Stage 2: Dry-run preview ────────────────────────────────────────

if (flags.dryRun) {
  console.error('=== DRY RUN — no files written ===\n');
  for (const obs of candidates) {
    const filename = generateFilename(obs);
    console.error('  Would write: .cortex/global/%s', filename);
    console.error('    #%d [%s] conf=%d — %s', obs.id, obs.type, obs.confidence, (obs.title || '').slice(0, 60));
    console.error('    Project: %s', obs.project_path);
    console.error('');
  }
  console.error('=== %d observations would be migrated ===', candidates.length);
  process.exit(0);
}

// ─── Stage 3: Prepare the memory repo ────────────────────────────────

const repoDir = getRepoDir();
const globalDir = getGlobalDir();

console.error('[seed] Memory repo location: %s\n', repoDir);

// Clone or initialize the repo
if (fs.existsSync(path.join(repoDir, '.git'))) {
  console.error('[seed] Pulling latest from memory repo...');
  try {
    execSync('git pull --ff-only origin HEAD', {
      cwd: repoDir, encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
    });
    console.error('[seed] Pull successful.\n');
  } catch (err) {
    console.error('[seed] Pull failed (continuing): %s\n', (err.stderr || err.message || '').slice(0, 100));
  }
} else if (fs.existsSync(REPO_URL) && fs.statSync(REPO_URL).isDirectory()) {
  // Local dir — ensure it's a git repo
  const hasGit = fs.existsSync(path.join(repoDir, '.git'));
  if (!hasGit) {
    console.error('[seed] Initializing git in local repo: %s', repoDir);
    try {
      execSync('git init', { cwd: repoDir, encoding: 'utf-8', timeout: 10000, stdio: 'pipe' });
      console.error('[seed] Git initialized (no remote — commits stay local until you add one).\n');
    } catch (err) {
      console.error('[seed] ERROR: git init failed: %s', (err.stderr || err.message || '').slice(0, 200));
      process.exit(1);
    }
  }
  // For local dirs: skip git pull (may not have a remote)
  if (hasGit) {
    try {
      const remotes = execSync('git remote', { cwd: repoDir, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
      if (remotes.trim()) {
        console.error('[seed] Pulling latest from local repo remote...');
        execSync('git pull --ff-only origin HEAD', {
          cwd: repoDir, encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
        });
        console.error('[seed] Pull successful.\n');
      }
    } catch { /* no remote or pull failed — continue */ }
  }
} else {
  // Remote URL — clone it
  console.error('[seed] Cloning memory repo: %s', REPO_URL);
  const parentDir = path.dirname(repoDir);
  if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
  try {
    execSync('git clone --depth 1 ' + shellQuote(REPO_URL) + ' ' + shellQuote(repoDir), {
      encoding: 'utf-8', timeout: 60000, stdio: 'pipe',
    });
    console.error('[seed] Clone successful.\n');
  } catch (err) {
    console.error('[seed] ERROR: Clone failed: %s', (err.stderr || err.message || '').slice(0, 200));
    console.error('[seed] Hint: Make sure the repo exists and you have access.');
    process.exit(1);
  }
}

// Ensure .cortex/global/ directory exists
if (!fs.existsSync(globalDir)) {
  fs.mkdirSync(globalDir, { recursive: true });
  console.error('[seed] Created %s', globalDir);
}

// ─── Stage 4: Build index of existing files in repo ──────────────────

const existingFiles = new Set();
try {
  const files = fs.readdirSync(globalDir).filter(f => f.endsWith('.md'));
  for (const f of files) existingFiles.add(f);
  console.error('[seed] %d existing .md files in repo (will skip if ID matches)\n', existingFiles.size);
} catch {
  console.error('[seed] No existing files in repo\n');
}

// ─── Stage 5: Write observation markdown files ───────────────────────

let written = 0;
let skipped = 0;
const summary = [];

for (const obs of candidates) {
  const filename = generateFilename(obs);

  // Check if this ID already exists in any filename in the repo
  const idPattern = '__' + String(obs.id).padStart(4, '0') + '__';
  const alreadyExists = [...existingFiles].some(f => f.includes(idPattern));

  if (alreadyExists) {
    skipped++;
    continue;
  }

  try {
    // Get relations for this observation
    const relations = db.prepare(
      `SELECT r.relation_type as relation_type, r.target_id as target_id,
              o.title as target_title
       FROM memory_relations r
       LEFT JOIN observations o ON o.id = r.target_id
       WHERE r.source_id = ?`
    ).all(obs.id);

    // Add source project context as a tag
    const obsWithContext = { ...obs };
    let tags = [];
    try {
      tags = typeof obs.tags === 'string' ? JSON.parse(obs.tags) : (obs.tags || []);
    } catch { tags = []; }
    // Tag the source project (slugified)
    const projectSlug = (obs.project_path || 'unknown')
      .replace(/[\\/]/g, '-')
      .replace(/^[A-Z]:-/, '')
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .slice(0, 40);
    if (!tags.includes('source:' + projectSlug)) {
      tags.push('source:' + projectSlug);
    }
    obsWithContext.tags = JSON.stringify(tags);

    const md = encodeObservation(obsWithContext, relations);
    const filePath = path.join(globalDir, filename);
    fs.writeFileSync(filePath, md, 'utf-8');
    existingFiles.add(filename);
    written++;

    summary.push({
      id: obs.id,
      type: obs.type,
      title: obs.title,
      confidence: obs.confidence,
      project: obs.project_path,
      filename,
    });

    console.error('  ✓ #%d [%s] conf=%d  %s  (%s)',
      obs.id, obs.type, obs.confidence,
      (obs.title || '').slice(0, 50),
      obs.project_path);
  } catch (err) {
    console.error('  ✗ #%d FAILED: %s', obs.id, (err.message || '').slice(0, 80));
  }
}

console.error('\n[seed] Written: %d  |  Skipped (already in repo): %d  |  Total candidates: %d\n',
  written, skipped, candidates.length);

if (written === 0) {
  console.error('[seed] No new observations to commit. Done.');
  process.exit(0);
}

// ─── Stage 6: Commit and push ────────────────────────────────────────

console.error('[seed] Committing and pushing to memory repo...\n');

try {
  execSync('git add .cortex/', {
    cwd: repoDir, encoding: 'utf-8', timeout: 10000, stdio: 'pipe',
  });

  const status = execSync('git status --porcelain', {
    cwd: repoDir, encoding: 'utf-8', timeout: 5000, stdio: 'pipe',
  });

  if (!status.trim()) {
    console.error('[seed] No changes to commit.');
    process.exit(0);
  }

  const commitMsg = 'seed: ' + written + ' observations from ' +
    Object.keys(byProject).length + ' projects [agentic-cortex one-time migration]';
  execSync('git commit -m ' + shellQuote(commitMsg), {
    cwd: repoDir, encoding: 'utf-8', timeout: 10000, stdio: 'pipe',
  });

  // Check if we have a remote to push to
  let hasRemote = false;
  try {
    const remotes = execSync('git remote', {
      cwd: repoDir, encoding: 'utf-8', timeout: 5000, stdio: 'pipe',
    });
    hasRemote = remotes.trim().length > 0;
  } catch { /* no remotes */ }

  if (hasRemote) {
    execSync('git push origin HEAD', {
      cwd: repoDir, encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
    });
    console.error('[seed] ✓ Pushed to remote.\n');
  } else {
    console.error('[seed] ⚠ No git remote configured. Files committed locally only.\n');
    console.error('[seed]   To push, add a remote:');
    console.error('[seed]     cd %s', repoDir);
    console.error('[seed]     git remote add origin <your-repo-url>');
    console.error('[seed]     git push origin HEAD\n');
  }

  const commitHash = execSync('git rev-parse --short HEAD', {
    cwd: repoDir, encoding: 'utf-8', timeout: 5000, stdio: 'pipe',
  }).trim();

  console.error('[seed] Commit: %s', commitHash);
} catch (err) {
  console.error('[seed] ERROR during commit/push: %s', (err.stderr || err.message || '').slice(0, 300));
  console.error('[seed] Files are written locally. You may need to commit/push manually.');
}

// ─── Summary ──────────────────────────────────────────────────────────

console.error('\n═══════════════════════════════════════════════════════');
console.error('  Migration Complete');
console.error('═══════════════════════════════════════════════════════');
console.error('  Repository:   %s', REPO_URL);
console.error('  Candidates:   %d', candidates.length);
console.error('  Written:      %d', written);
console.error('  Skipped:      %d (already in repo)', skipped);
console.error('  Projects:     %d', Object.keys(byProject).length);
console.error('═══════════════════════════════════════════════════════\n');

// Print the summary for use by the parent agent
console.log(JSON.stringify({ written, skipped, total: candidates.length, projects: Object.keys(byProject).length, summary }, null, 2));
