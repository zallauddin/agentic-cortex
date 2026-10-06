# Lesson Persistence Design — Learning Across Machines Without Leaking

## Problem

Agents encounter problems and solve them in conversations, then the lessons die
with the session. AC fixes per-machine memory, but a single machine's vault:

- is lost on disk failure / reinstall,
- doesn't help your other machines,
- can't accumulate community-scale knowledge.

A shared repo (`zallauddin/agentic-cortex-memory`) was considered for storing
lessons and seeds — but naive pushing of raw vault contents would leak private
information: file paths, client names, API keys, business logic, project
structure. **Your instinct is correct — and AC already contains the machinery
to solve it properly.**

## Core principle: separate the three planes

| Plane | What it holds | Where it lives | Sync? |
|---|---|---|---|
| **Private vault** | Full memories with paths, names, context | Local SQLite | Never leaves machine |
| **Lesson layer** | Generalized, sanitized lessons | Local markdown, git-tracked per user | User-controlled sync |
| **Seed layer** | Anonymous, project-agnostic patterns | `agentic-cortex-memory` repo | Shared intentionally |

The mistake to avoid is treating the repo as a *dump target*. It must be a
**distillation target**: only lessons that have been generalized (private
details stripped and replaced with structural descriptions) ever reach it.

## The pipeline (4 stages, all already built or trivially wired)

### Stage 1 — Capture (fixed this session)
Agents follow the `<lesson_capture>` protocol in discovery files:
immediate `memory_save` for each problem→fix, mandatory session-end sweep,
or `agentic-cortex ingest --file transcript` for bulk extraction.

### Stage 2 — Distill (locally, before anything leaves the machine)
New command: `agentic-cortex distill [--since 7d] [--project PATH]`

Takes `learning`/`error`/`failure` observations and produces **lesson
records**:
- strips file paths → `"the MCP schema module"`,
- strips machine/user names, URLs, credentials (reuse the seed-sanitizer's
  `HARD_BLOCK_PATTERNS` + `REDACTION_RULES` — it already fail-closes),
- generalizes: "write_file requires instructions param" survives because the
  *pattern* (tool schema validation) is the lesson, not the specifics,
- assigns a **generality score**: project-specific lessons stay in the private
  vault (marked `scope: project`); machine-level lessons are eligible for
  seeds (`scope: machine`); universal lessons are seed candidates
  (`scope: universal`).

Lesson records are stored as markdown files under `lessons/` in a
user-owned git repo (one file per lesson, YAML frontmatter: id, type,
scope, confidence, sources, created_at). Human-inspectable, diffable,
portable — the durable truth layer YOINK-style.

### Stage 3 — Promote (user-in-the-loop, not silent)
- `scope: universal` lessons queue for seed candidacy.
- `agentic-cortex seed-review` shows the queue with the sanitized content
  side-by-side with the source memory, so the user approves *exactly* what
  would be shared.
- Nothing is pushed without explicit approval. The lesson record carries a
  `sanitized: true` flag and a `sanitization-report` (what was redacted and
  why) so review is fast.
- The existing `memory_promote_global` path stays for machine-local
  cross-project promotion (no network involved).

### Stage 4 — Publish (seeds only, to the shared repo)
- `agentic-cortex seed-push` (after review) writes approved lessons to a
  local clone of `agentic-cortex-memory` as **seeds**: the exact
  `memory_import` format AC already accepts, sanitized and anonymized.
- Other machines/users run `agentic-cortex seed-pull` + `memory_import` to
  gain the lessons. AC's provenance, confidence, and calibration systems
  then grade imported seeds like any other memory — so bad community seeds
  decay naturally instead of polluting vaults (calibration loop from v7.5.0).
- Seeds carry `origin: community` and a source-machine pseudonymous hash,
  never identifying data.

## Why this is privacy-safe by construction

1. **Default is local.** Stages 1–2 happen entirely on-machine; nothing
   syncs unless the user builds the pipeline out.
