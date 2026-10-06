/**
 * distill.js — Phase 0 of lesson persistence: generalize + sanitize
 * learning/error observations into a local `lessons/` markdown layer.
 *
 * Raw conversations die with the session; raw vault rows are private and
 * machine-specific. The lesson layer between them holds GENERALIZED lessons:
 * pattern-level statements with no file paths, machine names, or credentials.
 *
 * Privacy posture (fail-closed, reusing the seed-sanitizer):
 *   - credential-class content → hard-blocked (lesson skipped, reason logged)
 *   - identity paths / tokens / emails / IPs → redacted with typed placeholders
 *   - more than MAX_REDACTIONS redactions needed → too machine-specific, skipped
 *   - scope classification: project lessons stay local; machine/universal
 *     lessons are eligible for later seed review (never pushed automatically)
 *
 * @module core/distill
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sanitizer = require('./seed-sanitizer');

/** Observation types eligible for distillation. */
const DISTILLABLE_TYPES = ['learning', 'error', 'failure', 'success', 'fact', 'decision', 'pattern'];

/** Lessons not touched in this many days are considered stable (idempotency window). */
const REWRITE_WINDOW_DAYS = 30;

// ─── Generalization ──────────────────────────────────────────────────────────

/**
 * Replace machine-specific surface references with structural descriptions.
 * The lesson must read as a *pattern*, not an incident report.
 * @param {string} text
 * @returns {{ text: string, generalizations: string[] }}
 */
