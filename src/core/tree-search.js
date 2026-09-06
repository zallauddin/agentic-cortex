/**
 * tree-search.js — Tree of Thoughts / MCTS reasoning engine for agentic-cortex.
 *
 * Implements inference-time graph search instead of greedy single-path decoding.
 * Maps directly to the architectures from:
 *   - Tree of Thoughts (Yao et al., 2023) — BFS/DFS over reasoning branches
 *   - MCTS (Zhou et al., LATS 2023) — Monte Carlo Tree Search with PRM feedback
 *   - Snell et al. (2024) — Compute-optimal allocation per difficulty
 *
 * Key design decisions:
 *   1. Tree nodes are reasoning steps (not raw tokens) — matches ToT paradigm
 *   2. Branch factor is adaptive (via adaptive-budget.js)
 *   3. Uses existing FSM transitions as the "action space" for each node
 *   4. PRM (prm.js) scores each step; bad branches are pruned early
 *   5. Backtracking is FSM-native: trigger reverse transitions
 *   6. Reflexion loop: failed paths become context for next attempts
 *
 * Integrates with existing modules:
 *   - FSM (fsm.js) — state transitions for each reasoning step
 *   - PRM (prm.js) — step-level verification
 *   - Adaptive Budget (adaptive-budget.js) — compute-optimal allocation
 *   - Rules (rules.js) — fires on pruning/completion events
 *   - Memory — stores reasoning traces and reflexion context
 *
 * @module core/tree-search
 */

'use strict';

const prm = require('./prm');
const adaptiveBudget = require('./adaptive-budget');
// Lazy resolution: tests (and hot-reload paths) patch session.callLLM at
// runtime; a destructured binding would freeze the original and silently
// bypass every mock/override.
function _callLLM() { return require('./session').callLLM; }
const replExecutor = require('./repl-executor');
const budgetForcing = require('./budget-forcing');

// Lazy-loaded dependencies
let _prompts = null;
let _saveFn = null;
let _searchFn = null;
let _db = null;

function _getPrompts() {
  if (!_prompts) _prompts = require('./prompts');
  return _prompts;
}

// ─── Reasoning Node ────────────────────────────────────────────────

/**
 * @typedef {Object} ReasoningNode
 * @property {number|null} id — DB ID (null for new nodes)
 * @property {number|null} parentId — Parent node ID
 * @property {number} stepIndex — Position in chain
 * @property {string} stepContent — The reasoning step text
 * @property {string} stepType — 'code' | 'reasoning' | 'plan'
 * @property {string|null} branchLabel — Label for this branch
 * @property {number} prmScore — PRM score 0.0-1.0
 * @property {boolean} isPruned — Whether this node was pruned
 * @property {boolean} isTerminal — Whether this is a leaf/goal node
 * @property {number} visitCount — MCTS visit count
 * @property {number} qValue — MCTS Q-value
 * @property {number[]} childrenIds — Child node IDs
 * @property {Object} verificationResult — Full PRM verification details
 * @property {string|null} executionOutput — REPL execution output if code
 */

function createNode({ id = null, parentId = null, stepIndex = 0, stepContent = '', stepType = 'reasoning', branchLabel = null, prmScore = 0, isPruned = false, isTerminal = false, visitCount = 0, qValue = 0, childrenIds = [], verificationResult = null, executionOutput = null }) {
  return {
    id, parentId, stepIndex, stepContent, stepType, branchLabel,
    prmScore, isPruned, isTerminal, visitCount, qValue, childrenIds,
    verificationResult, executionOutput,
  };
}

// ─── Reasoning Trace ───────────────────────────────────────────────

/**
 * @typedef {Object} ReasoningTrace
 * @property {number|null} id — DB ID
 * @property {string} problem — The problem being solved
 * @property {string} strategy — 'greedy' | 'beam' | 'mcts' | 'bfs'
 * @property {number} difficultyScore — 0-10
 * @property {ReasoningNode} rootNode — Root of the search tree
 * @property {number} nodesExplored — Counter
 * @property {number} tokensSpent — Token counter
 * @property {number} branchesPruned — Counter
 * @property {string} status — 'running' | 'completed' | 'pruned' | 'timeout' | 'budget_exhausted'
 * @property {Object} budget — Adaptive budget parameters
 * @property {ReasoningNode[]} allNodes — All nodes in tree (flat)
 * @property {ReasoningNode|null} bestNode — Best terminal node found
 */

