/**
 * reflection.js — Reflection & Consolidation for agentic-cortex.
 *
 * Provides three core operations that help maintain a clean, useful
 * knowledge base over time:
 *
 * 1. consolidateMemories — Merge semantically similar observations into
 *    a single canonical entry. Keeps the highest-confidence version,
 *    archives the rest, and records a 'supersedes' relation.
 *
 * 2. promotePatterns — Detect recurring patterns (repeated tags, types,
 *    topics) and create "pattern" observations that summarize the
 *    recurring theme. Useful for extracting learnings from noise.
 *
 * 3. archiveSuperseded — Find and soft-delete observations that have
 *    been superseded by newer, higher-confidence versions on the same
 *    topic. Keeps history in observation_versions but cleans the active
 *    index.
 *
 * @module core/reflection
 */

'use strict';

const { cosineSimilarity } = require('./embedding');
const { callLLM } = require('./session');
const embedding = require('./embedding');

// Save function injected to avoid circular dependency on src/api
let _saveFn = null;  // (opts) => Promise<{id, status, ...}>

/**
 * Default similarity threshold for consolidation.
 * Pairs above this are candidates for merging.
 * @type {number}
 */
const DEFAULT_CONSOLIDATE_THRESHOLD = 0.85;

/**
 * Default minimum occurrences for a pattern to be promoted.
 * @type {number}
 */
const DEFAULT_PATTERN_MIN_COUNT = 3;

/**
 * Default age (days) before an observation can be auto-archived if superseded.
 * @type {number}
 */
const DEFAULT_ARCHIVE_AGE_DAYS = 30;

/**
 * Default confidence threshold for auto-extracting skills from learnings.
 * Actual threshold varies by project maturity (see _projectRelativeThreshold).
 * @type {number}
 */
const DEFAULT_SKILL_CONFIDENCE_THRESHOLD = 80;

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Get recent embedded observations for a project.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @param {number} limit
 * @returns {Array<Object>} Observations with parsed embeddings
 */
function getEmbeddedObservations(db, project, limit = 200) {
  const rows = db.prepare(
    'SELECT id, type, title, content, confidence, provenance, embedding, created_at ' +
    'FROM observations WHERE project_path = ? AND is_active = 1 AND embedding IS NOT NULL ' +
    'ORDER BY created_at DESC LIMIT ?'
  ).all(project, limit);

  return rows.map(r => ({
    ...r,
    embedding: JSON.parse(r.embedding),
    preview: r.content.slice(0, 200),
  }));
}

/**
 * Find clusters of highly similar observations using greedy clustering.
 *
 * @param {Array<Object>} observations - Embedded observations
 * @param {number} threshold - Cosine similarity threshold (0-1)
 * @returns {Array<Array<Object>>} Clusters (each cluster = array of similar obs)
 */
function findSimilarClusters(observations, threshold = DEFAULT_CONSOLIDATE_THRESHOLD) {
  const clusters = [];
  const used = new Set();

  for (const obs of observations) {
    if (used.has(obs.id)) continue;

    const cluster = [obs];
    used.add(obs.id);

    // Find all other observations similar to this one
    for (const other of observations) {
      if (used.has(other.id)) continue;
      const sim = cosineSimilarity(obs.embedding, other.embedding);
      if (sim >= threshold) {
        cluster.push(other);
        used.add(other.id);
      }
    }

    if (cluster.length > 1) {
      clusters.push(cluster);
    }
  }

  return clusters;
}

/**
 * Pick the "canonical" observation from a cluster — the one with highest confidence,
 * most recent if tied.
 *
 * @param {Array<Object>} cluster
 * @returns {Object} Canonical observation
 */
function pickCanonical(cluster) {
  return cluster.reduce((best, curr) =>
    curr.confidence > best.confidence ? curr :
    (curr.confidence === best.confidence && new Date(curr.created_at) > new Date(best.created_at)) ? curr : best
  );
}

/**
 * Create a consolidated summary via LLM (optional but preferred).
 *
 * @param {Array<Object>} cluster
 * @returns {Promise<{title: string, content: string}>}
 */
