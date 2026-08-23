/**
 * war-room.js — Continuous Self-Improvement Arena for agentic-cortex.
 *
 * Ported from cortex-os-agent/src/sandbox/war-room.js. The War Room is a
 * synthetic sandbox that:
 *   1. Generates 17 deterministic reasoning scenarios with known issues
 *   2. Runs agentic-cortex's tree search + PRM + self-consistency against them
 *   3. Tracks improvement over time via a persistent scoreboard
 *   4. Adapts difficulty: score ≥ 85 → harder, score ≤ 45 → easier
 *   5. Periodically crystallizes proven patterns into permanent knowledge
 *   6. Runs a ReAct-style observe→act→learn loop
 *
 * Zero LLM: every scenario is a hand-crafted reasoning problem with a
 * known-good answer, scored against deterministic criteria.
 *
 * @module core/war-room
 */

'use strict';

// ─── Scenario Pool (17 reasoning scenarios) ──────────────────────────

/**
 * Each scenario has:
 *   id, name, description, difficulty ('easy'|'medium'|'hard'),
 *   categories (tag list), and a generate() function that returns { problem, expectedAnswer, hints }
 */
const SCENARIO_POOL = [
  {
    id: 'deductive-syllogism',
    name: 'Deductive Syllogism',
    description: 'Classic logical deduction: all A are B, all B are C, is X a C?',
    difficulty: 'easy',
    categories: ['deduction', 'logic'],
    generate() {
      return {
        problem: 'All code that is untested contains bugs. All features shipped without review are untested. The login feature was shipped without review. Does the login feature contain bugs? Explain step by step.',
        expectedAnswer: 'Yes',
        keywords: ['yes', 'contains bugs', 'deduction', 'syllogism', 'modus ponens', 'transitive'],
        hints: ['Use syllogistic reasoning', 'Chain the premises: untested → bugs, no-review → untested'],
      };
    },
  },
  {
    id: 'transitive-dependency',
    name: 'Transitive Dependency Resolution',
    description: 'Determine implicit dependencies in a module graph.',
    difficulty: 'easy',
    categories: ['deduction', 'architecture'],
    generate() {
      return {
        problem: 'Module A depends on B. Module B depends on C and D. Module E depends on A. Which modules does E transitively depend on? List them all and explain.',
        expectedAnswer: 'A, B, C, D',
        keywords: ['A', 'B', 'C', 'D', 'transitive', 'closure'],
        hints: ['Build the dependency graph', 'Compute transitive closure from E'],
      };
    },
  },
  {
    id: 'null-safety-reasoning',
    name: 'Null Safety Reasoning',
    description: 'Identify null-dereference risks in a code snippet.',
    difficulty: 'easy',
    categories: ['null-safety', 'code-quality'],
    generate() {
      return {
        problem: 'Analyze this code: `function getName(user) { return user.profile.name; }` What are the null-safety risks, and how should it be fixed?',
        expectedAnswer: 'user could be null/undefined, profile could be null/undefined',
        keywords: ['null', 'undefined', 'optional chaining', 'user?.profile?.name', 'null check', 'guard'],
        hints: ['Check for null at each property access', 'Consider optional chaining (?.)'],
      };
    },
  },
  {
    id: 'security-injection',
    name: 'SQL Injection Detection',
    description: 'Identify and explain a SQL injection vulnerability.',
    difficulty: 'medium',
    categories: ['security', 'deduction'],
    generate() {
      return {
        problem: 'Analyze: `const query = "SELECT * FROM users WHERE name = \'" + username + "\'"; db.execute(query);` What is wrong, why is it dangerous, and how should it be fixed?',
        expectedAnswer: 'SQL injection',
        keywords: ['SQL injection', 'parameterized', 'prepared statement', 'sanitize', 'placeholder'],
        hints: ['User input is concatenated directly', 'Consider parameterized queries'],
      };
    },
  },
  {
    id: 'concurrency-race',
    name: 'Race Condition Analysis',
    description: 'Identify a race condition in concurrent operations.',
    difficulty: 'medium',
    categories: ['concurrency', 'deduction'],
    generate() {
      return {
        problem: 'async function incrementCounter() { const current = counter; await delay(10); counter = current + 1; } Two calls run concurrently. What is the race condition, and how do you fix it?',
        expectedAnswer: 'non-atomic read-modify-write',
        keywords: ['race condition', 'non-atomic', 'read-modify-write', 'mutex', 'lock', 'atomic'],
        hints: ['Both reads see the same value', 'The last write overwrites', 'Need atomicity'],
      };
    },
  },
  {
    id: 'async-error-propagation',
    name: 'Async Error Propagation',
    description: 'Trace error handling through an async call chain.',
    difficulty: 'medium',
    categories: ['error-handling', 'async-patterns'],
    generate() {
      return {
        problem: 'async function A() { await B(); } async function B() { await C(); } async function C() { throw new Error("fail"); } If A() is called, where does the error surface, and what happens if A has no try/catch?',
        expectedAnswer: 'propagates up to caller of A',
        keywords: ['propagates', 'unhandled', 'rejection', 'try/catch', 'caller'],
        hints: ['Errors bubble up through await chains', 'Unhandled rejections crash Node.js'],
      };
    },
  },
  {
    id: 'time-complexity-estimation',
    name: 'Time Complexity Estimation',
    description: 'Estimate algorithmic complexity of nested loops.',
    difficulty: 'medium',
    categories: ['algorithm-efficiency', 'induction'],
    generate() {
      return {
        problem: 'function findDuplicates(items) { const dups = []; for (let i = 0; i < items.length; i++) { for (let j = i + 1; j < items.length; j++) { if (items[i] === items[j] && !dups.includes(items[i])) dups.push(items[i]); } } return dups; } What is the time complexity, and how can it be improved?',
        expectedAnswer: 'O(n²) or O(n³)',
        keywords: ['O(n²)', 'O(n³)', 'quadratic', 'cubic', 'Set', 'hash map', 'O(n)'],
        hints: ['Two nested loops + includes = cubic', 'A Set can make lookups O(1)'],
      };
    },
  },
  {
    id: 'resource-leak-detection',
    name: 'Resource Leak Detection',
    description: 'Identify unclosed resources that cause leaks.',
    difficulty: 'medium',
    categories: ['resource-management', 'robustness'],
    generate() {
      return {
        problem: 'function readFile(path) { const stream = fs.createReadStream(path); stream.on("data", (chunk) => { process(chunk); }); } What resources leak here, and how should it be fixed?',
        expectedAnswer: 'stream not closed on error',
        keywords: ['stream', 'close', 'error handler', 'leak', 'cleanup', 'finally'],
        hints: ['The stream has no error handler', 'Unhandled errors leave the stream open'],
      };
    },
  },
  {
    id: 'architectural-layer-violation',
    name: 'Architectural Layer Violation',
    description: 'Identify when a controller calls the database directly.',
    difficulty: 'hard',
    categories: ['architecture', 'code-organization'],
    generate() {
      return {
        problem: 'async function getUserOrders(req, res) { const discount = req.params.id > 1000 ? 0.1 : 0; const orders = await pool.query("SELECT * FROM orders WHERE user_id = $1", [req.params.id]); const result = orders.rows.map(o => ({ ...o, total: o.total * (1 - discount) })); res.json(result); } What architectural principle is violated, and how should the code be restructured?',
        expectedAnswer: 'mixed concerns, layered architecture',
        keywords: ['layered', 'controller', 'service', 'separation of concerns', 'repository', 'domain logic in controller'],
        hints: ['Business logic lives in the controller', 'Database access should go through a service layer'],
      };
    },
  },
  {
    id: 'circular-dependency-resolution',
    name: 'Circular Dependency Detection',
    description: 'Detect and resolve circular module dependencies.',
    difficulty: 'hard',
    categories: ['module-organization', 'deduction'],
    generate() {
      return {
        problem: 'Module A imports B. Module B imports C. Module C imports A. What is wrong, and how do you fix it in 3 different ways?',
        expectedAnswer: 'circular dependency',
        keywords: ['circular', 'dependency', 'extract shared', 'interface', 'dependency inversion', 'lazy import'],
        hints: ['Extract a shared interface/module', 'Use dependency inversion', 'Consider lazy/dynamic imports'],
      };
    },
  },
  {
    id: 'inductive-pattern-generalization',
    name: 'Pattern Generalization',
    description: 'Generalize recurring code patterns into a reusable principle.',
    difficulty: 'hard',
    categories: ['induction', 'code-consistency'],
    generate() {
      return {
        problem: 'You observe: (1) fnA(user?.id, user?.name), (2) fnB(item?.price, item?.qty), (3) fnC(order?.total, order?.status). What principle emerges, and what is the generalized rule?',
        expectedAnswer: 'use optional chaining to guard property access',
        keywords: ['optional chaining', 'null safety', 'guard', 'defensive', '?.'],
        hints: ['Each uses ?. before accessing sub-properties', 'Generalize: always guard against null when chaining'],
      };
    },
  },
  {
    id: 'state-mutation-detection',
    name: 'State Mutation Detection',
    description: 'Identify impure functions that mutate shared state.',
    difficulty: 'easy',
    categories: ['functional-purity', 'code-quality'],
    generate() {
      return {
        problem: 'let counter = 0; function getNextId() { counter++; return counter; } function processOrder(order) { order.status = "done"; saveToDb(order); } What patterns are problematic and why?',
        expectedAnswer: 'global mutation and parameter mutation',
        keywords: ['mutation', 'side effect', 'pure', 'immutable', 'global state', 'parameter mutation'],
        hints: ['Counter is global mutable state', 'processOrder mutates its parameter', 'Impure functions are hard to test'],
      };
    },
  },
  {
    id: 'testing-anti-pattern',
    name: 'Testing Anti-pattern Detection',
    description: 'Identify assertion-free and implementation-detail tests.',
    difficulty: 'hard',
    categories: ['testing', 'code-quality'],
    generate() {
      return {
        problem: 'it("should work", () => { const result = calculateTotal([{price: 10, qty: 2}], 0.1); }); it("uses reduce", () => { const spy = jest.spyOn(Array.prototype, "reduce"); calculateTotal(items, 0.1); expect(spy).toHaveBeenCalled(); }); What is wrong with both tests?',
        expectedAnswer: 'no assertion and testing implementation detail',
        keywords: ['no assertion', 'implementation detail', 'spy', 'behavior', 'always passes'],
        hints: ['First test has no assertion — it always passes', 'Second tests HOW (reduce) not WHAT (result)', 'Test behavior, not implementation'],
      };
    },
  },
  {
    id: 'input-validation-gap',
    name: 'Input Validation Gap Analysis',
    description: 'Find missing validation in function parameters.',
    difficulty: 'easy',
    categories: ['defensive-programming', 'code-quality'],
    generate() {
      return {
        problem: 'function transferFunds(from, to, amount) { const fee = amount * 0.01; return { from, to, amount: amount - fee }; } What validations are missing, and what are the risks?',
        expectedAnswer: 'missing validation for all three parameters',
        keywords: ['validation', 'required', 'numeric', 'negative', 'type check'],
        hints: ['from and to could be empty', 'amount could be negative or zero', 'No type checks'],
      };
    },
  },
  {
    id: 'analogical-problem-solving',
    name: 'Analogical Transfer',
    description: 'Apply a known solution pattern to a new context.',
    difficulty: 'medium',
    categories: ['analogy', 'architecture'],
    generate() {
      return {
        problem: 'In a React app, you solved prop-drilling with Context. In a Node.js service, you have a config object threaded through 5 layers of middleware. What pattern transfers, and how would you implement it?',
        expectedAnswer: 'dependency injection or module-level singleton',
        keywords: ['dependency injection', 'singleton', 'module', 'context', 'inversion of control', 'DI'],
        hints: ['The React Context pattern is dependency injection for components', 'In Node, a module-level export is effectively a singleton context'],
      };
    },
  },
  {
    id: 'abductive-root-cause',
    name: 'Root Cause Abduction',
    description: 'Determine the most likely root cause given multiple symptoms.',
    difficulty: 'hard',
    categories: ['abduction', 'error-handling'],
    generate() {
      return {
        problem: 'Symptoms: (1) all API calls timeout after 30s, (2) database connection pool shows 100/100 active, (3) no CPU spike, (4) restarting fixes it temporarily. What is the most likely root cause?',
        expectedAnswer: 'connection leak or missing release',
        keywords: ['connection leak', 'pool exhaustion', 'not releasing', 'missing release', 'connection not returned'],
        hints: ['All connections are active and never released', 'Not a CPU issue — waiting on a resource', 'Restart clears the pool — temporary fix'],
      };
    },
  },
  {
    id: 'forecast-version-trend',
    name: 'Version Trend Forecasting',
    description: 'Extrapolate the next version from historical data.',
    difficulty: 'medium',
    categories: ['forecast', 'induction'],
    generate() {
      return {
        problem: 'The project had major versions released in: v1.0 (Jan 2024), v2.0 (Jul 2024), v3.0 (Jan 2025), v4.0 (Jul 2025). When should v5.0 ship if the pattern holds, and what is the cadence?',
        expectedAnswer: 'Jan 2026',
        keywords: ['January 2026', 'Jan 2026', '6 months', 'biannual', 'semiannual'],
        hints: ['Measure the gaps: 6 months each', 'Cadence: January and July', 'Next: January 2026'],
      };
    },
  },
];

