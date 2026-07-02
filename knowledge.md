# Agent Memory System — Install & Forget

You have `agentic-cortex` installed globally. This memory system persists across sessions without any user action required.

## Auto-Save Protocol (CRITICAL)

**You MUST save observations automatically without being asked.** After ANY of these events, immediately run:

```bash
agentic-cortex save "Short title" "Detailed content with context" --type <type> --importance <1-10> --confidence <0-100> --tags "relevant,tags"
```

### When to Auto-Save (do not wait for the user to tell you):

| Trigger | Type | Confidence | Example |
|---|---|---|---|
| Architecture/design choice made | `decision` | 90 | "Chose SQLite over Postgres for local agent memory" |
| Bug found and fixed | `error` | 95 | "Fixed null pointer in orchestrator.ts line 42" |
| Project context discovered | `context` | 80 | "The project uses Prisma with PostgreSQL on port 5432" |
| User states a preference | `preference` | 100 | "User prefers concise answers with code examples" |
| Non-obvious gotcha found | `fact` | 85 | "Windows paths need forward-slash normalization for SQLite" |
| Feature completed | `event` | 95 | "Published agentic-cortex v3.1.0 to npm" |
| New insight learned | `learning` | 75 | "BGE embeddings outperform all-MiniLM for code-related queries" |
| Step-by-step procedure | `instruction` | 90 | "To restart the pipeline: kill PID, rm stop file, re-run script" |

### Quick Reference

- **Save:** `agentic-cortex save "title" "content" --type TYPE --importance N --tags "t1,t2"`
- **Search:** `agentic-cortex search "query" --project /path/to/project`
- **Answer from memory:** `agentic-cortex answer "question" --project /path/to/project`
- **Forget:** `agentic-cortex forget <id>` (soft-delete) or `--hard` (permanent)
- **Daily summary:** `agentic-cortex daily-summary --project /path/to/project`

### 13 Memory Types

`instruction` `fact` `decision` `goal` `commitment` `preference` `relationship` `context` `event` `learning` `observation` `artifact` `error`

### At Session Start

The context below is AUTO-INJECTED by git hooks (post-merge, post-checkout) or `agentic-cortex inject`. It contains:

1. **Session memories** — what was built, decided, fixed, discovered (with confidence scores)
2. **Codebase graph** — every source file, API route, import, and export

Use this pre-computed knowledge to skip discovery. No need to re-read files you already know about.

<!-- MEMORY_CONTEXT_START -->
<!-- Auto-injected by agentic-cortex at 2026-07-02T18:23:16.614Z -->

## Codebase Graph
Generated: 2026-07-02T18:23:16.213Z | 24 source files | 0 API routes

### Scripts
- `scripts/generate-graph.mjs`
- `scripts/inject-memory.mjs`
<!-- MEMORY_CONTEXT_END -->