async function generateConsolidatedSummary(cluster) {
  const prompt = `You are consolidating ${cluster.length} related observations into a single canonical entry.
Extract the key facts, remove redundancy, and write a clear, concise summary.

Observations:
${cluster.map((o, i) => `${i + 1}. [${o.type}] ${o.title || '(untitled)'}: ${o.content}`).join('\n\n')}

Return JSON with:
- title: Short descriptive title (max 80 chars)
- content: Consolidated content (markdown ok, max 1000 chars)`;

  try {
    const result = await callLLM([
      { role: 'system', content: 'You are a knowledge consolidation assistant. Respond ONLY with valid JSON.' },
      { role: 'user', content: prompt },
    ], { temperature: 0.2, maxTokens: 1500 });

    const parsed = JSON.parse(result || '{}');
    if (parsed.title && parsed.content) return parsed;
  } catch (e) {
    console.warn('[reflection] LLM consolidation failed, using fallback:', e.message);
  }

  // Fallback: simple concatenation
  return {
    title: cluster[0].title || `Consolidated: ${cluster.length} items`,
    content: cluster.map((o, i) => `## ${o.title || `Item ${i + 1}`}\n${o.content}`).join('\n\n'),
  };
}

// ─── 1. Consolidate Memories ────────────────────────────────────────

/**
 * Consolidate similar observations within a project.
 *
 * Algorithm:
 * 1. Load recent embedded observations
 * 2. Cluster by cosine similarity >= threshold
 * 3. For each cluster: pick canonical (highest confidence), generate merged summary via LLM,
 *    update canonical with merged content, archive others, add 'supersedes' relations
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} opts
 * @param {string} [opts.project] - Project path
 * @param {number} [opts.threshold=0.85] - Similarity threshold
 * @param {boolean} [opts.dryRun=false] - If true, only report what would happen
 * @returns {Promise<{clusters: number, merged: number, archived: number, dryRun: boolean}>}
 */
async function consolidateMemories(db, opts = {}) {
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const threshold = opts.threshold ?? DEFAULT_CONSOLIDATE_THRESHOLD;
  const dryRun = opts.dryRun ?? false;

  const observations = getEmbeddedObservations(db, project);
  if (observations.length < 2) {
    return { clusters: 0, merged: 0, archived: 0, dryRun };
  }

  const clusters = findSimilarClusters(observations, threshold);
  if (clusters.length === 0) {
    return { clusters: 0, merged: 0, archived: 0, dryRun };
  }

  let merged = 0;
  let archived = 0;

  for (const cluster of clusters) {
    const canonical = pickCanonical(cluster);
    const others = cluster.filter(o => o.id !== canonical.id);

    const summary = await generateConsolidatedSummary(cluster);

    if (!dryRun) {
      // Update canonical with consolidated content
      db.prepare(
        'UPDATE observations SET title = ?, content = ?, confidence = ? WHERE id = ?'
      ).run(summary.title, summary.content, Math.min(100, canonical.confidence + 10), canonical.id);

      // Re-embed the updated canonical observation
      const updatedObs = db.prepare('SELECT * FROM observations WHERE id = ?').get(canonical.id);
      if (updatedObs) {
        const text = [updatedObs.title || '', updatedObs.content].filter(Boolean).join('. ');
        try {
          const vec = await embedding.computeEmbedding(text);
          db.prepare('UPDATE observations SET embedding = ? WHERE id = ?').run(JSON.stringify(vec), canonical.id);
        } catch {}
      }

      // Archive others and link via supersedes
      for (const other of others) {
        db.prepare('UPDATE observations SET is_active = 0 WHERE id = ?').run(other.id);
        db.prepare(
          'INSERT INTO memory_relations (source_id, target_id, relation_type, confidence) VALUES (?, ?, ?, ?)'
        ).run(canonical.id, other.id, 'supersedes', 90);
        archived++;
      }
      merged++;
    }
  }

  return { clusters: clusters.length, merged, archived, dryRun };
}

// ─── 2. Promote Patterns ────────────────────────────────────────────