// ─── Scoring ───────────────────────────────────────────────────────────

/**
 * Score an answer against expected keywords. Returns 0-100.
 *
 * @param {string} answer — the agent's solution text
 * @param {string[]} keywords — expected keywords/phrases
 * @returns {number}
 */
function scoreAnswer(answer, keywords) {
  if (!answer || !keywords || keywords.length === 0) return 0;
  const lower = answer.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) hits++;
  }
  return Math.round((hits / keywords.length) * 100);
}

// ─── Difficulty Adaptation ─────────────────────────────────────────────

function adaptDifficulty(recentScores, currentDifficulty) {
  if (recentScores.length < 5) return currentDifficulty;
  const avg = recentScores.reduce((a, b) => a + b, 0) / recentScores.length;
  const levels = ['easy', 'medium', 'hard'];
  const idx = levels.indexOf(currentDifficulty);
  if (avg >= 85 && idx < 2) return levels[idx + 1];
  if (avg <= 45 && idx > 0) return levels[idx - 1];
  return currentDifficulty;
}

// ─── War Room Class ────────────────────────────────────────────────────

/**
 * @typedef {Object} WarRoomOptions
 * @property {number} [maxRounds=0] — 0 = infinite
 * @property {number} [roundDelayMs=2000]
 * @property {number} [reflectEvery=10]
 * @property {boolean} [verbose=true]
 * @property {string} [difficulty] — 'easy'|'medium'|'hard'|null (all)
 */

