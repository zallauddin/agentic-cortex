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
// Each detector: { id, name, kind, files: [project-relative config paths],
// homeFiles: [home-relative evidence paths], env: [env var names],
// commands: [executable names to look for on PATH],
// mcpFiles: [project-relative MCP config paths], mcpKey, mcpKind }
// Returns { id, name, kind, configPaths: [abs], env: {...}, commands: [...], registeredMcp: [...] }

const KNOWN_FRAMEWORKS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    kind: 'coding-agent',
    files: ['.mcp.json', '.claude/CLAUDE.md'],
    homeFiles: ['.claude.json', '.claude/CLAUDE.md'],
    env: ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SKIP_BUNDLE_DOWNLOAD', 'CLAUDECODE'],
    commands: ['claude'],
    mcpFiles: ['.mcp.json', '.mcp.jsonc'],
    mcpKey: 'mcpServers',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    kind: 'coding-agent',
    files: ['.cursor/mcp.json', '.cursor/rules/agentic-cortex.mdc'],
    homeFiles: ['.cursor/mcp.json'],
    env: [],
    commands: ['cursor-agent', 'cursor'],
    mcpFiles: ['.cursor/mcp.json'],
    mcpKey: 'mcpServers',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    kind: 'coding-agent',
    files: ['opencode.json', '.opencode/agentic-cortex.md'],
    homeFiles: ['.config/opencode/opencode.json'],
    env: ['OPENCODE_CONFIG'],
    commands: ['opencode'],
    mcpFiles: ['opencode.json'],
    mcpKey: 'mcp',
  },
  {
    id: 'freebuff',
    name: 'Freebuff',
    kind: 'coding-agent',
    files: ['.freebuff'],
    homeFiles: ['.freebuff'],
    env: ['CODEBUFF_SESSION', 'FREEBUFF_HOME'],
    commands: ['freebuff'],
    mcpFiles: ['.freebuff/mcp.json'],
    mcpKey: 'mcpServers',
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    kind: 'coding-agent',
    files: ['.gemini/settings.json'],
    homeFiles: ['.gemini/settings.json'],
    env: ['GEMINI_API_KEY'],
    commands: ['gemini'],
    mcpFiles: ['.gemini/settings.json'],
    mcpKey: 'mcpServers',
  },
  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    kind: 'coding-agent',
    files: ['.codex/config.toml'],
    homeFiles: ['.codex/config.toml'],
    env: ['CODEX_HOME'],
    commands: ['codex'],
    mcpFiles: ['.codex/config.toml'],
    mcpKey: 'mcp_servers', // TOML — never JSON-merged; wiring is advisory
  },
  {
    id: 'copilot-cli',
    name: 'GitHub Copilot CLI',
    kind: 'coding-agent',
    files: ['.copilot/mcp-config.json'],
    homeFiles: ['.copilot/mcp-config.json'],
    env: ['GITHUB_COPILOT_CLI'],
    commands: ['copilot'],
    mcpFiles: ['.copilot/mcp-config.json'],
    mcpKey: 'mcpServers',
  },
  {
    id: 'vscode-copilot',
    name: 'VS Code (Copilot agent mode)',
    kind: 'editor-agent',
    files: ['.vscode/mcp.json'],
    homeFiles: [],
    env: [],
    commands: ['code'],
    mcpFiles: ['.vscode/mcp.json'],
    mcpKey: 'servers',
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    kind: 'editor-agent',
    files: ['.windsurf/mcp_config.json'],
    homeFiles: ['.codeium/windsurf/mcp_config.json'],
    env: [],
    commands: ['windsurf'],
    mcpFiles: ['.windsurf/mcp_config.json'],
    mcpKey: 'mcpServers',
  },
  {
    id: 'roo-code',
    name: 'Roo Code',
    kind: 'editor-agent',
    files: ['.roo/mcp.json', '.roo/rules/agentic-cortex.md'],
    homeFiles: [],
    env: [],
    commands: [],
    mcpFiles: ['.roo/mcp.json'],
    mcpKey: 'mcpServers',
  },
  {
    id: 'cline',
    name: 'Cline',
    kind: 'editor-agent',
    files: ['.cline'],
    homeFiles: [],
    env: [],
    commands: [],
    mcpFiles: ['.clinerules'],
    mcpKey: null, // Cline MCP settings live in VS Code globalState — advisory only
  },
  {
    id: 'continue',
    name: 'Continue',
    kind: 'editor-agent',
    files: ['.continue/config.yaml', '.continue/config.json'],
    homeFiles: ['.continue/config.yaml'],
    env: [],
    commands: ['cn'],
    mcpFiles: ['.continue/config.yaml'],
    mcpKey: null, // YAML — advisory
  },
  {
    id: 'zed',
    name: 'Zed',
    kind: 'editor-agent',
    files: ['.zed/settings.json'],
    homeFiles: ['.config/zed/settings.json'],
    env: [],
    commands: ['zed'],
    mcpFiles: ['.zed/settings.json'],
    mcpKey: 'context_servers',
  },
  {
    id: 'goose',
    name: 'Goose (Block)',
    kind: 'coding-agent',
    files: ['.goose/config.yaml'],
    homeFiles: ['.config/goose/config.yaml'],
    env: ['GOOSE_MODE'],
    commands: ['goose'],
    mcpFiles: ['.goose/config.yaml'],
    mcpKey: null, // YAML — advisory
  },
  {
    id: 'qwen-code',
    name: 'Qwen Code',
    kind: 'coding-agent',
    files: ['.qwen/settings.json'],
    homeFiles: ['.qwen/settings.json'],
    env: ['QWEN_API_KEY'],
    commands: ['qwen'],
    mcpFiles: ['.qwen/settings.json'],
    mcpKey: 'mcpServers',
  },
  {
    id: 'amazon-q',
    name: 'Amazon Q Developer',
    kind: 'coding-agent',
    files: ['.amazonq'],
    homeFiles: ['.aws/amazonq'],
    env: [],
    commands: ['q'],
    mcpFiles: ['.amazonq/mcp.json'],
    mcpKey: 'mcpServers',
  },
  {
    id: 'amp',
    name: 'Amp (Sourcegraph)',
    kind: 'coding-agent',
    files: ['.amp/settings.json'],
    homeFiles: ['.config/amp/settings.json'],
    env: [],
    commands: ['amp'],
    mcpFiles: ['.amp/settings.json'],
    mcpKey: 'mcpServers',
  },
  {
    id: 'crush',
    name: 'Crush (Charm)',
    kind: 'coding-agent',
    files: ['.crush/crush.json'],
    homeFiles: ['.config/crush/crush.json'],
    env: [],
    commands: ['crush'],
    mcpFiles: ['.crush/crush.json'],
    mcpKey: 'mcpServers',
  },
  {
    id: 'trae',
    name: 'Trae',
    kind: 'editor-agent',
    files: ['.trae/mcp.json'],
    homeFiles: [],
    env: [],
    commands: [],
    mcpFiles: ['.trae/mcp.json'],
    mcpKey: 'mcpServers',
  },
  {
    id: 'kilo-code',
    name: 'Kilo Code',
    kind: 'editor-agent',
    files: ['.kilocode'],
    homeFiles: [],
    env: [],
    commands: [],
    mcpFiles: ['.kilocode/mcp.json'],
    mcpKey: 'mcpServers',
  },
  {
    id: 'aider',
    name: 'Aider',
    kind: 'coding-agent',
    files: ['.aider.conf.yml', '.aider*'],
    homeFiles: [],
    env: ['AIDER_MODEL'],
    commands: ['aider'],
    mcpFiles: [],
    mcpKey: null, // no native MCP — compose via a generic MCP proxy
  },
  {
    id: 'generic-mcp',
    name: 'Generic MCP client',
    kind: 'mcp-client',
    files: [],
    homeFiles: [],
    env: [],
    commands: [],
    mcpFiles: [],
    mcpKey: null,
  },
];

