/**
 * compactor.js — Session context compactor (v7).
 *
 * Fights the dominant token cost in long agentic sessions: conversation
 * history. Produces a compressed "state so far" summary that an agent can swap
 * in for raw history, using a map-reduce scheme:
 *
 *   chunk → LLM chunk summary (template fallback) → final merge summary
 *
 * Works over either (a) observations recorded for a session/project, or
 * (b) a raw transcript of { role, content } entries. Results are stored in the
 * session_compactions table (audit trail with compression ratio) and can be
 * saved back as an observation for the next session's bootstrap.
 *
 * @module core/compactor
 */

'use strict';

const { callLLM } = require('./session');

/** Observations per chunk for the map phase. */
const CHUNK_SIZE = 40;

/** Target chars per transcript chunk (~1000 tokens). */
const TRANSCRIPT_CHUNK_CHARS = 4000;

/** Max entries/observations processed in one run. */
const DEFAULT_MAX_INPUT = 500;

/** Produce a template fallback summary for a chunk of observations. */
function _templateChunkSummary(items, kind) {
  const parts = items.slice(0, 8).map((o) => {
    const label = o.title || (o.content || '').slice(0, 80);
    return '[' + (o.type || kind) + '] ' + label;
  });
  return (kind === 'transcript' ? 'Transcript segment covered: ' : 'Observations covered: ') +
    parts.join('; ') + '. (' + items.length + ' items)';
}