/**
 * Detect recurring patterns and create "pattern" observations.
 *
 * Looks at tags, types, and content themes across recent observations.
 * When a tag/type/theme appears >= minCount times, creates a summary
 * observation of type 'learning' with the pattern description.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} opts
 * @param {string} [opts.project] - Project path
 * @param {number} [opts.minCount=3] - Minimum occurrences to promote
 * @param {boolean} [opts.dryRun=false] - If true, only report
 * @returns {Promise<{patterns: Array<{theme: string, count: number, type: string}>, promoted: number, skillsExtracted: number, dryRun: boolean}>}
 */
async function promotePatterns(db, opts = {}) {
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const minCount = opts.minCount ?? DEFAULT_PATTERN_MIN_COUNT;
  const dryRun = opts.dryRun ?? false;

  /** Map project observation count to a confidence threshold. */
  function _projectRelativeThreshold(count) {
    if (count < 200) return 75;
    if (count <= 1000) return DEFAULT_SKILL_CONFIDENCE_THRESHOLD;
    return 90;
  }

  const projectCount = db.prepare(
    'SELECT COUNT(*) as c FROM observations WHERE project_path = ? AND is_active = 1'
  ).get(project).c;
  const threshold = opts.skillConfidenceThreshold ?? _projectRelativeThreshold(projectCount);

  const recent = db.prepare(
    'SELECT id, type, title, content, tags, created_at ' +
    'FROM observations WHERE project_path = ? AND is_active = 1 ' +
    'ORDER BY created_at DESC LIMIT ?'
  ).all(project, 500);

  if (recent.length < minCount) {
    return { patterns: [], promoted: 0, dryRun };
  }

  // Count tag frequencies
  const tagCounts = new Map();
  for (const obs of recent) {
    try {
      const tags = JSON.parse(obs.tags || '[]');
      for (const tag of tags) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    } catch {}
  }

  // Count type frequencies
  const typeCounts = new Map();
  for (const obs of recent) {
    typeCounts.set(obs.type, (typeCounts.get(obs.type) || 0) + 1);
  }

  // Extract potential pattern themes (tags + types with >= minCount)
  const patterns = [];
  for (const [theme, count] of tagCounts) {
    if (count >= minCount) patterns.push({ theme, count, type: 'tag' });
  }
  for (const [theme, count] of typeCounts) {
    if (count >= minCount) patterns.push({ theme, count, type: 'type' });
  }

  let promoted = 0;
  for (const p of patterns) {
    // Check if we already promoted this pattern recently.
    // SAFETY: p.theme comes from parsed DB tag/type values, not raw user input.
    const existing = db.prepare(
      'SELECT id FROM observations WHERE project_path = ? AND type IN (\'pattern\', \'learning\') AND title LIKE \'%\' || ? || \'%\' AND created_at > datetime(\'now\', \'-7 days\')'
    ).get(project, p.theme);
    if (existing) continue;

    // Get sample observations for this theme
    const samples = recent.filter(o => {
      try {
        const tags = JSON.parse(o.tags || '[]');
        return o.type === p.theme || tags.includes(p.theme);
      } catch {
        return o.type === p.theme;
      }
    }).slice(0, 10);

    if (samples.length < minCount) continue;

    const prompt = `You noticed a recurring theme "${p.theme}" (${p.type}) appearing ${p.count} times in recent observations.
Summarize the key pattern/insight in one learning observation.

Sample observations:
${samples.map((s, i) => `${i + 1}. [${s.type}] ${s.title || '(untitled)'}: ${s.content.slice(0, 300)}`).join('\n\n')}

Return JSON with:
- title: "Pattern: ${p.theme}" (max 80 chars)
- content: Brief insight (markdown ok, max 1000 chars)
- tags: ["pattern", "${p.theme}", "${p.type}"]`;

    let summary;
    try {
      const result = await callLLM([
        { role: 'system', content: 'You extract recurring patterns from observations. Respond ONLY with valid JSON.' },
        { role: 'user', content: prompt },
      ], { temperature: 0.3, maxTokens: 1500 });
      summary = JSON.parse(result || '{}');
    } catch (e) {
      summary = {
        title: `Pattern: ${p.theme}`,
        content: `Recurring ${p.type} "${p.theme}" observed ${p.count} times. Key examples:\n${samples.map(s => `- [${s.type}] ${s.title || '(untitled)'}`).join('\n')}`,
      };
    }

    if (!dryRun && summary.title && summary.content && _saveFn) {
      await _saveFn({
        project,
        type: 'pattern',
        title: summary.title,
        content: summary.content,
        tags: summary.tags || ['pattern', p.theme, p.type],
        confidence: 80,
        provenance: 'inferred',
      });
      promoted++;
    } else if (!dryRun && summary.title && summary.content && !_saveFn) {
      console.warn('[reflection] No save function injected — skipping pattern promotion save');
    }
  }

  // ── Skill auto-extraction: high-confidence learnings become instructions ──
  let skillsExtracted = 0;
  if (!dryRun) {
    console.warn('[reflection] Skill extraction threshold for %s: %d (project has %d observations)', project, threshold, projectCount);
  }
  const ripeLearnings = db.prepare(
    'SELECT id, title, content, confidence, tags FROM observations ' +
    'WHERE project_path = ? AND type = ? AND is_active = 1 AND confidence >= ? ' +
    'ORDER BY confidence DESC LIMIT 5'
  ).all(project, 'learning', threshold);

  for (const learning of ripeLearnings) {
    // Check if already promoted
    const existing = db.prepare(
      'SELECT id FROM memory_relations WHERE source_id = ? AND relation_type = ?'
    ).get(learning.id, 'refines');
    if (existing) continue;

    let structured;
    try {
      const prompt = `Convert this high-confidence learning into a structured instruction with actionable steps.\n\nLearning: "${learning.title}: ${learning.content}"\n\nReturn JSON with:\n- title: Instruction title (max 80 chars)\n- content: Clear instructional content (max 500 chars)\n- steps: Array of actionable step strings (3-5 steps)\n- triggers: Array of situations that trigger this instruction (e.g., "TypeError", "before PR")\n- preconditions: Array of conditions that must be true (e.g., "Node.js >= 18")\n- postconditions: Array of expected results (e.g., "No null pointer errors")`;

      const { callLLM } = require('./session');
      const result = await callLLM([
        { role: 'system', content: 'You convert learnings into structured instructions. Respond ONLY with valid JSON.' },
        { role: 'user', content: prompt },
      ], { temperature: 0.2, maxTokens: 1200, timeout: 30000 });
      structured = JSON.parse(result || '{}');
    } catch {
      structured = {
        title: learning.title,
        content: learning.content,
        steps: [learning.content],
        triggers: [],
        preconditions: [],
        postconditions: [],
      };
    }

    if (!dryRun && structured.title && structured.content && _saveFn) {
      // Determine scope: if this learning tag appears across multiple projects, make it global
      let scope = 'local';
      try {
        const tags = JSON.parse(learning.tags || '[]');
        if (tags.length > 0) {
          const globalCount = db.prepare(
            'SELECT COUNT(DISTINCT project_path) as c FROM observations WHERE is_active = 1 AND (' +
            tags.map(() => 'tags LIKE ?').join(' OR ') + ')'
          ).all(...tags.map(t => '%' + t + '%'))[0]?.c || 0;
          if (globalCount >= 2) scope = 'global';
        }
      } catch {}

      const skillObs = await _saveFn({
        project,
        type: 'instruction',
        title: structured.title,
        content: structured.content,
        steps: structured.steps || [structured.content],
        triggers: structured.triggers || [],
        preconditions: structured.preconditions || [],
        postconditions: structured.postconditions || [],
        tags: [...(JSON.parse(learning.tags || '[]')), 'auto-extracted-skill'],
        confidence: Math.min(100, learning.confidence),
        importance: 9,
        provenance: 'inferred',
        project_scope: scope,
      });

      if (skillObs && skillObs.id) {
        // Link learning → instruction via 'refines' relation
        db.prepare(
          'INSERT INTO memory_relations (source_id, target_id, relation_type, confidence) VALUES (?,?,?,?)'
        ).run(learning.id, skillObs.id, 'refines', 90);
        skillsExtracted++;
      }
    }
  }

  return { patterns, promoted, skillsExtracted, dryRun };
}

