/**
 * seed-crdt.js — Federated grade counters for lesson seeds (phase 3b).
 *
 * Reputation without a tallier: grades are stored as per-machine counter
 * slots (`seed_hash → grade → machine_id → count`) and exchanged as state
 * files on a git branch (`refs/heads/seed-grades`). The merge is a grow-only
 * map of G-Counters: element-wise max per machine slot. Commutative,
 * associative, idempotent — machines can sync in any order, any number of
 * times, and every replica converges to the same counts. No machine or hub
 * ever tallies votes for anyone else; quorum is computed locally from merged
 * state.
 *
 * Privacy: what leaves a machine is its own anonymous counter increments
 * (machine_id is a random per-install UUID, NOT a hostname, user, or repo).
 * Grade *content* never travels — only increments.
 *
 * Transport: a git branch of the seed registry repo holding one state file
 * per machine (`grades/<machine_id>.json`). Exchange = `git fetch` + merge
 * + `git push` of that branch. Cheap, conflict-free (one file per writer),
 * and uses the exact same registry repo as the seeds themselves.
 *
 * @module core/seed-crdt
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Machine identity ────────────────────────────────────────────────────────

/**
 * Stable anonymous machine id. Random UUID on first use, persisted in
 * .cortex/machine-id. Deliberately NOT derived from hostname/user/repo —
 * the id must never be linkable back to a person or organization.
 */
function ensureMachineId(projectRoot) {
  const dir = path.join(projectRoot || process.cwd(), '.cortex');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'machine-id');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const id = crypto.randomUUID();
  fs.writeFileSync(file, id, { mode: 0o600 });
  return id;
}

// ─── CRDT: grow-only map of G-Counters ──────────────────────────────────────

function emptyState() {
  return { v: 1, counters: {} }; // counters[seedHash][grade][machineId] = count
}

/**
 * Record one local grade by incrementing this machine's own slot.
 * Only ever touches counters[seed][grade][MY_MACHINE_ID] — that's what makes
 * concurrent replicas merge cleanly (nobody else writes your slot).
 */
function recordGrade(state, machineId, seedHash, grade) {
  if (!['helpful', 'not_helpful'].includes(grade)) throw new Error("grade must be 'helpful' or 'not_helpful'");
  if (!state.counters[seedHash]) state.counters[seedHash] = {};
  if (!state.counters[seedHash][grade]) state.counters[seedHash][grade] = {};
  const slot = state.counters[seedHash][grade][machineId] || 0;
  state.counters[seedHash][grade][machineId] = slot + 1;
  return state;
}

/**
 * Merge two states: element-wise max per (seed, grade, machine) slot.
 * Pure function — returns a NEW state, never mutates inputs.
 *
 * max() (not sum) is what makes this a G-Counter CRDT: replicating the same
 * state twice is harmless (idempotent), and receiving states in any order
 * converges (commutative + associative).
 */
function mergeStates(a, b) {
  const out = { v: 1, counters: {} };
  const seeds = new Set([...Object.keys(a.counters || {}), ...Object.keys(b.counters || {})]);
  for (const seed of seeds) {
    out.counters[seed] = {};
    const grades = new Set([
      ...Object.keys(a.counters[seed] || {}),
      ...Object.keys(b.counters[seed] || {}),
    ]);
    for (const grade of grades) {
      out.counters[seed][grade] = {};
      const machines = new Set([
        ...Object.keys((a.counters[seed] || {})[grade] || {}),
        ...Object.keys((b.counters[seed] || {})[grade] || {}),
      ]);
      for (const machine of machines) {
        out.counters[seed][grade][machine] = Math.max(
          ((a.counters[seed] || {})[grade] || {})[machine] || 0,
          ((b.counters[seed] || {})[grade] || {})[machine] || 0
        );
      }
    }
  }
  return out;
}

/** Merge a list of states (fold). */
function mergeAll(states) {
  return (states || []).reduce((acc, s) => mergeStates(acc, s), emptyState());
}

/**
 * Aggregate counts per (seed, grade): sum over machine slots.
 * This is the G-Counter value read, not a vote tally by anyone.
 */
function aggregate(state) {
  const out = {}; // seedHash -> { helpful, not_helpful, machines }
  for (const [seed, grades] of Object.entries(state.counters || {})) {
    out[seed] = { helpful: 0, not_helpful: 0, machines: new Set() };
    for (const [grade, machines] of Object.entries(grades)) {
      for (const [machine, count] of Object.entries(machines)) {
        if (grade === 'helpful' || grade === 'not_helpful') {
          out[seed][grade] += count;
          out[seed].machines.add(machine);
        }
      }
    }
  }
  // Serialize the Set for JSON-friendliness
  for (const s of Object.values(out)) s.machines = s.machines.size;
  return out;
}

