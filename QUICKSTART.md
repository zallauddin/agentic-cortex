# Quickstart — Agentic Cortex

Get AC wired into your AI coding agent in under two minutes.

## Install

```bash
npm install -g agentic-cortex
```

The postinstall script auto-creates the vault and discovery files. `better-sqlite3` ships prebuilt binaries; `@xenova/transformers` (local embeddings/generation) is an optional dependency — install it if you want semantic search and offline models:

```bash
npm install -g @xenova/transformers   # optional, enables embeddings
```

## 1. Wire into your agents (one command)

```bash
agentic-cortex wireup
```

Detects ~22 frameworks (Claude Code, Cursor, OpenCode, Codex, Windsurf, Gemini CLI, Copilot, Roo, Cline, Continue, Zed, Goose, Amazon Q, Freebuff, …) and hard-wires AC into each: merges the MCP server config, injects the memory-ownership instructions. Idempotent — safe to re-run. Preview without writing:

```bash
agentic-cortex wireup --dry-run
```

Restart your agent afterwards; it will now save observations, recall memories, and build context automatically through MCP.

## 2. Pick a model provider (optional)

AC works with **zero LLM** — every reasoning path has a deterministic fallback. To enable full reasoning, point it at any OpenAI-compatible server:

```bash
# llama.cpp / LM Studio / Ollama (/v1) / vLLM / OpenRouter / OpenAI
export AGENTIC_CORTEX_LLM_BASE_URL=http://127.0.0.1:8081   # default
export AGENTIC_CORTEX_LLM_MODEL=qwen2.5-coder:7b
# export AGENTIC_CORTEX_LLM_API_KEY=sk-...                  # hosted providers only

# Or fully offline local generation:
export AGENTIC_CORTEX_LLM_PROVIDER=xenova

# Or fully deterministic (no model at all):
export AGENTIC_CORTEX_LLM_PROVIDER=off

agentic-cortex llm-status   # verify
```

## 3. Try it

```bash
# Fully offline memory loop demo (no network, no model):
node examples/offline-demo.js

# Speak real MCP JSON-RPC to the server, like your agent does:
node examples/mcp-demo.js

# CLI basics
agentic-cortex save "Fixed flaky retry loop" "Added fixed 1s backoff between attempts" --type learning
agentic-cortex search "flaky retry"
agentic-cortex health
agentic-cortex stats
```

## 4. Dashboard & observability

```bash
agentic-cortex serve        # http://127.0.0.1:37777
```

- `/` — 5-layer cortex dashboard
- `/health` — vault + LLM provider status (JSON)
- `/metrics` — Prometheus gauges (`?format=json` also supported)

Structured logs: `AGENTIC_CORTEX_LOG=json` emits one JSON object per line on stderr.

## 5. Share knowledge across machines (opt-in)

AC's seed system exports **sanitized** lessons (credentials hard-blocked, identity stripped, TTL-applied) to a git repo and germinates them on other machines with quarantined trust until re-proven locally:

```bash
export AGENTIC_CORTEX_MEMORY_REPO=git@github.com:you/ac-seeds.git
agentic-cortex sync-push
agentic-cortex sync-pull
```

## Environment reference

| Variable | Default | Purpose |
|---|---|---|
| `AGENTIC_CORTEX_DB` | `~/.agentic-cortex/agentic-cortex.db` | Vault location |
| `AGENTIC_CORTEX_PROJECT` | cwd | Default project scope |
| `AGENTIC_CORTEX_LLM_PROVIDER` | `openai` | `openai` \| `xenova` \| `off` |
| `AGENTIC_CORTEX_LLM_BASE_URL` | `LLAMA_CPP_BASE_URL` or `http://127.0.0.1:8081` | OpenAI-compatible endpoint |
| `AGENTIC_CORTEX_LLM_MODEL` | server default | Model name |
| `AGENTIC_CORTEX_LLM_API_KEY` | — | Bearer token |
| `AGENTIC_CORTEX_LLM_LOCAL_MODEL` | `Xenova/LaMini-Flan-T5-77M` | Local model (xenova provider) |
| `AGENTIC_CORTEX_LOG` | `pretty` | `pretty` \| `json` |
| `AGENTIC_CORTEX_EMBEDDINGS` | off | `1` enables semantic embeddings |

## Docker

```bash
docker compose up --build        # dashboard API on :37777, vault in named volume
docker compose run --rm demo     # run the offline demo against the shared vault
```

Next steps: [ARCHITECTURE.md](ARCHITECTURE.md) for the internals, [CONTRIBUTING.md](CONTRIBUTING.md) to hack on AC.
