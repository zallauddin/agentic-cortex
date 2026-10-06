/**
 * seed-log.js — Trust plane: a Merkle-chained, transparency-log for seeds
 * (phase 3c). Reuses the v7.5.0 eval-log construction —
 * `hash_n = sha256(prev_hash | canonical_entry)` — applied to the seed
 * registry's append-only log.
 *
 * How it works (Certificate-Transparency thinking, minimized):
 *
 *   - The registry hub keeps `log/log.jsonl`: one JSON entry per line, in
 *     append order. Each entry = { seq, action, seedHash, publishedAt }
 *     plus the chain fields { prevHash, entryHash }.
 *   - `entryHash_n = sha256(prevHash_n | seq | action | seedHash | publishedAt)`.
 *     The chain anchors at the empty string, same as the eval log.
 *   - The hub periodically signs the log **head** (latest seq + entryHash)
 *     with its ed25519 key → `log/head.json`. Heads are tiny (~200 bytes)
 *     and are what gets gossiped between hubs / cached by machines.
 *   - Any machine holding (a) the log file and (b) ANY previously observed
 *     signed head can verify two things:
 *         1. the log is internally consistent (every link recomputes), and
 *         2. the seed it cares about is included: recompute the chain from
 *            the beginning and check the seed's entryHash is in the chain —
 *            or, cheaper, ask the hub for an **inclusion proof** (the chain
 *            of entryHashes from that entry to the head) and verify it
 *            against the cached head. Either way, a hub that rewrites
 *            history produces a chain that contradicts some previously
 *            observed head — the inconsistency IS the alarm.
 *   - Tamper-evident, not tamper-proof (same honesty as the eval log): a hub
 *     can rewrite everything and re-sign, but it cannot produce a chain that
 *     matches two different heads observed at two different times. That is
 *     the property gossip buys: witnesses.
 *
 * @module core/seed-log
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function logDir(registryDir) {
  return path.join(registryDir, 'log');
}
function logFile(registryDir) {
  return path.join(logDir(registryDir), 'log.jsonl');
}
function headFile(registryDir) {
  return path.join(logDir(registryDir), 'head.json');
}

function canonicalEntry(seq, action, seedHash, publishedAt) {
  return [seq, action, seedHash, publishedAt].join('|');
}

function computeEntryHash(prevHash, seq, action, seedHash, publishedAt) {
  return crypto.createHash('sha256')
    .update(prevHash + '|' + canonicalEntry(seq, action, seedHash, publishedAt))
    .digest('hex');
}

// ─── Append (hub-side) ───────────────────────────────────────────────────────

/**
 * Append an entry to the hub log. Fail-closed on any inconsistency: if the
 * existing file's chain does not verify, refuse to extend it.
 *
 * @param {string} registryDir
 * @param {{ action: 'publish'|'retire', seedHash: string }} entry
 * @returns {{ seq: number, entryHash: string, headHash: string }}
 */
function appendLogEntry(registryDir, entry) {
  if (!['publish', 'retire'].includes(entry.action)) throw new Error("action must be 'publish' or 'retire'");
  if (!/^[0-9a-f]{16}$/.test(entry.seedHash)) throw new Error('seedHash must be a 16-hex-char content hash');

  fs.mkdirSync(logDir(registryDir), { recursive: true });
  const file = logFile(registryDir);

  // Read + verify existing chain before extending it (fail-closed).
  const existing = readLog(registryDir);
  if (existing.chainBroken) {
    throw new Error('refusing to extend a broken log at seq ' + existing.brokenAt + ' — investigate before appending');
  }

  const seq = existing.entries.length + 1;
  const prevHash = seq === 1 ? '' : existing.entries[seq - 2].entryHash;
  const publishedAt = new Date().toISOString();
  const entryHash = computeEntryHash(prevHash, seq, entry.action, entry.seedHash, publishedAt);

  const line = JSON.stringify({ seq, action: entry.action, seedHash: entry.seedHash, publishedAt, prevHash, entryHash });
  fs.appendFileSync(file, line + '\n', 'utf8');

  const head = signHead(registryDir);
  return { seq, entryHash, headHash: head.headHash };
}

// ─── Read + verify ───────────────────────────────────────────────────────────

