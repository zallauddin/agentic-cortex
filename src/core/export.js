/**
 * export.js — Import/export operations for agentic-cortex.
 *
 * Provides JSON export/import for programmatic data exchange and
 * Obsidian-compatible markdown export with wikilinks, tag indexes,
 * and a master index page.
 *
 * @module core/export
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { getEmbedPipeline } = require('./embedding');
const { VALID_TYPES } = require('./constants');

/**
 * Export all observations and sessions as a JSON object.
 *
 * @param {import('better-sqlite3').Database} db - Database instance
 * @param {Object} opts - Export options
 * @param {string} [opts.project] - Filter by project path (all projects if omitted)
 * @param {boolean} [opts.includeEmbeddings=false] - Include embedding vectors in output
 * @returns {{ observations: Array<Object>, sessions: Array<Object>, exportedAt: string }}
 */
function exportJSON(db, opts) {
  const project = opts.project || null;

  const sessions = project
    ? db.prepare('SELECT * FROM sessions WHERE project_path = ? ORDER BY started_at DESC').all(project)
    : db.prepare('SELECT * FROM sessions ORDER BY started_at DESC').all();

  const selectCols = opts.includeEmbeddings
    ? 'id, session_id, project_path, type, title, content, tags, importance, confidence, provenance, agent_id, steps, triggers, preconditions, postconditions, is_active, embedding, created_at'
    : 'id, session_id, project_path, type, title, content, tags, importance, confidence, provenance, agent_id, steps, triggers, preconditions, postconditions, is_active, created_at';

  const observations = project
    ? db.prepare('SELECT ' + selectCols + ' FROM observations WHERE project_path = ? ORDER BY created_at DESC').all(project)
    : db.prepare('SELECT ' + selectCols + ' FROM observations ORDER BY created_at DESC').all();

  return {
    observations,
    sessions,
    exportedAt: new Date().toISOString(),
  };
}

/**
 * Import observations from a JSON array or object.
 * Embeds each observation if the pipeline is available.
 *
 * @param {import('better-sqlite3').Database} db - Database instance
 * @param {Array<Object>|Object} data - Observations array or { observations: [...] }
 * @param {Object} opts - Import options
 * @param {string} [opts.project] - Override project path for all imported observations
 * @returns {{ saved: number, ids: Array<number>, embedded: boolean }}
 */
async function importJSON(db, data, opts) {
  const items = Array.isArray(data) ? data : (data.observations || [data]);
  const project = opts.project || process.cwd();

  let pipe;
  try { pipe = await getEmbedPipeline(); } catch { /* embeddings unavailable */ }

  const insert = db.transaction((arr) => {
    const ids = [];
    for (const item of arr) {
      const r = db.prepare(
        'INSERT INTO observations (session_id, project_path, type, title, content, tags, importance, confidence, provenance, agent_id, steps, triggers, preconditions, postconditions) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(
        item.session_id || null,
        item.project_path || project,
        item.type || 'context',
        item.title || null,
        item.content,
        JSON.stringify(item.tags || []),
        item.importance || 5,
        item.confidence ?? 100,
        item.provenance || 'observed',
        item.agent_id || null,
        item.steps ? JSON.stringify(item.steps) : null,
        item.triggers ? JSON.stringify(item.triggers) : null,
        item.preconditions ? JSON.stringify(item.preconditions) : null,
        item.postconditions ? JSON.stringify(item.postconditions) : null
      );
      ids.push(Number(r.lastInsertRowid));
    }
    return ids;
  });

  const ids = insert(items);

  if (pipe) {
    for (const id of ids) {
      const obs = db.prepare('SELECT title, content FROM observations WHERE id = ?').get(id);
      if (obs) {
        try {
          const text = [obs.title || '', obs.content].filter(Boolean).join('. ');
          const result = await pipe(text, { pooling: 'mean', normalize: true });
          db.prepare('UPDATE observations SET embedding = ? WHERE id = ?')
            .run(JSON.stringify(Array.from(result.data)), id);
        } catch { /* skip failed embeddings */ }
      }
    }
  }

  return { saved: ids.length, ids, embedded: !!pipe };
}