// ─── 3. Archive Superseded ──────────────────────────────────────────

/**
 * Archive observations that have been superseded by newer versions.
 *
 * Finds observations linked via 'supersedes' relation where the source
 * (canonical) has higher confidence and is newer. Archives the targets.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} opts
 * @param {string} [opts.project] - Project path
 * @param {number} [opts.maxAgeDays=30] - Only archive superseded obs older than this
 * @param {boolean} [opts.dryRun=false] - If true, only report
 * @returns {Promise<{candidates: number, archived: number, dryRun: boolean}>}
 */
async function archiveSuperseded(db, opts = {}) {
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_ARCHIVE_AGE_DAYS;
  const dryRun = opts.dryRun ?? false;

  // Find superseded observations older than maxAgeDays that are still active
  const candidates = db.prepare(
    `SELECT o.id, o.title, o.created_at
     FROM observations o
     JOIN memory_relations r ON r.target_id = o.id
     JOIN observations src ON src.id = r.source_id
     WHERE o.project_path = ?
       AND o.is_active = 1
       AND r.relation_type = 'supersedes'
       AND src.is_active = 1
       AND src.confidence >= o.confidence
       AND date(o.created_at) < date('now', '-' || ? || ' days')`
  ).all(project, maxAgeDays);

  let archived = 0;
  for (const c of candidates) {
    if (!dryRun) {
      db.prepare('UPDATE observations SET is_active = 0 WHERE id = ?').run(c.id);
      archived++;
    }
  }

  // ── Utility decay pass: observations never accessed in 30+ days lose confidence ──
  let decayed = 0;
  const staleObs = db.prepare(
    `SELECT id, confidence FROM observations
     WHERE project_path = ? AND is_active = 1 AND access_count = 0
       AND created_at < datetime('now', '-' || ? || ' days')
       AND confidence > 20`
  ).all(project, maxAgeDays);

  for (const o of staleObs) {
    if (!dryRun) {
      db.prepare('UPDATE observations SET confidence = MAX(confidence - 10, 10) WHERE id = ?').run(o.id);
      decayed++;
    }
  }

  return { candidates: candidates.length, archived, decayed, dryRun };
}

