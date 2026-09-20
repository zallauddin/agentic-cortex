/**
 * claims.js — Settleable commitments (YOINK-inspired).
 *
 * A memory can carry a claim about the future that settles itself: when the
 * settle date arrives, the named source is read, the test is applied, and the
 * outcome is written back onto the memory. A claim is only accepted when a
 * grader can check it — vague claims, past settle dates, unknown sources, and
 * ungradeable tests are refused at save time.
 *
 * Claim fields live in the `claim_meta` JSON column on observations:
 *   { claim, settles, reads, test }
 * and settlement state in `claim_status` ('open' | 'settled') plus the
 * `claim_settlements` table.
 *
 * Four kinds of source, each naming where the number came from:
 *   file:path/to/data.json#dot.path   — a JSON file, by key path
 *   csv:path/to/bars.csv#close@date   — a column, on a date row
 *   chain:network/method              — a public chain, over read-only JSON-RPC
 *   manual:https://…                  — a human reads it; the URL is recorded
 *
 * @module core/claims
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Tests ───────────────────────────────────────────────────────────────

const TEST_OPS = new Set(['gte', 'lte', 'gt', 'lt', 'eq', 'between']);

/**
 * Parse a test expression like "gte 10" or "between 2 4".
 *
 * @param {string} str
 * @returns {{ op: string, args: number[] } | null} null if unparseable
 */
function parseTest(str) {
  if (typeof str !== 'string') return null;
  const parts = str.trim().split(/\s+/);
  const op = parts[0];
  if (!TEST_OPS.has(op)) return null;
  const args = parts.slice(1).map(Number);
  if (args.length === 0 || args.some(a => !Number.isFinite(a))) return null;
  if (op === 'between' && args.length !== 2) return null;
  if (op !== 'between' && args.length !== 1) return null;
  return { op, args };
}

/**
 * Apply a parsed test to a numeric reading.
 *
 * @param {{ op: string, args: number[] }} test
 * @param {number} value
 * @returns {boolean}
 */
function applyTest(test, value) {
  const [a, b] = test.args;
  switch (test.op) {
    case 'gte': return value >= a;
    case 'lte': return value <= a;
    case 'gt': return value > a;
    case 'lt': return value < a;
    case 'eq': return value === a;
    case 'between': return value >= Math.min(a, b) && value <= Math.max(a, b);
    default: return false;
  }
}

// ─── Sources ─────────────────────────────────────────────────────────────

const SOURCE_SCHEMES = new Set(['file', 'csv', 'chain', 'manual']);

/**
 * Parse a source string like "file:data/readings.json#txcount".
 *
 * @param {string} str
 * @returns {{ scheme: string, rest: string, locator: string } | null}
 */
function parseSource(str) {
  if (typeof str !== 'string') return null;
  const m = str.match(/^(file|csv|chain|manual):(.+)$/);
  if (!m) return null;
  const scheme = m[1];
  const rest = m[2].trim();
  if (!rest) return null;
  // manual: records the URL/address so the settlement can be argued with later
  if (scheme === 'manual') {
    if (!/^https?:\/\/\S+/.test(rest) && !/^manual-inline:/.test(rest)) {
      return { scheme, rest, locator: rest };
    }
  }
  const hashIdx = rest.indexOf('#');
  return {
    scheme,
    rest,
    locator: hashIdx >= 0 ? rest.slice(hashIdx + 1) : '',
  };
}