2. **Sanitizer is fail-closed** (regression-tested in
   `tests/capability-absence.test.js`): credentials are hard-blocked, secrets
   redacted, over-redacted content is rejected rather than shipped.
3. **Human review gates sharing.** The seed-review step means a human sees
   the exact bytes before they leave the machine.
4. **Generalization over redaction.** Rather than blacking out details
   (which leaks structure), lessons are rewritten at the pattern level.
5. **Community seeds are second-class by default** — lower initial
   confidence, graded by local calibration, archived if unhelpful. A poisoned
   or noisy seed can't outrank earned experience.

## Recommendation on `zallauddin/agentic-cortex-memory`

Keep the repo, but define it strictly as the **seed exchange**, not a vault
backup:

- `seeds/*.json` — approved, sanitized, importable seed files
- `LESSONS.md` — curated index of high-value lessons (human-readable)
- `schema.md` — seed format contract (mirrors `memory_import` input)
- No raw vault exports, no private-scope lessons, ever.

Do **not** use it as a sync target for raw exports. The markdown lesson layer
(user-owned repo, any private remote) is the durable per-user backup; the
seeds repo is the intentional, reviewed, community layer.

## Scale: 1 → 100,000 machines (federated hub-and-spoke)

At fleet scale, neither a single central dump nor pure P2P works. The model
that fits is **tiered federation with pull-based, signed, graded seeds**:

| Tier | What | Storage |
|---|---|---|
| 0 — Local | Raw vault, private, never leaves machine | SQLite + markdown lessons |
| 1 — Org/team (optional) | Org-specific lessons behind the org's own remote | Private git/registry mirror |
| 2 — Global seed registry | Reviewed, signed, generalized lessons only | Central repo → CDN |

Rules that make it safe and powerful at any fleet size:

1. **Pull, never push.** Machines fetch seeds; nothing writes to them. The
   registry can't leak what it never receives.
2. **Signed, content-addressed artifacts.** Each seed = JSON with a stable
   content hash + publisher signature; tampering is detectable, duplicates
   dedupe naturally.
3. **Quorum promotion.** A lesson reaches Tier 2 only after N independent
   machines report it helpful via calibration feedback (Brier-weighted), and
   decays if consumers grade it wrong. Poisoned seeds starve instead of spread.
4. **Canary rollout.** New seeds serve to a small percentage of fleet first,
   expand only if consumer grades stay positive — deployments discipline
   applied to knowledge.
5. **Aggregate telemetry only.** Consumers report `(seed_hash, grade,
   pseudonymous-machine-hash)` counts; no content, no identity. The registry
   learns *which lessons work*, never *who hit which problem*.
6. **Org tiers mirror npm scopes.** Company-specific lessons live in Tier 1
   mirrors; universal lessons graduate to Tier 2 — same artifact format.

### Phased action plan

- **Phase 0 (now):** distill locally; `lessons/` markdown layer; seed-review
  gate. No network. — *highest leverage, zero risk*
- **Phase 1:** Tier 2 as a git repo with signed commits + `seed-pull`/import
  + consumer calibration grading. Works at 1–1,000 machines.
- **Phase 2:** registry service (API: publish/review/fetch/stats), org
  mirrors, semantic dedup at ingest. 1,000–10,000 machines.
- **Phase 3:** telemetry loop → quorum promotion + reputation + canary
  rollout. 10,000+ machines.
- **Phase 4:** CDN/mirrors for the artifact blobs; registry stays
  metadata-only. Effectively unbounded.

## Immediate next steps

1. Implement `distill` (Stage 2) — highest leverage; works offline.
2. Wire the lesson markdown layer into `lessons/` with per-user git.
3. Build `seed-review` (Stage 3) reusing the seed sanitizer's report.
4. Define the seed schema and push the first batch of sanitized lessons
   from this machine's vault (it already has 1,113 `failure` and 650
   `success` observations to distill from).