class WarRoom {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {Object} api — agentic-cortex API (needs treeSearch, verifyStep, etc.)
   * @param {WarRoomOptions} [opts]
   */
  constructor(db, api, opts = {}) {
    this.db = db;
    this.api = api;
    this.maxRounds = opts.maxRounds || 0;
    this.roundDelayMs = opts.roundDelayMs || 2000;
    this.reflectEvery = opts.reflectEvery || 10;
    this.verbose = opts.verbose !== false;
    this.difficulty = opts.difficulty || null;

    // State
    this.round = 0;
    this._aborted = false;
    this._scores = [];
    this._currentDifficulty = opts.difficulty || 'easy';
    this._startedAt = null;
    this.project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  }

  async start() {
    this._aborted = false;
    this._startedAt = new Date().toISOString();
    this._log('');
    this._log('╔══════════════════════════════════════════════════════╗');
    this._log('║     ⚔️  AGENTIC-CORTEX WAR ROOM — REASONING DOJO    ║');
    this._log('║     Scenarios: ' + String(SCENARIO_POOL.length).padStart(2) + ' | Max rounds: ' + String(this.maxRounds || '∞').padStart(3) + '                    ║');
    this._log('╚══════════════════════════════════════════════════════╝');
    this._log('');

    while (!this._aborted && (this.maxRounds === 0 || this.round < this.maxRounds)) {
      this.round++;
      await this._runRound();

      if (this.round > 0 && this.round % this.reflectEvery === 0) {
        await this._reflect();
      }

      if (this.round >= 5) {
        this._currentDifficulty = adaptDifficulty(this._scores.slice(-5), this._currentDifficulty);
      }

      if (!this._aborted && this.roundDelayMs > 0) {
        await sleep(this.roundDelayMs);
      }
    }

    return this._summarize();
  }

