# Benchmark Results: agentic-cortex vs baselines (LoCoMo + LongMemEval)

**Harness:** [supermemoryai/memorybench](https://github.com/supermemoryai/memorybench) (MIT) — supermemory's open-source evaluation framework
**Benchmarks:** LoCoMo (snap-research/locomo, 600 q) · LongMemEval-S (`longmemeval_s_cleaned`, 500 q) · AC's built-in `benchmark recall`
**Metric:** deterministic hit@10 — ≥50% ground-truth word overlap (words len>2) in top-10 context, plus one LLM-judged answer-accuracy run (see caveats).
**Jump to:** [coverage table](#benchmark-coverage--what-ac-has-actually-run) · [LongMemEval](#longmemeval-s-retrieval-head-to-head-2026-10-06) · [judged run](#locomo-llm-judged-smoke-2026-10-05--the-only-end-to-end-answer-accuracy-run) · [2×2 matrix](#summary--22-matrix-matched-granularity-pairs-in-bold) · [caveats](#caveats)

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

## Benchmark coverage — what AC has actually run

| Benchmark | Scale | Metric | AC | Baseline (filesystem) | Verdict |
|---|---|---|---|---|---|
| **LoCoMo** (MemoryBench harness, session granularity) | 600 q | deterministic hit@10 | **63.0%** | 54.2% | **AC +8.8** |
| **LoCoMo** — multi-hop slice | 130 q | deterministic hit@10 | **80.0%** | 30.8% | **AC +49.2** |
| **LoCoMo** — LLM-judged smoke | 15 q | answer accuracy (judge) | 40% (6/15) | not run | n too small; lower bound |
| **LoCoMo** — retrieval smoke | 15 q | deterministic hit@10 | **58.3%** (7/12 scored) | not run | **+8.3** from the empty-result fix below |
| **LongMemEval-S** (retrieval) | 30 q | deterministic hit@10 | **80%** (20/25 scored) | 92% @session / 64% @turn | 12 pts behind @session at **4× less context**; **+16** over @turn |
| **Built-in `benchmark recall`** | 6 q | hit@10 across 4 question kinds | **100% (6/6)** | — | pass |

Everything below is the evidence for that table. Every run uses a **hermetic
SQLite DB** (`AGENTIC_CORTEX_DB`) — a real memory vault is never touched.

### Where that lands against published competitor scores

| System | LoCoMo | LongMemEval | Metric | Judge |
|---|---|---|---|---|
| Mem0 | 92.5 | 94.4 | answer accuracy | frontier LLM (self-reported) |
| Zep | ~90.2 | 94.7 | answer accuracy | frontier LLM (self-reported) |
| Hindsight | — | 94.6 | answer accuracy | frontier LLM (self-reported) |
| Letta | 74.0 | — | answer accuracy | frontier LLM (self-reported) |
| Mastra | — | 84.2 | answer accuracy (GPT-4o) | frontier LLM (self-reported) |
| **agentic-cortex** | **63.0** | **80** | **retrieval hit@10** | **none (deterministic)** |

**These columns are not the same measurement — do not rank across them.**
Every competitor number above is LLM-judged *answer accuracy* on a model's
final answer; both AC numbers are deterministic *retrieval recall* on whether
evidence landed in the top-10. AC's numbers are conservative in two ways at
once (no judge to give credit for partially-correct phrasing, and a hard 50%
word-overlap threshold), so AC would very likely score higher under a judge —
but **no honest number exists for that yet**, which is why the coverage table
above is the real scorecard. The comparison becomes legitimate the moment the
same harness runs AC's `answer`/`evaluate` phases with a frontier judge key.

Also not apples-to-apples: the AC runs are keyword-only FTS5 (embeddings off),
n = 30/15 for the two small runs, and every competitor figure is vendor
self-reported with unreproducible sampling.

> **⚠️ Measurement bug found and fixed (2026-10-06).** AC's `search()` returns
> only a 300-char preview (`substr(o.content, 1, 300)` in
> `src/core/search.js:84`). The provider adapter passed that preview through
> as `content`, so any harness-adapter run scored or judged **truncated
> evidence**: median 898 chars lost per hit, 145/300 LongMemEval hits losing
> >1000 chars, max 22,568 chars. Fixing the adapter to hydrate full content by
> id (search → get, unchanged ranking) moved LongMemEval AC **36.7% → 56.7%**;
> the [hardening round](#hardening-round-2026-10-06-what-was-actually-wrong) and
> the [metric fix](#metric-fix-2026-10-06-short-answers-were-auto-failed) below
> carry it to **80%**.
> The LoCoMo 63.0% figure was never affected — that runner queries AC's DB
> directly for `o.content`. Fixed in both
> [`src/providers/ac/index.ts`](src/providers/ac/index.ts) and the harness
> clone.
>
> **Two more adapter defects fixed in the same pass (type-level, no behaviour
> change):** the class declared `prompts = AC_PROMPTS` in a `{extract, answer}`
> shape that never satisfied the harness's `ProviderPrompts`
> (`{answerPrompt?, judgePrompt?}`) — so the harness has always silently used
> its own default answer/judge prompts, and the field is now deliberately left
> unset so that stays explicit rather than accidental; and `config.acApiPath`
> (from `ProviderConfig`'s `[key: string]: unknown`) reached `require()`
> un-narrowed. Every adapter-attributable error in `tsc --noEmit`
> (2 in `providers/ac/index.ts` + the `providers/index.ts` registration it
> failed) went **3 → 0**; the 3 remaining errors in that harness clone sit on
> lines byte-identical to its git HEAD (`mem0` `webcrypto as Crypto` casts,
> `supermemory` SDK typings) and are upstream, not ours.

## The benchmark loop

A repeatable formula, because benchmark tuning turns into curve-fitting the
moment it runs on one corpus, against a stand-in for the shipped code path,
next to a metric that quietly disagrees with the documentation. The loop is
executable: [`scripts/benchmark-loop.js`](scripts/benchmark-loop.js) runs it
and a run can be judged by whether it passed.

| Phase | Gate | Why it exists |
|---|---|---|
| **1. Reproduce** | Re-measure the published baseline through `api.search` and require it to equal *both* MEMORYBENCH.md and the committed report. | Drift invalidates every later claim, so the loop exits **2** instead of tuning on sand. |
| **2. Measure** | Every candidate config, on every corpus that still has a hermetic DB, through that same path, hydrated by id. | A stand-in for the shipped path measures the stand-in. Missing corpora are skipped loudly. |
| **3. Verdict** | Adopt only if it improves ≥1 corpus, regresses **none**, and stays inside a **+50% context budget**. | One corpus is a hypothesis; two agreeing is evidence. The cost gate exists because the first version of this loop happily "adopted" a 3× prompt for +8 points. |
| **4. Next** | Name the weakest question type still carrying headroom. | Guarantees the next candidate is aimed, not sprayed. |

Fixed guards, by construction: same **k**, same metric, same corpus for every
arm (raising k inflates recall for free and is not an improvement), and the
measurement drives `api.search` rather than a reimplementation of it.

```bash
node scripts/benchmark-loop.js                # full cycle
node scripts/benchmark-loop.js --quick        # smoke the loop itself
LOOP_CTX_BUDGET=3 node scripts/benchmark-loop.js   # show what the cost gate holds back
node scripts/benchmark-loop.js --selftest-drift    # corrupt the expectation on purpose
```

Exit codes are part of the contract and all three were exercised: **0** loop
completed · **1** no usable corpus (nothing can be measured, so nothing can be
claimed) · **2** published baseline no longer reproduced. The last one is
runnable on demand — a gate that has never been seen to fire is a claim, not a
check — and `--selftest-drift` corrupts the expected numbers so the run above
must come back `DRIFT` and exit 2. It does.

**Three cycles run 2026-10-06** — the baseline reproduced at 80% / 58.3% every
single time (phase 1 clean on all three):

| Candidate | LongMemEval | LoCoMo | Verdict |
|---|---|---|---|
| cap 2 / session | ±0 (−27% ctx) | −8.3 | REJECTED (regression) |
| cap 5 / session | −4 | ±0 | REJECTED (regression) |
| cap 1 / session | ±0 (−42% ctx) | −25 | REJECTED (regression) |
| parent-document expand | ±0 (+79% ctx) | ±0 (+182% ctx) | neutral |
| transcript fusion, `TXN=4` | +4 | −8.3 | REJECTED (regression) |
| fuse + cap 2 | +4 | −8.3 | REJECTED (regression) |
| **transcript fusion, `TXN=6…12`** | **+4…+8** | **±0** | **OVER BUDGET** — see [the frontier](#transcript-channel-fusion-2026-10-06--implemented-opt-in-only) |
| spread floor 5 | ±0 (±0 ctx) | ±0 | neutral — see below |
| spread floor 7 | **−8** | **−8.3** | REJECTED (regression) |
| coverage selection | ±0 (+6% ctx) | ±0 | neutral |
| coverage + spread 5 | ±0 | ±0 | neutral |

**Phase 4 output (round 3's brief):** `multi-hop` on LoCoMo smoke (**0%**,
0/3), `multi-session` on LongMemEval (**25%**, 1/4), `temporal` on LoCoMo
(**33.3%**, 1/3) — all multi-evidence questions, so round 3 tested *spreading
the k slots across conversations* two ways: `spreadAcrossSessions` (a floor on
how many distinct conversations the top-k spans) and `greedyCoverageSelect`
(pick the candidate covering the most still-uncovered query term, so each hop
or session earns its own slot).

### Round 3 verdict: the hypothesis was rejected, and the reason is upstream

Neither policy moved a single target question — `multi-session` stayed 25%,
`multi-hop` stayed 0%. [`scripts/spread-diagnose.js`](scripts/spread-diagnose.js)
explains why the points were never there to take:

| Question | Answer reachable in-corpus? | In FTS top-50? | Sessions holding evidence |
|---|---|---|---|
| LoCoMo `conv-26-q1` (multi-hop) | **no** | 0/50 | 0 |
| LoCoMo `conv-26-q5` (multi-hop) | **no** | 0/50 | 0 |
| LoCoMo `conv-26-q0` (multi-hop) | yes | **0/50** | **1** |
| LME `078150f1` (multi-session) | yes | 3/50 | **4** ✅ |
| LME `09ba9854` (multi-session) | yes | 1/50 | **3** ✅ |

Two of the three multi-hop questions have ground-truth wording that **appears
nowhere in the ingested store** — no retrieval policy, at any k, can return
evidence that was never written down. The third is reachable but sits in a
single session, so spreading slots across conversations cannot surface it
either. Only the two ✅ rows are structurally amenable, and neither flipped.

**What this rules out:** `spread`/`coverage` are *not* adopted. They remain
opt-in because they buy a guarantee rather than points — `spread floor 5` cuts
LongMemEval questions spanning fewer than 5 conversations from **6/30 → 0/30**
at exactly zero accuracy and zero context cost, which is a robustness property
(the same "one conversation fills every slot" failure as hardening defect #2),
not a benchmark win. `spread floor 7` is measured and rejected.

**The real brief for round 4:** the gap is ingestion/extraction, not ranking —
`reachable=NO` means the answer's wording never made it into a memory. That is
different work: extraction coverage at ingest time, or a judge that accepts
paraphrase.

## LongMemEval-S retrieval head-to-head (2026-10-06)

**Harness:** supermemoryai/memorybench `longmemeval` benchmark · **Dataset:**
`longmemeval_s_cleaned.json` (500 questions) · **Sample:** 5 per category × 6
categories = 30 · **Run ID:** `ac-lme-1` · **Metric:** same deterministic
hit@10 as the LoCoMo table (≥50% ground-truth word overlap).

| Provider | Recall@10 | Median context / question | % of haystack |
|---|---|---|---|
| agentic-cortex (hardened) | **80%** (20/25 scored) | 32,465 chars | 7% |
| filesystem@session | **92%** (23/25 scored) | 138,744 chars | 28% |
| filesystem@turn | **64%** (16/25 scored) | 21,037 chars | 4% |

*The denominator is the 25 **scorable** questions — see the
[metric fix](#metric-fix-2026-10-06-short-answers-were-auto-failed). The other 5
have answers word-overlap cannot judge (`"2"`, `"25"`), and counting them as
misses capped every provider at 21/30 no matter how good retrieval was.*

**By question type (recall@10):**

| Type | AC | FS@session | FS@turn |
|---|---|---|---|
| single-session-user | **100%** | 100% | 80% |
| single-session-assistant | **75%** | 75% | 50% |
| knowledge-update | **100%** | 100% | 100% |
| single-session-preference | **100%** | 100% | 100% |
| temporal-reasoning | 75% | **100%** | 50% |
| multi-session | 25% | **75%** | 0% |

**Reading this honestly:**

- **The filesystem baseline here is *raw-transcript*, not the harness's native
  one.** Its scoring algorithm (`tokenize` / `scoreDocument` / selection) is
  copied verbatim from `src/providers/filesystem/index.ts`, but its *documents*
  are raw session transcripts. The native `FilesystemProvider.ingest()` first
  LLM-condenses every session (`extractMemories`, `maxTokens: 2000`) and stores
  that instead — and no LLM API was available for extraction in this run. So
  `filesystem@session` carries more text per unit than the native provider
  would: **its 5× context cost is an upper bound, not a like-for-like
  measurement.** Recall may move either way under extraction too — condensed
  memories can preserve key facts (higher recall per char) or drop the verbatim
  phrasing word-overlap needs (lower recall).
- **FS@session's lead costs 4× the prompt.** It ranks *whole sessions*, so its
  top-10 is a median 138,744 chars — 28% of the median 492,759-char haystack.
  That is "return a quarter of the corpus" more than it is better retrieval.
  AC buys 80% for 7% of the haystack, and the gap is **12 pts**.
- **At a similar budget AC is clearly ahead.** FS@turn uses *less* context than
  AC (21,037 vs 32,465) and scores **16 pts worse** (64% vs 80%).
- **multi-session is the one place FS@session pulls away** (75% vs AC's 25%).
  These answers need evidence from several sessions, and AC's breadth cap only
  allows 3 fragments per conversation — the correct fix is to spend slots on
  *different* sessions, not to relax the cap (which is measured below and
  regresses the other corpus). FS@turn scores 0% here: at turn granularity the
  same answer is unreachable.
- **temporal-reasoning is AC's weakest gap** (75% vs FS@session's 100%). AC's
  FTS5 OR-ranking does not know which of several similar turns is the *latest*
  one; the temporal boost in `search()` is metadata-driven and does not close
  it. The transcript channel below *does* close it (→100%) but costs 2× context.
- **Embeddings were off** (keyword-only FTS5, the memory-safe default), and n
  = 30. Both gap and variance would move with `AGENTIC_CORTEX_EMBEDDINGS=1`.

### Hardening round (2026-10-06): what was actually wrong

The first pass reported 56.7%. Three defects were found in AC's own retrieval
path and fixed; each fix was measured on **both** corpora that still have
hermetic DBs before being adopted (`scripts/strategy-sweep.js` runs the sweep).

| # | Defect | Fix |
|---|---|---|
| 1 | FTS5 query was `split(' ')` + quote-every-token, so **stopwords entered an OR query**. FTS5's BM25 idf is *negative* for terms in most documents, so quoting `the`/`is`/`what` actively *subtracts* score; punctuation and duplicates were never cleaned. | `buildFtsQuery()` — alphanumerics only, lowercased, de-duplicated, stopwords dropped (falling back to them if the query is all stopwords), capped at 24 terms. |
| 2 | One long conversation could fill all 10 slots with near-duplicate turns (median **3 distinct sessions** per top-10). | `capPerSession()` / `opts.maxPerSession: 3` — breadth control, applied before the limit slice. |
| 3 | `diversifyResults()` split tokens on `/\\W+/` (a literal backslash), so every similarity came out 0 and MMR silently degenerated to plain relevance order. | Regex corrected to `/\W+/`; MMR now actually diversifies. |

**Measured effect of the full stack (same corpora, same metric, hydrated content
on both arms so the comparison is fair):**

| Corpus | Before | After | Δ | Median context |
|---|---|---|---|---|
| LongMemEval-S (n=30, 25 scorable) | 72% (18/25) | **80% (20/25)** | **+8** | 29,922 → 31,593 (+6%) |
| LoCoMo smoke (n=15, 12 scorable) | 41.7% (5/12) | **50% (6/12)** | **+8.3** | 6,017 → 6,983 (+16%) |

Per-type gains on LongMemEval: `single-session-preference` 80% → **100%** (now
level with FS@session) and `temporal-reasoning` 60% → **75%**.

> The pre-metric-fix version of this table read 56.7% → 63.3% and 33.3% →
> 40.0%. Those are the *same hits* over a denominator that counted 5
> unanswerable questions as misses; see the
> [metric fix](#metric-fix-2026-10-06-short-answers-were-auto-failed).

**Candidates measured and rejected** — this is the part that stops the sweep
from being a fitting exercise:

| Candidate | LongMemEval | LoCoMo | Verdict |
|---|---|---|---|
| strict dedupe (1 fragment/session) | **80% (+8)** | **25% (−16.7)** | **Rejected** — LoCoMo answers need several turns of the same conversation |
| parent-document expansion (whole transcript per hit) | 72% (±0) | 50% (+8.3) | Implemented as `expandToSessions()`, but *not* the default: 2× the context of `maxPerSession` for no gain on LongMemEval |
| query hygiene alone | 72% (±0) | 50% (+8.3) | Adopted (it is fix #1, and it never regresses) |
| MMR fix alone | 72% (±0) | 50% (+8.3) | Adopted (it is a latent bug fix; no regression observed) |
| transcript-channel fusion (see below) | **84% (+4)** | 50% (−8.3) | Implemented, **opt-in only** — the two corpora disagree on the sign |

**Honest read:** +8 pts on n=30 is **two flipped questions**, which on its own
is inside noise — the evidence is that *two independent corpora moved the same
direction* while a plausible alternative (strict dedupe) was caught regressing
16.7 points on the second. Temporal-reasoning is 25 pts behind FS@session,
`multi-session` is 50 pts behind it, and the 600-question LoCoMo DB
from the original run no longer exists on this machine, so the headline **63.0%
cannot be re-verified without a re-ingest** — the LoCoMo row above is unchanged.

Raw: [`data/runs/longmemeval-h2h/report.json`](data/runs/longmemeval-h2h/report.json)
(`contextCost` block carries the per-provider medians and ratios), sweep at
[`scripts/strategy-sweep.js`](scripts/strategy-sweep.js).

### Metric fix (2026-10-06): short answers were auto-failed

The scorer behind every deterministic number here lived in three scripts and
returned `false` whenever `groundTruth.length <= 3`. That guard was meant to
skip *unanswerable* rows — but LongMemEval's `multi-session` answers are
`"$12"`, `"$50"`, `"20%"`, `"2"`, so **nine of thirty questions were
unscoreable for every provider**, capping the metric at 21/30 no matter how
good retrieval was. It also hid the one place the filesystem baseline actually
beats AC.

- **Fix:** non-scorable questions are now *excluded from the denominator*
  instead of counted as misses, and the excluded count is reported so the
  reader can see raw hits and scored hits separately. The matcher, the
  scorbility rule and the tokenizer now live in one module,
  [`scripts/lib/bench-metric.js`](scripts/lib/bench-metric.js), so the three
  benchmark scripts cannot drift apart again.
- **Consequence for this document:** every deterministic row was recomputed
  under the fixed rule. LongMemEval AC **63.3% → 80%**, FS@session **66.7% →
  92%**, FS@turn **53.3% → 64%**; LoCoMo smoke **40% → 50%** *before* this
  round's fix. The 600-question LoCoMo headline (63.0 / 54.2) came from a
  different runner on a DB that no longer exists and was **not** recomputed —
  it still uses the old rule.
- **The gap widened rather than narrowed**: under the old denominator AC looked
  3.4 pts behind FS@session; correctly scored it is **12 pts** behind. The old
  number was flattery produced by a bug in our own scorer.

### Recall safety net (2026-10-06): a search could return nothing

`api.search` could return **zero rows for a question about data we hold**.
Reproduced with `"What is Caroline's relationship status?"`: every query term
scored `df = 0` in that project — the corpus says *relationships*, the question
says *relationship*; `Caroline's` tokenises to `caroline`, not `carolines`.
FTS5 does not stem, so the lexical channel returned an empty list, and nothing
downstream could recover it. One such question was the **entire** LoCoMo gap.

- **Fix:** when retrieval comes back short of `k`, `search()` fills the
  remaining slots from the second channel — whole-session transcripts ranked by
  IDF-weighted query coverage. Coverage is **substring**-based, so it degrades
  to "nearest conversation" where exact-token matching gives up.
- **Measured:** LoCoMo smoke **50% → 58.3%** (7/12, `single-hop` 66.7% → 100%)
  at median context 6,983 → 7,416 chars (**+6%**). LongMemEval unchanged at 80%
  with median 31,291 → 31,593. Two corpora, no regression, near-zero cost.
- **Not a benchmark-only trick:** an empty result set is wrong for any caller,
  which is why this runs unconditionally rather than behind an option. Covered
  by a regression test in
  [`tests/integration.test.js`](tests/integration.test.js).

### Transcript-channel fusion (2026-10-06) — implemented, **opt-in only**

AC stores every conversation twice: as whole-session transcripts *and* as
turn fragments. BM25's length normalisation buries the transcripts (observed
ranks **58 / 143 / 187** on LongMemEval — outside any candidate pool a
downstream reranker can see), while the fragments win by being short. Fusing a
coverage-ranked transcript channel with the lexical ranking via reciprocal rank
fusion lets each granularity vote.

| Config | LongMemEval | LoCoMo | Median context |
|---|---|---|---|
| shipped (safety net only) | 80% | **58.3%** | 31,593 / 7,416 |
| `fuseTranscripts` | **84%** | 50% | 66,457 / 14,924 |

**Search latency** (same 10 LongMemEval queries, warm, `api.search` end to
end): default path **19.9 ms** median / 31.9 ms max; with fusion **42.0 ms** /
77.0 ms. The channel costs one FTS count per query term plus a scan of ~40
transcripts, so it roughly doubles search latency while staying well under
100 ms — context, not CPU, is the reason it is opt-in.

**Why it is not the default: it is a context decision, not a correctness one.**
The channel has to admit enough transcripts before LoCoMo stops paying for it:
`maxTranscripts: 4` **regresses** LoCoMo (58.3% → 50%, `world-knowledge` 100%
→ 66.7%), while **6–12 holds LoCoMo at 58.3% and lifts LongMemEval to
84–88%**. The measured frontier (same shipped path, same metric):

| Config | LongMemEval | LoCoMo | LongMemEval median context |
|---|---|---|---|
| shipped (no fusion) | 80% | **58.3%** | 31,593 |
| `maxTranscripts: 6` | 84% | 58.3% | 86,511 (+173%) |
| `maxTranscripts: 8` | 84% | 58.3% | 91,889 (+191%) |
| `maxTranscripts: 10` | **88%** | 58.3% | 107,107 (+239%) |
| `maxTranscripts: 4` | 84% | **50% — regression** | 66,457 |

A coverage floor does not rescue it at any useful point: 0.7 keeps LoCoMo but
drops LongMemEval back to 80%, because the decisive transcript scores **0.63**.
`opts.temporalBoost` and `opts.expandSessions` were measured on the same
question and move nothing (both 80%).

So the last 8 points cost 3.4× the prompt. At the shipped setting AC is
**4.4× cheaper** than `filesystem@session` (31,593 vs 138,744); at
`maxTranscripts: 10` that advantage shrinks to **1.3×**. Shipping that is a
product choice about what goes in the prompt, so it is gated by the
[benchmark loop](#the-benchmark-loop) rather than defaulted: it ships as
`opts.fuseTranscripts` + `opts.maxTranscripts` + `opts.minCoverage`, **off** in
the benchmark adapter, and `LOOP_CTX_BUDGET=3 node scripts/benchmark-loop.js`
is the command that shows what the gate is holding back.

**Reproduce:**

```bash
AC_DB=/tmp/ac-mb-long.db RUN_DIR=.../data/runs/ac-lme-1 \
  FUSE=0 node scripts/measure-shipped.js   # 80%
AC_DB=/tmp/ac-mb-long.db RUN_DIR=.../data/runs/ac-lme-1 \
  FUSE=1 TXN=4 node scripts/measure-shipped.js   # 84%, 2x context
AC_DB=/tmp/ac-mb-smoke.db RUN_DIR=.../data/runs/ac-smoke1 \
  FUSE=0 node scripts/measure-shipped.js   # 58.3%
```

`measure-shipped.js` drives `api.search` itself — the same entry point the
adapter calls, with the same options — rather than a stand-in for it, and
hydrates full content by id (search → get).

## LoCoMo LLM-judged smoke (2026-10-05) — the only end-to-end answer-accuracy run

MemoryBench's full `ingest → search → answer → evaluate` pipeline against AC,
n = 15 (3 per category),
[`data/runs/locomo-judged-smoke/report.json`](data/runs/locomo-judged-smoke/report.json):

| Metric | Value |
|---|---|
| **Accuracy (judge)** | **40% (6/15)** — MemScore quality 40 |
| Retrieval hit@10 / MRR / nDCG | 46.7% / 0.297 / 0.352 |
| Precision@10 | 8.7% (10 hits per question, evidence is sparse) |
| Answer latency | median 404s — **local model**, not a cloud API |

By type: adversarial 3/3 · world-knowledge 2/3 · temporal 1/3 · multi-hop 0/3 ·
single-hop 0/3.

**Four caveats that make this number a floor, not a point estimate:**

1. **The judge was a local 9B model** (qwythos-9b via LM Studio), aliased as
   `gpt-4o` through `OPENAI_BASE_URL`. The report's `judge: "gpt-4o"` label is
   the harness's requested alias, **not** OpenAI's model. Do not compare this
   40% to Mem0's 92.5 or Zep's 90.2 — those are frontier-LLM-judged.
2. **It ran under the preview-truncation bug** above: the answerer saw 300-char
   previews. It also **predates the [hardening round](#hardening-round-2026-10-06-what-was-actually-wrong)**,
   so its retrieval phase (hit@10 46.7%, MRR 0.297) is the pre-fix ordering.
   Both defects push this number *down*; re-running it with a frontier judge is
   still the single missing experiment.
3. **3 of the 6 correct answers are `adversarial`** (unanswerable by design —
   the judge correctly said "I don't know"). Excluding them: **3/12 = 25%**.
4. **n = 15.** The 95% binomial interval on 6/15 spans roughly 16%–68%.

## Summary — 2×2 matrix (matched-granularity pairs in bold)

| Config | Units/question | Recall@10 |
|---|---|---|
| **filesystem@session** (MemoryBench algorithm, raw transcripts) | ~19 | **54.2%** |
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

- **The tables above are retrieval recall, not answer accuracy.** MemoryBench's
  `answer`/`evaluate` phases need an LLM API key. One judged run exists (the
  15-question smoke above) but its judge was a local 9B model, so **no number
  in this document is comparable to Mem0/Zep/Hindsight's published scores** —
  those are frontier-LLM-judged on the same benchmarks. A judged run on
  GPT-4o/Claude with the hydration fix is the single missing experiment.
- **Small samples.** 30 questions (LongMemEval) and 15 (judged LoCoMo) are
  smoke-scale. The 600-question LoCoMo matrix is the only run large enough to
  rank providers on.
- **Neither LoCoMo side used LLM extraction — deliberately.** The filesystem
  runner stores raw session transcripts scored by MemoryBench's own
  `scoreDocument()`; AC stores raw transcripts too. That holds *text seen*
  constant so the delta is attributable to retrieval, not to one side getting
  an LLM to pre-digest its notes. The trade: these numbers do **not** tell you
  how the harness's native LLM-extracting `FilesystemProvider` would score.
- **supermemory cloud: adapter ready, awaiting key.** The runner's supermemory
  path mirrors the harness provider (same SDK v4 calls, same search params);
  it needs `SUPERMEMORY_API_KEY` and was skipped cleanly with the full matrix
  reproduced bit-exact (`supermemory.ran=false`, `reason` recorded, planned
  sample documented in report.json). Mem0/Zep remain out of scope.
- **Keyword-only AC.** BGE embeddings were not enabled (memory-safe default;
  model not cached). Semantic categories may shift with
  `AGENTIC_CORTEX_EMBEDDINGS=1`.
- **hit@10 word-overlap is a blunt metric.** It rewards large units (more text
  in top-k) — hence the granularity finding, and hence FS@session's apparent
  LongMemEval win. Recall is only meaningful next to the context it cost, so
  `contextCost` is now part of the LongMemEval report. Per-unit precision/MRR
  would complement it; MemoryBench's LLM-judge path is the authoritative
  scorer.
- **multi-session questions are unmeasurable at k=10** with a ≥50% word-overlap
  threshold (all providers score 0). They need a judge or an evidence-set
  metric, not a bigger k.

## Reproduce

```bash
# 1. Clone MemoryBench and install (bun)
git clone https://github.com/supermemoryai/memorybench && cd memorybench
bun install

# 2. Copy the AC provider adapter from this repo
cp -r <ac-repo>/src/providers/ac src/providers/
# apply the 3 small patches: providers/index.ts registration,
# utils/config.ts provider case, lazy `serve` import (Bun-only web server)
# NOTE: keep src/providers/ac/index.ts in sync with this repo — its
# content-hydration step is load-bearing for every score above.

# 3. Run the real harness against AC (hermetic DB)
AGENTIC_CORTEX_DB=/tmp/ac-bench.db \
AGENTIC_CORTEX_PATH=<ac-repo> \
node ./node_modules/tsx/dist/cli.mjs src/index.ts ingest -p agentic-cortex -b locomo -r <runId>

# 4. Granularity-controlled head-to-head (no judge key needed)
cp <ac-repo>/scripts/memorybench-head-to-head.js .
AGENTIC_CORTEX_DB=/tmp/ac-bench.db node head-to-head.js

# 5. LongMemEval-S retrieval head-to-head (no LLM)
#    sample = 5/category (the harness's deterministic stratified sample)
AGENTIC_CORTEX_DB=/tmp/ac-lme.db \
AGENTIC_CORTEX_PATH=<ac-repo> \
node ./node_modules/tsx/dist/cli.mjs src/index.ts ingest -p agentic-cortex \
  -b longmemeval -s 5 -r ac-lme-1
#    score AC's stored top-10 against a filesystem re-run over the same
#    haystack — hydrate full content so previews never reach the metric:
cp <ac-repo>/scripts/longmemeval-h2h.js . \
  && AC_DB=/tmp/ac-lme.db MB_ROOT=$PWD node longmemeval-h2h.js

# 6. Built-in retrieval suite (hermetic, no network)
AGENTIC_CORTEX_DB=/tmp/ac-bench.db node <ac-repo>/cli.js benchmark recall

# 7. Retrieval-hardening sweep (which query/selection policy to ship)
#    Runs every candidate on BOTH corpora that have hermetic DBs, so a change
#    that only helps one benchmark cannot get adopted by accident.
AC_DB=/tmp/ac-lme.db MB_ROOT=$PWD node <ac-repo>/scripts/strategy-sweep.js

# 8. Re-run search only (no re-ingest) after changing retrieval:
#    set that question's phases.search.status to "pending" in the run's
#    checkpoint.json (leave phases.ingest alone), then:
AGENTIC_CORTEX_DB=/tmp/ac-lme.db AGENTIC_CORTEX_PATH=<ac-repo> \
  node ./node_modules/tsx/dist/cli.mjs src/index.ts search -r <runId>
```

The AC provider adapter resolves the agentic-cortex API via `AGENTIC_CORTEX_PATH`
(or pass `acApiPath` explicitly) and writes into a hermetic SQLite DB via
`AGENTIC_CORTEX_DB` — your real memory vault is never touched.
