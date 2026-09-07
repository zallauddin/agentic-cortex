# Contributing to Agentic Cortex

Thanks for helping improve AC. This guide gets you from clone to green tests in one sitting.

## Setup

**Option A — local:**

```bash
git clone https://github.com/zallauddin/agentic-cortex.git
cd agentic-cortex
npm ci --include=optional     # optional deps enable embeddings/deferred models
npm test                      # ~820 tests, no network or LLM needed
```

**Option B — dev container:**

Open the repo in VS Code → "Reopen in Container" (`.devcontainer/` handles everything), or:

```bash
docker compose up --build
```

## Ground rules

1. **Deterministic-first.** Every feature must work with `AGENTIC_CORTEX_LLM_PROVIDER=off`. LLM calls go through `src/core/llm-adapter.js` (`callProvider`) and must treat `null` as "unavailable, fall back". Never call `fetch` for model traffic directly.
2. **Tests are mandatory.** New modules need `tests/<module>.test.js`. Run the full suite before opening a PR — it must be green.
3. **Privacy is a hard boundary.** Anything that leaves the machine (seeds, sync) must pass through `seed-sanitizer.js`. Never add an export path that bypasses it.
4. **Idempotent side effects.** Config-writing code (`wireup.js`, `create-discovery-files.js`) must be safe to re-run and must never clobber unrelated user config.
5. **No new runtime dependencies** without discussion. `better-sqlite3` is the only hard dep; heavy features go in `optionalDependencies` behind graceful degradation.

## Code layout

```
cli.js                 CLI commands (commands.<name> = { desc, parse, run })
src/api/index.js       unified API surface used by CLI, MCP, HTTP
src/mcp/server.js      MCP stdio server (TOOLS registry + handleRequest)
src/core/              domain modules (db, session, search, tree-search, prm, …)
src/core/llm-adapter.js  model provider abstraction — callProvider()
src/sync/              git-based seed distribution (sanitize → push / pull → germinate)
tests/                 node:test suites
examples/              runnable demos (offline-demo.js, mcp-demo.js)
scripts/               setup, seeding, discovery-file generation
```

## Adding an MCP tool

1. Add the tool definition to `TOOLS` in `src/mcp/server.js` (name, description, JSON schema).
2. Implement the case in the tool dispatch switch, delegating to an `src/api/index.js` function (keep business logic out of the transport).
3. Add a CLI command wrapper in `cli.js` if it makes sense interactively.
4. Add tests in `tests/mcp.test.js` (transport-level) and unit tests for the API function.

## Adding a model provider

1. `registerProvider('name', { available, complete })` in `src/core/llm-adapter.js` (or call it from a plugin).
2. `complete(messages, opts)` returns text or `null`; throw only for real errors, not unavailability.
3. Document the env vars in `QUICKSTART.md` and the help text in `cli.js`.
4. Test with `AGENTIC_CORTEX_LLM_PROVIDER=name agentic-cortex llm-status`.

## Adding an agent integration

Add the framework to `src/core/manifest.js`: detection evidence (config files, env vars, PATH commands) plus a data-driven wiring recipe (JSON merge / TOML / YAML / manual). Then extend `scripts/create-discovery-files.js` if the agent has its own config file. Cover it in `tests/manifest.test.js` and `tests/wireup.test.js`.

## Commit style

Short imperative subject focused on the *why*, e.g. `fix: hybridSearch drops FTS hits in keyword-only mode`. PRs must include: what changed, why, test evidence (`npm test` summary), and any migration notes.

## Reporting bugs

Include: AC version (`agentic-cortex --version`), provider config (`agentic-cortex llm-status` output), the failing command, and structured logs (`AGENTIC_CORTEX_LOG=json <command> 2>log.txt`).
