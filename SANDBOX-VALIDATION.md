# AC Agent-Memory Sandbox Validation

**Question:** does agentic-cortex actually work as session/long-term memory for AI coding agents — detected, used, beneficial, consistent within a session, durable across sessions, correctly scoped across projects and the machine?

**Method:** simulated real agent sessions against the **real MCP stdio server** (`src/mcp/server.js`, the exact integration Claude Code / Cursor / OpenCode use — one spawned process = one agent session) plus the CLI (`mcp-config`, handshake). Every run is fully hermetic: `AGENTIC_CORTEX_DB` → fresh temp SQLite file, `AGENTIC_CORTEX_PROJECT` → fake project dirs inside a throwaway temp root. Nothing touches the user's real memory DB. Runner: `scripts/sandbox-agent-test.js` (rerunnable: `node scripts/sandbox-agent-test.js`, ~10s).

**Result: 47/47 checks pass** across 10 scenarios (report with full evidence: `data/runs/sandbox-agent/report.json`).

| Scenario | What it proves | Checks |
|---|---|---|
| S1 Detection | `mcp-config` emits valid wiring; MCP handshake succeeds; `tools/list` exposes 70+ tools with `memory_bootstrap` documented as "call FIRST at session start"; cold session startup < 15 s | 6/6 |
| S2 Cold start | `memory_bootstrap({})` on an empty project returns structured XML context with no errors, < 15 s | 3/3 |
| S3 In-session | 5 typed saves (decision/gotcha/architecture/procedure/preference) → mid-session searches retrieve them; `memory_get` round-trips by the id the server returned | 8/8 |
| S4 Session lifecycle | `session_start` → work → `session_end` with summary; the ended session shows up in a later `memory_context`/`memory_profile` | 4/4 |
| S5 Cross-session | New process (= agent restart): bootstrap re-injects the vitest decision, JWT architecture note, and release procedure; searches recall procedure + preference verbatim | 3/3 |
| S6 Cross-project isolation | Project B's bootstrap and searches return **zero** of project A's facts; B still finds its own; machine-wide search finds A's facts on demand from B | 4/4 |
| S6b Global vault | Promote a learning in A → recall it from B (machine-wide layer works) | 3/3 |
| S7 Long horizon | 10 sessions, 30 memories of churn, full maintenance cycle → 3 critical facts (importance 10) remain retrievable and surface in bootstrap; memory system does not evict what matters | 7/7 |
| S8 Concurrency | 2 concurrent agent sessions × 10 parallel saves each: 20/20 durable and searchable (per-project write queue + WAL) | 3/3 |
| S9 Robustness | Empty query, FTS-hostile unicode query, edit, feedback, forget; a forgotten memory is excluded from subsequent search | 6/6 |

## Verdict on each axis the user asked about

- **Agents detect it** — yes: valid `mcp-config` output for claude/cursor/opencode, working handshake, self-describing toolset whose bootstrap tool tells the agent to call it first.
- **Agents use it** — yes: the full save→search→get→edit→feedback→forget lifecycle works through MCP with typed observations (decision/gotcha/procedure/preference/architecture).
- **They benefit from it** — yes: after a restart, `memory_bootstrap` re-injects prior-session decisions, architecture and procedures without any re-derivation; searches recall exact facts.
- **Keep the context (within session)** — yes, with one caveat: reads gated on pending writes were *added* this round (see bugs fixed), so pipelined save→search is now consistent. Keyword-only mode needs exact-token queries ("test framework vitest" ✓, "which framework should I use" ✗ against content saying "tests") — embeddings (`AGENTIC_CORTEX_EMBEDDINGS=1`) remove this.
- **Keep the session** — yes: `session_start`/`session_end` with summaries record and are visible to later sessions via context/profile.
- **Memory across sessions** — yes (S5): fresh process, same DB, full recall.
- **Memory across the machine** — yes (S6/S6b): project isolation is correct *and* deliberate cross-project recall works via machine-wide search and the promoted global vault.

## Bugs found by the sandbox — and fixed

1. **Cross-project memory leak via MCP tools (real, serious).** Tool schemas document `project` as "defaults to `AGENTIC_CORTEX_PROJECT` or cwd", but `memory_search`/`memory_list` passed args through unscoped — an agent that omitted `project` received search results from **every project on the machine**. The API layer scoped correctly; only the MCP dispatch layer leaked. Fixed: `_PROJECT_SCOPED_TOOLS` now applies the documented default server-side (17 tools).
2. **Read-after-write race (real).** The per-project queue serialized writes but reads bypassed it — a search pipelined in parallel with a save (agents fire concurrent tool calls) could execute before the save landed and return stale results. Fixed: reads gate on pending same-project writes while still running concurrently with each other.

## Known limitations (documented, not bugs)

- **Keyword-only mode is token-exact.** Without embeddings, FTS5 matches tokens, not paraphrases; question-style queries can miss. Fix is one env var (`AGENTIC_CORTEX_EMBEDDINGS=1`) or a setup-time embedding step.
- **Adversarial/LLM-judge paths untested here** by design — this sandbox is deterministic; LLM-dependent features (bootstrap insights text, `answer`, auto-summarize) degrade gracefully keyless but their *quality* isn't scored here.
- **One machine, one user.** Multi-user/team sync (`syncPull`) was out of scope for the hermetic sandbox.

## Reproduce

```bash
node scripts/sandbox-agent-test.js          # 47 checks, ~10s, hermetic
node scripts/sandbox-agent-test.js --keep   # keep the sandbox for inspection
```
