/**
 * standards.js — Canonical Coding Standards for agentic-cortex.
 *
 * Pre-loaded, always-injected, phase-aware coding standards derived from:
 *   - Karpathy Guidelines (Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven)
 *   - SOLID (SRP, OCP, LSP, ISP, DIP)
 *   - DRY, KISS, YAGNI
 *   - Clean Code (meaningful names, small functions, no side effects, error handling)
 *
 * These are NOT opt-in CLI commands. They are auto-seeded on first init,
 * always injected into every context() call, organized by development phase,
 * and self-reinforcing through the existing feedback/predicted-utility loop.
 *
 * Agents should never need to explicitly query for standards — they're always
 * visible in context and always in effect.
 *
 * @module core/standards
 */

'use strict';

// ─── Phase Constants ──────────────────────────────────────────────────

/** @enum {string} Development phases for standards organization */
const PHASES = {
  PLANNING: 'planning',       // Requirements gathering, architecture, design
  IMPLEMENTATION: 'implementation', // Writing code, building features
  REVIEW: 'review',           // Code review, refactoring, cleanup
  ALL: 'all',                 // Applicable at every phase
};

/** @enum {string} Category tags for filtering/searching */
const CATEGORIES = {
  KARPATHY: 'karpathy',
  SOLID: 'solid',
  DRY: 'dry',
  KISS: 'kiss',
  YAGNI: 'yagni',
  CLEAN_CODE: 'clean-code',
  GENERAL: 'general',
};

// ─── Canonical Standards Definition ────────────────────────────────────

/**
 * All coding standards, organized by phase and category.
 * Each entry is an instruction-type observation definition with
 * structured fields: steps, triggers, preconditions, postconditions.
 *
 * These are hardcoded — not user-configurable — to ensure consistency
 * across all agentic-cortex installations.
 *
 * @type {Array<{
 *   title: string,
 *   content: string,
 *   phase: string,
 *   category: string,
 *   steps: string[],
 *   triggers: string[],
 *   preconditions: string[],
 *   postconditions: string[]
 * }>}
 */
