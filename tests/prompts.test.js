'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Clear module cache so we always get a fresh prompts instance
delete require.cache[require.resolve('../src/core/prompts')];
const prompts = require('../src/core/prompts');

// ─── Built-in Templates ───────────────────────────────────────────────

describe('Prompts: built-in templates', () => {
  afterEach(() => {
    prompts.resetTemplates();
  });

  it('should have 10 built-in templates', () => {
    const templates = prompts.listTemplates();
    assert.equal(templates.length, 10);
  });

  it('should include all expected template names', () => {
    const templates = prompts.listTemplates();
    const names = templates.map(t => t.name).sort();
    assert.deepEqual(names, [
      'analyze-plateau',
      'classify-outcome',
      'consolidate-observations',
      'crystallize-raw-to-synthesis',
      'design-experiment',
      'extract-skill',
      'promote-pattern',
      'rca-from-error',
      'resolve-conflict',
      'verify-learning',
    ]);
  });

  it('should mark all built-in templates with source "built-in"', () => {
    const templates = prompts.listTemplates();
    assert.ok(templates.every(t => t.source === 'built-in'));
  });

  it('classify-outcome should track outcomes and have low temperature', () => {
    const t = prompts.getTemplate('classify-outcome');
    assert.ok(t);
    assert.equal(t.outcomeTracking, true);
    assert.equal(t.defaults.temperature, 0);
    assert.equal(t.defaults.maxTokens, 80);
  });

  it('rca-from-error should have appropriate defaults', () => {
    const t = prompts.getTemplate('rca-from-error');
    assert.ok(t);
    assert.equal(t.defaults.temperature, 0.2);
    assert.equal(t.defaults.maxTokens, 800);
    assert.equal(t.defaults.timeout, 60000);
  });

  it('consolidate-observations should NOT track outcomes', () => {
    const t = prompts.getTemplate('consolidate-observations');
    assert.equal(t.outcomeTracking, false);
  });

  it('analyze-plateau should have higher temperature for creative thinking', () => {
    const t = prompts.getTemplate('analyze-plateau');
    assert.equal(t.defaults.temperature, 0.4);
    assert.equal(t.defaults.maxTokens, 1000);
  });
});

// ─── getTemplate ──────────────────────────────────────────────────────

describe('Prompts: getTemplate', () => {
  afterEach(() => {
    prompts.resetTemplates();
  });

  it('should return a template by name', () => {
    const t = prompts.getTemplate('classify-outcome');
    assert.ok(t);
    assert.equal(t.name, 'classify-outcome');
    assert.equal(t.version, '1.0');
  });

  it('should return undefined for unknown template', () => {
    assert.equal(prompts.getTemplate('nonexistent'), undefined);
  });

  it('should return template with systemPrompt and userPromptTemplate', () => {
    const t = prompts.getTemplate('resolve-conflict');
    assert.ok(t.systemPrompt);
    assert.ok(t.userPromptTemplate);
    assert.ok(t.userPromptTemplate.includes('{{observationA}}'));
    assert.ok(t.userPromptTemplate.includes('{{observationB}}'));
  });
});

// ─── renderPrompt ─────────────────────────────────────────────────────

describe('Prompts: renderPrompt', () => {
  afterEach(() => {
    prompts.resetTemplates();
  });

  it('should return null for unknown template', () => {
    assert.equal(prompts.renderPrompt('nonexistent'), null);
  });

  it('should render a template with variable substitution', () => {
    const r = prompts.renderPrompt('classify-outcome', { outcomeText: 'test passed' });
    assert.ok(r);
    assert.equal(r.name, 'classify-outcome');
    assert.equal(r.version, '1.0');
    assert.ok(r.user.includes('test passed'), 'Should substitute outcomeText');
  });

  it('should leave unreplaced placeholders as empty strings', () => {
    const r = prompts.renderPrompt('classify-outcome', {});
    assert.ok(r.user.includes('\"\"'), 'Unreplaced placeholder should be empty string');
  });

  it('should render template with multiple variables', () => {
    const r = prompts.renderPrompt('rca-from-error', { errorContent: 'NullPointerException at line 42' });
    assert.ok(r.user.includes('NullPointerException at line 42'));
    assert.ok(r.system.includes('root cause analysis'));
  });

  it('should include defaults in rendered output', () => {
    const r = prompts.renderPrompt('verify-learning', {
      learningTitle: 'Test',
      learningContent: 'desc',
      obsType: 'error',
      obsTitle: 'err',
      obsContent: 'bad',
    });
    assert.equal(r.defaults.temperature, 0.1);
    assert.equal(r.defaults.maxTokens, 200);
    assert.ok(r.outcomeTracking);
  });

  it('should handle special characters in substitution values', () => {
    const r = prompts.renderPrompt('classify-outcome', { outcomeText: 'Error: "bad" & <evil>' });
    assert.ok(r.user.includes('Error: "bad" & <evil>'));
  });
});

