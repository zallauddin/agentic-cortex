<!-- agentic-cortex:start:v4.7.6 -->
<agentic_cortex>
Persistent, self-improving agent memory. MCP server configured in opencode.json.
43 MCP tools available.

<bootstrap>
CRITICAL: Call MCP tool memory_bootstrap({}) first — no args needed.
Returns XML context: actionable insights, task-relevant memories, warnings,
coding standards, codebase graph, machine-wide global vault.
</bootstrap>

<auto_save>
Use MCP tool memory_save({ content, type?, importance?, confidence?, tags? }).
Type auto-detected from content patterns.
Triggers: decision|90 error|95 context|80 preference|100 fact|85 event|95 learning|75 instruction|90
</auto_save>

<all_43_mcp_tools>

Memory core: memory_save, memory_search, memory_get, memory_list, memory_edit, memory_forget, memory_context, memory_reflect, memory_conflicts, memory_export, memory_import, memory_health, memory_embed, memory_relate, memory_graph, memory_hook, memory_share, memory_feedback, memory_trail (19)

Memory advanced: memory_learn_from_error, memory_record_action, memory_transfer_knowledge, memory_machine_vault, memory_promote_global, memory_search_all, memory_ingest_transcript, memory_utility_stats, memory_freshness, memory_maintenance, memory_analytics, memory_standards, memory_auto_capture, memory_skill_list, memory_skill_search, memory_daily_summary (16)

Session: session_start, session_end, session_summarize, agent_session_start, agent_session_end, agent_list_sessions, memory_shared_get (7)

Bootstrap: memory_bootstrap (1)

</all_43_mcp_tools>

<key_tools>
memory_bootstrap({}) — session start context (CRITICAL: call first)
memory_save({ content, type? }) — save observation (type auto-detected)
memory_search({ query, project?, limit? }) — hybrid FTS5 + semantic search
memory_search_all({ query }) — search across ALL projects on this machine
memory_machine_vault({}) — browse machine-wide global vault
memory_promote_global({ id }) — promote to cross-project vault
memory_reflect({}) — consolidate, promote patterns, archive
memory_feedback({ id, type }) — mark helpful or incorrect
memory_context({ project? }) — full project context pack
memory_forget({ id }) — soft-delete (hard: true for permanent)
memory_list({ project?, type?, limit? }) — list with filters
memory_conflicts({}) — detect contradictory observations
memory_standards({ action: "search", query }) — search coding standards
memory_daily_summary({}) — yesterday's observations summary
</key_tools>

<memory_types>instruction fact decision goal commitment preference relationship context event learning observation artifact error</memory_types>

<mcp>43 tools via opencode.json mcp config. Run agentic-cortex-mcp locally.</mcp>
</agentic_cortex>
<!-- agentic-cortex:end -->
