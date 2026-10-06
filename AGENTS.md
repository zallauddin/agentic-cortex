


<!-- agentic-cortex:start:v7.5.0 -->
# agentic-cortex

Persistent, self-improving memory system for AI coding agents. 138 MCP tools.

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

<lesson_capture>
EVERY problem you encounter is a lesson. Capture it — do not let it die in the conversation.

CAPTURE IMMEDIATELY (same turn) when you:
  1. Fix a bug after a wrong first attempt        → memory_save({ type: "learning", content: "Problem: <what broke> | Wrong turn: <what you tried first and why it failed> | Fix: <what worked> | Guard: <how to avoid next time>" })
  2. Hit a tool/API/schema error and recover      → memory_save({ type: "error", content: "<exact error> → <root cause> → <fix>" })
  3. Discover a constraint of this codebase       → memory_save({ type: "fact", content: "<constraint>" })
  4. Make a non-obvious decision                  → memory_save({ type: "decision", content: "<decision> because <reason>; rejected: <alternative>" })

CAPTURE AT SESSION END (mandatory, before finishing):
  - 2+ problems were encountered: save each as learning/error above.
  - Or one-shot dump: `agentic-cortex ingest --file <transcript-path>` (regex + LLM extraction of decisions/errors/learnings).

FORMAT for lessons (searchable later): name the surface (file/tool/function), the failure mode, and the working fix. Never save secrets, API keys, tokens, or credentials — the sanitizer blocks/redacts them.

This is how the system learns from mistakes instead of repeating them. Saving nothing from a problem-heavy session is a failure.
</lesson_capture>

## All 138 MCP Tools

### Memory core: memory_save, memory_search, memory_get, memory_list, memory_edit, memory_forget, memory_context, memory_reflect, memory_conflicts, memory_export, memory_import, memory_health, memory_embed, memory_relate, memory_graph, memory_hook, memory_share, memory_feedback, memory_trail (19)

### Memory advanced: memory_learn_from_error, memory_record_action, memory_transfer_knowledge, memory_machine_vault, memory_promote_global, memory_search_all, memory_ingest_transcript, memory_utility_stats, memory_freshness, memory_maintenance, memory_analytics, memory_standards, memory_auto_capture, memory_skill_list, memory_skill_search, memory_daily_summary, memory_crystallize, memory_experiment, memory_eval_log, memory_fsm, memory_rules, memory_workflow, memory_workflow_agents, memory_prompts_list, memory_prompts_render, memory_plateau_check (26)

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

MCP: agentic-cortex-mcp — 138 tools. Configured in .mcp.json, .cursor/mcp.json, opencode.json.

Read knowledge.md for injected context (coding standards, session memories, codebase graph).
<!-- agentic-cortex:end -->