/**
 * Read the log and recompute every link. Returns entries plus integrity info.
 * @returns {{ entries: Array, chainBroken: boolean, brokenAt: number|null, length: number }}
 */
function readLog(registryDir) {
  const file = logFile(registryDir);
  const entries = [];
  if (!fs.existsSync(file)) return { entries, chainBroken: false, brokenAt: null, length: 0 };

  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
  let prevHash = '';
  for (let i = 0; i < lines.length; i++) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { return { entries, chainBroken: true, brokenAt: i + 1, length: entries.length }; }
    if (e.seq !== i + 1 || e.prevHash !== prevHash) {
      return { entries, chainBroken: true, brokenAt: i + 1, length: entries.length };
    }
    const expected = computeEntryHash(prevHash, e.seq, e.action, e.seedHash, e.publishedAt);
    if (e.entryHash !== expected) {
      return { entries, chainBroken: true, brokenAt: i + 1, length: entries.length };
    }
    entries.push(e);
    prevHash = e.entryHash;
  }
  return { entries, chainBroken: false, brokenAt: null, length: entries.length };
}

// ─── Signed heads ────────────────────────────────────────────────────────────

/**
 * Sign the current head with the given project's keypair and write head.json.
 * Heads are what gossip carries: { hubId, seq, headHash, signedAt, signature }.
 * hubId is the fingerprint of the hub's public key — anonymous, like machine ids.
 */
function signHead(registryDir, projectRoot) {
  const log = readLog(registryDir);
  if (log.chainBroken) throw new Error('refusing to sign a broken log head');
  projectRoot = projectRoot || process.cwd();
  const seeds = require('./seeds');
  const { privateKeyPath } = seeds.ensureKeypair(projectRoot);
  const pubPath = path.join(projectRoot, '.cortex', 'keys', 'signing.pub');
  const pub = fs.readFileSync(pubPath, 'utf8');

  const head = {
    hubId: seeds.fingerprint(pub),
    seq: log.entries.length,
    headHash: log.entries.length ? log.entries[log.entries.length - 1].entryHash : '',
    signedAt: new Date().toISOString(),
  };
  head.signature = crypto.sign(null, Buffer.from(JSON.stringify({ ...head, signature: undefined })), crypto.createPrivateKey(fs.readFileSync(privateKeyPath, 'utf8'))).toString('base64');
  fs.mkdirSync(logDir(registryDir), { recursive: true });
  fs.writeFileSync(headFile(registryDir), JSON.stringify(head, null, 2), 'utf8');
  return head;
}

/**
 * Verify a gossiped head against a trusted public key (fail-closed).
 * @returns {{ ok: boolean, reason?: string }}
 */
function verifyHead(head, trustedPublicKeys) {
  try {
    if (!head || !head.signature) return { ok: false, reason: 'missing signature' };
    const seeds = require('./seeds');
    const pub = (trustedPublicKeys || []).find(k => seeds.fingerprint(k) === head.hubId);
    if (!pub) return { ok: false, reason: 'head from untrusted hub: ' + head.hubId };
    const bytes = Buffer.from(JSON.stringify({ ...head, signature: undefined }));
    const ok = crypto.verify(null, bytes, crypto.createPublicKey(pub), Buffer.from(head.signature, 'base64'));
    return ok ? { ok: true } : { ok: false, reason: 'head signature mismatch' };
  } catch (err) {
    return { ok: false, reason: 'verify error (fail-closed): ' + (err && err.message ? err.message : err) };
  }
}

// ─── Gossip: observe + reconcile heads ───────────────────────────────────────

/**
 * Merge gossiped heads into the local witness set (`.cortex/seed-log-heads.json`).
 * Keeps, per hubId, the head with the HIGHEST seq ever observed — a hub can
 * only move forward; seeing a lower-seq head from the same hubId later is
 * normal gossip lag, seeing the same seq with a DIFFERENT headHash is fraud.
 *
 * @returns {{ witnesses: number, conflicts: Array<{hubId: string, seq: number, keptHash: string, seenHash: string}> }}
 */
