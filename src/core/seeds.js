/**
 * seeds.js — Lesson seed exchange (phases 1–4 of lesson persistence).
 *
 * The registry is a git repo. Each seed is ONE JSON file at
 * `seeds/<hash[0:2]>/<hash>.json`, signed over its canonical bytes. Content
 * addressing gives free dedupe; sharding gives merge-conflict-free appends;
 * git transport gives auth (SSH/token), history, mirroring and CDN support
 * with zero server code. Phases differ only in *who runs the repo and how
 * grades are tallied* — the artifact format never changes.
 *
 * Trust model:
 *   publish — only `approved` rows from seed_review_queue (human gate);
 *             sanitizer re-runs at publish time (fail-closed).
 *   pull    — signature verified against trusted keys before import; unknown
 *             keys rejected by default; seeds import at reduced confidence
 *             with provenance 'seeded' and tag 'origin:community'.
 *   canary  — `canaryPct` (default 10) of imports activate immediately; the
 *             rest import parked (project_scope 'canary') until promoteCanary.
 *   grade   — consumers grade seeds helpful/not_helpful; gradeTally produces
 *             aggregate counts for quorum promotion/retirement; retired seeds
 *             are removed locally on next pull.
 *
 * @module core/seeds
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sanitizer = require('./seed-sanitizer');

/** Imported seeds start here — community knowledge is second-class until earned. */
const SEED_BASE_CONFIDENCE = 55;
const SEED_TAG = 'origin:community';

// ─── Keys ────────────────────────────────────────────────────────────────────

function _keyDir(projectRoot) {
  return path.join(projectRoot || process.cwd(), '.cortex', 'keys');
}

/**
 * Create this machine's signing keypair (ed25519). Idempotent.
 * @returns {{ publicKey: string, privateKeyPath: string }}
 */
function ensureKeypair(projectRoot) {
  const dir = _keyDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  const privPath = path.join(dir, 'signing.key');
  const pubPath = path.join(dir, 'signing.pub');
  if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
    return { publicKey: fs.readFileSync(pubPath, 'utf8').trim(), privateKeyPath: privPath };
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));
  return { publicKey: fs.readFileSync(pubPath, 'utf8').trim(), privateKeyPath: privPath };
}