/** Read a dot-separated key path out of a parsed JSON object. */
function _readJsonPath(obj, dotPath) {
  let cur = obj;
  for (const key of dotPath.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * Read a value from a claim source. Deterministic sources (file:, csv:) never
 * touch the network. chain: speaks read-only JSON-RPC only — it has four
 * methods and all four read. manual: cannot be resolved by the machine; the
 * caller must supply the value a human read at the recorded URL.
 *
 * @param {string} sourceStr - Raw source string from claim_meta.reads
 * @param {Object} [opts]
 * @param {string} [opts.project] - Base directory for relative file:/csv: paths
 * @param {string} [opts.rpcBase] - JSON-RPC endpoint for chain: sources
 * @param {number} [opts.timeoutMs=5000]
 * @returns {Promise<{ value: number|null, reading: string, source: string, error?: string }>}
 */
async function readSource(sourceStr, opts) {
  opts = opts || {};
  const parsed = parseSource(sourceStr);
  if (!parsed) return { value: null, reading: null, source: sourceStr, error: 'unparseable source: ' + sourceStr };

  if (parsed.scheme === 'manual') {
    return {
      value: null,
      reading: null,
      source: sourceStr,
      error: 'manual source cannot be read by the machine — settle with the value a human read at ' + parsed.locator,
    };
  }

  if (parsed.scheme === 'file') {
    const [filePart, dotPath] = parsed.rest.split('#');
    const filePath = path.resolve(opts.project || process.cwd(), filePart);
    let json;
    try {
      json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      return { value: null, reading: null, source: sourceStr, error: 'cannot read file source: ' + err.message };
    }
    const v = dotPath ? _readJsonPath(json, dotPath) : json;
    if (typeof v !== 'number') {
      return { value: null, reading: null, source: sourceStr, error: 'key path "' + (dotPath || '') + '" is not a number in ' + filePart };
    }
    return { value: v, reading: String(v), source: sourceStr };
  }

  if (parsed.scheme === 'csv') {
    // csv:path#close@2026-10-01
    const m = parsed.rest.match(/^(.+)#([^@#]+)(?:@(\d{4}-\d{2}-\d{2}))?$/);
    if (!m) return { value: null, reading: null, source: sourceStr, error: 'csv source must look like csv:path#column@date' };
    const [, filePart, column, date] = m;
    const filePath = path.resolve(opts.project || process.cwd(), filePart);
    let rows;
    try {
      rows = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/).map(l => l.split(','));
    } catch (err) {
      return { value: null, reading: null, source: sourceStr, error: 'cannot read csv source: ' + err.message };
    }
    if (rows.length < 2) return { value: null, reading: null, source: sourceStr, error: 'csv has no data rows' };
    const header = rows[0].map(h => h.trim());
    const colIdx = header.indexOf(column);
    if (colIdx < 0) return { value: null, reading: null, source: sourceStr, error: 'column "' + column + '" not in csv header' };
    let row = rows[rows.length - 1];
    if (date) {
      // Date row: match a 'date'-like column, else the first column
      const dateIdx = header.findIndex(h => /date|day/i.test(h));
      const lookIdx = dateIdx >= 0 ? dateIdx : 0;
      row = rows.slice(1).find(r => (r[lookIdx] || '').trim().startsWith(date));
      if (!row) return { value: null, reading: null, source: sourceStr, error: 'no row for date ' + date };
    }
    const v = Number((row[colIdx] || '').trim());
    if (!Number.isFinite(v)) return { value: null, reading: null, source: sourceStr, error: 'cell is not a number at column ' + column };
    return { value: v, reading: String(v), source: sourceStr };
  }

  if (parsed.scheme === 'chain') {
    // chain:network/method — e.g. chain:robinhood-testnet/eth_blockNumber
    // Read-only JSON-RPC. Before any read it calls eth_chainId and refuses if
    // the endpoint reports a different chain than the one the claim named.
    if (!opts.rpcBase) {
      return { value: null, reading: null, source: sourceStr, error: 'no RPC endpoint configured for chain source (set --rpc-base)' };
    }
    const slashIdx = parsed.rest.indexOf('/');
    if (slashIdx < 0) return { value: null, reading: null, source: sourceStr, error: 'chain source must look like chain:network/method' };
    const network = parsed.rest.slice(0, slashIdx).trim();
    const rpcMethod = parsed.rest.slice(slashIdx + 1).trim();
    const READ_ONLY_METHODS = new Set([
      'eth_blockNumber', 'eth_getBalance', 'eth_getBlockByNumber', 'eth_call',
      'eth_getTransactionCount', 'eth_getCode', 'eth_getStorageAt', 'net_version',
    ]);
    if (!READ_ONLY_METHODS.has(rpcMethod)) {
      return { value: null, reading: null, source: sourceStr, error: 'refused: "' + rpcMethod + '" is not a read method. chain: reads only' };
    }
    const timeoutMs = opts.timeoutMs || 5000;
    async function rpc(method, params) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(opts.rpcBase, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || [] }),
          signal: ctrl.signal,
        });
        const body = await res.json();
        if (body.error) throw new Error(body.error.message || 'rpc error');
        return body.result;
      } finally {
        clearTimeout(timer);
      }
    }
    try {
      // Chain identity guard: a mainnet answer cannot quietly settle a testnet bet.
      const chainIdHex = await rpc('eth_chainId');
      const chainId = parseInt(chainIdHex, 16);
      if (opts.expectChainId != null && chainId !== opts.expectChainId) {
        return { value: null, reading: null, source: sourceStr, error: 'endpoint reports chain ' + chainId + ', claim named ' + opts.expectChainId };
      }
      const result = await rpc(rpcMethod);
      const num = typeof result === 'string' && /^0x/i.test(result) ? parseInt(result, 16) : Number(result);
      if (!Number.isFinite(num)) return { value: null, reading: null, source: sourceStr, error: 'rpc result is not a number' };
      return { value: num, reading: String(num), source: sourceStr + ' @ chain ' + chainId };
    } catch (err) {
      return { value: null, reading: null, source: sourceStr, error: 'chain read failed: ' + err.message };
    }
  }

  return { value: null, reading: null, source: sourceStr, error: 'unknown source scheme' };
}