function observeHeads(projectRoot, heads, trustedPublicKeys) {
  const witnessFile = path.join(projectRoot || process.cwd(), '.cortex', 'seed-log-heads.json');
  fs.mkdirSync(path.dirname(witnessFile), { recursive: true });
  let observed = {};
  if (fs.existsSync(witnessFile)) {
    try { observed = JSON.parse(fs.readFileSync(witnessFile, 'utf8')); } catch { observed = {}; }
  }

  const conflicts = [];
  for (const head of heads || []) {
    const v = verifyHead(head, trustedPublicKeys);
    if (!v.ok) continue; // fail-closed: untrusted heads are not witnesses
    const known = observed[head.hubId];
    if (!known || head.seq > known.seq) {
      observed[head.hubId] = { seq: head.seq, headHash: head.headHash, signedAt: head.signedAt };
    } else if (head.seq === known.seq && head.headHash !== known.headHash) {
      conflicts.push({ hubId: head.hubId, seq: head.seq, keptHash: known.headHash, seenHash: head.headHash });
    }
  }
  fs.writeFileSync(witnessFile, JSON.stringify(observed, null, 2), 'utf8');
  return { witnesses: Object.keys(observed).length, conflicts };
}

// ─── Inclusion proof ─────────────────────────────────────────────────────────

/**
 * Inclusion proof for a seed: the chain of entryHashes from the seed's entry
 * to the current head. A verifier holding a previously observed signed head
 * (with seq >= proof.toSeq) recomputes nothing more than the final link:
 * proof.chain[last] must equal the observed head's headHash, and each link i
 * must equal sha256(chain[i-1] | canonicalEntry_i) — supplied inline so the
 * verifier can recompute the whole span cheaply from the log tail.
 *
 * Practical shape (matches CT "consistency" intuition): we return the tail
 * entries from the seed's seq to the head; verification = recompute hashes
 * over the span and check the last equals a trusted head.
 *
 * @returns {{ ok: boolean, fromSeq?: number, toSeq?: number, chain?: string[], reason?: string }}
 */
function inclusionProof(registryDir, seedHash) {
  const log = readLog(registryDir);
  if (log.chainBroken) return { ok: false, reason: 'log chain broken at seq ' + log.brokenAt };
  const idx = log.entries.findIndex(e => e.seedHash === seedHash && e.action === 'publish');
  if (idx === -1) return { ok: false, reason: 'seed not found in log' };
  const span = log.entries.slice(idx).map(e => e.entryHash);
  return { ok: true, fromSeq: log.entries[idx].seq, toSeq: log.entries[log.entries.length - 1].seq, chain: span };
}

/**
 * Verify an inclusion proof against a trusted, previously observed head.
 * Recomputes the chain over the span using the log file and checks:
 *   1. proof.chain is contiguous and internally consistent
 *   2. proof.chain[last] === trustedHead.headHash (the anchor the witness holds)
 */
function verifyInclusion(registryDir, seedHash, proof, trustedHead, trustedPublicKeys) {
  const hv = verifyHead(trustedHead, trustedPublicKeys);
  if (!hv.ok) return { ok: false, reason: 'untrusted head: ' + hv.reason };
  if (!proof || !proof.ok) return { ok: false, reason: 'invalid proof object' };
  if (trustedHead.seq < proof.toSeq) return { ok: false, reason: 'observed head is older than proof span' };

  const log = readLog(registryDir);
  if (log.chainBroken) return { ok: false, reason: 'log chain broken at seq ' + log.brokenAt };

  // The span must end exactly at the trusted head's seq...
  if (log.entries.length !== trustedHead.seq) return { ok: false, reason: 'log length ' + log.entries.length + ' != head seq ' + trustedHead.seq };
  // ...and its final hash must equal the witness hash.
  const last = log.entries[log.entries.length - 1];
  if (last.entryHash !== trustedHead.headHash) return { ok: false, reason: 'head hash mismatch — log diverged from observed head' };

  const mine = log.entries.find(e => e.seedHash === seedHash && e.action === 'publish');
  if (!mine) return { ok: false, reason: 'seed absent from log span' };
  if (mine.seq < proof.fromSeq || mine.seq > proof.toSeq) return { ok: false, reason: 'seed outside proof span' };
  return { ok: true, seq: mine.seq };
}

module.exports = {
  appendLogEntry,
  readLog,
  signHead,
  verifyHead,
  observeHeads,
  inclusionProof,
  verifyInclusion,
};
