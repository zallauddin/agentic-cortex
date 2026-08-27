'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../src/core/db');
const {
  PERSONAS,
  DEFAULT_PIPELINE,
  RETRY_POLICY,
  setApi,
  decomposeGoal,
  getNextTask,
  startTask,
  completeTask,
  failTask,
  retryNow,
  claimTask,
  replanSubgraph,
  replanGoal,
  listEscalations,
  classifyTaskFailure,
  getGoalTasks,
  getGoalProgress,
  executeTask,
  executePipeline,
  createJob,
  getJob,
  listJobs,
  cancelJob,
  runJob,
} = require('../src/core/swarm');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-worker.js');
let tmpDirs = [];

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-worker-'));
  tmpDirs.push(dir);
  return dir;
}

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  return db;
}

const FAST_POLICY = { maxRetries: 2, maxReplans: 1, baseDelayMs: 5, backoffFactor: 1, maxDelayMs: 50 };

/**
 * Fake reasoning-API injected via swarm.setApi. `failures` maps an engine
 * name to the number of times it should throw before succeeding.
 */
function makeFakeApi(failures = {}) {
  const counters = {};
  const failOnce = (engine) => {
    counters[engine] = (counters[engine] || 0) + 1;
    if (counters[engine] <= (failures[engine] || 0)) {
      throw new Error(`network timeout (simulated transient failure ${counters[engine]})`);
    }
    return undefined;
  };
  return {
    search: async () => ({ results: [] }),
    treeSearch: async (args) => {
      failOnce('treeSearch');
      return { solution: `solution for: ${(args.problem || '').slice(0, 40)}` };
    },
    budgetForce: async (args) => {
      failOnce('budgetForce');
      return { answer: `plan for: ${(args.problem || '').slice(0, 40)}` };
    },
    selfConsistency: async (args) => {
      failOnce('selfConsistency');
      return { answer: `tests for: ${(args.problem || '').slice(0, 40)}` };
    },
    reasonAll: async (topic) => ({ insights: [{ text: `insight about ${topic}` }] }),
    warRoomSelfCheck: () => ({ diagnostics: { avgScore: 72, strengths: ['logic'], weaknesses: ['memory'] } }),
  };
}

const singleStepPipeline = [
  { role: 'analyzer', action: 'analyze', dependsOn: [], description: 'Analyze' },
];

const linearPipeline = [
  { role: 'analyzer', action: 'analyze', dependsOn: [], description: 'Analyze' },
  { role: 'coder', action: 'implement', dependsOn: ['analyzer'], description: 'Implement' },
  { role: 'tester', action: 'write-tests', dependsOn: ['coder'], description: 'Test' },
  { role: 'verifier', action: 'verify', dependsOn: ['tester'], description: 'Verify' },
];

const savedMemories = [];

/**
 * Fake API that records engine call order and measures max in-flight
 * concurrency, so tests can prove bounded parallelism.
 */
function makeTrackingApi() {
  let inFlight = 0;
  let maxInFlight = 0;
  const order = [];
  const api = {
    search: async () => ({ results: [] }),
    treeSearch: async (args) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push((args.problem || '').match(/You are the ([A-Z]+)/)?.[1] || 'task');
      await sleep(15);
      inFlight--;
      return { solution: 'ok' };
    },
    budgetForce: async (args) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push((args.problem || '').match(/You are the ([A-Z]+)/)?.[1] || 'task');
      await sleep(15);
      inFlight--;
      return { answer: 'ok' };
    },
    selfConsistency: async (args) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push((args.problem || '').match(/You are the ([A-Z]+)/)?.[1] || 'task');
      await sleep(15);
      inFlight--;
      return { answer: 'ok' };
    },
    warRoomSelfCheck: () => ({ diagnostics: { avgScore: 70, strengths: ['logic'], weaknesses: [] } }),
  };
  return { api, stats: () => ({ maxInFlight, order: order.slice() }) };
}

const fourIndependent = [
  { role: 'analyzer', action: 'analyze', dependsOn: [], description: 'A1' },
  { role: 'analyzer', action: 'analyze', dependsOn: [], description: 'A2' },
  { role: 'analyzer', action: 'analyze', dependsOn: [], description: 'A3' },
  { role: 'analyzer', action: 'analyze', dependsOn: [], description: 'A4' },
];

