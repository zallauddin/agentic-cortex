# MemoryBench Head-to-Head, Granularity-Controlled: agentic-cortex vs filesystem

**Harness:** [supermemoryai/memorybench](https://github.com/supermemoryai/memorybench) (MIT) — supermemory's open-source evaluation framework
**Benchmark:** LoCoMo (snap-research/locomo), 600 questions across 4 conversations
**Run date:** 2026-09-12 · **Run ID:** `ac-harness-smoke` · **K:** 10
**Metric:** deterministic hit@10 — ≥50% ground-truth word overlap (words len>2) in top-10 context. No LLM judge (see caveats).

> **v3 (report.json) adds the real supermemory cloud provider** to this matrix
> when `SUPERMEMORY_API_KEY` is set: faithful harness ingestion (76 calls per
> run via per-conversation containers instead of N×19 per-question),
> `search.memories` hybrid with the harness's exact parameters, deterministic
> stratified sample (5/category, 20 questions) to bound cloud cost, and a
> checkpoint cache (`supermemory-cache.json`) so re-runs only pay for new
> questions. The three-way table scores all providers on the same sampled
> subset; the full AC/FS matrix (600 questions) is unchanged. As of this
> writing the key was not available on this machine — AC/FS results below are
> v2-exact, and the cloud row is one keyed re-run away
> (`node scripts/supermemory-smoke.js` validates the key first).

> **v2 (this report) supersedes v1.** The first comparison pitted AC's mixed
> 434-row containers (sessions + turns) against the filesystem baseline's 19
> session documents — document granularity was confounded with retrieval
> quality, and the earlier interpretation ("turn-level storage drives the
> multi-hop win") was an artifact. v2 holds unit size constant in a 2×2
> matrix and reaches the **opposite conclusion**. v1 is preserved at
> `data/runs/memorybench-compare/report-v1-mixed-granularity.json`.

## Summary — 2×2 matrix (matched-granularity pairs in bold)

| Config | Units/question | Recall@10 |
|---|---|---|
| **filesystem@session** (MemoryBench native) | ~19 | **54.2%** |
| **agentic-cortex@session** (matched) | ~19 | **63.0%** ✅ |
| **filesystem@turn** (matched) | ~415 | **28.5%** |
| **agentic-cortex@turn** (adapter default mix) | ~415 | **25.3%** |

**Matched-pair verdicts (unit size held constant):**
- Session level: **AC wins by +8.8 pts** (63.0% vs 54.2%)
- Turn level: filesystem wins by 3.2 pts (28.5% vs 25.3%) — a statistical wash

## By category (recall@10)

| Category | FS@session | AC@session | FS@turn | AC@turn |
|---|---|---|---|---|
| multi_hop | 30.8% | **80.0%** | 9.2% | 6.9% |
| single_hop | 58.6% | **62.2%** | 18.9% | 22.5% |
| world_knowledge | **95.3%** | 88.8% | 63.3% | 52.6% |
| temporal | **46.9%** | 43.8% | 6.3% | **15.6%** |
| adversarial* | 0% | 0% | 0% | 0% |

\* Adversarial questions are unanswerable by design (`answer: undefined` in
LoCoMo), so deterministic word-overlap scoring structurally scores 0% for every
provider. Exclude this row (or score with an LLM judge, which MemoryBench's
full pipeline does).

## What changed vs v1, and why it matters

1. **Granularity isolated.** AC's rows carry adapter tags
   (`session-transcript` vs `dialog-turn`), so AC can be pinned to either unit
   size from the same harness-ingested DB without re-ingesting. The filesystem
   baseline runs MemoryBench's own algorithm on the same 19 sessions, or on
   the same per-turn docs (turns ≥ 30 chars — the adapter's ingest threshold).
2. **AC's search mirrored faithfully.** The evaluator reproduces
   `keywordSearch()` from `src/core/search.js`: quoted-word OR query, `ORDER
   BY rank`, join on `o.id`, title-composed previews. (v2's first cut omitted
   `ORDER BY rank` and got 0%/misleading numbers — fixed before publishing.)
3. **The real finding:** with unit size matched, **AC's FTS5 retrieval is
   better than the filesystem baseline at session level** — driven by
   multi-hop (80% vs 30.8%, +49.2 pts), where quoting each query word and
   OR-ranking surfaces evidence scattered across sessions that term-coverage
   scoring drowns. AC also edges single-hop (+3.6). Filesystem keeps
   world_knowledge (+6.5), where answers are literal substrings that simple
   substring coverage finds anywhere.
4. **Granularity dominates retrieval quality.** Going from 19 session-docs to
   ~415 turn-docs costs ~30 pts for *both* providers at k=10: top-10 turn
   snippets (~100 chars each) rarely contain ≥50% of a ground-truth answer's
   words. Session-level ingestion is the right operating point for this
   metric — a finding about the metric as much as the systems.

## What this run verified (end-to-end, real harness)

- **Adapter registered** as a first-class MemoryBench provider (`src/providers/ac`
  in the memorybench clone; mirrored in this repo), implementing the full
  `Provider` interface: `initialize` / `ingest` / `awaitIndexing` / `search` / `clear`.
- **Harness ran its own pipeline against AC** — `ingest → indexing → search`
  through supermemoryai/memorybench's orchestrator with checkpointing
  (`data/runs/ac-harness-smoke/`). Every question got its own AC container
  (harness isolation model): ~600 containers, 434 observations each.
- **Search returned exact evidence** — e.g. for "When did Caroline go to the
  LGBTQ support group?", AC's top-1 was the right dialog turn.
- **Head-to-head scored identically** for both providers over the same corpus.
  Raw JSON: `data/runs/memorybench-compare/report.json`.

## Caveats

- **No LLM judge.** MemoryBench's `answer`/`evaluate` phases need an LLM API
  key (GPT-4o/Claude/Gemini). This measures *retrieval recall*, not MemScore
  answer accuracy.
- **supermemory cloud: adapter ready, awaiting key.** The runner's supermemory
  path mirrors the harness provider (same SDK v4 calls, same search params);
  it needs `SUPERMEMORY_API_KEY` and was skipped cleanly with the full matrix
  reproduced bit-exact (`supermemory.ran=false`, `reason` recorded, planned
  sample documented in report.json). Mem0/Zep remain out of scope.
- **Keyword-only AC.** BGE embeddings were not enabled (memory-safe default;
  model not cached). Semantic categories may shift with
  `AGENTIC_CORTEX_EMBEDDINGS=1`.
- **hit@10 word-overlap is a blunt metric.** It rewards large units (more text
  in top-k) — hence the granularity finding. Per-unit precision/MRR would
  complement it; MemoryBench's LLM-judge path is the authoritative scorer.

## Reproduce

```bash
# 1. Clone MemoryBench and install (bun)
git clone https://github.com/supermemoryai/memorybench && cd memorybench
bun install

# 2. Copy the AC provider adapter from this repo
cp -r <ac-repo>/src/providers/ac src/providers/
# apply the 3 small patches: providers/index.ts registration,
# utils/config.ts provider case, lazy `serve` import (Bun-only web server)

# 3. Run the real harness against AC (hermetic DB)
AGENTIC_CORTEX_DB=/tmp/ac-bench.db \
AGENTIC_CORTEX_PATH=<ac-repo> \
node ./node_modules/tsx/dist/cli.mjs src/index.ts ingest -p agentic-cortex -b locomo -r <runId>

# 4. Granularity-controlled head-to-head (no judge key needed)
cp <ac-repo>/scripts/memorybench-head-to-head.js .
AGENTIC_CORTEX_DB=/tmp/ac-bench.db node head-to-head.js
```

The AC provider adapter resolves the agentic-cortex API via `AGENTIC_CORTEX_PATH`
(or pass `acApiPath` explicitly) and writes into a hermetic SQLite DB via
`AGENTIC_CORTEX_DB` — your real memory vault is never touched.
