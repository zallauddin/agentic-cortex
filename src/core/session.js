/**
 * session.js — Session management for agentic-cortex.
 *
 * Provides session lifecycle operations (start, end, list, summarize),
 * LLM integration for auto-summarization via llama.cpp, and a template-based
 * fallback when the LLM is unavailable.
 *
 * @module core/session
 */

'use strict';

const path = require('path');
const { LLAMA_URL } = require('./constants');

/**
 * Start a new memory session for a project.
 *
 * @param {import('better-sqlite3').Database} db - Database instance
 * @param {Object} opts - Session options
 * @param {string} [opts.prompt] - User prompt that initiated the session
 * @param {string} [opts.project] - Project path (defaults to AGENTIC_CORTEX_PROJECT or cwd)
 * @param {string} [opts.sessionId] - Custom session ID (auto-generated if omitted)
 * @returns {{ session_id: string, status: string }} The new session info
 */
function startSession(db, opts) {
  const sid = opts.sessionId || 'session-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const name = path.basename(project);

  db.prepare(
    'INSERT INTO sessions (session_id, project_path, project_name, user_prompt) VALUES (?,?,?,?)'
  ).run(sid, project, name, opts.prompt || '');

  return { session_id: sid, status: 'started' };
}

/**
 * End a session and optionally set its summary.
 *
 * @param {import('better-sqlite3').Database} db - Database instance
 * @param {string} sessionId - The session ID to end
 * @param {string} [summary=''] - Session summary text
 * @returns {{ session_id: string, status: string }} The ended session info
 */
function endSession(db, sessionId, summary) {
  if (!sessionId) {
    throw new Error('session ID is required to end a session');
  }

  db.prepare("UPDATE sessions SET ended_at = datetime('now'), summary = ? WHERE session_id = ?")
    .run(summary || '', sessionId);

  return { session_id: sessionId, status: 'ended' };
}

/**
 * List recent sessions for a project.
 *
 * @param {import('better-sqlite3').Database} db - Database instance
 * @param {Object} opts - List options
 * @param {string} [opts.project] - Filter by project path
 * @param {number} [opts.limit=10] - Maximum number of sessions
 * @returns {Array<Object>} Session records
 */
function listSessions(db, opts) {
  const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
  const limit = opts.limit || 10;

  return db.prepare(
    'SELECT id, session_id, project_name, user_prompt, summary, started_at, ended_at ' +
    'FROM sessions WHERE project_path = ? ORDER BY started_at DESC LIMIT ?'
  ).all(project, limit);
}

/**
 * Call the LLM (llama.cpp) for text generation.
 * Returns null if llama.cpp is unreachable (caller should use template fallback).
 *
 * @param {Array<{role: string, content: string}>} messages - Chat messages
 * @param {Object} [opts={}] - LLM options
 * @param {number} [opts.temperature=0.3] - Sampling temperature
 * @param {number} [opts.maxTokens=2000] - Maximum tokens to generate
 * @param {number} [opts.timeout=300000] - Request timeout in milliseconds
 * @returns {Promise<string|null>} Generated text, or null if LLM is unavailable
 */
async function callLLM(messages, opts = {}) {
  const body = {
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 2000,
    stream: false,
  };

  try {
    const res = await fetch(LLAMA_URL + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeout ?? 300000),
    });

    if (!res.ok) {
      throw new Error('LLM error ' + res.status + ': ' + (await res.text()));
    }

    const data = await res.json();
    let content = data.choices?.[0]?.message?.content || '';

    // Qwen 3.5 thinking models put output in reasoning_content when
    // max_tokens is exhausted on thinking tokens, leaving content empty.
    if (!content) {
      const rc = data.choices?.[0]?.message?.reasoning_content;
      if (typeof rc === 'string' && rc.length > 0) {
        content = rc;
      }
    }

    return content;
  } catch (err) {
    if (
      err.code === 'ECONNREFUSED' ||
      err.message?.includes('ECONNREFUSED') ||
      err.message?.includes('fetch failed')
    ) {
      return null; // Signal LLM unavailable — caller handles fallback
    }
    throw err;
  }
}

