#!/usr/bin/env node
'use strict';

/**
 * agentic-cortex MCP Server — stdio JSON-RPC 2.0 interface.
 *
 * Exposes agentic-cortex as an MCP tool server over stdio.
 * No HTTP; no npm MCP SDK dependency — pure JSON-RPC from scratch.
 * All logging goes to stderr only (stdout is reserved for JSON-RPC).
 *
 * @module mcp/server
 */

const api = require('../api');
const pkg = require('../../package.json');

// ─── Global error handlers ────────────────────────────────────────────
// Must write to stderr to avoid corrupting the MCP stdio JSON channel.
process.on('uncaughtException', (err) => {
  console.error('[agentic-cortex-mcp] Uncaught exception:', err);
  // Don't crash — keep serving tools. But log prominently.
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[agentic-cortex-mcp] Unhandled rejection at:', promise, 'reason:', reason);
});

// ─── JSON-RPC 2.0 helpers ────────────────────────────────────────────

function rpcResult(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return JSON.stringify({ jsonrpc: '2.0', id, error: err });
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// ─── Per-project execution queue (prevents concurrent SQLite/NN contention) ─

/** @type {Map<string, Promise>} Per-project execution chains */
const _projectQueues = new Map();

/**
 * Read-only tools: never mutate state, so they don't serialize behind each
 * other — but they DO wait for pending writes in the same project so that
 * pipelined read-after-write sequences (save → search) observe the write.
 */
const stateModifyingTools = new Set(['memory_offline_execute', 'memory_save', 'memory_edit', 'memory_forget', 'memory_reflect', 'memory_import', 'memory_relate', 'memory_share', 'agent_session_start', 'agent_session_end', 'session_start', 'session_end', 'memory_record_action', 'memory_transfer_knowledge', 'memory_ingest_transcript', 'memory_feedback', 'memory_maintenance', 'memory_standards', 'memory_bootstrap', 'memory_promote_global', 'memory_crystallize', 'memory_experiment', 'memory_fsm', 'memory_rules', 'memory_workflow', 'memory_plateau_check', 'memory_send', 'memory_mark_read', 'memory_tree_search', 'memory_reflexion', 'memory_verify_code', 'memory_retry_check', 'memory_burst_reset', 'memory_reason_all', 'memory_swarm_decompose', 'memory_swarm_start_task', 'memory_swarm_complete_task', 'memory_swarm_fail_task', 'memory_swarm_synthesize', 'memory_swarm_execute', 'memory_swarm_execute_pipeline', 'memory_swarm_replan_goal', 'memory_swarm_retry_now', 'memory_swarm_job_create', 'memory_swarm_job_run', 'memory_swarm_job_cancel', 'memory_swarm_plan_import', 'memory_swarm_plan_run', 'memory_swarm_plan_sync', 'memory_experience_record', 'memory_experience_replay', 'memory_translation_store', 'memory_war_room_run', 'memory_expire']);

/**
 * Execute a tool call with per-project serialization.
 * Ensures only one concurrent tool call per project to avoid SQLite busy
 * errors and overlapping LLM/embedding operations.
 *
 * Read-after-write consistency: reads (search/list/get/context/bootstrap)
 * also wait for any PENDING writes in the same project before executing,
 * so a search fired in parallel with a save (agents pipeline concurrent
 * tool calls) never executes before the save has landed. Reads still run
 * concurrently with each other — they only gate on writes, not on reads.
 */
function _enqueueToolCall(toolName, toolArgs) {
  if (!stateModifyingTools.has(toolName)) {
    // Read-only tool: gate on any PENDING write in this project for
    // read-after-write consistency (save → search in parallel must see the
    // save), but do NOT register the read in the queue — concurrent reads
    // stay concurrent instead of serializing behind each other.
    const readKey = (toolArgs && toolArgs.project) || '__default__';
    const pendingWrite = _projectQueues.get(readKey) || Promise.resolve();
    return pendingWrite.then(() => callTool(toolName, toolArgs),
      () => callTool(toolName, toolArgs));
  }

  const projectKey = toolArgs.project || '__default__';
  const prev = _projectQueues.get(projectKey) || Promise.resolve();
  const next = prev.then(() => callTool(toolName, toolArgs),
    () => callTool(toolName, toolArgs)
  );

  const cleanup = next.then(() => {
    if (_projectQueues.get(projectKey) === next) {
      _projectQueues.delete(projectKey);
    }
  }, () => {
    if (_projectQueues.get(projectKey) === next) {
      _projectQueues.delete(projectKey);
    }
  });
  cleanup.catch(() => {});

  _projectQueues.set(projectKey, next);

  if (_projectQueues.size > 100) {
    const keys = [..._projectQueues.keys()];
    for (const k of keys.slice(0, 50)) _projectQueues.delete(k);
  }

  return next;
}

// ─── Tool definitions ────────────────────────────────────────────────

/**
 * Tools whose documented `project` default (AGENTIC_CORTEX_PROJECT or cwd)
 * must be enforced server-side before dispatch. Without this, search/list
 * read across ALL projects on the machine — a cross-project memory leak for
 * any agent that omits the explicit `project` argument.
 */
const _PROJECT_SCOPED_TOOLS = new Set([
  'memory_search', 'memory_list', 'memory_context', 'memory_profile',
  'memory_bootstrap', 'memory_reflect', 'memory_conflicts', 'memory_expire',
  'memory_maintenance', 'memory_search_hybrid', 'memory_daily_summary',
  'memory_analytics', 'memory_utility_stats', 'memory_freshness',
]);

const TOOLS = [
  {
    name: 'memory_save',
    description: 'Save a new observation to memory. Auto-embeds if the embedding pipeline is available.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the observation' },
        content: { type: 'string', description: 'Full observation content (required)' },
        type: { type: 'string', description: 'Observation type: instruction, fact, decision, goal, commitment, preference, relationship, context, event, learning, observation, artifact, error, skill, procedure, architecture, bugfix, gotcha, codebase-graph', default: 'observation' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        importance: { type: 'integer', description: 'Importance 1-10', default: 5 },
        confidence: { type: 'integer', description: 'Confidence 0-100', default: 100 },
        provenance: { type: 'string', description: 'Source: explicit, inferred, observed', default: 'observed' },
        project: { type: 'string', description: 'Project path (defaults to AGENTIC_CORTEX_PROJECT or cwd)' },
        session: { type: 'string', description: 'Session ID to associate' },
        agentId: { type: 'string', description: 'Agent ID for multi-agent namespace isolation' },
        steps: { type: 'array', items: { type: 'string' }, description: 'Procedure steps (for type=procedure)' },
        triggers: { type: 'array', items: { type: 'string' }, description: 'Triggers/conditions (for type=procedure or skill)' },
        preconditions: { type: 'array', items: { type: 'string' }, description: 'Preconditions (for type=procedure or skill)' },
        postconditions: { type: 'array', items: { type: 'string' }, description: 'Postconditions (for type=procedure or skill)' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_search',
    description: 'Hybrid search across memories (FTS5 keyword + semantic vector). Auto-computes embedding for the query. Pass rerank=true to apply cross-encoder reranking for higher precision.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query text' },
        project: { type: 'string', description: 'Filter by project path' },
        type: { type: 'string', description: 'Filter by observation type' },
        limit: { type: 'integer', description: 'Max results', default: 10 },
        minConfidence: { type: 'integer', description: 'Minimum confidence filter' },
        agentId: { type: 'string', description: 'Filter by agent ID (multi-agent namespace)' },
        rerank: { type: 'boolean', description: 'Apply cross-encoder reranking to top results (slower but more precise)', default: false },
        rerankTopN: { type: 'integer', description: 'Number of candidates to retrieve before reranking. Default: 5 * limit.', default: 50 },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_get',
    description: 'Get a single observation by ID.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Observation ID' } },
      required: ['id'],
    },
  },
  {
    name: 'memory_list',
    description: 'List observations with optional filters.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Filter by project path' },
        type: { type: 'string', description: 'Filter by observation type' },
        limit: { type: 'integer', description: 'Max results', default: 10 },
        minConfidence: { type: 'integer', description: 'Minimum confidence filter' },
        changedSince: { type: 'string', description: 'Only observations after this date (YYYY-MM-DD)' },
        asOf: { type: 'string', description: 'Only observations before this date (YYYY-MM-DD)' },
        agentId: { type: 'string', description: 'Filter by agent ID (multi-agent namespace)' },
      },
    },
  },
  {
    name: 'memory_edit',
    description: 'Edit an existing observation (creates version history).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Observation ID' },
        title: { type: 'string', description: 'New title' },
        content: { type: 'string', description: 'New content' },
        confidence: { type: 'integer', description: 'New confidence value' },
        importance: { type: 'integer', description: 'New importance 1-10' },
        steps: { type: 'array', items: { type: 'string' }, description: 'New procedure steps' },
        triggers: { type: 'array', items: { type: 'string' }, description: 'New triggers/conditions' },
        preconditions: { type: 'array', items: { type: 'string' }, description: 'New preconditions' },
        postconditions: { type: 'array', items: { type: 'string' }, description: 'New postconditions' },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_forget',
    description: 'Soft-delete (or hard-delete) an observation.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Observation ID' },
        hard: { type: 'boolean', description: 'Permanently delete (cannot be undone)', default: false },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_context',
    description: 'Generate a formatted markdown context pack for AI system prompts — summarizes recent sessions and key observations for a project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path (defaults to AGENTIC_CORTEX_PROJECT or cwd)' },
      },
    },
  },
  {
    name: 'memory_reflect',
    description: 'Run reflection cycle: consolidate similar memories, promote recurring patterns, archive superseded. All operations are LLM-driven and create supersedes relations.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Filter by project path (defaults to AGENTIC_CORTEX_PROJECT or cwd)' },
        dryRun: { type: 'boolean', description: 'Preview what would happen without making changes', default: false },
        consolidateThreshold: { type: 'number', description: 'Cosine similarity threshold for consolidation (0-1)', default: 0.85 },
        promoteMinCount: { type: 'integer', description: 'Minimum occurrences to promote a pattern', default: 3 },
        archiveMaxAgeDays: { type: 'integer', description: 'Max age in days for archiving superseded observations', default: 30 },
      },
    },
  },
  {
    name: 'session_start',
    description: 'Start a new memory session.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path' },
        name: { type: 'string', description: 'Project/session name' },
        prompt: { type: 'string', description: 'User prompt that started this session' },
      },
    },
  },
  {
    name: 'session_end',
    description: 'End an active session.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to end' },
        summary: { type: 'string', description: 'Summary of the session' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'session_summarize',
    description: 'Summarize a session (async — uses LLM if available).',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID to summarize' },
        project: { type: 'string', description: 'Project path filter' },
      },
    },
  },
  {
    name: 'memory_conflicts',
    description: 'Detect semantically similar but potentially contradictory observations. Utopia-aligned: supports semantic cache, confidence floor, LLM batching, and keep-both/open outcome.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Filter by project path' },
        limit: { type: 'integer', description: 'Max conflict pairs', default: 10 },
        autoResolve: { type: 'boolean', description: 'Attempt automatic DS resolution', default: false },
        confidenceFloor: { type: 'integer', description: 'Minimum confidence to include an observation (default 30; 0 = no filter)' },
        batchSize: { type: 'integer', description: 'Pairs per LLM batch prompt (default 5)' },
        threshold: { type: 'number', description: 'Cosine similarity threshold (default 0.65)' },
        clearCache: { type: 'boolean', description: 'Clear the semantic cache before detecting' },
      },
    },
  },
  {
    name: 'memory_export',
    description: 'Export observations and sessions as JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Filter by project path' },
        includeEmbeddings: { type: 'boolean', description: 'Include embedding vectors', default: false },
      },
    },
  },
  {
    name: 'memory_import',
    description: 'Import observations from JSON. Accepts an array of observations or { observations: [...] }.',
    inputSchema: {
      type: 'object',
      properties: {
        data: { type: 'object', description: 'JSON data to import (array of observations or { observations: [...] })' },
        project: { type: 'string', description: 'Override project path for imported observations' },
      },
      required: ['data'],
    },
  },
  {
    name: 'memory_health',
    description: 'Health check: DB stats, embedding cache stats, and overall status.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_embed',
    description: 'Re-embed an observation by ID, or compute embedding for a text string.',
    inputSchema: {
      type: 'object',
      properties: {
        idOrText: { type: 'string', description: 'Observation ID (number as string) or text to embed' },
      },
      required: ['idOrText'],
    },
  },
  {
    name: 'memory_relate',
    description: 'Create a semantic relation between two observations (e.g., contradicts, supersedes, derives_from).',
    inputSchema: {
      type: 'object',
      properties: {
        sourceId: { type: 'integer', description: 'Source observation ID' },
        targetId: { type: 'integer', description: 'Target observation ID' },
        relationType: { type: 'string', description: 'Relation type: related_to, contradicts, supersedes, derives_from, depends_on, part_of, refines', default: 'related_to' },
        confidence: { type: 'integer', description: 'Confidence 0-100', default: 100 },
      },
      required: ['sourceId', 'targetId'],
    },
  },
  {
    name: 'memory_graph',
    description: 'Get a subgraph of related observations around a center observation (nodes + edges).',
    inputSchema: {
      type: 'object',
      properties: {
        observationId: { type: 'integer', description: 'Center observation ID' },
        depth: { type: 'integer', description: 'Traversal depth (1-4)', default: 2 },
        limit: { type: 'integer', description: 'Max nodes to return', default: 100 },
      },
      required: ['observationId'],
    },
  },
  {
    name: 'memory_hook',
    description: 'Manage auto-capture hooks that trigger on observation events (pre_save, post_save, pre_edit, post_edit, pre_forget, post_forget). Supports create, list, update, delete, enable, and disable operations.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'update', 'delete', 'enable', 'disable'], description: 'Hook operation' },
        id: { type: 'integer', description: 'Hook ID (for update/delete/enable/disable)' },
        name: { type: 'string', description: 'Unique hook name (for create)' },
        event: { type: 'string', enum: ['pre_save', 'post_save', 'pre_edit', 'post_edit', 'pre_forget', 'post_forget'], description: 'Event to trigger on (for create)' },
        condition_type: { type: 'string', enum: ['type_equals', 'tag_contains', 'importance_gte', 'project_equals', 'always'], description: 'Condition type (for create/update)' },
        condition_value: { type: 'string', description: 'Condition value (for create/update)' },
        action_type: { type: 'string', enum: ['save_memory', 'log', 'webhook'], description: 'Action to perform when triggered (for create/update)' },
        action_config: { type: 'object', description: 'Action configuration (for create/update). save_memory: {template}, log: {message}, webhook: {url, headers, body_template}' },
        enabled: { type: 'boolean', description: 'Hook enabled state (for update)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'agent_session_start',
    description: 'Start a new agent session for multi-agent namespace isolation.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Unique agent identifier' },
        sessionId: { type: 'string', description: 'Session identifier' },
        project: { type: 'string', description: 'Project path' },
        role: { type: 'string', description: 'Agent role (e.g., coder, reviewer, planner)' },
      },
      required: ['agentId', 'sessionId'],
    },
  },
  {
    name: 'agent_session_end',
    description: 'End an active agent session.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent identifier' },
        sessionId: { type: 'string', description: 'Session identifier to end' },
      },
      required: ['agentId', 'sessionId'],
    },
  },
  {
    name: 'memory_share',
    description: 'Share an observation with other agents. Updates shared_with tracking.',
    inputSchema: {
      type: 'object',
      properties: {
        observationId: { type: 'integer', description: 'Observation ID to share' },
        sharedWith: { type: 'array', items: { type: 'string' }, description: 'List of agent IDs to share with' },
      },
      required: ['observationId', 'sharedWith'],
    },
  },
  {
    name: 'agent_list_sessions',
    description: 'List agent sessions with optional filters.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Filter by agent ID' },
        project: { type: 'string', description: 'Filter by project path' },
        limit: { type: 'integer', description: 'Max results', default: 20 },
      },
    },
  },
  {
    name: 'memory_shared_get',
    description: 'Get memories shared with a specific agent from other agents.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID requesting shared memories' },
        project: { type: 'string', description: 'Filter by project path' },
        limit: { type: 'integer', description: 'Max results', default: 20 },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'memory_skill_list',
    description: 'List observations of type skill or procedure with their structured fields (steps, triggers, preconditions, postconditions).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Filter by project path' },
        type: { type: 'string', description: 'Filter by type: skill or procedure', default: 'skill' },
        agentId: { type: 'string', description: 'Filter by agent ID' },
        limit: { type: 'integer', description: 'Max results', default: 20 },
        minConfidence: { type: 'integer', description: 'Minimum confidence filter' },
      },
    },
  },
  {
    name: 'memory_skill_search',
    description: 'Search within skills and procedures by text query. Searches across title, content, steps, triggers, preconditions, and postconditions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        project: { type: 'string', description: 'Filter by project path' },
        type: { type: 'string', description: 'Filter by type: skill, procedure, or both', default: 'both' },
        agentId: { type: 'string', description: 'Filter by agent ID' },
        limit: { type: 'integer', description: 'Max results', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_daily_summary',
    description: 'Generate a daily summary of observations for a project. Uses LLM if available, falls back to template.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path (defaults to AGENTIC_CORTEX_PROJECT or cwd)' },
        date: { type: 'string', description: 'Date to summarize (YYYY-MM-DD, defaults to yesterday)' },
        force: { type: 'boolean', description: 'Force regeneration even if cached', default: false },
      },
    },
  },
  {
    name: 'memory_auto_capture',
    description: 'Declare what you are working on. Auto-starts a session if needed and saves a context observation. Use this at the start of every significant task so memories are automatically associated with the right session.',
    inputSchema: {
      type: 'object',
      properties: {
        workingOn: { type: 'string', description: 'What you are working on right now (e.g., "Fixing login bug in auth.ts")' },
        project: { type: 'string', description: 'Project path (defaults to AGENTIC_CORTEX_PROJECT or cwd)' },
        type: { type: 'string', description: 'Observation type', default: 'context' },
        importance: { type: 'integer', description: 'Importance 1-10', default: 6 },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
      },
      required: ['workingOn'],
    },
  },
  {
    name: 'memory_bootstrap',
    description: '🔑 BOOTSTRAP — Call this FIRST at session start. Returns structured XML context with: task-relevant memories (hybrid search + cross-encoder reranking), LLM-generated actionable insights, recent sessions, warnings about incorrect memories, and collapsed coding standards. The system auto-infers your task — just call memory_bootstrap({}) with no arguments!',
    inputSchema: {
      type: 'object',
      properties: {
        workingOn: { type: 'string', description: 'What you are about to work on. If omitted, the system automatically infers it from your session prompt, git branch, or recent activity. Just call memory_bootstrap({}) — no arguments needed!' },
        project: { type: 'string', description: 'Project path (defaults to AGENTIC_CORTEX_PROJECT or cwd)' },
        includeStandards: { type: 'boolean', description: 'Include collapsed coding standards summary (default true)', default: true },
        includeGraph: { type: 'boolean', description: 'Include codebase graph summary (default true)', default: true },
        budgetTokens: { type: 'integer', description: 'Approximate token budget for context (default 4000)', default: 4000 },
      },
    },
  },
  {
    name: 'memory_learn_from_error',
    description: 'Report an error or shortcoming. Saves the error observation and automatically triggers root cause analysis — the system will generate a "learning" observation with a systemic fix. Use this whenever something goes wrong so the system improves over time.',
    inputSchema: {
      type: 'object',
      properties: {
        errorContent: { type: 'string', description: 'What went wrong — describe the error or shortcoming in detail' },
        project: { type: 'string', description: 'Project path (defaults to AGENTIC_CORTEX_PROJECT or cwd)' },
        importance: { type: 'integer', description: 'Importance 1-10', default: 8 },
        tags: { type: 'array', items: { type: 'string' }, description: 'Additional tags' },
      },
      required: ['errorContent'],
    },
  },
  {
    name: 'memory_record_action',
    description: 'Record an agent action as an intent→action→outcome triplet. Links all three via relations and runs evidence-based confidence scoring automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'What the agent tried to accomplish' },
        action: { type: 'string', description: 'What the agent actually did' },
        outcome: { type: 'string', description: 'What happened as a result' },
        project: { type: 'string', description: 'Project path' },
        agentId: { type: 'string', description: 'Agent identifier' },
        confidence: { type: 'integer', description: 'Initial confidence (default 90)', default: 90 },
      },
      required: ['intent', 'action', 'outcome'],
    },
  },
  {
    name: 'memory_transfer_knowledge',
    description: 'Transfer high-confidence observations from one project to another with a confidence decay modifier. Useful for sharing battle-tested learnings across projects.',
    inputSchema: {
      type: 'object',
      properties: {
        fromProject: { type: 'string', description: 'Source project path' },
        toProject: { type: 'string', description: 'Target project path' },
        types: { type: 'array', items: { type: 'string' }, description: 'Filter by observation types (e.g., ["learning", "instruction"])' },
        minConfidence: { type: 'integer', description: 'Minimum confidence to transfer (default 80)', default: 80 },
        confidenceModifier: { type: 'number', description: 'Multiplier for transferred confidence (default 0.8)', default: 0.8 },
      },
      required: ['fromProject', 'toProject'],
    },
  },
  {
    name: 'memory_machine_vault',
    description: '🌐 MACHINE-WIDE MEMORY — View and search the global vault: battle-tested learnings, instructions, and facts promoted from all projects on this machine. Acts as an immune system preventing repeated mistakes across projects. Use query to find relevant global knowledge for your current task.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'What to do: list (show all), search (find by relevance), analytics (cross-project insights)', default: 'list' },
        query: { type: 'string', description: 'Search query to find relevant global memories (for action=search)' },
        type: { type: 'string', description: 'Filter by observation type (learning, instruction, fact, decision)' },
        limit: { type: 'integer', description: 'Max results', default: 20 },
        minConfidence: { type: 'integer', description: 'Minimum confidence filter' },
      },
    },
  },
  {
    name: 'memory_promote_global',
    description: '⭐ Promote a high-quality observation to the machine-wide global vault. Once promoted, this knowledge will appear in bootstrap for ALL projects, preventing the same mistakes from repeating. Requires confidence >= 85 and predicted_utility >= 10 (or use force=true).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Observation ID to promote to global scope' },
        force: { type: 'boolean', description: 'Force promotion even if quality thresholds not met', default: false },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_search_all',
    description: '🔍 Search across ALL projects on this machine, not just the current one. Uses hybrid search (FTS5 + semantic) to find relevant memories from any project. Includes global vault memories. Great for finding if you solved a similar problem before in a different project.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query to find relevant memories across all projects' },
        type: { type: 'string', description: 'Filter by observation type' },
        limit: { type: 'integer', description: 'Max results', default: 20 },
        minConfidence: { type: 'integer', description: 'Minimum confidence filter' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_profile',
    description: '👤 ONE-CALL PROFILE — supermemory-style: returns the distilled profile of a project/agent as static (stable facts, decisions, preferences) + dynamic (recent activity, open goals) in a single fast call. Optionally combine with a query to also get searchResults in the same round trip. Inject directly into your system prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path (defaults to current)' },
        agentId: { type: 'string', description: 'Scope the profile to one agent (multi-agent namespace)' },
        q: { type: 'string', description: 'Optional query — also returns searchResults in the same call' },
        limit: { type: 'integer', description: 'Max entries per section (default 12)' },
      },
    },
  },
  {
    name: 'memory_search_hybrid',
    description: '🧬 UNIFIED SEARCH — memories AND code symbols in ONE query. Returns { memories, code } where memories are vault memories (hybrid FTS5+semantic) and code are matching functions/classes from the code index. The supermemory-style single-surface retrieval: knowledge base + code grounding together.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        project: { type: 'string', description: 'Project path (defaults to current)' },
        limit: { type: 'integer', description: 'Max memories (default 10)' },
        codeLimit: { type: 'integer', description: 'Max code symbols (default 5)' },
        code: { type: 'boolean', description: 'Include code index results (default true)', default: true },
        rerank: { type: 'boolean', description: 'Apply cross-encoder reranking to memories', default: false },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_expire',
    description: '⏳ TEMPORAL FORGETTING — expire memories whose lifespan (expires_at) has elapsed. Temporary facts ("I have an exam tomorrow") die on their date instead of lingering. Runs automatically in maintenance; call directly to sweep now. Also supersede an old memory with a new one (pass oldId + newId).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['sweep', 'supersede'], description: 'sweep = expire due memories; supersede = mark old memory replaced by new (default sweep)' },
        project: { type: 'string', description: 'Project path' },
        dryRun: { type: 'boolean', description: 'List what would expire without expiring', default: false },
        oldId: { type: 'integer', description: 'supersede: the memory being replaced' },
        newId: { type: 'integer', description: 'supersede: the memory replacing it' },
        reason: { type: 'string', description: 'supersede: why the old memory is replaced' },
      },
    },
  },
  {
    name: 'memory_ingest_transcript',
    description: 'Parse a conversation transcript and auto-extract structured observations (decisions, errors, learnings, preferences, facts). Uses regex with LLM fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Raw transcript text to parse' },
        project: { type: 'string', description: 'Project path' },
        agentId: { type: 'string', description: 'Agent identifier' },
        useLLM: { type: 'boolean', description: 'Use LLM for deeper extraction (default true)', default: true },
      },
      required: ['text'],
    },
  },
  {
    name: 'memory_feedback',
    description: 'Record explicit agent feedback on a memory. "helpful" boosts confidence and utility. "incorrect" decays confidence and flags for review.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Observation ID to give feedback on' },
        type: { type: 'string', description: 'Feedback type: helpful or incorrect', enum: ['helpful', 'incorrect'] },
        reason: { type: 'string', description: 'Why this feedback (saved as audit trail)' },
      },
      required: ['id', 'type'],
    },
  },
  {
    name: 'memory_trail',
    description: 'Walk the memory relation graph to surface a readable narrative trail. Follows derives_from, produces, achieves, depends_on, supersedes, refines relations.',
    inputSchema: {
      type: 'object',
      properties: {
        observationId: { type: 'integer', description: 'Starting observation ID' },
        depth: { type: 'integer', description: 'Traversal depth (default 5, max 10)', default: 5 },
        direction: { type: 'string', description: 'Walk direction: forward, backward, or both', default: 'both' },
      },
      required: ['observationId'],
    },
  },
  {
    name: 'memory_utility_stats',
    description: 'Get the most and least useful memories for a project, ranked by access count. Helps identify which memories agents actually use.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path' },
        limit: { type: 'integer', description: 'Max results per category (default 10)', default: 10 },
      },
    },
  },
  {
    name: 'memory_freshness',
    description: 'Show memory freshness scores or auto-archive stale memories below a threshold. Freshness combines access recency, confidence, and predicted utility into a 0-100 score that naturally decays over time.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'What to do: scores (show distribution), update (recompute all scores), archive (auto-archive stale)', default: 'scores' },
        project: { type: 'string', description: 'Project path' },
        threshold: { type: 'integer', description: 'Freshness threshold for archiving (default 15)', default: 15 },
        dryRun: { type: 'boolean', description: 'Preview without making changes', default: false },
      },
    },
  },
  {
    name: 'memory_maintenance',
    description: 'Run the full maintenance cycle: update freshness scores, auto-archive stale memories, and run utility decay. Can also run automatically via the post_save hook every ~50 saves.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path' },
        dryRun: { type: 'boolean', description: 'Preview without making changes', default: false },
        maxAgeDays: { type: 'integer', description: 'Max age in days for decay (default 30)', default: 30 },
      },
    },
  },
  {
    name: 'memory_analytics',
    description: 'Surface self-improving loop analytics: RCA effectiveness, conflict health, utility distribution, feedback ratio, and freshness distribution. See how well the system is learning.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path' },
      },
    },
  },
  {
    name: 'memory_standards',
    description: 'Access pre-loaded coding standards (DRY, KISS, SOLID, Clean Code, Karpathy). Standards are auto-seeded on init and always injected into context — no command needed. This tool is for explicit querying only.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'What to do: list (show all), search (find by query), seed (force re-seed)', default: 'list' },
        query: { type: 'string', description: 'Search query (for action=search)' },
        phase: { type: 'string', description: 'Filter by phase: planning, implementation, review, all' },
        category: { type: 'string', description: 'Filter by category: karpathy, solid, dry, kiss, yagni, clean-code, general' },
        project: { type: 'string', description: 'Project path' },
        limit: { type: 'integer', description: 'Max results', default: 20 },
      },
    },
  },
  {
    name: 'memory_crystallize',
    description: '🧊 CRYSTALLIZE — Compress raw observations upward through tiered layers (raw→synthesis→principle). AutoGTM\'s compounding brain: high-confidence syntheses verified 3+ times harden into principles that are always injected and rarely adjusted.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path' },
        fromLayer: { type: 'integer', description: 'Layer to compress from (1=raw, 2=synthesis)', default: 1 },
        minCount: { type: 'integer', description: 'Minimum raw observations to form a synthesis', default: 3 },
        dryRun: { type: 'boolean', description: 'Preview without making changes', default: false },
      },
    },
  },
  {
    name: 'memory_experiment',
    description: '🧪 HYPOTHESIS TESTING — Spawn or list controlled experiments. AutoGTM\'s single-variable experiment loop: when the same error tag appears 3+ times, the system auto-spawns experiments that change ONE variable and measure against a fixed metric.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'What to do: spawn (create experiment), list (show active)', default: 'list' },
        errorTag: { type: 'string', description: 'Error tag to spawn experiment for (required for action=spawn)' },
        project: { type: 'string', description: 'Project path' },
        limit: { type: 'integer', description: 'Max results for list', default: 20 },
      },
    },
  },
  {
    name: 'memory_eval_log',
    description: '📊 IMMUTABLE AUDIT TRAIL — Query the append-only evaluation log. AutoGTM\'s results.tsv: every evaluation is preserved forever for benchmarking and plateau detection. Use --stats for aggregate metrics. Each row carries attribution provenance: injected (count of linked memories), injectedSources ({manual, auto, session}), autoAttributed (linked via search, not manually wired), clearlyAuto (time-window auto-link), viaSession (endAgentSession), and linkProvenance (none|manual|auto|session).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path' },
        verdict: { type: 'string', description: 'Filter by verdict: SUCCESS, FAILURE, NEUTRAL, REINFORCE, CONTRADICT' },
        limit: { type: 'integer', description: 'Max rows', default: 50 },
        stats: { type: 'boolean', description: 'Return aggregate stats instead of raw rows', default: false },
      },
    },
  },
  {
    name: 'memory_outcome_stats',
    description: '📈 PROVEN-GOOD MEMORIES — Query which memories are proven-good or proven-bad by eval-outcome history. Each injected memory\'s verdict record is correlated (eval_memory_injections JOIN evaluation_log): weight +1 = always injected into successes, -1 = always failures, 0 = below the min-runs threshold or no signal. Consult before relying on a memory: prefer weight > 0 over unproven or negative-weight memories.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path' },
        minRuns: { type: 'integer', description: 'Minimum recorded eval runs before a memory gets a non-zero weight', default: 2 },
        minWeight: { type: 'number', description: 'Only return memories with weight >= this value (e.g. 0.5 for proven-good only)', default: -1 },
        limit: { type: 'integer', description: 'Max memories to return', default: 50 },
      },
    },
  },
  {
    name: 'memory_fsm',
    description: '🧠 FSM ORCHESTRATION — Manage the agent brain state machine: start agents in workflows, transition between states, query current state. The brain\'s executive function — tracks where every agent is and what comes next.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'What to do: start (begin machine), transition (move state), state (query current), list-machines (show available)', default: 'state' },
        machineName: { type: 'string', description: 'Machine name: coding-workflow, debug-workflow, review-workflow (for action=start)' },
        agentId: { type: 'string', description: 'Agent identifier (defaults to AGENTIC_CORTEX_AGENT_ID env var)', default: 'default' },
        trigger: { type: 'string', description: 'Transition trigger (for action=transition): plan_approved, tests_pass, review_approved, etc.' },
        project: { type: 'string', description: 'Project path' },
      },
    },
  },
  {
    name: 'memory_rules',
    description: '📋 RULE ENGINE — Manage declarative brain rules: list, delete, enable/disable, or evaluate manually. Rules fire automatically on post_save and state_transition events.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'What to do: list, delete, enable, disable, evaluate', default: 'list' },
        id: { type: 'integer', description: 'Rule ID (for delete/enable/disable)' },
        event: { type: 'string', description: 'Filter by event or evaluate event: post_save, state_transition, manual' },
        project: { type: 'string', description: 'Project path (for evaluate)' },
      },
    },
  },
  {
    name: 'memory_workflow',
    description: '⚡ WORKFLOW EXECUTOR — Run multi-step procedures with dependency ordering: start, advance steps, check progress, cancel. Built-in workflows: deploy-pipeline, bug-fix-cycle, memory-maintenance, plus multi-agent: code-review-team, incident-response-squad.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'What to do: list, start, advance, get, cancel, agents (list sub-agents)', default: 'list' },
        workflowName: { type: 'string', description: 'Workflow name (for action=start)' },
        instanceId: { type: 'integer', description: 'Instance ID (for advance/get/cancel/agents)' },
        agentId: { type: 'string', description: 'Agent identifier' },
        project: { type: 'string', description: 'Project path' },
      },
    },
  },
  {
    name: 'memory_workflow_agents',
    description: '🤖 MULTI-AGENT WORKFLOW — List all sub-agents spawned by a multi-agent workflow instance. Each step with agentRole config creates an FSM-tracked sub-agent. Use this to inspect multi-agent collaboration state.',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'integer', description: 'Workflow instance ID to inspect sub-agents for' },
      },
      required: ['instanceId'],
    },
  },
  {
    name: 'memory_prompts_list',
    description: '📝 PROMPT REGISTRY — List all available prompt templates in the registry. Each template has a name, version, description, and outcome tracking flag. Layer 1 of Graph Engineering: Prompt Engineering.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'memory_prompts_render',
    description: '🎨 PROMPT RENDERING — Render a prompt template with variable substitution. Returns the system message, user message, and default LLM params. Use this to inspect or use templates by name (e.g., classify-outcome, rca-from-error, design-experiment).',
    inputSchema: {
      type: 'object',
      properties: {
        templateName: { type: 'string', description: 'Template name: classify-outcome, rca-from-error, consolidate-observations, promote-pattern, resolve-conflict, verify-learning, design-experiment, extract-skill, crystallize-raw-to-synthesis, analyze-plateau' },
        vars: { type: 'object', description: 'Variable substitutions for the template (e.g., { "outcomeText": "test passed" })' },
      },
      required: ['templateName'],
    },
  },
  {
    name: 'memory_plateau_check',
    description: '📉 PLATEAU DETECTION — Check if the self-improvement loop has stalled for a project. Analyzes the evaluation log to detect flatlining success rates. When a plateau is found, triggers LLM analysis for breakthrough strategies and saves a learning observation. Layer 4 of Graph Engineering: Loop Engineering.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path (defaults to AGENTIC_CORTEX_PROJECT or cwd)' },
        windowDays: { type: 'integer', description: 'Days to analyze for stall detection (default 7)', default: 7 },
        force: { type: 'boolean', description: 'Bypass debounce check (default false)', default: false },
      },
    },
  },
  {
    name: 'memory_provider',
    description: '🔍 DISCOVER — Self-describing provider manifest. Call this to discover agentic-cortex as a memory provider/extender: name, version, memory/relation types, multi-agent mailbox, workflows, and usage instructions.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'memory_manifest',
    description: '📜 MANIFEST — Machine-readable capability manifest (schema v1.0.0). Lists all 40+ capabilities (memory, code, reasoning, learning, audit, orchestration, integration) with versions and the interfaces each is exposed via. Use for feature-detection before composing agentic-cortex with another framework.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path for scoped manifest output' },
        write: { type: 'boolean', description: 'Also write agentic-cortex.manifest.json to the project' },
      },
    },
  },
  {
    name: 'memory_discover',
    description: '🕵️ DISCOVER FRAMEWORKS — Scan the machine for agent frameworks agentic-cortex can compose with (Claude Code, Cursor, OpenCode, generic MCP clients). Returns evidence: config files found, registered MCP servers, env vars. Pair with memory_compose for wiring.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path to scan (default cwd)' },
      },
    },
  },
  {
    name: 'memory_compose',
    description: '🔗 COMPOSE — Return the exact wiring to compose agentic-cortex with a discovered agent framework: which MCP config to write, which memory/reasoning/audit/orchestration tools to expose. Input: framework id (claude-code, cursor, opencode, freebuff, gemini-cli, codex, windsurf, zed, goose, …) or a discovered framework object.',
    inputSchema: {
      type: 'object',
      properties: {
        framework: { type: 'string', description: 'Framework id — see memory_discover' },
        project: { type: 'string', description: 'Project path' },
      },
      required: ['framework'],
    },
  },
  {
    name: 'memory_wireup',
    description: '🔌 WIREUP — Hard-wire agentic-cortex into every AI coding agent detected on this machine/project (Claude Code, Cursor, OpenCode, Freebuff, Gemini CLI, Copilot, Windsurf, Zed, Roo, Cline, Goose, Codex, …). Merges the AC MCP server into each agent\'s JSON config and injects the bootstrap/auto-save instruction section into their instruction files. Idempotent. Set dryRun=true to preview.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path (default cwd)' },
        dryRun: { type: 'boolean', description: 'Report what would change without writing' },
        only: { type: 'array', items: { type: 'string' }, description: 'Restrict to these framework ids' },
        skip: { type: 'array', items: { type: 'string' }, description: 'Skip these framework ids' },
      },
    },
  },
  {
    name: 'memory_send',
    description: 'Send a message/task/handoff to another agent\'s mailbox (inter-agent event primitive). The recipient reads it via memory_inbox.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient agent ID' },
        from: { type: 'string', description: 'Sender agent ID (defaults to AGENTIC_CORTEX_AGENT_ID)' },
        subject: { type: 'string', description: 'Message subject' },
        body: { type: 'string', description: 'Message body (required)' },
        kind: { type: 'string', description: 'Message kind: message, task, handoff, result', default: 'message' },
        refObservationId: { type: 'integer', description: 'Related observation ID (e.g., the goal/task this message concerns)' },
      },
      required: ['to', 'body'],
    },
  },
  {
    name: 'memory_inbox',
    description: 'Read the caller agent\'s mailbox (messages addressed to it).',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID whose inbox to read (defaults to AGENTIC_CORTEX_AGENT_ID)' },
        unreadOnly: { type: 'boolean', description: 'Only unread messages', default: true },
        kind: { type: 'string', description: 'Filter by kind: task, result, handoff, message' },
        limit: { type: 'integer', description: 'Max results', default: 50 },
      },
    },
  },
  {
    name: 'memory_mark_read',
    description: 'Mark a mailbox message as read.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Message ID to mark read' },
      },
      required: ['id'],
    },
  },

  // ── v6.3.0: Test-time compute reasoning (Phase 20) ────────────
  {
    name: 'memory_coverage_probe',
    description: '🕳️ BLIND-SPOT PROBE — Assess whether retrieved memories cover a query and return explicit missing-evidence questions. Use before trusting a narrow top-k result.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Question or task to assess' },
        project: { type: 'string', description: 'Project path' },
        limit: { type: 'number', description: 'Number of memories to retrieve', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_tree_search',
    description: '🌳 TREE SEARCH — Run Tree of Thoughts / MCTS reasoning on a problem. Explores multiple reasoning branches, verifies each step with PRM, prunes invalid paths, and backtracks. Uses adaptive compute budget: harder problems get more exploration. Strategies: auto (default), beam, mcts, greedy.',
    inputSchema: {
      type: 'object',
      properties: {
        problem: { type: 'string', description: 'Problem to solve via tree search' },
        project: { type: 'string', description: 'Project path' },
        strategy: { type: 'string', description: 'Search strategy: auto, beam, mcts, greedy', default: 'auto' },
        beamWidth: { type: 'number', description: 'Override beam width (number of branches per node)' },
        maxDepth: { type: 'number', description: 'Override max search depth' },
        tokenBudget: { type: 'number', description: 'Override token budget' },
      },
      required: ['problem'],
    },
  },
  {
    name: 'memory_verify_step',
    description: '🔍 STEP VERIFIER — Verify a single reasoning step using 3-tier Process Reward Model: deterministic checks, LLM-as-judge, and memory cross-check. Returns a score 0.0-1.0 and whether the step is valid.',
    inputSchema: {
      type: 'object',
      properties: {
        stepContent: { type: 'string', description: 'The reasoning step to verify' },
        priorSteps: { type: 'array', items: { type: 'string' }, description: 'Previous steps in the chain for context' },
        problem: { type: 'string', description: 'The original problem being solved' },
        stepType: { type: 'string', description: 'Step type: reasoning, code, or plan', default: 'reasoning' },
        project: { type: 'string', description: 'Project path' },
      },
      required: ['stepContent'],
    },
  },
  {
    name: 'memory_budget',
    description: '📊 ADAPTIVE BUDGET — Estimate problem difficulty and calculate optimal compute allocation. Returns beam width, max depth, token budget, and recommended strategy based on memory history and complexity signals.',
    inputSchema: {
      type: 'object',
      properties: {
        problem: { type: 'string', description: 'Problem description to estimate' },
        project: { type: 'string', description: 'Project path' },
        beamWidth: { type: 'number', description: 'Override beam width' },
        maxDepth: { type: 'number', description: 'Override max depth' },
      },
      required: ['problem'],
    },
  },
  {
    name: 'memory_verify_code',
    description: '💻 PROGRAM-AIDED VERIFICATION — Generate and execute a verification script for a coding hypothesis. Uses PAL/PoT pattern: LLM generates code, runs it in a sandbox, and feeds results back. Deterministic verification without retraining.',
    inputSchema: {
      type: 'object',
      properties: {
        hypothesis: { type: 'string', description: 'What to verify (e.g., "auth.ts handles null profiles")' },
        context: { type: 'string', description: 'Code context (file paths, function signatures)' },
        project: { type: 'string', description: 'Project root for file access' },
      },
      required: ['hypothesis'],
    },
  },
  {
    name: 'memory_reflexion',
    description: '🔄 REFLEXION — Record a failed reasoning path as a self-correction. Extracts a critique, saves as context memory, and prevents the agent from repeating the same mistake. Call this when a reasoning approach fails.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Current session ID' },
        problem: { type: 'string', description: 'Original problem' },
        failedPath: { type: 'string', description: 'The reasoning steps that failed' },
        verificationError: { type: 'string', description: 'Why it was rejected' },
        strategy: { type: 'string', description: 'What approach was tried' },
        project: { type: 'string', description: 'Project path' },
      },
      required: ['sessionId', 'problem', 'failedPath', 'verificationError'],
    },
  },
  {
    name: 'memory_coverage_probes',
    description: '📋 COVERAGE PROBES — List unresolved blind-spot questions created by retrieval coverage checks.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, status: { type: 'string', default: 'open' }, limit: { type: 'number', default: 20 } } },
  },
  {
    name: 'memory_resolve_coverage_probe',
    description: '✅ RESOLVE COVERAGE PROBE — Mark a blind-spot question resolved with supporting memory evidence.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' }, observationId: { type: 'integer' } }, required: ['id'] },
  },
  {
    name: 'memory_reasoning_trace',
    description: '📜 REASONING TRACE — View a saved reasoning trace (Tree of Thoughts / MCTS execution log). Shows all explored branches, PRM scores, pruned paths, and the best solution found.',
    inputSchema: {
      type: 'object',
      properties: {
        traceId: { type: 'integer', description: 'Reasoning trace ID to view' },
      },
      required: ['traceId'],
    },
  },
  {
    name: 'memory_reasoning_stats',
    description: '📊 REASONING ANALYTICS — Aggregate stats for test-time compute reasoning: total traces, success rate, difficulty distribution, pruning effectiveness, per-strategy performance, PRM score distribution, and the best-performing strategy.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path (defaults to current project)' },
      },
    },
  },
  {
    name: 'memory_synthesize_solution',
    description: '🧬 SYNTHESIZE SOLUTION — Merge insights from all explored branches of a reasoning trace into a final synthesized answer. Uses LLM to combine the best parts of terminal (goal-reached) paths, active exploration paths, and pruned-path warnings. Falls back to deterministic best-path merging when LLM is unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        traceId: { type: 'integer', description: 'Reasoning trace ID to synthesize a solution from' },
      },
      required: ['traceId'],
    },
  },

  // ── v6.4.0: Self-consistency + Budget forcing (Phase 21) ─────
  {
    name: 'memory_self_consistency',
    description: '🗳️ SELF-CONSISTENCY — Sample N independent reasoning chains with high temperature and majority-vote the answer. If the model has 80% per-step accuracy on a 5-step problem, a single greedy chain has only ~33% success — but 40 sampled chains recover the truth with high probability. Optionally weights votes by PRM scores so higher-quality paths have more influence.',
    inputSchema: {
      type: 'object',
      properties: {
        problem: { type: 'string', description: 'Problem to solve via self-consistency' },
        project: { type: 'string', description: 'Project path' },
        samples: { type: 'number', description: 'Number of independent chains to sample (default 5, max 40)', default: 5 },
        temperature: { type: 'number', description: 'Sampling temperature for diversity (default 0.8)', default: 0.8 },
        usePrmWeighting: { type: 'boolean', description: 'Weight votes by PRM chain scores (default true)', default: true },
      },
      required: ['problem'],
    },
  },
  {
    name: 'memory_budget_force',
    description: '💪 BUDGET FORCING — s1-style reasoning depth control. Forces the model to think deeper by suppressing early stops (lower-bound forcing) and capping infinite loops (upper-bound truncation). Uses doubt heuristics like "Wait, let me rethink..." to push the model through multiple reasoning rounds, then forces conclusion synthesis. Single chain, forced deeper.',
    inputSchema: {
      type: 'object',
      properties: {
        problem: { type: 'string', description: 'Problem to solve with forced deep reasoning' },
        minTokens: { type: 'number', description: 'Minimum reasoning tokens before allowing a stop (default 200)', default: 200 },
        maxTokens: { type: 'number', description: 'Maximum total tokens before forcing conclusion (default 6000)', default: 6000 },
        maxRounds: { type: 'number', description: 'Maximum continuation rounds before force-concluding (default 5)', default: 5 },
        temperatureBase: { type: 'number', description: 'Starting temperature (decays each round)', default: 0.6 },
      },
      required: ['problem'],
    },
  },

  // ── v6.5.0: Failure classifier + Exp replay + Translations (Phase 22-24) ─────
  {
    name: 'memory_classify_failure',
    description: '🔍 FAILURE CLASSIFIER — Deterministically classify an error message into a condition family (network/timeout/file/element/app/auth/parse/other), extract a probe target, and suggest the corrected approach. No LLM: pure regex + heuristics.',
    inputSchema: {
      type: 'object',
      properties: {
        errorText: { type: 'string', description: 'Error message to classify' },
      },
      required: ['errorText'],
    },
  },
  {
    name: 'memory_retry_check',
    description: '🔁 RETRY GATE — Check whether the underlying condition behind a failure has actually changed. Probes the network/file/app condition with live checks before offering a retry. Only offers a re-run when the cause is confirmed cleared.',
    inputSchema: {
      type: 'object',
      properties: {
        commandKey: { type: 'string', description: 'Normalized command key from the failure' },
        project: { type: 'string', description: 'Project path' },
      },
      required: ['commandKey'],
    },
  },
  {
    name: 'memory_failure_lessons',
    description: '📋 FAILURE LESSONS — List all failure lessons for a project, grouped by condition kind with aggregated stats.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path' },
      },
    },
  },
  {
    name: 'memory_experience_scripts',
    description: '📜 EXPERIENCE REPLAY — List all learned scripts (successful operations recorded as deterministic replays). Each script shows runs/successes/failures and estimated LLM cost saved.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path' },
        limit: { type: 'number', description: 'Max scripts to list', default: 50 },
      },
    },
  },
  {
    name: 'memory_translation_lookup',
    description: '📖 TRANSLATION LOOKUP — Check if a problem/input has a cached deterministic resolution. Every hit avoids an LLM call. Returns the cached solution + uses counter.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Namespace — "problem" | "verify"', default: 'problem' },
        key: { type: 'string', description: 'Normalized input key' },
        project: { type: 'string', description: 'Project path' },
      },
      required: ['namespace', 'key'],
    },
  },

  // ── v6.5.0: Burst budget + War room + Reasoner + Swarm (Phase 25-28) ─────
  {
    name: 'memory_burst_check',
    description: '🛡️ BURST BUDGET — Check whether a tool is allowed to run within the rolling-window burst budget. Returns allowed/reason/remaining. Guards against runaway autonomous actions.',
    inputSchema: {
      type: 'object',
      properties: {
        toolName: { type: 'string', description: 'Tool name to check' },
        project: { type: 'string', description: 'Project path' },
        allowlist: { type: 'array', items: { type: 'string' }, description: 'Allowed tools' },
        windowMs: { type: 'number', description: 'Rolling window in ms (default 300000 = 5 min)' },
        maxPerWindow: { type: 'number', description: 'Max actions per window (default 5)' },
      },
      required: ['toolName'],
    },
  },
  {
    name: 'memory_burst_reset',
    description: '🔓 RESET CIRCUIT BREAKER — Manually reset the burst-budget circuit breaker after it tripped. Fresh budget, no pending state.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path' },
      },
    },
  },
  {
    name: 'memory_war_room_scoreboard',
    description: '🏟️ WAR ROOM SCOREBOARD — View the self-improvement arena results: rounds, per-difficulty averages, best/worst scores, trend, and recent round details.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path' },
      },
    },
  },
  {
    name: 'memory_reason_deduce',
    description: '🧠 DEDUCTION — Run transitive-closure reasoning over the knowledge graph + detect contradictions between opposing principles. Returns inferred insights.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic to deduce about' },
        project: { type: 'string', description: 'Project path' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'memory_reason_induce',
    description: '🔬 INDUCTION — Generalize recurring concepts across many observations into a reusable principle. Confidence ∝ support (observation count).',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic to induce patterns from' },
        project: { type: 'string', description: 'Project path' },
        minSupport: { type: 'number', description: 'Minimum observation count to generalize (default 3)' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'memory_reason_analogize',
    description: '🔄 ANALOGY — Find past solutions matching the current topic and propose transferring that approach. Searches for high-confidence, solution-tagged observations.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic to find analogies for' },
        project: { type: 'string', description: 'Project path' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'memory_reason_abduce',
    description: '💡 ABDUCTION — Rank candidate explanations by causal signals (because, root cause, fixed by) in the knowledge base. Emits the best explanation as a hypothesis.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic to abduce explanations for' },
        project: { type: 'string', description: 'Project path' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'memory_reason_synthesize',
    description: '🧩 SYNTHESIS — Combine related memories sharing a subject into a single multi-angle derived fact.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Subject to synthesize' },
        project: { type: 'string', description: 'Project path' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'memory_reason_forecast',
    description: '📈 FORECAST — Extract numeric series (years, versions, counts) from observations, fit a trend line, and extrapolate the next value.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic to forecast trends for' },
        project: { type: 'string', description: 'Project path' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'memory_reason_all',
    description: '🧠 REASON ALL — Run all six deterministic inference modes (deduction, induction, analogy, abduction, synthesis, forecast) over a topic and persist insights that clear the confidence floor. Grows the knowledge base.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Topic to reason about' },
        project: { type: 'string', description: 'Project path' },
        modes: { type: 'string', description: 'Comma-separated modes (default all: deduction,induction,analogy,abduction,synthesis,forecast)' },
        minConfidence: { type: 'number', description: 'Min confidence to persist (default 50)', default: 50 },
        maxInsights: { type: 'number', description: 'Max insights to persist (default 10)', default: 10 },
      },
      required: ['topic'],
    },
  },
  {
    name: 'memory_swarm_decompose',
    description: '🐝 SWARM DECOMPOSE — Break a goal into a dependency DAG and dispatch subtasks to role-based personas (analyzer → planner → coder → tester → reviewer → verifier → orchestrator). Tasks coordinate through the shared brain.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'High-level goal to decompose' },
        project: { type: 'string', description: 'Project path' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'memory_swarm_progress',
    description: '📊 SWARM PROGRESS — Check the status of a decomposed goal: how many tasks pending/running/completed/failed, plus per-role results.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Goal to check progress for' },
        project: { type: 'string', description: 'Project path' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'memory_swarm_start_task',
    description: '🐝 SWARM START — Mark a task as started (running). Returns the task details including role and description.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to start' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'memory_swarm_complete_task',
    description: '✅ SWARM COMPLETE — Mark a task as completed with a result summary. Unblocks dependent tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to complete' },
        summary: { type: 'string', description: 'Summary of what was accomplished' },
        obsId: { type: 'string', description: 'Optional observation ID linking to stored result' },
      },
      required: ['taskId', 'summary'],
    },
  },
  {
    name: 'memory_swarm_fail_task',
    description: '❌ SWARM FAIL — Mark a task as failed with a reason. Triggers replanning for the goal.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to fail' },
        reason: { type: 'string', description: 'Why the task failed' },
      },
      required: ['taskId', 'reason'],
    },
  },
  {
    name: 'memory_swarm_next_task',
    description: '🐝 SWARM NEXT — Get the next ready task for a role (only tasks whose dependencies are complete).',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Role to fetch the next task for (analyzer, planner, coder, tester, reviewer, verifier, orchestrator)' },
        project: { type: 'string', description: 'Project path' },
      },
      required: ['role'],
    },
  },
  {
    name: 'memory_swarm_status',
    description: '🐝 SWARM STATUS — List all active goals and their overall execution state.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path' },
      },
    },
  },
  {
    name: 'memory_swarm_synthesize',
    description: '🐝 SWARM SYNTHESIZE — Merge all task results into a unified final report for a completed goal.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Goal to synthesize' },
        project: { type: 'string', description: 'Project path' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'memory_swarm_execute',
    description: '⚡ SWARM EXECUTE — Run a single swarm task. Default: persona-specific reasoning engine (Analyzer→beam search, Planner→budget-forcing, Coder→MCTS, Tester→self-consistency, Reviewer→beam search, Verifier→budget-forcing, Reasoner→deterministic, Orchestrator→synthesize). With workerMode=process, launches a real agent subprocess (Claude Code/OpenCode/Cursor) so the coder actually edits files and the tester actually runs tests.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'number', description: 'Task ID to execute' },
        project: { type: 'string', description: 'Project path' },
        dryRun: { type: 'boolean', description: 'If true, return the execution plan without running' },
        workerMode: { type: 'string', description: 'process | in-process — use a real agent subprocess (default: in-process)' },
        workerFramework: { type: 'string', description: 'Framework id: claude-code | opencode | cursor' },
        worker: { type: 'string', description: 'Explicit worker config as JSON: { command, args?, env?, timeoutMs?, cwd?, framework? }' },
        workerRoles: { type: 'array', items: { type: 'string' }, description: 'Only these roles use the worker (e.g. [coder, tester])' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'memory_swarm_execute_pipeline',
    description: '⚡ SWARM EXECUTE ALL — Run all pending tasks for a goal through a bounded worker pool. Independent DAG branches run concurrently (concurrency cap). Runs a closed failure loop: transient failures are retried with backoff, exhausted tasks are replanned as fresh attempts, and beyond the attempt budget they escalate to the war room. With workerMode=process, runnable tasks launch real agent subprocesses instead of in-process reasoning engines.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Goal whose tasks to execute' },
        project: { type: 'string', description: 'Project path' },
        dryRun: { type: 'boolean', description: 'If true, return the execution plan without running' },
        concurrency: { type: 'number', description: 'Worker-pool size — max simultaneous tasks (default 4)' },
        maxRounds: { type: 'number', description: 'Round budget for the failure loop' },
        waitRetries: { type: 'boolean', description: 'Wait out backoff windows within the run (default true)' },
        workerMode: { type: 'string', description: 'process | in-process — launch real agent subprocesses (default: in-process)' },
        workerFramework: { type: 'string', description: 'Framework id: claude-code | opencode | cursor' },
        worker: { type: 'string', description: 'Explicit worker config as JSON: { command, args?, env?, timeoutMs?, cwd?, framework? }' },
        workerRoles: { type: 'array', items: { type: 'string' }, description: 'Only these roles use the worker (e.g. [coder, tester])' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'memory_swarm_worker_info',
    description: '🤖 SWARM WORKER INFO — Report the worker wiring: enabled mode, resolved worker (framework, command, args, timeout, availability), and which agent frameworks were discovered on this machine. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path to scan for frameworks' },
      },
    },
  },
  {
    name: 'memory_swarm_plan_import',
    description: '🗂️ SWARM PLAN IMPORT — Import the .swarm plan (plan.json / SWARM_PLAN.json / latest ledger snapshot) into swarm_tasks: each plan task becomes a coder task + one QA-gate task per selected gate (reviewer → reviewer, test_engineer → tester, hallucination_guard → verifier), dependencies chained from the plan. Idempotent.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path containing .swarm/' },
        gates: { type: 'array', items: { type: 'string' }, description: 'QA gates (default: parsed from .swarm/context.md)' },
      },
      required: ['project'],
    },
  },
  {
    name: 'memory_swarm_plan_run',
    description: '▶️ SWARM PLAN RUN — Import the .swarm plan, execute it through the core engine (parallel pool, failure loop, optional worker mode), and sync results back to plan.json + the plan-ledger. One source of truth: the plan drives swarm_tasks, execution writes back.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path containing .swarm/' },
        concurrency: { type: 'number', description: 'Worker-pool size (default 4)' },
        workerMode: { type: 'string', description: 'process | in-process — launch real agent subprocesses for tasks' },
        workerFramework: { type: 'string', description: 'Framework id: claude-code | opencode | cursor' },
        worker: { type: 'string', description: 'Explicit worker config as JSON: { command, args?, env?, timeoutMs?, cwd?, framework? }' },
      },
      required: ['project'],
    },
  },
  {
    name: 'memory_swarm_plan_sync',
    description: '🔄 SWARM PLAN SYNC — Write the engine\'s swarm_tasks statuses back into .swarm/plan.json and append task_status_changed + snapshot events to the plan-ledger (with plan hashes). Call after executing imported tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path containing .swarm/' },
      },
      required: ['project'],
    },
  },
  {
    name: 'memory_swarm_plan_info',
    description: '📋 SWARM PLAN INFO — Summarize the .swarm plan (phases, task counts, statuses), QA gate selection, ledger depth, and how many tasks are imported into swarm_tasks. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path containing .swarm/' },
      },
      required: ['project'],
    },
  },
  {
    name: 'memory_swarm_replan_goal',
    description: '🔄 SWARM REPLAN — Re-decompose every permanently failed task of a goal (plus its not-yet-completed dependents) into fresh attempts. Past the attempt budget, tasks are escalated to the war room instead.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Goal to replan' },
        project: { type: 'string', description: 'Project path' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'memory_swarm_escalations',
    description: '🚨 SWARM ESCALATIONS — List swarm tasks that exhausted their retry/replan budget and were escalated to the war room (with failure class, last error, and suggestion).',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Optional goal filter' },
        project: { type: 'string', description: 'Project path' },
      },
    },
  },
  {
    name: 'memory_swarm_retry_now',
    description: '⏱️ SWARM RETRY NOW — Clear a task\'s backoff window so it is immediately pickable again by the next get-next/execute call.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'number', description: 'Task ID to force-retry' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'memory_swarm_job_create',
    description: '🗂️ SWARM JOB CREATE — Enqueue a goal as a persistent job in the swarm_jobs queue. The queue survives restarts: run the job later with memory_swarm_job_run, and it resumes from where the DAG left off.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Goal to run as a job' },
        project: { type: 'string', description: 'Project path' },
        concurrency: { type: 'number', description: 'Worker-pool size (default 4)' },
        maxRounds: { type: 'number', description: 'Round budget for the failure loop' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'memory_swarm_job_run',
    description: '▶️ SWARM JOB RUN — Run (or resume) a queued/paused job. If the process died mid-run, tasks left running are recovered to pending and the DAG continues. Independent branches execute concurrently up to the job\'s concurrency limit.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'number', description: 'Job ID to run' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'memory_swarm_jobs',
    description: '🗂️ SWARM JOBS — List swarm jobs (optionally filtered by project/status) with their round progress and completion counts.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path filter' },
        status: { type: 'string', description: 'Status filter: queued | running | paused | completed | failed | canceled' },
        limit: { type: 'number', description: 'Max rows (default 50)' },
      },
    },
  },
  {
    name: 'memory_swarm_job_cancel',
    description: '⏹️ SWARM JOB CANCEL — Cancel a queued/running job. A running job stops at its next round checkpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'number', description: 'Job ID to cancel' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'memory_experience_record',
    description: '📝 EXPERIENCE RECORD — Save a successful operation as a deterministic replay script. Next call to replay skips LLM entirely.',
    inputSchema: {
      type: 'object',
      properties: {
        commandKey: { type: 'string', description: 'Unique key for this operation (e.g. resolve-imports)' },
        steps: { type: 'string', description: 'JSON-serialized steps or description of the operation' },
        expectedOutput: { type: 'string', description: 'Expected output pattern for validation' },
        llmCallsSaved: { type: 'number', description: 'How many LLM calls this replay avoids', default: 1 },
        project: { type: 'string', description: 'Project path' },
      },
      required: ['commandKey', 'steps'],
    },
  },
  {
    name: 'memory_experience_replay',
    description: '▶️ EXPERIENCE REPLAY — Execute a previously recorded script deterministically. Zero LLM calls.',
    inputSchema: {
      type: 'object',
      properties: {
        commandKey: { type: 'string', description: 'Key of the recorded script to replay' },
        project: { type: 'string', description: 'Project path' },
      },
      required: ['commandKey'],
    },
  },
  {
    name: 'memory_experience_stats',
    description: '📊 EXPERIENCE STATS — Show how many scripts are recorded, total replays, and total LLM calls saved.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path' },
      },
    },
  },
  {
    name: 'memory_experience_autodetect',
    description: '🔍 EXPERIENCE AUTO-DETECT — Fuzzy-match a problem against stored experience scripts. Returns the best replay candidates with match scores. Use before expensive tree search to find deterministic replays at zero LLM cost.',
    inputSchema: {
      type: 'object',
      properties: {
        problem: { type: 'string', description: 'Current task description to match against stored scripts' },
        minScore: { type: 'number', description: 'Minimum overlap score (default 0.3)', default: 0.3 },
        project: { type: 'string', description: 'Project path' },
      },
      required: ['problem'],
    },
  },
  {
    name: 'memory_translation_store',
    description: '📖 TRANSLATION STORE — Resolve an input once via LLM (or manual mapping), store the result, and replay it deterministically from then on.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Translation namespace (e.g. problem, command, query)', default: 'problem' },
        key: { type: 'string', description: 'Input text to map' },
        payload: { type: 'string', description: 'JSON-serialized resolved output' },
        project: { type: 'string', description: 'Project path' },
      },
      required: ['namespace', 'key', 'payload'],
    },
  },
  {
    name: 'memory_translation_stats',
    description: '📖 TRANSLATION STATS — Show how many translations are stored and how many LLM calls have been saved.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path' },
      },
    },
  },
  {
    name: 'memory_translation_list',
    description: '📖 TRANSLATION LIST — List all stored translations, optionally filtered by namespace.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Filter by namespace' },
        limit: { type: 'number', description: 'Max results (default 50)', default: 50 },
        project: { type: 'string', description: 'Project path' },
      },
    },
  },
  {
    name: 'memory_burst_state',
    description: '📊 BURST STATE — Show current burst budget state: remaining calls, window status, circuit breaker health.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path' },
      },
    },
  },
  {
    name: 'memory_burst_audit',
    description: '📋 BURST AUDIT — Show the burst budget audit trail: recent allow/deny decisions with timestamps and reasons.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries (default 50)', default: 50 },
        project: { type: 'string', description: 'Project path' },
      },
    },
  },
  {
    name: 'memory_war_room_run',
    description: '⚔️ WAR ROOM RUN — Execute the self-improvement arena: run all 17 reasoning scenarios, score them, adapt difficulty, and persist the scoreboard.',
    inputSchema: {
      type: 'object',
      properties: {
        maxRounds: { type: 'number', description: 'Max scenario rounds (default 1, runs all 17)', default: 1 },
        project: { type: 'string', description: 'Project path' },
      },
    },
  },
  {
    name: 'memory_war_room_selfcheck',
    description: '🩺 WAR ROOM SELF-CHECK — Run a lightweight diagnostic (3-5 deterministic scenarios, zero LLM, ~10ms). Returns reasoning strengths, weaknesses, category scores, and lifetime trend. Automatically called by bootstrap() and injected into context.',
    inputSchema: {
      type: 'object',
      properties: {
        maxScenarios: { type: 'number', description: 'How many scenarios (default 4, max 5)', default: 4 },
        project: { type: 'string', description: 'Project path' },
      },
    },
  },

  // ── v7.0.0: Code index — symbol-level code knowledge ──
  {
    name: 'memory_code_symbols',
    description: '📚 CODE SYMBOLS — Search the symbol-level code index by name or meaning (hybrid keyword + semantic). Returns functions/methods/classes with signatures, docs, and optional real bodies — so the agent knows what a symbol does without reading the whole file. Pair with memory_ingest_code to refresh the index.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for (e.g., "token budget calculation" or "embedSymbols")' },
        project: { type: 'string', description: 'Project path (defaults to AGENTIC_CORTEX_PROJECT or cwd)' },
        limit: { type: 'integer', description: 'Max results (default 10)', default: 10 },
        semantic: { type: 'boolean', description: 'Force semantic scoring (default true when embeddings available)', default: true },
        includeBody: { type: 'boolean', description: 'Include the real function body (default false)', default: false },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_code_context',
    description: '🎯 TASK-SCOPED CODE — Fetch real symbol bodies for the files relevant to the current task (transitive import closure), budget-capped. This is the “knows the code inside out” layer: inject it at session start so you don\'t re-read files to discover what you already know.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What the agent is working on (drives file relevance scoring)' },
        project: { type: 'string', description: 'Project path (defaults to AGENTIC_CORTEX_PROJECT or cwd)' },
        tokenBudget: { type: 'integer', description: 'Approximate token cap for the block (default 1200)', default: 1200 },
      },
      required: ['task'],
    },
  },
  {
    name: 'memory_ingest_code',
    description: '♻️ INGEST CODE — (Re)build or refresh the symbol-level code index for a project from the deterministic codebase graph. Use --changedOnly after git operations to re-parse just the changed files (cheap, incremental). Optionally embed symbols for semantic search and/or generate one-line distilled summaries.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path (defaults to AGENTIC_CORTEX_PROJECT or cwd)' },
        changedOnly: { type: 'boolean', description: 'Only re-parse files changed in git (default false)', default: false },
        embed: { type: 'boolean', description: 'Also compute semantic embeddings for new symbols', default: false },
        summarize: { type: 'boolean', description: 'Also generate one-line distilled summaries for new symbols', default: false },
      },
    },
  },
  {
    name: 'memory_code_stats',
    description: '📊 CODE INDEX STATS — Symbol index size, kind breakdown, embed/summary coverage for a project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path (defaults to AGENTIC_CORTEX_PROJECT or cwd)' },
      },
    },
  },

  // ── v7.0.0: Session context compactor ──
  {
    name: 'memory_compact_context',
    description: '🗜️ COMPACT CONTEXT — Compress a session\'s observations (or a raw transcript) into a “state so far” summary. Swap the summary in for raw conversation history to cut per-turn token cost. Optionally save it back as an observation for the next bootstrap.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session to compact (defaults to AGENTIC_CORTEX_SESSION or recent project activity)' },
        project: { type: 'string', description: 'Project path' },
        transcript: { type: 'array', items: { type: 'object' }, description: 'Raw [{role, content}] transcript entries (alternative to sessionId)' },
        saveObservation: { type: 'boolean', description: 'Persist the summary as a context observation tagged for bootstrap', default: false },
        saveSummary: { type: 'boolean', description: 'Also update the session summary', default: false },
      },
    },
  },

  // ── v8.0.0: Evidence-theoretic conflict resolution ──
  {
    name: 'memory_resolve_conflict',
    description: '⚖️ RESOLVE CONFLICT — Adjudicate contradictory observations using Dempster-Shafer evidence fusion (statistical corroboration + LLM adjudication). Archives the loser with an explicit reason, records the resolution (conflict coefficient k + deciding evidence), and boosts the winner. Pass explicit winnerId/loserId/reason for human-guided resolution, or omit them to auto-adjudicate a conflict pair.',
    inputSchema: {
      type: 'object',
      properties: {
        winnerId: { type: 'number', description: 'Explicit winner observation id (human/agent-guided)' },
        loserId: { type: 'number', description: 'Explicit loser observation id (human/agent-guided)' },
        reason: { type: 'string', description: 'Why the winner wins (used for explicit resolution)' },
        confidence: { type: 'number', description: 'Your conviction in the winner, 0-1 (default 0.9, explicit only)' },
        aId: { type: 'number', description: 'First conflict observation id (auto-adjudication)' },
        bId: { type: 'number', description: 'Second conflict observation id (auto-adjudication)' },
        project: { type: 'string', description: 'Project path' },
      },
    },
  },
  {
    name: 'memory_resolution_history',
    description: '📜 RESOLUTION HISTORY — Recent evidence-theoretic resolutions (winner, loser, conflict coefficient, deciding evidence) so an agent can see why past conflicts were settled instead of re-opening them.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path' },
        limit: { type: 'number', description: 'Max resolutions to return (default 5)' },
      },
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map(t => [t.name, t]));

