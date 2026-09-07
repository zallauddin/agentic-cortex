# Architecture — Agentic Cortex

Agentic Cortex (AC) is a **machine-local, self-improving memory and reasoning layer** for AI coding agents. It runs as an MCP server that any agent (Claude Code, Cursor, OpenCode, Codex, Windsurf, Gemini CLI, Freebuff, …) wires into — one SQLite vault per machine, shared by every agent that talks to it.

## The 5-layer brain

```
 Layer 1  Capture      observations, decisions, failures, sessions (raw experience)
 Layer 2  Structure    reflection, conflict detection, crystallization into principles
 Layer 3  Recall       FTS + semantic (BGE embeddings) hybrid search, outcome weighting
 Layer 4  Reasoning    tree-of-thoughts (MCTS/beam), PRM step verification,
                       self-consistency, reflexion, REPL executor, budget forcing
 Layer 5  Growth       experiment spawning, plateau detection, self-improvement loop
```

## Component map

```mermaid
graph TB
    subgraph Agents["AI agents (22 frameworks detected)"]
        CC[Claude Code] / CC2[Cursor] / CC3[OpenCode]
    end
    CC -->|MCP stdio| SRV
    CC2 -->|MCP stdio| SRV
    CC3 -->|MCP stdio| SRV

    SRV[src/mcp/server.js<br/>130 MCP tools] --> API[src/api/index.js<br/>unified API]
    CLI[cli.js<br/>45+ commands] --> API
    HTTP[cli.js serve<br/>/health /metrics /dashboard] --> API

    API --> CORE[src/core/*]
    subgraph CORE["Core modules"]
        DB[db.js · SQLite vault]
        SES[session.js]
        LLM[llm-adapter.js<br/>openai · xenova · off]
        TS[tree-search.js · prm.js · reflexion-loop.js]
        SI[self-improve.js<br/>8 improvement hooks]
        WIRE[wireup.js · manifest.js<br/>agent detection + hard wireup]
        SEED[seed-sanitizer.js · seed-lifecycle.js<br/>distributed seeds w/ TTL + redaction]
        SYNC[git-sync.js · markdown-codec.js]
    end
    API --> DB
    API --> LLM
    LLM -->|OpenAI-compatible /v1/chat/completions| LOCAL[llama.cpp · LM Studio · Ollama · OpenRouter]
    LLM -->|local pipeline| XENO[@xenova/transformers]
```

## Key flows

### Wireup (agent → AC, zero questions asked)

`manifest.js` detects ~22 agent frameworks via evidence (project/home config files, env vars, PATH executables). `wireup.js` then **hard-wires** AC into each: merges the MCP registration into the agent's JSON config (idempotent, never clobbers sibling servers) and injects a version-stamped instruction section telling the agent that AC owns memory, sessions, and machine-wide knowledge. Exposed as `agentic-cortex wireup` (CLI), `memory_wireup` (MCP tool).

### Distributed seeds (knowledge shared, privacy kept)

```
local vault ──promote──▶ seed-sanitizer ──▶ git-sync push
                              │ fail-closed: blocks credentials/keys,
                              │ redacts emails/user paths/IPs, strips identity
git-sync pull ──▶ seed-lifecycle (germination)
                   pseudonymous origin · per-type TTL · trust decay
                   quarantine until 60% confidence · graduates at 85% once
                   re-proven locally · expired seeds refused at import
```

### LLM provider abstraction (`src/core/llm-adapter.js`)

Every reasoning module funnels through one entry point, `callProvider(messages, opts)`:

| Provider (`AGENTIC_CORTEX_LLM_PROVIDER`) | Backing | Use case |
|---|---|---|
| `openai` (default) | any OpenAI-compatible `/v1/chat/completions`: llama.cpp, LM Studio, Ollama, vLLM, OpenRouter, OpenAI | full reasoning |
| `xenova` | `@xenova/transformers` local pipeline (default `Xenova/LaMini-Flan-T5-77M`) | fully offline, no network |
| `off` | always `null` → deterministic/template fallbacks everywhere | deterministic mode, CI |

Contract: `callProvider` never throws for "unavailable" — it returns `null` and callers fall back. Custom providers register via `registerProvider(name, adapter)`.

### Degradation ladder (never fail because the model is away)

```
LLM unavailable
  → template summaries (session.js templateSummary)
  → deterministic reasoner (deterministic-reasoner.js)
  → keyword-only search (hybridSearch survives null embeddings)
```

## Storage

One SQLite database (better-sqlite3), default path resolved in `src/core/db-path.js`, overridable with `AGENTIC_CORTEX_DB`. Schema is created/migrated by `db.js ensureSchema`. FTS5 for keyword search; embeddings stored as JSON per observation (BGE-base-en-v1.5 via `embedding.js`, off by default for memory safety).

## Testing

`npm test` → `node --test tests/*.test.js` (~820 tests). No network, no LLM required: the suite runs with deterministic fallbacks.
