# AC offline capability matrix

AC now has an explicit offline-first execution path. It does not call an LLM when using `offlinePlan`, `offlineApplyChanges`, `offlineRunCheck`, or `offlineExecute`.

| Area | Fully offline | Boundary |
|---|---:|---|
| Memory/search | Yes | SQLite FTS5, filters, deterministic ranking, and coverage probes |
| Repository inspection | Yes | Git status/diff, package scripts, static graph and symbol index |
| Dependency analysis | Yes | Existing graph/import closure; no semantic interpretation of unknown code |
| Research collection | Yes | Local indexed files and deterministic extraction; web access remains an external tool concern |
| Research interpretation | No | Needs explicit rules, a skill, human input, or optional LLM |
| Deterministic reasoning | Yes | Rules, FSM, workflows, evidence aggregation, and six deterministic reasoner modes |
| Constrained coding | Yes | Explicit, unique old-text → new-text replacements within the project root |
| Novel arbitrary coding | No | Offline mode refuses to invent code; provide a template, codemod, or registered skill |
| Tests/typecheck/lint | Yes | Runs declared package scripts and captures stdout/stderr/exit status |
| Semantic verification | Conditional | Fully offline when represented by tests/rules; otherwise requires human/LLM review |

## Offline coding workflow

1. `memory_offline_capabilities()` reports the available boundary.
2. `memory_offline_plan({ task, project })` inspects the repository and selects deterministic checks.
3. `memory_offline_execute({ task, project, changes })` applies only explicit replacements where `oldText` occurs exactly once.
4. Each changed file receives a sibling `.offline-backup` before modification.
5. Project checks run with captured output; the workflow reports `completed` or `failed_verification`.

A change has the shape:

```json
{
  "file": "src/example.js",
  "oldText": "const oldValue = 1;",
  "newText": "const oldValue = 2;"
}
```

Ambiguous, missing, malformed, or out-of-root edits are skipped rather than guessed. This is intentional: offline AC can execute bounded work safely, but it must not pretend to possess a general code-generation capability it does not have.
