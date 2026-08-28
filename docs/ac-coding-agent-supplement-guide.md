# AC as a Persistent Companion for Coding Agents

## Overview

Agentic Cortex (AC) supplements LLM coding agents such as Claude Code, OpenCode, Cursor, and other MCP clients. The model handles ambiguity, design, novel code, and explanation. AC handles durable memory, repository facts, code graphs, retrieval, deterministic reasoning, bounded edits, verification, provenance, and session handoff.

AC is not merely a longer transcript. It is a local operational substrate that lets several agents continue the same work without repeatedly rediscovering the project.

---

## 1. The repeated session tax

Each new session can repeat project discovery, architecture decisions, failed debugging approaches, test selection, dependency analysis, unfinished-work recovery, and explanation of conventions.

```text
session cost
  = history retransmission
  + repeated repository reads
  + repeated search/index work
  + repeated explanation of conventions
  + repeated verification setup
  + recovery cost from forgotten failures
```

AC attacks these costs with structured memories, session compaction, a deterministic code graph, a symbol index, task-scoped context, outcome records, and verification receipts.

| Repeated cost | AC contribution |
|---|---|
| Conversation history | Structured observations, decisions, commitments, compacted state |
| Broad repository reads | Deterministic code graph and symbol-level index |
| Repeated keyword searches | Persistent FTS5 and optional local semantic search |
| Re-explaining conventions | Project facts, coding standards, principles, procedures |
| Rebuilding task context | Bootstrap and task-scoped context injection |
| Repeating failed approaches | Error memories, outcomes, failure classification, experience replay |
| Blind verification | Recorded commands, results, explicit uncertainty |
| Switching agents | Shared MCP/API memory and provenance |

AC reduces unnecessary input tokens and rediscovery. It does not make LLM generation free or eliminate authoritative source reads.

---

## 2. Cross-session memory

AC can retain facts, decisions, goals, commitments, preferences, instructions, events, learnings, observations, artifacts, errors, patterns, syntheses, principles, actions, experiments, and outcomes. A useful record stores what happened, when and where, confidence/provenance, and later confirmation or contradiction.

### Memory scope

| Scope | Example | Retention |
|---|---|---|
| Turn/session | "The test is running now." | Short-lived or compacted |
| Task | "Parser bug caused by Windows separators." | Retain through task, link to outcome |
| Project | "This package uses Node's built-in test runner." | Persistent project fact |
| Machine/global | "Shell requires forward-slash paths." | Promote only when broadly useful |
| Historical | "Attempt A failed because fixture was stale." | Searchable failure evidence |

Current user instructions, current repository contents, and current checks outrank stale memory.

### Session lifecycle

**Start:** identify project/branch/task, load compact state, retrieve decisions/errors/commitments, inspect git and index freshness, refresh if needed, inject targeted context.

**During work:** save stable decisions, exact failures, linked outcomes, used files/symbols, unresolved questions.

**Handoff:** compact state, record verification, preserve unfinished work and failed approaches, crystallize repeated observations only when justified.

Example handoff state:

```text
project: inventory-service
branch: fix/cache-race
task: prevent duplicate refreshes on concurrent cache misses
completed: added single-flight locking
verification: targeted test passed; full suite pending
risk: real-timer integration test may be flaky
next: run full suite
```

---

## 3. Offline capability matrix

"Offline" means no LLM call is required. Local files, git, compilers, tests, and permitted services may still be used.

| Capability | Status | AC can do | Boundary |
|---|---|---|---|
| Persistent memory | Fully offline | Store, query, relate, score, compact SQLite records | Cannot remember what was never recorded |
| Session continuity | Fully offline | Reconstruct state from structured memory | Missing observations cannot be recovered |
| Keyword retrieval | Fully offline | FTS5 search over memory and code | Synonyms may be missed |
| Semantic retrieval | Optional local | Use local embeddings when enabled | Requires model/resources |
| Code graph | Fully offline | Parse supported files, imports, exports, roles, layers | Static parsing is not compilation |
| Symbol index | Fully offline | Store symbols, bodies, docs, hashes, usage | Dynamic/unsupported languages may be incomplete |
| Change-aware indexing | Fully offline | Re-index changed files, save observations | Requires usable git state |
| Task context | Fully offline | Select symbols, expand imports, enforce token budget | Relevance is heuristic without embeddings |
| Deterministic reasoning | Fully offline | Deduction, induction, analogy, abduction, synthesis, forecasting | Cannot invent missing premises reliably |
| Repository planning | Fully offline | Plan from files, symbols, scripts, tests, git state | Does not fully understand arbitrary intent |
| Safe explicit edits | Fully offline | Apply unique bounded replacements under project root | Refuses to invent unspecified code |
| Checks and verification | Fully offline from AC perspective | Run commands, capture output/duration/exit code/scope | Commands may need tools/services |
| Novel coding | Not generally | Templates, codemods, reviewed patches, procedure replay | Open-ended work needs worker/LLM |
| Research synthesis | Partial | Gather, rank, cite, deduplicate, compare evidence | Nuanced interpretation is limited |