function createTrace({ id = null, problem = '', strategy = 'beam', difficultyScore = 0, budget = {} }) {
  const root = createNode({ stepContent: problem, stepIndex: 0 });
  return {
    id, problem, strategy, difficultyScore,
    rootNode: root,
    nodesExplored: 1,
    tokensSpent: 0,
    branchesPruned: 0,
    status: 'running',
    budget,
    allNodes: [root],
    bestNode: null,
  };
}

// ─── Branch Generation (LLM) ───────────────────────────────────────

/**
 * Generate candidate next reasoning steps.
 * Calls the generate-reasoning-branches prompt template.
 *
 * @param {Object} params
 * @param {string} params.problem — Original problem
 * @param {string[]} params.currentChain — Steps taken so far
 * @param {number} params.branchCount — How many branches to generate
 * @param {number} params.budget — Remaining token budget
 * @param {Array<Object>} [params.memories] — Pre-retrieved brain evidence; when
 *   present, a compact block is injected so branches argue from memory
 * @returns {Promise<Array<{ content: string, type: string }>>}
 */
async function generateBranches({ problem, currentChain = [], branchCount = 3, budget = 2000, memories = null }) {
  const chainContext = currentChain.length > 0
    ? 'Steps taken so far:\n' + currentChain.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : 'No steps taken yet — this is the first reasoning step.';

  // Memory-informed generation: when the brain has evidence for this
  // problem, the branches are asked to argue FROM it, not reinvent it.
  const memoryContext = Array.isArray(memories) && memories.length > 0
    ? '\n\nRelevant memory evidence (consult it — argue from what the brain already knows, and do not contradict it without strong reason):\n' +
      memories.slice(0, 5).map((m, i) => `${i + 1}. [${m.type || 'memory'}${m.confidence != null ? ' · conf ' + m.confidence : ''}] ${m.title || ''}: ${String(m.content || '').slice(0, 200)}`).join('\n')
    : '';

  const messages = [
    {
      role: 'system',
      content: `You are a reasoning engine that explores multiple solution paths.
Given a problem and the reasoning chain so far, generate ${branchCount} DIFFERENT candidate next steps.

Each candidate should represent a DISTINCT approach:
- One should be the most obvious/straightforward step
- One should be a creative/unconventional approach
- One should be the most conservative/safe step

For each step, classify it as 'reasoning', 'code', or 'plan'.
The step should be specific and actionable, not vague.

Respond ONLY with valid JSON: {"branches": [{"content": "step text", "type": "reasoning|code|plan"}]}`,
    },
    {
      role: 'user',
      content: `Problem: ${problem}\n\n${chainContext}\n\nGenerate ${branchCount} candidate next steps:${memoryContext}`,
    },
  ];

  try {
    const result = await _callLLM()(messages, {
      temperature: 0.7, // Higher temperature for diversity
      maxTokens: Math.min(budget, 2000),
      timeout: 30000,
    });

    const parsed = JSON.parse(result || '{}');
    if (Array.isArray(parsed.branches) && parsed.branches.length > 0) {
      return parsed.branches.slice(0, branchCount);
    }
  } catch {}

  // Fallback: return generic branches
  return [
    { content: `Consider the most direct approach to: ${problem}`, type: 'reasoning' },
    { content: `Think about edge cases and potential issues with this problem`, type: 'reasoning' },
  ].slice(0, branchCount);
}

// ─── Goal Check (Terminal Node Detection) ───────────────────────────

/**
 * Check if a reasoning chain has reached a solution.
 *
 * @param {string} problem — Original problem
 * @param {string[]} chain — Current reasoning chain
 * @param {number} depth — Current depth
 * @param {number} maxDepth — Maximum allowed depth
 * @returns {Promise<{ reached: boolean, confidence: number }>}
 */