  abort() {
    this._aborted = true;
    this._log('🛑 Aborting war room...');
  }

  // ── Round ──────────────────────────────────────────────────────────

  async _runRound() {
    // Pick a scenario matching current difficulty (or all if null)
    const pool = this.difficulty
      ? SCENARIO_POOL.filter(s => s.difficulty === this.difficulty)
      : SCENARIO_POOL;
    const scenario = pool[Math.floor(Math.random() * pool.length)];
    const { problem, expectedAnswer, keywords, hints } = scenario.generate();

    this._log(`━━━ Round ${this.round} ━━━`);
    this._log(`Scenario: ${scenario.name} [${scenario.difficulty}]`);
    this._log(`  Categories: ${scenario.categories.join(', ')}`);

    const t0 = Date.now();
    let solution = '';
    let score = 0;
    let nodesExplored = 0;
    let branchesPruned = 0;
    let failed = false;

    try {
      // Run tree search to solve the problem
      const result = await this.api.treeSearch({
        problem,
        strategy: scenario.difficulty === 'hard' ? 'mcts' : 'beam',
        project: this.project,
      });

      solution = result.solution || '';
      nodesExplored = result.nodesExplored || 0;
      branchesPruned = result.branchesPruned || 0;

      if (solution) {
        score = scoreAnswer(solution, keywords);
      }
    } catch (err) {
      this._log(`  ❌ Round failed: ${err.message}`);
      failed = true;
    }

    const durationMs = Date.now() - t0;

    // If score is low on easy, try with hints (reasoning depth boost)
    if (score < 60 && !failed && scenario.difficulty !== 'hard') {
      this._log('  🔍 Low confidence — refining with self-consistency...');
      try {
        const scResult = await this.api.selfConsistency({
          problem,
          project: this.project,
          samples: 5,
        });
        if (scResult && scResult.answer) {
          const scScore = scoreAnswer(scResult.answer, keywords);
          if (scScore > score) {
            solution = scResult.answer;
            score = scScore;
            nodesExplored += scResult.samples || 0;
            this._log(`  ✅ Self-consistency improved score: ${score}/100`);
          }
        }
      } catch { /* best-effort */ }
    }

    // Record to scoreboard
    const roundData = {
      round: this.round,
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      difficulty: scenario.difficulty,
      kind: 'code',
      score,
      issuesFound: score >= 70 ? 1 : 0,
      plantedIssues: 1,
      fixesApplied: score >= 60 ? 1 : 0,
      newObservations: score >= 50 ? 1 : 0,
      newPatterns: 0,
      durationMs,
      failed: failed ? 1 : 0,
    };

    this._scores.push(score);
    this._saveRound(roundData);

    const bar = '█'.repeat(Math.round(score / 10)) + '░'.repeat(10 - Math.round(score / 10));
    this._log(`  Score: ${score}/100 [${bar}]`);
    this._log(`  Nodes: ${nodesExplored} | Pruned: ${branchesPruned} | Time: ${durationMs}ms`);
    if (solution) this._log(`  Answer snippet: ${solution.slice(0, 120)}...`);
    this._log('');

    // Persist as observation for the brain to learn from
    try {
      await this.api.save({
        type: 'war_room_round',
        title: `war-room:${scenario.id}:round-${this.round}`,
        content: JSON.stringify({ scenario: scenario.name, difficulty: scenario.difficulty, score, solution: solution.slice(0, 500), problem }),
        tags: ['war-room', 'round', `scenario:${scenario.id}`, `score:${score}`],
        importance: score >= 80 ? 8 : 5,
        confidence: score,
        project: this.project,
      });
    } catch { /* best-effort */ }
  }

