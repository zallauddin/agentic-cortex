<!-- agentic-cortex:start:v6.5.0 -->
# agentic-cortex

Persistent, self-improving memory system for AI coding agents. 67 MCP tools.

## Test-Time Reasoning (NEW)

For hard problems, use tree search to explore multiple reasoning branches:
- `memory_tree_search({ problem: "..." })` — Beam/MCTS search with PRM verification
- `memory_verify_step({ stepContent: "..." })` — Verify a reasoning step
- `memory_budget({ problem: "..." })` — Estimate difficulty and compute budget
- `memory_verify_code({ hypothesis: "..." })` — Program-aided verification
- `memory_reflexion({ ... })` — Record failed path for self-correction
- `memory_reasoning_trace({ traceId: N })` — View search trace

## Session Start (MANDATORY)

Call the MCP tool `memory_bootstrap` with no arguments at session start to load context.

Returns XML-tagged context: actionable insights, task-relevant memories (hybrid search + reranking),
warnings, coding standards, codebase graph, machine-wide global vault.

**Fallback (CLI):** `agentic-cortex bootstrap`

## Auto-Save

Use MCP tool `memory_save({ content, type?, importance?, confidence?, tags? })` after:
decisions, bug fixes, discoveries, learnings, preferences, feature completions, gotchas.

**Fallback (CLI):** `agentic-cortex save "title" "content"`

Type auto-detected. Triggers: decision|90 error|95 context|80 preference|100 fact|85 event|95 learning|75 instruction|90

## All 57 MCP Tools

### Memory core: memory_save, memory_search, memory_get, memory_list, memory_edit, memory_forget, memory_context, memory_reflect, memory_conflicts, memory_export, memory_import, memory_health, memory_embed, memory_relate, memory_graph, memory_hook, memory_share, memory_feedback, memory_trail (19)

### Memory advanced: memory_learn_from_error, memory_record_action, memory_transfer_knowledge, memory_machine_vault, memory_promote_global, memory_search_all, memory_ingest_transcript, memory_utility_stats, memory_freshness, memory_maintenance, memory_analytics, memory_standards, memory_auto_capture, memory_skill_list, memory_skill_search, memory_daily_summary, memory_crystallize, memory_experiment, memory_eval_log, memory_fsm, memory_rules, memory_workflow, memory_workflow_agents, memory_prompts_list, memory_prompts_render, memory_plateau_check (26)

### Reasoning: memory_tree_search, memory_verify_step, memory_budget, memory_verify_code, memory_reflexion, memory_reasoning_trace, memory_reasoning_stats, memory_synthesize_solution, memory_self_consistency, memory_budget_force (10)

### Session: session_start, session_end, session_summarize, agent_session_start, agent_session_end, agent_list_sessions, memory_shared_get, memory_provider, memory_send, memory_inbox, memory_mark_read (11)

### Bootstrap: memory_bootstrap (1)

## Key Operations

| Operation | MCP Tool | CLI Fallback |
|-----------|----------|--------------|
| Bootstrap | `memory_bootstrap({})` | `agentic-cortex bootstrap` |
| Save | `memory_save({ content, type? })` | `agentic-cortex save "t" "c"` |
| Search | `memory_search({ query })` | `agentic-cortex search "q" --project .` |
| Search all projects | `memory_search_all({ query })` | `agentic-cortex machine-search "q"` |
| Global vault | `memory_machine_vault({})` | `agentic-cortex machine-memory` |
| Promote | `memory_promote_global({ id })` | — |
| Reflect | `memory_reflect({})` | — |
| Feedback | `memory_feedback({ id, type })` | `agentic-cortex feedback <id> --type helpful|incorrect` |
| Context | `memory_context({})` | — |
| Forget | `memory_forget({ id })` | `agentic-cortex forget <id> [--hard]` |
| Standards | `memory_standards({ action: "search", query })` | `agentic-cortex standards --search "topic"` |
| Conflicts | `memory_conflicts({})` | — |
| Health | `memory_health({})` | — |
| Daily summary | `memory_daily_summary({})` | `agentic-cortex daily-summary` |

## Memory Types

instruction fact decision goal commitment preference relationship context event learning observation artifact error

MCP: agentic-cortex-mcp — 67 tools. Configured in .mcp.json, .cursor/mcp.json, opencode.json.

Read knowledge.md for injected context (coding standards, session memories, codebase graph).
<!-- agentic-cortex:end -->