async function checkGoal({ problem, chain, depth, maxDepth }) {
  // Hard depth limit
  if (depth >= maxDepth) {
    return { reached: true, confidence: 0.5 };
  }

  const messages = [
    {
      role: 'system',
      content: `You determine if a reasoning chain has reached a solution.
The chain has reached a goal if:
- It contains a concrete answer/solution (not just analysis)
- The final step resolves the original problem
- It reaches a natural conclusion point

Respond ONLY with valid JSON: {"reached": true/false, "confidence": 0.0-1.0, "reason": "brief"}`,
    },
    {
      role: 'user',
      content: `Problem: ${problem}\n\nReasoning chain:\n${chain.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nHas this chain reached a solution?`,
    },
  ];

  try {
    const result = await _callLLM()(messages, {
      temperature: 0,
      maxTokens: 150,
      timeout: 10000,
    });

    const parsed = JSON.parse(result || '{}');
    return {
      reached: !!parsed.reached,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    };
  } catch {
    // Fallback: check chain length heuristic
    return { reached: chain.length >= 3, confidence: 0.4 };
  }
}

// ─── Shared Node Expander (LATS + Budget-Forcing integration) ───

/**
 * Expand branches from a node, running REPL verification for code-type
 * steps and budget-forcing when only one branch is available.
 *
 * LATS unification: if expandViaCode is set and a branch is code-typed,
 * the step gets executed in the REPL sandbox. The execution output is
 * stored in `executionOutput` and fed into the PRM verification context.
 *
 * Budget-forcing: when beamWidth is 1 (or only one valid branch exists
 * after filtering), instead of shallow verification, the path gets
 * deepened through multiple rounds of doubt prompting and reconsideration.
 */