// ─── Combined Reflection Pass ───────────────────────────────────────

/**
 * Run a full reflection cycle: consolidate, promote, archive.
 * Additionally runs auto-promotion of high-quality learnings to global scope
 * so the machine-wide immune system grows automatically.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} opts
 * @param {string} [opts.project] - Project path
 * @param {boolean} [opts.dryRun=false] - If true, only report
 * @returns {Promise<{consolidate: Object, promote: Object, archive: Object, globalPromote: Object}>}
 */
async function reflect(db, opts = {}) {
  const dryRun = opts.dryRun ?? false;
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();

  const [consolidate, promote, archive] = await Promise.all([
    consolidateMemories(db, { ...opts, project, dryRun }),
    promotePatterns(db, { ...opts, project, dryRun }),
    archiveSuperseded(db, { ...opts, project, dryRun }),
  ]);

  // Auto-promote high-quality learnings to machine-wide global vault
  let globalPromote = { promoted: 0, candidates: 0 };
  if (!dryRun) {
    try {
      // Lazy-load api to avoid circular dependency
      const api = require('../api');
      globalPromote = api.autoPromoteGlobal(db, project);
    } catch { /* best-effort */ }
  }

  return { consolidate, promote, archive, globalPromote };
}

// ─── 4. Crystallize: Tiered Memory Upward Compression ──────────────

/**
 * Default minimum verification count before a synthesis can become a principle.
 * @type {number}
 */
const DEFAULT_PRINCIPLE_VERIFY_COUNT = 3;

/**
 * Default confidence threshold for promoting to principle layer.
 * @type {number}
 */
const DEFAULT_PRINCIPLE_CONFIDENCE = 90;

/**
 * Crystallize: compress raw observations (layer 1) upward into synthesis
 * (layer 2) and stable syntheses into principles (layer 3).
 *
 * This is AutoGTM's "compounding brain" pattern applied to memory:
 *   raw (1) → synthesis (2) → principle (3)
 *
 * Layer 1 → 2: Groups raw observations with similar topics/themes and
 *   generates LLM-summarized syntheses. Original raws remain active.
 *
 * Layer 2 → 3: Promotion happens when a synthesis has confidence >= 90
 *   AND has been independently verified (REINFORCE verdict) 3+ times.
 *   Principles are always injected in context and rarely adjusted.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} opts
 * @param {string} [opts.project] - Project path
 * @param {number} [opts.fromLayer=1] - Layer to compress from
 * @param {number} [opts.minCount=3] - Minimum raw observations to form a synthesis
 * @param {boolean} [opts.dryRun=false] - Preview only
 * @returns {Promise<{rawToSynthesis: number, synthesisToPrinciple: number, dryRun: boolean}>}
 */
