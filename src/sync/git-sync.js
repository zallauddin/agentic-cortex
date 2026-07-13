'use strict';

/**
 * git-sync.js — Sync the agentic-cortex __global__ vault with a team Git repo.
 *
 * Pull: clones/pulls .cortex/global/*.md from the team repo, imports
 *       high-quality observations into the local __global__ scope.
 * Push: exports newly promoted global observations as .md files and
 *       pushes them to the team repo.
 *
 * One team, one memory repo. One source of truth for all agents.
 *
 * @module sync/git-sync
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { decodeMarkdown, encodeObservation, generateFilename } = require('./markdown-codec');

// Debounce state: max one pull per 5 minutes
let _lastPullTime = 0;
const PULL_DEBOUNCE_MS = 5 * 60 * 1000;

// ─── Configuration ──────────────────────────────────────────────────

/**
 * Resolve the configured team memory repo URL.
 * Priority: env var > sync-config.json > null
 * @returns {string|null}
 */
function _getRepoUrl() {
  // 1. Environment variable (highest priority)
  if (process.env.AGENTIC_CORTEX_MEMORY_REPO) {
    return process.env.AGENTIC_CORTEX_MEMORY_REPO;
  }
  // 2. Persistent config file (~/.agentic-cortex/sync-config.json)
  try {
    const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
    const configPath = path.join(home, '.agentic-cortex', 'sync-config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.memoryRepo && typeof config.memoryRepo === 'string') {
        return config.memoryRepo;
      }
    }
  } catch { /* config file missing or malformed — silently fall through */ }
  return null;
}

/** @returns {string} Local cache directory for the memory repo */
function _getRepoDir() {
  const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
  return path.join(home, '.agentic-cortex', 'memory-repo');
}

/** @returns {string} Path to global memories in the repo */
function _getGlobalDir() {
  return path.join(_getRepoDir(), '.cortex', 'global');
}

// ─── Pull: Import team knowledge into local __global__ scope ────────

/**
 * Pull the latest team knowledge from the memory repo.
 * Clones if first time, otherwise pulls. Imports .cortex/global/*.md
 * observations into the local SQLite __global__ scope.
 *
 * @param {import('better-sqlite3').Database} db - Local SQLite instance
 * @param {string} [repoUrl] - Override repo URL (defaults to env var)
 * @returns {{ pulled: number, new: number, updated: number, repoUrl: string }}
 */