// ─── Validation (the refusals) ───────────────────────────────────────────

/**
 * Validate a claim attempt. Returns the errors that make the claim
 * ungradeable. A claim is only worth making if somebody who was not there
 * can check it.
 *
 * @param {Object} fields - { claim?, settles?, reads?, test? }
 * @param {Object} [opts] - { now?: Date }
 * @returns {{ ok: boolean, errors: string[], meta: Object|null }}
 */
function validateClaim(fields, opts) {
  const now = (opts && opts.now) || new Date();
  const errors = [];
  const meta = {
    claim: fields.claim || null,
    settles: fields.settles || null,
    reads: fields.reads || null,
    test: fields.test || null,
  };

  const hasAny = !!(fields.claim || fields.settles || fields.reads || fields.test);
  if (!hasAny) return { ok: false, errors: [], meta: null };

  if (!fields.claim) errors.push('no claim text — say what will be true');
  if (!fields.settles) {
    errors.push('no settle date — a claim without a date can never be graded');
  } else if (!/^\d{4}-\d{2}-\d{2}/.test(String(fields.settles))) {
    errors.push('settles must be an ISO date (YYYY-MM-DD)');
  } else {
    const when = new Date(String(fields.settles).slice(0, 10) + 'T23:59:59Z');
    if (isNaN(when.getTime())) {
      errors.push('settles date is not a real date');
    } else if (when.getTime() < now.getTime()) {
      errors.push(String(fields.settles).slice(0, 10) + ' is not in the future. You cannot bet on yesterday\u2019s race');
    }
  }

  if (!fields.reads) {
    errors.push('no source — a claim only worth making if somebody who was not there can check it. Use file:, csv:, chain: or manual:<url>');
  } else if (!parseSource(fields.reads)) {
    errors.push("'" + fields.reads + "' is not a source. Use file:, csv:, chain: or manual:<url>");
  }

  if (!fields.test) {
    errors.push('no test — say what number, and which way. Use one of: gte 10, lte 3.5, gt 0, eq 1, between 2 4');
  } else if (!parseTest(fields.test)) {
    errors.push("'" + fields.test + "' is not a test. Use one of: gte 10, lte 3.5, gt 0, eq 1, between 2 4");
  }

  if (errors.length > 0) return { ok: false, errors, meta: null };
  return { ok: true, errors: [], meta };
}

/**
 * Save-time sanity gate. Detects prediction-shaped content that was NOT
 * declared as a claim and returns a warning (never blocks the save).
 *
 * @param {string} type - Memory type
 * @param {string} title
 * @param {string} content
 * @returns {string[]} Warnings
 */
function sanityWarnings(type, title, content) {
  const warnings = [];
  const text = ((title || '') + ' ' + (content || '')).toLowerCase();
  const predicts = /\b(will|should|expect(ed)? to|going to|by (next|end of)|deadline)\b/.test(text);
  const hasDate = /\b\d{4}-\d{2}-\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}\b|\b(next (week|month|quarter|year)|tomorrow)\b/.test(text);
  if (predicts && hasDate) {
    warnings.push(
      'This memory predicts something with a date but is not a verifiable claim. ' +
      'Attach --claim/--settles/--reads/--test (or claim/settles/reads/test on memory_save) ' +
      'so the outcome can be graded when the date arrives.'
    );
  }
  if (type === 'commitment' && !hasDate) {
    warnings.push('Commitment has no date — attach --settles so it can settle itself.');
  }
  return warnings;
}

// ─── Settlement ──────────────────────────────────────────────────────────

/**
 * Parse claim_meta JSON safely.
 * @param {string|null} json
 */
function parseClaimMeta(json) {
  if (!json) return null;
  try {
    const m = JSON.parse(json);
    return (m && m.claim) ? m : null;
  } catch { return null; }
}

/**
 * Find open claims whose settle date has arrived.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} [opts] - { project?, now? }
 * @returns {Array<Object>} Open due claims
 */
