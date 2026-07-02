'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureSchema } = require('../src/core/db');
const {
  addRelation,
  getRelations,
  getGraph,
  deleteRelation,
  listRelationTypes,
} = require('../src/core/relations');

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  return db;
}

function seedObservations(db) {
  const insert = db.prepare(
    'INSERT INTO observations (project_path, type, title, content) VALUES (?,?,?,?)'
  );
  insert.run('/test', 'decision', 'Node A', 'Content A');
  insert.run('/test', 'observation', 'Node B', 'Content B');
  insert.run('/test', 'bug', 'Node C', 'Content C');
  insert.run('/test', 'context', 'Node D', 'Content D');
  insert.run('/test', 'observation', 'Node E', 'Content E');
}

// ─── addRelation ─────────────────────────────────────────────────────

describe('addRelation', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    seedObservations(db);
  });

  it('should create a relation between two observations', () => {
    const result = addRelation(db, { sourceId: 1, targetId: 2, relationType: 'related_to' });
    assert.equal(result.status, 'created');
    assert.ok(result.id > 0);
    assert.equal(result.relationType, 'related_to');
    assert.equal(result.confidence, 100);
  });

  it('should accept custom confidence', () => {
    const result = addRelation(db, { sourceId: 1, targetId: 2, relationType: 'depends_on', confidence: 80 });
    assert.equal(result.confidence, 80);
  });

  it('should reject missing required fields', () => {
    assert.throws(() => addRelation(db, { sourceId: 1 }), /required/);
    assert.throws(() => addRelation(db, { targetId: 1 }), /required/);
    assert.throws(() => addRelation(db, { relationType: 'related_to' }), /required/);
  });

  it('should reject invalid relation type', () => {
    assert.throws(
      () => addRelation(db, { sourceId: 1, targetId: 2, relationType: 'invalid_type' }),
      /Invalid relation_type/
    );
  });

  it('should reject self-referencing relations', () => {
    assert.throws(
      () => addRelation(db, { sourceId: 1, targetId: 1, relationType: 'related_to' }),
      /cannot be the same/
    );
  });

  it('should reject non-existent source', () => {
    assert.throws(
      () => addRelation(db, { sourceId: 999, targetId: 1, relationType: 'related_to' }),
      /Source observation not found/
    );
  });

  it('should reject non-existent target', () => {
    assert.throws(
      () => addRelation(db, { sourceId: 1, targetId: 999, relationType: 'related_to' }),
      /Target observation not found/
    );
  });

  it('should reject inactive source observation', () => {
    db.prepare('UPDATE observations SET is_active = 0 WHERE id = 1').run();
    assert.throws(
      () => addRelation(db, { sourceId: 1, targetId: 2, relationType: 'related_to' }),
      /Source observation not found or inactive/
    );
  });

  it('should support all valid relation types', () => {
    const types = ['related_to', 'contradicts', 'supersedes', 'derives_from', 'depends_on', 'part_of', 'refines'];
    for (const t of types) {
      const result = addRelation(db, { sourceId: 1, targetId: 2, relationType: t });
      assert.equal(result.relationType, t);
    }
  });

  it('should enforce unique source-target-type constraint', () => {
    addRelation(db, { sourceId: 1, targetId: 2, relationType: 'related_to' });
    assert.throws(
      () => addRelation(db, { sourceId: 1, targetId: 2, relationType: 'related_to' }),
      /UNIQUE constraint failed/
    );
  });
});

// ─── getRelations ────────────────────────────────────────────────────

describe('getRelations', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    seedObservations(db);
  });

  it('should return empty array for node with no relations', () => {
    const relations = getRelations(db, 1);
    assert.equal(relations.length, 0);
  });

  it('should return outgoing relations', () => {
    addRelation(db, { sourceId: 1, targetId: 2, relationType: 'related_to' });
    const relations = getRelations(db, 1);
    assert.equal(relations.length, 1);
    assert.equal(relations[0].direction, 'outgoing');
    assert.equal(relations[0].targetId, 2);
  });

  it('should return incoming relations', () => {
    addRelation(db, { sourceId: 1, targetId: 2, relationType: 'related_to' });
    const relations = getRelations(db, 2);
    assert.equal(relations.length, 1);
    assert.equal(relations[0].direction, 'incoming');
    assert.equal(relations[0].sourceId, 1);
  });

  it('should return both incoming and outgoing', () => {
    addRelation(db, { sourceId: 1, targetId: 2, relationType: 'related_to' });
    addRelation(db, { sourceId: 2, targetId: 3, relationType: 'depends_on' });
    const relations = getRelations(db, 2);
    assert.equal(relations.length, 2);
    assert.ok(relations.some(r => r.direction === 'incoming'));
    assert.ok(relations.some(r => r.direction === 'outgoing'));
  });

  it('should include relation details', () => {
    addRelation(db, { sourceId: 1, targetId: 2, relationType: 'supersedes', confidence: 85 });
    const relations = getRelations(db, 1);
    assert.equal(relations.length, 1);
    assert.equal(relations[0].relationType, 'supersedes');
    assert.equal(relations[0].confidence, 85);
    assert.ok(relations[0].createdAt);
  });

  it('should include target/source observation details', () => {
    addRelation(db, { sourceId: 1, targetId: 2, relationType: 'related_to' });
    const outgoing = getRelations(db, 1);
    assert.equal(outgoing[0].targetTitle, 'Node B');
    assert.equal(outgoing[0].targetType, 'observation');

    const incoming = getRelations(db, 2);
    assert.equal(incoming[0].sourceTitle, 'Node A');
    assert.equal(incoming[0].sourceType, 'decision');
  });
});