function syncPull(db, repoUrl) {
  const url = repoUrl || _getRepoUrl();
  if (!url) return { pulled: 0, new: 0, updated: 0, repoUrl: null, reason: 'AGENTIC_CORTEX_MEMORY_REPO not set' };

  // Debounce: max one pull per 5 minutes
  const now = Date.now();
  if (now - _lastPullTime < PULL_DEBOUNCE_MS) {
    return { pulled: 0, new: 0, updated: 0, repoUrl: url, reason: 'debounced (last pull < 5 min ago)' };
  }
  _lastPullTime = now;

  const repoDir = _getRepoDir();
  let isFirstClone = false;

  // ── Clone or pull ──
  try {
    if (fs.existsSync(path.join(repoDir, '.git'))) {
      execSync('git pull --ff-only origin HEAD', { cwd: repoDir, encoding: 'utf-8', timeout: 30000, stdio: 'pipe' });
    } else {
      const parentDir = path.dirname(repoDir);
      if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
      execSync('git clone --depth 1 ' + _shellQuote(url) + ' ' + _shellQuote(repoDir), {
        encoding: 'utf-8', timeout: 60000, stdio: 'pipe',
      });
      isFirstClone = true;
    }
  } catch (err) {
    console.warn('[agentic-cortex] Git pull failed (non-fatal):', (err.stderr || err.message || '').slice(0, 200));
    return { pulled: 0, new: 0, updated: 0, repoUrl: url, reason: 'git pull failed: ' + (err.message || '').slice(0, 100) };
  }

  const globalDir = _getGlobalDir();
  if (!fs.existsSync(globalDir)) {
    // No global memories yet — first time setup
    try { fs.mkdirSync(globalDir, { recursive: true }); } catch {}
    return { pulled: 0, new: 0, updated: 0, repoUrl: url, reason: 'no global memories in repo yet' };
  }

  // ── Scan .md files ──
  let files;
  try {
    files = fs.readdirSync(globalDir).filter(f => f.endsWith('.md'));
  } catch {
    return { pulled: 0, new: 0, updated: 0, repoUrl: url, reason: 'cannot read global directory' };
  }

  if (files.length === 0) return { pulled: 0, new: 0, updated: 0, repoUrl: url };

  let newCount = 0;
  let updatedCount = 0;

  // ── Import each file into local SQLite __global__ scope ──
  for (const filename of files) {
    try {
      const filePath = path.join(globalDir, filename);
      const mdContent = fs.readFileSync(filePath, 'utf-8');
      const { observation, relations } = decodeMarkdown(mdContent);
      if (!observation.id || !observation.content) continue;

      // Check if this observation already exists locally (any project_path)
      const existing = db.prepare(
        'SELECT id, synced_at, project_path FROM observations WHERE id = ? AND is_active = 1'
      ).get(observation.id);

      if (existing) {
        // Check if the repo version is newer
        const existingSynced = existing.synced_at || '';
        const repoSynced = observation.synced_at || '';
        if (repoSynced > existingSynced) {
          // Update local copy (preserve original project_path)
          db.prepare(
            "UPDATE observations SET type = ?, title = ?, content = ?, tags = ?, confidence = ?, importance = ?, provenance = ?, agent_id = ?, session_id = ?, steps = ?, triggers = ?, preconditions = ?, postconditions = ?, synced_at = datetime('now') WHERE id = ?"
          ).run(
            observation.type, observation.title, observation.content,
            JSON.stringify(observation.tags), observation.confidence,
            observation.importance, observation.provenance,
            observation.agent_id, observation.session_id,
            observation.steps ? JSON.stringify(observation.steps) : null,
            observation.triggers ? JSON.stringify(observation.triggers) : null,
            observation.preconditions ? JSON.stringify(observation.preconditions) : null,
            observation.postconditions ? JSON.stringify(observation.postconditions) : null,
            observation.id
          );
          updatedCount++;
        }
      } else {
        // New observation — insert into __global__ scope
        const now = new Date().toISOString();
        db.prepare(
          'INSERT INTO observations (id, project_path, project_scope, type, title, content, tags, importance, confidence, provenance, agent_id, session_id, steps, triggers, preconditions, postconditions, created_at, synced_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
        ).run(
          observation.id, '__global__', 'global',
          observation.type, observation.title, observation.content,
          JSON.stringify(observation.tags), observation.importance,
          observation.confidence, observation.provenance,
          observation.agent_id, observation.session_id,
          observation.steps ? JSON.stringify(observation.steps) : null,
          observation.triggers ? JSON.stringify(observation.triggers) : null,
          observation.preconditions ? JSON.stringify(observation.preconditions) : null,
          observation.postconditions ? JSON.stringify(observation.postconditions) : null,
          observation.created_at || now,
          now
        );
        newCount++;

        // Import relations
        for (const rel of relations) {
          try {
            db.prepare(
              'INSERT OR IGNORE INTO memory_relations (source_id, target_id, relation_type, confidence) VALUES (?, ?, ?, ?)'
            ).run(observation.id, rel.target_id, rel.relation_type, 100);
          } catch { /* relation may already exist */ }
        }
      }
    } catch (err) {
      console.warn('[agentic-cortex] Failed to import ' + filename + ': ' + (err.message || '').slice(0, 100));
    }
  }

  // ── Re-embed imported observations ──
  if (newCount > 0 || updatedCount > 0) {
    try {
      const embedding = require('../core/embedding');
      const newObs = db.prepare(
        'SELECT id, title, content FROM observations WHERE project_path = ? AND embedding IS NULL AND is_active = 1 ORDER BY created_at DESC LIMIT ?'
      ).all('__global__', newCount + updatedCount + 10);

      // Collect all embedding promises and await them
      const embedPromises = [];
      for (const obs of newObs) {
        const text = [obs.title || '', obs.content].filter(Boolean).join('. ');
        embedPromises.push(
          embedding.computeEmbedding(text).then(v => {
            db.prepare('UPDATE observations SET embedding = ? WHERE id = ?').run(JSON.stringify(v), obs.id);
          }).catch(() => {})
        );
      }
      // Fire-and-forget in background — don't block pull return
      // Embeddings will be ready by the time the agent searches
      Promise.all(embedPromises).catch(() => {});
    } catch { /* embedding unavailable — ok */ }
  }

  const total = files.length;
  console.error('[agentic-cortex] Git sync pull: %d files scanned, %d new, %d updated (repo: %s)', total, newCount, updatedCount, url);

  return { pulled: total, new: newCount, updated: updatedCount, repoUrl: url, firstClone: isFirstClone };
}

// ─── Push: Export local global promotions to team repo ──────────────

/**
 * Push newly promoted global observations to the team memory repo.
 * Exports observations in __global__ scope as .cortex/global/*.md files.
 *
 * @param {import('better-sqlite3').Database} db - Local SQLite instance
 * @param {number[]} [promotedIds] - Specific observation IDs to push (from autoPromoteGlobal)
 * @param {string} [repoUrl] - Override repo URL
 * @returns {{ pushed: number, commit: string|null }}
 */
