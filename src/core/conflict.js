/**
 * conflict.js — Conflict detection for agentic-cortex.
 *
 * Detects potentially contradictory observations using semantic similarity
 * (cosine similarity > 0.65 on embeddings) and optional LLM verification.
 * Pairs with high similarity but different content are flagged as conflicts.
 *
 * @module core/conflict
 */

'use strict';

const { cosineSimilarity } = require('./embedding');
const { callLLM } = require('./session');

/**
 * Detect conflicting observations within a project.
 * Compares embedded observation pairs using cosine similarity and
 * optionally asks the LLM to verify contradictions.
 *
 * @param {import('better-sqlite3').Database} db - Database instance
 * @param {Object} opts - Conflict detection options
 * @param {string} [opts.project] - Project path to scan (defaults to AGENTIC_CORTEX_PROJECT or cwd)
 * @param {number} [opts.limit=10] - Maximum number of conflict pairs to return
 * @param {boolean} [opts.autoResolve=false] - Enable LLM contradiction verification
 * @returns {{ conflicts: Array<Object>, totalFound: number, project: string }}
 */
async function checkConflicts(db, opts) {
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const limit = opts.limit || 10;

  // Fetch recent embedded observations for the project
  const embedded = db.prepare(
    'SELECT id, type, title, content, confidence, provenance, embedding ' +
    'FROM observations WHERE project_path = ? AND is_active = 1 AND embedding IS NOT NULL ' +
    'ORDER BY id DESC LIMIT ?'
  ).all(project, 100);

  if (embedded.length < 2) {
    return { conflicts: [], totalFound: 0, project };
  }

  // Compare all pairs for high semantic similarity
  const conflicts = [];
  for (let i = 0; i < embedded.length; i++) {
    for (let j = i + 1; j < embedded.length; j++) {
      try {
        const vecA = JSON.parse(embedded[i].embedding);
        const vecB = JSON.parse(embedded[j].embedding);
        const sim = cosineSimilarity(vecA, vecB);

        // High similarity but potentially conflicting
        if (sim > 0.65) {
          conflicts.push({
            a: {
              id: embedded[i].id,
              type: embedded[i].type,
              title: embedded[i].title,
              confidence: embedded[i].confidence,
              preview: embedded[i].content.slice(0, 150),
            },
            b: {
              id: embedded[j].id,
              type: embedded[j].type,
              title: embedded[j].title,
              confidence: embedded[j].confidence,
              preview: embedded[j].content.slice(0, 150),
            },
            similarity: Math.round(sim * 1000) / 1000,
          });
        }
      } catch {
        // Skip pairs with unparseable embeddings
      }
    }
  }

  conflicts.sort((a, b) => b.similarity - a.similarity);
  const top = conflicts.slice(0, limit);

  // Optional LLM verification for each conflict pair (parallelized)
  await Promise.allSettled(
    top.map(async (c) => {
      try {
        const llmCheck = await callLLM([
          { role: 'system', content: 'You detect contradictions between two pieces of information. Answer ONLY "YES" or "NO".' },
          { role: 'user', content: 'Do these two observations contradict each other?\nA: ' + c.a.preview + '\nB: ' + c.b.preview },
        ], { temperature: 0, maxTokens: 10, timeout: 30000 });
        c.llm_contradiction = llmCheck && llmCheck.toUpperCase().startsWith('YES');
      } catch {
        c.llm_contradiction = null; // LLM unavailable — treat as inconclusive
      }
    })
  );

  return { conflicts: top, totalFound: conflicts.length, project };
}

module.exports = { checkConflicts };
