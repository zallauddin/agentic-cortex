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
<!-- Auto-injected by agentic-cortex at 2026-07-03T22:42:21.525Z -->

## Codebase Graph
*35 source files | 0 API routes | Generated 2026-07-03T22:42:21.501Z*

### Architecture
**Patterns:** Event-Driven, CLI Tool
**Stack:** Databases: SQLite | Tools: Xenova Transformers (AI/ML)

### Data Flow
`API → Service`
Files per layer: UI=0 API=1 Service=32 Data=0
**Hub files (most imported):** `scripts/inject-memory.mjs`, `scripts/generate-graph.mjs`, `cli.js`, `src/api/index.js`, `src/core/conflict.js`

### Core Libraries (14)
- `src/core/conflict.js` — fns: checkConflicts(db, opts)
- `src/core/constants.js` — fns: getProjectDefault(opts)
- `src/core/db-path.js` — fns: ensureDir(filePath), getDbDir(), getDbPath(), getLegacyDbPath(), getLegacyDbPathIfExists()
- `src/core/db.js` — fns: ensureSchema(db), getDb(), getDbPath_()
- `src/core/embedding.js` — fns: _cacheGet(key), _cacheSet(key, value), clearEmbeddingCache(), computeEmbedding(text), cosineSimilarity(a, b)
- `src/core/export.js` — fns: exportJSON(db, opts), exportMarkdown(db, opts), findRelated(obs, allObs), importJSON(db, data, opts), sanitizeFilename(title, id)
- `src/core/hooks.js` — fns: createHook(db, opts), deleteHook(db, id), evaluateCondition(type, value, observation, context), executePersistedHook(db, hook, observation, context), getPersistedHooks(db, event)
- `src/core/index.js`
- `src/core/reflection.js` — fns: archiveSuperseded(db, opts), consolidateMemories(db, opts), findSimilarClusters(observations, threshold), generateConsolidatedSummary(cluster), getEmbeddedObservations(db, project, limit)
- `src/core/relations.js` — fns: addRelation(db, opts), deleteRelation(db, relationId), getGraph(db, opts), getRelations(db, observationId), listRelationTypes(db)
- `src/core/search.js` — fns: buildWhereClause(opts), hybridSearch(db, query, queryVec, opts), keywordSearch(db, opts), rerankResults(query, results), sanitizeDate(dateStr)
- `src/core/self-improve.js` — fns: autoResolveConflicts(db, opts), initHooks(saveFn), learnFromError(db, errorObs), resetState(), setSaveFunction(saveFn)

### Scripts
- `scripts/generate-graph.mjs`
- `scripts/inject-memory.mjs`
<!-- MEMORY_CONTEXT_END -->
