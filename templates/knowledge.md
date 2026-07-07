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
<!-- MEMORY_CONTEXT_END -->