function syncPush(db, promotedIds, repoUrl) {
  const url = repoUrl || _getRepoUrl();
  if (!url) return { pushed: 0, commit: null, reason: 'AGENTIC_CORTEX_MEMORY_REPO not set' };

  const repoDir = _getRepoDir();
  const globalDir = _getGlobalDir();

  // Ensure repo exists locally
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    // Clone first if needed
    try {
      const parentDir = path.dirname(repoDir);
      if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
      execSync('git clone --depth 1 ' + _shellQuote(url) + ' ' + _shellQuote(repoDir), {
        encoding: 'utf-8', timeout: 60000, stdio: 'pipe',
      });
    } catch (err) {
      console.warn('[agentic-cortex] Git clone for push failed:', (err.stderr || err.message || '').slice(0, 200));
      return { pushed: 0, commit: null, reason: 'clone failed' };
    }
  } else {
    // Pull latest before pushing
    try {
      execSync('git pull --ff-only origin HEAD', { cwd: repoDir, encoding: 'utf-8', timeout: 30000, stdio: 'pipe' });
    } catch {
      // If pull fails (e.g., no network), try push anyway with --force-with-lease
    }
  }

  // Ensure global directory exists
  if (!fs.existsSync(globalDir)) {
    try { fs.mkdirSync(globalDir, { recursive: true }); } catch {}
  }

  // ── Determine which observations to push ──
  let toPush;
  if (promotedIds && promotedIds.length > 0) {
    const placeholders = promotedIds.map(() => '?').join(',');
    toPush = db.prepare(
      'SELECT * FROM observations WHERE id IN (' + placeholders + ') AND is_active = 1'
    ).all(...promotedIds);
  } else {
    // Push all global-scope observations that haven't been synced yet
    // (those without machine-global tag or recently promoted)
    toPush = db.prepare(
      "SELECT * FROM observations WHERE project_path = ? AND is_active = 1 AND project_scope = 'global'"
    ).all('__global__');
  }

  if (toPush.length === 0) return { pushed: 0, commit: null, reason: 'no observations to push' };

  // ── Export each observation as a .md file ──
  let filesWritten = 0;
  for (const obs of toPush) {
    try {
      // Get relations for this observation
      const relations = db.prepare(
        'SELECT r.relation_type as relation_type, r.target_id as target_id, o.title as target_title FROM memory_relations r LEFT JOIN observations o ON o.id = r.target_id WHERE r.source_id = ?'
      ).all(obs.id);

      const md = encodeObservation(obs, relations);
      const filename = generateFilename(obs);
      const filePath = path.join(globalDir, filename);
      fs.writeFileSync(filePath, md, 'utf-8');
      filesWritten++;
    } catch (err) {
      console.warn('[agentic-cortex] Failed to export obs #' + obs.id + ': ' + (err.message || '').slice(0, 100));
    }
  }

  if (filesWritten === 0) return { pushed: 0, commit: null, reason: 'no files written' };

  // ── Commit and push ──
  try {
    execSync('git add .cortex/', { cwd: repoDir, encoding: 'utf-8', timeout: 10000, stdio: 'pipe' });
    const status = execSync('git status --porcelain', { cwd: repoDir, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    if (!status.trim()) return { pushed: 0, commit: null, reason: 'no changes to commit' };

    execSync(
      'git commit -m "sync: ' + filesWritten + ' global observation(s) [agentic-cortex]"',
      { cwd: repoDir, encoding: 'utf-8', timeout: 10000, stdio: 'pipe' }
    );

    execSync('git push origin HEAD', { cwd: repoDir, encoding: 'utf-8', timeout: 30000, stdio: 'pipe' });

    const commitHash = execSync('git rev-parse --short HEAD', {
      cwd: repoDir, encoding: 'utf-8', timeout: 5000, stdio: 'pipe',
    }).trim();

    console.error('[agentic-cortex] Git sync push: %d observation(s) → %s (commit %s)', filesWritten, url, commitHash);

    return { pushed: filesWritten, commit: commitHash, repoUrl: url };
  } catch (err) {
    console.warn('[agentic-cortex] Git push failed (non-fatal):', (err.stderr || err.message || '').slice(0, 200));
    return { pushed: filesWritten, commit: null, reason: 'push failed: ' + (err.message || '').slice(0, 100) };
  }
}

/**
 * Quote a string for safe shell usage (cross-platform).
 * @param {string} str
 * @returns {string}
 */
function _shellQuote(str) {
  if (process.platform === 'win32') {
    return '"' + str.replace(/"/g, '\\"') + '"';
  }
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

module.exports = { syncPull, syncPush, _getRepoUrl };
