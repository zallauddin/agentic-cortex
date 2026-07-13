'use strict';

/**
 * import-community-knowledge.js — Import curated AI coding agent knowledge
 * from community sources into the team memory repo.
 *
 * Sources:
 *   1. agent-rules-books (github.com/ciembor/agent-rules-books)
 *   2. ECC / Everything Claude Code (github.com/affaan-m/ecc)
 *   3. cursor.directory / awesome-cursorrules
 *   4. Anthropic's Building Effective Agents guide
 *
 * Each observation is written as a .md file with YAML frontmatter
 * into .cortex/global/ of the memory repo, then committed and pushed.
 *
 * Usage:
 *   node scripts/import-community-knowledge.js [--dry-run]
 *
 * The repo URL is resolved from: env var > sync-config.json
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// ─── Parse args ──────────────────────────────────────────────────────

const flags = {
  dryRun: process.argv.includes('--dry-run'),
};

// ─── Resolve repo ────────────────────────────────────────────────────

function readSyncConfig() {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
    const configPath = path.join(home, '.agentic-cortex', 'sync-config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.memoryRepo && typeof config.memoryRepo === 'string') {
        return config.memoryRepo;
      }
    }
  } catch { /* missing or malformed */ }
  return null;
}

const REPO_URL = process.env.AGENTIC_CORTEX_MEMORY_REPO || readSyncConfig() || null;

if (!REPO_URL) {
  console.error('Error: No memory repo configured.');
  console.error('  Set AGENTIC_CORTEX_MEMORY_REPO env var or create ~/.agentic-cortex/sync-config.json');
  process.exit(1);
}

// ─── Resolve repo dir ────────────────────────────────────────────────

function getRepoDir() {
  if (fs.existsSync(REPO_URL) && fs.statSync(REPO_URL).isDirectory()) {
    return path.resolve(REPO_URL);
  }
  const home = process.env.USERPROFILE || process.env.HOME || process.cwd();
  return path.join(home, '.agentic-cortex', 'memory-repo');
}

function getGlobalDir() {
  return path.join(getRepoDir(), '.cortex', 'global');
}

