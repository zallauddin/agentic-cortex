/**
 * manifest.js — Machine-readable agent capability manifest + framework auto-discovery.
 *
 * Answers three questions for any consumer (another agent framework, an MCP
 * client, a CI pipeline, a human):
 *
 *   1. WHAT can agentic-cortex do?        → getManifest() — schema v1 JSON
 *   2. WHO else is on this machine?       → discoverFrameworks() — scans known
 *                                           agent framework config locations
 *   3. HOW do we compose?                 → composeWithFramework() — given a
 *                                           discovered framework, returns the
 *                                           exact wiring AC needs to plug into it
 *
 * The manifest is schema-versioned (manifest.schemaVersion) so consumers can
 * feature-detect instead of breaking. All functions are synchronous, pure,
 * and deterministic — safe to call from CLI, MCP, or bootstrap.
 *
 * @module core/manifest
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Manifest schema version ────────────────────────────────────────

const MANIFEST_SCHEMA_VERSION = '1.0.0';

// ─── Known agent framework detectors ────────────────────────────────
// Each detector: { id, name, kind, files: [project-relative config paths], env: [env var names] }
// Returns { id, name, kind, configPaths: [abs], env: {...}, registeredMcp: [...] }

const KNOWN_FRAMEWORKS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    kind: 'coding-agent',
    files: ['.mcp.json', '.claude/CLAUDE.md'],
    env: ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SKIP_BUNDLE_DOWNLOAD'],
    mcpFiles: ['.mcp.json', '.mcp.jsonc'],
    mcpKey: 'mcpServers',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    kind: 'coding-agent',
    files: ['.cursor/mcp.json', '.cursor/rules/agentic-cortex.mdc'],
    env: [],
    mcpFiles: ['.cursor/mcp.json'],
    mcpKey: 'mcpServers',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    kind: 'coding-agent',
    files: ['opencode.json', '.opencode/agentic-cortex.md'],
    env: [],
    mcpFiles: ['opencode.json'],
    mcpKey: 'mcp',
  },
  {
    id: 'codebuff',
    name: 'Codebuff',
    kind: 'coding-agent',
    files: ['.freebuff/', 'AGENTS.md'],
    env: ['CODEBUFF_SESSION'],
    mcpFiles: [],
    mcpKey: null,
  },
  {
    id: 'generic-mcp',
    name: 'Generic MCP client',
    kind: 'mcp-client',
    files: [],
    env: [],
    mcpFiles: [],
    mcpKey: null,
  },
];

/**
 * Resolve a project-relative path list to absolute paths that exist.
 * @param {string} project
 * @param {string[]} rels
 * @returns {string[]}
 */
function _existingPaths(project, rels) {
  const out = [];
  for (const rel of rels) {
    const abs = path.resolve(project, rel);
    if (fs.existsSync(abs)) out.push(abs);
  }
  return out;
}

/**
 * Parse MCP servers registered in a framework config file, if any.
 * @param {string} absPath
 * @param {string|null} key — top-level key holding the servers map
 * @returns {Array<{name: string, transport: string, command?: string}>}
 */
