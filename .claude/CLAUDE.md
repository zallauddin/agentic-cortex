<!-- agentic-cortex:start:v6.5.1 -->
<agentic_cortex>
agentic-cortex is installed. Persistent, self-improving memory across sessions.
MCP server is configured in .mcp.json — 67 tools available directly.

<reasoning>
For hard problems, use tree search reasoning:
  memory_tree_search({ problem: "..." }) — explore multiple reasoning branches
  memory_verify_step({ stepContent: "..." }) — verify a reasoning step (PRM)
  memory_budget({ problem: "..." }) — estimate difficulty and compute budget
  memory_verify_code({ hypothesis: "..." }) — program-aided verification
  memory_reflexion({ ... }) — record failed path for self-correction
</reasoning>

<bootstrap>
PREFERRED: Use MCP tool memory_bootstrap({}) — no args needed. Returns structured XML context.
FALLBACK CLI: agentic-cortex bootstrap
</bootstrap>

MCP tools (78 total):
Memory core: memory_save, memory_search, memory_get, memory_list, memory_edit, memory_forget, memory_context, memory_reflect, memory_conflicts, memory_export, memory_import, memory_health, memory_embed, memory_relate, memory_graph, memory_hook, memory_share, memory_feedback, memory_trail,
Memory advanced: memory_learn_from_error, memory_record_action, memory_transfer_knowledge, memory_machine_vault, memory_promote_global, memory_search_all, memory_ingest_transcript, memory_utility_stats, memory_freshness, memory_maintenance, memory_analytics, memory_standards, memory_auto_capture, memory_skill_list, memory_skill_search, memory_daily_summary, memory_crystallize, memory_experiment, memory_eval_log, memory_fsm, memory_rules, memory_workflow, memory_workflow_agents, memory_prompts_list, memory_prompts_render, memory_plateau_check,
Reasoning: memory_tree_search, memory_verify_step, memory_budget, memory_verify_code, memory_reflexion, memory_reasoning_trace, memory_reasoning_stats, memory_synthesize_solution, memory_self_consistency, memory_budget_force,
Session: session_start, session_end, session_summarize, agent_session_start, agent_session_end, agent_list_sessions, memory_shared_get, memory_provider, memory_send, memory_inbox, memory_mark_read,
Bootstrap: memory_bootstrap.

<auto_save>
PREFERRED: Use MCP tool memory_save({ content, type?, importance?, confidence?, tags? }).
FALLBACK CLI: agentic-cortex save "title" "content"
Type auto-detected. Triggers: decision|90 error|95 context|80 preference|100 fact|85 event|95 learning|75 instruction|90
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

<mcp>agentic-cortex-mcp configured in .mcp.json. 67 tools on stdio JSON-RPC.</mcp>

Read knowledge.md for injected context (coding standards, session memories, codebase graph).
</agentic_cortex>
<!-- agentic-cortex:end -->