Conservative rules: no explicit change contract means plan/report only; ambiguous targets, duplicate matches, or path escapes mean refusal; missing checks mean "not verified"; failed checks mean preserve evidence and stop or replan.

---

## 4. Architecture with a coding agent

```text
+---------------------------------------------------------+
| Coding agent: Claude Code / OpenCode / Cursor / custom  |
| language understanding, design, novel code, interaction |
+--------------------------+------------------------------+
                           | MCP stdio / Node API / HTTP
+--------------------------v------------------------------+
| Agentic Cortex                                           |
| memory | FTS5/embeddings | graph/index | reasoning      |
| workflows | compaction | offline edits | verification  |
+--------------------------+------------------------------+
                           | filesystem / git / commands
+--------------------------v------------------------------+
| Project: source, tests, scripts, CI, history            |
+---------------------------------------------------------+
```

### MCP integration

Register AC as a local stdio MCP server:

```json
{
  "mcpServers": {
    "agentic-cortex": {
      "type": "stdio",
      "command": "agentic-cortex-mcp",
      "args": []
    }
  }
}
```

The agent can bootstrap context, search memories/symbols, save decisions/errors/outcomes, compact sessions, inspect graph statistics, and invoke bounded offline workflows. A supervisor can call the Node API directly. Hooks can bootstrap sessions, ingest changed files after git events, record checks, and compact handoffs; hook failures must not block development.

---

## 5. Simulation 1: resume work tomorrow

**Request:** "Continue fixing the flaky cache refresh test. We started yesterday."

**Without AC:** the agent searches broadly, rereads implementation and tests, reconstructs yesterday's work, rediscovers that fake timers masked a race, and infers the intended locking design.

**With AC:** bootstrap returns the prior completed change, failed approach, decision, relevant symbols, and the warning that the full suite has not run.

```xml
<agentic_cortex_context project="inventory-service" task="flaky cache refresh test">
  <prior_session>
    <completed>Moved refresh scheduling behind a single-flight lock.</completed>
    <failed_approach>Fake timers masked a race.</failed_approach>
    <decision>Use an injected clock at the cache boundary.</decision>
    <next>Repeat targeted test, then run the full suite.</next>
  </prior_session>
  <relevant_memories>
    <memory type="error" confidence="92">Real timers expose duplicate refreshes.</memory>
    <memory type="decision" confidence="88">Lock belongs in refresh scheduling.</memory>
  </relevant_memories>
  <code_symbols>
    <symbol file="src/cache/refresh.js" name="scheduleRefresh">...</symbol>
    <symbol file="tests/cache-refresh.test.js" name="deduplicates concurrent refreshes">...</symbol>
  </code_symbols>
  <warnings>Full suite has not run since the last edit.</warnings>
</agentic_cortex_context>
```

For an 80,000-token prior transcript, a targeted packet might contain 500 tokens of state, 800 of memories, 1,200 of symbols, and 300 of warnings. This is illustrative; measure per agent and project.

---

## 6. Simulation 2: switch agents

A design agent records that authorization belongs in a shared policy layer because route-local checks were duplicated and request context already exists. It records rationale, rejected alternative, evidence files, confidence, and status "proposed until tests pass."

An implementation agent bootstraps and receives the decision without the original transcript. CI records the targeted test command, exit code, test count, and status. The decision becomes verified.

The shared unit is a structured decision with provenance and outcome, not a provider-specific transcript.

---

## 7. Simulation 3: offline deterministic coding

AC is suitable for explicit transformations: changing a uniquely identified constant, mechanical renames, path normalization, reviewed patch application, index refreshes, regression checks, and verified procedure replay.

### Input contract

