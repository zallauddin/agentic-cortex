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
 * Execute a tool call with per-project serialization.
 * Ensures only one concurrent tool call per project to avoid SQLite busy
 * errors and overlapping LLM/embedding operations.
 */
function _enqueueToolCall(toolName, toolArgs) {
  // Only serialize state-modifying tool calls; reads are concurrent-safe
  const stateModifyingTools = new Set(['memory_save', 'memory_edit', 'memory_forget', 'memory_reflect', 'memory_import', 'memory_relate', 'memory_share', 'agent_session_start', 'agent_session_end', 'session_start', 'session_end', 'memory_record_action', 'memory_transfer_knowledge', 'memory_ingest_transcript', 'memory_feedback', 'memory_maintenance', 'memory_standards']);
  if (!stateModifyingTools.has(toolName)) {
    return callTool(toolName, toolArgs);
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
    description: 'Detect semantically similar but potentially contradictory observations.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Filter by project path' },
        limit: { type: 'integer', description: 'Max conflict pairs', default: 10 },
        autoResolve: { type: 'boolean', description: 'Attempt automatic resolution', default: false },
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
];

const TOOL_MAP = new Map(TOOLS.map(t => [t.name, t]));

// ─── Tool execution ──────────────────────────────────────────────────

async function callTool(name, args) {
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
      serverInfo: { name: 'agentic-cortex', version: '3.1.0' },
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