async function _expandAndVerifyNode({ trace, node, chain, branches, problem, project, depth, db, searchFn, budget, expandViaCode = false, memories = null }) {
  const childNodes = [];
  let tokensAdded = 0;

  for (const branch of branches) {
    const childNode = createNode({
      parentId: node.id,
      stepIndex: depth + 1,
      stepContent: branch.content,
      stepType: branch.type || 'reasoning',
      branchLabel: `d${depth + 1}_${node.childrenIds.length + childNodes.length}`,
    });

    // ── REPL execution (LATS unification) ──
    if (expandViaCode && (branch.type === 'code' || childNode.stepType === 'code')) {
      try {
        const execResult = await replExecutor.verifyWithCode({
          hypothesis: branch.content,
          context: chain.join('\n'),
          project,
          db,
          budget: Math.min(1000, budget.tokenBudget - trace.tokensSpent - tokensAdded),
        });

        childNode.executionOutput = execResult.executionResult
          ? execResult.executionResult.output?.slice(0, 2000) : null;

        // Use execution result for verification: success = high PRM, failure = low
        const execScore = execResult.verified ? 0.85 : (execResult.success ? 0.4 : 0.15);

        const verification = {
          valid: execScore >= 0.3,
          score: execScore,
          tier: 'repl',
          reason: execResult.reason || `REPL execution ${execResult.verified ? 'confirmed' : (execResult.success ? 'ambiguous' : 'rejected')}`,
          details: { deterministic: { valid: execResult.verified, score: execScore, reason: 'REPL execution' } },
        };

        childNode.prmScore = verification.score;
        childNode.verificationResult = verification;
        tokensAdded += (branch.content || '').length / 2; // Rough estimate

        if (verification.score < 0.3) {
          childNode.isPruned = true;
          trace.branchesPruned++;
          trace.allNodes.push(childNode);
          continue;
        }
      } catch (e) {
        childNode.executionOutput = `REPL execution failed: ${e.message}`;
        childNode.prmScore = 0.5;
        childNode.verificationResult = { valid: true, score: 0.5, tier: 'repl-fallback', reason: `REPL unavailable: ${e.message}` };
      }
    } else {
      // ── Normal PRM verification ── the brain's evidence (pre-retrieved
      //    once for this search) scores every node, so the trace shows WHY
      //    each step was accepted or rejected in memory terms.
      const verification = await prm.verifyStep({
        stepContent: branch.content,
        priorSteps: chain,
        problem,
        stepType: branch.type || 'reasoning',
        project,
        db,
        searchFn,
        memories,
      });

      childNode.prmScore = verification.score;
      childNode.verificationResult = verification;
      tokensAdded += 200;

      if (verification.score < 0.3) {
        childNode.isPruned = true;
        trace.branchesPruned++;

        // Capture deeply-pruned branches. A deterministic hard-fail scores
        // exactly 0.2, so the boundary is inclusive (<= 0.2) — otherwise the
        // most clear-cut failures (unverified assumptions, bare conclusions)
        // never become lessons.
        if (_saveFn && verification.score <= 0.2) {
          // Awaited: the capture is part of the learning contract — callers
          // that inspect memory right after search() must see the lesson.
          try {
            await _saveFn({
              project,
              type: 'error',
              title: `Reasoning path pruned: ${branch.content.slice(0, 60)}`,
              content: `Step "${branch.content}" was pruned by PRM (score: ${verification.score}). Reason: ${verification.reason}`,
              tags: ['tree-search', 'prm-pruned', 'auto-capture'],
              importance: 4,
              provenance: 'inferred',
            });
          } catch { /* capture is best-effort */ }
        }

        trace.allNodes.push(childNode);
        continue;
      }
    }

    // Check if this is a terminal node (goal reached)
    const goalCheck = await checkGoal({
      problem,
      chain: [...chain, branch.content],
      depth: depth + 1,
      maxDepth: budget.maxDepth,
    });

    if (goalCheck.reached) {
      childNode.isTerminal = true;
      childNode.qValue = (childNode.prmScore || 0) * goalCheck.confidence;
      if (!trace.bestNode || childNode.qValue > trace.bestNode.qValue) {
        trace.bestNode = childNode;
      }
    }

    trace.allNodes.push(childNode);
    childNodes.push(childNode);
    node.childrenIds.push(childNode.id || trace.allNodes.length - 1);
  }

  // ── Budget-forcing: when only one valid branch remains, deepen it ──
  const validChildren = childNodes.filter(c => !c.isPruned);

  if (validChildren.length === 1 && budget.beamWidth === 1 && !validChildren[0].isTerminal) {
    const deepenNode = validChildren[0];
    const deepenChain = _getChain(trace, deepenNode);

    try {
      const bfResult = await budgetForcing.generateForcedChain({
        problem,
        config: {
          minTokens: budget.bfMinTokens || 100,
          maxTokens: Math.min(budget.tokenBudget - trace.tokensSpent - tokensAdded, 3000),
          maxRounds: Math.min(budget.bfMaxRounds || 3, 3),
          temperatureBase: 0.5,
        },
      });

      if (bfResult && bfResult.chain) {
        deepenNode.executionOutput = bfResult.chain;
        deepenNode.qValue = (deepenNode.prmScore || 0) * 0.9;
        deepenNode.isTerminal = true;

        if (!trace.bestNode || deepenNode.qValue > trace.bestNode.qValue) {
          trace.bestNode = deepenNode;
        }

        tokensAdded += bfResult.tokensUsed || 500;

        if (_saveFn) {
          _saveFn({
            project,
            type: 'context',
            title: `Budget-forced deepening: ${problem.slice(0, 60)}`,
            content: `Deepened single reasoning path through ${bfResult.rounds || '?'} rounds. Tokens: ${bfResult.tokensUsed || 0}`,
            tags: ['tree-search', 'budget-forcing', 'auto-capture'],
            importance: 5,
            provenance: 'inferred',
          }).catch(() => {});
        }
      }
    } catch (e) {
      // Budget-forcing failed — continue with the single node as-is
      console.warn('[tree-search] Budget-forcing failed:', e.message);
    }
  }

  return { childNodes, tokensAdded };
}

// ─── Tree Search Execution ─────────────────────────────────────────

/**
 * Run tree search on a problem using Beam Search strategy.
 * The simplest strategy: at each depth, keep the top-K branches.
 *
 * @param {Object} params
 * @param {string} params.problem — Problem to solve
 * @param {string} params.project — Project path
 * @param {Object} [params.db] — Database
 * @param {Object} [params.searchFn] — Memory search function
 * @param {Object} [params.budgetOverrides] — Override budget parameters
 * @returns {Promise<ReasoningTrace>}
 */