function dueClaims(db, opts) {
  opts = opts || {};
  const now = opts.now || new Date();
  const today = now.toISOString().slice(0, 10);
  const rows = opts.project
    ? db.prepare("SELECT id, project_path, type, title, content, claim_meta, claim_status FROM observations WHERE claim_status = 'open' AND claim_meta IS NOT NULL AND project_path = ?").all(opts.project)
    : db.prepare("SELECT id, project_path, type, title, content, claim_meta, claim_status FROM observations WHERE claim_status = 'open' AND claim_meta IS NOT NULL").all();
  return rows.map(r => ({ row: r, meta: parseClaimMeta(r.claim_meta) }))
    .filter(x => x.meta && x.meta.settles && x.meta.settles.slice(0, 10) <= today)
    .map(x => x.row);
}

/**
 * Settle one claim with an explicit reading (manual sources, or forced value).
 * Applies the test, records the settlement, writes the outcome onto the
 * memory, and marks it settled. A settled claim cannot be settled again.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} id - Observation id
 * @param {number|string} valueOrReading - The reading to test against
 * @param {Object} [opts] - { source?, note? }
 */
function settleWithValue(db, id, valueOrReading, opts) {
  opts = opts || {};
  const obs = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
  if (!obs) throw new Error('observation not found: ' + id);
  if (obs.claim_status === 'settled') throw new Error('already settled — a settled claim cannot be settled again (no settling, looking, and settling differently)');
  const meta = parseClaimMeta(obs.claim_meta);
  if (!meta) throw new Error('observation #' + id + ' carries no claim');

  const test = parseTest(meta.test);
  if (!test) throw new Error('claim test is unparseable: ' + meta.test);

  const value = Number(valueOrReading);
  if (!Number.isFinite(value)) throw new Error('reading is not a number: ' + valueOrReading);
  const outcome = applyTest(test, value);

  const source = opts.source || (meta.reads ? meta.reads : 'manual:recorded-at-settlement');
  const settledAt = new Date().toISOString();
  db.prepare('INSERT INTO claim_settlements (observation_id, source, reading, test, outcome, settled_at) VALUES (?,?,?,?,?,?)')
    .run(id, source, String(value), meta.test, outcome ? 1 : 0, settledAt);
  const tags = JSON.parse(obs.tags || '[]');
  for (const t of [outcome ? 'claim-true' : 'claim-false', 'settled']) {
    if (!tags.includes(t)) tags.push(t);
  }
  db.prepare("UPDATE observations SET claim_status = 'settled', tags = ? WHERE id = ?").run(JSON.stringify(tags), id);

  return {
    id,
    claim: meta.claim,
    test: meta.test,
    reading: String(value),
    outcome,
    source,
    settledAt,
    note: opts.note || null,
  };
}

/**
 * Settle everything due. Sources are read; if a source cannot answer the
 * claim stays open rather than settling on a guess. manual: sources settle
 * only via an explicit --value / opts.value.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} [opts] - { project?, value?, rpcBase?, expectChainId?, now? }
 * @returns {{ settled: Array, stayedOpen: Array, dueCount: number }}
 */
async function settleDue(db, opts) {
  opts = opts || {};
  const due = dueClaims(db, { project: opts.project, now: opts.now });
  const settled = [];
  const stayedOpen = [];

  for (const row of due) {
    const meta = parseClaimMeta(row.claim_meta);
    try {
      if (opts.value != null) {
        settled.push(settleWithValue(db, row.id, opts.value, { note: 'settled with supplied value' }));
        continue;
      }
      const parsed = parseSource(meta.reads);
      if (parsed && parsed.scheme === 'manual') {
        if (opts.manualValue != null) {
          settled.push(settleWithValue(db, row.id, opts.manualValue, { source: meta.reads, note: 'manual: value a human read at the recorded URL' }));
        } else {
          stayedOpen.push({ id: row.id, reason: 'manual source — supply the value a human read at ' + parsed.locator });
        }
        continue;
      }
      const read = await readSource(meta.reads, {
        project: opts.project || row.project_path,
        rpcBase: opts.rpcBase,
        expectChainId: opts.expectChainId,
      });
      if (read.error || read.value == null) {
        stayedOpen.push({ id: row.id, reason: read.error || 'source gave no number' });
        continue;
      }
      settled.push(settleWithValue(db, row.id, read.value, { source: read.source }));
    } catch (err) {
      stayedOpen.push({ id: row.id, reason: err.message });
    }
  }

  return { settled, stayedOpen, dueCount: due.length };
}

module.exports = {
  TEST_OPS,
  SOURCE_SCHEMES,
  parseTest,
  applyTest,
  parseSource,
  readSource,
  validateClaim,
  sanityWarnings,
  parseClaimMeta,
  dueClaims,
  settleWithValue,
  settleDue,
};