/** Clean model output: strip thinking blocks, collapse whitespace. */
function _clean(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<\|?[a-z_]*\|?>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Call the LLM with a strict single-shot prompt; null on failure. */
async function _llm(system, user, maxTokens) {
  try {
    const res = await callLLM([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { temperature: 0.2, maxTokens: maxTokens || 300, timeout: 30000 });
    return _clean(res);
  } catch {
    return null;
  }
}

/**
 * Map phase: summarize one chunk of observations.
 */
async function _summarizeObsChunk(chunk, kind) {
  const obsText = chunk.map((o, i) =>
    (i + 1) + '. [' + (o.type || 'observation') + '] ' + (o.title || '(untitled)') + ': ' +
    String(o.content || '').slice(0, 200)
  ).join('\n');

  const out = await _llm(
    'You are a state compactor for a coding agent. Given observations from a coding session, ' +
    'compress them into 2-4 terse bullet lines: what was built/changed, key decisions, open problems, current state. ' +
    'No preamble, no markdown headers.',
    'Session observations (' + chunk.length + '):\n' + obsText,
    250
  );

  if (!out || out.length < 8) return _templateChunkSummary(chunk, kind);
  return out.slice(0, 600);
}

/**
 * Compact a session's (or project's) observations into a "state so far" summary.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} opts - { sessionId?, project?, limit?, saveObservation?, saveSummary? }
 * @returns {Promise<{ session_id: string|null, summary: string, inputCount: number, inputChars: number, ratio: number, stored: boolean }>}
 */
async function compactObservations(db, opts = {}) {
  const limit = opts.limit || DEFAULT_MAX_INPUT;
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();

  let rows;
  if (opts.sessionId) {
    rows = db.prepare(
      'SELECT id, type, title, content FROM observations WHERE session_id = ? ORDER BY created_at LIMIT ?'
    ).all(opts.sessionId, limit);
  } else {
    rows = db.prepare(
      'SELECT id, type, title, content FROM observations WHERE project_path = ? AND is_active = 1 ORDER BY created_at DESC LIMIT ?'
    ).all(project, limit);
  }

  if (rows.length === 0) {
    return {
      session_id: opts.sessionId || null,
      summary: '',
      inputCount: 0,
      inputChars: 0,
      ratio: 0,
      stored: false,
    };
  }

  // Map phase: chunk → summaries
  const chunkSummaries = [];
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    chunkSummaries.push(await _summarizeObsChunk(chunk, 'observation'));
  }

  // Reduce phase: merge chunk summaries into one "state so far"
  let summary;
  if (chunkSummaries.length === 1) {
    summary = chunkSummaries[0];
  } else {
    const merged = await _llm(
      'You are a state compactor. Merge these per-chunk session summaries into ONE "State so far" block: ' +
      'what was accomplished, what remains, current state. Max 6 lines. No preamble.',
      chunkSummaries.map((s, i) => '--- chunk ' + (i + 1) + ' ---\n' + s).join('\n\n'),
      350
    );
    summary = merged && merged.length > 8
      ? merged
      : chunkSummaries.join('\n').slice(0, 1200);
  }

  // Store the compaction record
  const inputChars = rows.reduce((acc, r) => acc + String(r.content || '').length, 0);
  const sessionId = opts.sessionId || null;
  const ratio = inputChars > 0 ? Math.round((summary.length / inputChars) * 1000) / 1000 : 0;
  const stored = _storeCompaction(db, sessionId, project, 'session', rows.length, inputChars, summary, ratio);

  // Optional: persist as an observation tagged for bootstrap pickup
  if (opts.saveObservation && summary) {
    try {
      db.prepare(
        "INSERT INTO observations (session_id, project_path, type, title, content, tags, importance, confidence, provenance) " +
        "VALUES (?, ?, 'context', ?, ?, ?, 8, 90, 'inferred')"
      ).run(sessionId, project, 'Session state (compacted)', summary, JSON.stringify(['compaction', 'state-so-far']));
    } catch { /* best-effort */ }
  }
  if (opts.saveSummary && sessionId) {
    try {
      db.prepare("UPDATE sessions SET summary = ? WHERE session_id = ?").run(summary.slice(0, 2000), sessionId);
    } catch { /* best-effort */ }
  }

  return { session_id: sessionId, summary, inputCount: rows.length, inputChars, ratio, stored };
}

/**
 * Compact a raw transcript of { role, content } entries (map-reduce over chunks).
 * No DB access required.
 *
 * @param {Array<{role: string, content: string}>} entries
 * @param {Object} [opts] - { maxInputChars? }
 * @returns {Promise<{ summary: string, chunks: number, inputChars: number, ratio: number }>}
 */
async function compactTranscript(entries, opts = {}) {
  const maxChars = opts.maxInputChars || 40000;
  let items = Array.isArray(entries) ? entries.filter(e => e && (e.content || '').length > 0) : [];
  if (items.length === 0) return { summary: '', chunks: 0, inputChars: 0, ratio: 0 };

  // Respect cap
  let total = 0;
  const capped = [];
  for (const e of items) {
    total += e.content.length;
    if (total > maxChars) break;
    capped.push(e);
  }
  items = capped;

  // Chunk by chars
  const chunks = [];
  let cur = [];
  let curChars = 0;
  for (const e of items) {
    const line = (e.role === 'user' ? 'USER: ' : e.role === 'assistant' ? 'ASSISTANT: ' : '') + e.content;
    if (curChars + line.length > TRANSCRIPT_CHUNK_CHARS && cur.length > 0) {
      chunks.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(line);
    curChars += line.length;
  }
  if (cur.length > 0) chunks.push(cur);

  const chunkSummaries = [];
  for (const chunk of chunks) {
    const text = chunk.join('\n').slice(0, 3500);
    const out = await _llm(
      'You are a conversation compactor for a coding agent. Compress this transcript segment into 2-4 terse lines: ' +
      'goal, key actions, decisions, blockers, current state. No preamble.',
      text,
      200
    );
    chunkSummaries.push(out && out.length > 6 ? out : _templateChunkSummary(chunk.map(l => ({ content: l })), 'transcript'));
  }

  let summary;
  if (chunkSummaries.length === 1) {
    summary = chunkSummaries[0];
  } else {
    const merged = await _llm(
      'You are a conversation compactor. Merge these segment summaries into ONE "State so far" block: ' +
      'what was accomplished, what remains, current state. Max 6 lines. No preamble.',
      chunkSummaries.map((s, i) => '--- segment ' + (i + 1) + ' ---\n' + s).join('\n\n'),
      350
    );
    summary = merged && merged.length > 8 ? merged : chunkSummaries.join('\n').slice(0, 1200);
  }

  const inputChars = items.reduce((acc, e) => acc + String(e.content).length, 0);
  return {
    summary,
    chunks: chunks.length,
    inputChars,
    ratio: inputChars > 0 ? Math.round((summary.length / inputChars) * 1000) / 1000 : 0,
  };
}

/** Insert a compaction record into session_compactions. */
function _storeCompaction(db, sessionId, project, kind, inputCount, inputChars, output, ratio) {
  try {
    db.prepare(
      'INSERT INTO session_compactions (session_id, project_path, kind, input_count, input_chars, output, output_chars, ratio) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(sessionId, project, kind, inputCount, inputChars, output, output.length, ratio);
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the most recent compactions for a session/project.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object} opts - { sessionId?, project?, limit? }
 * @returns {Array<Object>}
 */
function getCompactionHistory(db, opts = {}) {
  const limit = opts.limit || 5;
  if (opts.sessionId) {
    return db.prepare(
      'SELECT * FROM session_compactions WHERE session_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(opts.sessionId, limit);
  }
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  return db.prepare(
    'SELECT * FROM session_compactions WHERE project_path = ? ORDER BY created_at DESC LIMIT ?'
  ).all(project, limit);
}

module.exports = {
  compactObservations,
  compactTranscript,
  getCompactionHistory,
  _templateChunkSummary,
  _clean,
};
