


<!-- agentic-cortex:start:v7.5.0 -->
<agentic_cortex>
agentic-cortex is installed. Persistent, self-improving memory across sessions.
MCP server is configured in .mcp.json — 138 tools available directly.

<bootstrap>
PREFERRED: Use MCP tool memory_bootstrap({}) — no args needed. Returns structured XML context.
FALLBACK CLI: agentic-cortex bootstrap
</bootstrap>

MCP tools (138 total):
Memory core: memory_save, memory_search, memory_get, memory_list, memory_edit, memory_forget, memory_context, memory_reflect, memory_conflicts, memory_export, memory_import, memory_health, memory_embed, memory_relate, memory_graph, memory_hook, memory_share, memory_feedback, memory_trail,
Memory advanced: memory_learn_from_error, memory_record_action, memory_transfer_knowledge, memory_machine_vault, memory_promote_global, memory_search_all, memory_ingest_transcript, memory_utility_stats, memory_freshness, memory_maintenance, memory_analytics, memory_standards, memory_auto_capture, memory_skill_list, memory_skill_search, memory_daily_summary, memory_crystallize, memory_experiment, memory_eval_log, memory_fsm, memory_rules, memory_workflow, memory_workflow_agents, memory_prompts_list, memory_prompts_render, memory_plateau_check,
Session: session_start, session_end, session_summarize, agent_session_start, agent_session_end, agent_list_sessions, memory_shared_get, memory_provider, memory_send, memory_inbox, memory_mark_read,
Bootstrap: memory_bootstrap.

<auto_save>
PREFERRED: Use MCP tool memory_save({ content, type?, importance?, confidence?, tags? }).
FALLBACK CLI: agentic-cortex save "title" "content"
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
</auto_save>

<commands>
MCP tools (preferred): memory_bootstrap({}) | memory_save({...}) | memory_search({ query })
  memory_search_all({ query }) | memory_machine_vault({}) | memory_promote_global({ id })
  memory_reflect({}) | memory_feedback({ id, type }) | memory_context({}) | memory_health({})
  memory_export({}) | memory_import({}) | memory_conflicts({}) | memory_list({})
CLI fallback: agentic-cortex bootstrap | save "t" "c" | search "q" --project .
  agentic-cortex machine-search "q" | machine-memory [--analytics]
  agentic-cortex forget <id> | feedback <id> --type helpful|incorrect
  agentic-cortex standards --search "topic"
</commands>

<memory_types>instruction fact decision goal commitment preference relationship context event learning observation artifact error</memory_types>

<mcp>agentic-cortex-mcp configured in .mcp.json. 138 tools on stdio JSON-RPC.</mcp>

Read knowledge.md for injected context (coding standards, session memories, codebase graph).
</agentic_cortex>
<!-- agentic-cortex:end -->
