'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../src/core/db');
const {
  DEFAULT_WORKFLOWS,
  defineWorkflow,
  getWorkflow,
  listWorkflows,
  startWorkflow,
  advanceWorkflow,
  getWorkflowInstance,
  listWorkflowInstances,
  cancelWorkflow,
  initDefaultWorkflows,
  setSaveFunction,
  setFsm,
} = require('../src/core/workflow');

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  initDefaultWorkflows(db);
  return db;
}

// ─── Default Workflows ────────────────────────────────────────────────

describe('Workflow: default workflows', () => {
  it('should have 3 default workflows', () => {
    assert.equal(Object.keys(DEFAULT_WORKFLOWS).length, 3);
  });

  it('bug-fix-cycle should have 6 steps', () => {
    const wf = DEFAULT_WORKFLOWS['bug-fix-cycle'];
    assert.equal(wf.steps.length, 6);
    const stepIds = wf.steps.map(s => s.id);
    assert.deepEqual(stepIds, ['reproduce', 'diagnose', 'fix', 'test', 'review', 'merge']);
  });

  it('deploy-pipeline should exist', () => {
    const wf = DEFAULT_WORKFLOWS['deploy-pipeline'];
    assert.ok(wf);
    assert.ok(wf.steps.length > 0);
  });

  it('memory-maintenance should exist', () => {
    const wf = DEFAULT_WORKFLOWS['memory-maintenance'];
    assert.ok(wf);
    assert.ok(wf.steps.length > 0);
  });
});

// ─── Workflow Definition ──────────────────────────────────────────────

describe('Workflow: definition', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should define a custom workflow', () => {
    defineWorkflow({
      name: 'test-workflow',
      description: 'A test workflow',
      steps: [
        { id: 'step1', action: 'check', description: 'First step', dependsOn: [] },
        { id: 'step2', action: 'check', description: 'Second step', dependsOn: ['step1'] },
      ],
    });

    const wf = getWorkflow('test-workflow');
    assert.ok(wf);
    assert.equal(wf.name, 'test-workflow');
    assert.equal(wf.steps.length, 2);
  });

  it('should reject workflow without required fields', () => {
    assert.throws(() => defineWorkflow({}), /requires/);
    assert.throws(() => defineWorkflow({ name: 'x' }), /requires/);
  });

  it('should reject workflow with unknown dependency', () => {
    assert.throws(() => defineWorkflow({
      name: 'bad-wf',
      steps: [
        { id: 'step1', action: 'check', description: 'Bad', dependsOn: ['nonexistent'] },
      ],
    }), /unknown step/);
  });

  it('should detect simple dependency cycles', () => {
    assert.throws(() => defineWorkflow({
      name: 'cycle-wf',
      steps: [
        { id: 'a', action: 'check', description: 'A', dependsOn: ['b'] },
        { id: 'b', action: 'check', description: 'B', dependsOn: ['a'] },
      ],
    }), /circular|cycle/i);
  });

  it('should list all workflows including defaults', () => {
    const workflows = listWorkflows();
    assert.ok(workflows.length >= 3);
    const names = workflows.map(w => w.name);
    assert.ok(names.includes('bug-fix-cycle'));
    assert.ok(names.includes('deploy-pipeline'));
    assert.ok(names.includes('memory-maintenance'));
  });

  it('should return undefined for unknown workflow', () => {
    assert.equal(getWorkflow('nonexistent'), undefined);
  });
});

// ─── Workflow Execution ───────────────────────────────────────────────

describe('Workflow: execution', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should start a workflow at the first step', () => {
    const inst = startWorkflow(db, 'bug-fix-cycle', { project: '/test' });
    assert.ok(inst);
    assert.equal(inst.workflowName, 'bug-fix-cycle');
    assert.equal(inst.currentStep, 'reproduce');
    assert.equal(inst.status, 'running');
    assert.ok(inst.id > 0);
  });

  it('should throw for unknown workflow', () => {
    assert.throws(() => startWorkflow(db, 'no-such-workflow'), /Unknown workflow/);
  });

  it('should advance through all steps of bug-fix-cycle', () => {
    const inst = startWorkflow(db, 'bug-fix-cycle');
    assert.equal(inst.currentStep, 'reproduce');

    const s1 = advanceWorkflow(db, inst.id);
    assert.ok(s1.completedSteps.includes('reproduce'), 'reproduce should be in completedSteps');
    assert.equal(s1.currentStep, 'diagnose');

    const s2 = advanceWorkflow(db, inst.id);
    assert.ok(s2.completedSteps.includes('diagnose'));
    assert.equal(s2.currentStep, 'fix');

    const s3 = advanceWorkflow(db, inst.id);
    assert.ok(s3.completedSteps.includes('fix'));
    assert.equal(s3.currentStep, 'test');

    const s4 = advanceWorkflow(db, inst.id);
    assert.ok(s4.completedSteps.includes('test'));
    assert.equal(s4.currentStep, 'review');

    const s5 = advanceWorkflow(db, inst.id);
    assert.ok(s5.completedSteps.includes('review'));
    assert.equal(s5.currentStep, 'merge');
  });

  it('should mark workflow as completed after final step', () => {
    const inst = startWorkflow(db, 'bug-fix-cycle');
    advanceWorkflow(db, inst.id); // reproduce → diagnose
    advanceWorkflow(db, inst.id); // diagnose → fix
    advanceWorkflow(db, inst.id); // fix → test
    advanceWorkflow(db, inst.id); // test → review
    advanceWorkflow(db, inst.id); // review → merge
    const final = advanceWorkflow(db, inst.id); // merge → complete

    assert.ok(final, 'advanceWorkflow should return completion object, not null');
    assert.equal(final.status, 'completed');
    assert.equal(final.currentStep, null);
    assert.ok(final.completedAt);
  });

  it('should return null for completed workflow', () => {
    const inst = startWorkflow(db, 'bug-fix-cycle');
    for (let i = 0; i < 6; i++) advanceWorkflow(db, inst.id);
    const result = advanceWorkflow(db, inst.id);
    assert.equal(result, null);
  });

  it('should return null for unknown instance', () => {
    assert.equal(advanceWorkflow(db, 9999), null);
  });
});