```json
{
  "project": "/work/inventory-service",
  "task": "Update the retry timeout constant and verify the project",
  "changes": [{
    "file": "src/retry.js",
    "oldText": "const timeout = 1000;",
    "newText": "const timeout = 2000;"
  }]
}
```

### Workflow

```text
1. Audit capabilities and repository shape
2. Inspect metadata, scripts, graph, and tests
3. Build a bounded plan
4. Validate every requested change
5. Refuse unsafe or ambiguous changes
6. Create reversible backups/change records
7. Apply exact replacements
8. Refresh the index for changed files
9. Select test/typecheck/lint/build commands
10. Execute checks and capture output, exit code, duration
11. Compare expected and actual changed files
12. Produce verification report
13. Save action and outcome memory
14. Stop on failure; never claim completion
```

Good offline tasks: version bumps, constant changes, mechanical renames, path normalization, explicit codemods, reviewed patch application, index refreshes, regression checks, verified procedure replay.

Defer: ambiguous refactors, new feature design, novel bug fixes, security-sensitive changes without policy, dynamic semantic changes, multi-file work with unspecified relationships.

If old text occurs four times, refusal is correct; guessing is not.

---

## 8. Simulation 4: code graph and token reduction

AC maintains a file/import/export/layer graph plus a symbol index of functions, methods, classes, signatures, docs, summaries, bodies, hashes, and usage signals.

For "fix timeout handling in the request path," AC scores paths and symbols, selects seed files, expands import closure, adds reverse callers, ranks by relevance and prior use, includes bounded bodies, and records what was injected.

### Illustrative 4,000-token packet

```text
Graph overview:       250 tokens
Relevant file list:   150 tokens
Signatures and docs:  900 tokens
Selected bodies:    2,400 tokens
Warnings/provenance:  300 tokens
Total:              4,000 tokens
```

The agent can still read complete files. AC reduces unnecessary reads without hiding source truth.

Body hashes, changed-file ingestion, deleted-symbol cleanup, freshness warnings, and selection provenance are essential; stale graph data must not masquerade as truth.

---

## 9. Simulation 5: deterministic analysis and verification

After an agent edits a retry loop, AC can check:

- Syntax where supported
- File/symbol existence
- Changed-file scope
- Imports/exports consistency
- Stale call sites or duplicate constants
- Package test/typecheck/lint/build scripts
- Exit codes and output patterns
- Index freshness
- Known failure memories
- Explicit invariants such as "retry count never exceeds maxRetries"

Reports distinguish:

```text
checked and passed
checked and failed
not checked
not expressible by the offline verifier
```

A passing targeted test is not full verification.

---

## 10. Research and search

For local Markdown, text, JSON, CSV, and source, AC can index, search, deduplicate, preserve source identity, track confidence/provenance, record contradictions, build timelines, and produce compact evidence packets.

For "Why does this project avoid transactions in the import path?" AC retrieves implementation files, decisions, deadlock errors, migrations, and dissenting evidence; an LLM synthesizes a grounded answer.

With permitted fetchers, AC can collect external documents, canonicalize/deduplicate, extract chunks, rank evidence, preserve citations, and compare contradictions. Offline AC does not imply web access.

```text
question -> query expansion -> permitted collection -> deduplication
         -> extraction -> ranking -> citations -> coverage analysis
         -> optional LLM synthesis
```

Store source URL/path, retrieval time, title/version, quote or hash, query, confidence, limitations, source type, and later confirmation/contradiction.

---

## 11. End-to-end hybrid workflow

1. **Bootstrap:** project/branch, session state, decisions, errors, principles, scoped code, freshness, coverage warnings.
2. **Plan:** LLM proposes a plan; AC checks files, symbols, dependencies, known procedures. Bounded tasks may be planned by AC alone.
3. **Implement:** LLM edits novel code; use AC for symbols, callers, decisions, fixes, checks. Delegate bounded mechanical work.
4. **Verify:** run targeted/full tests, typecheck/build/lint, graph checks, invariants, scope checks. Record evidence.
5. **Reflect:** classify verified/partial/failed/blocked/ambiguous; save outcomes and compact state.

---

## 12. Integration patterns

### AC as MCP provider

```text
session start -> bootstrap(task) -> search memories/symbols
             -> normal edits -> save decisions/errors/outcomes
             -> compact at handoff/end
```

### Wrapper