// ─── Obsidian markdown export helpers ──────────────────────────────

/** @type {Object<string, string>} Observation type to vault folder mapping */
const TYPE_FOLDERS = {
  decision: 'decisions',
  bugfix: 'bugs',
  context: 'context',
  gotcha: 'gotchas',
  architecture: 'architecture',
  preference: 'preferences',
};

/**
 * Sanitize a title into a safe Obsidian filename.
 *
 * @param {string} title - Observation title
 * @param {number} id - Observation ID (fallback)
 * @returns {string} Sanitized filename with .md extension
 */
function sanitizeFilename(title, id) {
  const base = (title || 'untitled')
    .replace(/[^a-zA-Z0-9\s\-]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 60);
  return (base || 'obs-' + id) + '.md';
}

/**
 * Find related observations by shared tags.
 *
 * @param {Object} obs - The observation to find related items for
 * @param {Array<Object>} allObs - All observations in the project
 * @returns {Array<{id: number, title: string, shared: number}>} Related observations
 */
function findRelated(obs, allObs) {
  let obsTags;
  try { obsTags = JSON.parse(obs.tags || '[]'); } catch { obsTags = []; }
  if (obsTags.length === 0) return [];

  const related = [];
  for (const other of allObs) {
    if (other.id === obs.id) continue;
    let otherTags;
    try { otherTags = JSON.parse(other.tags || '[]'); } catch { otherTags = []; }
    const shared = obsTags.filter(t => otherTags.includes(t));
    if (shared.length > 0) {
      related.push({ id: other.id, title: other.title, shared: shared.length });
    }
  }
  related.sort((a, b) => b.shared - a.shared);
  return related.slice(0, 5);
}

/**
 * Export memories to an Obsidian vault (one-way, read-only mirror).
 * Creates session files, observation files by type, tag index pages,
 * and a master index.
 *
 * @param {import('better-sqlite3').Database} db - Database instance
 * @param {Object} opts - Export options
 * @param {string} opts.vaultPath - Path to the Obsidian vault directory
 * @param {string} [opts.project] - Filter by project path
 * @param {boolean} [opts.force=false] - Overwrite existing files
 * @returns {{ status: string, vault: string, exported: Object, total: Object }}
 */
