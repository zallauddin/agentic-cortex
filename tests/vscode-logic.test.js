'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── Mock VS Code API ──────────────────────────────────────────────
const mockVSCode = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/test/project' } }],
    onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
    onDidSaveTextDocument: () => ({ dispose: () => {} }),
    onDidCloseTextDocument: () => ({ dispose: () => {} }),
    onDidChangeTextDocument: () => ({ dispose: () => {} }),
  },
  window: {
    onDidOpenTerminal: () => ({ dispose: () => {} }),
    onDidCloseTerminal: () => ({ dispose: () => {} }),
  },
};

// ── Mock API ──────────────────────────────────────────────────────
let mockSavedItems = [];
let mockSessionId = null;

const mockApi = {
  save: async (opts) => {
    mockSavedItems.push(opts);
    return { id: mockSavedItems.length, status: 'saved' };
  },
  startSession: () => {
    mockSessionId = 'sess-' + Date.now();
    return { session_id: mockSessionId };
  },
  endSession: () => ({ status: 'ended' }),
};

// Clear module cache for fresh load
delete require.cache[require.resolve('../src/editor/vscode-logic')];
const vscodeLogic = require('../src/editor/vscode-logic');

// ─── Tests ──────────────────────────────────────────────────────────

describe('init', () => {
  beforeEach(() => {
    mockSavedItems = [];
    mockSessionId = null;
  });

  it('should accept vscode API and project path', () => {
    assert.doesNotThrow(() => vscodeLogic.init({
      vscode: mockVSCode, projectPath: '/test/project', api: mockApi,
    }));
  });

  it('should derive project path from workspace folders', () => {
    assert.doesNotThrow(() => vscodeLogic.init({
      vscode: mockVSCode, api: mockApi,
    }));
  });
});

describe('registerHandlers', () => {
  beforeEach(() => {
    mockSavedItems = [];
    vscodeLogic.init({ vscode: mockVSCode, api: mockApi, projectPath: '/test' });
  });

  it('should not throw when API is initialized', () => {
    assert.doesNotThrow(() => vscodeLogic.registerHandlers({ subscriptions: [] }));
  });

  it('should add disposables to context', () => {
    const context = { subscriptions: [] };
    vscodeLogic.registerHandlers(context);
    assert.ok(context.subscriptions.length > 0);
  });
});

describe('recordTerminalCommand', () => {
  beforeEach(() => {
    mockSavedItems = [];
    vscodeLogic.init({ vscode: mockVSCode, api: mockApi, projectPath: '/test' });
  });

  it('should save a terminal command observation', () => {
    vscodeLogic.recordTerminalCommand('npm test', 0, 'All tests passed');
    assert.equal(mockSavedItems.length, 1);
    assert.equal(mockSavedItems[0].type, 'event');
    assert.ok(mockSavedItems[0].content.includes('npm test'));
    assert.ok(mockSavedItems[0].content.includes('succeeded'));
  });

  it('should record failed commands with exit code', () => {
    vscodeLogic.recordTerminalCommand('npm run build', 1, 'Build failed');
    assert.ok(mockSavedItems[0].content.includes('failed'));
  });

  it('should include appropriate tags', () => {
    vscodeLogic.recordTerminalCommand('ls', 0);
    const tags = mockSavedItems[0].tags;
    assert.ok(Array.isArray(tags));
    assert.ok(tags.includes('auto-capture'));
    assert.ok(tags.includes('success'));
  });

  it('should handle missing output', () => {
    assert.doesNotThrow(() => vscodeLogic.recordTerminalCommand('git status', 0));
  });
});

describe('recordGitOperation', () => {
  beforeEach(() => {
    mockSavedItems = [];
    vscodeLogic.init({ vscode: mockVSCode, api: mockApi, projectPath: '/test' });
  });

  it('should save git operation observation', () => {
    vscodeLogic.recordGitOperation('commit', 'fix: resolve null pointer');
    assert.equal(mockSavedItems.length, 1);
    assert.equal(mockSavedItems[0].type, 'event');
    assert.ok(mockSavedItems[0].content.includes('commit'));
    assert.ok(mockSavedItems[0].content.includes('fix: resolve null pointer'));
  });

  it('should include git tags', () => {
    vscodeLogic.recordGitOperation('pull');
    const tags = mockSavedItems[0].tags;
    assert.ok(Array.isArray(tags));
    assert.ok(tags.includes('git'));
    assert.ok(tags.includes('pull'));
  });

  it('should set importance to 5', () => {
    vscodeLogic.recordGitOperation('merge');
    assert.equal(mockSavedItems[0].importance, 5);
  });
});

describe('saveMemory', () => {
  beforeEach(() => {
    mockSavedItems = [];
    vscodeLogic.init({ vscode: mockVSCode, api: mockApi, projectPath: '/test' });
  });

  it('should delegate to API save', async () => {
    const result = await vscodeLogic.saveMemory({
      type: 'observation', title: 'Manual save', content: 'From editor',
    });
    assert.ok(result.id);
    assert.equal(mockSavedItems.length, 1);
  });

  it('should auto-set project from init', async () => {
    await vscodeLogic.saveMemory({ type: 'fact', title: 'Auto', content: 'Test' });
    assert.equal(mockSavedItems[0].project, '/test');
  });
});

describe('module exports', () => {
  it('should export all expected functions', () => {
    assert.equal(typeof vscodeLogic.init, 'function');
    assert.equal(typeof vscodeLogic.registerHandlers, 'function');
    assert.equal(typeof vscodeLogic.recordTerminalCommand, 'function');
    assert.equal(typeof vscodeLogic.recordGitOperation, 'function');
    assert.equal(typeof vscodeLogic.saveMemory, 'function');
  });
});
