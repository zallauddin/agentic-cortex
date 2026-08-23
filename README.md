# agentic-cortex v6.5.0 — The 5-Layer Agent Brain + Test-Time Reasoning

Persistent, self-improving memory **and orchestration** for AI coding agents (Codebuff, Claude Code, Cursor, Codex, OpenCode). Implements the full **5-Layer Graph Engineering** framework: Prompt Engineering → Context Engineering → Harness Engineering → Loop Engineering → Graph Engineering. Install & forget — auto-injects context via git hooks, infers what you're working on, detects when improvement stalls, coordinates multi-agent teams, and prevents the same mistakes from repeating across projects.

## Features

- **Zero-arg bootstrap** — `agentic-cortex bootstrap` with no arguments. Infers your task from session prompt, git branch, or recent activity. Returns structured XML context.
- **Auto type detection** — `save "title" "content"` detects the right memory type from content patterns. No `--type` flag needed.
- **Machine-wide global vault** — battle-tested learnings auto-promoted across projects. If you learned it once, you never make the mistake again on this machine.
- **Auto-promotion with relative thresholds** — top 20% confidence + 2× median utility auto-promote to global vault during reflection. Self-tunes as your project grows.
- **XML codebase graph** — deterministic static analysis, SHA-256 cached, zero LLM cost. Injected as structured XML, not markdown.
- **Agent-optimized knowledge.md** — XML-structured, 4× token reduction vs markdown. Built for LLM consumption, not human skimming.
- **57 MCP tools** — `memory_bootstrap()`, `memory_search_all()`, `memory_machine_vault()`, `memory_promote_global()`, plus a multi-agent mailbox (`memory_send`/`memory_inbox`), provider discovery (`memory_provider`), recovery (probe-gated retry), prompts, plateau detection, workflows, FSM, and rules. Stdio JSON-RPC.
- **13 typed memories** — instruction, fact, decision, goal, commitment, preference, relationship, context, event, learning, observation, artifact, error.
- **Hybrid search** — FTS5 keyword + BGE semantic embeddings (768-dim) + cross-encoder reranking. Falls back gracefully when embeddings unavailable.
- **Confidence & provenance tracking** — every memory scores 0-100 confidence and source (explicit, inferred, observed).
- **5-Layer Graph Engineering** — full implementation of Prompt Engineering (versioned template registry), Context Engineering (hybrid search + reranking), Harness Engineering (MCP tools + webhooks), Loop Engineering (self-improvement + plateau detection), and Graph Engineering (FSM + rules + multi-agent DAG workflows).
- **Prompt template registry** — 10 versioned, outcome-tracked templates for every LLM call. Render templates with variable substitution via API or MCP. Centralized prompt evolution powered by eval log feedback.
- **Self-improving loop with meta-cognition** — error RCA generates systemic learnings. Conflict detection finds contradictions. Evidence-based confidence scoring. **Plateau detection** identifies stalled improvement and triggers breakthrough analysis.
- **Multi-agent workflows** — DAG-based workflow executor with FSM bridge. Workflow steps can spawn sub-agents tracked in state machines. Built-in multi-agent workflows: `code-review-team`, `incident-response-squad`.
- **FSM orchestration engine** — state machines for coding, debugging, and review workflows. Agents transition between states with guard conditions and entry/exit actions.
- **Declarative rule engine** — priority-based condition→action rules that fire on events. Built-in rules for error escalation, auto-crystallization, and context capture.
- **Webhook support** — hook actions can POST to external HTTP endpoints with template interpolation and configurable retries. Bridge agentic-cortex to Slack, PagerDuty, CI pipelines, or any HTTP service.
- **Save-time deduplication** — cosine similarity ≥ 0.97 reinforces existing memories instead of creating duplicates.
- **Freshness scoring** — 0-100 score combining access recency, confidence, and utility. Auto-archives stale memories.
- **Auto-maintenance scheduler** — runs freshness updates and archival every ~50 saves, minimum 6 hours between full cycles.
- **Tiered memory crystallization** — raw observations compress upward through layers: raw (1) → synthesis (2) → principle (3). Principles are always-injected, load-bearing knowledge.
- **Immutable evaluation log** — append-only audit trail (AutoGTM's results.tsv pattern). Every evaluation preserved forever for benchmarking and plateau detection.
- **Intent → Action → Outcome tracking** — linked triplets with relations for evidence-based learning verification.
- **Multi-agent sharing** — namespaced agent sessions with shared memory discovery.
- **Skill/procedure extraction** — structured fields (steps, triggers, preconditions, postconditions) with dedicated search.
- **Pre-loaded coding standards** — DRY, KISS, SOLID, Clean Code, Karpathy guidelines auto-seeded on init. Always injected into context.
- **Conversation transcript ingestion** — regex + LLM fallback extracts decisions, errors, learnings, preferences, and facts from chat logs.
- **Grounded QA** — retrieve relevant memories + LLM answer with source citations.
- **Git hook auto-injection** — context auto-refreshes on checkout, merge, pull, and commit.
- **Multi-agent discovery files** — auto-creates `.claude/CLAUDE.md`, `.cursor/rules/agentic-cortex.mdc`, `.opencode/agentic-cortex.md`.
- **Temporal queries** — search as-of specific dates or filter by changes since.
- **Daily summaries** — LLM-generated or template-fallback summaries of each day's observations.
- **Obsidian export** — one-way read-only mirror to an Obsidian vault with wikilinks and tag indexes.
- **File upload** — chunk and embed .md, .txt, .json, .csv, .py, .ts, .prisma, and more into memory.
- **HTTP API server** — optional REST interface on port 37777 for external tool integration.
- **Multi-agent discovery** — auto-creates discovery files for Claude Code, Cursor, and OpenCode on setup.
- **🌳 Tree of Thoughts / MCTS reasoning** — inference-time graph search over reasoning branches. Beam search, MCTS, and greedy strategies with adaptive compute budget.
- **🔍 Process Reward Model (PRM)** — 3-tier step-level verification: deterministic checks, LLM-as-judge, and memory cross-check. Scores each reasoning step 0.0-1.0.
- **📊 Adaptive compute budget** — Snell et al. compute-optimal allocation: estimates problem difficulty from memory and adjusts beam width, depth, and token budget.
- **💻 Program-aided reasoning (PAL/PoT)** — generate and execute verification code in a sandbox. Deterministic arithmetic, graph traversal, and constraint checking.
- **🔄 Reflexion loop** — in-context self-correction: failed reasoning paths become memory, preventing repeated mistakes within the same session.
- **🗳️ Self-consistency decoding** — sample N independent chains with temperature, majority-vote the answer. Optional PRM-weighted voting gives higher-quality paths more influence.
- **💪 Budget forcing (s1)** — enforce minimum reasoning depth by suppressing early stops and appending doubt heuristics. Force conclusion synthesis at upper token bound. Controls compute per problem independently of architectural changes.
- **BGE embeddings** — Xenova/bge-base-en-v1.5 with in-memory LRU cache.
- **Embedding dimension mismatch detection** — warns when stored embeddings don't match current model dimensions.

## Install

```bash
npm install -g agentic-cortex
```

### Lightweight install (no semantic embeddings)

Semantic search and reranking are powered by `@xenova/transformers`, which is an
**optional dependency** — the core package (SQLite storage, FTS5 keyword search,
consolidation, self-improvement, MCP tools) works fully without it and degrades
semantic features to deterministic keyword search.

```bash
# Skip the ~500 MB embedding stack entirely (~12 MB install)
npm install -g agentic-cortex --omit=optional

# Add semantic embeddings back later
npm install -g @xenova/transformers
```

## Quick Start

```bash
cd your-project

# One command: init + graph + inject + discovery files + git hooks
agentic-cortex setup

# At session start, just run:
agentic-cortex bootstrap
```

## Core Commands

| Command | Description |
|---|---|
| `bootstrap` | 🔑 Bootstrap task context — zero args, auto-inferring |
| `save <title> <content>` | Save observation — type auto-detected |
| `search <query>` | Hybrid search (FTS5 + semantic) with optional `--rerank` |
| `machine-search <query>` | Search across ALL projects on this machine |
| `machine-memory` | View/search the machine-wide global vault |
| `promote-global <id>` | Promote a memory to machine-wide scope |
| `feedback <id> --type helpful\|incorrect` | Reinforce or flag a memory |
| `forget <id>` | Soft-delete (`--hard` for permanent) |
| `get <id>` | View full memory with structured fields |
| `edit <id>` | Edit memory (version history preserved) |

## How It Works

### Zero-Arg Bootstrap

`bootstrap` infers your task and returns structured XML context:

```xml
<agentic_cortex_context project="/my/project" task="fix login bug">
  <session_started id="sess_abc123"/>
  <actionable_insights>...</actionable_insights>
  <relevant_memories>
    <tier priority="critical">...</tier>
    <tier priority="important">...</tier>
  </relevant_memories>
  <recent_sessions>...</recent_sessions>
  <warnings>...</warnings>
  <coding_standards collapsed="true">...</coding_standards>
  <global_vault>...</global_vault>
  <codebase_graph>...</codebase_graph>
</agentic_cortex_context>
```

### Machine-Wide Global Vault

Auto-promote uses relative thresholds — the system gets stricter as your project grows:

```bash
# View cross-project analytics
agentic-cortex machine-memory --analytics

# Search across all projects
agentic-cortex machine-search "Windows path normalization"

# Manually promote
agentic-cortex promote-global 42
```

### Auto-Detect Memory Types

| Pattern | Type | Example |
|---|---|---|
| "error", "bug", "crash", "failed" | `error` | `save "Null ptr" "Error in auth.ts:42"` |
| "chose", "decided", "going with" | `decision` | `save "DB" "Chose SQLite over Postgres"` |
| "learned", "realized", "found that" | `learning` | `save "Paths" "Windows needs forward-slash"` |
| "prefer", "rather than" | `preference` | `save "Style" "Prefer async/await"` |
| "project uses", "configured with" | `fact` | `save "Stack" "Uses Prisma with PostgreSQL"` |
| "step", "procedure", "how to" | `instruction` | `save "Deploy" "Step 1: build, step 2: push"` |
| "published", "released", "deployed" | `event` | `save "Release" "Published v4.7.0 to npm"` |
| "goal", "objective", "milestone" | `goal` | `save "Target" "Need to achieve 95% coverage"` |

## All Commands

### Core
`bootstrap` `save` `search` `get` `edit` `forget` `list` `bulk`

### Intelligence
`conflicts` `answer` `analytics` `daily-summary` `reflect` `maintenance` `freshness` `crystallize` `eval-log`

### Brain Orchestration
`fsm` `rules` `workflow` `experiment`

### Cross-Project
`machine-memory` `machine-search` `promote-global` `transfer` `feedback`

### Setup
`setup` `init` `graph` `inject` `hook` `embed`

### Advanced
`upload` `watch` `action` `trail` `utility` `ingest` `export` `serve` `standards` `context` `session` `timeline` `cortex-ui`

## MCP Server

```bash
agentic-cortex-mcp
```

**57 tools** over stdio JSON-RPC. Call `memory_bootstrap()` with no arguments to start.

### Graph Engineering Tools

| Tool | Layer | Description |
|------|-------|-------------|
| `memory_prompts_list` | Layer 1: Prompt Engineering | List all 10 versioned prompt templates |
| `memory_prompts_render` | Layer 1: Prompt Engineering | Render a template with variable substitution |
| `memory_plateau_check` | Layer 4: Loop Engineering | Detect stalled improvement; triggers breakthrough analysis |
| `memory_workflow_agents` | Layer 5: Graph Engineering | List FSM-tracked sub-agents in multi-agent workflows |
| `memory_fsm` | Layer 5: Graph Engineering | Manage agent state machines (start, transition, query) |
| `memory_rules` | Layer 5: Graph Engineering | Manage declarative brain rules (list, enable, disable, evaluate) |
| `memory_workflow` | Layer 5: Graph Engineering | Run multi-step DAG workflows with dependency ordering |
| `memory_crystallize` | Layer 4: Loop Engineering | Compress raw observations upward through tiered layers |
| `memory_experiment` | Layer 4: Loop Engineering | Spawn/list controlled experiments (hypothesis testing) |
| `memory_eval_log` | Layer 4: Loop Engineering | Query the immutable evaluation log for benchmarking |

## For Coding Agents (Use AC as Your Memory Provider)

agentic-cortex is **not a hosted/cloud service** — there is no central server to
"deploy" AC to. It runs locally on the same machine as your coding agent, in one
of two forms:

1. **MCP server (stdio subprocess).** `agentic-cortex-mcp` is a zero-arg binary.
   The coding agent launches it as a child process and speaks JSON-RPC over
   stdin/stdout. Register it once in the agent's own config, then call
   `memory_bootstrap({})` at session start and `memory_save({...})` after
   decisions and fixes.

   | Coding agent | Where to register the server |
   |---|---|
   | Claude Code | `.mcp.json` (project) or `claude_desktop_config.json` (global) |
   | Cursor | `.cursor/mcp.json` |
   | OpenCode | `opencode.json` → `mcpServers` |
   | Any MCP client | `{ "mcpServers": { "agentic-cortex": { "type": "stdio", "command": "agentic-cortex-mcp", "args": [] } } }` |

2. **Node library (in-process).** For agents that embed AC directly (e.g. a
   custom orchestrator or the `cortex-swarm` persona swarm):
   `require('agentic-cortex')`, or set `AGENTIC_CORTEX_PATH` to its
   `src/api/index.js`.

**Where the memory lives:** a single machine-global SQLite file —
`%APPDATA%/agentic-cortex/agentic-cortex.db` on Windows and
`~/.local/share/agentic-cortex/agentic-cortex.db` on Linux/macOS (override with
`AGENTIC_CORTEX_DB`). There is no database server to point at; each machine runs
its own brain. Cross-machine sharing uses the optional git memory repo
(`agentic-cortex setup` + `AGENTIC_CORTEX_MEMORY_REPO`), not a live server.

**Discover yourself:** call the `memory_provider` MCP tool for the provider
manifest (name, version, memory/relation types, multi-agent mailbox, workflows,
recovery, and usage instructions).

## 18 Memory Types

`instruction` `fact` `decision` `goal` `commitment` `preference` `relationship` `context` `event` `learning` `observation` `artifact` `error` `pattern` `synthesis` `principle` `experiment` `action`

### Tiered Memory Layers (AutoGTM's Compounding Brain)

| Layer | Type | Description |
|-------|------|-------------|
| 1 — Raw | `observation`, `error`, `fact`, `decision`, etc. | Direct observations from agent activity |
| 2 — Synthesis | `learning`, `synthesis`, `pattern` | LLM-compressed clusters of related raw observations |
| 3 — Principle | `principle` | Battle-tested knowledge verified 3+ times; always injected in context |

## Environment

| Variable | Default | Description |
|---|---|---|
| `AGENTIC_CORTEX_PROJECT` | cwd | Default project path |
| `AGENTIC_CORTEX_SESSION` | — | Current session ID |
| `AGENTIC_CORTEX_PORT` | 37777 | HTTP server port |
| `LLAMA_CPP_BASE_URL` | http://127.0.0.1:8081 | LLM for summaries/QA |

## Architecture: The 5-Layer Graph Engineering Brain

```
Layer 1: Prompt Engineering  ──  src/core/prompts.js     (10 versioned templates)
Layer 2: Context Engineering  ──  src/core/search.js       (hybrid FTS5 + semantic)
                                  src/core/embedding.js    (BGE-base, cross-encoder)
                                  src/core/relations.js    (memory graph)
Layer 3: Harness Engineering  ──  src/mcp/server.js       (57 MCP tools, webhooks)
                                  src/core/hooks.js        (event-driven automation)
Layer 4: Loop Engineering     ──  src/core/self-improve.js (6 improvement hooks)
                                  src/core/reflection.js   (consolidate, crystallize)
Layer 5: Graph Engineering    ──  src/core/fsm.js          (state machine engine)
                                  src/core/rules.js        (declarative rule engine)
                                  src/core/workflow.js     (DAG workflow + multi-agent)
```

## License

MIT © 2026 zallauddin

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files, to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