async function crystallize(db, opts = {}) {
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const fromLayer = opts.fromLayer || 1;
  const minCount = opts.minCount || 3;
  const dryRun = opts.dryRun || false;

  let rawToSynthesis = 0;
  let synthesisToPrinciple = 0;

  // ── Layer 1 → 2: Raw observations → Syntheses ──
  if (fromLayer <= 1) {
    const raws = db.prepare(
      'SELECT id, type, title, content, tags, confidence, embedding ' +
      'FROM observations WHERE project_path = ? AND is_active = 1 ' +
      'AND (layer IS NULL OR layer = 1) ' +
      'ORDER BY created_at DESC LIMIT 200'
    ).all(project);

    if (raws.length >= minCount) {
      // Find theme clusters by tag overlap (AutoGTM's topic grouping)
      const tagClusters = new Map();
      for (const r of raws) {
        try {
          const tags = JSON.parse(r.tags || '[]');
          for (const tag of tags) {
            if (!tagClusters.has(tag)) tagClusters.set(tag, []);
            tagClusters.get(tag).push(r);
          }
        } catch {}
      }

      // Process clusters with >= minCount members that don't already have a synthesis
      for (const [tag, cluster] of tagClusters) {
        if (cluster.length < minCount) continue;

        // Check if synthesis for this tag already exists recently
        const existingSynth = db.prepare(
          "SELECT id FROM observations WHERE project_path = ? AND type = 'learning' AND is_active = 1 AND tags LIKE ? AND created_at > datetime('now', '-30 days')"
        ).get(project, '%"' + tag + '"%');
        if (existingSynth) continue;

        // Generate synthesis via LLM
        const prompt = `You are compressing ${cluster.length} raw observations about "${tag}" into a single synthesis. Extract the key insights, remove redundancy, and write a concise summary.

Observations:
${cluster.slice(0, 10).map((r, i) => `${i + 1}. [${r.type}] ${r.title || '(untitled)'}: ${r.content.slice(0, 300)}`).join('\n\n')}

Return JSON with:
- title: Synthesis title (max 80 chars)
- content: Key insights synthesized (max 800 chars, markdown ok)`;

        let synthesized;
        try {
          const result = await callLLM([
            { role: 'system', content: 'You distill multiple observations into a single synthesis. Respond ONLY with valid JSON.' },
            { role: 'user', content: prompt },
          ], { temperature: 0.2, maxTokens: 1200, timeout: 30000 });
          synthesized = JSON.parse(result || '{}');
          if (!synthesized || !synthesized.title || !synthesized.content) {
            synthesized = null;
          }
        } catch {
          synthesized = null;
        }
        if (!synthesized) {
          synthesized = {
            title: `Synthesis: ${tag}`,
            content: cluster.slice(0, 5).map(r => `- ${r.title || r.content.slice(0, 100)}`).join('\n'),
          };
        }

        if (!dryRun && synthesized.title && synthesized.content && _saveFn) {
          const avgConf = Math.round(cluster.reduce((s, r) => s + (r.confidence || 100), 0) / cluster.length);
          const synthObs = await _saveFn({
            project,
            type: 'learning',
            title: synthesized.title,
            content: synthesized.content,
            tags: [tag, 'synthesis', 'auto-crystallized'],
            confidence: Math.min(100, avgConf),
            importance: 7,
            provenance: 'inferred',
            layer: 2,
          });

          if (synthObs && synthObs.id) {
            // Link all raws → synthesis via 'distills' relation
            for (const r of cluster.slice(0, 10)) {
              try {
                db.prepare(
                  'INSERT OR IGNORE INTO memory_relations (source_id, target_id, relation_type, confidence) VALUES (?,?,?,?)'
                ).run(synthObs.id, r.id, 'distills', 85);
              } catch {}
            }
            rawToSynthesis++;

            // Log crystallization
            db.prepare(
              'INSERT INTO crystallization_log (project_path, from_layer, to_layer, source_count, result_observation_id) VALUES (?,?,?,?,?)'
            ).run(project, 1, 2, cluster.length, synthObs.id);
          }
        }
      }
    }
  }

  // ── Layer 2 → 3: Syntheses → Principles ──
  // A synthesis becomes a principle when it has confidence >= 90 and has been
  // independently verified (REINFORCE verdicts in evaluation_log) 3+ times.
  if (fromLayer <= 2) {
    const syntheses = db.prepare(
      "SELECT id, title, content, tags, confidence FROM observations " +
      "WHERE project_path = ? AND type = 'learning' AND is_active = 1 " +
      'AND (layer = 2 OR layer IS NULL) AND confidence >= ?'
    ).all(project, DEFAULT_PRINCIPLE_CONFIDENCE);

    for (const synth of syntheses) {
      // Check if already promoted
      const alreadyPromoted = db.prepare(
        'SELECT id FROM memory_relations WHERE source_id = ? AND relation_type = ?'
      ).get(synth.id, 'hardens_to');
      if (alreadyPromoted) continue;

      // Count REINFORCE verdicts for this synthesis in eval log
      const verifyCount = db.prepare(
        'SELECT COUNT(*) as c FROM evaluation_log WHERE project_path = ? AND intent_id = ? AND llm_verdict = ?'
      ).get(project, synth.id, 'REINFORCE').c;

      if (verifyCount >= DEFAULT_PRINCIPLE_VERIFY_COUNT) {
        if (!dryRun && _saveFn) {
          const principleObs = await _saveFn({
            project,
            type: 'principle',
            title: synth.title,
            content: synth.content,
            tags: [...(JSON.parse(synth.tags || '[]')), 'principle', 'auto-crystallized'],
            confidence: Math.min(100, synth.confidence + 5),
            importance: 10,
            provenance: 'inferred',
            layer: 3,
            project_scope: 'global',
          });

          if (principleObs && principleObs.id) {
            db.prepare(
              'INSERT OR IGNORE INTO memory_relations (source_id, target_id, relation_type, confidence) VALUES (?,?,?,?)'
            ).run(principleObs.id, synth.id, 'hardens_to', 95);
            // Mark synthesis as layer 2 explicitly
            db.prepare('UPDATE observations SET layer = 2 WHERE id = ?').run(synth.id);
            synthesisToPrinciple++;

            db.prepare(
              'INSERT INTO crystallization_log (project_path, from_layer, to_layer, source_count, result_observation_id) VALUES (?,?,?,?,?)'
            ).run(project, 2, 3, 1, principleObs.id);
          }
        }
      }
    }
  }

  return { rawToSynthesis, synthesisToPrinciple, dryRun };
}