function _readRegisteredMcp(absPath, key) {
  if (!key) return [];
  try {
    const raw = fs.readFileSync(absPath, 'utf-8');
    const json = JSON.parse(raw);
    const servers = json && typeof json === 'object' ? json[key] : null;
    if (!servers || typeof servers !== 'object') return [];
    return Object.entries(servers).map(([name, cfg]) => {
      const c = cfg || {};
      return {
        name,
        transport: c.type || 'stdio',
        command: typeof c.command === 'string' ? c.command
          : Array.isArray(c.command) ? c.command[0] : undefined,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Collect env-var evidence for a framework.
 * @param {string[]} names
 * @returns {Record<string, string>}
 */
function _collectEnv(names) {
  const out = {};
  for (const n of names) {
    if (process.env[n]) out[n] = process.env[n];
  }
  return out;
}

/**
 * Scan the machine for agent frameworks AC could compose with.
 *
 * Checks, in order of specificity:
 *  1. project-scoped config files (the cwd or an explicit project)
 *  2. user-global config locations (home dir)
 *  3. environment variables
 *
 * @param {Object} [opts]
 * @param {string} [opts.project] — project root to scan (default cwd)
 * @returns {Array<Object>} discovered frameworks
 */
function discoverFrameworks(opts = {}) {
  const project = path.resolve(opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd());
  const home = os.homedir();
  const out = [];

  for (const fw of KNOWN_FRAMEWORKS) {
    const projectPaths = _existingPaths(project, fw.files);
    const homePaths = _existingPaths(home, fw.files.map(f => f.replace(/^\./, '.')));
    const env = _collectEnv(fw.env);

    const mcpServers = [];
    for (const rel of fw.mcpFiles) {
      const abs = _existingPaths(project, [rel])[0] || _existingPaths(home, [rel])[0];
      if (abs) mcpServers.push(..._readRegisteredMcp(abs, fw.mcpKey));
    }

    if (projectPaths.length === 0 && homePaths.length === 0 && Object.keys(env).length === 0 && mcpServers.length === 0) {
      continue;
    }

    out.push({
      id: fw.id,
      name: fw.name,
      kind: fw.kind,
      scope: projectPaths.length || mcpServers.length ? 'project' : 'user',
      evidence: {
        projectConfig: projectPaths,
        userConfig: homePaths,
        env,
        registeredMcp: mcpServers,
      },
    });
  }

  return out;
}

// ─── Capability inventory (single source of truth) ──────────────────

/**
 * The complete, machine-readable capability inventory. Kept as data (not
 * derived at call time) so it is stable across versions and cheap to emit.
 * Each capability: { id, version, description, exposedVia: [interfaces] }
 */
const CAPABILITIES = [
  // Memory layer
  { id: 'memory.typed', version: '1', description: '18 typed memories with confidence 0-100 and provenance (explicit/inferred/observed)', exposedVia: ['mcp', 'cli', 'node', 'http'] },
  { id: 'memory.search', version: '1', description: 'Hybrid search: FTS5 keyword + BGE semantic (768-dim) + cross-encoder rerank, graceful fallback', exposedVia: ['mcp', 'cli', 'node', 'http'] },
  { id: 'memory.dedup', version: '1', description: 'Save-time cosine dedup >= 0.97 reinforces existing memory instead of duplicating', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'memory.freshness', version: '1', description: '0-100 freshness score (recency + confidence + utility), auto-archival', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'memory.tiered-crystallization', version: '1', description: 'Raw → synthesis → principle compression; principles always injected', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'memory.global-vault', version: '1', description: 'Machine-wide vault with relative-threshold auto-promotion', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'memory.compactor', version: '1', description: 'Map-reduce session compaction (~95% smaller state-so-far)', exposedVia: ['mcp', 'cli', 'node'] },

  // Code knowledge layer
  { id: 'code.index', version: '1', description: 'Symbol-level code index (functions/methods/classes + real bodies) in SQLite', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'code.task-scoped-injection', version: '1', description: 'Bootstrap injects relevant symbols + transitive import closure under a token budget', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'code.semantic-search', version: '1', description: 'Embedding-based symbol search by meaning (opt-in for memory safety)', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'code.usage-feedback', version: '1', description: 'Symbol access tracked; frequently-needed code wins injection ties', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'code.change-aware', version: '1', description: 'Git hooks re-parse only changed files; records code-change memories', exposedVia: ['mcp', 'cli', 'node'] },

  // Reasoning layer
  { id: 'reasoning.tree-search', version: '1', description: 'Tree of Thoughts: beam search, MCTS, greedy with adaptive compute budget', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'reasoning.prm', version: '1', description: 'Process Reward Model: 3-tier step verification (deterministic, LLM-judge, memory cross-check)', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'reasoning.self-consistency', version: '1', description: 'N independent chains, majority vote, optional PRM-weighted', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'reasoning.budget-forcing', version: '1', description: 's1-style minimum reasoning depth enforcement', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'reasoning.repl', version: '1', description: 'Program-aided reasoning: sandboxed verification code execution', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'reasoning.deterministic', version: '1', description: '6-mode deterministic inference (deduce/induce/analogize/abduce/synthesize/forecast), zero LLM', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'reasoning.reflexion', version: '1', description: 'In-context self-correction; failed paths become memory', exposedVia: ['mcp', 'cli', 'node'] },

  // Learning / self-improvement layer
  { id: 'learning.self-improve', version: '1', description: '6 improvement hooks: error RCA, conflict detection, evidence-based confidence', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'learning.plateau-detection', version: '1', description: 'Detects stalled improvement and triggers breakthrough analysis', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'learning.experiments', version: '1', description: 'Controlled hypothesis experiments tracked against an immutable eval log', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'learning.failure-classifier', version: '1', description: 'Failure classification + probe-gated retry + lessons', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'learning.experience-replay', version: '1', description: 'Deterministic replay of recorded operations, zero LLM cost', exposedVia: ['mcp', 'cli', 'node'] },

  // Audit / decision layer
  { id: 'audit.conflict-resolution', version: '1', description: 'Dempster-Shafer evidence fusion: belief mass, conflict coefficient k, deciding evidence, two-shot debate', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'audit.resolution-records', version: '1', description: 'Persisted resolution_records with winner, loser, masses, k, debate — auditable forever', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'audit.weak-resolution-warning', version: '1', description: 'Bootstrap flags high-k / near-tie / low-belief resolutions as open questions', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'audit.eval-log', version: '1', description: 'Append-only immutable evaluation trail', exposedVia: ['mcp', 'cli', 'node'] },

  // Orchestration layer
  { id: 'orchestration.fsm', version: '1', description: 'Finite-state machine engine with guards, entry/exit hooks, per-agent state', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'orchestration.workflow', version: '1', description: 'DAG workflow executor with parallel branches, rollback, sub-agent spawning', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'orchestration.rules', version: '1', description: 'Priority-based condition→action declarative rules', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'orchestration.swarm', version: '1', description: 'Persona-based multi-agent swarm: 8 roles, dependency DAG, role→reasoning-engine dispatch', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'orchestration.mailbox', version: '1', description: 'Inter-agent mailbox (send/inbox/mark-read) for agent coordination', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'orchestration.agent-sessions', version: '1', description: 'Namespaced agent sessions with shared memory discovery', exposedVia: ['mcp', 'cli', 'node'] },

  // Integration layer
  { id: 'integration.mcp-stdio', version: '1', description: 'MCP server over stdio JSON-RPC (110 tools)', exposedVia: ['mcp'] },
  { id: 'integration.mcp-http', version: '1', description: 'Optional REST interface on port 37777', exposedVia: ['http'] },
  { id: 'integration.git-hooks', version: '1', description: 'Auto context refresh on checkout/merge/pull/commit', exposedVia: ['cli', 'node'] },
  { id: 'integration.webhooks', version: '1', description: 'Hook actions POST to Slack/PagerDuty/CI', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'integration.discovery-files', version: '1', description: 'Auto-creates AGENTS.md, .claude/CLAUDE.md, .cursor/rules, .opencode', exposedVia: ['cli'] },
];

// ─── Manifest builder ───────────────────────────────────────────────

/**
 * Build the full machine-readable capability manifest.
 *
 * @param {Object} [opts]
 * @param {string} [opts.project] — project path (for scoped tool listing)
 * @returns {Object} schema-v1 manifest
 */
function getManifest(opts = {}) {
  let version = 'unknown';
  try { version = require('../../package.json').version; } catch {}

  const project = path.resolve(opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd());

  return {
    manifest: 'agentic-cortex-capability-manifest',
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    agent: {
      name: 'agentic-cortex',
      version,
      kind: 'memory-provider + agent-orchestration',
      transports: ['stdio-mcp', 'node-api', 'cli', 'http'],
      id: 'agentic-cortex@' + version,
    },
    capabilities: CAPABILITIES,
    interfaces: {
      mcp: {
        transport: 'stdio-jsonrpc',
        command: 'agentic-cortex-mcp',
        args: [],
        toolCount: 110,
        discoveryTool: 'memory_provider',
        manifestTools: ['memory_manifest', 'memory_discover'],
      },
      node: {
        require: 'agentic-cortex',
        entry: 'src/api/index.js',
        envOverride: 'AGENTIC_CORTEX_PATH',
      },
      cli: {
        binary: 'agentic-cortex',
        bootstrapCommand: 'agentic-cortex bootstrap',
      },
      http: {
        port: parseInt(process.env.AGENTIC_CORTEX_PORT || '37777', 10),
        basePath: '/',
      },
    },
    composition: {
      role: 'memory + reasoning + orchestration provider',
      providesTo: [
        { consumer: 'coding-agent', value: 'persistent memory, task-scoped code context, self-improvement, test-time reasoning' },
        { consumer: 'mcp-client', value: '110 MCP tools over stdio JSON-RPC' },
        { consumer: 'multi-agent-swarm', value: 'persona orchestration, mailbox, FSM, shared brain' },
      ],
      consumes: [
        { provider: 'llm', value: 'LLM backend for summaries/adjudication (LLAMA_CPP_BASE_URL or compatible)' },
        { provider: 'coding-agent-harness', value: 'tool-call loop, file editing, test running' },
      ],
      composeCommands: [
        'agentic-cortex mcp-config --agent claude|cursor|opencode --json',
        'agentic-cortex manifest --json',
        'agentic-cortex discover',
      ],
    },
    environment: {
      project: { AGENTIC_CORTEX_PROJECT: 'default project path (cwd)' },
      session: { AGENTIC_CORTEX_SESSION: 'current session id' },
      db: { AGENTIC_CORTEX_DB: 'sqlite db path override' },
      embeddings: { AGENTIC_CORTEX_EMBEDDINGS: 'set 1 to enable the ~400MB embedding model' },
      llm: { LLAMA_CPP_BASE_URL: 'llm backend for summaries (default http://127.0.0.1:8081)' },
      memoryRepo: { AGENTIC_CORTEX_MEMORY_REPO: 'optional git repo for cross-machine memory sync' },
    },
    scoped: {
      project,
      manifestFile: path.join(project, 'agentic-cortex.manifest.json'),
    },
  };
}

/**
 * Write the manifest to a file in the project (agentic-cortex.manifest.json).
 * Machine-readable so other frameworks/CI can consume it without spawning AC.
 *
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @param {string} [opts.file] — override output path
 * @returns {{ ok: boolean, file: string, error?: string }}
 */
function writeManifestFile(opts = {}) {
  try {
    const manifest = getManifest(opts);
    const file = path.resolve(opts.file || manifest.scoped.manifestFile);
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    return { ok: true, file };
  } catch (err) {
    return { ok: false, file: opts.file || '', error: err.message };
  }
}

// ─── Composition mapping ────────────────────────────────────────────

/**
 * Given a discovered framework, return the exact wiring AC needs to compose
 * with it: which interfaces to use, which MCP tools to expose, and any
 * config files to create.
 *
 * @param {string|Object} frameworkOrId — framework id ('claude-code') or a
 *   discovered framework object from discoverFrameworks()
 * @param {Object} [opts]
 * @param {string} [opts.project]
 * @returns {Object} composition plan
 */
function composeWithFramework(frameworkOrId, opts = {}) {
  const project = path.resolve(opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd());
  const fw = typeof frameworkOrId === 'string'
    ? KNOWN_FRAMEWORKS.find(f => f.id === frameworkOrId)
    : frameworkOrId;

  if (!fw) {
    return {
      ok: false,
      error: 'Unknown framework. Discover with: agentic-cortex discover',
      known: KNOWN_FRAMEWORKS.map(f => f.id),
    };
  }

  const id = fw.id;
  const plan = {
    ok: true,
    framework: { id: fw.id, name: fw.name, kind: fw.kind },
    strategy: null,
    wiring: {},
  };

  switch (id) {
    case 'claude-code':
      plan.strategy = 'register AC as an MCP stdio server in .mcp.json; CLAUDE.md already discovered via setup';
      plan.wiring = {
        mcpFile: path.join(project, '.mcp.json'),
        mcpConfig: { mcpServers: { 'agentic-cortex': { type: 'stdio', command: 'agentic-cortex-mcp', args: [] } } },
        memoryTools: ['memory_bootstrap', 'memory_save', 'memory_search', 'memory_code_symbols', 'memory_code_context'],
        reasoningTools: ['memory_tree_search', 'memory_reason_all', 'memory_verify_code', 'memory_self_consistency'],
        auditTools: ['memory_resolve_conflict', 'memory_resolution_history'],
        orchestrationTools: ['memory_fsm', 'memory_workflow', 'memory_swarm_decompose', 'memory_swarm_execute_pipeline'],
      };
      break;

    case 'cursor':
      plan.strategy = 'register AC as an MCP stdio server in .cursor/mcp.json; cursor rule file already discovered via setup';
      plan.wiring = {
        mcpFile: path.join(project, '.cursor/mcp.json'),
        mcpConfig: { mcpServers: { 'agentic-cortex': { type: 'stdio', command: 'agentic-cortex-mcp', args: [] } } },
        memoryTools: ['memory_bootstrap', 'memory_save', 'memory_search'],
        reasoningTools: ['memory_tree_search', 'memory_reason_all'],
        auditTools: ['memory_resolve_conflict'],
        orchestrationTools: ['memory_workflow', 'memory_swarm_decompose'],
      };
      break;

    case 'opencode':
      plan.strategy = 'register AC as an OpenCode MCP addon in opencode.json';
      plan.wiring = {
        mcpFile: path.join(project, 'opencode.json'),
        mcpConfig: { mcp: { 'agentic-cortex': { type: 'local', command: ['agentic-cortex-mcp'], enabled: true } } },
        memoryTools: ['memory_bootstrap', 'memory_save', 'memory_search'],
        reasoningTools: ['memory_tree_search', 'memory_reason_all'],
        auditTools: ['memory_resolve_conflict'],
        orchestrationTools: ['memory_workflow', 'memory_swarm_decompose'],
      };
      break;

    case 'codebuff':
      plan.strategy = 'use AC as a node library in-process (AGENTIC_CORTEX_PATH) or via MCP; AGENTS.md already discovered via setup';
      plan.wiring = {
        nodeRequire: 'agentic-cortex',
        envOverride: 'AGENTIC_CORTEX_PATH',
        memoryTools: ['memory_bootstrap', 'memory_save', 'memory_search', 'memory_code_symbols', 'memory_code_context'],
        reasoningTools: ['memory_tree_search', 'memory_reason_all', 'memory_verify_code', 'memory_self_consistency'],
        auditTools: ['memory_resolve_conflict', 'memory_resolution_history'],
        orchestrationTools: ['memory_fsm', 'memory_workflow', 'memory_swarm_decompose', 'memory_swarm_execute_pipeline'],
      };
      break;

    case 'generic-mcp':
    default:
      plan.strategy = 'register AC as an MCP stdio server in any MCP client config';
      plan.wiring = {
        mcpConfig: { mcpServers: { 'agentic-cortex': { type: 'stdio', command: 'agentic-cortex-mcp', args: [] } } },
        memoryTools: ['memory_bootstrap', 'memory_save', 'memory_search'],
        reasoningTools: ['memory_tree_search', 'memory_reason_all'],
        auditTools: ['memory_resolve_conflict'],
        orchestrationTools: ['memory_workflow'],
      };
      break;
  }

  return plan;
}

// ─── Exports ────────────────────────────────────────────────────────

module.exports = {
  MANIFEST_SCHEMA_VERSION,
  CAPABILITIES,
  KNOWN_FRAMEWORKS,
  getManifest,
  writeManifestFile,
  discoverFrameworks,
  composeWithFramework,
};
