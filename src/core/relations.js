/**
 * relations.js — Memory graph relations (edges between observations).
 *
 * Provides CRUD for memory_relations table and graph traversal utilities.
 *
 * @module core/relations
 */

'use strict';

const { VALID_RELATION_TYPES } = require('./constants');

/**
 * Add a relation between two observations.
 * @param {import('better-sqlite3').Database} db - Database instance
 * @param {Object} opts - { sourceId, targetId, relationType, confidence? }
 * @returns {Object} Created relation with id and status
 */
function addRelation(db, opts) {
  if (!opts.sourceId || !opts.targetId || !opts.relationType) {
    throw new Error('sourceId, targetId, and relationType are required');
  }
  if (!VALID_RELATION_TYPES.has(opts.relationType)) {
    throw new Error('Invalid relation_type: ' + opts.relationType + '. Valid: ' + [...VALID_RELATION_TYPES].join(', '));
  }
  if (opts.sourceId === opts.targetId) {
    throw new Error('sourceId and targetId cannot be the same');
  }

  // Verify both observations exist and are active
  const source = db.prepare('SELECT id FROM observations WHERE id = ? AND is_active = 1').get(opts.sourceId);
  const target = db.prepare('SELECT id FROM observations WHERE id = ? AND is_active = 1').get(opts.targetId);
  if (!source) throw new Error('Source observation not found or inactive: ' + opts.sourceId);
  if (!target) throw new Error('Target observation not found or inactive: ' + opts.targetId);

  const confidence = opts.confidence ?? 100;
  const r = db.prepare(
    'INSERT INTO memory_relations (source_id, target_id, relation_type, confidence) VALUES (?, ?, ?, ?)'
  ).run(opts.sourceId, opts.targetId, opts.relationType, confidence);

  return { id: Number(r.lastInsertRowid), status: 'created', relationType: opts.relationType, confidence };
}

/**
 * Get all relations for a given observation (as source or target).
 * @param {import('better-sqlite3').Database} db - Database instance
 * @param {number} observationId - Observation ID
 * @returns {Array<Object>} Relations with direction info
 */
function getRelations(db, observationId) {
  const asSource = db.prepare(`
    SELECT mr.id, mr.source_id as sourceId, mr.target_id as targetId, mr.relation_type as relationType,
           mr.confidence, mr.created_at as createdAt, 'outgoing' as direction,
           o.type as targetType, o.title as targetTitle, o.content as targetContent
    FROM memory_relations mr
    JOIN observations o ON o.id = mr.target_id
    WHERE mr.source_id = ? AND o.is_active = 1
  `).all(observationId);

  const asTarget = db.prepare(`
    SELECT mr.id, mr.source_id as sourceId, mr.target_id as targetId, mr.relation_type as relationType,
           mr.confidence, mr.created_at as createdAt, 'incoming' as direction,
           o.type as sourceType, o.title as sourceTitle, o.content as sourceContent
    FROM memory_relations mr
    JOIN observations o ON o.id = mr.source_id
    WHERE mr.target_id = ? AND o.is_active = 1
  `).all(observationId);

  return [...asSource, ...asTarget];
}

/**
 * Get a subgraph around an observation up to a given depth.
 * @param {import('better-sqlite3').Database} db - Database instance
 * @param {Object} opts - { observationId, depth?, limit? }
 * @returns {Object} { nodes: [], edges: [] }
 */
function getGraph(db, opts) {
  const observationId = opts.observationId;
  const depth = Math.min(opts.depth || 2, 4); // max depth 4
  const limit = Math.min(opts.limit || 100, 500);

  if (!observationId) throw new Error('observationId is required');

  const visited = new Set();
  const nodes = new Map(); // id -> node
  const edges = [];
  const queue = [{ id: observationId, depth: 0 }];

  // BFS to collect nodes up to depth
  while (queue.length > 0 && nodes.size < limit) {
    const { id, depth: d } = queue.shift();
    if (visited.has(id) || d > depth) continue;
    visited.add(id);

    const obs = db.prepare('SELECT id, type, title, substr(content, 1, 200) as preview, importance, created_at FROM observations WHERE id = ? AND is_active = 1').get(id);
    if (!obs) continue;
    nodes.set(id, { ...obs, preview: obs.preview || '' });

    if (d < depth) {
      // Get neighbors (both directions)
      const neighbors = db.prepare(`
        SELECT source_id as neighborId FROM memory_relations WHERE target_id = ? AND source_id IN (SELECT id FROM observations WHERE is_active = 1)
        UNION
        SELECT target_id as neighborId FROM memory_relations WHERE source_id = ? AND target_id IN (SELECT id FROM observations WHERE is_active = 1)
      `).all(id, id);

      for (const n of neighbors) {
        if (!visited.has(n.neighborId)) {
          queue.push({ id: n.neighborId, depth: d + 1 });
        }
      }
    }
  }

  // Collect edges between collected nodes
  const nodeIds = [...nodes.keys()];
  if (nodeIds.length > 1) {
    const placeholders = nodeIds.map(() => '?').join(',');
    const relationRows = db.prepare(`
      SELECT id, source_id as sourceId, target_id as targetId, relation_type as relationType, confidence
      FROM memory_relations
      WHERE source_id IN (${placeholders}) AND target_id IN (${placeholders})
    `).all(...nodeIds, ...nodeIds);

    for (const r of relationRows) {
      edges.push(r);
    }
  }

  return {
    nodes: [...nodes.values()],
    edges,
    centerId: observationId,
  };
}

/**
 * Delete a relation by ID.
 * @param {import('better-sqlite3').Database} db - Database instance
 * @param {number} relationId - Relation ID
 * @returns {Object} { id, status }
 */
function deleteRelation(db, relationId) {
  const r = db.prepare('DELETE FROM memory_relations WHERE id = ?').run(relationId);
  if (r.changes === 0) throw new Error('Relation not found: ' + relationId);
  return { id: relationId, status: 'deleted' };
}

/**
 * List all relation types with counts.
 * @param {import('better-sqlite3').Database} db - Database instance
 * @returns {Array<Object>} [{ relationType, count }]
 */
function listRelationTypes(db) {
  return db.prepare('SELECT relation_type as relationType, COUNT(*) as count FROM memory_relations GROUP BY relation_type ORDER BY count DESC').all();
}

module.exports = {
  addRelation,
  getRelations,
  getGraph,
  deleteRelation,
  listRelationTypes,
};