async function setup(failures, pipeline) {
  const db = createTestDb();
  savedMemories.length = 0;
  setApi(makeFakeApi(failures), async (m) => { savedMemories.push(m); return { id: savedMemories.length }; });
  const tasks = decomposeGoal(db, 'shipping feature', { project: 'proj', pipeline: pipeline || linearPipeline });
  return { db, tasks };
}

afterEach(() => {
  setApi(null, null);
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

// ─── Decompose / dependency graph ─────────────────────────────────────

describe('Swarm: decompose + dependency graph', () => {
  it('creates DEFAULT_PIPELINE tasks with role chain', async () => {
    const { db, tasks } = await setup(undefined, DEFAULT_PIPELINE);
    assert.equal(tasks.length, DEFAULT_PIPELINE.length);
    assert.equal(tasks[0].role, 'analyzer');
    assert.deepEqual(tasks[0].dependsOn, []);
    assert.equal(tasks[1].role, 'planner');
    assert.deepEqual(tasks[1].dependsOn, ['analyzer']);
    const rows = getGoalTasks(db, 'shipping feature', { project: 'proj' });
    assert.equal(rows[0].agent_role, 'analyzer');
    assert.equal(rows[0].attempt, 1);
    assert.equal(rows[0].max_retries, RETRY_POLICY.maxRetries);
  });

  it('getNextTask returns analyzer first, then coder only after analyzer completes', async () => {
    const { db } = await setup();
    const a = getNextTask(db, 'analyzer', { project: 'proj' });
    assert.equal(a.agent_role, 'analyzer');
    assert.equal(getNextTask(db, 'coder', { project: 'proj' }), null);

    completeTask(db, a.id, 'analysis done');
    const c = getNextTask(db, 'coder', { project: 'proj' });
    assert.equal(c.agent_role, 'coder');
  });
});

// ─── Failure classification ───────────────────────────────────────────

describe('Swarm: failure classification', () => {
  it('treats transient failures as retryable', () => {
    for (const msg of ['request timed out', 'ECONNREFUSED connection', 'unexpected hiccup']) {
      const c = classifyTaskFailure(msg);
      assert.equal(c.retryable, true, msg);
    }
  });

  it('treats deterministic failures as non-retryable', () => {
    for (const msg of ['not authorized: permission denied', 'syntax error in command', 'treeSearch API not available']) {
      const c = classifyTaskFailure(msg);
      assert.equal(c.retryable, false, msg);
    }
  });
});

// ─── failTask retry with backoff ──────────────────────────────────────

describe('Swarm: failTask retry/backoff', () => {
  it('schedules a retry with backoff for transient failures, then fails after maxRetries', async () => {
    const { db } = await setup();
    const a = getNextTask(db, 'analyzer', { project: 'proj' });

    const r1 = failTask(db, a.id, 'operation took too long', { retryPolicy: FAST_POLICY });
    assert.equal(r1.retryScheduled, true);
    assert.equal(r1.status, 'pending');
    assert.equal(r1.retryCount, 1);
    assert.ok(r1.nextRetryAt > new Date().toISOString());

    const row1 = db.prepare(`SELECT * FROM swarm_tasks WHERE id = ?`).get(a.id);
    assert.equal(row1.status, 'pending');
    assert.equal(row1.retry_count, 1);
    assert.equal(row1.failure_class, 'timeout');
    assert.ok(row1.next_retry_at);

    failTask(db, a.id, 'operation took too long again', { retryPolicy: FAST_POLICY });
    const row2 = db.prepare(`SELECT * FROM swarm_tasks WHERE id = ?`).get(a.id);
    assert.equal(row2.status, 'pending');
    assert.equal(row2.retry_count, 2);

    const r3 = failTask(db, a.id, 'operation took too long thrice', { retryPolicy: FAST_POLICY });
    assert.equal(r3.retryScheduled, false);
    assert.equal(r3.status, 'failed');
    const row3 = db.prepare(`SELECT * FROM swarm_tasks WHERE id = ?`).get(a.id);
    assert.equal(row3.status, 'failed');
    assert.equal(row3.next_retry_at, null);
    assert.equal(row3.failure_class, 'timeout');
  });

  it('marks a permanent (human) failure as failed immediately', async () => {
    const { db } = await setup();
    const a = getNextTask(db, 'analyzer', { project: 'proj' });
    const r = failTask(db, a.id, 'canceled by operator', { permanent: true });
    assert.equal(r.status, 'failed');
    assert.equal(r.retryScheduled, false);
    const row = db.prepare(`SELECT * FROM swarm_tasks WHERE id = ?`).get(a.id);
    assert.equal(row.status, 'failed');
  });

  it('does not hand out a task still in its backoff window', async () => {
    const { db } = await setup();
    const a = getNextTask(db, 'analyzer', { project: 'proj' });
    failTask(db, a.id, 'timed out', { retryPolicy: { ...FAST_POLICY, baseDelayMs: 60000 } });
    assert.equal(getNextTask(db, 'analyzer', { project: 'proj' }), null);
    retryNow(db, a.id);
    const again = getNextTask(db, 'analyzer', { project: 'proj' });
    assert.equal(again.id, a.id);
  });
});

// ─── Replanning the affected subgraph ─────────────────────────────────

describe('Swarm: replan subgraph', () => {
  it('replaces the failed task and its pending dependents with fresh attempts', async () => {
    const { db, tasks } = await setup();
    // Complete analyzer + coder, fail tester (3rd task).
    completeTask(db, tasks[0].id, 'ok');
    completeTask(db, tasks[1].id, 'ok');
    failTask(db, tasks[2].id, 'timed out 3x', { permanent: true });

    const created = await replanSubgraph(db, tasks[2].id);
    assert.equal(created.length, 2); // tester + verifier (orchestrator not in this pipeline)

    const tester = db.prepare(`SELECT * FROM swarm_tasks WHERE id = ?`).get(created[0].id);
    assert.equal(tester.agent_role, 'tester');
    assert.equal(tester.status, 'pending');
    assert.equal(tester.attempt, 2);
    assert.equal(tester.retry_of, tasks[2].id);
    assert.deepEqual(JSON.parse(tester.dependency_ids), [tasks[1].id]); // still depends on completed coder

    const verifier = db.prepare(`SELECT * FROM swarm_tasks WHERE id = ?`).get(created[1].id);
    assert.deepEqual(JSON.parse(verifier.dependency_ids), [created[0].id]); // remapped to new tester

    // Originals are stale, completed work untouched.
    assert.equal(db.prepare(`SELECT status FROM swarm_tasks WHERE id = ?`).get(tasks[2].id).status, 'stale');
    assert.equal(db.prepare(`SELECT status FROM swarm_tasks WHERE id = ?`).get(tasks[0].id).status, 'completed');
    assert.equal(db.prepare(`SELECT status FROM swarm_tasks WHERE id = ?`).get(tasks[1].id).status, 'completed');
  });

  it('escalates when the attempt budget is exhausted', async () => {
    const { db, tasks } = await setup(undefined, singleStepPipeline);
    failTask(db, tasks[0].id, 'operation took too long', { permanent: true });

    // Attempt 2 (first replan)
    const c1 = await replanSubgraph(db, tasks[0].id);
    assert.equal(c1.length, 1);
    assert.equal(c1[0].attempt, 2);
    assert.equal(c1[0].retryOf, tasks[0].id);

    // Attempt 2 also fails → attempt budget (1 + maxReplans = 2) reached → escalate.
    failTask(db, c1[0].id, 'operation took too long', { permanent: true });
    const c2 = await replanSubgraph(db, c1[0].id);
    assert.equal(c2.length, 0);

    const row = db.prepare(`SELECT * FROM swarm_tasks WHERE id = ?`).get(c1[0].id);
    assert.equal(row.escalated, 1);
    assert.ok(savedMemories.some(m => m.type === 'error' && m.tags.includes('escalation')));
  });
});

// ─── Closed pipeline loop ─────────────────────────────────────────────

describe('Swarm: closed executePipeline loop', () => {
  it('retries transient failures with backoff and completes', async () => {
    const { db } = await setup({ treeSearch: 2 }, singleStepPipeline);
    const out = await executePipeline(db, 'shipping feature', { project: 'proj', retryPolicy: FAST_POLICY });
    assert.equal(out.meta.completed, 1);
    assert.equal(out.meta.failed, 0);
    assert.ok(out.meta.retryScheduled >= 2);
    const analyzer = getGoalTasks(db, 'shipping feature', { project: 'proj' })[0];
    assert.equal(analyzer.status, 'completed');
  });

  it('replans exhausted failures, then escalates, and terminates', async () => {
    // treeSearch always throws a transient error → every attempt exhausts retries.
    const { db } = await setup({ treeSearch: Infinity }, singleStepPipeline);
    const out = await executePipeline(db, 'shipping feature', { project: 'proj', retryPolicy: FAST_POLICY });
    assert.ok(out.meta.retryScheduled > 0, 'should have scheduled retries');
    assert.ok(out.meta.replanned >= 1, 'should have replanned');
    assert.ok(out.meta.escalated >= 1, 'should have escalated');
    assert.ok(out.meta.stillPending === 0, 'no runnable work should remain');
    assert.ok(out.results.length > 0);

    // An escalation memory + failure lesson were recorded.
    assert.ok(savedMemories.some(m => m.type === 'error' && m.tags.includes('escalation')));
    const lessons = db.prepare(`SELECT * FROM failure_lessons WHERE project_path = 'proj'`).all();
    assert.ok(lessons.length > 0, 'failure lesson recorded');

    const escalations = listEscalations(db, 'shipping feature', { project: 'proj' });
    assert.ok(escalations.length >= 1);
    assert.equal(escalations[0].failureClass, 'network');
  });

  it('stays stable when a goal has no runnable tasks', async () => {
    const { db } = await setup();
    const out = await executePipeline(db, 'no-such-goal', { project: 'proj' });
    assert.equal(out.results.length, 0);
    assert.equal(out.meta.rounds, 1);
  });

  it('getGoalProgress reports failure + escalation info', async () => {
    const { db, tasks } = await setup();
    completeTask(db, tasks[0].id, 'ok');
    failTask(db, tasks[1].id, 'not authorized', { permanent: true });
    const progress = getGoalProgress(db, 'shipping feature', { project: 'proj' });
    assert.equal(progress.escalated, 0);
    const failedRow = progress.results.find(r => r.status === 'failed');
    assert.equal(failedRow.failure_class, 'auth');
    assert.ok(failedRow.last_error.includes('not authorized'));
  });
});

// ─── Parallel executor (bounded worker pool) ─────────────────────────

describe('Swarm: parallel executor', () => {
  it('runs independent branches concurrently, bounded by the pool size', async () => {
    const db = createTestDb();
    const { api, stats } = makeTrackingApi();
    savedMemories.length = 0;
    setApi(api, async (m) => { savedMemories.push(m); return { id: 1 }; });
    decomposeGoal(db, 'shipping feature', { project: 'proj', pipeline: fourIndependent });

    const out = await executePipeline(db, 'shipping feature', { project: 'proj', concurrency: 2 });

    assert.equal(out.meta.completed, 4);
    assert.ok(stats().maxInFlight > 1, `expected real parallelism, got ${stats().maxInFlight}`);
    assert.equal(stats().maxInFlight, 2, 'must not exceed the concurrency bound');
  });

  it('still respects DAG dependencies while running in parallel', async () => {
    const db = createTestDb();
    const { api, stats } = makeTrackingApi();
    savedMemories.length = 0;
    setApi(api, async (m) => { savedMemories.push(m); return { id: 1 }; });
    decomposeGoal(db, 'shipping feature', { project: 'proj', pipeline: linearPipeline });

    const out = await executePipeline(db, 'shipping feature', { project: 'proj', concurrency: 4 });

    assert.equal(out.meta.completed, 4);
    const order = stats().order;
    const first = (role) => order.indexOf(role);
    assert.ok(first('ANALYZER') !== -1 && first('CODER') !== -1 && first('TESTER') !== -1 && first('VERIFIER') !== -1);
    assert.ok(first('ANALYZER') < first('CODER'), 'coder must wait for analyzer');
    assert.ok(first('CODER') < first('TESTER'), 'tester must wait for coder');
    assert.ok(first('TESTER') < first('VERIFIER'), 'verifier must wait for tester');
  });

  it('dryRun previews one pass without claiming or mutating tasks', async () => {
    const db = createTestDb();
    const { api } = makeTrackingApi();
    setApi(api, async (m) => { savedMemories.push(m); return { id: 1 }; });
    decomposeGoal(db, 'shipping feature', { project: 'proj', pipeline: fourIndependent });

    const out = await executePipeline(db, 'shipping feature', { project: 'proj', concurrency: 2, dryRun: true });

    assert.equal(out.results.length, 4);
    assert.equal(out.meta.rounds, 1);
    const rows = db.prepare(`SELECT status FROM swarm_tasks WHERE project_path = 'proj' AND goal = 'shipping feature'`).all();
    assert.ok(rows.every(r => r.status === 'pending'), 'dry run must leave every task pending');
    assert.ok(out.results.every(r => r.dryRun === true));
  });

  it('claimTask is atomic — a task can only be claimed once', async () => {
    const { db, tasks } = await setup(undefined, singleStepPipeline);
    assert.equal(claimTask(db, tasks[0].id), true);
    assert.equal(claimTask(db, tasks[0].id), false);
    const row = db.prepare(`SELECT status FROM swarm_tasks WHERE id = ?`).get(tasks[0].id);
    assert.equal(row.status, 'running');
  });
});

// ─── Worker mode (real agent subprocesses) ───────────────────────────

describe('Swarm: worker mode', () => {
  it('runs the coder as a real subprocess that edits files', async () => {
    const project = tmpProject();
    const db = createTestDb();
    savedMemories.length = 0;
    setApi(makeFakeApi(), async (m) => { savedMemories.push(m); return { id: 1 }; });
    decomposeGoal(db, 'shipping feature', { project, pipeline: [
      { role: 'coder', action: 'implement', dependsOn: [], description: 'Implement' },
    ] });

    const out = await executePipeline(db, 'shipping feature', {
      project,
      workerMode: 'process',
      worker: { command: process.execPath, args: [FIXTURE, 'coder-marker.txt', 'ok'], timeoutMs: 10000 },
    });

    assert.equal(out.meta.completed, 1);
    assert.ok(fs.existsSync(path.join(project, 'coder-marker.txt')), 'coder actually wrote a file in the repo');
    const marker = JSON.parse(fs.readFileSync(path.join(project, 'coder-marker.txt'), 'utf-8'));
    assert.match(marker.prompt, /EDIT REAL FILES/, 'worker received the real-action persona instruction');
    const row = getGoalTasks(db, 'shipping feature', { project })[0];
    assert.match(row.result_summary, /FAKE WORKER OK/);
  });

  it('a failing worker feeds the retry/replan/escalate loop', async () => {
    const project = tmpProject();
    const db = createTestDb();
    savedMemories.length = 0;
    setApi(makeFakeApi(), async (m) => { savedMemories.push(m); return { id: 1 }; });
    decomposeGoal(db, 'shipping feature', { project, pipeline: singleStepPipeline });

    const out = await executePipeline(db, 'shipping feature', {
      project,
      workerMode: 'process',
      worker: { command: process.execPath, args: [FIXTURE, 'fail-marker.txt', 'fail'], timeoutMs: 10000 },
      retryPolicy: FAST_POLICY,
    });

    assert.ok(out.meta.retryScheduled > 0, 'worker failures should be retried with backoff');
    assert.ok(out.meta.replanned >= 1, 'exhausted worker should be replanned');
    assert.ok(out.meta.escalated >= 1, 'past the budget it should escalate');
    assert.ok(fs.existsSync(path.join(project, 'fail-marker.txt')), 'worker ran for real');
  });

  it('worker dryRun returns the planned command without spawning', async () => {
    const project = tmpProject();
    const db = createTestDb();
    setApi(makeFakeApi(), async () => ({ id: 1 }));
    decomposeGoal(db, 'shipping feature', { project, pipeline: singleStepPipeline });

    const out = await executePipeline(db, 'shipping feature', {
      project,
      workerMode: 'process',
      worker: { command: process.execPath, args: [FIXTURE, 'dry.txt', 'ok'], timeoutMs: 10000 },
      dryRun: true,
    });

    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].dryRun, true);
    assert.ok(out.results[0].worker, 'dry run exposes the planned worker command');
    assert.equal(out.results[0].worker.command, process.execPath);
    assert.ok(!fs.existsSync(path.join(project, 'dry.txt')), 'dry run must not spawn');
    const rows = getGoalTasks(db, 'shipping feature', { project });
    assert.ok(rows.every(r => r.status === 'pending'), 'dry run leaves tasks pending');
  });

  it('workerRoles restricts which roles use the worker', async () => {
    const project = tmpProject();
    const db = createTestDb();
    setApi(makeFakeApi(), async () => ({ id: 1 }));
    decomposeGoal(db, 'shipping feature', { project, pipeline: [
      { role: 'analyzer', action: 'analyze', dependsOn: [], description: 'a' },
      { role: 'coder', action: 'implement', dependsOn: ['analyzer'], description: 'c' },
    ] });

    const out = await executePipeline(db, 'shipping feature', {
      project,
      workerMode: 'process',
      workerRoles: ['coder'],
      worker: { command: process.execPath, args: [FIXTURE, 'coder-marker.txt', 'ok'], timeoutMs: 10000 },
    });

    const analyzer = out.results.find(r => r.role === 'analyzer');
    const coder = out.results.find(r => r.role === 'coder');
    assert.ok(analyzer && analyzer.worker === null, 'analyzer used the in-process engine');
    assert.ok(coder && coder.worker && coder.worker.framework === 'custom', 'coder used the worker');
    assert.ok(fs.existsSync(path.join(project, 'coder-marker.txt')));
  });
});