// ─── buildMessages ────────────────────────────────────────────────────

describe('Prompts: buildMessages', () => {
  afterEach(() => {
    prompts.resetTemplates();
  });

  it('should return null for unknown template', () => {
    assert.equal(prompts.buildMessages('nonexistent'), null);
  });

  it('should build messages array with system and user roles', () => {
    const r = prompts.buildMessages('classify-outcome', { outcomeText: 'test' });
    assert.ok(r);
    assert.equal(r.messages.length, 2);
    assert.equal(r.messages[0].role, 'system');
    assert.equal(r.messages[1].role, 'user');
    assert.ok(r.messages[0].content.length > 0);
    assert.ok(r.messages[1].content.includes('test'));
  });

  it('should include template metadata', () => {
    const r = prompts.buildMessages('design-experiment', {
      errorTag: 'TypeError',
      recentErrors: 'error1, error2',
    });
    assert.equal(r.templateName, 'design-experiment');
    assert.equal(r.version, '1.0');
    assert.equal(r.outcomeTracking, true);
    assert.ok(r.defaults);
  });

  it('should include defaults from the template', () => {
    const r = prompts.buildMessages('extract-skill', {
      learningTitle: 'Rule',
      learningContent: 'desc',
    });
    assert.equal(r.defaults.temperature, 0.2);
    assert.equal(r.defaults.maxTokens, 1200);
  });
});

// ─── listTemplates ────────────────────────────────────────────────────

describe('Prompts: listTemplates', () => {
  afterEach(() => {
    prompts.resetTemplates();
  });

  it('should return an array', () => {
    assert.ok(Array.isArray(prompts.listTemplates()));
  });

  it('should have name, version, description, source, outcomeTracking for each', () => {
    const templates = prompts.listTemplates();
    for (const t of templates) {
      assert.ok(t.name, 'Template should have a name');
      assert.ok(t.version, 'Template should have a version');
      assert.equal(typeof t.description, 'string');
      assert.equal(typeof t.source, 'string');
      assert.equal(typeof t.outcomeTracking, 'boolean');
    }
  });

  it('should include custom templates after defineTemplate', () => {
    prompts.defineTemplate({
      name: 'my-custom',
      systemPrompt: 'Be helpful.',
      userPromptTemplate: 'Do {{task}}',
      description: 'Custom template',
    });
    const templates = prompts.listTemplates();
    assert.equal(templates.length, 11); // 10 built-in + 1 custom
    const custom = templates.find(t => t.name === 'my-custom');
    assert.ok(custom);
    assert.equal(custom.source, 'custom');
  });
});

// ─── defineTemplate ───────────────────────────────────────────────────

