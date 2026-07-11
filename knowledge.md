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
<!-- Auto-injected by agentic-cortex at 2026-07-11T21:35:53.836Z -->

<codebase_graph files="38" api_routes="0" generated="2026-07-11T21:35:53.751Z">
  <architecture patterns="Event-Driven, CLI Tool" stack="Databases: SQLite | Tools: Xenova Transformers (AI/ML)"/>
  <layers dataflow="API → Service" ui="0" api="1" service="33" data="0"/>
  <hub_files>scripts/inject-memory.mjs, scripts/generate-graph.mjs, cli.js, scripts/auto-setup.js, scripts/create-discovery-files.js, src/api/index.js, src/core/conflict.js, src/core/constants.js</hub_files>
  <libraries>
    <file path="src/core/conflict.js" layer="Service" fns="checkConflicts(db,opts)"/>
    <file path="src/core/constants.js" layer="Service" fns="getProjectDefault(opts)"/>
    <file path="src/core/db-path.js" layer="Service" fns="ensureDir(filePath); getDbDir(); getDbPath(); getLegacyDbPath(); getLegacyDbPathIfExists()"/>
    <file path="src/core/db.js" layer="Service" fns="ensureSchema(db); getDb(); getDbPath_()"/>
    <file path="src/core/embedding.js" layer="Service" fns="_cacheGet(key); _cacheSet(key,value); clearEmbeddingCache(); computeEmbedding(text); cosineSimilarity(a,b); disposePipelines()"/>
    <file path="src/core/export.js" layer="Service" fns="exportJSON(db,opts); exportMarkdown(db,opts); findRelated(obs,allObs); importJSON(db,data,opts); sanitizeFilename(title,id)"/>
    <file path="src/core/hooks.js" layer="Service" fns="createHook(db,opts); deleteHook(db,id); evaluateCondition(type,value,observation,context); executePersistedHook(db,hook,observation,context); getPersistedHooks(db,event); interpolate(str,observation,context)"/>
    <file path="src/core/index.js" layer="Service"/>
    <file path="src/core/reflection.js" layer="Service" fns="archiveSuperseded(db,opts); consolidateMemories(db,opts); findSimilarClusters(observations,threshold); generateConsolidatedSummary(cluster); getEmbeddedObservations(db,project,limit); pickCanonical(cluster)"/>
    <file path="src/core/relations.js" layer="Service" fns="addRelation(db,opts); deleteRelation(db,relationId); getGraph(db,opts); getRelations(db,observationId); listRelationTypes(db)"/>
    <file path="src/core/search.js" layer="Service" fns="buildWhereClause(opts); hybridSearch(db,query,queryVec,opts); keywordSearch(db,opts); rerankResults(query,results); sanitizeDate(dateStr); semanticSearch(db,queryVec,opts)"/>
    <file path="src/core/self-improve.js" layer="Service" fns="autoResolveConflicts(db,opts); initHooks(saveFn); learnFromError(db,errorObs); resetState(); setSaveFunction(saveFn); verifyLearning(db,newObs)"/>
    <file path="src/core/session.js" layer="Service" fns="callLLM(messages,opts); endSession(db,sessionId,summary); listSessions(db,opts); startSession(db,opts); summarizeSession(db,opts); templateSummary(obs,reason)"/>
    <file path="src/core/standards.js" layer="Service" fns="ensureStandardsExist(db,project,saveFn); getStandardsAsObservations(project); getStandardsContext(); listStandards(db,project,opts); searchStandards(db,project,query,limit)"/>
    <file path="src/core/watcher.js" layer="Service" fns="_flushBatch(onBatch); _onChange(eventType,filename,onBatch); _walkForChanges(dir,prefix,since,onBatch); _watchWithPolling(dir,onBatch); getStatus(); setAPI(api)"/>
  </libraries>
  <scripts>
    <file path="scripts/auto-setup.js"/>
    <file path="scripts/create-discovery-files.js"/>
    <file path="scripts/generate-graph.mjs"/>
    <file path="scripts/inject-memory.mjs"/>
  </scripts>
</codebase_graph>
<!-- MEMORY_CONTEXT_END -->
