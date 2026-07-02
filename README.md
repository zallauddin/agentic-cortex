# agentic-cortex

Persistent typed memory for AI coding agents (Codebuff, Claude Code, Cursor, Codex, etc.). Three-layer context system inspired by Memanto's memory architecture.

1. **13 typed memories** — instruction, fact, decision, goal, commitment, preference, relationship, context, event, learning, observation, artifact, error
2. **Confidence & provenance** — every memory tracks how sure you are (0-100) and where it came from (explicit, inferred, observed)
3. **Codebase graph** — deterministic structural map of the entire codebase (zero LLM cost, SHA-256 cached)

## Install

```bash
npm install -g agentic-cortex
```

## Quick Start

```bash
# 1. Initialize a project (creates knowledge.md with memory markers)
cd your-project
agentic-cortex init

# 2. Generate the codebase structure graph
agentic-cortex graph

# 3. Inject context before starting your agent
agentic-cortex inject
```

## Commands

### Core Memory
| Command | Description |
|---|---|
| `agentic-cortex save <title> <content>` | Save a memory with type, confidence, provenance |
| `agentic-cortex search <query>` | Search with keyword, semantic (`--semantic`), or temporal (`--as-of`, `--changed-since`) filters |
| `agentic-cortex get <id>` | View full memory by ID |
| `agentic-cortex edit <id>` | Edit memory (creates version history) |
| `agentic-cortex forget <id>` | Soft-delete a memory (`--hard` for permanent) |
| `agentic-cortex bulk` | Bulk import JSON from stdin |

### Intelligence
| Command | Description |
|---|---|
| `agentic-cortex conflicts` | Detect contradictory memories (semantic similarity + LLM check) |
| `agentic-cortex answer <question>` | Grounded QA — retrieve relevant memories + LLM answer |
| `agentic-cortex daily-summary` | Summarize yesterday's observations |
| `agentic-cortex upload <file>` | Upload files (.md, .txt, .json, .csv, .py, .ts, etc.) into memory |

### Project Setup
| Command | Description |
|---|---|
| `agentic-cortex init` | Create knowledge.md template in current directory |
| `agentic-cortex graph` | Generate/update the codebase structure graph |
| `agentic-cortex inject` | Inject memories + codebase graph into knowledge.md |
| `agentic-cortex embed` | Generate BGE embeddings for all observations |
| `agentic-cortex session` | Start/end/summarize coding sessions |
| `agentic-cortex export <vault-path>` | Export to Obsidian vault (wikilinks, tag indexes) |
| `agentic-cortex serve [port]` | Start HTTP API server |

### System
| Command | Description |
|---|---|
| `agentic-cortex health` | Database statistics |
| `agentic-cortex timeline` | Recent sessions for a project |
| `agentic-cortex projects` | List all known projects |

## Memory Types (13 from Memanto)

`instruction` `fact` `decision` `goal` `commitment` `preference` `relationship` `context` `event` `learning` `observation` `artifact` `error`

Plus backwards-compatible aliases: `architecture`, `bugfix`, `gotcha`, `codebase-graph`

## Save with Confidence & Provenance

```bash
agentic-cortex save "API key rotation schedule" "Rotate all keys every 90 days" \
  --type instruction --confidence 95 --provenance explicit --importance 9
```

## Temporal Queries

```bash
# What changed since last week?
agentic-cortex search --changed-since 2026-06-21 --project /my/project

# What did we know as of a specific date?
agentic-cortex search "port configuration" --as-of 2026-06-01
```

## Conflict Detection

```bash
# Find potentially contradictory memories
agentic-cortex conflicts --project /my/project --limit 5
```

## Grounded Q&A

```bash
agentic-cortex answer "What database credentials are we using for production?" \
  --project /my/project --top-k 5
```

## File Upload

```bash
agentic-cortex upload docs/api-spec.md --type artifact --title "API Specification"
agentic-cortex upload data/export.csv --type observation
```

## Fresh Machine Setup

```bash
npm install -g agentic-cortex
git clone <your-repo> && cd <your-repo>
agentic-cortex init && agentic-cortex graph && agentic-cortex inject
# Your agent now has full context
```

## Environment

| Variable | Default | Description |
|---|---|---|
| `AGENTIC_CORTEX_PROJECT` | cwd | Default project path |
| `AGENTIC_CORTEX_SESSION` | — | Current session ID |
| `AGENTIC_CORTEX_PORT` | 37777 | HTTP server port |
| `LLAMA_CPP_BASE_URL` | http://127.0.0.1:8081 | LLM for summaries/QA |

## License

Apache 2.0