// ─── Workflow Instances ───────────────────────────────────────────────

describe('Workflow: instances', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should get a workflow instance by ID', () => {
    const inst = startWorkflow(db, 'bug-fix-cycle');
    const fetched = getWorkflowInstance(db, inst.id);
    assert.ok(fetched);
    assert.equal(fetched.workflowName, 'bug-fix-cycle');
    assert.equal(fetched.status, 'running');
  });

  it('should return null for unknown instance', () => {
    assert.equal(getWorkflowInstance(db, 9999), null);
  });

  it('should list workflow instances', () => {
    startWorkflow(db, 'bug-fix-cycle');
    startWorkflow(db, 'memory-maintenance');
    const instances = listWorkflowInstances(db);
    assert.ok(instances.length >= 2);
  });

  it('should list workflow instances filtered by status', () => {
    startWorkflow(db, 'bug-fix-cycle');
    const instances = listWorkflowInstances(db, { status: 'running' });
    assert.ok(instances.length >= 1);
    assert.ok(instances.every(i => i.status === 'running'));
  });

  it('should list workflow instances filtered by agentId', () => {
    startWorkflow(db, 'bug-fix-cycle', { agentId: 'agent-x' });
    startWorkflow(db, 'memory-maintenance', { agentId: 'agent-y' });
    const instances = listWorkflowInstances(db, { agentId: 'agent-x' });
    assert.ok(instances.every(i => i.agentId === 'agent-x'));
  });
});

// ─── Workflow Cancellation ────────────────────────────────────────────

describe('Workflow: cancellation', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should cancel a running workflow', () => {
    const inst = startWorkflow(db, 'bug-fix-cycle');
    const result = cancelWorkflow(db, inst.id);
    assert.equal(result.status, 'cancelled');
  });

  it('should throw for non-existent instance', () => {
    assert.throws(() => cancelWorkflow(db, 9999), /not found/);
  });

  it('should not cancel already completed workflow', () => {
    const inst = startWorkflow(db, 'bug-fix-cycle');
    for (let i = 0; i < 6; i++) advanceWorkflow(db, inst.id);
    // Already completed, cancel should fail
    assert.throws(() => cancelWorkflow(db, inst.id), /not found/);
  });
});

// ─── Multi-Step Dependencies ──────────────────────────────────────────

describe('Workflow: multi-step dependencies', () => {
  let db;
  beforeEach(() => { db = createTestDb(); });

  it('should handle steps with multiple dependencies', () => {
    defineWorkflow({
      name: 'multi-dep',
      steps: [
        { id: 'a', action: 'check', description: 'A', dependsOn: [] },
        { id: 'b', action: 'check', description: 'B', dependsOn: [] },
        { id: 'c', action: 'check', description: 'C (needs A and B)', dependsOn: ['a', 'b'] },
      ],
    });

    // Both a and b are initial (no deps), but only one becomes currentStep
    const inst = startWorkflow(db, 'multi-dep');
    assert.ok(inst.currentStep === 'a' || inst.currentStep === 'b',
      `Expected 'a' or 'b', got ${inst.currentStep}`);

    // Advance a
    const s1 = advanceWorkflow(db, inst.id);
    const remaining = s1.currentStep;

    // Advance the other initial step
    const s2 = advanceWorkflow(db, inst.id);
    // Now both dependencies satisfied, should advance to c
    assert.equal(s2.currentStep, 'c');
  });
});

// ─── Dependency Injection ─────────────────────────────────────────────

describe('Workflow: dependency injection', () => {
  it('should accept a save function', () => {
    const fn = async () => ({ id: 1 });
    assert.doesNotThrow(() => setSaveFunction(fn));
  });

  it('should accept an FSM reference', () => {
    const fsm = { transition: () => {}, getAgentState: () => null };
    assert.doesNotThrow(() => setFsm(fsm));
  });
});

// ─── Module Exports ───────────────────────────────────────────────────

describe('Workflow: module exports', () => {
  it('should export all expected functions', () => {
    assert.equal(typeof defineWorkflow, 'function');
    assert.equal(typeof getWorkflow, 'function');
    assert.equal(typeof listWorkflows, 'function');
    assert.equal(typeof startWorkflow, 'function');
    assert.equal(typeof advanceWorkflow, 'function');
    assert.equal(typeof getWorkflowInstance, 'function');
    assert.equal(typeof listWorkflowInstances, 'function');
    assert.equal(typeof cancelWorkflow, 'function');
    assert.equal(typeof initDefaultWorkflows, 'function');
    assert.equal(typeof setSaveFunction, 'function');
    assert.equal(typeof setFsm, 'function');
  });
});