/**
 * Local quorum computation from MERGED state — the heart of the design.
 * Same thresholds as the single-machine gradeTally, but computed over every
 * machine this replica has ever heard from.
 */
function quorum(state, opts = {}) {
  const minMachines = opts.minMachines || 3;
  const minHelpfulPct = opts.minHelpfulPct || 60;
  const agg = aggregate(state);
  const rows = [];
  for (const [seedHash, a] of Object.entries(agg)) {
    const total = a.helpful + a.not_helpful;
    const helpfulPct = total ? Math.round((a.helpful / total) * 100) : 0;
    let verdict = 'keep';
    if (a.machines >= minMachines) {
      if (helpfulPct < minHelpfulPct) verdict = 'retire';
      else verdict = 'promote';
    }
    rows.push({ seedHash, helpful: a.helpful, notHelpful: a.not_helpful, total, helpfulPct, machines: a.machines, verdict });
  }
  return rows;
}

// ─── State persistence + git-branch transport ───────────────────────────────

function statePath(registryDir, machineId) {
  return path.join(registryDir, 'grades', machineId + '.json');
}

/** Read this machine's own state file (its CRDT replica). */
function loadOwnState(registryDir, machineId) {
  const p = statePath(registryDir, machineId);
  if (!fs.existsSync(p)) return emptyState();
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return emptyState(); }
}

function saveOwnState(registryDir, machineId, state) {
  const p = statePath(registryDir, machineId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf8');
  return p;
}

/**
 * Full exchange cycle over the registry repo's grades/ directory:
 *   1. read every replica file present (post `git fetch` by the caller)
 *   2. merge all states with our own
 *   3. recompute our slot values from merged state (absorbs stragglers)
 *   4. write our replica file back (caller `git push`es)
 *
 * The caller performs git pull/push — AC never touches the network, same as
 * publish/pull for seeds.
 */
function syncGrades(db, registryDir, opts = {}) {
  const projectRoot = opts.projectRoot || process.cwd();
  const machineId = ensureMachineId(projectRoot);
  const gradesDir = path.join(registryDir, 'grades');

  // 1. Collect all replicas currently in the repo
  const states = [];
  if (fs.existsSync(gradesDir)) {
    for (const f of fs.readdirSync(gradesDir).filter(f => f.endsWith('.json'))) {
      try { states.push(JSON.parse(fs.readFileSync(path.join(gradesDir, f), 'utf8'))); } catch { /* skip corrupt */ }
    }
  }

  // 2. Merge everything (including our own file if present)
  const own = loadOwnState(registryDir, machineId);
  const merged = mergeAll([...states, own]);

  // 3. Our slot, recomputed from merged state (idempotent absorption)
  const myMerged = emptyState();
  for (const [seed, grades] of Object.entries(merged.counters || {})) {
    for (const [grade, machines] of Object.entries(grades)) {
      if (machines[machineId] != null) {
        if (!myMerged.counters[seed]) myMerged.counters[seed] = {};
        if (!myMerged.counters[seed][grade]) myMerged.counters[seed][grade] = {};
        myMerged.counters[seed][grade][machineId] = machines[machineId];
      }
    }
  }

  // 4. Persist our replica + also cache merged state locally for fast tally
  saveOwnState(registryDir, machineId, myMerged);
  const cachePath = path.join(projectRoot, '.cortex', 'seed-grades-merged.json');
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(merged, null, 2), 'utf8');

  // Distinct machines actually present in merged state (accurate even when
  // our own replica file was already among the files read).
  const distinctMachines = new Set();
  for (const grades of Object.values(merged.counters || {})) {
    for (const machines of Object.values(grades)) {
      for (const machine of Object.keys(machines)) distinctMachines.add(machine);
    }
  }

  const q = quorum(merged, opts);
  const retire = opts.applyRetire !== false;
  const retired = [];
  if (retire) {
    const seedsCore = require('./seeds');
    for (const row of q) {
      if (row.verdict === 'retire') {
        seedsCore.retireSeed(db, row.seedHash, 'CRDT quorum: ' + row.helpfulPct + '% helpful across ' + row.machines + ' machines');
        retired.push(row.seedHash);
      }
    }
  }

  return {
    machineId,
    replicas: distinctMachines.size,
    seedsTracked: Object.keys(merged.counters).length,
    quorum: q,
    retired,
    mergedStatePath: cachePath,
  };
}

module.exports = {
  ensureMachineId,
  emptyState,
  recordGrade,
  mergeStates,
  mergeAll,
  aggregate,
  quorum,
  loadOwnState,
  saveOwnState,
  syncGrades,
};
