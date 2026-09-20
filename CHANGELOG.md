# Changelog

## v7.5.0 — Calibrated, settleable commitments (YOINK-inspired)

All eight lessons from studying [YOINK](https://github.com/DefiLeoo/YOINK)'s
"grade yourself and refuse to cheat" philosophy, in one release.

### Calibrated confidence
- `feedback()` now records an immutable **feedback event** carrying the
  confidence the system held at the moment of judgment.
- New `src/core/calibration.js` turns those events into two numbers per memory
  type: the **overconfidence gap** (said − right) and the **Brier score**.
- CLI: `agentic-cortex calibration [--project PATH] [--machine]`.
- MCP: `memory_calibration`.

### Settleable claims
- Commitments can carry structured frontmatter: `claim` + `test` (e.g.
  `gte N`, range ops) + `settle_date` + optional `read_source` (file, URL, or
  RPC endpoint scheme).
- Maintenance sweeps due claims automatically: reads the source, applies the
  test, and writes the outcome back — feeding the calibration loop.
- Manual override: `agentic-cortex settle [--id N --value X] [--dry-run]`.
- MCP: `memory_settle_claims`.

### Save-time sanity gate
- Unverifiable predictions are **refused at save time** with a stated reason
  (no test, no date, no source) — vault quality is defended at the capture
  edge, not just at reflection time.

### Dead-memory audit
- `agentic-cortex dead` surfaces memories nothing links to, that were never
  retrieved and never graded, as an honest health metric (`doctor` reports the
  share). MCP: `memory_dead_memories`.

### Tamper-evident eval log
- Eval-log entries are hash-chained (`hash_n = sha256(entry_n | hash_{n-1})`).
- `agentic-cortex doctor` verifies the chain end-to-end and names the exact
  line where a retroactive edit occurred. Tamper-*evident*, not tamper-proof —
  regression-tested with a demonstrated full rewrite.

### Honest docs
- New `scripts/check-readme.js` recomputes MCP tool count, memory types, prompt
  templates, and test-file count straight from source and fails if the README's
  numbers disagree (YOINK's `figures.py --check` pattern). It found real drift:
  README corrected from 110 → **138** MCP tools, 10 → **20** prompt templates,
  and the memory-types section expanded to the full **26** accepted types.

### Capability-absence testing
- `tests/capability-absence.test.js` parses source files to prove guarantees
  structurally: the ~400MB embedding model is never auto-required on
  automatic paths, and the seed sanitizer fails closed.

### Rebuildable index
- `agentic-cortex rebuild --from <export.json> --yes` wipes and rebuilds the
  SQLite vault from a JSON export — the markdown/JSON export layer is the
  durable, human-inspectable truth; SQLite is a rebuildable index.
- MCP: `memory_rebuild`.

### Tests
- 34 new tests (`tests/yoink-lessons.test.js`,
  `tests/capability-absence.test.js`); 908 total.