async function beamSearch({ problem, project = '', db = null, searchFn = null, budgetOverrides = {}, memories = null }) {
  // 1. Estimate difficulty and calculate budget. The retrieved brain
  //    evidence is threaded into node scoring and branch generation below
  //    — one consult per search, not one per node.
  if (!memories && searchFn) {
    try { memories = await searchFn(problem, { project, limit: 10 }); } catch { memories = []; }
  } else if (!memories) {
    memories = [];
  }

  const { score: difficulty } = adaptiveBudget.estimateDifficulty({
    problem, project, memories, db,
  });
  const budget = adaptiveBudget.calculateBudget(difficulty, budgetOverrides);

  const trace = createTrace({
    problem,
    strategy: budget.strategy,
    difficultyScore: difficulty,
    budget,
  });

  // 2. Search loop
  let currentFrontier = [trace.rootNode]; // Start with root
  let totalTokensSpent = 0;

  for (let depth = 0; depth < budget.maxDepth; depth++) {
    const nextFrontier = [];

    for (const node of currentFrontier) {
      if (node.isPruned || node.isTerminal) continue;

      // Get the chain up to this node
      const chain = _getChain(trace, node);

      // Generate branches
      const branches = await generateBranches({
        problem,
        currentChain: chain,
        branchCount: budget.beamWidth,
        budget: Math.max(200, budget.tokenBudget - totalTokensSpent),
        memories,
      });

      const result = await _expandAndVerifyNode({
        trace, node, chain, branches, problem, project, depth, db, searchFn, budget,
        expandViaCode: budgetOverrides.expandViaCode || false,
        memories,
      });

      totalTokensSpent += result.tokensAdded;
      for (const child of result.childNodes) {
        if (!child.isPruned) nextFrontier.push(child);
      }

      trace.nodesExplored++;
    }

    // Keep only top-K by PRM score for next frontier
    nextFrontier.sort((a, b) => b.prmScore - a.prmScore);
    currentFrontier = nextFrontier.slice(0, budget.beamWidth);

    // Budget check
    if (totalTokensSpent >= budget.tokenBudget) {
      trace.status = 'budget_exhausted';
      break;
    }

    // If no valid branches remain, search is exhausted
    if (currentFrontier.length === 0) {
      trace.status = 'pruned';
      break;
    }
  }

  trace.tokensSpent = totalTokensSpent;

  // If we found a terminal node, extract the solution
  if (trace.bestNode) {
    trace.status = 'completed';
  } else if (trace.status === 'running') {
    trace.status = 'completed'; // Completed search but no clear goal
  }

  return trace;
}

/**
 * Run tree search using MCTS strategy.
 * UCT-based selection with PRM as rollout reward.
 *
 * @param {Object} params — Same as beamSearch
 * @returns {Promise<ReasoningTrace>}
 */
async function mctsSearch({ problem, project = '', db = null, searchFn = null, budgetOverrides = {}, memories = null }) {
  // 1. Estimate difficulty and budget. The retrieved brain evidence is
  //    threaded into node scoring and branch generation below.
  if (!memories && searchFn) {
    try { memories = await searchFn(problem, { project, limit: 10 }); } catch { memories = []; }
  } else if (!memories) {
    memories = [];
  }

  const { score: difficulty } = adaptiveBudget.estimateDifficulty({
    problem, project, memories, db,
  });
  const budget = adaptiveBudget.calculateBudget(difficulty, { ...budgetOverrides, strategy: 'mcts' });

  const trace = createTrace({
    problem,
    strategy: 'mcts',
    difficultyScore: difficulty,
    budget,
  });

  let totalTokensSpent = 0;
  const maxIterations = budget.beamWidth * budget.maxDepth * 2; // Total MCTS iterations

  for (let iter = 0; iter < maxIterations; iter++) {
    if (totalTokensSpent >= budget.tokenBudget) {
      trace.status = 'budget_exhausted';
      break;
    }

    // 2. Selection — pick the most promising leaf via UCT
    const selected = _selectNode(trace);
    const chain = _getChain(trace, selected);

    // 3. Expansion — generate children if not terminal
    if (!selected.isTerminal && !selected.isPruned && chain.length < budget.maxDepth) {
      const branches = await generateBranches({
        problem,
        currentChain: chain,
        branchCount: Math.min(2, budget.beamWidth),
        budget: Math.max(200, budget.tokenBudget - totalTokensSpent),
        memories,
      });

      const result = await _expandAndVerifyNode({
        trace, node: selected, chain, branches, problem, project, depth: chain.length, db, searchFn, budget,
        expandViaCode: budgetOverrides.expandViaCode || false,
        memories,
      });

      totalTokensSpent += result.tokensAdded;
      for (const child of result.childNodes) {
        child.visitCount = 1;
        if (!child.isPruned) selected.childrenIds.push(child.id || trace.allNodes.length - 1);
      }

      trace.nodesExplored++;
    }

    // 5. Backpropagation — update Q-values up the tree
    _backpropagate(trace, selected);
  }

  trace.tokensSpent = totalTokensSpent;
  trace.status = trace.bestNode ? 'completed' : (trace.status === 'running' ? 'completed' : trace.status);

  return trace;
}

