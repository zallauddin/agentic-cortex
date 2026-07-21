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
<!-- Auto-injected by agentic-cortex at 2026-07-21T03:12:56.346Z -->

# Agentic Cortex - Project Context

## 🔧 Coding Standards (auto-injected — ALWAYS in effect)

These standards are pre-loaded and always active. You MUST apply them at every phase of development. They are not optional — they are the rules of the system.

### 🧠 Core Principles (Karpathy Guidelines)
- **Think before coding** — Surface assumptions, ask when uncertain, present tradeoffs.
- **Simplicity first** — Minimum code. No bloat. No speculative abstractions.
- **Surgical changes** — Touch only what you must. Match existing style.
- **Goal-driven execution** — Define verifiable criteria. Loop until verified.

### 🔴 Always Active — Every Phase
- **Don't assume, don't hide confusion** [KARPATHY]
  *When:* Unclear requirement; Ambiguous specification; Unexpected behavior in existing code
- **Push back when a simpler approach exists** [KARPATHY]
  *When:* Requested approach seems overcomplicated; A simpler pattern/library/technique could work; User may not know about alternatives
- **Match existing patterns and conventions** [GENERAL]
  *When:* Adding code to an existing project; First contribution to a codebase; Choosing between your preference and existing style
- **Code for readability, not cleverness** [GENERAL]
  *When:* Reviewing code you just wrote; Temptation to use metaprogramming or complex patterns; A solution makes you feel clever
- **Verify before considering done: run the tests** [GENERAL]
  *When:* Finishing an implementation; Before committing code; Before requesting a review
- **Comments explain WHY, not WHAT** [CLEAN-CODE]
  *When:* Writing or reviewing comments; Non-obvious design choice needs explanation; Commented-out code in the codebase

### 🟡 Planning & Design Phase
- **Think before coding: surface assumptions explicitly** [KARPATHY]
  *When:* Starting a new task; User request is ambiguous; Multiple approaches possible
- **Present options, don't pick silently** [KARPATHY]
  *When:* User request is ambiguous; Multiple technical approaches exist; Request could be interpreted at different scopes
- **SRP — Single Responsibility: one reason to change** [SOLID]
  *When:* Designing a new class or module; A class has methods serving different concerns; Refactoring a god class with 20+ methods
- **KISS — Keep It Simple: simplest solution that works** [KISS]
  *When:* Starting a new feature; Choosing between simple and complex approaches; You find yourself writing an abstraction for one use case
- **YAGNI — You Aren't Gonna Need It: no speculative features** [YAGNI]
  *When:* You're tempted to add "flexibility" or "configurability" not requested; Writing abstractions for hypothetical future use cases; Adding error handling for impossible scenarios
- **OCP — Open for Extension, Closed for Modification** [SOLID]
  *When:* You have 3+ variants of the same behavior; Adding a new type requires modifying switch/case statements; Requirements specify future variants
- **DIP — Depend on Abstractions, Not Concretions** [SOLID]
  *When:* High-level module creates instances of low-level services; Swapping implementations requires changing business logic; Testing requires mocking infrastructure

### 🟢 Implementation & Coding Phase
- **Simplicity first: minimum code that solves the problem** [KARPATHY]
  *When:* Writing new code; Code exceeds 50 lines for a single function; You're adding configurability that wasn't requested
- **DRY — Don't Repeat Yourself: single source of truth** [DRY]
  *When:* You're about to copy-paste code; You see the same calculation or rule in multiple files; A constant or config value is hardcoded in multiple places
- **Small functions: do one thing well** [CLEAN-CODE]
  *When:* A function exceeds 30 lines; Function mixes high-level logic with low-level details; You need comments to explain sections of a function
- **Meaningful names: self-documenting code** [CLEAN-CODE]
  *When:* Naming a new variable, function, or class; Code review finds unclear names; You need a comment to explain what a variable holds
- **No side effects: pure functions when possible** [CLEAN-CODE]
  *When:* Function name suggests a query but has side effects; Direct mutation of objects or arrays; getUser() also updates last_accessed
- **Error handling: fail loud, not silently** [CLEAN-CODE]
  *When:* Writing try/catch blocks; Handling external API calls or I/O; Error goes unlogged or silently ignored
- **Early returns: flatten deep nesting** [CLEAN-CODE]
  *When:* Code has 3+ levels of indentation; If-else chains that could be guard clauses; Reading code requires tracking multiple nested conditions
- **Immutable by default: spread, don't mutate** [GENERAL]
  *When:* Writing obj.property = value directly; Using push/pop/splice on arrays; Mutating function arguments
- **Type safety: avoid "any" — always use proper types** [GENERAL]
  *When:* Writing a new function signature; Using "any" as a type; Type checker reports implicit any
- **Async/await: parallel when possible** [GENERAL]
  *When:* Multiple await calls in sequence; Operations that don't depend on each other; Page loading fetches that could run in parallel
- **Magic numbers: use named constants** [CLEAN-CODE]
  *When:* Numeric literals in code without explanation; String literals that encode business rules; Thresholds, timeouts, limits without documentation
- **Separate business logic from I/O and framework code** [CLEAN-CODE]
  *When:* Business rules mixed with HTTP handlers; Testing requires mocking Express or database; UI component contains business calculations