// ─── Tool execution ──────────────────────────────────────────────────

/**
 * Extract swarm worker options from MCP args and merge them into the base
 * opts. `args.worker` is a JSON string (MCP has no nested object literals
 * in this tool set).
 */
function _swarmWorkerOpts(args, base = {}) {
  const out = { ...base };
  if (args.workerMode) out.workerMode = args.workerMode;
  if (args.workerFramework) out.workerFramework = args.workerFramework;
  if (args.workerRoles) out.workerRoles = args.workerRoles;
  if (args.worker) {
    try {
      out.worker = typeof args.worker === 'string' ? JSON.parse(args.worker) : args.worker;
    } catch {
      out.worker = null;
    }
  }
  return out;
}

async function callTool(name, args) {
  args = args || {};
  // Documented default (see tool schemas): tools whose `project` param says
  // "defaults to AGENTIC_CORTEX_PROJECT or cwd" must actually apply that
  // default — otherwise a project-scoped agent session silently gets results
  // from every project on the machine (cross-project leak).
  if (args.project === undefined && _PROJECT_SCOPED_TOOLS.has(name)) {
    args.project = process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  }
  switch (name) {
    case 'memory_save':
      return api.save(args);

    case 'memory_search':
      return api.search(args.query, args);

    case 'memory_get':
      return api.get(args.id);

    case 'memory_list':
      return api.list(args);

    case 'memory_edit':
      return api.edit(args.id, args);

    case 'memory_forget':
      return api.forget(args.id, { hard: args.hard });

    case 'memory_context':
      return api.context(args); // note: context is async but callTool handles async returns

    case 'memory_reflect': {
      const mapped = { ...args };
      if (args.consolidateThreshold != null) mapped.threshold = args.consolidateThreshold;
      if (args.promoteMinCount != null) mapped.minCount = args.promoteMinCount;
      if (args.archiveMaxAgeDays != null) mapped.maxAgeDays = args.archiveMaxAgeDays;
      return api.reflect(mapped);
    }

    case 'session_start':
      return api.startSession(args);

    case 'session_end':
      return api.endSession(args.sessionId, args.summary);

    case 'session_summarize':
      return api.summarizeSession(args);

    case 'memory_conflicts':
      return api.checkConflicts(args);

    case 'memory_export':
      return api.exportJSON(args);

    case 'memory_import':
      return api.importJSON(args.data, args);

    case 'memory_health':
      return api.health();

    case 'memory_embed': {
      const v = args.idOrText;
      // If it looks like an integer, treat it as an observation ID
      const num = Number(v);
      if (Number.isInteger(num) && String(num) === v) {
        return api.embed(num);
      }
      return api.embed(v);
    }

    case 'memory_relate':
      return api.addRelation(args);

    case 'memory_graph':
      return api.getGraph(args);

    case 'memory_hook': {
      const hAction = args.action;
      switch (hAction) {
        case 'create':
          return api.createHook({
            name: args.name,
            event: args.event,
            condition_type: args.condition_type || 'always',
            condition_value: args.condition_value || null,
            action_type: args.action_type,
            action_config: args.action_config || {},
            enabled: args.enabled !== false,
          });
        case 'list':
          return api.listHooks();
        case 'update':
          return api.updateHook(args.id, {
            name: args.name,
            event: args.event,
            condition_type: args.condition_type,
            condition_value: args.condition_value,
            action_type: args.action_type,
            action_config: args.action_config,
            enabled: args.enabled,
          });
        case 'delete':
          return api.deleteHook(args.id);
        case 'enable':
          return api.setHookEnabled(args.id, true);
        case 'disable':
          return api.setHookEnabled(args.id, false);
        default:
          throw new Error('Unknown hook action: ' + hAction);
      }
    }

    case 'agent_session_start':
      return api.startAgentSession(args);

    case 'agent_session_end':
      return api.endAgentSession(args.agentId, args.sessionId);

    case 'memory_share':
      return api.shareMemory(args);

    case 'agent_list_sessions':
      return api.listAgentSessions(args);

    case 'memory_shared_get':
      return api.getSharedMemories(args.agentId, args);

    case 'memory_skill_list': {
      const results = api.list({ ...args, type: args.type || 'skill' });
      return results.map(r => {
        const full = api.get(r.id);
        return {
          ...r,
          steps: full?.steps,
          triggers: full?.triggers,
          preconditions: full?.preconditions,
          postconditions: full?.postconditions,
        };
      });
    }

    case 'memory_skill_search':
      return api.searchSkills(args);

    case 'memory_daily_summary': {
      const db = require('../core/db').getDb();
      const project = args.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
      const targetDate = args.date || new Date(Date.now() - 86400000).toISOString().split('T')[0];

      if (!args.force) {
        const existing = db.prepare('SELECT summary FROM daily_summaries WHERE project_path = ? AND summary_date = ?').get(project, targetDate);
        if (existing) return { date: targetDate, summary: existing.summary, cached: true };
      }

      const obs = db.prepare(
        "SELECT id, type, title, content, importance, confidence FROM observations WHERE project_path = ? AND is_active = 1 AND date(created_at) = ? ORDER BY importance DESC LIMIT 50"
      ).all(project, targetDate);

      if (obs.length === 0) {
        return { date: targetDate, summary: 'No observations recorded on ' + targetDate, observationCount: 0 };
      }

      const obsText = obs.map((o, i) =>
        `${i + 1}. [${o.type}] ${o.title || '(untitled)'}: ${o.content.slice(0, 300)}`
      ).join('\n');

      let summary;
      try {
        const { callLLM } = require('../core/session');
        summary = await callLLM([
          { role: 'system', content: 'You summarize a day\'s worth of coding agent observations. Be concise (2-4 sentences). Focus on what was accomplished, key decisions, and problems solved. Use past tense.' },
          { role: 'user', content: 'Date: ' + targetDate + '\n\nObservations:\n' + obsText },
        ], { temperature: 0.2, maxTokens: 300 });
      } catch {}

      if (!summary) {
        const types = {};
        for (const o of obs) { types[o.type] = (types[o.type] || 0) + 1; }
        summary = obs.length + ' observations — ' + Object.entries(types).map(([t, c]) => c + ' ' + t).join(', ');
      }

      db.prepare(
        'INSERT OR REPLACE INTO daily_summaries (project_path, summary_date, summary, observation_count) VALUES (?,?,?,?)'
      ).run(project, targetDate, summary, obs.length);

      return { date: targetDate, summary, observationCount: obs.length, status: 'summarized' };
    }

    case 'memory_learn_from_error': {
      // Save the error observation — the post-save hook in self-improve.js
      // will automatically trigger root cause analysis
      const result = await api.save({
        type: 'error',
        title: 'Error: ' + (args.errorContent || '').slice(0, 60),
        content: args.errorContent,
        project: args.project,
        importance: args.importance || 8,
        tags: [...(args.tags || []), 'auto-capture', 'error-report'],
      });
      return {
        status: 'error_logged_and_analyzing',
        errorId: result.id,
        note: 'The self-improving loop will analyze this error and generate a systemic learning/fix automatically.',
      };
    }

    case 'memory_record_action':
      return api.recordAction(args);

    case 'memory_transfer_knowledge':
      return api.transferKnowledge(args);

    case 'memory_machine_vault': {
      if (args.action === 'analytics') {
        return api.machineAnalytics();
      }
      return api.getGlobalVault({ query: args.query, type: args.type, limit: args.limit, minConfidence: args.minConfidence });
    }

    case 'memory_promote_global':
      return api.promoteToGlobal(args.id, { force: args.force });

    case 'memory_search_all':
      return api.searchAllProjects(args.query, args);

    case 'memory_profile':
      return api.profile(args);

    case 'memory_search_hybrid':
      return api.unifiedSearch(args.query, args);

    case 'memory_expire': {
      if (args.action === 'supersede') {
        if (!args.oldId || !args.newId) throw new Error('supersede requires oldId and newId');
        return api.supersede(args.oldId, args.newId, { reason: args.reason });
      }
      return api.expireMemories({ project: args.project, dryRun: args.dryRun });
    }

    case 'memory_ingest_transcript':
      return api.ingestTranscript(args.text, args);

    case 'memory_feedback':
      return api.feedback(args.id, { type: args.type, reason: args.reason });

    case 'memory_trail':
      return api.trail(args.observationId, { depth: args.depth, direction: args.direction });

    case 'memory_utility_stats':
      return api.getUtilityStats(args);

    case 'memory_freshness': {
      const project = args.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
      if (args.action === 'update') {
        const count = api.updateFreshnessScores(require('../core/db').getDb(), project);
        return { status: 'updated', count };
      }
      if (args.action === 'archive') {
        return api.autoArchive({ project, threshold: args.threshold || 15, dryRun: args.dryRun });
      }
      // Default: return freshness analytics
      return api.analytics({ project }).freshness;
    }

    case 'memory_maintenance':
      return api.runMaintenance(args);

    case 'memory_analytics':
      return api.analytics(args);

    case 'memory_standards': {
      const project = args.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
      if (args.action === 'seed') {
        return api.ensureStandardsExist(require('../core/db').getDb(), project, api.save);
      }
      if (args.action === 'search' && args.query) {
        return api.searchStandards(require('../core/db').getDb(), project, args.query, args.limit || 10);
      }
      return api.listStandards(require('../core/db').getDb(), project, { phase: args.phase, category: args.category, limit: args.limit || 20 });
    }

    case 'memory_crystallize':
      return api.crystallize(args);

    case 'memory_experiment': {
      if (args.action === 'spawn') {
        return api.spawnExperiment({ project: args.project, errorTag: args.errorTag });
      }
      return api.listExperiments({ project: args.project, limit: args.limit });
    }

    case 'memory_eval_log': {
      if (args.stats) {
        return api.getEvalLogStats({ project: args.project });
      }
      return api.getEvaluationLog({ project: args.project, verdict: args.verdict, limit: args.limit });
    }

    case 'memory_outcome_stats': {
      // Map<observationId, {runs, successes, failures, successRate, weight}> →
      // JSON-friendly array enriched with each memory's title/type so agents
      // can see WHICH memories are proven-good, not just bare ids.
      const stats = api.memoryOutcomeStats({ project: args.project, minRuns: args.minRuns });
      const entries = [];
      for (const [observationId, s] of stats) {
        const obs = api.get(observationId) || {};
        const weight = Math.round((s.weight || 0) * 1000) / 1000;
        if (weight < (args.minWeight != null ? args.minWeight : -1)) continue;
        entries.push({
          observationId,
          title: obs.title || '(deleted memory)',
          type: obs.type || 'unknown',
          runs: s.runs,
          successes: s.successes,
          failures: s.failures,
          successRate: s.successRate,
          weight,
          provenGood: weight > 0,
        });
      }
      // Proven-good first, then by weight desc, then by run count desc.
      entries.sort((a, b) =>
        (b.provenGood - a.provenGood) || (b.weight - a.weight) || (b.runs - a.runs)
      );
      return {
        total: entries.length,
        memories: entries.slice(0, args.limit || 50),
      };
    }

    case 'memory_fsm': {
      const agentId = args.agentId || process.env.AGENTIC_CORTEX_AGENT_ID || 'default';
      if (args.action === 'start') {
        api.startAgent(agentId, args.machineName, { project: args.project });
        return api.getAgentState(agentId);
      }
      if (args.action === 'transition') {
        api.transitionAgent(agentId, args.trigger, { project: args.project });
        return api.getAgentState(agentId);
      }
      if (args.action === 'list-machines') {
        return api.listMachines();
      }
      const state = api.getAgentState(agentId);
      const transitions = api.getAvailableTransitions(agentId);
      return { state, transitions };
    }

    case 'memory_rules': {
      if (args.action === 'delete') {
        return api.deleteRule(args.id);
      }
      if (args.action === 'enable') {
        return api.setRuleEnabled(args.id, true);
      }
      if (args.action === 'disable') {
        return api.setRuleEnabled(args.id, false);
      }
      if (args.action === 'evaluate') {
        return api.evaluateRules(args.event || 'manual', { project: args.project });
      }
      return api.listRules({ event: args.event });
    }

    case 'memory_workflow': {
      if (args.action === 'start') {
        return api.startWorkflow(args.workflowName, { agentId: args.agentId, project: args.project });
      }
      if (args.action === 'advance') {
        return api.advanceWorkflow(args.instanceId);
      }
      if (args.action === 'cancel') {
        return api.cancelWorkflow(args.instanceId);
      }
      if (args.action === 'get') {
        return api.getWorkflowInstance(args.instanceId);
      }
      if (args.action === 'agents') {
        return api.getWorkflowAgents(args.instanceId);
      }
      return api.listWorkflows();
    }

    case 'memory_workflow_agents':
      return api.getWorkflowAgents(args.instanceId);

    case 'memory_prompts_list':
      return api.listPromptTemplates();

    case 'memory_prompts_render':
      return api.renderPrompt(args.templateName, args.vars || {});

    case 'memory_plateau_check':
      return api.checkPlateau({
        project: args.project,
        windowDays: args.windowDays,
        force: args.force,
      });

    case 'memory_auto_capture': {
      const project = args.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();

      // Only start a new session if none is active
      if (!process.env.AGENTIC_CORTEX_SESSION) {
        try {
          const sess = api.startSession({
            project,
            name: require('path').basename(project),
            prompt: args.workingOn,
          });
          process.env.AGENTIC_CORTEX_SESSION = sess.session_id;
        } catch {}
      }

      const content = 'Agent is working on: ' + args.workingOn +
        '\nProject: ' + project +
        '\nTimestamp: ' + new Date().toISOString();
      return api.save({
        project,
        type: args.type || 'context',
        title: 'Working on: ' + args.workingOn.slice(0, 80),
        content,
        importance: args.importance || 6,
        session: process.env.AGENTIC_CORTEX_SESSION || null,
        provenance: 'inferred',
        tags: [...(args.tags || []), 'auto-capture', 'mcp'],
      });
    }

    case 'memory_bootstrap':
      return api.bootstrap(args);

    case 'memory_provider':
      return api.providerInfo();

    case 'memory_manifest': {
      const manifest = api.getManifest({ project: args.project });
      if (args.write) {
        const written = api.writeManifestFile({ project: args.project });
        return { ...manifest, written };
      }
      return manifest;
    }

    case 'memory_discover':
      return { frameworks: api.discoverFrameworks({ project: args.project }) };

    case 'memory_compose':
      return api.composeWithFramework(args.framework, { project: args.project });

    case 'memory_wireup':
      return api.wireupAll({ project: args.project, dryRun: args.dryRun, only: args.only, skip: args.skip });

    case 'memory_send':
      return api.sendMessage(args);

    case 'memory_inbox':
      return api.getInbox(args.agentId || process.env.AGENTIC_CORTEX_AGENT_ID || null, {
        unreadOnly: args.unreadOnly,
        kind: args.kind,
        limit: args.limit,
      });

    case 'memory_mark_read':
      return api.markMessageRead(args.id);

    // ── v6.3.0: Test-time compute reasoning ──
    case 'memory_coverage_probe':
      return api.coverageProbe(args.query, { project: args.project, limit: args.limit, record: args.record });

    case 'memory_offline_capabilities':
      return api.offlineCapabilities();
    case 'memory_offline_plan':
      return api.offlinePlan(args.project, args.task, args);
    case 'memory_offline_execute':
      return api.offlineExecute(args.project, args.task, { changes: args.changes || [], verify: args.verify, stopOnFailure: args.stopOnFailure });

    case 'memory_tree_search':
      return api.treeSearch({
        problem: args.problem,
        project: args.project,
        strategy: args.strategy || 'auto',
        budgetOverrides: {
          beamWidth: args.beamWidth,
          maxDepth: args.maxDepth,
          tokenBudget: args.tokenBudget,
        },
      });

    case 'memory_verify_step':
      return api.verifyStep({
        stepContent: args.stepContent,
        priorSteps: args.priorSteps || [],
        problem: args.problem || '',
        stepType: args.stepType || 'reasoning',
        project: args.project,
      });

    case 'memory_budget':
      return (async () => {
        const { estimateDifficulty, calculateBudget } = require('../core/adaptive-budget');
        let memories = [];
        try {
          memories = await api.search(args.problem, { project: args.project, limit: 10 });
        } catch {}
        const difficulty = estimateDifficulty({
          problem: args.problem,
          project: args.project,
          memories,
        });
        const budget = calculateBudget(difficulty.score, {
          beamWidth: args.beamWidth,
          maxDepth: args.maxDepth,
        });
        return { difficulty, budget };
      })();

    case 'memory_verify_code':
      return api.verifyWithCode({
        hypothesis: args.hypothesis,
        context: args.context || '',
        project: args.project,
      });

    case 'memory_reflexion':
      return api.recordReflexion({
        sessionId: args.sessionId,
        problem: args.problem,
        failedPath: args.failedPath,
        verificationError: args.verificationError,
        strategy: args.strategy || 'unknown',
        project: args.project,
      });

    case 'memory_coverage_probes':
      return api.listCoverageProbes({ project: args.project, status: args.status, limit: args.limit });

    case 'memory_resolve_coverage_probe':
      return api.resolveCoverageProbe(args.id, args.observationId);

    case 'memory_reasoning_trace':
      return api.getReasoningTrace(args.traceId);

    case 'memory_reasoning_stats':
      return api.reasoningStats({ project: args.project });

    case 'memory_synthesize_solution':
      return api.synthesizeSolution({ traceId: args.traceId });

    case 'memory_self_consistency':
      return api.selfConsistency({
        problem: args.problem,
        project: args.project,
        samples: args.samples || 5,
        temperature: args.temperature || 0.8,
        usePrmWeighting: args.usePrmWeighting !== false,
      });

    case 'memory_budget_force':
      return api.budgetForce({
        problem: args.problem,
        config: {
          minTokens: args.minTokens,
          maxTokens: args.maxTokens,
          maxRounds: args.maxRounds,
          temperatureBase: args.temperatureBase,
        },
      });

    // ── v6.5.0: Failure classifier + Exp replay + Translations ──
    case 'memory_classify_failure':
      return api.classifyFailure(args.errorText);

    case 'memory_retry_check':
      return api.checkRetryCleared(args.commandKey, args.project);

    case 'memory_failure_lessons':
      return api.lessonStats(args.project);

    case 'memory_experience_scripts':
      return { scripts: api.listScripts({ project: args.project, limit: args.limit || 50 }), stats: api.scriptStats(args.project) };

    case 'memory_translation_lookup':
      return api.translationLookup(args.namespace || 'problem', args.key, args.project);

    // ── v6.5.0: Burst budget ──
    case 'memory_burst_check':
      return api.burstCheck(args.toolName, args.project, {
        allowlist: args.allowlist || [],
        windowMs: args.windowMs,
        maxPerWindow: args.maxPerWindow,
      });

    case 'memory_burst_reset':
      return api.burstReset(args.project);

    // ── v6.5.0: War room ──
    case 'memory_war_room_scoreboard':
      return api.getScoreboard({ project: args.project });

    // ── v6.5.0: Deterministic reasoner ──
    case 'memory_reason_deduce':
      return api.reasonDeduce(args.topic, { project: args.project });

    case 'memory_reason_induce':
      return api.reasonInduce(args.topic, { project: args.project, minSupport: args.minSupport });

    case 'memory_reason_analogize':
      return api.reasonAnalogize(args.topic, { project: args.project });

    case 'memory_reason_abduce':
      return api.reasonAbduce(args.topic, { project: args.project });

    case 'memory_reason_synthesize':
      return api.reasonSynthesize(args.topic, { project: args.project });

    case 'memory_reason_forecast':
      return api.reasonForecast(args.topic, { project: args.project });

    case 'memory_reason_all':
      return api.reasonAll(args.topic, {
        project: args.project,
        modes: args.modes,
        minConfidence: args.minConfidence,
        maxInsights: args.maxInsights,
      });

    // ── v6.5.0: Swarm ──
    case 'memory_swarm_decompose':
      return { tasks: api.swarmDecompose(args.goal, { project: args.project }) };

    case 'memory_swarm_start_task':
      return api.swarmStartTask(args.taskId);

    case 'memory_swarm_complete_task':
      return api.swarmCompleteTask(args.taskId, args.summary, args.obsId);

    case 'memory_swarm_fail_task': {
      const task = api.swarmFailTask(args.taskId, args.reason, { permanent: true });
      const replanned = task && task.goal
        ? api.swarmReplanGoal(task.goal, { project: args.project })
        : Promise.resolve([]);
      return Promise.resolve(replanned).then(created => ({ task, replanned: created }));
    }

    case 'memory_swarm_replan_goal':
      return api.swarmReplanGoal(args.goal, { project: args.project });

    case 'memory_swarm_escalations':
      return api.swarmEscalations(args.goal, { project: args.project });

    case 'memory_swarm_retry_now':
      return api.swarmRetryNow(args.taskId);

    case 'memory_swarm_job_create':
      return api.swarmCreateJob(args.goal, {
        project: args.project,
        concurrency: args.concurrency,
        maxRounds: args.maxRounds,
      });

    case 'memory_swarm_job_run':
      return api.swarmRunJob(args.jobId, {});

    case 'memory_swarm_jobs':
      return api.swarmListJobs({ project: args.project, status: args.status, limit: args.limit });

    case 'memory_swarm_job_cancel':
      return api.swarmCancelJob(args.jobId);

    case 'memory_swarm_next_task':
      return api.swarmNextTask(args.role, { project: args.project });

    case 'memory_swarm_status':
      return api.swarmActiveGoals({ project: args.project });

    case 'memory_swarm_synthesize':
      return api.swarmSynthesize(args.goal, { project: args.project });

    case 'memory_swarm_execute':
      return api.swarmExecute(args.taskId, _swarmWorkerOpts(args, { project: args.project, dryRun: args.dryRun }));

    case 'memory_swarm_execute_pipeline':
      return api.swarmExecutePipeline(args.goal, _swarmWorkerOpts(args, {
        project: args.project,
        dryRun: args.dryRun,
        concurrency: args.concurrency,
      }));

    case 'memory_swarm_worker_info':
      return api.swarmWorkerInfo({ project: args.project });

    case 'memory_swarm_plan_import':
      return api.swarmPlanImport(args.project, { gates: args.gates });

    case 'memory_swarm_plan_run':
      return api.swarmPlanRun(args.project, _swarmWorkerOpts(args, {
        concurrency: args.concurrency,
      }));

    case 'memory_swarm_plan_sync':
      return api.swarmPlanSync(args.project, {});

    case 'memory_swarm_plan_info':
      return api.swarmPlanInfo(args.project, {});

    case 'memory_swarm_progress':
      return api.swarmGoalProgress(args.goal, { project: args.project });

    // ── v6.5.0: Experience replay (extended) ──
    case 'memory_experience_record':
      return api.recordScript({
        commandKey: args.commandKey,
        steps: args.steps,
        expectedOutput: args.expectedOutput,
        llmCallsSaved: args.llmCallsSaved,
        project: args.project,
      });

    case 'memory_experience_replay':
      return api.replayExperience(args.commandKey, args.project, args.params);

    case 'memory_experience_stats':
      return api.scriptStats(args.project);

    case 'memory_experience_autodetect':
      return api.autodetectReplay(args.problem, { minScore: args.minScore, project: args.project });

    // ── v6.5.0: Translation store (extended) ──
    case 'memory_translation_store':
      return api.translationStore(args.namespace || 'problem', args.key, JSON.parse(args.payload), args.project);

    case 'memory_translation_stats':
      return api.translationStats(args.project);

    case 'memory_translation_list':
      return api.translationList({ namespace: args.namespace, limit: args.limit || 50, project: args.project });

    // ── v6.5.0: Burst budget (extended) ──
    case 'memory_burst_state':
      return api.burstGetState(args.project, { allowlist: args.allowlist || [] });

    case 'memory_burst_audit':
      return api.burstAuditLog({ limit: args.limit || 50, project: args.project });

    // ── v6.5.0: War room (extended) ──
    case 'memory_war_room_run':
      return api.runWarRoom({ maxRounds: args.maxRounds || 1, project: args.project });

    case 'memory_war_room_selfcheck':
      return api.warRoomSelfCheck({ maxScenarios: args.maxScenarios || 4, project: args.project });

    // ── v7.0.0: Code index ──
    case 'memory_code_symbols':
      return api.codeSearch(args.query, {
        project: args.project,
        limit: args.limit || 10,
        semantic: args.semantic !== false,
        includeBody: !!args.includeBody,
      });

    case 'memory_code_context':
      return {
        xml: api.codeContext(args.project, args.task, args.tokenBudget || 1200),
      };

    case 'memory_ingest_code': {
      const result = args.changedOnly
        ? await api.codeIngestDiff(args.project, {})
        : api.codeIngest(args.project, { regenerate: true });
      if (args.embed) result.embed = await api.codeEmbed(args.project, {});
      if (args.summarize) result.summarize = await api.codeSummarize(args.project, {});
      return result;
    }

    case 'memory_code_stats':
      return api.codeStats(args.project);

    // ── v7.0.0: Session context compactor ──
    case 'memory_compact_context':
      if (Array.isArray(args.transcript)) {
        return api.compactTranscript(args.transcript, {});
      }
      return api.compactContext({
        sessionId: args.sessionId || process.env.AGENTIC_CORTEX_SESSION || undefined,
        project: args.project,
        saveObservation: !!args.saveObservation,
        saveSummary: !!args.saveSummary,
      });

    // ── v8.0.0: Evidence-theoretic conflict resolution ──
    case 'memory_resolve_conflict':
      if (args.winnerId && args.loserId) {
        return api.resolveExplicit({
          winnerId: args.winnerId,
          loserId: args.loserId,
          reason: args.reason,
          confidence: args.confidence,
          project: args.project,
        });
      }
      if (args.aId && args.bId) {
        return api.resolvePair({
          aId: args.aId,
          bId: args.bId,
          project: args.project,
          resolutionType: 'adjudicated',
        });
      }
      throw new Error('Provide either winnerId+loserId+reason (explicit) or aId+bId (auto-adjudicate)');

    case 'memory_resolution_history':
      return api.resolutionHistory(args.project, args.limit);

    default:
      throw new Error('Unknown tool: ' + name);
  }
}