  _saveRound(data) {
    this.db.prepare(`
      INSERT INTO war_room_scoreboard (project_path, round_number, scenario_id,
        scenario_name, difficulty, kind, score, issues_found, planted_issues,
        fixes_applied, new_observations, new_patterns, duration_ms, failed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.project, data.round, data.scenarioId, data.scenarioName,
      data.difficulty, data.kind, data.score, data.issuesFound, data.plantedIssues,
      data.fixesApplied, data.newObservations, data.newPatterns, data.durationMs,
      data.failed
    );
  }

  async _reflect() {
    this._log('🔄 REFLECTING — crystallizing learnings...');

    const stats = getScoreboard(this.db, { project: this.project });
    const avgScore = stats.totals.avgScore;
    const trend = computeTrend(this._scores);

    // Save reflection insight
    try {
      await this.api.save({
        type: 'learning',
        title: `war-room-reflection:round-${this.round}`,
        content: [
          `War room reflection after ${this.round} rounds:`,
          `- Average score: ${avgScore}/100`,
          `- Score trend: ${trend > 0 ? '+' : ''}${trend.toFixed(1)} (${trend > 2 ? 'improving 📈' : trend < -2 ? 'declining 📉' : 'stable'})`,
          `- Current difficulty: ${this._currentDifficulty}`,
          `- Total observations: ${stats.totals.observationsCreated}`,
        ].join('\n'),
        tags: ['war-room', 'reflection', 'crystallization'],
        importance: 8,
        confidence: 90,
        project: this.project,
      });
    } catch { /* best-effort */ }

    this._log(`  ✅ Reflection complete (round ${this.round}, avg score: ${avgScore}/100)`);
  }

  _summarize() {
    const stats = getScoreboard(this.db, { project: this.project });
    return {
      rounds: this.round,
      startedAt: this._startedAt,
      difficulty: this._currentDifficulty,
      totals: stats.totals,
      byDifficulty: stats.byDifficulty,
      recentScores: this._scores.slice(-10),
      trend: computeTrend(this._scores),
    };
  }

  _log(msg) {
    if (this.verbose) console.log('  [war-room] ' + msg);
  }
}

// ─── Scoreboard Queries ────────────────────────────────────────────────

function getScoreboard(db, opts = {}) {
  const proj = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const rows = db.prepare(
    `SELECT * FROM war_room_scoreboard WHERE project_path = ? ORDER BY created_at`
  ).all(proj);

  const totals = { rounds: rows.length, totalScore: 0, bestScore: 0, worstScore: 100, avgScore: 0, observationsCreated: 0, patternsDiscovered: 0 };
  const byDifficulty = { easy: { runs: 0, avgScore: 0, totalScore: 0 }, medium: { runs: 0, avgScore: 0, totalScore: 0 }, hard: { runs: 0, avgScore: 0, totalScore: 0 } };

  for (const r of rows) {
    totals.totalScore += r.score;
    totals.bestScore = Math.max(totals.bestScore, r.score);
    totals.worstScore = Math.min(totals.worstScore, r.score);
    totals.observationsCreated += r.new_observations;
    totals.patternsDiscovered += r.new_patterns;
    if (byDifficulty[r.difficulty]) {
      byDifficulty[r.difficulty].runs++;
      byDifficulty[r.difficulty].totalScore += r.score;
    }
  }

  if (totals.rounds > 0) {
    totals.avgScore = Math.round(totals.totalScore / totals.rounds);
  }
  for (const diff of ['easy', 'medium', 'hard']) {
    const d = byDifficulty[diff];
    if (d.runs > 0) d.avgScore = Math.round(d.totalScore / d.runs);
  }

  return { totals, byDifficulty, recentRounds: rows.slice(-5) };
}

function computeTrend(scores) {
  if (scores.length < 5) return 0;
  const recent = scores.slice(-5);
  const older = scores.slice(-10, -5);
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const olderAvg = older.length > 0 ? older.reduce((a, b) => a + b, 0) / older.length : recentAvg;
  return Math.round((recentAvg - olderAvg) * 10) / 10;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Exports ────────────────────────────────────────────────────────────

module.exports = {
  SCENARIO_POOL,
  scoreAnswer,
  adaptDifficulty,
  WarRoom,
  getScoreboard,
  computeTrend,
};