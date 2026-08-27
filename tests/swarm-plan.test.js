'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../src/core/db');
const { setApi } = require('../src/core/swarm');
const {
  readPlan,
  readLedger,
  readQaGates,
  importPlan,
  syncPlan,
  runPlan,
  planInfo,
  planHash,
} = require('../src/core/swarm-plan');

const PLAN = {
  schema_version: '1.0.0',
  title: 'Test Transformation',
  swarm: 'test-swarm',
  current_phase: 1,
  phases: [{
    id: 1,
    name: 'Phase One',
    status: 'pending',
    tasks: [
      { id: '1.1', phase: 1, status: 'pending', size: 'large', description: 'Do the thing', depends: [], acceptance: 'The thing works' },
      { id: '1.2', phase: 1, status: 'pending', size: 'medium', description: 'Do the other thing', depends: ['1.1'], acceptance: 'The other thing works' },
    ],
  }],
};

const CONTEXT_MD = '## Pending QA Gate Selection\n\nUser selected: reviewer (mandatory), test_engineer, hallucination_guard\n';

const savedMemories = [];

function makeFakeApi(failRole = null) {
  const fail = (engine) => {
    if (failRole && engine === failRole) {
      throw new Error('network timeout (simulated)');
    }
  };
  return {
    search: async () => ({ results: [] }),
    treeSearch: async (args) => { fail('treeSearch'); return { solution: `solution ${(args.problem || '').slice(0, 30)}` }; },
    selfConsistency: async (args) => { fail('selfConsistency'); return { answer: `tests ${(args.problem || '').slice(0, 30)}` }; },
    budgetForce: async (args) => { fail('budgetForce'); return { answer: `verify ${(args.problem || '').slice(0, 30)}` }; },
    warRoomSelfCheck: () => ({ diagnostics: { avgScore: 70, strengths: ['logic'], weaknesses: [] } }),
  };
}

let tmpProjects = [];
let dbs = [];

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  dbs.push(db);
  return db;
}

function makeProject(plan = PLAN, contextMd = CONTEXT_MD) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-bridge-'));
  tmpProjects.push(dir);
  fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.swarm', 'plan.json'), JSON.stringify(plan, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(path.join(dir, '.swarm', 'context.md'), contextMd, 'utf-8');
  fs.writeFileSync(path.join(dir, '.swarm', 'plan-ledger.jsonl'),
    JSON.stringify({
      plan_id: 'test-swarm-Test_Transformation',
      event_type: 'plan_created',
      source: 'initLedger',
      seq: 1,
      timestamp: new Date().toISOString(),
      plan_hash_before: '',
      plan_hash_after: planHash(plan),
      schema_version: '1.1.0',
      payload: { plan },
    }) + '\n', 'utf-8');
  return dir;
}

beforeEach(() => { tmpProjects = []; dbs = []; savedMemories.length = 0; });

afterEach(() => {
  setApi(null, null);
  for (const d of tmpProjects) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  for (const db of dbs) {
    try { db.close(); } catch { /* ignore */ }
  }
});

// ─── Reading the harness ──────────────────────────────────────────────

describe('swarm-plan: reading the harness', () => {
  it('reads the plan and parses QA gates from context.md', () => {
    const project = makeProject();
    const plan = readPlan(project);
    assert.equal(plan.title, 'Test Transformation');
    assert.deepEqual(readQaGates(project), ['reviewer', 'test_engineer', 'hallucination_guard']);
  });

  it('reads the ledger records', () => {
    const project = makeProject();
    const records = readLedger(project);
    assert.equal(records.length, 1);
    assert.equal(records[0].event_type, 'plan_created');
  });
});

// ─── Import ───────────────────────────────────────────────────────────

