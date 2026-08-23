/**
 * index.js — Core module barrel export for agentic-cortex.
 *
 * Re-exports all core modules for convenient single-point access:
 *
 *   const core = require('./src/core');
 *   core.db.getDb();
 *   core.embedding.computeEmbedding('text');
 *   core.search.hybridSearch(db, query, queryVec, opts);
 *
 * @module core
 */

'use strict';

module.exports = {
  constants: require('./constants'),
  db: require('./db'),
  embedding: require('./embedding'),
  search: require('./search'),
  session: require('./session'),
  conflict: require('./conflict'),
  export: require('./export'),
  dbPath: require('./db-path'),
  relations: require('./relations'),
  hooks: require('./hooks'),
  reflection: require('./reflection'),
  fsm: require('./fsm'),
  rules: require('./rules'),
  workflow: require('./workflow'),
  prompts: require('./prompts'),
  recovery: require('./recovery'),
  prm: require('./prm'),
  treeSearch: require('./tree-search'),
  adaptiveBudget: require('./adaptive-budget'),
  replExecutor: require('./repl-executor'),
  reflexionLoop: require('./reflexion-loop'),
  selfConsistency: require('./self-consistency'),
  budgetForcing: require('./budget-forcing'),
  failureClassifier: require('./failure-classifier'),
  experienceReplay: require('./experience-replay'),
  translationStore: require('./translation-store'),
  burstBudget: require('./burst-budget'),
  warRoom: require('./war-room'),
  deterministicReasoner: require('./deterministic-reasoner'),
  swarm: require('./swarm'),
};