const ALL_STANDARDS = [
  // ═══════════════════════════════════════════════════════════════════════
  // PHASE: PLANNING & DESIGN
  // ═══════════════════════════════════════════════════════════════════════

  {
    title: 'Think before coding: surface assumptions explicitly',
    content: 'Before implementing, state your assumptions. If uncertain, ask rather than guess. Present multiple interpretations when ambiguity exists. Push back if a simpler approach exists. Stop when confused — name what is unclear and ask for clarification. Never pick an interpretation silently.',
    phase: PHASES.PLANNING,
    category: CATEGORIES.KARPATHY,
    steps: ['Identify hidden assumptions in the request', 'State them explicitly before coding', 'Ask for clarification if uncertain', 'Present tradeoffs if multiple approaches exist'],
    triggers: ['Starting a new task', 'User request is ambiguous', 'Multiple approaches possible', 'Something seems off or unclear'],
    preconditions: ['You have received a task request'],
    postconditions: ['All assumptions are documented or confirmed', 'Ambiguities are resolved', 'Tradeoffs are understood by all parties'],
  },
  {
    title: 'Present options, don\'t pick silently',
    content: 'When a request has multiple valid interpretations, present the options with tradeoffs instead of silently picking one. Example: "Make search faster" could mean reduce latency, increase throughput, or improve perceived speed. Ask which matters most.',
    phase: PHASES.PLANNING,
    category: CATEGORIES.KARPATHY,
    steps: ['Identify multiple interpretations', 'Describe each with tradeoffs', 'Ask user to choose or confirm', 'Proceed only after alignment'],
    triggers: ['User request is ambiguous', 'Multiple technical approaches exist', 'Request could be interpreted at different scopes'],
    preconditions: ['Ambiguity detected in user request'],
    postconditions: ['User has confirmed approach', 'Tradeoffs are understood'],
  },
  {
    title: 'SRP — Single Responsibility: one reason to change',
    content: 'Each module, class, or function should have exactly one reason to change. Not "does one thing" — but "one actor demands the change." Ask: if I change this, who asked for it? If the answer is "it depends on the change," split it.',
    phase: PHASES.PLANNING,
    category: CATEGORIES.SOLID,
    steps: ['Identify who would request changes to this module', 'Group methods by the actor they serve', 'Split into separate modules if multiple actors exist', 'Name each module for the actor it serves'],
    triggers: ['Designing a new class or module', 'A class has methods serving different concerns', 'Refactoring a god class with 20+ methods'],
    preconditions: ['You are designing or refactoring a class/module'],
    postconditions: ['Each module serves exactly one actor', 'Changes to one module don\'t cascade to unrelated modules'],
  },
  {
    title: 'KISS — Keep It Simple: simplest solution that works',
    content: 'The simplest solution that works is the best solution. Prefer functions over classes for simple logic. Prefer explicit code over clever abstractions. Prefer readable code over elegant code. No premature optimization.',
    phase: PHASES.PLANNING,
    category: CATEGORIES.KISS,
    steps: ['Write the simplest version first', 'Verify it works', 'Only add complexity when needed', 'Ask: would a junior dev understand this?'],
    triggers: ['Starting a new feature', 'Choosing between simple and complex approaches', 'You find yourself writing an abstraction for one use case'],
    preconditions: ['You are designing a solution'],
    postconditions: ['Solution is as simple as possible while meeting requirements', 'No unnecessary abstractions exist'],
  },
  {
    title: 'YAGNI — You Aren\'t Gonna Need It: no speculative features',
    content: 'Don\'t build features, abstractions, or "flexibility" before they\'re needed. The most expensive code is code you wrote but never used. If you can\'t point to the ticket, user request, or failing test that needs it, don\'t write it.',
    phase: PHASES.PLANNING,
    category: CATEGORIES.YAGNI,
    steps: ['Identify what the request actually needs', 'Strip speculative features from the design', 'Only implement what has a clear, immediate need', 'Document future considerations in comments, not code'],
    triggers: ['You\'re tempted to add "flexibility" or "configurability" not requested', 'Writing abstractions for hypothetical future use cases', 'Adding error handling for impossible scenarios'],
    preconditions: ['You are planning what to build'],
    postconditions: ['Only requested functionality is implemented', 'Future considerations are documented, not coded'],
  },
  {
    title: 'OCP — Open for Extension, Closed for Modification',
    content: 'Add new behavior by adding new code, not by changing existing tested code. Achieved through interfaces, abstract classes, and polymorphism. But only add this abstraction when you actually have 3+ variants — don\'t create a strategy pattern for a single implementation.',
    phase: PHASES.PLANNING,
    category: CATEGORIES.SOLID,
    steps: ['Identify variation points in the design', 'Define an interface for the varying behavior', 'Implement the interface for each variant', 'New variants add classes, not modify existing code'],
    triggers: ['You have 3+ variants of the same behavior', 'Adding a new type requires modifying switch/case statements', 'Requirements specify future variants'],
    preconditions: ['At least 2 variants exist (3+ to justify abstraction)'],
    postconditions: ['New variants can be added without touching existing code', 'Existing tests pass without modification'],
  },
  {
    title: 'DIP — Depend on Abstractions, Not Concretions',
    content: 'High-level modules should not depend on low-level modules. Both should depend on abstractions. Dependency should point toward stability: depend on interfaces (stable), not implementations (volatile). Inject dependencies, don\'t instantiate them internally.',
    phase: PHASES.PLANNING,
    category: CATEGORIES.SOLID,
    steps: ['Identify concrete dependencies in high-level modules', 'Define interfaces for those dependencies', 'Inject implementations via constructor or parameters', 'Low-level modules implement the interface, not the other way around'],
    triggers: ['High-level module creates instances of low-level services', 'Swapping implementations requires changing business logic', 'Testing requires mocking infrastructure'],
    preconditions: ['You have a module that depends on external services or libraries'],
    postconditions: ['Business logic has no knowledge of implementation details', 'Swapping implementations requires no business logic changes'],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE: IMPLEMENTATION & CODING
  // ═══════════════════════════════════════════════════════════════════════

  {
    title: 'Simplicity first: minimum code that solves the problem',
    content: 'Write the minimum code that solves the problem. No features beyond what was asked. No abstractions for single-use code. No "flexibility" or "configurability" that wasn\'t requested. If you write 200 lines and it could be 50, rewrite it. Ask: would a senior engineer say this is overcomplicated?',
    phase: PHASES.IMPLEMENTATION,
    category: CATEGORIES.KARPATHY,
    steps: ['Write the minimal implementation', 'Check if it meets all requirements', 'Remove any speculative or decorative code', 'Review: could this be shorter without sacrificing clarity?'],
    triggers: ['Writing new code', 'Code exceeds 50 lines for a single function', 'You\'re adding configurability that wasn\'t requested', 'Temptation to build a framework instead of a feature'],
    preconditions: ['You are implementing a feature or fix'],
    postconditions: ['Code is as short as possible while being clear', 'No speculative features exist', 'A peer review would approve the simplicity'],
  },
  {
    title: 'DRY — Don\'t Repeat Yourself: single source of truth',
    content: 'Every piece of knowledge must have a single, authoritative representation in the codebase. Every business rule, calculation, or configuration should live in exactly one place. But don\'t extract prematurely: two similar-looking code blocks that serve different business reasons are NOT duplicates.',
    phase: PHASES.IMPLEMENTATION,
    category: CATEGORIES.DRY,
    steps: ['Scan for duplicate logic in new and existing code', 'Check if duplicates share the same reason to change', 'Extract shared logic to a single function/module if they do', 'If reasons differ, keep them separate despite surface similarity'],
    triggers: ['You\'re about to copy-paste code', 'You see the same calculation or rule in multiple files', 'A constant or config value is hardcoded in multiple places'],
    preconditions: ['Duplicate logic exists that shares the same reason to change'],
    postconditions: ['Each business rule lives in exactly one place', 'Changes to a rule propagate everywhere automatically'],
  },
  {
    title: 'Small functions: do one thing well',
    content: 'A function should do exactly one thing, do it well, and do it only. If a function has multiple levels of abstraction, extract the lower levels. Functions should be shorter than you think — aim for under 20-30 lines. Name each extracted function for WHAT it does.',
    phase: PHASES.IMPLEMENTATION,
    category: CATEGORIES.CLEAN_CODE,
    steps: ['Review function for multiple responsibilities', 'Extract lower-level details into named helper functions', 'Ensure the function reads at a single level of abstraction', 'Verify each extracted function name describes its purpose'],
    triggers: ['A function exceeds 30 lines', 'Function mixes high-level logic with low-level details', 'You need comments to explain sections of a function'],
    preconditions: ['Function exists with multiple levels of abstraction'],
    postconditions: ['Each function does one thing', 'Code reads at a consistent level of abstraction', 'Function names accurately describe purpose'],
  },
  {
    title: 'Meaningful names: self-documenting code',
    content: 'Use clear, descriptive names for variables, functions, and classes. Names should reveal intent — why it exists, what it does, how it\'s used. A good name eliminates the need for a comment. Use pronounceable names. Use searchable names (no single-letter vars except loop indices).',
    phase: PHASES.IMPLEMENTATION,
    category: CATEGORIES.CLEAN_CODE,
    steps: ['Choose names that reveal intent, not just type', 'Use verb-noun for functions: fetchUser, calculateTax', 'Use noun for variables: userCount, isAuthenticated', 'Avoid abbreviations, single letters, and cryptic prefixes'],
    triggers: ['Naming a new variable, function, or class', 'Code review finds unclear names', 'You need a comment to explain what a variable holds'],
    preconditions: ['You are writing or reviewing code'],
    postconditions: ['Names reveal intent without comments', 'Names are searchable and pronounceable', 'No single-letter variables except loop indices'],
  },
  {
    title: 'No side effects: pure functions when possible',
    content: 'Functions should either do something (command) or answer something (query), but not both. Getters and queries should not modify state. Avoid hidden mutations in functions that appear read-only. Use immutable patterns: spread operators, not direct mutations.',
    phase: PHASES.IMPLEMENTATION,
    category: CATEGORIES.CLEAN_CODE,
    steps: ['Check if a function modifies state AND returns a value', 'Split into separate command and query functions if so', 'Use spread/immutable patterns instead of direct mutations', 'Document any necessary side effects explicitly'],
    triggers: ['Function name suggests a query but has side effects', 'Direct mutation of objects or arrays', 'getUser() also updates last_accessed', 'sort() mutates the original array'],
    preconditions: ['You are writing or modifying a function'],
    postconditions: ['Queries return data without side effects', 'Commands clearly indicate they modify state', 'Mutations use immutable patterns where possible'],
  },
  {
    title: 'Error handling: fail loud, not silently',
    content: 'Catch specific errors, not blanket exceptions. Log what failed and why. Never swallow errors silently with empty catch blocks or "pass." If recovery is possible, handle it explicitly. If not, let it propagate with context. Use try/catch at boundaries (API endpoints, event handlers), not everywhere.',
    phase: PHASES.IMPLEMENTATION,
    category: CATEGORIES.CLEAN_CODE,
    steps: ['Identify which errors are recoverable', 'Catch specific error types, not all exceptions', 'Log errors with context (what operation, what input)', 'If unrecoverable, propagate with useful message'],
    triggers: ['Writing try/catch blocks', 'Handling external API calls or I/O', 'Error goes unlogged or silently ignored', 'Empty catch block detected'],
    preconditions: ['Operation can fail for reasons outside your control'],
    postconditions: ['All errors are logged with context', 'Recoverable errors are handled', 'Unrecoverable errors propagate clearly'],
  },
  {
    title: 'Early returns: flatten deep nesting',
    content: 'Avoid deeply nested conditionals. Use guard clauses (early returns) at the top of functions to handle edge cases and invalid states. The happy path should be the least indented code. No more than 2-3 levels of nesting in any function.',
    phase: PHASES.IMPLEMENTATION,
    category: CATEGORIES.CLEAN_CODE,
    steps: ['Identify deeply nested conditionals', 'Extract guard conditions as early returns', 'Handle errors and edge cases first', 'Let the happy path flow at the function\'s top level'],
    triggers: ['Code has 3+ levels of indentation', 'If-else chains that could be guard clauses', 'Reading code requires tracking multiple nested conditions'],
    preconditions: ['Function has conditional logic'],
    postconditions: ['Happy path is least indented', 'No more than 2-3 nesting levels', 'Edge cases handled cleanly at function entry'],
  },
  {
    title: 'Immutable by default: spread, don\'t mutate',
    content: 'Use immutable patterns for data transformations. Spread operators for objects and arrays. Array methods (map, filter, reduce) instead of push/pop in place. Functional updates for state (prev => next). Never mutate function arguments directly.',
    phase: PHASES.IMPLEMENTATION,
    category: CATEGORIES.GENERAL,
    steps: ['Replace direct mutations with spread or immutable methods', 'Use map/filter/reduce instead of for-loops that mutate', 'Use functional state updates: setState(prev => ...)', 'Never mutate function parameters'],
    triggers: ['Writing obj.property = value directly', 'Using push/pop/splice on arrays', 'Mutating function arguments', 'for-loop that modifies array elements in place'],
    preconditions: ['You are transforming data structures'],
    postconditions: ['Original data is never mutated', 'Transformations produce new objects/arrays', 'State updates use functional patterns'],
  },
  {
    title: 'Type safety: avoid "any" — always use proper types',
    content: 'Use the most specific type possible. Never use "any" as a shortcut — it defeats the purpose of type checking. Use "unknown" if the type is truly unknown, then narrow it. Define interfaces/types for all function parameters and return values.',
    phase: PHASES.IMPLEMENTATION,
    category: CATEGORIES.GENERAL,
    steps: ['Define interfaces for all data structures', 'Type all function parameters and return values', 'Use unknown + type guards instead of any', 'Use generics for reusable patterns'],
    triggers: ['Writing a new function signature', 'Using "any" as a type', 'Type checker reports implicit any', 'Working with untyped external data'],
    preconditions: ['You are writing TypeScript or typed JavaScript'],
    postconditions: ['No "any" types in codebase', 'All function signatures are typed', 'External data is validated and typed at boundaries'],
  },
  {
    title: 'Async/await: parallel when possible',
    content: 'Use Promise.all for independent async operations — don\'t await them sequentially. Only serialize when one operation depends on the result of another. This can reduce execution time dramatically for multi-step workflows.',
    phase: PHASES.IMPLEMENTATION,
    category: CATEGORIES.GENERAL,
    steps: ['Identify independent async operations', 'Group them in Promise.all or Promise.allSettled', 'Only await sequentially when one depends on another', 'Handle partial failures with allSettled when appropriate'],
    triggers: ['Multiple await calls in sequence', 'Operations that don\'t depend on each other', 'Page loading fetches that could run in parallel'],
    preconditions: ['Multiple async operations need to run'],
    postconditions: ['Independent operations run concurrently', 'Sequential awaits only for dependent operations', 'Execution time is minimized'],
  },
  {
    title: 'Magic numbers: use named constants',
    content: 'Replace unexplained numeric or string literals with well-named constants. A reader should understand WHY a value was chosen. 86400 means nothing; SECONDS_PER_DAY explains the intent. Use ALL_CAPS for constants.',
    phase: PHASES.IMPLEMENTATION,
    category: CATEGORIES.CLEAN_CODE,
    steps: ['Find unexplained numeric or string literals', 'Create a named constant with descriptive name', 'Group related constants together', 'Document units and ranges if not obvious'],
    triggers: ['Numeric literals in code without explanation', 'String literals that encode business rules', 'Thresholds, timeouts, limits without documentation'],
    preconditions: ['Code contains unexplained literal values'],
    postconditions: ['All significant literals have named constants', 'Constant names explain intent, not just value', 'Related constants are grouped'],
  },
  {
    title: 'Separate business logic from I/O and framework code',
    content: 'Keep business rules isolated from HTTP handlers, database queries, and UI components. Business logic should be testable without mocking frameworks. Put business rules in plain functions; put framework/I/O code in handlers/adapters.',
    phase: PHASES.IMPLEMENTATION,
    category: CATEGORIES.CLEAN_CODE,
    steps: ['Extract business logic from handlers/components', 'Create pure functions for business rules', 'Inject data dependencies, don\'t query them inside business logic', 'Test business logic independently of frameworks'],
    triggers: ['Business rules mixed with HTTP handlers', 'Testing requires mocking Express or database', 'UI component contains business calculations'],
    preconditions: ['Code has framework dependencies'],
    postconditions: ['Business logic is framework-independent', 'Business rules are testable in isolation', 'I/O code is thin and delegates to business logic'],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE: REVIEW & REFACTORING
  // ═══════════════════════════════════════════════════════════════════════

  {
    title: 'Surgical changes: touch only what you must',
    content: 'When editing existing code, don\'t "improve" adjacent code, comments, or formatting. Don\'t refactor things that aren\'t broken. Match existing style, even if you\'d do it differently. If you notice unrelated dead code, mention it — don\'t delete it. Every changed line should trace directly to the user\'s request.',
    phase: PHASES.REVIEW,
    category: CATEGORIES.KARPATHY,
    steps: ['Identify the minimum set of lines that must change', 'Change only those lines', 'Match the existing style exactly (quotes, spacing, patterns)', 'Mention but don\'t touch unrelated issues'],
    triggers: ['Modifying existing code', 'Temptation to fix adjacent code', 'Unrelated improvements during a bug fix', 'Style differences from your preference'],
    preconditions: ['You are modifying existing, working code'],
    postconditions: ['Only requested changes appear in the diff', 'Existing style is preserved', 'No unrelated "improvements" introduced'],
  },
  {
    title: 'Goal-driven execution: define success criteria first',
    content: 'Transform tasks into verifiable goals. Instead of "add validation," write "tests for invalid inputs pass." Instead of "fix the bug," write "test that reproduces the bug now passes." For multi-step tasks, state a plan: Step → verify: check. Loop until all criteria are met.',
    phase: PHASES.REVIEW,
    category: CATEGORIES.KARPATHY,
    steps: ['Define verifiable success criteria before coding', 'Write tests that encode the criteria', 'Implement until tests pass', 'Verify no regression in existing tests'],
    triggers: ['Starting any non-trivial task', 'Bug fix without a reproduction test', 'Feature without clear acceptance criteria', 'Task is ambiguous: "make it better"'],
    preconditions: ['You are starting a task'],
    postconditions: ['All success criteria are verified', 'Tests encode the acceptance criteria', 'Task can be confirmed complete without manual checking'],
  },
  {
    title: 'Clean up your own orphans — remove your dead code',
    content: 'When your changes make imports, variables, or functions unused, remove them. This is YOUR responsibility as the author of the change. But don\'t remove pre-existing dead code unless explicitly asked. Every deletion should be traceable to your change.',
    phase: PHASES.REVIEW,
    category: CATEGORIES.KARPATHY,
    steps: ['After making changes, check for unused imports', 'Check for variables/functions that became dead', 'Remove only what YOUR changes orphaned', 'Don\'t touch pre-existing dead code'],
    triggers: ['After modifying code', 'Changed function signatures or removed calls', 'Linter reports unused imports or variables'],
    preconditions: ['You have modified existing code'],
    postconditions: ['No unused imports from your changes', 'No dead code created by your changes', 'Pre-existing dead code is untouched but noted'],
  },
  {
    title: 'Test structure: Arrange-Act-Assert (AAA)',
    content: 'Every test should have three clear sections: Arrange (set up data and mocks), Act (call the function under test), Assert (verify the result). Avoid mixing these phases. Each test should test one behavior. Test names should describe the scenario and expected outcome.',
    phase: PHASES.REVIEW,
    category: CATEGORIES.GENERAL,
    steps: ['Arrange: create inputs, mocks, and expected outputs', 'Act: call the function under test once', 'Assert: verify one behavior per test', 'Name tests: "returns X when Y" pattern'],
    triggers: ['Writing new tests', 'Test has no clear AAA structure', 'Test does multiple unrelated assertions', 'Test name doesn\'t describe the scenario'],
    preconditions: ['You are writing or reviewing tests'],
    postconditions: ['Tests follow AAA pattern', 'Each test verifies one behavior', 'Test names describe scenarios clearly'],
  },
  {
    title: 'LSP — Subtypes must be substitutable for base types',
    content: 'If code uses a base type, it must work correctly with any derived type without knowing which one. Derived classes should not throw NotImplementedError for inherited methods. Don\'t force inheritance where it breaks the contract — use composition instead.',
    phase: PHASES.REVIEW,
    category: CATEGORIES.SOLID,
    steps: ['Check if derived classes can be used anywhere the base is expected', 'Identify methods that throw in derived classes', 'Redesign hierarchy or use composition if LSP is violated', 'Test base-type code with derived instances'],
    triggers: ['Designing or reviewing class hierarchies', 'Derived class throws in inherited methods', 'Square extends Rectangle with surprising behavior', 'Code breaks when handed a derived type'],
    preconditions: ['Class hierarchy exists'],
    postconditions: ['Derived classes are fully substitutable', 'No surprises when using derived types', 'Violations are resolved via redesign or composition'],
  },
  {
    title: 'ISP — No client forced to depend on unused methods',
    content: 'Fat interfaces couple clients to irrelevant changes. Split large interfaces into small, focused ones. If a client implements methods it doesn\'t need (throws NotImplementedError or has empty stubs), the interface is too big. Each client should depend only on methods it actually uses.',
    phase: PHASES.REVIEW,
    category: CATEGORIES.SOLID,
    steps: ['Identify clients implementing unused methods', 'Split the interface into smaller role-specific interfaces', 'Clients implement only their relevant interface', 'Combine interfaces at the composition level if needed'],
    triggers: ['Interface has methods that not all implementors use', 'NotImplementedError in interface implementations', 'New client only needs a subset of existing interface'],
    preconditions: ['Interface exists with multiple methods'],
    postconditions: ['Every client uses every method it depends on', 'Interfaces are focused on a single role', 'No NotImplementedError stubs'],
  },

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE: ALL PHASES — ALWAYS ACTIVE
  // ═══════════════════════════════════════════════════════════════════════

  {
    title: 'Don\'t assume, don\'t hide confusion',
    content: 'If something is unclear, STOP. Name what\'s confusing. Ask for clarification. Don\'t guess, don\'t silently pick an interpretation, don\'t paper over uncertainty with plausible-sounding code. A five-minute clarification prevents hours of rework.',
    phase: PHASES.ALL,
    category: CATEGORIES.KARPATHY,
    steps: ['Recognize when something is unclear', 'Articulate exactly what is confusing', 'Ask a specific question', 'Confirm understanding before proceeding'],
    triggers: ['Unclear requirement', 'Ambiguous specification', 'Unexpected behavior in existing code', 'Multiple valid interpretations'],
    preconditions: ['Uncertainty exists about the task or code'],
    postconditions: ['Confusion is resolved before code is written', 'Understanding is confirmed with user or context'],
  },
  {
    title: 'Push back when a simpler approach exists',
    content: 'If you see a simpler approach than what was requested, say so. The user may not be aware of a better pattern, library, or technique. Frame it as a suggestion: "Here\'s a simpler way to achieve this. Would you prefer this approach?" Don\'t silently override — propose.',
    phase: PHASES.ALL,
    category: CATEGORIES.KARPATHY,
    steps: ['Recognize when a simpler alternative exists', 'Articulate the tradeoff between approaches', 'Propose the simpler approach', 'Let the user decide'],
    triggers: ['Requested approach seems overcomplicated', 'A simpler pattern/library/technique could work', 'User may not know about alternatives'],
    preconditions: ['A viable simpler alternative exists'],
    postconditions: ['User has considered the tradeoff', 'Decision is explicit, not assumed'],
  },
  {
    title: 'Match existing patterns and conventions',
    content: 'When adding code to an existing project, match the project\'s established patterns, naming conventions, styling, and architecture. Consistency is more important than your personal preference. Read surrounding code before writing new code.',
    phase: PHASES.ALL,
    category: CATEGORIES.GENERAL,
    steps: ['Read surrounding code before writing', 'Identify project conventions (naming, structure, style)', 'Mirror those conventions exactly', 'Follow the same patterns for error handling, imports, exports'],
    triggers: ['Adding code to an existing project', 'First contribution to a codebase', 'Choosing between your preference and existing style'],
    preconditions: ['Project has existing code and conventions'],
    postconditions: ['New code is indistinguishable in style from existing code', 'Conventions are followed consistently'],
  },
  {
    title: 'Code for readability, not cleverness',
    content: 'Write code that a tired teammate at 3 AM can understand. Avoid clever tricks, metaprogramming for simple cases, and cryptic one-liners. Clear beats clever every time. If your solution makes you feel smart, it\'s probably too complex.',
    phase: PHASES.ALL,
    category: CATEGORIES.GENERAL,
    steps: ['Write the clearest version first', 'Replace clever patterns with explicit code if unclear', 'Use intermediate variables instead of nested expressions', 'If it needs a comment to be understood, simplify it'],
    triggers: ['Reviewing code you just wrote', 'Temptation to use metaprogramming or complex patterns', 'A solution makes you feel clever', 'Code requires mental effort to parse'],
    preconditions: ['You are writing or reviewing code'],
    postconditions: ['Code is understandable on first read', 'No tricks that require explanation', 'Intermediate values have clear names'],
  },
  {
    title: 'Verify before considering done: run the tests',
    content: 'Before marking a task complete, verify the solution works. Run the tests. Run the linter. Check for type errors. If the project has a CI pipeline, make sure the local equivalent passes. Never ship untested code.',
    phase: PHASES.ALL,
    category: CATEGORIES.GENERAL,
    steps: ['Run the test suite for affected code', 'Run linting and type checking', 'Fix any failures before declaring done', 'Check for regressions in related functionality'],
    triggers: ['Finishing an implementation', 'Before committing code', 'Before requesting a review'],
    preconditions: ['You have made code changes'],
    postconditions: ['All tests pass', 'No lint or type errors', 'No regressions introduced'],
  },
  {
    title: 'Comments explain WHY, not WHAT',
    content: 'Code should be self-documenting for WHAT it does. Comments explain WHY it does it that way — the context, the tradeoff, the reason for a non-obvious choice. Don\'t comment the obvious. Don\'t leave commented-out code in the codebase.',
    phase: PHASES.ALL,
    category: CATEGORIES.CLEAN_CODE,
    steps: ['Read the code — is the intent clear without comments?', 'Add comments only for WHY, not WHAT', 'Remove commented-out code', 'Keep comments up to date with code changes'],
    triggers: ['Writing or reviewing comments', 'Non-obvious design choice needs explanation', 'Commented-out code in the codebase'],
    preconditions: ['You are writing or reviewing code with comments'],
    postconditions: ['Comments explain intent and tradeoffs', 'No obvious comments describing what the code does', 'No stale or commented-out code'],
  },
];

// ─── Context Generation ───────────────────────────────────────────────

/**
 * Generate the standards section for context injection.
 * Organized by development phase so agents see relevant standards
 * based on what they're currently doing.
 *
 * @returns {string} Markdown-formatted standards block
 */
function getStandardsContext() {
  const phases = [
    { key: PHASES.ALL, label: '🔴 Always Active — Every Phase' },
    { key: PHASES.PLANNING, label: '🟡 Planning & Design Phase' },
    { key: PHASES.IMPLEMENTATION, label: '🟢 Implementation & Coding Phase' },
    { key: PHASES.REVIEW, label: '🔵 Review & Refactoring Phase' },
  ];

  let block = '## 🔧 Coding Standards (auto-injected — ALWAYS in effect)\n\n';
  block += 'These standards are pre-loaded and always active. You MUST apply them at every phase of development. They are not optional — they are the rules of the system.\n\n';

  // Brief Karpathy summary at the top
  block += '### 🧠 Core Principles (Karpathy Guidelines)\n';
  block += '- **Think before coding** — Surface assumptions, ask when uncertain, present tradeoffs.\n';
  block += '- **Simplicity first** — Minimum code. No bloat. No speculative abstractions.\n';
  block += '- **Surgical changes** — Touch only what you must. Match existing style.\n';
  block += '- **Goal-driven execution** — Define verifiable criteria. Loop until verified.\n\n';

  for (const phase of phases) {
    const standards = ALL_STANDARDS.filter(s => s.phase === phase.key);
    if (standards.length === 0) continue;

    block += `### ${phase.label}\n`;
    for (const s of standards) {
      // Show category badge
      const badge = `[${s.category.toUpperCase()}]`;
      block += `- **${s.title}** ${badge}\n`;
      // Show triggers as a quick-reference
      if (s.triggers.length > 0) {
        const quickTriggers = s.triggers.slice(0, 3).join('; ');
        block += `  *When:* ${quickTriggers}\n`;
      }
    }
    block += '\n';
  }

  return block;
}

/**
 * Get all standards as structured instruction observation data,
 * ready to be saved via the API's save() function.
 *
 * @param {string} project - Project path
 * @returns {Array<Object>} Observation-ready standard definitions
 */
function getStandardsAsObservations(project) {
  return ALL_STANDARDS.map(s => ({
    project,
    type: 'instruction',
    title: s.title,
    content: s.content,
    tags: ['coding-standard', 'best-practice', s.category, s.phase],
    importance: 9,
    confidence: 95,
    provenance: 'explicit',
    project_scope: 'global',
    steps: s.steps,
    triggers: s.triggers,
    preconditions: s.preconditions,
    postconditions: s.postconditions,
  }));
}

// ─── Seeding ──────────────────────────────────────────────────────────

/**
 * Check if coding standards exist in the project and seed them if not.
 * Called automatically by init() — no user action required.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @returns {Promise<{seeded: number, skipped: number, alreadyExisted: boolean}>}
 */
async function ensureStandardsExist(db, project, saveFn) {
  // Check if any standards already exist
  const existing = db.prepare(
    "SELECT COUNT(*) as c FROM observations WHERE project_path = ? AND tags LIKE '%coding-standard%' AND is_active = 1"
  ).get(project);

  if (existing.c >= ALL_STANDARDS.length) {
    return { seeded: 0, skipped: 0, alreadyExisted: true };
  }

  if (!saveFn) {
    console.warn('[standards] No save function provided — cannot seed standards');
    return { seeded: 0, skipped: 0, alreadyExisted: false };
  }

  const observations = getStandardsAsObservations(project);
  let seeded = 0;
  let skipped = 0;

  for (const obs of observations) {
    try {
      // Check for existing by title to avoid duplicates
      const titleMatch = db.prepare(
        'SELECT id FROM observations WHERE project_path = ? AND title = ? AND is_active = 1'
      ).get(project, obs.title);

      if (titleMatch) {
        skipped++;
        continue;
      }

      await saveFn(obs);
      seeded++;
    } catch (err) {
      console.warn('[standards] Failed to seed standard "%s": %s', obs.title, err.message);
      skipped++;
    }
  }

  if (seeded > 0) {
    console.error('[standards] Seeded %d coding standards for project %s (%d already existed)', seeded, project, skipped);
  }

  return { seeded, skipped, alreadyExisted: false };
}

// ─── Querying ─────────────────────────────────────────────────────────

/**
 * List all active coding standards for a project.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @param {Object} [opts] - { phase?, category?, limit? }
 * @returns {Array<Object>}
 */
function listStandards(db, project, opts = {}) {
  let sql = "SELECT id, title, content, tags, confidence, predicted_utility, freshness_score, steps, triggers FROM observations WHERE project_path = ? AND is_active = 1 AND tags LIKE '%coding-standard%'";
  const params = [project];

  if (opts.phase) {
    sql += " AND tags LIKE ?";
    params.push(`%${opts.phase}%`);
  }
  if (opts.category) {
    sql += " AND tags LIKE ?";
    params.push(`%${opts.category}%`);
  }

  sql += ' ORDER BY predicted_utility DESC, confidence DESC LIMIT ?';
  params.push(opts.limit || 50);

  return db.prepare(sql).all(...params);
}

/**
 * Search coding standards by query text.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @param {string} query
 * @param {number} [limit=10]
 * @returns {Array<Object>}
 */
function searchStandards(db, project, query, limit = 10) {
  return db.prepare(
    `SELECT id, title, content, tags, confidence, predicted_utility
     FROM observations
     WHERE project_path = ? AND is_active = 1
       AND tags LIKE '%coding-standard%'
       AND (title LIKE ? OR content LIKE ?)
     ORDER BY predicted_utility DESC
     LIMIT ?`
  ).all(project, `%${query}%`, `%${query}%`, limit);
}

// ─── Exports ──────────────────────────────────────────────────────────

module.exports = {
  ALL_STANDARDS,
  PHASES,
  CATEGORIES,
  getStandardsContext,
  getStandardsAsObservations,
  ensureStandardsExist,
  listStandards,
  searchStandards,
};