describe('swarm-plan: importPlan', () => {
  it('materializes plan tasks + QA gates as swarm tasks with chained deps', () => {
    const project = makeProject();
    const db = createTestDb();
    const res = importPlan(db, project);
    assert.equal(res.ok, true);
    assert.equal(res.gates.length, 3);

    const rows = db.prepare(
      `SELECT * FROM swarm_tasks WHERE project_path = ? AND plan_id = ? ORDER BY id`
    ).all(path.resolve(project), res.planId);

    // 2 primary + 6 gates (3 gates × 2 tasks)
    assert.equal(rows.length, 8);

    const t1 = db.prepare(`SELECT * FROM swarm_tasks WHERE plan_task_id = '1.1'`).get();
    const t2 = db.prepare(`SELECT * FROM swarm_tasks WHERE plan_task_id = '1.2'`).get();
    assert.equal(t1.agent_role, 'coder');
    assert.equal(t1.acceptance, 'The thing works');
    assert.equal(t1.task_size, 'large');
    assert.deepEqual(JSON.parse(t1.dependency_ids), []);
    assert.deepEqual(JSON.parse(t2.dependency_ids), [t1.id], 'plan depends mapped to task ids');

    const gate = db.prepare(`SELECT * FROM swarm_tasks WHERE plan_task_id = '1.1:gate:reviewer'`).get();
    assert.equal(gate.agent_role, 'reviewer');
    assert.deepEqual(JSON.parse(gate.dependency_ids), [t1.id], 'gate depends on its primary task');

    const testGate = db.prepare(`SELECT * FROM swarm_tasks WHERE plan_task_id = '1.1:gate:test_engineer'`).get();
    assert.equal(testGate.agent_role, 'tester');
    const guardGate = db.prepare(`SELECT * FROM swarm_tasks WHERE plan_task_id = '1.1:gate:hallucination_guard'`).get();
    assert.equal(guardGate.agent_role, 'verifier');
  });

  it('is idempotent and carries over completed statuses', () => {
    const project = makeProject();
    const db = createTestDb();
    const first = importPlan(db, project);
    assert.equal(first.imported, 2);

    // Mark 1.1 completed in the engine, then re-import → no duplicates.
    db.prepare(`UPDATE swarm_tasks SET status = 'completed' WHERE plan_task_id = '1.1'`).run();
    const second = importPlan(db, project);
    assert.equal(second.imported, 0, 're-import must not create rows');
    assert.equal(second.tasks, first.tasks);
  });

  it('imports a plan task that is already completed as completed', () => {
    const plan = JSON.parse(JSON.stringify(PLAN));
    plan.phases[0].tasks[0].status = 'completed';
    const project = makeProject(plan);
    const db = createTestDb();
    importPlan(db, project);
    const t1 = db.prepare(`SELECT * FROM swarm_tasks WHERE plan_task_id = '1.1'`).get();
    assert.equal(t1.status, 'completed');
  });
});

// ─── Execute → sync round-trip ────────────────────────────────────────

describe('swarm-plan: runPlan round-trip', () => {
  it('executes the imported goal and writes results back to plan.json + ledger', async () => {
    const project = makeProject();
    const db = createTestDb();
    setApi(makeFakeApi(), async (m) => { savedMemories.push(m); return { id: savedMemories.length }; });

    const out = await runPlan(db, project);
    assert.equal(out.ok, true);
    assert.equal(out.execution.meta.failed, 0);
    assert.equal(out.execution.meta.completed, 8, '2 primaries + 6 gates all executed');
    assert.ok(out.sync.synced);

    // plan.json now reflects engine state.
    const updated = readPlan(project);
    assert.equal(updated.phases[0].tasks[0].status, 'completed');
    assert.equal(updated.phases[0].tasks[1].status, 'completed');
    assert.equal(updated.phases[0].status, 'completed');

    // ledger gained task_status_changed + snapshot events.
    const records = readLedger(project);
    const types = records.map(r => r.event_type);
    assert.ok(types.includes('task_status_changed'));
    assert.ok(types.includes('snapshot'));
    const last = records[records.length - 1];
    assert.ok(last.plan_hash_before && last.plan_hash_after, 'hashes present');
    assert.equal(last.payload.plan.phases[0].status, 'completed');
  });

  it('propagates a failing task (and gate) into the plan as failed', async () => {
    // Make the coder engine always fail transiently → retries exhaust → replan → escalate.
    const project = makeProject();
    const db = createTestDb();
    setApi(makeFakeApi('treeSearch'), async (m) => { savedMemories.push(m); return { id: savedMemories.length }; });

    const out = await runPlan(db, project, { retryPolicy: { maxRetries: 1, maxReplans: 0, baseDelayMs: 5, backoffFactor: 1, maxDelayMs: 50 } });
    assert.equal(out.ok, true);
    assert.ok(out.execution.meta.escalated >= 1);

    const updated = readPlan(project);
    const t1 = updated.phases[0].tasks.find(t => t.id === '1.1');
    assert.equal(t1.status, 'failed');
    // Reviewer gate also failed (tree-search engine) → phase failed.
    assert.equal(updated.phases[0].status, 'failed');
  });
});

// ─── Sync ─────────────────────────────────────────────────────────────

describe('swarm-plan: syncPlan + planInfo', () => {
  it('does not write ledger events when nothing changed', () => {
    // Phase already in_progress with pending tasks = consistent engine state.
    const plan = JSON.parse(JSON.stringify(PLAN));
    plan.phases[0].status = 'in_progress';
    const project = makeProject(plan);
    const db = createTestDb();
    importPlan(db, project);
    const res = syncPlan(db, project);
    assert.equal(res.synced, false);
    assert.equal(res.changes.length, 0);
    assert.equal(readLedger(project).length, 1);
  });

  it('planInfo summarizes the plan and import state', () => {
    const project = makeProject();
    const db = createTestDb();
    const info = planInfo(db, project);
    assert.equal(info.ok, true);
    assert.equal(info.title, 'Test Transformation');
    assert.equal(info.counts.total, 2);
    assert.equal(info.qaGates.length, 3);
    assert.equal(info.importedTasks, 0);

    importPlan(db, project);
    const after = planInfo(db, project);
    assert.equal(after.importedTasks, 8);
  });
});
