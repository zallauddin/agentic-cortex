/**
 * log.js — Minimal structured logger for agentic-cortex.
 *
 * AGENTIC_CORTEX_LOG=json   → one JSON object per line (machine-parseable,
 *                             ready for any log shipper)
 * AGENTIC_CORTEX_LOG=pretty (default) → human-readable single lines
 *
 * Levels: debug < info < warn < error. AGENTIC_CORTEX_LOG_LEVEL filters
 * (default: info). Never throws; logging must not break the caller.
 */

'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function minLevel() {
  const l = (process.env.AGENTIC_CORTEX_LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[l] ?? LEVELS.info;
}

function jsonMode() {
  return (process.env.AGENTIC_CORTEX_LOG || '').toLowerCase() === 'json';
}

function emit(level, msg, fields) {
  if (LEVELS[level] < minLevel()) return;
  const ts = new Date().toISOString();
  try {
    if (jsonMode()) {
      const rec = { ts, level, msg };
      if (fields) {
        for (const [k, v] of Object.entries(fields)) {
          if (v instanceof Error) rec[k] = { message: v.message, code: v.code };
          else rec[k] = v;
        }
      }
      process.stderr.write(JSON.stringify(rec) + '\n');
    } else {
      const suffix = fields && Object.keys(fields).length
        ? ' ' + JSON.stringify(fields, (_k, v) => (v instanceof Error ? v.message : v))
        : '';
      process.stderr.write(`[${ts}] ${level.toUpperCase()} ${msg}${suffix}\n`);
    }
  } catch {
    /* logging must never break the caller */
  }
}

module.exports = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};
