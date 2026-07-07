# agentic-cortex v4.7.0

Persistent, self-improving memory for AI coding agents (Codebuff, Claude Code, Cursor, Codex, OpenCode). Install & forget — auto-injects context via git hooks, infers what you're working on, and prevents the same mistakes from repeating across projects.

## Features

- **Zero-arg bootstrap** — `agentic-cortex bootstrap` with no arguments. Infers your task from session prompt, git branch, or recent activity. Returns structured XML context.
- **Auto type detection** — `save "title" "content"` detects the right memory type from content patterns. No `--type` flag needed.
- **Machine-wide global vault** — battle-tested learnings auto-promoted across projects. If you learned it once, you never make the mistake again on this machine.
- **Auto-promotion with relative thresholds** — top 20% confidence + 2× median utility auto-promote to global vault during reflection. Self-tunes as your project grows.
- **XML codebase graph** — deterministic static analysis, SHA-256 cached, zero LLM cost. Injected as structured XML, not markdown.
- **Agent-optimized knowledge.md** — XML-structured, 4× token reduction vs markdown. Built for LLM consumption, not human skimming.
- **39+ MCP tools** — `memory_bootstrap()`, `memory_search_all()`, `memory_machine_vault()`, `memory_promote_global()`, and more. Stdio JSON-RPC.
- **13 typed memories** — instruction, fact, decision, goal, commitment, preference, relationship, context, event, learning, observation, artifact, error.
- **Hybrid search** — FTS5 keyword + BGE semantic embeddings (768-dim) + cross-encoder reranking. Falls back gracefully when embeddings unavailable.
- **Confidence & provenance tracking** — every memory scores 0-100 confidence and source (explicit, inferred, observed).
- **Self-improving loop** — error RCA generates systemic learnings. Conflict detection finds contradictions. Evidence-based confidence scoring.
- **Save-time deduplication** — cosine similarity ≥ 0.97 reinforces existing memories instead of creating duplicates.
- **Freshness scoring** — 0-100 score combining access recency, confidence, and utility. Auto-archives stale memories.
- **Auto-maintenance scheduler** — runs freshness updates and archival every ~50 saves, minimum 6 hours between full cycles.
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
- **BGE embeddings** — Xenova/bge-base-en-v1.5 with in-memory LRU cache.
- **Embedding dimension mismatch detection** — warns when stored embeddings don't match current model dimensions.

## Install

```bash
npm install -g agentic-cortex
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
`conflicts` `answer` `analytics` `daily-summary` `reflect` `maintenance` `freshness`

### Cross-Project
`machine-memory` `machine-search` `promote-global` `transfer` `feedback`

### Setup
`setup` `init` `graph` `inject` `hook` `embed`

### Advanced
`upload` `watch` `action` `trail` `utility` `ingest` `export` `serve` `standards` `context` `session` `timeline`

## MCP Server

```bash
agentic-cortex-mcp
```

39+ tools over stdio JSON-RPC. Call `memory_bootstrap()` with no arguments to start.

## 13 Memory Types

`instruction` `fact` `decision` `goal` `commitment` `preference` `relationship` `context` `event` `learning` `observation` `artifact` `error`

## Environment

| Variable | Default | Description |
|---|---|---|
| `AGENTIC_CORTEX_PROJECT` | cwd | Default project path |
| `AGENTIC_CORTEX_SESSION` | — | Current session ID |
| `AGENTIC_CORTEX_PORT` | 37777 | HTTP server port |
| `LLAMA_CPP_BASE_URL` | http://127.0.0.1:8081 | LLM for summaries/QA |

## License

MIT © 2026 zallauddin

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files, to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