// ─── Persistent job queue ─────────────────────────────────────────────

describe('Swarm: persistent job queue', () => {
  it('createJob enqueues a job with its policy snapshot', async () => {
    const { db } = await setup(undefined, singleStepPipeline);
    const job = createJob(db, 'shipping feature', { project: 'proj', concurrency: 2 });
    assert.equal(job.status, 'queued');
    assert.equal(job.concurrency, 2);
    assert.equal(job.total_tasks, 1);
    assert.ok(job.max_rounds > 0);
  });

  it('runJob executes the goal and records completion counts', async () => {
    const { db } = await setup(undefined, singleStepPipeline);
    const job = createJob(db, 'shipping feature', { project: 'proj' });
    const res = await runJob(db, job.id);
    assert.equal(res.job.status, 'completed');
    assert.equal(res.job.completed_tasks, 1);
    assert.equal(res.meta.completed, 1);
    assert.ok(res.job.finished_at);
    const row = getGoalTasks(db, 'shipping feature', { project: 'proj' })[0];
    assert.equal(row.status, 'completed');
  });

  it('recovers tasks left running by a crash and resumes the job', async () => {
    const { db, tasks } = await setup(undefined, singleStepPipeline);
    // Simulate a crash mid-flight: the task was claimed but never finished.
    claimTask(db, tasks[0].id);
    const job = createJob(db, 'shipping feature', { project: 'proj' });

    const res = await runJob(db, job.id);
    assert.equal(res.recovered, 1, 'crashed task should be recovered');
    assert.equal(res.job.status, 'completed');
    assert.equal(res.job.completed_tasks, 1);
  });

  it('a canceled job is not re-runnable and stays terminal', async () => {
    const { db } = await setup(undefined, singleStepPipeline);
    const job = createJob(db, 'shipping feature', { project: 'proj' });
    assert.equal(cancelJob(db, job.id), true);
    const res = await runJob(db, job.id);
    assert.equal(res.skipped, true);
    assert.match(res.reason, /already canceled/);
    assert.equal(cancelJob(db, job.id), false);
  });

  it('listJobs filters by status', async () => {
    const { db } = await setup(undefined, singleStepPipeline);
    createJob(db, 'shipping feature', { project: 'proj' });
    createJob(db, 'another goal', { project: 'proj' });
    const queued = listJobs(db, { status: 'queued' });
    assert.equal(queued.length, 2);
    assert.equal(listJobs(db, { status: 'completed' }).length, 0);
  });
});

// ─── Escalation payload shape ─────────────────────────────────────────

describe('Swarm: escalation payload', () => {
  it('includes war-room diagnostics and failure metadata', async () => {
    const { db, tasks } = await setup();
    const { escalateTask } = require('../src/core/swarm');
    completeTask(db, tasks[0].id, 'ok');
    failTask(db, tasks[1].id, 'operation took too long', { permanent: true });
    const payload = await escalateTask(db, tasks[1].id, { project: 'proj' });
    assert.equal(payload.role, 'coder');
    assert.equal(payload.failureClass, 'timeout');
    assert.ok(payload.warRoom, 'war-room self-check attached');
    assert.equal(payload.warRoom.avgScore, 72);
  });
});