// ─── getGraph ────────────────────────────────────────────────────────

describe('getGraph', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    seedObservations(db);
  });

  it('should throw when observationId is missing', () => {
    assert.throws(() => getGraph(db, {}), /observationId is required/);
  });

  it('should return a single node when no neighbors exist', () => {
    const graph = getGraph(db, { observationId: 1, depth: 2 });
    assert.equal(graph.centerId, 1);
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.nodes[0].id, 1);
    assert.equal(graph.edges.length, 0);
  });

  it('should traverse connected nodes', () => {
    // Create a chain: 1 -> 2 -> 3
    addRelation(db, { sourceId: 1, targetId: 2, relationType: 'related_to' });
    addRelation(db, { sourceId: 2, targetId: 3, relationType: 'depends_on' });

    const graph = getGraph(db, { observationId: 1, depth: 2 });
    assert.equal(graph.nodes.length, 3);
    const nodeIds = graph.nodes.map(n => n.id);
    assert.ok(nodeIds.includes(1));
    assert.ok(nodeIds.includes(2));
    assert.ok(nodeIds.includes(3));
    assert.equal(graph.edges.length, 2);
  });

  it('should respect depth limit', () => {
    // Chain: 1 -> 2 -> 3 -> 4
    addRelation(db, { sourceId: 1, targetId: 2, relationType: 'related_to' });
    addRelation(db, { sourceId: 2, targetId: 3, relationType: 'related_to' });
    addRelation(db, { sourceId: 3, targetId: 4, relationType: 'related_to' });

    const graph = getGraph(db, { observationId: 1, depth: 1 });
    assert.equal(graph.nodes.length, 2, 'Should only reach depth 1');
    const nodeIds = graph.nodes.map(n => n.id);
    assert.ok(nodeIds.includes(1));
    assert.ok(nodeIds.includes(2));
    assert.ok(!nodeIds.includes(3));
  });

  it('should handle bidirectional edges', () => {
    addRelation(db, { sourceId: 1, targetId: 2, relationType: 'related_to' });
    addRelation(db, { sourceId: 2, targetId: 1, relationType: 'refines' });

    const graph = getGraph(db, { observationId: 1, depth: 1 });
    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.edges.length, 2);
  });

  it('should include node metadata', () => {
    const graph = getGraph(db, { observationId: 1 });
    const node = graph.nodes.find(n => n.id === 1);
    assert.equal(node.type, 'decision');
    assert.equal(node.title, 'Node A');
    assert.ok(node.preview !== undefined);
    assert.ok(node.importance !== undefined);
    assert.ok(node.created_at !== undefined);
  });

  it('should cap max depth at 4', () => {
    const graph = getGraph(db, { observationId: 1, depth: 10 });
    // depth is capped at 4 internally, no error expected
    assert.ok(graph.nodes.length >= 1);
  });

  it('should handle non-existent center node', () => {
    const graph = getGraph(db, { observationId: 9999 });
    assert.equal(graph.nodes.length, 0);
    assert.equal(graph.centerId, 9999);
  });
});

// ─── deleteRelation ──────────────────────────────────────────────────

describe('deleteRelation', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    seedObservations(db);
  });

  it('should delete a relation', () => {
    const r = addRelation(db, { sourceId: 1, targetId: 2, relationType: 'related_to' });
    const result = deleteRelation(db, r.id);
    assert.equal(result.status, 'deleted');
    assert.equal(result.id, r.id);
  });

  it('should throw when relation not found', () => {
    assert.throws(() => deleteRelation(db, 9999), /Relation not found/);
  });

  it('should remove deleted relation from getRelations', () => {
    const r = addRelation(db, { sourceId: 1, targetId: 2, relationType: 'related_to' });
    deleteRelation(db, r.id);
    const relations = getRelations(db, 1);
    assert.equal(relations.length, 0);
  });
});

// ─── listRelationTypes ───────────────────────────────────────────────

describe('listRelationTypes', () => {
  let db;
  beforeEach(() => {
    db = createTestDb();
    seedObservations(db);
  });

  it('should return empty when no relations exist', () => {
    const types = listRelationTypes(db);
    assert.equal(types.length, 0);
  });

  it('should count relations by type', () => {
    addRelation(db, { sourceId: 1, targetId: 2, relationType: 'related_to' });
    addRelation(db, { sourceId: 1, targetId: 3, relationType: 'related_to' });
    addRelation(db, { sourceId: 2, targetId: 3, relationType: 'depends_on' });

    const types = listRelationTypes(db);
    assert.equal(types.length, 2);

    const related = types.find(t => t.relationType === 'related_to');
    assert.equal(related.count, 2);

    const depends = types.find(t => t.relationType === 'depends_on');
    assert.equal(depends.count, 1);
  });

  it('should order by count descending', () => {
    addRelation(db, { sourceId: 1, targetId: 2, relationType: 'related_to' });
    addRelation(db, { sourceId: 1, targetId: 3, relationType: 'related_to' });
    addRelation(db, { sourceId: 1, targetId: 4, relationType: 'related_to' });
    addRelation(db, { sourceId: 2, targetId: 3, relationType: 'depends_on' });

    const types = listRelationTypes(db);
    assert.equal(types[0].relationType, 'related_to', 'Most common type should be first');
    assert.ok(types[0].count >= types[1].count);
  });
});