/**
 * Check whether any of the given executables exist on PATH.
 * Pure fs existence checks — never spawns a shell.
 * @param {string[]} names
 * @returns {string[]} found executable names
 */
function _commandsOnPath(names) {
  if (!names || names.length === 0) return [];
  const pathEnv = process.env.PATH || process.env.Path || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  const found = [];
  for (const name of names) {
    outer: for (const dir of dirs) {
      for (const ext of exts) {
        try {
          fs.accessSync(path.join(dir, name + ext), fs.constants.X_OK);
          found.push(name);
          break outer;
        } catch { /* not here */ }
      }
    }
  }
  return found;
}

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
    if (fw.id === 'generic-mcp') continue; // generic-mcp is a composition target, not a detectable install
    const projectPaths = _existingPaths(project, fw.files);
    const homePaths = _existingPaths(home, fw.homeFiles || []);
    const env = _collectEnv(fw.env);
    const commands = _commandsOnPath(fw.commands);

    const mcpServers = [];
    for (const rel of fw.mcpFiles) {
      const abs = _existingPaths(project, [rel])[0] || _existingPaths(home, [rel])[0];
      if (abs) mcpServers.push(..._readRegisteredMcp(abs, fw.mcpKey));
    }

    if (projectPaths.length === 0 && homePaths.length === 0 && Object.keys(env).length === 0 && commands.length === 0 && mcpServers.length === 0) {
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
        commands,
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
  { id: 'memory.temporal-forgetting', version: '1', description: 'Bounded lifespans for temporary facts: expires_at detection from content/ttl, expiry sweep, supersession (newer fact replaces older, lineage relation recorded)', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'memory.profile', version: '1', description: 'One-call static+dynamic project/agent profile (supermemory-compatible shape), optional combined query in the same round trip', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'search.unified', version: '1', description: 'Unified query surface: memories (FTS5+semantic) and code-index symbols in a single call', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'bench.provider-adapter', version: '1', description: 'MemoryBench-compatible provider interface (addMemories/search/profile/reset) plus built-in deterministic recall@k suite (single_hop, multi_hop, temporal, knowledge_update)', exposedVia: ['cli', 'node'] },
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
  { id: 'orchestration.swarm-workers', version: '1', description: 'Spawn real agent subprocesses as swarm workers via the launcher registry + compose wiring — coder actually edits files, tester actually runs tests, results feed the failure loop', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'orchestration.swarm-plan-bridge', version: '1', description: 'Import .swarm plan.json/plan-ledger specs into swarm_tasks (QA gates → reviewer/tester/verifier tasks), execute through the engine, and sync results back to plan.json + the ledger', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'orchestration.mailbox', version: '1', description: 'Inter-agent mailbox (send/inbox/mark-read) for agent coordination', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'orchestration.agent-sessions', version: '1', description: 'Namespaced agent sessions with shared memory discovery', exposedVia: ['mcp', 'cli', 'node'] },

  // Integration layer
  { id: 'integration.mcp-stdio', version: '1', description: 'MCP server over stdio JSON-RPC (110 tools)', exposedVia: ['mcp'] },
  { id: 'integration.mcp-http', version: '1', description: 'Optional REST interface on port 37777', exposedVia: ['http'] },
  { id: 'integration.git-hooks', version: '1', description: 'Auto context refresh on checkout/merge/pull/commit', exposedVia: ['cli', 'node'] },
  { id: 'integration.webhooks', version: '1', description: 'Hook actions POST to Slack/PagerDuty/CI', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'integration.discovery-files', version: '1', description: 'Auto-creates AGENTS.md, .claude/CLAUDE.md, .cursor/rules, .opencode', exposedVia: ['cli'] },
  { id: 'integration.agent-wireup', version: '2', description: 'Hard wireup: detection + MCP config merge + instruction injection for 20+ popular AI coding agents (Claude Code, Cursor, OpenCode, Freebuff, Gemini CLI, Codex, Copilot CLI, VS Code, Windsurf, Roo, Cline, Continue, Zed, Goose, Qwen, Amazon Q, Amp, Crush, Trae, Kilo, aider, generic MCP)', exposedVia: ['mcp', 'cli', 'node'] },
  { id: 'integration.seed-sanitizer', version: '1', description: 'Privacy gate on all exported knowledge: hard-blocks credential classes, redacts secrets/identity paths, strips provenance. Fail-closed.', exposedVia: ['node'] },
  { id: 'integration.seed-lifecycle', version: '1', description: 'Distributed seeds with bounded lifespan: pseudonymous envelope, per-type TTL, trust decay, germination confidence cap, local corroboration graduation', exposedVia: ['node'] },
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

// ─── Composition mapping (data-driven) ──────────────────────────────

/**
 * Per-framework wiring recipes. Every entry is declarative so wireup.js can
 * hard-apply it without per-framework logic:
 *
 *   mcp — { file, key, config } — JSON MCP registration; AC merges itself
 *         under `key`. null for YAML/TOML frameworks (advisory wiring only).
 *   strategy — human/LLM-readable one-liner of how AC plugs in.
 *   native — true when the agent reads AC's MCP registration natively.
 *
 * Command shape conventions per tool:
 *   - mcpServers (Claude/Cursor/Windsurf/Trae/…): { type: 'stdio', command, args: [] }
 *   - VS Code servers: { type: 'stdio', command }
 *   - OpenCode mcp: { type: 'local', command: [cmd], enabled: true }
 *   - Zed context_servers: { source: 'custom', command, args: [] }
 */
const COMPOSITION_RECIPES = {
  'claude-code': {
    strategy: 'register AC as an MCP stdio server in .mcp.json; instructions injected into .claude/CLAUDE.md',
    native: true,
    mcp: { file: '.mcp.json', key: 'mcpServers', config: { type: 'stdio', command: 'agentic-cortex-mcp', args: [] } },
    instructionFiles: ['.claude/CLAUDE.md', 'AGENTS.md'],
  },
  'cursor': {
    strategy: 'register AC as an MCP stdio server in .cursor/mcp.json; alwaysApply rule in .cursor/rules',
    native: true,
    mcp: { file: '.cursor/mcp.json', key: 'mcpServers', config: { type: 'stdio', command: 'agentic-cortex-mcp', args: [] } },
    instructionFiles: ['.cursor/rules/agentic-cortex.mdc', 'AGENTS.md'],
  },
  'opencode': {
    strategy: 'register AC as an OpenCode MCP addon in opencode.json; instructions in AGENTS.md (wired into instructions array)',
    native: true,
    mcp: { file: 'opencode.json', key: 'mcp', config: { type: 'local', command: ['agentic-cortex-mcp'], enabled: true } },
    instructionFiles: ['AGENTS.md'],
    extra: { ensureInstructions: { file: 'opencode.json', entry: 'AGENTS.md' } },
  },
  'freebuff': {
    strategy: 'register AC as an MCP stdio server in .freebuff/mcp.json; instructions injected into AGENTS.md',
    native: true,
    mcp: { file: '.freebuff/mcp.json', key: 'mcpServers', config: { type: 'stdio', command: 'agentic-cortex-mcp', args: [] } },
    instructionFiles: ['AGENTS.md'],
  },
  'gemini-cli': {
    strategy: 'register AC under mcpServers in .gemini/settings.json; instructions injected into GEMINI.md',
    native: true,
    mcp: { file: '.gemini/settings.json', key: 'mcpServers', config: { command: 'agentic-cortex-mcp', args: [] } },
    instructionFiles: ['GEMINI.md'],
  },
  'codex': {
    strategy: 'Codex reads MCP servers from ~/.codex/config.toml (TOML, [mcp_servers.agentic-cortex]); AC prints the exact TOML stanza — TOML is never auto-merged to avoid corrupting user config',
    native: true,
    mcp: null,
    tomlStanza: '[mcp_servers.agentic-cortex]\ncommand = "agentic-cortex-mcp"\nargs = []\n',
    instructionFiles: ['AGENTS.md'],
  },
  'copilot-cli': {
    strategy: 'register AC under mcpServers in .copilot/mcp-config.json (project) or ~/.copilot/mcp-config.json (global)',
    native: true,
    mcp: { file: '.copilot/mcp-config.json', key: 'mcpServers', config: { type: 'stdio', command: 'agentic-cortex-mcp', args: [] } },
    instructionFiles: ['AGENTS.md'],
  },
  'vscode-copilot': {
    strategy: 'register AC under servers in .vscode/mcp.json (Copilot agent mode); instructions via .github/copilot-instructions.md',
    native: true,
    mcp: { file: '.vscode/mcp.json', key: 'servers', config: { type: 'stdio', command: 'agentic-cortex-mcp', args: [] } },
    instructionFiles: ['.github/copilot-instructions.md'],
  },
  'windsurf': {
    strategy: 'register AC under mcpServers in .windsurf/mcp_config.json (or ~/.codeium/windsurf/mcp_config.json for global)',
    native: true,
    mcp: { file: '.windsurf/mcp_config.json', key: 'mcpServers', config: { type: 'stdio', command: 'agentic-cortex-mcp', args: [] } },
    instructionFiles: ['.windsurf/rules/agentic-cortex.md', 'AGENTS.md'],
  },
  'roo-code': {
    strategy: 'register AC under mcpServers in .roo/mcp.json; rules file in .roo/rules',
    native: true,
    mcp: { file: '.roo/mcp.json', key: 'mcpServers', config: { type: 'stdio', command: 'agentic-cortex-mcp', args: [] } },
    instructionFiles: ['.roo/rules/agentic-cortex.md'],
  },
  'cline': {
    strategy: 'Cline MCP servers live in VS Code globalState (configured via its UI); AC provides the copy-paste JSON and instructions via .clinerules',
    native: false,
    mcp: null,
    manualMcpConfig: { mcpServers: { 'agentic-cortex': { type: 'stdio', command: 'agentic-cortex-mcp', args: [], disabled: false } } },
    instructionFiles: ['.clinerules/agentic-cortex.md'],
  },
  'continue': {
    strategy: 'Continue uses YAML config (.continue/config.yaml, mcpServers block); AC prints the YAML block — YAML is never auto-merged',
    native: true,
    mcp: null,
    yamlBlock: 'mcpServers:\n  - name: agentic-cortex\n    command: agentic-cortex-mcp\n    args: []\n',
    instructionFiles: ['.continue/rules/agentic-cortex.md'],
  },
  'zed': {
    strategy: 'register AC under context_servers in .zed/settings.json (or Zed global settings)',
    native: true,
    mcp: { file: '.zed/settings.json', key: 'context_servers', config: { source: 'custom', command: 'agentic-cortex-mcp', args: [] } },
    instructionFiles: ['.zed/rules/agentic-cortex.md', 'AGENTS.md'],
  },
  'goose': {
    strategy: 'Goose uses YAML extensions config (~/.config/goose/config.yaml or .goose/config.yaml); AC prints the extensions block — YAML is never auto-merged',
    native: true,
    mcp: null,
    yamlBlock: 'extensions:\n  agentic-cortex:\n    cmd: agentic-cortex-mcp\n    args: []\n    enabled: true\n    type: stdio\n',
    instructionFiles: ['AGENTS.md'],
  },
  'qwen-code': {
    strategy: 'register AC under mcpServers in .qwen/settings.json; instructions injected into QWEN.md',
    native: true,
    mcp: { file: '.qwen/settings.json', key: 'mcpServers', config: { command: 'agentic-cortex-mcp', args: [] } },
    instructionFiles: ['QWEN.md'],
  },
  'amazon-q': {
    strategy: 'register AC under mcpServers in .amazonq/mcp.json (agent files in .amazonq/cli-agents/); instructions via AmazonQ.md',
    native: true,
    mcp: { file: '.amazonq/mcp.json', key: 'mcpServers', config: { type: 'stdio', command: 'agentic-cortex-mcp', args: [], timeout: 30000 } },
    instructionFiles: ['AmazonQ.md'],
  },
  'amp': {
    strategy: 'register AC under mcpServers in .amp/settings.json (project) or ~/.config/amp/settings.json (global)',
    native: true,
    mcp: { file: '.amp/settings.json', key: 'mcpServers', config: { type: 'stdio', command: 'agentic-cortex-mcp', args: [] } },
    instructionFiles: ['AGENTS.md'],
  },
  'crush': {
    strategy: 'register AC under mcpServers in .crush/crush.json (project) or ~/.config/crush/crush.json (global)',
    native: true,
    mcp: { file: '.crush/crush.json', key: 'mcpServers', config: { type: 'stdio', command: 'agentic-cortex-mcp', args: [] } },
    instructionFiles: ['AGENTS.md'],
  },
  'trae': {
    strategy: 'register AC under mcpServers in .trae/mcp.json',
    native: true,
    mcp: { file: '.trae/mcp.json', key: 'mcpServers', config: { type: 'stdio', command: 'agentic-cortex-mcp', args: [] } },
    instructionFiles: ['.trae/rules/agentic-cortex.md'],
  },
  'kilo-code': {
    strategy: 'register AC under mcpServers in .kilocode/mcp.json; rules file in .kilocode/rules',
    native: true,
    mcp: { file: '.kilocode/mcp.json', key: 'mcpServers', config: { type: 'stdio', command: 'agentic-cortex-mcp', args: [] } },
    instructionFiles: ['.kilocode/rules/agentic-cortex.md'],
  },
  'aider': {
    strategy: 'Aider has no native MCP support — compose via a generic MCP bridge (e.g. mcp-server-docs or an in-repo conventions file); AC instructions go to CONVENTIONS.md which aider reads with --read',
    native: false,
    mcp: null,
    instructionFiles: ['CONVENTIONS.md'],
  },
  'generic-mcp': {
    strategy: 'register AC as an MCP stdio server in any MCP client config',
    native: true,
    mcp: null,
    manualMcpConfig: { mcpServers: { 'agentic-cortex': { type: 'stdio', command: 'agentic-cortex-mcp', args: [] } } },
    instructionFiles: [],
  },
};

/** Tool groups exposed to every wired agent. */
const WIRE_TOOL_SETS = {
  memoryTools: ['memory_bootstrap', 'memory_save', 'memory_search', 'memory_search_all', 'memory_code_symbols', 'memory_code_context'],
  reasoningTools: ['memory_tree_search', 'memory_reason_all', 'memory_verify_code', 'memory_self_consistency'],
  auditTools: ['memory_resolve_conflict', 'memory_resolution_history'],
  orchestrationTools: ['memory_fsm', 'memory_workflow', 'memory_swarm_decompose', 'memory_swarm_execute_pipeline'],
};

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

  if (!fw || !COMPOSITION_RECIPES[fw.id]) {
    return {
      ok: false,
      error: 'Unknown framework. Discover with: agentic-cortex discover',
      known: Object.keys(COMPOSITION_RECIPES),
    };
  }

  const recipe = COMPOSITION_RECIPES[fw.id];
  const plan = {
    ok: true,
    framework: { id: fw.id, name: fw.name, kind: fw.kind },
    strategy: recipe.strategy,
    native: recipe.native,
    wiring: {
      ...WIRE_TOOL_SETS,
    },
  };

  if (recipe.mcp) {
    plan.wiring.mcpFile = path.join(project, recipe.mcp.file);
    plan.wiring.mcpKey = recipe.mcp.key;
    plan.wiring.mcpConfig = { [recipe.mcp.key]: { 'agentic-cortex': recipe.mcp.config } };
  } else {
    plan.wiring.mcpFile = null;
    if (recipe.tomlStanza) plan.wiring.tomlStanza = recipe.tomlStanza;
    if (recipe.yamlBlock) plan.wiring.yamlBlock = recipe.yamlBlock;
    if (recipe.manualMcpConfig) plan.wiring.manualMcpConfig = recipe.manualMcpConfig;
  }
  if (recipe.instructionFiles && recipe.instructionFiles.length > 0) {
    plan.wiring.instructionFiles = recipe.instructionFiles.map(f => path.join(project, f));
  }
  if (recipe.extra && recipe.extra.ensureInstructions) {
    plan.wiring.ensureInstructions = recipe.extra.ensureInstructions;
  }

  return plan;
}

// ─── Exports ────────────────────────────────────────────────────────

module.exports = {
  MANIFEST_SCHEMA_VERSION,
  CAPABILITIES,
  KNOWN_FRAMEWORKS,
  COMPOSITION_RECIPES,
  WIRE_TOOL_SETS,
  getManifest,
  writeManifestFile,
  discoverFrameworks,
  composeWithFramework,
};