// ─── MCTS Helpers ──────────────────────────────────────────────────

/**
 * Select the most promising node using UCT.
 * Traverses from root, selecting children with highest UCT at each level.
 */
function _selectNode(trace) {
  let current = trace.rootNode;

  while (current.childrenIds.length > 0 && !current.isPruned) {
    const children = current.childrenIds
      .map(id => trace.allNodes[id])
      .filter(n => n && !n.isPruned);

    if (children.length === 0) break;

    // Select child with highest UCT
    let bestChild = children[0];
    let bestUct = -Infinity;

    for (const child of children) {
      const uct = adaptiveBudget.uctScore({
        qValue: child.qValue,
        visitCount: child.visitCount,
        parentVisits: current.visitCount,
      });

      if (uct > bestUct) {
        bestUct = uct;
        bestChild = child;
      }
    }

    current = bestChild;
  }

  return current;
}

/**
 * Backpropagate Q-values up the tree after a visit.
 */
function _backpropagate(trace, node) {
  let current = node;
  while (current) {
    current.visitCount++;
    // Update Q-value as running average
    const children = current.childrenIds
      .map(id => trace.allNodes[id])
      .filter(n => n);
    if (children.length > 0) {
      current.qValue = children.reduce((s, c) => s + c.qValue * c.visitCount, 0) /
        children.reduce((s, c) => s + c.visitCount, 0);
    }
    // Move to parent
    if (current.parentId != null && current.parentId < trace.allNodes.length) {
      current = trace.allNodes[current.parentId];
    } else {
      break;
    }
  }
}

// ─── Trace Utilities ───────────────────────────────────────────────

/**
 * Get the reasoning chain from root to a given node.
 * @returns {string[]}
 */
function _getChain(trace, targetNode) {
  const chain = [];
  let current = targetNode;
  while (current && current.parentId != null) {
    chain.unshift(current.stepContent);
    current = trace.allNodes[current.parentId];
  }
  // Include root step if it's different from the problem
  if (trace.rootNode && trace.rootNode.stepContent !== trace.problem) {
    chain.unshift(trace.rootNode.stepContent);
  }
  return chain;
}

/**
 * Extract the best solution from a completed trace.
 * @returns {{ solution: string, chain: string[], score: number, trace: Object }|null}
 */
function extractSolution(trace) {
  if (!trace.bestNode) return null;

  const chain = _getChain(trace, trace.bestNode);
  return {
    solution: trace.bestNode.stepContent,
    chain,
    score: trace.bestNode.qValue,
    trace: {
      id: trace.id,
      strategy: trace.strategy,
      difficultyScore: trace.difficultyScore,
      nodesExplored: trace.nodesExplored,
      branchesPruned: trace.branchesPruned,
      tokensSpent: trace.tokensSpent,
      status: trace.status,
    },
  };
}

/**
 * Convert a trace to a serializable object for DB storage and MCP response.
 */
function traceToJSON(trace) {
  return {
    id: trace.id,
    problem: trace.problem,
    strategy: trace.strategy,
    difficultyScore: trace.difficultyScore,
    status: trace.status,
    nodesExplored: trace.nodesExplored,
    tokensSpent: trace.tokensSpent,
    branchesPruned: trace.branchesPruned,
    budget: trace.budget,
    solution: trace.bestNode ? {
      content: trace.bestNode.stepContent,
      score: trace.bestNode.qValue,
      chain: _getChain(trace, trace.bestNode),
    } : null,
    tree: trace.allNodes.map(n => ({
      id: n.id, parentId: n.parentId, stepIndex: n.stepIndex,
      stepContent: n.stepContent ? n.stepContent.slice(0, 200) : '',
      prmScore: n.prmScore, isPruned: n.isPruned, isTerminal: n.isTerminal,
      visitCount: n.visitCount, qValue: n.qValue,
      // Why this node scored what it did — the brain evidence it was
      // checked against (corroborating vs contradicting memory titles).
      verificationResult: n.verificationResult ? {
        score: n.verificationResult.score,
        tier: n.verificationResult.tier,
        reason: n.verificationResult.reason,
        memory: n.verificationResult.details && n.verificationResult.details.memory
          ? {
              corroborating: (n.verificationResult.details.memory.corroboratingMemories || []).map(m => m.title || m.id),
              contradicting: (n.verificationResult.details.memory.contradictingMemories || []).map(m => m.title || m.id),
            }
          : null,
      } : null,
    })),
  };
}