```text
AC bootstrap -> coding agent -> AC offline checks -> AC outcome
```

### Deterministic worker

```text
LLM: interpret request, create explicit change contract
AC: validate, apply, index, test, verify
LLM: explain result or handle exceptions
```

### Shared agent team

Planner records decisions; implementer retrieves symbols; reviewer retrieves changes/failures; tester records outcomes; release automation retrieves verified procedures. Namespaces, provenance, and status prevent speculation becoming project fact.

### CI recorder

CI records failures, flaky-test rates, build duration, environment failures, decision verification, and graph changes so future sessions start from current evidence.

---

## 13. Measuring token and time savings

Measure raw history vs compact-state tokens, bootstrap size, repository reads and repeats, searches per task, symbols injected, index freshness, indexing time, avoided LLM calls, verification duration, and repeated failures prevented.

| Metric | Before AC | With AC | Meaning |
|---|---:|---:|---|
| Prior transcript resent | 35,000 | 1,200 | Compaction retained state |
| Initial reads | 12 files | 5 targeted symbols/files | Graph-scoped context |
| Repeated searches | 9 | 3 | Persistent index/memory |
| Verification calls | 4 ad hoc | 2 recorded checks | Known procedures |

Values are illustrative. Small projects may gain little; large monorepos may gain substantially. Indexing can cost more than it saves for one-file work, so use lazy, change-aware indexing with visible cost and freshness.

---

## 14. Safety, provenance, and trust

Evidence precedence:

```text
current explicit user instruction
  > current repository and passing checks
  > recent verified outcomes
  > recent project decisions
  > older memories and inferred patterns
  > unresolved speculation
```

Important provenance: source, timestamp, project/branch, files/symbols, confidence, supporting/dissenting evidence, verification status, supersession/contradiction links.

Expose missing context, one-sided evidence, stale index data, unresolved conflicts, incomplete coverage, unavailable checks, and targeted-only verification. A trustworthy result says: "targeted test passed; full suite not run; dependent files may be stale; partially verified."

Use project-root restrictions, protected paths, file/byte limits, git-state requirements, backups, required checks, and explicit failure behavior.

---

## 15. Failure modes and recovery

- **Stale memory:** compare provenance with current files, mark superseded.
- **Stale graph:** refresh changed files, warn, prefer direct reads.
- **Over-compression:** preserve high-importance originals and links.
- **Retrieval tunnel vision:** request counterexamples, dissent, coverage probes, adjacent symbols.
- **False verification:** distinguish targeted, full, unavailable, blocked checks.
- **Ambiguous edit:** refuse and return the ambiguity for refinement.
- **Environment failure:** report blocked, do not call code verified.
- **Agent contradiction:** retain both records, link conflict, compare evidence, require adjudication.

---

## 16. Operating rules

1. Bootstrap every meaningful task.
2. Treat AC as evidence, not current source.
3. Read exact files/symbols before important changes.
4. Save stable decisions and exact failures.
5. Record what was and was not verified.
6. Use graph context, then validate important edges.
7. Request counter-evidence when retrieval seems too certain.
8. Delegate only bounded transformations to offline execution.
9. Never claim completion after partial, failed, or unavailable checks.
10. Compact state before agent handoff.
11. Preserve user control over consequential edits, migrations, deployments, history rewrites.

---

## 17. Roadmap toward deeper offline autonomy

- **Typed task contracts:** renames, configuration updates, exports, migrations, checks.
- **Repository-aware codemods:** parser/symbol-aware operations with strict text fallback.
- **Verification knowledge base:** map checks to files and behaviors while requiring current runs.
- **Procedure replay:** triggers, preconditions, steps, artifacts, postconditions, recovery, checks.
- **Evidence coverage planner:** implementation, call-site, test, history, dissent, runtime evidence.
- **Reproducible receipts:** task, revision, plan, files, commands, tests, memory IDs, uncertainty.

---

## 18. Bottom line

AC is the persistent operational substrate beneath coding agents: durable decisions and failures, searchable code structure, compact task context, deterministic evidence reasoning, bounded offline coding, provenance, uncertainty, and continuity across agents, scripts, and CI.

AC does not eliminate the need for an LLM for ambiguity, novel implementation, broad synthesis, or nuanced judgment. The separation is useful: the model handles open-ended interpretation and generation; AC handles durable state, repository facts, repeatability, cost control, and verification.