### 🔵 Review & Refactoring Phase
- **Surgical changes: touch only what you must** [KARPATHY]
  *When:* Modifying existing code; Temptation to fix adjacent code; Unrelated improvements during a bug fix
- **Goal-driven execution: define success criteria first** [KARPATHY]
  *When:* Starting any non-trivial task; Bug fix without a reproduction test; Feature without clear acceptance criteria
- **Clean up your own orphans — remove your dead code** [KARPATHY]
  *When:* After modifying code; Changed function signatures or removed calls; Linter reports unused imports or variables
- **Test structure: Arrange-Act-Assert (AAA)** [GENERAL]
  *When:* Writing new tests; Test has no clear AAA structure; Test does multiple unrelated assertions
- **LSP — Subtypes must be substitutable for base types** [SOLID]
  *When:* Designing or reviewing class hierarchies; Derived class throws in inherited methods; Square extends Rectangle with surprising behavior
- **ISP — No client forced to depend on unused methods** [SOLID]
  *When:* Interface has methods that not all implementors use; NotImplementedError in interface implementations; New client only needs a subset of existing interface


---

## Key Observations (ranked by utility)
### Event
- README v4.7.0 update (★0)
- README v4.7.0 update (★0)
<codebase_graph files="45" api_routes="0" generated="2026-07-21T03:12:56.273Z">
  <architecture patterns="Repository Pattern, Event-Driven, CLI Tool" stack="Databases: SQLite | Tools: Xenova Transformers (AI/ML)"/>
  <layers dataflow="API → Service" ui="0" api="1" service="38" data="0"/>
  <hub_files>scripts/inject-memory.mjs, scripts/generate-graph.mjs, src/sync/git-sync.js, cli.js, scripts/auto-setup.js, scripts/create-discovery-files.js, scripts/import-community-knowledge.js, scripts/seed-memory-repo.js</hub_files>
  <libraries>
    <file path="src/core/conflict.js" layer="Service" fns="checkConflicts(db,opts)"/>
    <file path="src/core/constants.js" layer="Service" fns="getProjectDefault(opts)"/>
    <file path="src/core/db-path.js" layer="Service" fns="ensureDir(filePath); getDbDir(); getDbPath(); getLegacyDbPath(); getLegacyDbPathIfExists()"/>
    <file path="src/core/db.js" layer="Service" fns="ensureSchema(db); getDb(); getDbPath_()"/>
    <file path="src/core/embedding.js" layer="Service" fns="_cacheGet(key); _cacheSet(key,value); clearEmbeddingCache(); computeEmbedding(text); cosineSimilarity(a,b); disposePipelines()"/>
    <file path="src/core/export.js" layer="Service" fns="exportJSON(db,opts); exportMarkdown(db,opts); findRelated(obs,allObs); importJSON(db,data,opts); sanitizeFilename(title,id)"/>
    <file path="src/core/fsm.js" layer="Service" fns="_fireOnEnter(db,machine,stateName,agentId,project); _fireOnExit(db,machine,stateName,agentId,project); _transitionFromDB(db,dbState,trigger,opts); _transitionFromState(db,state,trigger,opts); defineMachine(definition); getAgentState(agentId)"/>
    <file path="src/core/hooks.js" layer="Service" fns="createHook(db,opts); deleteHook(db,id); evaluateCondition(type,value,observation,context); executePersistedHook(db,hook,observation,context); getPersistedHooks(db,event); interpolate(str,observation,context)"/>
    <file path="src/core/index.js" layer="Service"/>
    <file path="src/core/reflection.js" layer="Service" fns="_projectRelativeThreshold(count); archiveSuperseded(db,opts); consolidateMemories(db,opts); crystallize(db,opts); findSimilarClusters(observations,threshold); generateConsolidatedSummary(cluster)"/>
    <file path="src/core/relations.js" layer="Service" fns="addRelation(db,opts); deleteRelation(db,relationId); getGraph(db,opts); getRelations(db,observationId); listRelationTypes(db)"/>
    <file path="src/core/rules.js" layer="Service" fns="_checkCondition(db,rule,context); _executeAction(db,rule,context); defineRule(db,def,persist); deleteRule(db,id); evaluate(db,event,context); initRuleHook(db)"/>
    <file path="src/core/search.js" layer="Service" fns="buildWhereClause(opts); hybridSearch(db,query,queryVec,opts); keywordSearch(db,opts); rerankResults(query,results); sanitizeDate(dateStr); semanticSearch(db,queryVec,opts)"/>
    <file path="src/core/self-improve.js" layer="Service" fns="_keywordClassify(outcomeText); autoResolveConflicts(db,opts); classifyOutcome(outcomeText); getEvalLogStats(db,project); getEvaluationLog(db,opts); initHooks(saveFn)"/>
    <file path="src/core/session.js" layer="Service" fns="callLLM(messages,opts); endSession(db,sessionId,summary); listSessions(db,opts); startSession(db,opts); summarizeSession(db,opts); templateSummary(obs,reason)"/>
  </libraries>
  <scripts>
    <file path="scripts/auto-setup.js"/>
    <file path="scripts/create-discovery-files.js"/>
    <file path="scripts/generate-graph.mjs"/>
    <file path="scripts/import-community-knowledge.js"/>
    <file path="scripts/inject-memory.mjs"/>
    <file path="scripts/seed-memory-repo.js"/>
  </scripts>
</codebase_graph>
<!-- MEMORY_CONTEXT_END -->
