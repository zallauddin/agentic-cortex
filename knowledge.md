<agentic_cortex>
<bootstrap>agentic-cortex bootstrap</bootstrap>

<auto_save>
Agentic-cortex is installed globally. Save observations automatically; never wait to be asked.
Command: agentic-cortex save "title" "content"
Type auto-detected from content patterns. Override with --type TYPE --importance 1-10 --confidence 0-100 --tags "t1,t2".
</auto_save>

<save_triggers format="type|confidence: description">
decision|90: architecture/design choice, technology selection
error|95: bug found, exception, crash, failure
context|80: project dependency, configuration, environment discovered
preference|100: user explicitly states a preference
fact|85: non-obvious gotcha, platform-specific quirk
event|95: feature completed, release, deployment
learning|75: new insight, discovered pattern, realization
instruction|90: step-by-step procedure, pipeline, workflow
</save_triggers>

<commands>
bootstrap: agentic-cortex bootstrap
save: agentic-cortex save "title" "content"
search: agentic-cortex search "query" --project .
machine-search: agentic-cortex machine-search "query"
machine-memory: agentic-cortex machine-memory [--analytics]
forget: agentic-cortex forget <id> [--hard]
feedback: agentic-cortex feedback <id> --type helpful|incorrect
answer: agentic-cortex answer "question" --project .
standards: agentic-cortex standards --search "topic"
daily-summary: agentic-cortex daily-summary --project .
</commands>

<memory_types>instruction fact decision goal commitment preference relationship context event learning observation artifact error</memory_types>

<mcp>agentic-cortex-mcp — 39+ tools. Call memory_bootstrap() with no args first.</mcp>

<injected_context>
Below is auto-injected by git hooks (post-merge, post-checkout) or agentic-cortex inject.
Contains: coding standards, session memories, codebase graph.
Use to skip rediscovery of known files and decisions.
</injected_context>
</agentic_cortex>

<!-- MEMORY_CONTEXT_START -->
<!-- Auto-injected by agentic-cortex at 2026-07-07T05:19:26.390Z -->

# Agentic Cortex - Project Context

## Key Observations
### Event
- README v4.7.0 update
- README v4.7.0 update
## Codebase Graph
*38 source files | 0 API routes | Generated 2026-07-07T05:18:46.494Z*

### Architecture
**Patterns:** Event-Driven, CLI Tool
**Stack:** Databases: SQLite | Tools: Xenova Transformers (AI/ML)

### Data Flow
`API → Service`
Files per layer: UI=0 API=1 Service=33 Data=0
**Hub files (most imported):** `scripts/inject-memory.mjs`, `scripts/generate-graph.mjs`, `cli.js`, `scripts/auto-setup.js`, `scripts/create-discovery-files.js`

### Core Libraries (15)
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
- `scripts/auto-setup.js`
- `scripts/create-discovery-files.js`
- `scripts/generate-graph.mjs`
- `scripts/inject-memory.mjs`
<!-- MEMORY_CONTEXT_END -->
