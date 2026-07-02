/**
 * db-path.js — XDG-aware database path resolution with env var override
 *
 * Priority order:
 * 1. AGENTIC_CORTEX_DB environment variable (absolute path)
 * 2. XDG_DATA_HOME/agentic-cortex/agentic-cortex.db (Linux/macOS)
 * 3. APPDATA/agentic-cortex/agentic-cortex.db (Windows)
 * 4. ~/.local/share/agentic-cortex/agentic-cortex.db (fallback Linux/macOS)
 * 5. ./agentic-cortex.db (current directory fallback - backward compatibility)
 */

'use strict';

const { homedir } = require('os');
const { join, resolve, dirname } = require('path');
const { existsSync, mkdirSync } = require('fs');

const DB_FILENAME = 'agentic-cortex.db';

/**
 * Ensure the parent directory of a file path exists.
 * @param {string} filePath - Path to file
 */
function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Resolve the database path following XDG Base Directory Specification
 * with environment variable override.
 *
 * @returns {string} Absolute path to the database file
 */
function getDbPath() {
  // 1. Environment variable override (highest priority)
  if (process.env.AGENTIC_CORTEX_DB) {
    const envPath = resolve(process.env.AGENTIC_CORTEX_DB);
    ensureDir(envPath);
    return envPath;
  }

  // 2. XDG_DATA_HOME (Linux/macOS standard)
  if (process.env.XDG_DATA_HOME) {
    const xdgPath = join(process.env.XDG_DATA_HOME, 'agentic-cortex', DB_FILENAME);
    ensureDir(xdgPath);
    return xdgPath;
  }

  // 3. Windows APPDATA
  if (process.platform === 'win32' && process.env.APPDATA) {
    const winPath = join(process.env.APPDATA, 'agentic-cortex', DB_FILENAME);
    ensureDir(winPath);
    return winPath;
  }

  // 4. ~/.local/share (XDG fallback for Linux/macOS)
  if (process.platform !== 'win32') {
    const localPath = join(homedir(), '.local', 'share', 'agentic-cortex', DB_FILENAME);
    ensureDir(localPath);
    return localPath;
  }

  // 5. Current directory fallback (backward compatibility)
  const fallbackPath = join(process.cwd(), DB_FILENAME);
  return fallbackPath;
}

/**
 * Get the database directory (parent of db file)
 * @returns {string} Absolute path to database directory
 */
function getDbDir() {
  return join(getDbPath(), '..');
}

/**
 * Get the legacy database path (for migration purposes)
 * @returns {string} Legacy path in project root
 */
function getLegacyDbPath() {
  return join(process.cwd(), DB_FILENAME);
}

/**
 * Check if legacy database exists and should be migrated
 * @returns {string|null} Legacy path if exists, null otherwise
 */
function getLegacyDbPathIfExists() {
  const legacyPath = getLegacyDbPath();
  if (existsSync(legacyPath)) {
    return legacyPath;
  }
  // Also check old names from previous package versions
  const oldNames = ['freebuff-mem.db', 'infinit-mem.db'];
  for (const oldName of oldNames) {
    const oldPath = join(process.cwd(), oldName);
    if (existsSync(oldPath)) return oldPath;
  }
  return null;
}

module.exports = { getDbPath, getDbDir, getLegacyDbPath, getLegacyDbPathIfExists };