/**
 * Generate a template-based summary when the LLM is unavailable.
 * Produces a simple list of observation topics.
 *
 * @param {Array<Object>} obs - Observations from the session
 * @param {string} reason - Why template fallback is being used
 * @returns {string} A plain-text summary
 */
function templateSummary(obs, reason) {
  const topics = obs.slice(0, 5)
    .map(o => o.title || o.content.slice(0, 80))
    .join('; ');
  return 'Session covered: ' + topics + '. ' + obs.length + ' observations recorded. (' + reason + ')';
}

/**
 * Summarize a session using the LLM with template fallback.
 * Fetches observations for the session, calls the LLM, and stores the summary.
 *
 * @param {import('better-sqlite3').Database} db - Database instance
 * @param {Object} opts - Summarize options
 * @param {string} [opts.id] - Session ID to summarize
 * @param {string} [opts.project] - Project path (used to find most recent session if id omitted)
 * @returns {{ session_id: string, summary: string, observations_count: number, status: string }}
 */
async function summarizeSession(db, opts) {
  let session;
  if (opts.id) {
    session = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(opts.id);
  } else {
    const project = opts.project || process.env.AGENTIC_CORTEX_PROJECT || process.cwd();
    session = db.prepare(
      'SELECT * FROM sessions WHERE project_path = ? ORDER BY started_at DESC LIMIT 1'
    ).get(project);
  }
  if (!session) {
    throw new Error('Session not found');
  }

  const obs = db.prepare(
    'SELECT type, title, content, tags, importance FROM observations WHERE session_id = ? ORDER BY created_at'
  ).all(session.session_id);

  // Fall back to recent project observations if session has none
  let effectiveObs = obs;
  if (obs.length === 0) {
    const projectObs = db.prepare(
      'SELECT type, title, content, tags, importance FROM observations WHERE project_path = ? ORDER BY created_at DESC LIMIT 20'
    ).all(session.project_path);
    if (projectObs.length === 0) {
      throw new Error('No observations found for session ' + session.session_id);
    }
    effectiveObs = projectObs;
  }

  const obsText = effectiveObs.map((o, i) => {
    let tags = '';
    try {
      const arr = JSON.parse(o.tags);
      if (arr.length) tags = ' [' + arr.join(', ') + ']';
    } catch { /* ignore */ }
    return (i + 1) + '. [' + o.type + '] ' + (o.title || '(untitled)') + tags + ': ' + o.content;
  }).join('\n');

  const messages = [
    {
      role: 'system',
      content: 'You are a session summarizer for a coding agent memory system. Given observations from a coding session, produce a concise summary. Focus on: what was built, what decisions were made, what problems were solved, and current state. Be specific and actionable. Output 2-4 sentences, no formatting.',
    },
    {
      role: 'user',
      content: 'Session: ' + (session.user_prompt || 'Unknown') + '\nProject: ' + session.project_name + '\nStarted: ' + session.started_at + '\n\nObservations (' + effectiveObs.length + '):\n' + obsText,
    },
  ];

  const summary = await callLLM(messages, { temperature: 0.2, maxTokens: 500 });

  let finalSummary;
  if (summary === null) {
    finalSummary = templateSummary(effectiveObs, 'LLM unavailable — template fallback');
  } else {
    const cleaned = summary.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || summary.trim();
    if (!cleaned) {
      finalSummary = templateSummary(effectiveObs, 'LLM returned empty — template fallback');
    } else {
      finalSummary = cleaned;
    }
  }

  db.prepare('UPDATE sessions SET summary = ? WHERE session_id = ?')
    .run(finalSummary, session.session_id);

  return {
    session_id: session.session_id,
    summary: finalSummary,
    observations_count: effectiveObs.length,
    status: 'summarized',
  };
}

module.exports = {
  startSession,
  endSession,
  listSessions,
  callLLM,
  templateSummary,
  summarizeSession,
};