function generalize(text) {
  let out = String(text || '');
  const applied = [];

  const rules = [
    // Absolute file paths → surface description
    { id: 'abs-paths', re: /(?:[A-Za-z]:\\(?:Users|sourcecode|repos|projects)[^\s"'`)]+|\/(?:home|Users|usr|opt|var)\/[^\s"'`)]+)/g, to: '<path>' },
    // Repo/project directory names in path-like contexts
    { id: 'repo-names', re: /\b(?:D|C|E):\\[^\s"')]*/g, to: '<path>' },
    // Hostnames / machine names
    { id: 'hostnames', re: /\b(?:[a-z0-9]+-)?(?:macbook|laptop|desktop|workstation)-?[a-z0-9]*\b/gi, to: '<machine>' },
    // Session/agent IDs
    { id: 'session-ids', re: /\b(?:ses|sid|sess)_[A-Za-z0-9_-]{8,}\b/g, to: '<session>' },
    // Ports bound on this machine
    { id: 'ports', re: /\blocalhost:(\d{4,5})\b/g, to: 'localhost:<port>' },
  ];

  for (const rule of rules) {
    try {
      let count = 0;
      out = out.replace(rule.re, () => { count++; return rule.to; });
      if (count > 0) applied.push({ rule: rule.id, count });
    } catch { /* skip malformed rule */ }
  }

  return { text: out, generalizations: applied };
}

/**
 * Classify how widely a lesson applies, from its content and origin.
 * @param {Object} obs — observation row
 * @param {{ text: string, generalizations: Array }} gen — generalized content
 * @returns {{ scope: 'project'|'machine'|'universal', score: number, signals: string[] }}
 */
function classifyScope(obs, gen) {
  const content = String(obs.content || '');
  const title = String(obs.title || '');
  const haystack = (content + ' ' + title).toLowerCase();
  const signals = [];
  let score = 50; // start neutral

  // Signals toward universal (pattern-level, tool-level, no local specifics)
  if (/\b(?:tool|api|schema|parameter|argument|validation|escaping|encoding|encoding|utf|json|yaml|regex|timeout|retry|race condition|off-by-one|null|undefined)\b/i.test(haystack)) {
    score += 20; signals.push('tooling/api pattern');
  }
  if (/\b(?:always|never|whenever|any tool|every time|rule of thumb|best practice)\b/i.test(haystack)) {
    score += 15; signals.push('general rule');
  }
  if (/\b(?:git|npm|node|python|curl|ssh|docker)\b/i.test(haystack)) {
    score += 10; signals.push('universal tooling');
  }
  if (gen.generalizations.length === 0) {
    score += 10; signals.push('no local specifics');
  }

  // Signals toward project-specific
  if (/\b(?:this (?:repo|project|codebase)|our (?:code|server|api)|src\/|tests?\/|package\.json)\b/i.test(haystack)) {
    score -= 25; signals.push('references this project');
  }
  if (gen.generalizations.some(g => g.rule === 'abs-paths' || g.rule === 'repo-names')) {
    score -= 10; signals.push('had paths (generalized)');
  }
  if ((obs.type === 'fact' || obs.type === 'decision') && /config|schema|migration|endpoint|internal/i.test(haystack)) {
    score -= 15; signals.push('config/internal specific');
  }

  // Business-domain content is never universal
  if (/\b(?:customer|invoice|payment|order|user data|credentials?\b)/i.test(haystack)) {
    score -= 20; signals.push('domain-specific');
  }

  let scope = 'project';
  if (score >= 70) scope = 'universal';
  else if (score >= 45) scope = 'machine';

  return { scope, score, signals };
}

// ─── Lesson rendering ────────────────────────────────────────────────────────

function slugify(title) {
  return String(title || 'lesson')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'lesson';
}

function hashLesson(type, title, content) {
  return crypto.createHash('sha256').update(type + '\n' + title + '\n' + content).digest('hex').slice(0, 16);
}

/**
 * Render a single lesson markdown file.
 * @param {Object} params
 * @returns {string} file content
 */
function renderLesson({ hash, type, scope, scopeScore, scopeSignals, title, body, confidence, sourceIds, redactions, generalizations }) {
  const frontmatter = [
    '---',
    'id: ' + hash,
    'type: ' + type,
    'scope: ' + scope,
    'scope_score: ' + scopeScore,
    'confidence: ' + confidence,
    'sources: [' + sourceIds.join(', ') + ']',
    'created_at: ' + new Date().toISOString(),
    'sanitized: true',
    'redaction_count: ' + redactions.reduce((s, r) => s + r.count, 0),
    'generalization_rules: [' + generalizations.map(g => g.rule).join(', ') + ']',
    '---',
    '',
  ].join('\n');

  const sigLine = scopeSignals.length ? '\nScope signals: ' + scopeSignals.join('; ') + '\n' : '';
  const redLine = redactions.length
    ? '\n<sanitization-report>\n' + redactions.map(r => '- ' + r.rule + ': ' + r.count + ' occurrence(s)').join('\n') + '\n</sanitization-report>\n'
    : '';

  return frontmatter + '# ' + title + '\n\n' + body + sigLine + redLine;
}

// ─── Core: distill observations into lessons/ ────────────────────────────────

/**
 * Distill vault observations into the local lessons/ markdown layer.
 * Idempotent: a lesson whose content hash already exists is skipped.
 * Fail-closed: any sanitizer block or overload skips the lesson (with reason).
 *
 * @param {Object} db — better-sqlite3 handle
 * @param {Object} [opts]
 * @param {string} [opts.project] — project path filter (defaults to all)
 * @param {string} [opts.outDir] — lessons directory (default <project>/.cortex/lessons)
 * @param {number} [opts.sinceDays] — only observe rows created in the last N days
 * @param {number} [opts.minConfidence] — minimum confidence (default 70)
 * @param {number} [opts.limit] — max observations to consider (default 500)
 * @param {boolean} [opts.dryRun] — report without writing
 * @returns {{ considered: number, written: number, skipped: number, files: string[], reasons: Array<{id:number, reason:string}> }}
 */
function distillObservations(db, opts = {}) {
  const outDir = opts.outDir;
  const project = opts.project || null;
  const sinceDays = opts.sinceDays || 90;
  const minConfidence = typeof opts.minConfidence === 'number' ? opts.minConfidence : 70;
  const limit = opts.limit || 500;
  const dryRun = !!opts.dryRun;

  const rows = db.prepare(`
    SELECT id, project_path, type, title, content, tags, confidence, created_at
    FROM observations
    WHERE is_active = 1
      AND type IN (${DISTILLABLE_TYPES.map(() => '?').join(',')})
      AND confidence >= ?
      AND created_at >= datetime('now', '-' || ? || ' days')
      ${project ? 'AND project_path = ?' : ''}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...DISTILLABLE_TYPES, minConfidence, sinceDays, ...(project ? [project] : []), limit);

  const result = { considered: rows.length, written: 0, skipped: 0, files: [], reasons: [] };

  if (!dryRun && outDir && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const existing = new Set();
  if (!dryRun && outDir && fs.existsSync(outDir)) {
    for (const f of fs.readdirSync(outDir)) {
      const m = f.match(/^([0-9a-f]{16})-/);
      if (m) existing.add(m[1]);
    }
  }

  for (const row of rows) {
    try {
      // 1. Screen for hard-block classes (fail-closed). Override type to a
      // seedable one so screenSeed reaches its credential check even for
      // error/failure rows (its own type gate would short-circuit first).
      const screen = sanitizer.screenSeed({ ...row, type: 'learning' });
      if (!screen.allowed) {
        // For distillation (local layer) the seedable-type restriction of the
        // shared sanitizer is too strict — only fail on credential-class issues.
        if (screen.blockedBy && screen.blockedBy.length > 0) {
          result.skipped++;
          result.reasons.push({ id: row.id, reason: 'credential-class content: ' + screen.blockedBy.join(', ') });
          continue;
        }
        // other reasons (type gate) are acceptable here — we pre-filtered types
      }

      // 2. Generalize
      const genTitle = generalize(row.title || '');
      const genContent = generalize(row.content || '');

      // 3. Sanitize (redaction pass on generalized text)
      const redTitle = sanitizer._redact(genTitle.text);
      const redContent = sanitizer._redact(genContent.text);
      const totalRedactions = [...redTitle.redactions, ...redContent.redactions];
      const redCount = totalRedactions.reduce((s, r) => s + r.count, 0);
      if (redCount > sanitizer.MAX_REDACTIONS) {
        result.skipped++;
        result.reasons.push({ id: row.id, reason: 'too machine-specific (' + redCount + ' redactions needed)' });
        continue;
      }

      // 4. Classify scope
      const scope = classifyScope(row, { text: redContent.text, generalizations: genContent.generalizations });

      // 5. Compose lesson body
      const body = redContent.text.trim();
      const hash = hashLesson(row.type, redTitle.text.trim(), body);

      // Idempotency: already distilled?
      if (existing.has(hash)) {
        result.skipped++;
        result.reasons.push({ id: row.id, reason: 'already distilled (' + hash + ')' });
        continue;
      }

      const filename = hash + '-' + slugify(redTitle.text) + '.md';
      const content = renderLesson({
        hash,
        type: row.type,
        scope: scope.scope,
        scopeScore: scope.score,
        scopeSignals: scope.signals,
        title: redTitle.text.trim(),
        body,
        confidence: row.confidence,
        sourceIds: [row.id],
        redactions: totalRedactions,
        generalizations: [...genTitle.generalizations, ...genContent.generalizations],
      });

      if (!dryRun && outDir) {
        fs.writeFileSync(path.join(outDir, filename), content, 'utf8');
        existing.add(hash);
      }
      result.files.push(filename);
      result.written++;
    } catch (err) {
      // Fail-closed per lesson: a single bad row must never abort the batch.
      result.skipped++;
      result.reasons.push({ id: row.id, reason: 'distill error (fail-closed): ' + (err && err.message ? err.message : err) });
    }
  }

  // Index file for human review
  if (!dryRun && outDir && result.written > 0) {
    const indexPath = path.join(outDir, 'INDEX.md');
    const lines = ['# Lesson Index', '', 'Auto-generated by `agentic-cortex distill`. Human review gate for seed candidacy.', ''];
    for (const f of fs.readdirSync(outDir).filter(f => f.endsWith('.md') && f !== 'INDEX.md').sort()) {
      const raw = fs.readFileSync(path.join(outDir, f), 'utf8');
      const fm = raw.match(/^---\n([\s\S]*?)\n---/);
      const get = (k) => { const m = fm && fm[1].match(new RegExp('^' + k + ': (.+)$', 'm')); return m ? m[1] : '?'; };
      lines.push('- [' + get('id') + '](./' + f + ') — ' + get('type') + ' / scope ' + get('scope') + ' — ' + f.replace(/^[0-9a-f]{16}-/, '').replace(/\.md$/, ''));
    }
    fs.writeFileSync(indexPath, lines.join('\n'), 'utf8');
  }

  return result;
}

module.exports = {
  DISTILLABLE_TYPES,
  generalize,
  classifyScope,
  slugify,
  hashLesson,
  renderLesson,
  distillObservations,
};
