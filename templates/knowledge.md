<agentic_cortex>
<bootstrap>MCP: memory_bootstrap({}) — CLI: agentic-cortex bootstrap</bootstrap>

<auto_save>
Agentic-cortex is installed globally. MCP server is configured for this project.
PREFERRED: Use MCP tool memory_save({ content, type?, importance?, confidence?, tags? }).
FALLBACK CLI: agentic-cortex save "title" "content"
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

<key_mcp_tools>
memory_bootstrap({}) — session start (CRITICAL: call first, no args)
memory_save({ content, type? }) — save observation (type auto-detected)
memory_search({ query, project?, limit? }) — hybrid FTS5 + semantic search
memory_search_all({ query }) — search ALL projects on this machine
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
</key_mcp_tools>

<commands>
MCP tools (preferred): memory_bootstrap({}) | memory_save({...}) | memory_search({ query })
  memory_search_all({ query }) | memory_machine_vault({}) | memory_promote_global({ id })
  memory_reflect({}) | memory_feedback({ id, type }) | memory_context({})
CLI fallback: agentic-cortex bootstrap | save "t" "c" | search "q" --project .
  agentic-cortex machine-search "query" | agentic-cortex machine-memory [--analytics]
  agentic-cortex forget <id> [--hard] | agentic-cortex feedback <id> --type helpful|incorrect
  agentic-cortex answer "question" --project . | agentic-cortex standards --search "topic"
  agentic-cortex daily-summary --project .
</commands>

<memory_types>instruction fact decision goal commitment preference relationship context event learning observation artifact error</memory_types>

<mcp>agentic-cortex-mcp — 42 tools on stdio JSON-RPC. Configured via .mcp.json, .cursor/mcp.json, or opencode.json.</mcp>

<injected_context>
Below is auto-injected by git hooks (post-merge, post-checkout) or agentic-cortex inject.
Contains: coding standards, session memories, codebase graph.
Use to skip rediscovery of known files and decisions.
</injected_context>
</agentic_cortex>

<!-- MEMORY_CONTEXT_START -->
<!-- MEMORY_CONTEXT_END -->
