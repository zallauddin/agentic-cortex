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
      return api.context(args);

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

    case 'memory_auto_capture': {
      const project = args.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();

      // Auto-start session and set env var so subsequent saves are associated
      try {
        const sess = api.startSession({
          project,
          name: require('path').basename(project),
          prompt: args.workingOn,
        });
        process.env.AGENTIC_CORTEX_SESSION = sess.session_id;
      } catch {}

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
      const result = await callTool(toolName, toolArgs);
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