describe('Prompts: defineTemplate', () => {
  afterEach(() => {
    prompts.resetTemplates();
  });

  it('should register a custom template', () => {
    const t = prompts.defineTemplate({
      name: 'custom-greeting',
      systemPrompt: 'You are friendly.',
      userPromptTemplate: 'Say hello to {{name}}',
    });
    assert.equal(t.name, 'custom-greeting');
    assert.equal(t.source, 'custom');
    assert.ok(t.version.startsWith('custom-'));
  });

  it('should throw for missing required fields', () => {
    assert.throws(() => prompts.defineTemplate({}), /requires/);
    assert.throws(() => prompts.defineTemplate({ name: 'x' }), /requires/);
    assert.throws(() => prompts.defineTemplate({ name: 'x', systemPrompt: 's' }), /requires/);
  });

  it('should override built-in template with same name', () => {
    const t = prompts.defineTemplate({
      name: 'classify-outcome',
      systemPrompt: 'Custom override.',
      userPromptTemplate: 'Custom: {{outcomeText}}',
      version: '2.0-custom',
    });
    assert.equal(t.source, 'custom');
    assert.equal(t.version, '2.0-custom');

    // Verify the override works
    const r = prompts.renderPrompt('classify-outcome', { outcomeText: 'test' });
    assert.ok(r.system.includes('Custom override'));
  });

  it('should accept optional defaults', () => {
    const t = prompts.defineTemplate({
      name: 'with-defaults',
      systemPrompt: 'System',
      userPromptTemplate: 'User {{var}}',
      defaults: { temperature: 0.7, maxTokens: 500 },
      outcomeTracking: false,
    });
    assert.equal(t.defaults.temperature, 0.7);
    assert.equal(t.outcomeTracking, false);
  });
});

// ─── resetTemplates ───────────────────────────────────────────────────

describe('Prompts: resetTemplates', () => {
  it('should clear custom templates and restore built-ins', () => {
    // Add custom template
    prompts.defineTemplate({
      name: 'temp-custom',
      systemPrompt: 'Temp',
      userPromptTemplate: 'Temp {{x}}',
    });
    assert.equal(prompts.listTemplates().length, 11);

    // Reset
    prompts.resetTemplates();

    // Back to 10, no custom
    const templates = prompts.listTemplates();
    assert.equal(templates.length, 10);
    assert.equal(prompts.getTemplate('temp-custom'), undefined);
    assert.ok(prompts.getTemplate('classify-outcome'));
  });

  it('should reset custom version counter', () => {
    prompts.defineTemplate({
      name: 'first',
      systemPrompt: 'First',
      userPromptTemplate: 'First {{x}}',
    });
    prompts.resetTemplates();
    const t = prompts.defineTemplate({
      name: 'second',
      systemPrompt: 'Second',
      userPromptTemplate: 'Second {{x}}',
    });
    // Should start counting from 1 again
    assert.equal(t.version, 'custom-1');
  });
});

// ─── Edge Cases ───────────────────────────────────────────────────────

describe('Prompts: edge cases', () => {
  afterEach(() => {
    prompts.resetTemplates();
  });

  it('should handle empty vars object gracefully', () => {
    const r = prompts.renderPrompt('resolve-conflict', {});
    assert.ok(r);
    // Unresolved placeholders become empty strings
    assert.ok(r.user.includes('\"\"') || r.user.includes('{{'));
  });

  it('should handle template with no placeholders', () => {
    // All built-in templates have placeholders, but custom ones might not
    const t = prompts.defineTemplate({
      name: 'no-vars',
      systemPrompt: 'Be concise.',
      userPromptTemplate: 'Do the thing.',
    });
    const r = prompts.renderPrompt('no-vars', { irrelevant: 'ignored' });
    assert.equal(r.user, 'Do the thing.');
  });

  it('buildMessages should return copy of defaults (not mutate original)', () => {
    const r1 = prompts.buildMessages('classify-outcome', { outcomeText: 'a' });
    const r2 = prompts.buildMessages('classify-outcome', { outcomeText: 'b' });
    assert.deepEqual(r1.defaults, r2.defaults);
    assert.notStrictEqual(r1.defaults, r2.defaults, 'Should be different objects');
  });
});

// ─── Module Exports ───────────────────────────────────────────────────

describe('Prompts: module exports', () => {
  it('should export all expected functions and constants', () => {
    assert.equal(typeof prompts.BUILTIN_TEMPLATES, 'object');
    assert.equal(typeof prompts.getTemplate, 'function');
    assert.equal(typeof prompts.defineTemplate, 'function');
    assert.equal(typeof prompts.renderPrompt, 'function');
    assert.equal(typeof prompts.buildMessages, 'function');
    assert.equal(typeof prompts.listTemplates, 'function');
    assert.equal(typeof prompts.resetTemplates, 'function');
  });
});
