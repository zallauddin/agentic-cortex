/**
 * constants.js — Shared constants for agentic-cortex core modules.
 *
 * Contains valid observation types, provenance values, model identifiers,
 * and database configuration constants used across the system.
 *
 * @module core/constants
 */

'use strict';

/** @type {Set<string>} Valid observation types (13 from Memanto + skill/procedure + action + legacy aliases) */
const VALID_TYPES = new Set([
  'instruction', 'fact', 'decision', 'goal', 'commitment', 'preference',
  'relationship', 'context', 'event', 'learning', 'observation',
  'artifact', 'error',
  // Skill/procedural memory types
  'skill', 'procedure',
  // Intent → Action → Outcome tracking
  'action',
  // Legacy aliases (backwards compatible)
  'architecture', 'bugfix', 'gotcha', 'codebase-graph',
]);

/** @type {Set<string>} Valid provenance values */
const VALID_PROVENANCES = new Set(['explicit', 'inferred', 'observed']);

/** @type {Set<string>} Valid relation types for memory graph edges */
const VALID_RELATION_TYPES = new Set([
  'related_to',    // General association
  'contradicts',   // Opposes or conflicts with
  'supersedes',    // Replaces or overrides
  'derives_from',  // Source/origin relationship
  'depends_on',    // Dependency chain
  'part_of',       // Hierarchical containment
  'refines',       // Improves upon or narrows
  'achieves',      // Action achieves intent
  'produces',      // Intent produces outcome
]);

/** @type {string} Default embedding model identifier */
const EMBED_MODEL = process.env.AGENTIC_CORTEX_EMBED_MODEL || 'Xenova/bge-base-en-v1.5';

/** @type {string} Default cross-encoder reranking model identifier */
const RERANK_MODEL = process.env.AGENTIC_CORTEX_RERANK_MODEL || 'Xenova/ms-marco-MiniLM-L-6-v2';

/** @type {string} Database filename */
const DB_FILENAME = 'agentic-cortex.db';

/** @type {string} Default port for HTTP server */
const PORT = parseInt(process.env.AGENTIC_CORTEX_PORT || '37777', 10);

/** @type {string} llama.cpp server base URL for LLM calls */
const LLAMA_URL = process.env.LLAMA_CPP_BASE_URL || 'http://127.0.0.1:8081';

/**
 * Get the default project path from options, env, or current working directory.
 * Centralized to reduce duplication across the codebase.
 *
 * @param {Object} [opts] - Options object that may contain a `project` field
 * @returns {string} Resolved project path
 */
function getProjectDefault(opts) {
  return (opts && opts.project) || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
}

module.exports = {
  VALID_TYPES,
  VALID_PROVENANCES,
  VALID_RELATION_TYPES,
  EMBED_MODEL,
  RERANK_MODEL,
  DB_FILENAME,
  PORT,
  LLAMA_URL,
  getProjectDefault,
};