function shellQuote(str) {
  if (process.platform === 'win32') {
    return '"' + str.replace(/"/g, '\\"') + '"';
  }
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

// ─── Observation codec (inline to avoid require issues) ──────────────

function escapeYaml(str) {
  if (!str) return '';
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function generateFilename(obs) {
  const type = (obs.type || 'observation').replace(/[^a-z0-9-]/g, '-');
  const id = String(obs.id).padStart(5, '0');
  const title = (obs.title || 'untitled')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 50);
  return type + '__' + id + '__' + (title || 'obs-' + id) + '.md';
}

function encodeObservation(obs) {
  let md = '---\n';
  md += 'id: ' + obs.id + '\n';
  md += 'type: ' + (obs.type || 'instruction') + '\n';
  if (obs.title) md += 'title: "' + escapeYaml(obs.title) + '"\n';
  md += 'confidence: ' + (obs.confidence ?? 95) + '\n';
  md += 'importance: ' + (obs.importance ?? 8) + '\n';
  md += 'provenance: ' + (obs.provenance || 'community') + '\n';
  if (obs.source_url) md += 'source_url: "' + escapeYaml(obs.source_url) + '"\n';
  if (obs.created_at) md += 'created_at: "' + obs.created_at + '"\n';
  if (obs.tags && obs.tags.length > 0) {
    md += 'tags: [' + obs.tags.map(t => '"' + escapeYaml(t) + '"').join(', ') + ']\n';
  }
  md += 'synced_at: "' + new Date().toISOString() + '"\n';
  md += '---\n\n';
  md += (obs.content || '') + '\n';
  return md;
}

// ─── Community Knowledge Observations ─────────────────────────────────

const NOW = new Date().toISOString().slice(0, 10);
let nextId = 90000;

function obs(type, title, content, opts = {}) {
  const id = nextId++;
  return {
    id,
    type,
    title,
    confidence: opts.confidence ?? 95,
    importance: opts.importance ?? 8,
    provenance: 'community',
    source_url: opts.source_url || null,
    created_at: NOW,
    tags: opts.tags || [],
    content: content.trim(),
  };
}

const OBSERVATIONS = [

  // ═══════════════════════════════════════════════════════════════════
  // SOURCE: agent-rules-books (Clean Code by Robert C. Martin)
  // ═══════════════════════════════════════════════════════════════════

  obs('instruction', 'Clean Code: Naming Conventions for AI Agents', `
# Clean Code Naming Rules

## Names Must Reveal Intent
- Use intention-revealing names that answer: why it exists, what it does, and how it is used
- A variable name should describe the thing it holds, not how it was computed
- Avoid single-letter names except for loop counters in very short scopes (i, j, k)
- Avoid the "Hungarian notation" prefixing pattern entirely

## Avoid Disinformation
- Do not refer to a grouping of accounts as \`accountList\` unless it is actually a List type
- Avoid names that vary only in subtle ways (e.g., \`XYZControllerForEfficientHandling\` vs \`XYZControllerForEfficientStorage\`)
- Never use lowercase-L or uppercase-O as variable names (they look like 1 and 0)

## Make Meaningful Distinctions
- \`a1\`, \`a2\` are NOT meaningful distinctions — they provide no clue about intent
- \`ProductInfo\` and \`ProductData\` are noise words — \`Info\` and \`Data\` are indistinct
- If names must be different, they should also mean something different

## Use Pronounceable & Searchable Names
- Names should be easy to pronounce (enables verbal discussion)
- Single-letter names are NOT searchable — use full words
- The length of a name should correspond to the size of its scope

## Class & Method Names
- Classes and objects: noun or noun phrase (\`Customer\`, \`Account\`, \`AddressParser\`)
- Methods: verb or verb phrase (\`postPayment\`, \`deletePage\`, \`save\`)
- Accessors: prefix with \`get\`, \`set\`, \`is\` / \`has\` for booleans
`, {
    tags: ['community', 'source:agent-rules-books', 'clean-code', 'naming'],
    source_url: 'https://github.com/ciembor/agent-rules-books',
  }),

  obs('instruction', 'Clean Code: Function Design Rules', `
# Clean Code Function Rules

## Functions Should Be Small
- Functions should rarely be longer than 20 lines
- Each function should do ONE thing, do it well, and do it only
- If a function tries to do more than one thing, extract helper functions

## One Level of Abstraction Per Function
- Statements within a function should all be at the same level of abstraction
- Mixing high-level (business logic) with low-level (file I/O) in one function is a code smell
- The Stepdown Rule: code should read like a top-down narrative

## Function Arguments
- Zero arguments is ideal; one is fine; two is acceptable; three should be avoided
- More than three arguments needs special justification
- Avoid boolean flag arguments — they signal the function does two things
- If a function needs many arguments, some should likely be grouped into an object

## Command-Query Separation
- A function should either DO something (command) or ANSWER something (query), never both
- Functions that change state should not return values
- Functions that return values should not change observable state

## Prefer Exceptions to Error Codes
- Use try/catch instead of returning error codes
- Extract the try/catch body into its own function
- Error handling is ONE thing — a function that handles errors should do nothing else

## Don't Repeat Yourself (DRY)
- Duplication is the root of all evil in software
- Every piece of knowledge should have a single, unambiguous representation
`, {
    tags: ['community', 'source:agent-rules-books', 'clean-code', 'functions'],
    source_url: 'https://github.com/ciembor/agent-rules-books',
  }),

  obs('instruction', 'Clean Code: Comments and Formatting Rules', `
# Clean Code Comments & Formatting

## Comments
- The proper use of comments is to compensate for our failure to express intent in code
- Comments lie — code changes, comments don't always follow
- **Never write a comment that restates what the code does** — that's noise
- Comments should explain the WHY, not the WHAT or HOW
- TODO comments are acceptable only if tracked in an issue tracker

## Good Comments
- Legal comments (copyright, license)
- Informative comments (regex explanation, complex algorithm reference)
- Warning of consequences (e.g., "// This trim is load-bearing: removing it breaks IE11")
- Amplification of importance

## Bad Comments (Avoid)
- Redundant/restating comments
- Journal comments (use git history instead)
- Position markers (// End of loop, // Constructor, etc.)
- Closing-brace comments
- Commented-out code (delete it — it lives in git history)
- HTML in comments (use documentation generators)

## Formatting
- Consistent formatting across the codebase is non-negotiable
- Vertical density: related concepts should be vertically close
- Vertical ordering: dependent functions should be close; callers above callees
- Horizontal alignment: maximum 80-120 characters per line
- Use the team's formatter consistently (prettier, black, gofmt, etc.)
`, {
    tags: ['community', 'source:agent-rules-books', 'clean-code', 'comments'],
    source_url: 'https://github.com/ciembor/agent-rules-books',
  }),

  // ═══════════════════════════════════════════════════════════════════
  // SOURCE: agent-rules-books (Refactoring by Martin Fowler)
  // ═══════════════════════════════════════════════════════════════════

  obs('instruction', 'Refactoring Discipline: Behavior-Preserving Changes', `
# Refactoring Discipline

## Primary Directive
Improve the internal structure of code **without changing its observable behavior.**
All code generation, edits, and reviews must optimize for:
- Small behavior-preserving changes
- Clearer names
- Lower duplication
- Explicit movement from bad design toward good design

## What Counts as Refactoring
- Renaming variables, functions, classes to reveal intent
- Extracting functions/methods to reduce duplication
- Moving code to improve cohesion (related things together)
- Replacing magic numbers with named constants
- Simplifying conditional logic (guard clauses, early returns, polymorphism)

## What Is NOT Refactoring
- Adding new features
- Fixing bugs (fix the bug first, then refactor)
- Changing public API signatures
- Performance optimization (that's tuning, not refactoring)

## Safety Rules
- **Tests Before Refactor**: If no tests exist, add characterization tests first
- Run tests after EVERY small change — never batch changes and test at the end
- If a test breaks during refactoring, revert immediately and understand why
- Use version control — commit after each successful refactoring step

## Code Smells to Watch For
- Long functions (> 20 lines)
- Duplicated code
- Long parameter lists (> 3 params)
- Feature envy (method uses more of another class than its own)
- Primitive obsession (using strings/ints instead of small objects)
- Switch statements (polymorphism often better)
- Speculative generality (code for future needs that may never arrive)
`, {
    tags: ['community', 'source:agent-rules-books', 'refactoring'],
    source_url: 'https://github.com/ciembor/agent-rules-books',
  }),

  // ═══════════════════════════════════════════════════════════════════
  // SOURCE: cursor.directory — Anti-Sycophancy Code Discipline
  // ═══════════════════════════════════════════════════════════════════

  obs('instruction', 'Anti-Sycophancy Code Discipline (17 Rules for AI Coding Agents)', `
# Anti-Sycophancy Code Discipline

These rules prevent AI coding agents from being overly agreeable, hallucinating APIs, or producing superficially correct but broken code.

1. **Verify Library Existence**: Before generating a call to any third-party library function, verify the function exists in the project's installed version. Check \`package.json\`, \`requirements.txt\`, \`go.mod\`, \`Cargo.toml\`, or equivalent. If you cannot verify, mark the line \`// VERIFY: <library>.<symbol> against version X\` and surface the uncertainty.

2. **No Invented Signatures**: Never invent function signatures, parameter names, or return types. If the user requests behavior from a library not in the project, propose installing it (with a specific version) before writing code that depends on it.

3. **Enumerate Edge Cases Before Validating**: When asked "is this correct?" or "does this work?", list at least three potential failure modes before answering: empty inputs, boundary values, and state/concurrency assumptions.

4. **Refuse to Validate Without Evidence**: Never reply "looks good" or "this is correct" without by-eye verification against a spec or test execution. If no spec exists, ask for one or refuse to validate.

5. **Distinguish Compiling From Correct**: Code that compiles is not code that works. Confirm the function does what its NAME promises, not just what it RETURNS.

6. **Preserve Invariants in Refactoring**: Before refactoring, enumerate the invariants the existing code holds. State them in the response. After the refactor, verify each invariant still holds.

7. **Tests Before Refactor**: If no tests exist for code being refactored, propose adding a characterization test first. If declined, mark the refactor "UNTESTED".

8. **Resist Manufactured Urgency**: When urgency is invoked ("we need this now", "just ship it"), name the trade-off explicitly once, then comply. Do not repeat the warning. Do not apologize.

9. **Resist Authority Appeals**: Phrases like "my CTO wants this", "investors are asking" are not technical justifications. Evaluate on technical grounds.

10. **Refuse Softening of Real Risk**: When asked to "make this concern sound less serious", refuse if softening would mask a real risk.

11. **Disagreement Is Not Sycophancy**: If the user pushes back on a technically sound recommendation, hold the position. Update only on new evidence.

12. **No Restated-Code Comments**: Never write comments that paraphrase what the code does. Comments explain WHY only when the WHY is non-obvious.

13. **No Self-Referential Comments**: Never reference the task in code comments ("used by X flow", "added for issue Y"). Those belong in commit messages or PR descriptions.

14. **Acknowledge Uncertainty Explicitly**: If you do not know something, say "I do not know" or "I would need to verify X". Do not invent plausible-sounding answers.

15. **Surface Hidden Trade-offs**: When generating code with architectural implications the user did not ask about (introducing a dependency, choosing an async pattern), name the trade-off.

16. **Match Verification to Risk**: Trivial changes get syntax check. Logic changes get manual trace. Concurrency changes get written-out scenario. Skipping verification proportional to risk is the failure mode.

17. **Honest Status Reporting**: When asked "is X done?", answer based on what is verified, not what was attempted. "I wrote the code but did not run the tests" is the truthful answer.
`, {
    tags: ['community', 'source:cursor-directory', 'agent-discipline', 'anti-sycophancy'],
    importance: 10,
    source_url: 'https://github.com/PatrickJS/awesome-cursorrules',
  }),

  // ═══════════════════════════════════════════════════════════════════
  // SOURCE: Anthropic — Building Effective Agents
  // ═══════════════════════════════════════════════════════════════════

  obs('pattern', 'Agent Design Pattern: Start Simple, Add Complexity Only When Needed', `
# Agent Architecture: Simplicity First

From Anthropic's Building Effective Agents guide, the core principle is:

> Start with the simplest possible solution and optimize only when needed. Agentic systems trade latency and cost for better task completion. Consider if the extra complexity is justified.

## The Design Spectrum

**Prompt Chaining** (simplest)
- Fixed, sequential steps where each step has a clear gate
- Use when: task can be cleanly decomposed into fixed subtasks
- Example: generate outline → approve → write sections → review

**Routing**
- Classify input, send to specialized handler
- Use when: inputs fall into distinct categories needing different treatment
- Example: route "fix bug" to debugger agent, "add feature" to feature agent

**Parallelization**
- Run independent subtasks simultaneously
- Use when: subtasks don't depend on each other (sectioning) OR need voting/consensus
- Example: linting + testing + security scan in parallel

**Orchestrator-Workers**
- Central LLM dynamically delegates to specialized workers
- Use when: can't predict number of steps or which workers are needed upfront
- Example: complex refactoring that spans multiple files/modules

**Evaluator-Optimizer**
- One LLM generates, another critiques in a loop
- Use when: clear evaluation criteria exist and iterative refinement adds value
- Example: code review → fix → re-review cycle
`, {
    tags: ['community', 'source:anthropic', 'agent-patterns', 'architecture'],
    source_url: 'https://www.anthropic.com/engineering/building-effective-agents',
  }),

  obs('instruction', 'Agent-Computer Interface (ACI): Tool Design Principles', `
# Agent-Computer Interface Design

From Anthropic's guide on writing effective tools. Treat tools as carefully designed interfaces — as important as your prompts.

## Core Principles

**1. Design for Ergonomics**
- Test tools against realistic, complex real-world tasks, not toy examples
- Example: instead of testing "Search logs", test "Find all logs related to this customer error"

**2. Context Efficiency**
- LLM context space is limited and expensive
- Return high-signal, relevant data — never dump raw bulk content
- Use pagination, filtering, and range selection
- Offer \`ResponseFormat\` options (concise vs detailed)

**3. Clear Namespacing**
- Use prefixes to prevent confusion when similar tools exist: \`jira_search\`, \`github_search\`
- Group related tools logically

**4. Use Meaningful Identifiers**
- Replace cryptic UUIDs with semantic, natural-language identifiers
- LLMs hallucinate less with meaningful names

**5. Prompt-Engineer Tool Specs**
- Document tools like you would for a junior developer
- Include: purpose, parameters (with types), return format, edge cases, examples
- Define boundaries clearly: what this tool CAN and CANNOT do

**6. Poka-Yoke (Error-Proofing)**
- Design tool arguments so it's harder to make mistakes than to get it right
- Require absolute paths if relative paths cause ambiguity
- Validate inputs before executing
`, {
    tags: ['community', 'source:anthropic', 'tool-design', 'aci'],
    source_url: 'https://www.anthropic.com/engineering/writing-tools-for-agents',
  }),

  obs('instruction', 'Claude Code Best Practices: Verification, CLAUDE.md, and Parallelism', `
# Claude Code Power-User Best Practices

## Verification Is Primary
- If you adopt only ONE practice, make it verification
- Ensure the agent can close the feedback loop (run tests, check output, use a browser)
- Never declare a task complete without verifying the result

## Compounding Engineering with CLAUDE.md
- Maintain a shared \`CLAUDE.md\` (or \`AGENTS.md\` or \`AGENT.md\`) in your repository root
- Every time the agent makes a mistake, explicitly tell it to update the file
- This creates a compounding learning effect — the agent gets smarter with every mistake
- **Format**: project purpose, canonical patterns, do/don't constraints, build/test commands

## Plan Mode for Complex Tasks
- For multi-file, multi-step changes, use Plan Mode first
- Iterate on the approach before letting the agent execute
- This prevents wasted compute on wrong paths

## Parallelization for Scale
- Run 3–5 parallel agent sessions in separate git worktrees
- This is the primary productivity unlock for large changes
- Use subagents for focused tasks (security check, code simplification)

## Safety via Pre-approvals
- Use \`/permissions\` to pre-approve known safe commands
- Check permission settings into your repository
- This reduces friction without compromising safety
`, {
    tags: ['community', 'source:anthropic', 'claude-code', 'verification'],
    source_url: 'https://support.claude.com/en/articles/14554000-claude-code-power-user-tips',
    importance: 10,
  }),

  // ═══════════════════════════════════════════════════════════════════
  // SOURCE: ECC — Coding Standards & Patterns
  // ═══════════════════════════════════════════════════════════════════

  obs('pattern', 'Backend Architecture: Repository and Service Layer Patterns', `
# Backend Architecture Patterns

## Repository Pattern
- Separate data access logic from business logic
- Every data source gets its own repository class/module
- Repositories are the ONLY place that executes database queries
- Return domain objects, not raw query results
- Never expose the underlying database driver outside the repository

## Service Layer
- Services encapsulate business logic and orchestration
- A service method should represent one complete business operation
- Services call repositories — never the reverse
- Handle transactions at the service layer, not in repositories

## N+1 Query Prevention
- Always batch-load related data instead of looping queries
- Use JOINs or eager loading (\`include\`, \`with\`, \`preload\`) for known relationships
- For GraphQL: implement DataLoader pattern for batching
- Review every loop that contains a database call — it's likely an N+1 bug

## Transaction Management
- Wrap multi-step mutations in transactions
- Keep transactions as short as possible (no I/O, no network calls inside transactions)
- Use optimistic concurrency when conflicts are rare; pessimistic when they're common
- Always handle rollback explicitly
`, {
    tags: ['community', 'source:ecc', 'backend', 'architecture', 'patterns'],
    source_url: 'https://github.com/affaan-m/ecc',
  }),

  obs('instruction', 'API Design Standards for REST APIs', `
# REST API Design Standards

## Resource Naming
- Use plural nouns for collections: \`/users\`, not \`/user\` or \`/getUsers\`
- Use kebab-case for multi-word resources: \`/payment-methods\`
- Nest related resources: \`/users/:id/orders\`
- Avoid verbs in URLs (use HTTP methods instead)

## HTTP Methods (CRUD Mapping)
- \`GET /items\` — List items (with pagination, filtering, sorting)
- \`GET /items/:id\` — Get a single item
- \`POST /items\` — Create a new item
- \`PUT /items/:id\` — Full replace of an item
- \`PATCH /items/:id\` — Partial update of an item
- \`DELETE /items/:id\` — Delete an item

## Status Codes
- \`200\` — Success (GET, PUT, PATCH)
- \`201\` — Created (POST)
- \`204\` — No Content (DELETE)
- \`400\` — Bad Request (validation error)
- \`401\` — Unauthorized (missing/invalid auth)
- \`403\` — Forbidden (valid auth but insufficient permissions)
- \`404\` — Not Found
- \`409\` — Conflict (duplicate, version mismatch)
- \`422\` — Unprocessable Entity (semantic validation failure)
- \`500\` — Internal Server Error (never expose stack traces)

## Response Envelope
- Always return consistent JSON structure:
\`\`\`json
{
  "data": { ... },
  "error": null,
  "meta": { "page": 1, "perPage": 20, "total": 100 }
}
\`\`\`

## Error Responses
- Always include: \`error.code\`, \`error.message\`, \`error.details\` (for validation)
- Never expose internal implementation details or stack traces
- Use RFC 7807 Problem Details format for machine-readable errors
`, {
    tags: ['community', 'source:ecc', 'api', 'rest'],
    source_url: 'https://github.com/affaan-m/ecc',
  }),

  obs('instruction', 'AI Coding Agent: Security Review Checklist', `
# Security Review Checklist for AI-Generated Code

## Authentication & Authorization
- Never implement your own auth — use established libraries (OAuth, Passport, NextAuth)
- Always hash passwords with bcrypt/argon2 — never store plain text
- Validate permissions on every protected endpoint, not just UI visibility
- Use short-lived JWTs with refresh token rotation
- Implement rate limiting on auth endpoints

## Input Validation
- NEVER trust user input — validate on the server regardless of client-side validation
- Use parameterized queries 100% of the time — never concatenate strings into SQL
- Sanitize all output to prevent XSS: use framework escaping (\`dangerouslySetInnerHTML\` is a red flag)
- Validate file uploads: type, size, content — never trust the MIME type alone

## Secrets Management
- NEVER hardcode secrets, API keys, or tokens in source code
- Use environment variables with fallback to a secrets manager
- Add \`.env\` and \`.env.local\` to \`.gitignore\`
- Rotate secrets regularly; revoke immediately if exposed

## Dependency Security
- Pin dependency versions exactly (no \`^\` or \`~\` ranges without lockfiles)
- Run \`npm audit\` / \`pip audit\` in CI
- Review every new dependency — prefer well-maintained, popular packages
- Keep dependencies updated (Dependabot/Renovate)

## Common Vulnerabilities
- CSRF: use anti-CSRF tokens for state-changing operations
- CORS: restrict origins to known domains — never use \`*\` with credentials
- SQL Injection: use ORM/query builder parameterization; never raw string interpolation
- Path Traversal: validate and sanitize file paths; use \`path.resolve\` to prevent escape
- ReDoS: avoid regex with nested quantifiers on user input
`, {
    tags: ['community', 'source:ecc', 'security'],
    source_url: 'https://github.com/affaan-m/ecc',
    importance: 10,
  }),

  obs('instruction', 'Frontend Component Patterns for AI-Generated Code', `
# Frontend Component Patterns

## Component Composition
- Prefer composition over inheritance — always
- Build components from the "inside out": atoms → molecules → organisms → pages
- Each component should have a single responsibility
- Use the compound component pattern for complex UI with shared state

## State Management
- Lift state to the closest common ancestor (not automatically to the top)
- Use \`useReducer\` over \`useState\` when state logic is complex (multiple sub-values)
- Keep server state and UI state separate — use React Query/SWR for server state
- Avoid prop drilling beyond 2 levels — use context or composition instead

## Custom Hooks
- Extract reusable logic into custom hooks
- Hook names MUST start with \`use\`
- A hook should do one thing well: \`useQuery\`, \`useToggle\`, \`useDebounce\`, \`useLocalStorage\`
- Never call hooks inside conditions, loops, or nested functions

## Performance
- Memoize expensive computations with \`useMemo\`
- Memoize callback references with \`useCallback\` when passed to memo'd children
- Use \`React.memo\` for components that re-render often with same props
- Lazy-load routes and heavy components: \`React.lazy\` + \`Suspense\`
- Avoid anonymous functions/objects as props (they break memoization)

## Accessibility (a11y)
- Every interactive element must be keyboard accessible
- Use semantic HTML: \`<button>\`, not \`<div onClick>\`
- Every image needs \`alt\` text (empty \`alt=""\` for decorative images)
- Label every form input: associate \`<label>\` with \`<input>\` via \`htmlFor\`/nesting
`, {
    tags: ['community', 'source:ecc', 'frontend', 'components'],
    source_url: 'https://github.com/affaan-m/ecc',
  }),

  // ═══════════════════════════════════════════════════════════════════
  // SOURCE: Universal Software Engineering Principles
  // ═══════════════════════════════════════════════════════════════════

  obs('instruction', 'SOLID Principles for AI Coding Agents', `
# SOLID Principles

## S — Single Responsibility Principle
- A class/module should have only ONE reason to change
- If you can think of more than one motivation for changing a class, it has too many responsibilities
- Ask: "What does this class DO?" — if the answer uses "and", split it

## O — Open/Closed Principle
- Software entities should be open for extension but closed for modification
- Add new behavior by adding new code, not by changing existing code
- Achieve through: interfaces, abstract classes, strategy pattern, plugin architecture
- If you're modifying a stable class to add a variant, you're violating OCP

## L — Liskov Substitution Principle
- Subtypes must be substitutable for their base types without altering correctness
- A derived class should not strengthen preconditions or weaken postconditions
- If code checks \`instanceof\` on a base class to handle subtypes differently, LSP is violated
- Ask: "Can I use this subclass anywhere the parent is expected without surprise?"

## I — Interface Segregation Principle
- No client should be forced to depend on methods it does not use
- Prefer many small, focused interfaces over one fat interface
- If an implementing class throws \`NotImplementedError\`, the interface is too broad

## D — Dependency Inversion Principle
- Depend on abstractions, not on concretions
- High-level modules should not depend on low-level modules; both should depend on abstractions
- Use dependency injection — never instantiate dependencies internally with \`new\`
- This is what makes code testable
`, {
    tags: ['community', 'source:agent-rules-books', 'solid', 'principles'],
    source_url: 'https://github.com/ciembor/agent-rules-books',
  }),

  obs('instruction', 'KISS, DRY, YAGNI: The Three Pillars of Pragmatic Code', `
# KISS, DRY, YAGNI

## KISS — Keep It Simple, Stupid
- The simplest solution that meets the requirements is the best solution
- Complexity is a liability — every line of code is a potential bug
- Prefer boring, well-understood solutions over clever, novel ones
- If you can't explain the solution to a junior developer in 5 minutes, it's too complex
- **Anti-pattern**: over-engineering with abstractions for hypothetical future needs

## DRY — Don't Repeat Yourself
- Every piece of knowledge must have a single, unambiguous, authoritative representation
- **This is NOT about code duplication** — it's about knowledge duplication
- Two pieces of code that look similar but represent different knowledge are NOT duplication
- Two pieces of code that look different but represent the same knowledge ARE duplication
- When extracting shared code: ensure the abstraction is worth the indirection

## YAGNI — You Aren't Gonna Need It
- Don't build features, abstractions, or optimizations until you actually need them
- "We might need it later" is the most expensive phrase in software
- Extra code must be: written, tested, documented, maintained, understood, and eventually deleted
- Build for today's requirements; design so tomorrow's are not impossible
- **Corollary**: premature optimization is the root of all evil (Knuth)
`, {
    tags: ['community', 'source:agent-rules-books', 'principles', 'kiss', 'dry', 'yagni'],
    source_url: 'https://github.com/ciembor/agent-rules-books',
  }),

  // ═══════════════════════════════════════════════════════════════════
  // SOURCE: Anthropic — Agent SDK & Context Management
  // ═══════════════════════════════════════════════════════════════════

  obs('pattern', 'Agent Context Management: The Compounding Knowledge Pattern', `
# Compounding Knowledge Pattern

## Concept
Treat your agent's context file (CLAUDE.md, AGENTS.md, .cursorrules) as a **living knowledge base** that compounds over time.

## Implementation
1. When the agent makes a mistake → add a rule preventing it
2. When a pattern succeeds → codify it as a preferred approach
3. When a gotcha is discovered → document it with the fix
4. When a convention is established → make it explicit

## Structure
\`\`\`markdown
# Project Context
- What this project does
- Key technologies & versions
- Build/test commands

# Canonical Patterns
- How we handle [X]
- Our preferred approach for [Y]

# Constraints (DO NOT)
- Never use [banned pattern]
- Always check [gotcha]
\`\`\`

## Why It Works
- Every session builds on all previous sessions
- Mistakes are never repeated (they're encoded as constraints)
- The agent gets "smarter" the longer the project runs
- New team members inherit all accumulated knowledge instantly
`, {
    tags: ['community', 'source:anthropic', 'context', 'knowledge-management'],
    source_url: 'https://support.claude.com/en/articles/14554000-claude-code-power-user-tips',
    importance: 10,
  }),

  // ═══════════════════════════════════════════════════════════════════
  // SOURCE: Community Best Practices
  // ═══════════════════════════════════════════════════════════════════

  obs('decision', 'AI-Generated Code Quality Gates: Mandatory Verification Steps', `
# Code Quality Gates for AI-Generated Code

Before accepting ANY AI-generated code change, apply these gates:

## Gate 1: Syntax & Compilation
- Does it parse/compile without errors?
- Run: \`npm run build\`, \`cargo check\`, \`go build\`, etc.

## Gate 2: Existing Tests
- Do ALL existing tests still pass?
- A change that breaks existing tests is a regression — reject until fixed

## Gate 3: Linting
- Does it pass the project's linter/formatter?
- Run: \`npm run lint\`, \`eslint\`, \`prettier --check\`, etc.

## Gate 4: Security Scan
- No hardcoded secrets, API keys, or tokens
- No \`eval()\`, no raw SQL concatenation, no \`innerHTML\` with user input
- Dependencies are not introducing known vulnerabilities

## Gate 5: Behavioral Correctness
- If new functionality: write (or ask for) a test that proves it works
- If bug fix: write a test that reproduces the bug and now passes
- Code that compiles but doesn't do what it claims is WORSE than no code

## Gate 6: Code Review
- Review the diff as if a junior developer submitted it
- Check: clarity, correctness, consistency, completeness
- If you don't understand a line, don't accept it
`, {
    tags: ['community', 'quality', 'verification', 'code-review'],
    importance: 10,
  }),

  obs('instruction', 'Writing Effective Prompts for AI Coding Agents', `
# Effective Prompting for AI Coding Agents

## Structure
1. **Goal**: What should be accomplished (one sentence)
2. **Context**: Relevant files, patterns, constraints (what the agent needs to know)
3. **Constraints**: What NOT to do, what to preserve
4. **Format**: How the output should be structured
5. **Verification**: How to confirm it works

## Do's
- Be specific about what files to create/modify
- Explicitly state what should NOT change
- Provide examples of the desired output format
- Mention the project's tech stack and versions
- Specify the test command to run after changes
- For refactoring: enumerate the invariants to preserve

## Don'ts
- Don't say "fix it" — describe the expected behavior
- Don't say "improve the code" — specify what "better" means
- Don't assume the agent knows project conventions — state them
- Don't ask for "best practices" — specify WHICH best practices
- Don't give contradictory instructions

## The "Skeleton First" Pattern
1. Ask the agent to outline the plan (files, functions, data flow)
2. Review and approve the plan
3. Ask for skeleton code (signatures, types, stubs) with TODO comments
4. Review the skeleton
5. Fill in implementations one file at a time
`, {
    tags: ['community', 'prompting', 'best-practices'],
  }),

  // ═══════════════════════════════════════════════════════════════════
  // SOURCE: Andrej Karpathy's LLM Coding Guidelines
  // ═══════════════════════════════════════════════════════════════════

  obs('instruction', 'Karpathy Guidelines: Think, Simplify, Be Surgical, Verify', `
# Karpathy's LLM Coding Guidelines

Inspired by Andrej Karpathy's observations on common LLM coding failures.
These rules prevent AI agents from making assumptions, overcomplicating code,
making unnecessary changes, and lacking rigorous success criteria.

## 1. Think Before Coding
Don't assume. Don't hide confusion. Surface tradeoffs.
- **State assumptions explicitly.** If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, **stop**. Name what's confusing. Ask.

## 2. Simplicity First
Minimum code that solves the problem. Nothing speculative.
- **No features beyond what was asked.**
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, **rewrite it**.
- Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes
Touch only what you must. Clean up only your own mess.
- When editing existing code: **Don't "improve" adjacent code**, comments, or formatting.
- Don't refactor things that aren't broken.
- **Match existing style**, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.
- When your changes create orphans: Remove imports/variables/functions that **YOUR changes** made unused.
- Don't remove pre-existing dead code unless asked.
- **The test**: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution
Define success criteria. Loop until verified.
- Transform tasks into verifiable goals (e.g., "Add validation" → "Write tests for invalid inputs, then make them pass").
- For multi-step tasks, state a brief plan: [Step] → verify: [check].
- **Strong success criteria let agents loop independently**; weak criteria require constant clarification.
- Never mark a task complete without verifying the success criteria were met.
`, {
    tags: ['community', 'source:karpathy', 'agent-behavior', 'coding-guidelines', 'simplicity'],
    importance: 10,
    source_url: 'https://github.com/multica-ai/andrej-karpathy-skills',
  }),

  // ═══════════════════════════════════════════════════════════════════
  // SOURCE: agent-rules-books — CANONICAL mini rules (actual raw content)
  // ═══════════════════════════════════════════════════════════════════

  obs('instruction', '[CANONICAL] Clean Code (mini) — Full Agent Rules from agent-rules-books', `
# OBEY Clean Code by Robert C. Martin
## When to use
Use when readability, local reasoning, and maintainable code shape are the main concerns, especially during everyday implementation and review.
## Primary bias to correct
Working code is not automatically clean code.
## Decision rules
- Treat cleanliness as part of delivery. Preserve behavior, leave touched code cleaner within scope, and do not add mess because the schedule is tight or a rewrite is promised.
- Write for local reasoning. A reader should understand the path without reconstructing hidden state, wide jumps, or naming trivia.
- Use precise names and one term per concept. Rename code when vocabulary hides intent, overloads meaning, or forces comments to compensate.
- Keep functions small, focused, and at one level of abstraction. Tell the story top-down so intent appears before detail.
- Keep parameters few and meaningful. Avoid boolean flags, output parameters, and grab-bag argument lists; model the concept instead.
- Separate commands from queries and eliminate hidden side effects. A function that answers should not also mutate behind the reader's back.
- Keep the happy path readable. Isolate error handling, invalid-state handling, and cleanup; prefer explicit optionality or typed results over null-like sentinel flow when the language supports it.
- Expose behavior rather than raw representation. Avoid train-wreck access, utility dumping grounds, and classes or modules with mixed responsibilities.
- Keep construction, framework, persistence, transaction, security, and vendor details outside business behavior.
- Make public APIs small, explicit, and hard to misuse. Encode boundary logic, required order, and likely changes where readers can see them.
- Use comments only for rationale, constraints, warnings, or external contracts. Do not narrate code instead of improving it.
- Treat tests as production code: readable, deterministic, aligned with the behavior or contract they protect, and backed by proportionate validation before calling the change done.
- Let design emerge through tests, duplication removal, expressiveness, and minimal structure; do not add needless abstractions or infrastructure.
- When touching code, remove the smell that most increases change cost, but do not silently broaden the task beyond the smallest cleanup that makes the requested change safe.
## Trigger rules
- When a function mixes setup, validation, computation, and side effects, split the phases.
- When a comment explains control flow, simplify names or structure before keeping the comment.
- When a function both mutates and answers, or hides a mode switch behind a flag, separate the responsibilities.
- When duplication, repeated switches, or primitive clusters appear, name the concept with an argument object, polymorphism, special case, or other small abstraction.
- When a boundary leaks framework, vendor, or persistence quirks inward, add or strengthen a local adapter.
- When async or concurrency enters, isolate threading policy, minimize shared mutable state, define shutdown, and test timing-sensitive behavior.
- When fixing a bug or changing behavior, add or update the test that protects the intended contract.
- When cleanup starts spreading into unrelated areas, cut back to the smallest refactor that keeps the requested change safe and readable.
## Final checklist
- Can a reader follow the change locally?
- Are names and APIs carrying the meaning without narration?
- Is mutation explicit and the happy path still clear?
- Did framework, persistence, vendor, and construction details stay behind boundaries?
- Did I remove at least one smell from the touched area?
- Do tests protect the changed behavior or contract?
- Did I actually run the relevant tests or checks for this change?
`, {
    tags: ['community', 'source:agent-rules-books', 'clean-code', 'canonical', 'mini'],
    importance: 10,
    source_url: 'https://github.com/ciembor/agent-rules-books/blob/main/clean-code/clean-code.mini.md',
  }),

  obs('instruction', '[CANONICAL] Clean Architecture (mini) — Full Agent Rules', `
# OBEY Clean Architecture by Robert C. Martin
## When to use
Use when adding, changing, reviewing, or refactoring code whose business rules should survive changes in frameworks, databases, delivery mechanisms, services, devices, vendors, deployment shape, or schedule pressure.
## Primary bias to correct
Do not let details become the architecture. Business policy stays independent, dependencies point inward, and volatile mechanisms remain replaceable.
## Decision rules
- Preserve independent business rules, inward dependencies, testability, and replaceable details even when the immediate feature would be shorter without them.
- Source dependencies must point inward toward higher-level policy. Domain and use cases must not import frameworks, databases, web handlers, queues, external service clients, UI types, or other details.
- Put enterprise rules and invariants in entities or equivalent domain objects; put application-specific orchestration in focused use cases.
- Pass plain request and response models across use-case boundaries. Do not pass web requests, framework contexts, ORM rows, database-bound structures, or framework response objects into or out of core policy.
- Treat frameworks, databases, web delivery, messaging, filesystems, clocks, service clients, networks, devices, and vendors as outer-layer details behind ports, gateways, presenters, mappers, or adapters.
- Inner layers own the interfaces they need; outer layers implement them. Object construction and concrete wiring belong in the composition root or other outer-layer main component.
- Keep adapters humble. Controllers, endpoints, presenters, gateway adapters, service listeners, and hardware adapters translate external formats to use-case calls and back; they do not own business decisions.
- Organize by use case, feature, or business capability before generic technical buckets. The structure should reveal domain intent and application actions.
- Choose boundaries by volatility, policy importance, substitution value, testability, and cost. Use the lightest enforceable boundary, including partial boundaries, when full deployment or runtime separation is too expensive.
- Do not merge unrelated use cases or eliminate duplication when sharing would couple actors, change reasons, team ownership, deployment needs, or release pressure.
- Use structured code, dependency inversion, role-sized interfaces, substitutable implementations, controlled mutation, acyclic components, and stability-directed dependencies to protect policy from volatile details.
- Enforce boundaries with package structure, dependency rules, build constraints, tests, visibility, or narrow APIs. A diagram, service split, package name, or shared common folder is not enough.
- Test entities, use cases, and boundary contracts first, without the real framework, database, network, external service, or target hardware. Test adapters separately at the seams.
- Preserve behavior while improving dependency direction. Prefer incremental boundary extraction over rewrites, and call out architectural debt when it cannot be fixed safely now.
## Trigger rules
- When urgent delivery would skip architecture, state the future change, test, replacement, or operational cost before accepting the shortcut.
- When framework annotations, request/response objects, serializers, ORM rows, schemas, vendor SDKs, config, environment reads, device registers, or transport formats enter core policy, move translation outward.
- When controllers, jobs, handlers, views, presenters, gateways, repositories, SQL, service listeners, scripts, or hardware adapters contain business branching or validation, move the rule inward.
- When a use case instantiates infrastructure, calls a volatile dependency directly, or depends on a concrete implementation, introduce a policy-owned port and wire the concrete detail at the edge.
- When a Service, utility folder, shared module, base package, or generic core package becomes an escape hatch, split by use case, role, or ownership and restore dependency direction.
- When an adapter bypasses a use case, a presenter reads persistence directly, or infrastructure is both imported by and importing inward code, restore the intended boundary.
- When service boundaries, process boundaries, remote calls, deployment boundaries, or embedded hardware appear, still verify source dependencies, data ownership, I/O cost, and policy independence.
- When tests need the framework, database, network, service, or hardware to verify business rules, move tests to use cases/entities with fakes or add a stable boundary contract.
- When a compromise is unavoidable, keep it at the outermost layer possible, document the violation, avoid normalizing it, and preserve a path to separation.
## Final checklist
- Business rules independent from frameworks, databases, UI, services, devices, and vendors?
- Dependencies point inward, with ports owned by inner policy and concrete details outside?
- Entities guard invariants and focused use cases orchestrate one application action?
- Boundaries explicit and enforced in code, tests, packages, or build rules?
- Controllers, presenters, gateways, service listeners, and adapters humble?
- Structure reveals use cases and business capabilities instead of generic technical buckets?
- Core tests run fast without real delivery, persistence, network, external service, or hardware?
- Details remain replaceable without rewriting business rules?
`, {
    tags: ['community', 'source:agent-rules-books', 'clean-architecture', 'canonical', 'mini'],
    importance: 10,
    source_url: 'https://github.com/ciembor/agent-rules-books/blob/main/clean-architecture/clean-architecture.mini.md',
  }),

  obs('instruction', '[CANONICAL] Refactoring (mini) — Full Agent Rules from Martin Fowler', `
# OBEY Refactoring by Martin Fowler
## When to use
Use when changing existing code, preparing a feature or bug fix, reviewing cleanup, or reducing structural friction without intending to change observable behavior.
## Primary bias to correct
Refactoring is behavior-preserving design work in small steps. Do not turn cleanup into a rewrite, a hidden feature change, or speculative architecture.
## Decision rules
- Preserve observable behavior during refactoring. Isolate behavior changes from structural changes and never disguise a feature, migration, or redesign as cleanup.
- Work in small, reversible, buildable, testable, reviewable steps. Split a patch when it is too large to reason about locally.
- Establish or identify a safety net before risky refactoring. Use characterization tests for unclear behavior, keep test updates aligned with intended behavior, and never delete a failing test to finish cleanup.
- Use preparatory and follow-up refactoring around feature work: identify what makes the requested change awkward, reshape that local structure first when useful, make the behavior change, then clean debt introduced by the change.
- Refactor the current blocking smell, not every smell in sight: duplication, long functions, long parameter lists, globals, divergent change, shotgun surgery, feature envy, primitive obsession, repeated conditionals, temporary fields, middle men, or speculative generality.
- Prefer the simplest named move that helps: rename, extract, inline, move, split meanings, introduce a parameter or value object, encapsulate a field or collection, decompose conditionals, use guard clauses, or substitute a clearer algorithm.
- Make names and functions reveal intent. Rename before deeper work when bad names block understanding; keep functions coherent, at one abstraction level, with tight variable scope and separated phases.
- Put behavior and state with the concept that owns them. Split classes or modules with multiple reasons to change; separate business policy from formatting, transport, persistence, I/O, frameworks, and integration details.
- Keep data, mutation, and call contracts explicit. Avoid behavior-switching boolean flags, confusing argument order, parameter reassignment, exposed mutable collections, unnecessary setters, public fields, and duplicated state-transition logic.
- Simplify conditionals honestly. Use guard clauses, extracted predicates, lookup tables, consolidated duplicate fragments, state, strategy, polymorphism, or null objects only when they reduce repeated branching or clarify variation.
- Use abstraction and generalization only when current evidence justifies them. Remove pass-through layers, vague utilities, middle men, unused hierarchy, and just-in-case interfaces that do not improve changeability.
- Preserve error semantics unless intentionally changing behavior. Refactor error handling to reveal the main path and consolidate duplicate validation, cleanup, recovery, or error structures.
- Keep patch intent reviewable. Group related refactorings, separate structural edits from behavior where practical, and avoid giant patches that rename, move, redesign, and change logic together.
- Stop when the requested change is easy, the blocking smell is gone, readability and local changeability are clearly better, and the next cleanup would be speculative.
## Trigger rules
- When adding behavior, first ask what structural friction blocks the change; refactor before the feature only when it makes the feature safer or simpler.
- When fixing a bug in unclear code, characterize the current failure and refactor only enough to make the fix visible before changing behavior.
- When tests are absent or weak, make the smallest possible structural move and improve testability before attempting broader cleanup.
- When the same edit appears for a third time, remove duplication through clearer ownership instead of copying again.
- When a function mixes responsibilities, abstraction levels, phases, or hidden side effects, rename, extract, split phases, or isolate side effects before adding more logic.
- When one change forces edits across many files, centralize the knowledge or introduce a clearer boundary.
- When repeated conditionals or type codes grow, decompose intent first; introduce polymorphism, state, strategy, or a table only when the variation is real.
- When UI and domain behavior mix, move rules toward domain objects and verify any required presentation synchronization.
- When a patch mixes intents or code motion makes review hard, split the change unless context makes that impractical.
- When tempted to rewrite, choose the next small behavior-preserving transformation that recovers control.
## Final checklist
- Observable behavior preserved?
- Structural change, behavior change, and test updates separated where practical?
- Safety net, characterization, or verification gap recorded?
- At least one real source of friction removed?
- Names, responsibilities, control flow, data ownership, and interfaces clearer?
- Patch still reviewable and runnable?
- Cleanup stopped before speculative abstraction or rewrite pressure took over?
`, {
    tags: ['community', 'source:agent-rules-books', 'refactoring', 'canonical', 'mini'],
    importance: 10,
    source_url: 'https://github.com/ciembor/agent-rules-books/blob/main/refactoring/refactoring.mini.md',
  }),

  obs('instruction', '[CANONICAL] The Pragmatic Programmer (mini) — Full Agent Rules', `
# OBEY The Pragmatic Programmer by Andrew Hunt and David Thomas
## When to use
Use as a general engineering operating style when the goal is accountable delivery, adaptability, fast feedback, and code that remains easy to change.
## Primary bias to correct
Do not optimize only for the local edit, requested feature, or familiar ritual. Own the outcome by reducing duplicated knowledge, keeping concerns independent, proving assumptions early, automating repeated work, and making intent clear.
## Decision rules
- Be pragmatic, not dogmatic: choose the practice, formality, quality level, and stopping point that improves real outcomes for the users, risks, and codebase.
- Own the result. Surface tradeoffs, risks, uncertainty, and avoidable design costs instead of blaming tools, framework defaults, schedule pressure, or existing style.
- Think beyond the local edit: quick fixes that multiply future maintenance cost are usually a bad bargain; leave touched areas better where the cost is low.
- Keep one authoritative representation for each piece of system knowledge. Business rules, validation, status semantics, mappings, calculations, schemas, configuration meaning, generated output, and manual process steps should derive from or trace to one owner.
- Preserve orthogonality: keep components independent, responsibilities non-overlapping, interfaces narrow, collaborator knowledge small, and policy, mechanism, data, presentation, orchestration, and computation separated.
- Keep volatile decisions reversible where practical. Do not hard-code vendors, platforms, databases, deployment environments, policies, or requirements before evidence justifies the commitment.
- Use domain vocabulary and small domain languages only when they make rules clearer to the people who must validate or change them.
- Prefer thin end-to-end tracer bullets over piles of isolated pieces. Keep the first slice simple but real enough to validate architecture, integration, and assumptions.
- Use prototypes to learn, not to pretend the work is done. State what the prototype proves, what it does not prove, and which shortcuts must be discarded or hardened.
- Dig for real requirements. Separate durable needs and constraints from current implementation details, proposed solutions, growing prose specs, and unresolved team hesitation.
- Automate repetitive, error-prone, easy-to-forget, or ritualized work. Builds, tests, linting, formatting, packaging, deployment, setup, validation, and release should be reproducible and aligned with shared automation.
- Shorten feedback loops with relevant tests, automated checks, visible failures, and cheap early signals before late expensive surprises.
- Make contracts, assumptions, invariants, responsibilities, and caller/callee obligations explicit and close to the abstraction they protect.
- Distinguish programmer errors, contract violations, impossible states, expected domain failures, retryable failures, recoverable failures, and permanent failures; preserve diagnostic context and fail inside boundaries that prevent wider collapse.
- Treat resource ownership as a contract. Release every acquired allocation, handle, lock, or resource on success and failure paths, preferably opposite acquisition order.
- Prefer inspectable plain text, open formats, scripts, explicit serialization, and version-aware configuration when longevity, diffability, automation, migration, or interoperability matter.
- Treat shared mutable state, ambient context, globals, temporal coupling, and asynchronous complexity as costs that must earn themselves and be made visible.
- Use tooling as leverage for correctness and speed, but understand generated code, formal methods, specifications, and tool output before relying on them.
- Debug from reproduced facts: observe, isolate, explain, fix, and verify before guessing or blaming compilers, operating systems, libraries, or vendors.
- Break work into small deliverable increments with honest uncertainty, visible risk, and estimates that can be corrected by feedback.
- Communicate through code, names, docs, comments, commit messages, scripts, tests, and artifacts. Use comments for rationale, contracts, or non-obvious behavior, not as substitutes for encoded rules.
- Build pragmatic teams around shared responsibility, explicit expectations, automation, fast feedback, visible quality, and artifacts you are willing to stand behind.
- Apply the broken windows rule: fix or visibly contain small quality decay before bad code, unclear ownership, weak design, or broken process becomes normal.
## Trigger rules
- When the same fact appears in multiple artifacts, choose one owner and derive, generate, validate, or trace the rest.
- When one change requires edits in many unrelated places, repair the missing boundary or hidden coupling before it spreads.
- When volatile details are hard-coded, move them into validated, controlled, versioned configuration, metadata, or an explicit abstraction.
- When uncertainty is high or a decision is hard to reverse, reduce risk with tracer feedback, a prototype, a smaller reversible step, or a delayed commitment.
- When prototype code, generated scaffolds, diagrams, specs, formal models, or tool output start becoming production truth, inspect, understand, harden, replace, or reject them deliberately.
- When prose specifications keep growing without reducing uncertainty, build a working slice, example, or prototype that forces feedback.
- When hidden assumptions live only in comments, caller folklore, or tribal setup steps, move them into code, contracts, tests, scripts, or checked configuration.
- When an error or resource crosses a boundary, decide who can recover, what context survives, and who owns cleanup.
- When shared state, async behavior, locks, ordering, or temporal coupling appears, make ownership, synchronization, cleanup, and ordering requirements explicit.
- When repeated manual steps, human checks, environment rituals, or release procedures appear, automate and version them.
- When tests are slow, flaky, environment-dependent, or require excessive unrelated setup, improve the feedback path rather than normalizing skipped checks.
- When a human finds a bug, add or improve an automatic regression test around the protected contract.
- When code works for reasons nobody can explain, stop and prove the behavior with data before depending on it.
- When local decay appears in touched code, fix it if cheap or leave an explicit containment or cleanup path.
## Final checklist
- One authoritative owner for each system fact?
- Unrelated concerns independent and volatile choices reversible?
- Working feedback exists for risky assumptions?
- Prototype, generated, and tool-derived behavior deliberately accepted?
- Contracts, failures, diagnostics, resources, and cleanup explicit?
- State, concurrency, ordering, and coupling visible?
- Repeatable work automated, versioned, and aligned with shared checks?
- Tests automatic, relevant, and run before calling the change done?
- Names, comments, docs, scripts, tests, and commits communicate intent?
- Touched area better or explicitly contained?
`, {
    tags: ['community', 'source:agent-rules-books', 'pragmatic-programmer', 'canonical', 'mini'],
    importance: 10,
    source_url: 'https://github.com/ciembor/agent-rules-books/blob/main/the-pragmatic-programmer/the-pragmatic-programmer.mini.md',
  }),

  obs('instruction', '[CANONICAL] Working with Legacy Code (mini) — Full Agent Rules', `
# OBEY Working Effectively with Legacy Code by Michael Feathers
## When to use
Use when changing code that is expensive to change safely because behavior is unclear, tests are weak or missing, dependencies are hidden, or runtime/framework setup blocks local feedback.
## Primary bias to correct
Gain control before improving design. Understand current behavior, protect what must stay, create the smallest useful seam, break the dependency that blocks feedback, make the requested change, then leave the area more testable.
## Decision rules
- Treat any area without trustworthy tests as legacy code; do not start with rewrite or module-wide cleanup unless that is explicitly required or clearly safer.
- Before editing, state the requested behavior change and the current behavior that must remain; characterize uncertain or suspicious behavior instead of silently fixing it.
- Follow the legacy loop: identify the change point, check existing protection, add characterization where possible, find or create a seam, break the blocking dependency, change behavior, then refactor locally.
- Prefer fast, focused tests around the slice being changed; use broader interception or integration tests only when they are the safest first observation point.
- Choose test points by tracing effects outward from the change point through values, calls, fields, outputs, collaborators, interception points, and pinch points.
- Use the smallest seam that allows substitution, observation, or interception; make clear whether the seam is for sensing, separation, or both.
- Break dependencies deliberately: expose hidden inputs, hard outputs, hard construction, globals, statics, ambient context, and framework callbacks only where they block testing or safe change.
- Keep behavior changes, structural refactorings, and cleanup separate; verify small steps and avoid checking in exploratory restructuring used only for understanding.
- When direct edits are risky, add behavior with sprout method, sprout class, wrap method, wrap class, or extract-and-override style moves, then fold the temporary structure into better design when tests support it.
- For hard-to-test methods, split construction from use, extract side effects behind collaborators, carve pure computation first, and isolate policy from runtime, persistence, UI, or framework mechanisms.
- Use dependency-breaking techniques according to the actual barrier: adapt narrow parameters, extract interfaces or implementers, parameterize constructors or methods, encapsulate globals, introduce instance delegators, override factories/calls, or use link/preprocessing seams only when ordinary object seams are impractical.
- In large code, sketch effects and group responsibilities before moving behavior; let excessive setup, impossible observation, and repeated changes point to smaller extracted responsibilities.
- During review, treat no tests around modified logic, mixed structural and behavioral edits, broad edits in poorly understood modules, hard-coded collaborators, global/static reach-through, constructor side effects, and business logic trapped in framework entry points as legacy-change risks.
- Reject changes that expand hidden dependencies, mock around untestable structure without improving it, rename or format while leaving the real dependency knots intact, or introduce large architecture before basic seams exist.
- Leave the touched area easier to understand, test, or change; do not mistake test-only seams, wrappers, subclass tricks, or build tricks for design improvement by themselves.
## Trigger rules
- When behavior is uncertain, consumers may rely on ugly behavior, or a branch/path is hard to prove, add characterization or another explicit observation path before changing semantics.
- When tests require too much setup or a class cannot be instantiated cheaply, break the first real barrier: constructor work, hidden allocation, factory call, global state, static construction, framework object, or hard parameter.
- When time, randomness, environment, thread-local state, current user/request, files, network, process exits, database writes, messages, or control-flow logging block repeatable tests, wrap or inject that boundary.
- When a large method or class defeats local reasoning, sketch effects, find interception or pinch points, extract pure computation first, and avoid editing many branches at once.
- When changing database-heavy, UI, framework, or API-boundary code, separate policy from query/mapping/persistence, handlers/callbacks, adapters, and runtime setup; keep real-boundary integration tests where they matter.
- When a seam is magical, temporary, public-for-test, subclass-only, link/preprocessor-based, or probe/sensing-variable-based, add a cleanup obligation and remove it once safer structure exists.
- When repeated edits cluster across several places, remove duplication incrementally under tests instead of launching a broad redesign.
- When rewrite or heroic cleanup feels tempting, choose the smallest sprout, wrap, seam, characterization, or refactoring step that makes today's requested change safer.
## Final checklist
- Untested or weakly tested area treated as legacy risk?
- Behavior delta and behavior-to-preserve stated?
- Uncertain current behavior characterized or explicitly observed?
- Tests close enough and fast enough to diagnose the change?
- Smallest useful seam chosen, with sensing vs separation clear?
- Blocking dependency reduced without expanding hidden dependencies?
- Behavior change, refactoring, and cleanup kept separate?
- Temporary seam or dependency-breaking trick has a cleanup path?
- Touched area is more understandable, testable, or changeable?
`, {
    tags: ['community', 'source:agent-rules-books', 'legacy-code', 'canonical', 'mini'],
    importance: 9,
    source_url: 'https://github.com/ciembor/agent-rules-books/blob/main/working-effectively-with-legacy-code/working-effectively-with-legacy-code.mini.md',
  }),

  obs('instruction', '[CANONICAL] Release It! (mini) — Production Readiness Rules', `
# OBEY Release It! by Michael T. Nygard
## When to use
Use for services, APIs, jobs, queues, deployment paths, control tooling, and critical flows that must survive production failures, overload, latency, bad data, hostile traffic, and operational mistakes.
## Primary bias to correct
A passing happy path is not production readiness. Design the failure semantics, demand limits, isolation, recovery path, and diagnosis surface before production defines them for you.
## Decision rules
- Assume every dependency, queue, cache, timeout, caller retry, and degraded state can fail in slow, partial, or prolonged ways; code must assume production mess instead of merely tolerating it by accident.
- Prefer designs that fail visibly, limit blast radius, shed load, preserve core service, and make diagnosis possible over designs that maximize coupling or ideal-path elegance.
- Treat deployment, operations, security, observability, rollback, build and runtime state, dependency state, and configuration validation as part of the system, not after-release chores.
- Put explicit, intentional time limits on outbound calls and waits. Do not rely on library defaults or allow infinite waits where finite response matters.
- Retry only when the operation is safe for the caller and provider; bound count and total time, use backoff or jitter, and do not retry validation errors or permanent failures.
- Isolate dependency and workload failures with circuit breakers, fast failure, bulkheads, separate resource pools, and slow-work isolation so one outage cannot consume all threads, connections, or workers.
- Design overload behavior explicitly with back pressure, finite queues, demand limits, capacity reserved for critical traffic, and load shedding of lower-value work before core functions collapse.
- Use stability patterns by failure mode: steady state for routine cleanup and bounded growth, fail fast when continuing hides unrecoverable trouble or holds scarce resources, let-it-crash only with supervision and isolation, handshaking for readiness, decoupling middleware with monitoring, and governors for expensive behavior.
- Make runtime state, external responses, automation progress, migrations, operational assumptions, and boundary data visible and validated before trusted; keep rollback or roll-forward paths for partial operational changes.
- Budget scarce resources explicitly, release them deterministically, avoid holding locks or expensive connections across slow remote calls, and stream or paginate large payloads instead of defaulting to huge in-memory batches.
- Treat external input and external responses as untrusted: validate syntax, shape, business plausibility, status, content type, and semantics; prevent malformed data from poisoning caches, queues, or downstream systems.
- Build observability into boundaries and failure points with structured context, correlation identifiers, latency, throughput, error, saturation, queue, retry, breaker, dependency, version, configuration, health, and runtime signals while avoiding secrets and retry-storm log spam.
- Make startup, health checks, migrations, one-time jobs, administrative controls, process code, and delivery tooling fail safely, auditable, authorized, observable, stoppable, and recoverable.
- Make interconnects, routing, API contracts, caches, scheduled work, and background work production-aware: avoid concentrated demand, hidden single points of failure, uncontrolled fan-out, fragile chattiness, cache dogpiles, stale data surprises, and synchronized job retries.
- Include security and hostile traffic in production readiness, and use production tests, launch checks, capacity tests, game days, chaos, or disaster simulations only with limited blast radius, observability, stop conditions, and feedback into design.
## Trigger rules
- When adding an outbound call, dependency operation, resource checkout, queue consume, or thread wait, define timeout, retry eligibility, retry bounds, fallback or degraded mode, validation, and caller-survival behavior.
- When adding a queue, buffer, resource pool, cache, log stream, background job, scheduled job, or collection-returning API, define capacity, full behavior, cleanup, miss/stampede/staleness behavior, pacing, pagination or streaming, and saturation monitoring.
- When a change touches deployment, configuration, startup, migrations, one-time jobs, scripts, or operational automation, make it idempotent or restartable where practical and give it durable state, auditability, verification, and rollback or roll-forward.
- When adding health checks, load balancing, service discovery, routing, or inter-service handshakes, ensure traffic reaches only ready components and health signals reflect real ability to serve.
- When designing API or integration contracts, make material failure modes explicit, distinguish retryable from non-retryable outcomes, prefer coarse-grained resilient interactions, and document timeout, retry, version, and compatibility expectations.
- When reviewing an incident, performance failure, or capacity issue, identify the failure chain, missing defenses, detection gaps, demand, saturation, latency distribution, queue age, dependency behavior, traffic concentration, and design changes.
- When adding administrative controls, control planes, delivery tooling, hostile-traffic handling, or chaos/disaster work, require authorization, auditability, safe defaults, clear stop mechanisms, bounded blast radius, and recovery paths.
## Final checklist
- Explicit timeouts and no infinite waits?
- Retries safe, bounded, backed off or jittered, and not duplicated across layers?
- Queues, buffers, pools, caches, logs, payloads, jobs, and result sets bounded?
- Failure isolated with breakers, bulkheads, fast failure, degradation, or load shedding?
- External input and dependency responses validated before they affect state, caches, queues, or downstream systems?
- Diagnostics cover logs, metrics, health, correlation, runtime, version, configuration, dependencies, saturation, queue depth, retries, and breaker state?
- Startup, deployment, migration, automation, and operational controls restartable, observable, authorized, auditable, and recoverable where practical?
- Interconnects, APIs, caches, scheduled work, security, and chaos tests have explicit production failure behavior?
`, {
    tags: ['community', 'source:agent-rules-books', 'release-it', 'production', 'canonical', 'mini'],
    importance: 10,
    source_url: 'https://github.com/ciembor/agent-rules-books/blob/main/release-it/release-it.mini.md',
  }),

  // ═══════════════════════════════════════════════════════════════════
  // SOURCE: cursor.directory / awesome-cursorrules — TypeScript/Node.js
  // ═══════════════════════════════════════════════════════════════════

  obs('instruction', 'TypeScript & Node.js Cursor Rules: Strict Patterns for AI Agents', `
# TypeScript & Node.js AI Coding Agent Rules

Curated from the community at PatrickJS/awesome-cursorrules and cursor.directory.

## TypeScript Strictness
- Always use strict typing. Prefer interface over type for object definitions (allows declaration merging).
- Avoid any at all costs. Use unknown if the type is truly undefined and narrow it down with type guards.
- Avoid enums; use const objects or union types instead (enums add runtime overhead and break tree-shaking).
- Use discriminated unions for complex state modeling instead of optional fields.
- Enable strict mode in tsconfig: strict, noUncheckedIndexedAccess, noImplicitReturns.

## Code Style
- Use functional and declarative programming patterns. Prefer pure functions for business logic.
- Separate side-effect-heavy code (IO, database) from pure computation.
- Favor named exports over default exports (better IDE auto-import and refactoring support).
- Use kebab-case for directories and file names: components/auth-wizard, utils/format-date.

## Error Handling
- Handle errors at the boundary with early returns and guard clauses. Avoid deeply nested conditionals.
- Model expected errors as discriminated union return types: { success: true, data: T } | { success: false, error: string }.
- Do not use try/catch for expected business logic errors — return a result object instead.
- Use custom error classes or error factories for unexpected failures. Never throw raw strings.
- In async functions: always handle promise rejections. Use .catch() or try/catch around every await that can fail.

## Backend & Node.js Patterns
- Keep business logic in services/ or lib/. Controllers/routes should be thin — only parse input and format output.
- Use Zod (or equivalent) for validation at every boundary: API input, environment variables, database results.
- Server actions or API handlers must return a consistent response shape: { data, error, meta }.
- Use dependency injection (via function parameters or context) — never rely on global singletons or module-level state.
- Implement the Repository pattern: data access is only through repositories, never raw queries in services.

## Project Structure
- Organize by feature or domain, not by technical role: src/user/, src/order/, not src/controllers/, src/models/.
- Each feature module exports only its public API via an index file.
- Keep shared utilities minimal — avoid a dumping-ground utils/ folder.
- Configuration through environment variables, validated at startup with Zod schemas.

## Testing
- Follow AAA pattern: Arrange, Act, Assert. Keep tests readable as documentation.
- Unit tests for pure business logic; integration tests for database/repository layers; E2E for critical flows.
- Use test doubles (mocks/stubs) only for external boundaries (APIs, databases, file system).
- Test error paths as thoroughly as happy paths.
`, {
    tags: ['community', 'source:cursor-directory', 'typescript', 'nodejs', 'strict-mode', 'cursor-rules'],
    importance: 9,
    source_url: 'https://github.com/PatrickJS/awesome-cursorrules',
  }),

  // ═══════════════════════════════════════════════════════════════════
  // SOURCE: Community Research — Agent Self-Improvement Patterns
  // ═══════════════════════════════════════════════════════════════════

  obs('pattern', 'Agent Self-Improvement: The Compound Engineering Loop', `
# The Compound Engineering Loop

A four-step cycle that makes every agent session build on all previous ones.

## The Cycle

**1. Plan** — Research the codebase and define a clear, testable scope before writing any code.
- Read relevant existing code, tests, and conventions
- State assumptions explicitly
- Define verifiable success criteria before starting

**2. Work** — Implement the plan in atomic, reversible steps.
- Each commit should be one logical change
- Keep changes small enough to reason about locally
- Match existing conventions, even if they differ from preference

**3. Review** — Subject code to external, objective validation.
- Run the full test suite — never skip tests
- Run linters and formatters
- Use a separate "reviewer" agent or perspective for code review
- Check: correctness, clarity, consistency, completeness

**4. Compound** — Persist what was learned for future sessions.
- If a mistake happened: add a rule preventing it in the context file
- If a pattern worked: codify it as a preferred approach
- If a gotcha was discovered: document the specific scenario and fix
- Update CLAUDE.md / AGENTS.md / .cursorrules with the new knowledge

## Why This Works
- Every completed session makes all future sessions better
- Mistakes are encoded as constraints, not repeated
- Patterns are codified as defaults, not rediscovered
- New team members inherit all accumulated knowledge on first bootstrap
`, {
    tags: ['community', 'source:research', 'self-improvement', 'compound-engineering', 'meta-learning'],
    importance: 10,
    source_url: 'https://every.to/source-code/compound-engineering',
  }),

  obs('pattern', 'Agent Self-Improvement: Grounded Reflection (Never Self-Evaluate)', `
# Grounded Reflection: External Verification Over Self-Evaluation

## The Core Problem
Agents suffer from "coherence bias" — they agree with their own incorrect reasoning.
Naive self-reflection ("Is this correct?") produces unreliable results because the
same model that made the error cannot reliably detect it.

## The Rule: Never Self-Evaluate
- Never ask an agent "Is this correct?" about its own output
- Never trust an agent's own assessment of its code quality
- Self-critique without external evidence is worse than no critique at all

## Grounded Verification Methods
1. **Execution-grounded validation**: Run the tests. If they pass, the code works. If they fail, it doesn't.
2. **Linter/formatter output**: Run eslint, prettier, mypy, gofmt. Don't guess — check.
3. **Build/compilation**: Does it compile? A passing build is not proof of correctness, but a failing build is proof of incorrectness.
4. **Browser automation**: For UI changes, actually render and inspect the result.
5. **Separate reviewer agent**: Use a different model or a fresh context to review. The reviewer should see only the diff, not the conversation that produced it.

## Concrete Practice
- Before claiming a bug is fixed: reproduce the bug with a test, then show the test passing
- Before claiming a feature works: write a test that exercises the feature end-to-end
- Before claiming code is clean: run the linter and formatter
- When uncertain: say "I would need to verify X by running Y" — don't guess
`, {
    tags: ['community', 'source:research', 'self-improvement', 'grounded-reflection', 'verification'],
    importance: 10,
    source_url: 'https://addyosmani.com/blog/self-improving-coding-agents/',
  }),

  obs('pattern', 'Agent Self-Improvement: The Reflexion Pattern (Actor-Evaluator-Reflection)', `
# The Reflexion Pattern

From Shinn et al. (2023) — the foundational framework for verbal reinforcement
learning in language agents. Works without model weight updates.

## Three Components

**Actor** — Generates actions and text based on the current task and memory.
- Produces: code changes, tool calls, responses
- Operates within the current context window

**Evaluator** — Scores the trajectory against objective criteria.
- Uses external signals: test results, build status, lint output, user feedback
- Produces: a scalar reward or structured feedback
- NEVER uses the same LLM instance that generated the code

**Self-Reflection** — Converts feedback + trajectory into actionable advice.
- Input: what was attempted, what the outcome was, what the evaluator said
- Output: a concise "reflection" stored in episodic memory
- Format: "In situation X, action Y led to outcome Z. Next time, try W instead."

## The Loop
1. Actor takes action based on task + memory
2. Evaluator assesses the outcome using external signals
3. Self-Reflection generates a memory entry from the assessment
4. Next iteration: Actor starts with updated memory
5. Repeat until success criteria met or iteration budget exhausted

## Key Constraints
- Limit to 1-2 reflection passes — infinite loops degrade quality
- Reflections must cite specific evidence, not general impressions
- Failed reflections ("try harder next time") are noise — delete them
- Successful reflections should be promoted to permanent rules after 3+ confirmations
`, {
    tags: ['community', 'source:research', 'self-improvement', 'reflexion', 'actor-evaluator'],
    importance: 9,
    source_url: 'https://arxiv.org/abs/2303.11366',
  }),

  obs('pattern', 'Agent Self-Improvement: Atomic Instinct Learning with Confidence Decay', `
# Atomic Instinct Learning

Inspired by ECC's continuous-learning-v2. Instead of saving large, monolithic
"skills" that are hard to verify, decompose successes and failures into granular,
testable "instincts" with confidence scores.

## Atomic Instinct Format
\`\`\`
# INSTINCT: Always verify file exists after bash write
Trigger: PostToolUse hook fires after Write tool
Condition: tool_name === 'Write' || tool_name === 'write_to_file'
Action: Run 'ls <filepath>' to confirm file was created
Confidence: 0.85
Evidence: 12 successes, 1 failure (file creation delayed by 200ms — added retry)
\`\`\`

## Confidence Scoring
- Every instinct starts at confidence 0.5 (neutral)
- Each successful application: confidence += 0.05 (capped at 0.95)
- Each failure/contradiction: confidence -= 0.15
- Below 0.30: instinct is retired (likely wrong or outdated)
- Above 0.85: instinct is "hardened" — changes require stronger evidence

## Evolution Path
1. **Observation**: A pattern is noticed across 3+ sessions
2. **Instinct**: Pattern is codified with trigger + action + confidence
3. **Rule**: At confidence 0.85+, instinct is promoted to a permanent context rule
4. **Skill**: Multiple related rules are composed into a reusable skill module

## Anti-Patterns
- Don't create instincts from a single occurrence — wait for repetition
- Don't harden instincts without diverse evidence (different projects, contexts)
- Don't keep instincts that fire but never change outcomes — they're noise
- Don't let confidence scores drift without periodic re-evaluation
`, {
    tags: ['community', 'source:research', 'self-improvement', 'instinct-learning', 'confidence-decay'],
    importance: 9,
    source_url: 'https://github.com/affaan-m/ecc',
  }),

  obs('instruction', 'Agent Self-Improvement: Root Cause Analysis from Errors', `
# Root Cause Analysis for Agent Errors

When an agent encounters an error, surface-level fixes ("add a null check") mask
the real problem. Always drill to the systemic cause.

## The RCA Process

**1. Record the Error** — Save the full error with context.
- What was the agent trying to do?
- What was the exact error message?
- What tool/call produced the error?
- What was the state before the error?

**2. Classify the Error Type**
- Knowledge gap: agent didn't know about a library function, API, or convention
- Process flaw: agent followed a workflow that doesn't work for this scenario
- Code issue: agent wrote code that has a bug, logic error, or type mismatch
- Environment issue: tool, network, permission, or configuration problem
- Assumption error: agent assumed something that wasn't true

**3. Identify the Root Cause**
Ask "Why?" repeatedly until you reach a systemic issue:
- Why did the error occur? → The function returned undefined
- Why was undefined returned? → The API changed its response format
- Why didn't we detect the API change? → No contract test exists
- Why no contract test? → Testing only covers internal logic, not external boundaries
→ Root cause: Missing boundary/contract testing for external API dependencies

**4. Create a Systemic Fix**
- The fix should prevent the CLASS of error, not just the instance
- Format: "When [trigger condition], always [preventive action]"
- Record the fix as a learning with confidence 75-85
- Link the learning to the error via 'derives_from' relation

**5. Verify the Fix**
- Does the fix address the root cause (not just the symptom)?
- Would the fix have prevented the original error?
- Does the fix introduce new failure modes?
`, {
    tags: ['community', 'source:research', 'self-improvement', 'rca', 'error-analysis'],
    importance: 9,
    source_url: 'https://github.com/zallauddin/agentic-cortex',
  }),

  obs('instruction', 'Agent Self-Improvement: Learning Verification & Confidence Calibration', `
# Learning Verification & Confidence Calibration

Agent learnings must be continuously verified against new evidence. A learning
that was correct last week may be wrong today. Confidence scores should track reality.

## Verification Triggers
- When a new observation is saved, check if it contradicts or reinforces existing learnings
- When a learning's confidence drops below 30, consider retiring it
- When a learning has been unchallenged for 30+ days with high confidence, it becomes a "rule"

## Confidence Adjustments

**Reinforcement** (new evidence supports the learning)
- Boost confidence by +5 (cap at 98)
- Record the reinforcing evidence ID
- If reinforced 5+ times, promote to "rule" status

**Contradiction** (new evidence conflicts with the learning)
- If learning is "soft" (confidence < 85): downgrade by -15
- If learning is "hardened" (confidence >= 85): flag for human review, don't auto-downgrade
- Record the contradicting evidence ID with a 'contradicts' relation

**Decay** (no verification activity for 30+ days)
- Soft learnings: confidence -= 2 per month of inactivity
- Hardened rules: no auto-decay (they've earned stability)

## Calibration Check
Periodically compare predicted confidence vs. actual outcomes:
- If high-confidence learnings (>85) frequently fail verification: the system is overconfident
- If low-confidence learnings (<50) frequently succeed: the system is underconfident
- Adjust the confidence model if calibration drifts beyond 20% error rate

## What NOT to Do
- Don't change confidence without recording the evidence (creates untraceable drift)
- Don't allow circular verification (learning A verifies learning B which verifies A)
- Don't let a single contradiction kill a well-evidenced learning — require multiple independent contradictions
`, {
    tags: ['community', 'source:research', 'self-improvement', 'verification', 'confidence-calibration'],
    importance: 9,
    source_url: 'https://github.com/zallauddin/agentic-cortex',
  }),

  obs('instruction', 'Agent Self-Improvement: Error Taxonomy & Targeted Recovery', `
# Error Taxonomy for AI Coding Agents

Classifying errors enables targeted recovery strategies instead of generic retries.
Each error type has a specific recovery path.

## Error Taxonomy

**SyntaxError** — Code doesn't parse or compile.
- Recovery: Check syntax with linter/compiler, fix the specific syntax issue, recompile.
- Prevention: Run syntax check after every code change before proceeding.

**TypeError / NullReference** — Wrong type or null/undefined where value expected.
- Recovery: Trace the value origin, add type guard or null check, verify with type checker.
- Prevention: Use strict typing, exhaustive null checks, avoid 'any'.

**AssertionError** — Test assertion failed.
- Recovery: Understand what the test expects vs. what the code produces. Fix the mismatch.
- Prevention: Write the test BEFORE the implementation (TDD).

**TimeoutError** — Operation exceeded time limit.
- Recovery: Check if the resource is available, increase timeout (only if justified), add retry.
- Prevention: Set explicit timeouts on all external calls; never rely on defaults.

**AuthError / ForbiddenError** — Missing or invalid credentials.
- Recovery: Check environment variables, token validity, permission scope. Don't retry blindly.
- Prevention: Validate credentials at startup; fail fast if auth is misconfigured.

**ResourceExhaustion** — Out of memory, disk, connections, or rate limit.
- Recovery: Release resources, add backpressure, implement exponential backoff.
- Prevention: Bound all resource usage; stream large data instead of loading into memory.

**Hallucination** — Agent used a non-existent API, function, or library.
- Recovery: Verify the API exists in the installed version. If not, find the real API.
- Prevention: Always check package.json / go.mod / Cargo.toml before calling third-party APIs.

**LogicError** — Code compiles and runs but produces wrong results.
- Recovery: Trace through the logic with specific inputs, identify where expectation diverges from reality.
- Prevention: Write unit tests for business logic before integrating.

## The Recovery Protocol
1. Classify the error using the taxonomy above
2. Apply the type-specific recovery strategy (don't retry the same approach)
3. If recovery fails twice: escalate to human with the full error context and what was tried
4. After successful recovery: record the error type + fix as a learning
`, {
    tags: ['community', 'source:research', 'self-improvement', 'error-taxonomy', 'recovery'],
    importance: 9,
    source_url: 'https://arxiv.org/abs/2310.04438',
  }),

  obs('pattern', 'Agent Self-Improvement: Retrospective Analysis (Post-Task Review)', `
# Retrospective Analysis Protocol

After every non-trivial task, run a structured retrospective. This is the "Compound"
step of the Compound Engineering loop — the most frequently skipped, most valuable step.

## The Retrospective Template

**1. What was the original goal?**
- Restate the task as a single sentence
- What were the specific acceptance criteria?

**2. Did we achieve it?**
- Verified by: tests passing, build green, user approval, metrics, etc.
- If no: what's the gap? What remains?

**3. What went well?** (Preserve these patterns)
- Which approaches worked better than expected?
- Which tools or patterns were especially effective?
- What would you do the same way next time?

**4. What went wrong?** (Prevent recurrence)
- Which assumptions were incorrect?
- Where did the agent waste time or go down wrong paths?
- What errors occurred that should have been caught earlier?

**5. What should be persisted?** (Compound the knowledge)
- New constraint for CLAUDE.md / AGENTS.md: "Never use X because Y"
- New pattern to codify: "Always do Z before W"
- New gotcha to document: "Library A version 2.x breaks B when C"
- Update to existing learning: adjust confidence, add evidence

**6. What's the next action?**
- Is there follow-up work? Known debt? Unresolved questions?
- Record as a task or flag for the next session

## When to Run Retrospectives
- After any task that took more than 3 tool calls
- After any task where an error or unexpected behavior occurred
- At the end of every session (even short ones — 30 seconds of review saves hours later)
- Skip only for trivial single-step operations (read a file, answer a fact question)
`, {
    tags: ['community', 'source:research', 'self-improvement', 'retrospective', 'post-mortem'],
    importance: 10,
    source_url: 'https://developersdigest.substack.com/p/self-improving-ai-agents',
  }),

  // ═══════════════════════════════════════════════════════════════════
  // SOURCE: GitHub Copilot — Official Prompt Engineering Guide
  // ═══════════════════════════════════════════════════════════════════

  obs('instruction', 'GitHub Copilot Prompt Engineering: 6 Techniques for AI Code Generation', `
# GitHub Copilot Prompt Engineering Best Practices

Extracted from GitHub's official documentation. These techniques improve the quality
of code generated by any AI coding assistant, not just Copilot.

## 1. Start General, Then Specific
- Begin with the high-level goal or "big picture" description
- Follow with specific requirements, constraints, and edge cases
- Example: "Create a user authentication service. It should support email/password login, JWT tokens with 1-hour expiry, and refresh token rotation."

## 2. Provide Examples (Few-Shot Prompting)
- Include examples of desired input/output format when the format matters
- Unit tests are exceptionally effective as examples — they define both the API AND the expected behavior
- Example: write a failing test that calls the function, then ask the agent to make it pass

## 3. Break Complex Tasks Into Steps
- Decomposition is the single highest-leverage technique
- Split a complex task into a numbered sequence of smaller, independent tasks
- Each step should have a clearly defined output that the next step can consume
- This prevents the agent from going down wrong paths on large tasks

## 4. Specify the Output Format
- Explicitly state the desired format: "Return a JSON object", "Write as a bulleted list", "Generate a Markdown table"
- For code: "Use async/await", "Follow the Repository pattern", "Export as a named function"
- Ambiguity in format expectations is the #1 cause of rejected generations

## 5. Use Context Files (Prompt Files)
- Leverage persistent context files (CLAUDE.md, AGENTS.md, .cursorrules) to encode:
  - Project-specific coding style and conventions
  - Technology stack and version constraints
  - Preferred patterns and anti-patterns
  - Task-specific workflows and checklists
- These files are read on every session — they're your agent's long-term memory

## 6. Iterative Steering
- Treat code generation as a conversation, not a one-shot command
- After the first generation, provide targeted feedback: "The error handling is good, but move the validation into a separate function"
- Each iteration narrows the gap between generated and desired code
- Stop when the code meets all acceptance criteria, not when it "looks good"
`, {
    tags: ['community', 'source:github', 'copilot', 'prompt-engineering', 'code-generation'],
    importance: 9,
    source_url: 'https://docs.github.com/en/copilot/using-github-copilot/prompt-engineering-for-github-copilot',
  }),

  // ═══════════════════════════════════════════════════════════════════
  // SOURCE: Cursor — Official Rules System Documentation
  // ═══════════════════════════════════════════════════════════════════

  obs('instruction', 'Cursor Rules Best Practices: .mdc Format, Types, and Composition', `
# Cursor Rules System: Best Practices for Agent Instructions

From Cursor's official documentation. These patterns apply to any rule-based
agent configuration system (Cursor, Claude Code, OpenCode, Copilot).

## Rule File Format (.mdc)
- Use Markdown Control (.mdc) files in \`.cursor/rules/\` directory
- Each file has YAML frontmatter (metadata) and Markdown content (the rules)
- Frontmatter fields: \`alwaysApply\`, \`description\`, \`globs\`

## Rule Application Types

**1. Always Apply (\`alwaysApply: true\`)**
- Included in every chat session and every request
- Use for: coding standards, security rules, project conventions
- Limit these to essentials — too many always-applied rules dilute context

**2. Apply Intelligently (with \`description\`)**
- Agent decides relevance based on the description metadata
- Use for: domain-specific rules, technology-specific patterns
- Example: \`description: "Rules for React component patterns and hooks usage"\`

**3. Apply to Specific Files (with \`globs\`)**
- Rule activates only when editing files matching the glob pattern
- Use for: file-type conventions, test patterns, config patterns
- Example: \`globs: ["**/*.test.ts", "**/*.spec.ts"]\` for test-specific rules

**4. Apply Manually (via @mention)**
- Invoked explicitly by the user with \`@RuleName\` in chat
- Use for: templates, boilerplate generators, rarely-needed workflows

## Composition Best Practices
- **Keep rules focused**: Each rule file should address ONE concern (under 500 lines)
- **Compose, don't monolith**: Use multiple small, focused rules rather than one huge file
- **Point to examples**: Reference canonical code examples rather than copying code into rules
- **Use AGENTS.md for flat instructions**: Project-root AGENTS.md for simple, flat rules that don't need frontmatter metadata
- **Nested AGENTS.md override parents**: Rules in subdirectories take precedence over parent directories

## What Makes a Good Rule
- Specific enough to be actionable ("Use Zod for validation" not "Write good code")
- Scoped to relevant files via \`globs\` when possible
- Updated when conventions change (rules rot faster than code)
- Reviewed periodically: unused rules should be removed
`, {
    tags: ['community', 'source:cursor', 'rules', 'cursorrules', 'configuration'],
    importance: 9,
    source_url: 'https://docs.cursor.com/context/rules-for-ai',
  }),

  // ═══════════════════════════════════════════════════════════════════
  // SOURCE: Confluent — Event-Driven Multi-Agent Architecture
  // ═══════════════════════════════════════════════════════════════════

  obs('pattern', 'Event-Driven Multi-Agent Architecture: 4 Design Patterns', `
# Event-Driven Multi-Agent Design Patterns

From Confluent's engineering guide on scaling multi-agent systems. These patterns
use event-streaming (Kafka-like) to coordinate agents at production scale.

## 1. Orchestrator-Worker
A central orchestrator agent assigns tasks to a pool of worker agents.

- **How**: Orchestrator publishes tasks to a topic. Worker consumer group
  processes tasks in parallel via key-based partitioning.
- **Use when**: Tasks are independent, the set of steps is known upfront,
  and you need uniform load distribution across workers.
- **Key detail**: Partition by task ID for ordering; use consumer groups for parallelism.

## 2. Hierarchical Agent
Recursive orchestrator-worker pattern. Non-leaf nodes manage subtrees of agents.

- **How**: A top-level agent decomposes the task into subtasks. Each subtask
  is delegated to a sub-orchestrator that further decomposes or executes.
- **Use when**: Complex problems benefit from recursive decomposition
  (e.g., "refactor entire monolith" → "refactor auth module" → "extract UserService").
- **Key detail**: Each level encapsulates complexity; leaf agents only see their slice.

## 3. Blackboard
Agents interact asynchronously by reading/writing to a shared event stream.

- **How**: Agents publish observations and partial results to a shared topic.
  Other agents consume and contribute. No direct agent-to-agent communication.
- **Use when**: Multiple agents need to contribute to a shared understanding
  without tight coupling (e.g., code analysis + security scan + style check all
  contribute findings to a shared review topic).
- **Key detail**: Eliminates brittle point-to-point connections; agents can
  join/leave without disrupting the system.

## 4. Market-Based
Agents compete or negotiate via bidding and asking topics.

- **How**: Agents publish "asks" (tasks they need done) and "bids" (offers to
  do tasks). A market-maker aggregator matches bids to asks.
- **Use when**: Tasks have varying cost/quality tradeoffs and you want decentralized
  allocation (e.g., multiple specialized agents bid on "fix this bug" based on
  their domain expertise).
- **Key detail**: Eliminates quadratic connection complexity; new agent types
  can join the market without reconfiguring existing agents.

## Universal Principles for Agent Coordination
- **Decouple via events**: Never have agent A call agent B directly.
- **Own your state**: Each agent owns its state; share facts, not state.
- **Design for failure**: Agents crash, time out, produce wrong output.
  Every pattern must handle partial failure gracefully.
- **Observability is non-negotiable**: Every agent must emit structured logs,
  metrics, and traces for debugging distributed agent systems.
`, {
    tags: ['community', 'source:confluent', 'multi-agent', 'event-driven', 'architecture', 'kafka'],
    importance: 8,
    source_url: 'https://www.confluent.io/blog/event-driven-multi-agent-systems/',
  }),

  // ═══════════════════════════════════════════════════════════════════
  // SOURCE: Agentic AI Flow — Production Error Handling for Agents
  // ═══════════════════════════════════════════════════════════════════

  obs('instruction', 'Agentic Error Handling: Structural, Monitored, and Type-Branched Recovery', `
# Production Error Handling Patterns for AI Agents

From Agentic AI Flow's production guide. Generic retry loops are insufficient —
agents need structured, monitored, type-aware error recovery.

## 1. Structural Error Correction
Use strict schema validation to catch malformed output BEFORE it executes.

- **Mechanism**: Validate agent output against a Pydantic/Zod/JSON Schema
  before passing it to any tool or function.
- **On failure**: Return the specific validation error to the LLM as structured
  feedback (e.g., "field 'email' is not a valid email address").
- **Goal**: Let the LLM self-correct its output format without executing bad data.
- **Tool contracts**: Every tool should declare its input schema. Validation
  at the boundary prevents garbage-in.

## 2. Monitored Execution Pattern
Implement a validation-retry loop with failure-specific feedback.

- **Loop**: Generate → Validate output → If valid: execute → If invalid: return
  specific error + retry (max 3 attempts).
- **Feedback must be specific**: "Invalid date format in field 'start_date'.
  Expected YYYY-MM-DD, got 'tomorrow'." NOT "Invalid input."
- **Escalation**: After max retries, escalate to human with the full generation
  history and all validation failures.

## 3. Error Type Branching
Different error types require fundamentally different recovery strategies.

- **Structural errors** (malformed JSON, wrong types): → Retry with validation
  feedback. These are format problems, not logic problems.
- **Runtime/transient errors** (rate limits, 503, timeouts): → Exponential
  backoff with jitter. These resolve themselves with time.
- **Logical/semantic errors** (hallucinations, wrong calculations): → Provide
  feedback pointing out the specific contradiction. "The function claims to
  sort ascending but the output [3, 1, 2] is not sorted."
- **Permanent errors** (invalid API key, resource not found): → Fail fast.
  Do not retry. Surface immediately to the user.

## 4. Observability Requirements
- **Record everything**: Every prompt, tool input, raw output, and stack trace.
- **Why**: Agent behavior is non-deterministic. You CANNOT debug what you didn't log.
- **Correlation IDs**: Every agent action gets a trace ID that flows through
  all retries, tool calls, and sub-agent invocations.
- **Replay capability**: Store enough state to replay failed agent runs for debugging.
`, {
    tags: ['community', 'source:agentic-ai-flow', 'error-handling', 'production', 'validation', 'observability'],
    importance: 9,
    source_url: 'https://agenticai-flow.com/en/posts/ai-agent-error-handling-best-practices/',
  }),

];

// ─── Main ────────────────────────────────────────────────────────────

console.error('[import] Importing %d community knowledge observations...\n', OBSERVATIONS.length);

const globalDir = getGlobalDir();

if (flags.dryRun) {
  console.error('=== DRY RUN — no files written ===\n');
  for (const o of OBSERVATIONS) {
    const md = encodeObservation(o);
    const filename = generateFilename(o);
    console.error('  Would write: .cortex/global/%s', filename);
    console.error('    #%d [%s] conf=%d — %s', o.id, o.type, o.confidence, o.title.slice(0, 70));
    console.error('    Tags: %s', (o.tags || []).join(', '));
    console.error('    Content: %d chars', o.content.length);
    console.error('');
  }
  console.error('=== %d observations would be imported ===', OBSERVATIONS.length);
  process.exit(0);
}

// Resolve memory repo
const repoDir = getRepoDir();
console.error('[import] Memory repo: %s\n', repoDir);

// Ensure the repo exists
if (!fs.existsSync(path.join(repoDir, '.git'))) {
  if (fs.existsSync(REPO_URL) && fs.statSync(REPO_URL).isDirectory()) {
    console.error('[import] Initializing git in local repo: %s', repoDir);
    try {
      execSync('git init', { cwd: repoDir, encoding: 'utf-8', timeout: 10000, stdio: 'pipe' });
    } catch (err) {
      console.error('[import] ERROR: git init failed: %s', (err.stderr || err.message || '').slice(0, 200));
      process.exit(1);
    }
  } else {
    // Clone the remote repo
    console.error('[import] Cloning memory repo: %s', REPO_URL);
    const parentDir = path.dirname(repoDir);
    if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
    try {
      execSync('git clone --depth 1 ' + shellQuote(REPO_URL) + ' ' + shellQuote(repoDir), {
        encoding: 'utf-8', timeout: 60000, stdio: 'pipe',
      });
      console.error('[import] Clone successful.\n');
    } catch (err) {
      console.error('[import] ERROR: Clone failed: %s', (err.stderr || err.message || '').slice(0, 200));
      process.exit(1);
    }
  }
} else {
  // Pull latest
  try {
    const remotes = execSync('git remote', { cwd: repoDir, encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    if (remotes.trim()) {
      console.error('[import] Pulling latest...');
      execSync('git pull --ff-only origin HEAD', {
        cwd: repoDir, encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
      });
      console.error('[import] Pull successful.\n');
    }
  } catch { /* best effort */ }
}

// Ensure .cortex/global/ exists
if (!fs.existsSync(globalDir)) {
  fs.mkdirSync(globalDir, { recursive: true });
}

// Build index of existing IDs
const existingIds = new Set();
try {
  const files = fs.readdirSync(globalDir).filter(f => f.endsWith('.md'));
  for (const f of files) {
    const idMatch = f.match(/__(\d{5})__/);
    if (idMatch) existingIds.add(parseInt(idMatch[1], 10));
  }
} catch { /* no files yet */ }

// Write observations
let written = 0;
let skipped = 0;

for (const o of OBSERVATIONS) {
  if (existingIds.has(o.id)) {
    console.error('  SKIP #%d [%s] — %s (already in repo)', o.id, o.type, o.title.slice(0, 50));
    skipped++;
    continue;
  }

  const md = encodeObservation(o);
  const filename = generateFilename(o);
  const filePath = path.join(globalDir, filename);

  fs.writeFileSync(filePath, md, 'utf-8');
  existingIds.add(o.id);
  written++;

  const tagStr = (o.tags || []).filter(t => t.startsWith('source:')).join(', ');
  console.error('  ✓ #%d [%s] %s  (%s)', o.id, o.type, o.title.slice(0, 50), tagStr);
}

console.error('\n[import] Written: %d  |  Skipped: %d  |  Total: %d\n', written, skipped, OBSERVATIONS.length);

if (written === 0) {
  console.error('[import] No new observations to commit. Done.');
  process.exit(0);
}

// Commit and push
console.error('[import] Committing and pushing...\n');

try {
  execSync('git add .cortex/', {
    cwd: repoDir, encoding: 'utf-8', timeout: 10000, stdio: 'pipe',
  });

  const status = execSync('git status --porcelain', {
    cwd: repoDir, encoding: 'utf-8', timeout: 5000, stdio: 'pipe',
  });

  if (!status.trim()) {
    console.error('[import] No changes to commit.');
    process.exit(0);
  }

  // Categorize what was imported
  const sources = [...new Set(OBSERVATIONS.filter(o => o.id >= nextId - written).map(o => {
    const tag = (o.tags || []).find(t => t.startsWith('source:'));
    return tag ? tag.replace('source:', '') : 'community';
  }))].sort();

  const commitMsg = 'import: ' + written + ' community knowledge observations from ' +
    sources.join(', ') + ' [agentic-cortex community import]';

  execSync('git commit -m ' + shellQuote(commitMsg), {
    cwd: repoDir, encoding: 'utf-8', timeout: 10000, stdio: 'pipe',
  });

  let hasRemote = false;
  try {
    const remotes = execSync('git remote', {
      cwd: repoDir, encoding: 'utf-8', timeout: 5000, stdio: 'pipe',
    });
    hasRemote = remotes.trim().length > 0;
  } catch { /* no remotes */ }

  if (hasRemote) {
    execSync('git push origin HEAD', {
      cwd: repoDir, encoding: 'utf-8', timeout: 30000, stdio: 'pipe',
    });
    console.error('[import] ✓ Pushed to remote.\n');
  } else {
    console.error('[import] ⚠ No git remote configured. Committed locally only.\n');
  }

  const commitHash = execSync('git rev-parse --short HEAD', {
    cwd: repoDir, encoding: 'utf-8', timeout: 5000, stdio: 'pipe',
  }).trim();

  console.error('[import] Commit: %s\n', commitHash);
} catch (err) {
  console.error('[import] ERROR during commit/push: %s', (err.stderr || err.message || '').slice(0, 300));
  console.error('[import] Files are written locally. You may need to commit/push manually.');
}

// Summary
console.error('═══════════════════════════════════════════════════════');
console.error('  Community Knowledge Import Complete');
console.error('═══════════════════════════════════════════════════════');
console.error('  Repository:   %s', REPO_URL);
console.error('  Imported:     %d observations', written);
console.error('  Skipped:      %d (already present)', skipped);

const sourceBreakdown = {};
for (const o of OBSERVATIONS) {
  const src = (o.tags || []).find(t => t.startsWith('source:')) || 'source:community';
  sourceBreakdown[src] = (sourceBreakdown[src] || 0) + 1;
}
console.error('  Sources:');
for (const [src, count] of Object.entries(sourceBreakdown).sort((a, b) => b[1] - a[1])) {
  console.error('    %s: %d', src, count);
}
console.error('═══════════════════════════════════════════════════════');