function exportMarkdown(db, opts) {
  if (!opts.vaultPath) {
    throw new Error('vaultPath is required for markdown export');
  }

  const vaultPath = path.resolve(opts.vaultPath);
  const mkdirOpts = { recursive: true };

  // Create vault directory structure
  const dirs = ['sessions', 'decisions', 'context', 'gotchas', 'bugs', 'architecture', 'preferences', 'misc', '_tags'];
  for (const dir of dirs) {
    try { fs.mkdirSync(path.join(vaultPath, dir), mkdirOpts); } catch { /* exists */ }
  }

  // Fetch all sessions
  const sessions = opts.project
    ? db.prepare('SELECT * FROM sessions WHERE project_path = ? ORDER BY started_at DESC').all(opts.project)
    : db.prepare('SELECT * FROM sessions ORDER BY started_at DESC').all();

  // Fetch all observations
  const observations = opts.project
    ? db.prepare('SELECT id, session_id, project_path, type, title, content, tags, importance, created_at FROM observations WHERE project_path = ? ORDER BY created_at DESC').all(opts.project)
    : db.prepare('SELECT id, session_id, project_path, type, title, content, tags, importance, created_at FROM observations ORDER BY created_at DESC').all();

  if (observations.length === 0 && sessions.length === 0) {
    return { status: 'empty', vault: vaultPath, exported: { sessions: 0, observations: 0, tags: 0 }, total: { sessions: 0, observations: 0 } };
  }

  // ── Export sessions ──
  let sessionsExported = 0;
  for (const session of sessions) {
    const date = session.started_at ? session.started_at.replace(' ', 'T').split('T')[0] : 'unknown';
    const name = session.project_name || 'unknown';
    const filename = (date + '-' + name).replace(/[^a-zA-Z0-9\-]/g, '-').replace(/-+/g, '-').toLowerCase() + '.md';
    const filepath = path.join(vaultPath, 'sessions', filename);

    const sessionObs = observations.filter(o => o.session_id === session.session_id);

    let content = '---\n';
    content += 'type: session\n';
    content += 'session_id: ' + session.session_id + '\n';
    content += 'project: ' + (session.project_path || '') + '\n';
    content += 'project_name: ' + (session.project_name || '') + '\n';
    content += 'started: ' + (session.started_at || '') + '\n';
    content += 'ended: ' + (session.ended_at || 'active') + '\n';
    content += 'observations: ' + sessionObs.length + '\n';
    content += '---\n\n';
    content += '# Session: ' + (session.user_prompt || session.project_name || 'Unknown') + '\n\n';

    if (session.summary) {
      content += '## Summary\n' + session.summary + '\n\n';
    }

    if (sessionObs.length > 0) {
      content += '## Observations\n';
      for (const obs of sessionObs) {
        const typeEmoji = { decision: '\u2705', bugfix: '\ud83d\udc1b', context: '\ud83d\udcca', gotcha: '\u26a0\ufe0f', architecture: '\ud83c\udfd7\ufe0f', preference: '\u2b50', bug: '\ud83d\udc1b' };
        const emoji = typeEmoji[obs.type] || '\ud83d\udccc';
        content += '- ' + emoji + ' **' + (obs.title || 'Untitled') + '** (ID: ' + obs.id + ', importance: ' + obs.importance + ')\n';
        content += '  ' + obs.content.slice(0, 200) + (obs.content.length > 200 ? '...' : '') + '\n';
      }
      content += '\n';
    }

    if (sessionObs.length > 0) {
      content += '## Related\n';
      for (const obs of sessionObs.slice(0, 5)) {
        content += '- [[' + sanitizeFilename(obs.title, obs.id).replace('.md', '') + ']]\n';
      }
      content += '\n';
    }

    if (!fs.existsSync(filepath) || opts.force) {
      if (opts.force && fs.existsSync(filepath)) console.error('Overwriting: ' + filepath);
      fs.writeFileSync(filepath, content, 'utf-8');
      sessionsExported++;
    }
  }

  // ── Export observations by type ──
  let observationsExported = 0;
  const tagCounts = {};

  for (const obs of observations) {
    const folder = TYPE_FOLDERS[obs.type] || 'misc';
    const filename = sanitizeFilename(obs.title, obs.id);
    const filepath = path.join(vaultPath, folder, filename);

    let tags;
    try { tags = JSON.parse(obs.tags || '[]'); } catch { tags = []; }

    for (const tag of tags) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }

    const related = findRelated(obs, observations);

    let content = '---\n';
    content += 'id: ' + obs.id + '\n';
    content += 'type: ' + obs.type + '\n';
    content += 'importance: ' + obs.importance + '\n';
    content += 'project: ' + (obs.project_path || '') + '\n';
    content += 'created: ' + (obs.created_at || '') + '\n';
    if (obs.session_id) content += 'session: ' + obs.session_id + '\n';
    if (tags.length > 0) content += 'tags: [' + tags.join(', ') + ']\n';
    content += '---\n\n';
    content += '# ' + (obs.title || 'Untitled') + '\n\n';
    content += '> **Type:** ' + obs.type + ' | **Importance:** ' + obs.importance + '/10 | **ID:** ' + obs.id + '\n\n';
    content += obs.content + '\n';

    if (related.length > 0) {
      content += '\n## Related Observations\n';
      for (const r of related) {
        content += '- [[' + sanitizeFilename(r.title, r.id).replace('.md', '') + ']] (shared tags: ' + r.shared + ')\n';
      }
      content += '\n';
    }

    if (obs.session_id) {
      const session = sessions.find(s => s.session_id === obs.session_id);
      if (session) {
        const date = session.started_at ? session.started_at.replace(' ', 'T').split('T')[0] : 'unknown';
        const name = session.project_name || 'unknown';
        const sessionFile = (date + '-' + name).replace(/[^a-zA-Z0-9\-]/g, '-').replace(/-+/g, '-').toLowerCase();
        content += '## Session\n';
        content += '- [[' + sessionFile + ']]\n\n';
      }
    }

    if (!fs.existsSync(filepath) || opts.force) {
      if (opts.force && fs.existsSync(filepath)) console.error('Overwriting: ' + filepath);
      fs.writeFileSync(filepath, content, 'utf-8');
      observationsExported++;
    }
  }

  // ── Generate tag index pages ──
  for (const [tag, count] of Object.entries(tagCounts)) {
    const tagObs = observations.filter(o => {
      let t;
      try { t = JSON.parse(o.tags || '[]'); } catch { t = []; }
      return t.includes(tag);
    });

    let content = '---\n';
    content += 'type: tag-index\n';
    content += 'tag: ' + tag + '\n';
    content += 'count: ' + count + '\n';
    content += '---\n\n';
    content += '# Tag: ' + tag + '\n\n';
    content += '> ' + count + ' observations tagged with **' + tag + '**\n\n';

    for (const obs of tagObs) {
      const folder = TYPE_FOLDERS[obs.type] || 'misc';
      content += '- [[' + sanitizeFilename(obs.title, obs.id).replace('.md', '') + ']] (' + obs.type + ', importance: ' + obs.importance + ')\n';
    }
    content += '\n';

    const tagFile = path.join(vaultPath, '_tags', tag.replace(/[^a-zA-Z0-9\-]/g, '-').toLowerCase() + '.md');
    fs.writeFileSync(tagFile, content, 'utf-8');
  }

  // ── Generate master index ──
  const typeCounts = {};
  for (const obs of observations) {
    typeCounts[obs.type] = (typeCounts[obs.type] || 0) + 1;
  }

  const projectSet = new Set(observations.map(o => o.project_path).filter(Boolean));

  let index = '---\n';
  index += 'type: index\n';
  index += 'generated: ' + new Date().toISOString() + '\n';
  index += 'total_observations: ' + observations.length + '\n';
  index += 'total_sessions: ' + sessions.length + '\n';
  index += '---\n\n';    index += '# Agentic Cortex Memory Index\n\n';
  index += '> Auto-generated by agentic-cortex. ' + observations.length + ' observations across ' + projectSet.size + ' projects.\n\n';

  index += '## Stats\n';
  index += '| Metric | Value |\n';
  index += '|--------|-------|\n';
  index += '| Observations | ' + observations.length + ' |\n';
  index += '| Sessions | ' + sessions.length + ' |\n';
  index += '| Projects | ' + projectSet.size + ' |\n';
  index += '| Tags | ' + Object.keys(tagCounts).length + ' |\n\n';

  index += '## By Type\n';
  for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    index += '- **' + type + '**: ' + count + ' observations\n';
  }
  index += '\n';

  index += '## Top Tags\n';
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [tag, count] of topTags) {
    index += '- [[' + tag.replace(/[^a-zA-Z0-9\-]/g, '-').toLowerCase() + '|' + tag + ']] (' + count + ')\n';
  }
  index += '\n';

  index += '## Recent Sessions\n';
  for (const session of sessions.slice(0, 10)) {
    const date = session.started_at ? session.started_at.split('T')[0] : '?';
    const st = session.ended_at ? 'done' : 'active';
    const name = session.project_name || 'unknown';
    const sessionFile = (date + '-' + name).replace(/[^a-zA-Z0-9\-]/g, '-').replace(/-+/g, '-').toLowerCase();
    index += '- [[' + sessionFile + '|' + date + ' ' + name + ']] (' + st + ')\n';
  }
  index += '\n';

  index += '## Recent Observations\n';
  for (const obs of observations.slice(0, 20)) {
    index += '- [[' + sanitizeFilename(obs.title, obs.id).replace('.md', '') + '|' + (obs.title || 'Untitled') + ']] (' + obs.type + ', \u2b50' + obs.importance + ')\n';
  }
  index += '\n';

  fs.writeFileSync(path.join(vaultPath, '_index.md'), index, 'utf-8');

  return {
    status: 'done',
    vault: vaultPath,
    exported: {
      sessions: sessionsExported,
      observations: observationsExported,
      tags: Object.keys(tagCounts).length,
    },
    total: {
      sessions: sessions.length,
      observations: observations.length,
    },
  };
}

module.exports = { exportJSON, exportMarkdown, importJSON };