// ─── Request handler ────────────────────────────────────────────────

async function handleRequest(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.id === 'undefined') {
    return rpcError(null, INVALID_REQUEST, 'Invalid JSON-RPC 2.0 request');
  }

  const { id, method, params } = msg;

  // ── initialize ──
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'agentic-cortex', version: pkg.version },
    });
  }

  // ── notifications (no response) ──
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return null; // no response for notifications
  }

  // ── tools/list ──
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  // ── tools/call ──
  if (method === 'tools/call') {
    const toolName = params && params.name;
    const toolArgs = (params && params.arguments) || {};

    if (!toolName || !TOOL_MAP.has(toolName)) {
      return rpcError(id, METHOD_NOT_FOUND, 'Unknown tool: ' + toolName);
    }

    try {
      const result = await _enqueueToolCall(toolName, toolArgs);
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify({ error: msg }) }],
        isError: true,
      });
    }
  }

  // ── ping ──
  if (method === 'ping') {
    return rpcResult(id, {});
  }

  return rpcError(id, METHOD_NOT_FOUND, 'Method not found: ' + method);
}

// ─── Stdio transport ─────────────────────────────────────────────────

let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  // Process complete lines (each JSON-RPC message is one line)
  const lines = buffer.split('\n');
  buffer = lines.pop(); // keep incomplete line

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stdout.write(rpcError(null, PARSE_ERROR, 'Parse error') + '\n');
      continue;
    }

    handleRequest(msg).then(response => {
      if (response !== null) {
        process.stdout.write(response + '\n');
      }
    }).catch(err => {
      console.error('[agentic-cortex-mcp] Unhandled error:', err);
      process.stdout.write(rpcError(msg && msg.id, INTERNAL_ERROR, 'Internal error') + '\n');
    });
  }
});

process.stdin.on('end', () => {
  // Process any remaining buffer
  if (buffer.trim()) {
    try {
      const msg = JSON.parse(buffer.trim());
      handleRequest(msg).then(response => {
        if (response !== null) process.stdout.write(response + '\n');
        process.exit(0);
      });
    } catch {
      process.exit(1);
    }
  } else {
    process.exit(0);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => { api.close(); process.exit(0); });
process.on('SIGINT', () => { api.close(); process.exit(0); });

// Log startup to stderr (stdout is for JSON-RPC)
console.error('[agentic-cortex-mcp] MCP server started on stdio');