/**
 * Get principles (layer 3) for a project — always-injected, load-bearing knowledge.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} project
 * @param {number} [limit=10]
 * @returns {Array<Object>}
 */
function getPrinciples(db, project, limit = 10) {
  return db.prepare(
    'SELECT id, type, title, content, tags, confidence, importance, predicted_utility, freshness_score ' +
    'FROM observations WHERE (project_path = ? OR (project_scope = ? AND is_active = 1)) ' +
    'AND is_active = 1 AND (layer = 3 OR type = ?) ' +
    'ORDER BY confidence DESC, predicted_utility DESC LIMIT ?'
  ).all(project, 'global', 'principle', limit);
}

module.exports = {
  DEFAULT_CONSOLIDATE_THRESHOLD,
  DEFAULT_PATTERN_MIN_COUNT,
  DEFAULT_ARCHIVE_AGE_DAYS,
  DEFAULT_SKILL_CONFIDENCE_THRESHOLD,
  DEFAULT_PRINCIPLE_VERIFY_COUNT,
  DEFAULT_PRINCIPLE_CONFIDENCE,
  consolidateMemories,
  promotePatterns,
  archiveSuperseded,
  crystallize,
  getPrinciples,
  reflect,
  findSimilarClusters,
  pickCanonical,
  generateConsolidatedSummary,
  getEmbeddedObservations,
  setSaveFunction: (fn) => { _saveFn = fn; },
};