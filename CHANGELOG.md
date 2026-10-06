# Changelog

## v7.6.0 — Lesson persistence, and a benchmark loop that can refuse itself

Two independent strands: a durable, signed pipeline for turning raw sessions
into shareable lessons, and turning "improve the benchmark numbers" from an
assertion into an executable procedure with gates that can fail.

### Lesson persistence
- `src/core/distill.js` — phase 0: generalizes and sanitizes learning/error
  observations into a local `lessons/` markdown layer, so raw conversations
  don't die with the session and private vault rows never leak into a shareable
  artifact.
- `src/core/seeds.js` — phases 1–4: each seed is ONE signed JSON file in a git
  registry (`seeds/<hash[0:2]>/<hash>.json`), signed over its canonical bytes.
- `src/core/seed-log.js` — phase 3c: a Merkle-chained transparency log for the
  seed registry, reusing the v7.5.0 eval-log construction
  (`hash_n = sha256(prev_hash | canonical_entry)`).
- `src/core/seed-crdt.js` — phase 3b: federated grade counters
  (`seed → grade → machine_id → count`), so reputation needs no central
  tallier.
- Design notes in `LESSON-PERSISTENCE-DESIGN.md`; suites in
  `tests/{distill,seeds,seed-log,seed-crdt}.test.js`.

### Benchmark loop — the formula, runnable
- `scripts/benchmark-loop.js`: **(1)** re-measure the published baseline through
  the real `api.search` and **exit 2** if it drifts from MEMORYBENCH.md;
  **(2)** run every candidate through that same path on every corpus with a
  hermetic DB; **(3)** adopt only what improves ≥1 corpus, regresses **none**,
  and stays inside a **+50% context budget**; **(4)** name the weakest question
  type for the next round. Three rounds run: 8 rejected, 1 parked OVER BUDGET
  rather than silently adopted. Gates are self-tested — `--selftest-drift`
  must exit 2, `--quick` must exit 0, no corpus must exit 1.
- `scripts/measure-shipped.js` drives `api.search` itself (not a stand-in) with
  full-content hydration and a distinct-conversation census;
  `scripts/spread-diagnose.js` answers *before* any code is written whether a
  missing answer is reachable, pooled, and spread across sessions.
- `scripts/verify-bench-doc.js` — 56 checks asserting MEMORYBENCH.md against
  the committed report in **both** directions: new values present, superseded
  ones absent.

### Retrieval hardening (measured on two corpora before adoption)
- **Query hygiene** — the FTS5 expression was built by splitting on spaces and
  quoting every token, so stopwords entered an OR query where BM25's idf is
  *negative* and actively subtracts score. `buildFtsQuery()` now tokenizes on
  non-alphanumerics, lowercases, de-duplicates, drops stopwords (falling back
  if the query is all stopwords) and caps at 24 terms.
- **Breadth cap** — one long conversation could fill all 10 slots with
  near-duplicate turns (median 3 distinct sessions per top-10).
  `capPerSession()` / `opts.maxPerSession`.
- **MMR regex** — `diversifyResults()` split tokens on `/\\W+/` (a literal
  backslash), so every similarity was 0 and diversification silently
  degenerated to plain relevance order.
- **Empty-result safety net** — `search()` could return **zero rows** for a
  question about data it holds: FTS5 doesn't stem, so "relationship" against a
  corpus of "relationships" scored df=0 for every term. Short result sets are
  now topped up from a coverage-ranked transcript channel (substring-based, so
  it degrades to "nearest conversation" instead of "nothing").
- **Transcript-channel fusion** (opt-in) — AC stores conversations twice;
  BM25's length normalisation buries the transcripts at ranks 58/143/187.
  RRF-fusing a coverage-ranked transcript channel reaches LongMemEval **88%**
  vs 80%, but costs 3.4× the prompt, so it stays behind `opts.fuseTranscripts`
  with a measured frontier table rather than being defaulted.
- **Selection policies** (opt-in) — `opts.selectionPolicy`:
  `spread` floors the number of distinct conversations in the top-k;
  `coverage` selects by marginal query-term gain. Neither moves the scores —
  documented as a robustness guarantee, not a benchmark win.

### Honest metrics
- The scorer returned `false` whenever `groundTruth.length <= 3`, which
  auto-failed LongMemEval's `"$12"`, `"20%"` multi-session answers — **9 of 30
  questions unscoreable for every provider**. Non-scorable questions are now
  excluded from the denominator and reported. The matcher lives in one shared
  module (`scripts/lib/bench-metric.js`) so the runners can't drift.
- The provider adapter returned 300-char previews as `content`, so harness runs
  judged truncated evidence (median 898 chars lost). It now hydrates by id.
- Recomputed scorecard: LongMemEval AC **80%**, filesystem@session **92%**,
  filesystem@turn **64%** — i.e. the real gap is **12 pts**, not the 3.4 pts the
  buggy denominator suggested. LoCoMo retrieval smoke **58.3%**.

### Tests
- 1007 total, 0 failing. New coverage for query terms, IDF/coverage, RRF
  de-duplication, transcript fusion, selection policies, and a regression test
  that fails if a selection policy silently falls back to rank order.

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