// ─── Persistence ───────────────────────────────────────────────────

/**
 * Save a reasoning trace and its nodes to the database.
 */
function saveTrace(db, trace, project) {
  if (!db) return null;

  const r = db.prepare(`
    INSERT INTO reasoning_traces (problem, strategy, difficulty_score, root_node_id, best_node_id,
      nodes_explored, tokens_spent, branches_pruned, status, project_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    trace.problem, trace.strategy, trace.difficultyScore,
    null, null, // Node IDs set after node insert
    trace.nodesExplored, trace.tokensSpent, trace.branchesPruned,
    trace.status, project
  );

  const traceId = Number(r.lastInsertRowid);

  // Save nodes
  for (const node of trace.allNodes) {
    const nr = db.prepare(`
      INSERT INTO reasoning_nodes (trace_id, parent_id, step_index, step_content, step_type,
        branch_label, prm_score, is_pruned, prune_reason, is_terminal, visit_count, q_value,
        children_ids, verification_result, execution_output)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      traceId,
      node.parentId != null ? node.parentId : null,
      node.stepIndex,
      node.stepContent,
      node.stepType,
      node.branchLabel,
      node.prmScore,
      node.isPruned ? 1 : 0,
      node.verificationResult && !node.verificationResult.valid ? node.verificationResult.reason : null,
      node.isTerminal ? 1 : 0,
      node.visitCount,
      node.qValue,
      JSON.stringify(node.childrenIds),
      node.verificationResult ? JSON.stringify(node.verificationResult) : null,
      node.executionOutput || null,
    );
    node.id = Number(nr.lastInsertRowid);
  }

  // Update trace with node IDs
  if (trace.rootNode) {
    db.prepare('UPDATE reasoning_traces SET root_node_id = ? WHERE id = ?')
      .run(trace.rootNode.id, traceId);
  }
  if (trace.bestNode) {
    db.prepare('UPDATE reasoning_traces SET best_node_id = ? WHERE id = ?')
      .run(trace.bestNode.id, traceId);
  }

  trace.id = traceId;
  return traceId;
}

/**
 * Load a reasoning trace from the database.
 */
function loadTrace(db, traceId) {
  if (!db) return null;

  const row = db.prepare('SELECT * FROM reasoning_traces WHERE id = ?').get(traceId);
  if (!row) return null;

  const nodes = db.prepare('SELECT * FROM reasoning_nodes WHERE trace_id = ? ORDER BY step_index').all(traceId);

  return {
    id: row.id,
    problem: row.problem,
    strategy: row.strategy,
    difficultyScore: row.difficulty_score,
    status: row.status,
    nodesExplored: row.nodes_explored,
    tokensSpent: row.tokens_spent,
    branchesPruned: row.branches_pruned,
    projectPath: row.project_path,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    nodes: nodes.map(n => ({
      id: n.id, parentId: n.parent_id, stepIndex: n.step_index,
      stepContent: n.step_content, stepType: n.step_type,
      branchLabel: n.branch_label, prmScore: n.prm_score,
      isPruned: !!n.is_pruned, pruneReason: n.prune_reason,
      isTerminal: !!n.is_terminal, visitCount: n.visit_count,
      qValue: n.q_value, childrenIds: JSON.parse(n.children_ids || '[]'),
      verificationResult: n.verification_result ? JSON.parse(n.verification_result) : null,
      executionOutput: n.execution_output,
    })),
  };
}

// ─── Main Entry Point ──────────────────────────────────────────────

/**
 * Run tree search on a problem. Automatically selects strategy based on difficulty.
 *
 * @param {Object} params
 * @param {string} params.problem — Problem to solve
 * @param {string} [params.project] — Project path
 * @param {string} [params.strategy] — 'beam' | 'mcts' | 'auto'
 * @param {Object} [params.db] — Database
 * @param {Object} [params.searchFn] — Memory search function
 * @param {Object} [params.budgetOverrides] — Override budget parameters
 * @returns {Promise<Object>} Trace result
 */
