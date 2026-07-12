# LinkedIn Post: agentic-cortex v4.7.1

---

**AI agents have no memory. Here's what they're forgetting every session:**

The bug pattern you debugged for 3 hours yesterday. The decision to use SQLite over Postgres. The Windows path normalization gotcha. The user's preference for async/await over `.then()`. Every decision, every fix, every lesson — gone the moment your session ends.

I built **agentic-cortex** to fix this. v4.7.1 just shipped. It's long-term memory for coding agents — persist, search, and recall across sessions and projects.

---

## What It Does

### Core Memory Engine
- 13 typed memories (instruction, fact, decision, goal, commitment, preference, relationship, context, event, learning, observation, artifact, error)
- Confidence scoring (0-100) + provenance tracking (explicit, inferred, observed)
- BGE 768-dim embeddings with hybrid FTS5+semantic search and cross-encoder reranking
- Save-time cosine similarity deduplication (≥0.97 = reinforce, don't duplicate)
- Temporal queries (as-of date, changed-since)

### 🚀 Zero-Arg Bootstrap
- `agentic-cortex bootstrap` — no arguments needed
- Infers your task from git branch, session prompt, or recent activity
- Returns structured XML context: actionable insights (LLM-summarized), tiered relevant memories (critical/important), recent sessions, warnings about incorrect memories, collapsed coding standards, codebase graph, machine-wide global vault
- Auto-starts a session if none is active

### 🧠 Auto Type Detection
- Pattern-matches content for error, decision, learning, preference, fact, instruction, event, goal
- No `--type` flag needed unless you want to override

### 🌐 Machine-Wide Global Vault (Cross-Project Immune System)
- Learnings from Project A auto-protect agents in Projects B, C, D
- Auto-promotion uses relative thresholds (top 20% confidence, 2× median utility) — self-tunes as projects grow
- Manual promotion with `agentic-cortex promote-global <id>`
- `agentic-cortex machine-search "query"` searches across ALL projects
- `agentic-cortex machine-memory --analytics` shows cross-project stats

### 🔄 Self-Improving Loop
- Error RCA generates systemic learnings automatically
- Conflict detection finds contradictions via semantic similarity + LLM
- Evidence-based confidence scoring from intent→action→outcome triplets
- Freshness scoring (0-100) combines access recency, confidence, utility — auto-archives stale
- Auto-maintenance scheduler runs every ~50 saves, minimum 6h between cycles

### 📊 Codebase Graph
- Deterministic static analysis — zero LLM cost, SHA-256 cached
- Extracts: files, exports, imports, function signatures, API routes, Prisma schema, layers (UI/API/Service/Data), paradigms, tech stack
- Outputs structured XML — not markdown. Token-optimized for LLM consumption
- Auto-injected on git checkout, merge, pull, commit via hooks

### 🤖 Agent-Optimized Output
- knowledge.md is XML-structured, ~4× fewer tokens than markdown equivalent
- Discovery files auto-created for Claude Code, Cursor, OpenCode
- MCP server with 39+ tools over stdio JSON-RPC — zero-config, no HTTP port needed
- Pre-loaded coding standards (DRY, KISS, SOLID, Clean Code, Karpathy) — always injected

### ➕ Additional Intelligence
- Grounded QA: retrieve relevant memories + LLM answer with source citations
- Conversation transcript ingestion: regex + LLM extracts decisions, errors, learnings
- Intent→Action→Outcome tracking with linked relations
- Multi-agent sharing with namespaced sessions
- Skill/procedure extraction with structured fields
- Daily summaries (LLM with template fallback)
- Obsidian export with wikilinks and tag indexes
- File upload with chunking and embedding
- File watcher daemon for auto-capture
- HTTP API server on port 37777

---

## Comparison: What Others Leave Out

### vs. LangChain Memory
agentic-cortex has: auto type detection, zero-arg bootstrap, machine-wide global vault with relative thresholds, error→learning RCA, conflict detection, XML codebase graph, git hook auto-injection, freshness scoring, save deduplication, pre-loaded coding standards, transcript ingestion, 39+ MCP tools

### vs. ChromaDB / Pinecone (Vector DBs)
agentic-cortex has: 13 typed memories (instruction, fact, decision, goal, commitment, preference, relationship, context, event, learning, observation, artifact, error — not just raw vectors), confidence/provenance tracking, save deduplication, self-improving loop, global vault with cross-project auto-promotion, codebase graph, git hooks, coding standards, intent→action→outcome tracking, grounded QA — plus it runs entirely local, no API costs

### vs. Mem0
agentic-cortex adds: zero-arg bootstrap with task inference, machine-wide global vault, relative auto-promotion thresholds, XML codebase graph, deterministic graph generation, 13 memory types including commitment, relationship, goal, and artifact (Mem0 has fewer, broader categories), conflict detection via semantic+LLM, freshness scoring with auto-archival, auto-maintenance scheduler, pre-loaded coding standards, transcript ingestion, 39+ MCP tools

### vs. Cursor Rules / Manual Context Files
agentic-cortex adds: automatic memory persistence (not manual), semantic search across 13 typed categories (instruction, fact, decision, goal, commitment, preference, relationship, context, event, learning, observation, artifact, error), confidence decay over time, cross-project knowledge transfer, evidence-based utility scoring, self-improving RCA loop, XML codebase graph auto-updating on git operations, MCP tool integration

---

## The Stack
Node.js · SQLite (single DB per machine) · Xenova BGE embeddings (entirely local) · Hybrid FTS5+semantic search · Cross-encoder reranking · Optional llama.cpp for LLM summarization

---

**368 tests passing.** MIT licensed.

```bash
npm install -g agentic-cortex
```

GitHub: https://github.com/zallauddin/agentic-cortex
npm: https://www.npmjs.com/package/agentic-cortex

If your agents keep reinventing the same solutions every session, give them a memory system that persists, self-improves, and protects across projects. #ai #codingagents #opensource #claude #cursor #llm #memory #typescript