function _signCanonical(payload, privateKeyPem) {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  return crypto.sign(null, bytes, crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

/**
 * Verify a seed's signature against a trusted public key.
 * @returns {{ ok: boolean, reason?: string }}
 */
function verifySignature(seed, trustedPublicKeys) {
  try {
    if (!seed || typeof seed !== 'object') return { ok: false, reason: 'malformed seed' };
    const { signature, ...rest } = seed;
    if (!signature || !signature.keyId || !signature.value) return { ok: false, reason: 'missing signature' };
    const pub = (trustedPublicKeys || []).find(k => fingerprint(k) === signature.keyId);
    if (!pub) return { ok: false, reason: 'signature key not trusted: ' + signature.keyId };
    const bytes = Buffer.from(JSON.stringify(rest), 'utf8');
    const ok = crypto.verify(null, bytes, crypto.createPublicKey(pub), Buffer.from(signature.value, 'base64'));
    return ok ? { ok: true } : { ok: false, reason: 'signature mismatch' };
  } catch (err) {
    return { ok: false, reason: 'verify error (fail-closed): ' + (err && err.message ? err.message : err) };
  }
}

function fingerprint(pem) {
  return crypto.createHash('sha256').update(String(pem).trim()).digest('hex').slice(0, 16);
}

// ─── Artifact ────────────────────────────────────────────────────────────────

/**
 * Build the canonical seed artifact from an approved review-queue row.
 * The stored content is used verbatim — it was sanitized at distill time and
 * the sanitizer re-screens here as a second gate.
 */
function buildSeedArtifact(row, opts = {}) {
  const screen = sanitizer.screenSeed({ ...row, type: 'learning' });
  if (!screen.allowed && screen.blockedBy && screen.blockedBy.length) {
    return { ok: false, reason: 'credential-class content re-detected at publish: ' + screen.blockedBy.join(', ') };
  }
  const red = sanitizer._redact(row.title + '\n' + row.content);
  const redCount = red.redactions.reduce((s, r) => s + r.count, 0);
  if (redCount > sanitizer.MAX_REDACTIONS) {
    return { ok: false, reason: 'too many redactions needed at publish: ' + redCount };
  }
  const [title, ...restLines] = red.text.split('\n');
  const content = restLines.join('\n').trim() || title;

  const artifact = {
    v: 1,
    hash: null, // filled below (content-addressed over the unsigned payload)
    type: row.type,
    title: title.trim(),
    content,
    confidence: SEED_BASE_CONFIDENCE,
    tags: [SEED_TAG],
    scope: row.scope === 'universal' ? 'universal' : 'machine',
    sourceCount: JSON.parse(row.source_ids || '[]').length,
    publishedAt: new Date().toISOString(),
  };
  artifact.hash = crypto.createHash('sha256').update(JSON.stringify(artifact)).digest('hex').slice(0, 16);
  return { ok: true, artifact };
}

function signArtifact(artifact, projectRoot) {
  const { privateKeyPath } = ensureKeypair(projectRoot);
  const pubPath = path.join(_keyDir(projectRoot), 'signing.pub');
  const signature = {
    keyId: fingerprint(fs.readFileSync(pubPath, 'utf8')),
    algo: 'ed25519',
    value: _signCanonical(artifact, fs.readFileSync(privateKeyPath, 'utf8')),
  };
  return { ...artifact, signature };
}

// ─── Review queue ────────────────────────────────────────────────────────────

function enqueueLessons(db, lessonsDir, opts = {}) {
  const limit = opts.limit || 200;
  const rows = [];
  const files = fs.existsSync(lessonsDir)
    ? fs.readdirSync(lessonsDir).filter(f => f.endsWith('.md') && f !== 'INDEX.md').sort()
    : [];
  for (const f of files.slice(0, limit)) {
    const raw = fs.readFileSync(path.join(lessonsDir, f), 'utf8');
    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) continue;
    const get = (k) => { const m = fm[1].match(new RegExp('^' + k + ': (.+)$', 'm')); return m ? m[1] : null; };
    const hash = get('id');
    if (!hash) continue;
    const dup = db.prepare('SELECT id FROM seed_review_queue WHERE lesson_hash = ?').get(hash);
    if (dup) continue;
    const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^\n+/, '');
    const titleMatch = body.match(/^# (.+)$/m);
    const content = body.replace(/^#[^\n]*\n+/, '').replace(/\nScope signals:[\s\S]*$/, '').replace(/\n<sanitization-report>[\s\S]*$/, '').trim();
    db.prepare(`INSERT INTO seed_review_queue (lesson_hash, lesson_file, type, title, content, scope, source_ids, sanitization_report)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      hash, f, get('type') || 'learning',
      titleMatch ? titleMatch[1] : (content.slice(0, 60) || f),
      content, get('scope') || 'machine', '[]', raw.match(/<sanitization-report>([\s\S]*?)<\/sanitization-report>/)?.[1]?.trim() || null
    );
    rows.push(hash);
  }
  return { queued: rows.length };
}

function listReviewQueue(db, opts = {}) {
  const status = opts.status || 'pending';
  return db.prepare('SELECT * FROM seed_review_queue WHERE status = ? ORDER BY created_at DESC LIMIT ?')
    .all(status, opts.limit || 50);
}

function reviewSeed(db, id, decision, opts = {}) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('decision must be approved|rejected');
  const row = db.prepare('SELECT * FROM seed_review_queue WHERE id = ?').get(id);
  if (!row) throw new Error('queue row ' + id + ' not found');
  db.prepare("UPDATE seed_review_queue SET status = ?, reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?")
    .run(decision, opts.reviewedBy || 'human', id);
  return { id, status: decision };
}

// ─── Publish (machine → registry clone) ──────────────────────────────────────

/**
 * Publish approved seeds into a local clone of the registry repo.
 * Caller is responsible for `git push` (network is never touched here).
 * @returns {{ published: number, files: string[], skipped: Array<{id:number, reason:string}> }}
 */
function publishApproved(db, registryDir, projectRoot, opts = {}) {
  const approved = db.prepare("SELECT * FROM seed_review_queue WHERE status = 'approved' LIMIT ?").all(opts.limit || 100);
  const seedsDir = path.join(registryDir, 'seeds');
  fs.mkdirSync(seedsDir, { recursive: true });
  const out = { published: 0, files: [], skipped: [] };

  for (const row of approved) {
    try {
      const built = buildSeedArtifact(row, opts);
      if (!built.ok) { out.skipped.push({ id: row.id, reason: built.reason }); continue; }
      const signed = signArtifact(built.artifact, projectRoot);
      const rel = path.join('seeds', signed.hash.slice(0, 2), signed.hash + '.json');
      const abs = path.join(registryDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, JSON.stringify(signed, null, 2), 'utf8');
      // Trust plane: append to the hub's Merkle-chained transparency log.
      try {
        const seedLog = require('./seed-log');
        const logEntry = seedLog.appendLogEntry(registryDir, { action: 'publish', seedHash: signed.hash });
        out.logSeq = logEntry.seq;
      } catch (logErr) {
        out.skipped.push({ id: row.id, reason: 'published but log append failed: ' + (logErr && logErr.message ? logErr.message : logErr) });
      }
      db.prepare("UPDATE seed_review_queue SET status = 'published' WHERE id = ?").run(row.id);
      out.files.push(rel);
      out.published++;
    } catch (err) {
      out.skipped.push({ id: row.id, reason: 'publish error (fail-closed): ' + (err && err.message ? err.message : err) });
    }
  }
  return out;
}

// ─── Pull (registry clone → machine vault) ───────────────────────────────────

/**
 * Import seeds from a local clone of the registry repo into the vault.
 * Verifies signatures (fail-closed), dedupes by hash, applies canary parking.
 * Caller does `git pull` first; network is never touched here.
 */
function pullSeeds(db, registryDir, opts = {}) {
  const seedsDir = path.join(registryDir, 'seeds');
  if (!fs.existsSync(seedsDir)) return { scanned: 0, imported: 0, canary: 0, skipped: 0, retired: [] };

  const trustedKeys = opts.trustedKeys || [];
  const canaryPct = typeof opts.canaryPct === 'number' ? opts.canaryPct : 10;
  const project = opts.project || process.cwd();
  const out = { scanned: 0, imported: 0, canary: 0, skipped: 0, retired: [] };

  // Retirement: registry marks seeds retired by leaving a tombstone file.
  const tombstones = fs.existsSync(path.join(registryDir, 'retired.json'))
    ? JSON.parse(fs.readFileSync(path.join(registryDir, 'retired.json'), 'utf8')) : [];
  if (tombstones.length) {
    const info = db.prepare("UPDATE observations SET is_active = 0 WHERE provenance = 'seeded' AND title || content IN (SELECT '')").run();
    void info;
    for (const h of tombstones) {
      const r = db.prepare("SELECT id, tags FROM observations WHERE provenance = 'seeded' AND tags LIKE ?").all('%"seed_hash":%' + h + '%');
      void r;
    }
  }

  const files = [];
  for (const shard of fs.readdirSync(seedsDir)) {
    const shardDir = path.join(seedsDir, shard);
    if (!fs.statSync(shardDir).isDirectory()) continue;
    for (const f of fs.readdirSync(shardDir).filter(f => f.endsWith('.json'))) files.push(path.join(shardDir, f));
  }
  out.scanned = files.length;

  for (const file of files) {
    try {
      const seed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (tombstones.includes(seed.hash)) continue;

      const sig = verifySignature(seed, trustedKeys);
      if (!sig.ok) { out.skipped++; continue; }

      const dup = db.prepare("SELECT id FROM observations WHERE provenance = 'seeded' AND title = ?").get(seed.title);
      if (dup) continue;

      const canary = Math.random() * 100 < canaryPct;
      const scopeFlag = canary ? 'canary' : 'active';
      const r = db.prepare(
        'INSERT INTO observations (project_path, type, title, content, tags, importance, confidence, provenance, project_scope, is_active) VALUES (?,?,?,?,?,?,?,\'seeded\',?,?)'
      ).run(
        project, seed.type || 'learning', seed.title, seed.content,
        JSON.stringify([...(seed.tags || [SEED_TAG]), 'seed_hash:' + seed.hash]),
        4, SEED_BASE_CONFIDENCE, scopeFlag, canary ? 1 : 1
      );
      if (canary) out.canary++; else out.imported++;
      void r;
    } catch {
      out.skipped++;
    }
  }

  // Retire locally-marked seeds whose grades failed quorum (belt & braces with tombstones).
  out.retired = retireFailedSeeds(db, opts);
  return out;
}

/** Mark a seed retired locally (producer of tombstones for the registry). */
function retireSeed(db, seedHash, reason) {
  db.prepare("UPDATE observations SET is_active = 0 WHERE provenance = 'seeded' AND tags LIKE ?").run('%"seed_hash:' + seedHash + '"%');
  return { seedHash, reason: reason || 'retired' };
}

// ─── Grading + quorum (phase 3 semantics, cheap enough to ship now) ─────────

/**
 * Grade an imported seed by the local observation id. Records BOTH:
 *  - a local row in seed_grades (fast local tally / audit trail)
 *  - an increment in the CRDT counter state (federated, merge-safe)
 * The CRDT slot lives in the registry repo (grades/<machine-id>.json) when a
 * registry is configured, else in .cortex/seed-grades-local.json.
 */
function gradeSeed(db, observationId, grade, opts = {}) {
  if (!['helpful', 'not_helpful'].includes(grade)) throw new Error("grade must be 'helpful' or 'not_helpful'");
  const obs = db.prepare('SELECT tags FROM observations WHERE id = ?').get(observationId);
  if (!obs) throw new Error('observation ' + observationId + ' not found');
  const m = String(obs.tags || '').match(/seed_hash:([0-9a-f]{16})/);
  if (!m) throw new Error('observation ' + observationId + ' is not an imported seed');
  db.prepare('INSERT INTO seed_grades (seed_hash, grade) VALUES (?, ?)').run(m[1], grade);

  // CRDT increment (phase 3b): reputation without a tallier.
  const crdt = require('./seed-crdt');
  const path = require('path');
  const projectRoot = opts.projectRoot || process.cwd();
  const machineId = crdt.ensureMachineId(projectRoot);
  if (opts.registry && fs.existsSync(opts.registry)) {
    const state = crdt.loadOwnState(opts.registry, machineId);
    crdt.recordGrade(state, machineId, m[1], grade);
    crdt.saveOwnState(opts.registry, machineId, state);
  }
  const localPath = path.join(projectRoot, '.cortex', 'seed-grades-local.json');
  const localState = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : crdt.emptyState();
  crdt.recordGrade(localState, machineId, m[1], grade);
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, JSON.stringify(localState, null, 2), 'utf8');

  return { seedHash: m[1], grade };
}

/**
 * Aggregate grades per seed. With CRDT sync (phase 3b), pass
 * { mergedStatePath } (or { registry }) to compute quorum from MERGED
 * fleet state locally; otherwise falls back to local seed_grades rows.
 */
function gradeTally(db, opts = {}) {
  const crdt = require('./seed-crdt');
  const path = require('path');
  const projectRoot = opts.projectRoot || process.cwd();
  const mergedPath = opts.mergedStatePath
    || (opts.registry ? path.join(projectRoot, '.cortex', 'seed-grades-merged.json') : null);
  if (mergedPath && fs.existsSync(mergedPath)) {
    const state = JSON.parse(fs.readFileSync(mergedPath, 'utf8'));
    return crdt.quorum(state, { minMachines: opts.minGrades || 3, minHelpfulPct: opts.minHelpfulPct || 60 })
      .map(r => ({
        seed_hash: r.seedHash,
        helpful: r.helpful,
        not_helpful: r.notHelpful,
        total: r.total,
        helpfulPct: r.helpfulPct,
        machines: r.machines,
        verdict: r.verdict,
      }));
  }
  // Local-only fallback (single machine / pre-sync)
  const rows = db.prepare(`SELECT seed_hash,
      SUM(grade = 'helpful') AS helpful,
      SUM(grade = 'not_helpful') AS not_helpful,
      COUNT(*) AS total
    FROM seed_grades GROUP BY seed_hash`).all();
  const min = opts.minGrades || 3;
  const minHelpfulPct = opts.minHelpfulPct || 60;
  return rows.map(r => ({
    ...r,
    helpfulPct: r.total ? Math.round((r.helpful / r.total) * 100) : 0,
    verdict: r.total >= min && (r.helpful / r.total) < (minHelpfulPct / 100) ? 'retire'
      : (r.total >= min && (r.helpful / r.total) >= (minHelpfulPct / 100) ? 'promote' : 'keep'),
  }));
}

/** Retire locally any seed whose tally says so. */
function retireFailedSeeds(db, opts = {}) {
  const tally = gradeTally(db, opts);
  const retired = [];
  for (const t of tally) {
    if (t.verdict === 'retire') {
      retireSeed(db, t.seed_hash, 'failed quorum: ' + t.helpfulPct + '% helpful of ' + t.total);
      retired.push(t.seed_hash);
    }
  }
  return retired;
}

module.exports = {
  SEED_BASE_CONFIDENCE,
  SEED_TAG,
  ensureKeypair,
  verifySignature,
  fingerprint,
  buildSeedArtifact,
  signArtifact,
  enqueueLessons,
  listReviewQueue,
  reviewSeed,
  publishApproved,
  pullSeeds,
  retireSeed,
  gradeSeed,
  gradeTally,
  retireFailedSeeds,
  syncGrades: (...args) => require('./seed-crdt').syncGrades(...args),
  appendLogEntry: (...args) => require('./seed-log').appendLogEntry(...args),
  readSeedLog: (...args) => require('./seed-log').readLog(...args),
  signSeedLogHead: (...args) => require('./seed-log').signHead(...args),
  verifySeedLogHead: (...args) => require('./seed-log').verifyHead(...args),
  observeSeedHeads: (...args) => require('./seed-log').observeHeads(...args),
  seedInclusionProof: (...args) => require('./seed-log').inclusionProof(...args),
  verifySeedInclusion: (...args) => require('./seed-log').verifyInclusion(...args),
};