async function search({ problem, project = '', strategy = 'auto', db = null, searchFn = null, budgetOverrides = {}, memories = null }) {
  const effectiveDb = db || _db;
  const effectiveSearch = searchFn || _searchFn;

  // One brain consult per search: the retrieved evidence feeds difficulty
  // estimation AND every node's PRM scoring and branch generation below.
  if (!memories && effectiveSearch) {
    try { memories = await effectiveSearch(problem, { project, limit: 10 }); } catch { memories = []; }
  } else if (!memories) {
    memories = [];
  }

  let trace;

  if (strategy === 'mcts') {
    trace = await mctsSearch({ problem, project, db: effectiveDb, searchFn: effectiveSearch, budgetOverrides, memories });
  } else if (strategy === 'beam') {
    trace = await beamSearch({ problem, project, db: effectiveDb, searchFn: effectiveSearch, budgetOverrides, memories });
  } else {
    // Auto: estimate difficulty first, then select strategy
    const { score: difficulty } = adaptiveBudget.estimateDifficulty({
      problem, project, memories, db: effectiveDb,
    });

    if (difficulty <= 2) {
      // Easy: greedy (single path)
      trace = await beamSearch({ problem, project, db: effectiveDb, searchFn: effectiveSearch, budgetOverrides: { beamWidth: 1, ...budgetOverrides }, memories });
    } else if (difficulty <= 5) {
      // Medium: beam search
      trace = await beamSearch({ problem, project, db: effectiveDb, searchFn: effectiveSearch, budgetOverrides, memories });
    } else {
      // Hard: MCTS
      trace = await mctsSearch({ problem, project, db: effectiveDb, searchFn: effectiveSearch, budgetOverrides, memories });
    }
  }

  // Persist to DB
  if (effectiveDb) {
    try {
      saveTrace(effectiveDb, trace, project);
    } catch (e) {
      console.warn('[tree-search] Failed to save trace:', e.message);
    }
  }

  // Save reflexion context for failed searches
  if (trace.status === 'pruned' || trace.status === 'budget_exhausted') {
    const reflexion = _buildReflexion(trace);
    if (reflexion && _saveFn) {
      _saveFn({
        project,
        type: 'context',
        title: `Tree search ${trace.status}: ${problem.slice(0, 60)}`,
        content: reflexion,
        tags: ['tree-search', 'reflexion', trace.status, 'auto-capture'],
        importance: 7,
        provenance: 'inferred',
      }).catch(() => {});
    }
  }

  return traceToJSON(trace);
}

/**
 * Build a reflexion message from a failed/completed trace.
 */
function _buildReflexion(trace) {
  const prunedBranches = trace.allNodes
    .filter(n => n.isPruned)
    .map(n => `"${n.stepContent.slice(0, 100)}" — ${n.verificationResult?.reason || 'PRM rejected'}`)
    .slice(0, 3);

  if (prunedBranches.length === 0) return null;

  return [
    `Tree search ${trace.strategy} explored ${trace.nodesExplored} nodes, pruned ${trace.branchesPruned} branches.`,
    `Problem: ${trace.problem}`,
    `Status: ${trace.status}`,
    '',
    'Pruned paths (avoid these approaches):',
    ...prunedBranches,
    '',
    'Use this context to guide future reasoning on this problem.',
  ].join('\n');
}

// ─── Dependency Injection ──────────────────────────────────────────

function setSaveFunction(fn) { _saveFn = fn; }
function setSearchFunction(fn) { _searchFn = fn; }
function setDb(db) { _db = db; }

// ─── Exports ────────────────────────────────────────────────────────

module.exports = {
  // Core algorithms
  beamSearch,
  mctsSearch,
  search,

  // Utilities
  createNode,
  createTrace,
  generateBranches,
  checkGoal,
  extractSolution,
  traceToJSON,
  _getChain,
  _buildReflexion,
  _expandAndVerifyNode,

  // Persistence
  saveTrace,
  loadTrace,

  // Dependency injection
  setSaveFunction,
  setSearchFunction,
  setDb,
};
