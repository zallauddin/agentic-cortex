'use strict';

/**
 * seed-sanitizer.js — Privacy gate for the distributed learning loop.
 *
 * AC's knowledge sharing model is "seeds, not dumps": only distilled,
 * machine-global learnings ever leave a machine (via the optional git memory
 * repo). Everything else — raw observations, session transcripts, code
 * symbols, project facts — stays in the local SQLite vault forever.
 *
 * This module is the LAST checkpoint before a seed is written to the repo.
 * It answers two questions for every observation:
 *
 *   1. Should this knowledge leave the machine at all?  → screenSeed()
 *      (hard-block classes: credentials, keys, tokens, customer data,
 *      infra endpoints, licensee-identifying strings)
 *   2. What must be redacted before it can travel?      → sanitizeSeed()
 *      (connection strings, bearer tokens, AWS keys, emails, user paths,
 *      hostnames, IPs, Slack/webhook URLs — replaced with typed placeholders)
 *
 * Design constraints:
 *   - Deterministic and synchronous: same input → same output, no LLM.
 *   - Fail-closed: if anything throws, the seed is NOT exported.
 *   - Redaction never destroys the lesson: patterns are replaced with
 *     typed placeholders (<redacted:aws-key>) so the learning still
 *     transfers without the sensitive payload.
 *
 * Terms-of-service posture: AC never extracts another vendor's proprietary
 * model outputs or service responses into its learning loop. Only the local
 * user's own distilled learnings are shared, and only after this gate.
 *
 * @module core/seed-sanitizer
 */

// ─── Hard-block patterns: if matched, the seed must NOT leave the machine ───

const HARD_BLOCK_PATTERNS = [
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'certificate', re: /-----BEGIN CERTIFICATE-----/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: 'password-assignment', re: /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|auth[_-]?token|access[_-]?token)\b\s*[:=]\s*['"][^'"]{6,}['"]/i },
  { id: 'aws-secret', re: /\baws.{0,20}secret.{0,20}[:=]\s*['"]?[A-Za-z0-9/+=]{40}\b/i },
];

// ─── Redaction rules: match → typed placeholder ─────────────────────────────

const REDACTION_RULES = [
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'aws-key' },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, label: 'github-token' },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, label: 'slack-token' },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g, label: 'google-key' },
  { id: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, label: 'openai-key' },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, label: 'anthropic-key' },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{30,}\b/g, label: 'npm-token' },
  { id: 'bearer-token', re: /\b(?:bearer|authorization)\s*[:=]\s*['"]?[A-Za-z0-9._+/=-]{16,}['"]?/gi, label: 'auth-header' },
  { id: 'webhook-url', re: /https:\/\/(?:hooks\.slack\.com|discord\.com\/api\/webhooks|outlook\.office\.com\/webhook)\/[^\s"')]+/g, label: 'webhook-url' },
  { id: 'connection-string', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|mssql):\/\/[^\s"')]+:[^\s"')@]+@[^\s"')]+/g, label: 'connection-string' },
  { id: 'connection-string-nopw', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|mssql):\/\/[^\s"')]*:[^\s"')@]+@[^\s"')]+/g, label: 'connection-string' },
  { id: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, label: 'email' },
  { id: 'ipv4', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, label: 'ip-address' },
  { id: 'unix-home-path', re: /(?:\/(?:home|Users)\/)[A-Za-z0-9._-]+/g, label: 'user-path' },
  { id: 'windows-profile-path', re: /(?:[A-Za-z]:\\Users\\)[^\\\s"')]+/g, label: 'user-path' },
];

/** Number of distinct redactions before a seed is considered too dirty to travel. */
const MAX_REDACTIONS = 8;

/**
 * Test a string against the hard-block classes.
 * @param {string} text
 * @returns {{ blocked: boolean, matches: string[] }}
 */
function _hardBlockMatches(text) {
  const matches = [];
  for (const p of HARD_BLOCK_PATTERNS) {
    try {
      if (p.re.test(text)) matches.push(p.id);
    } catch { /* skip malformed rule */ }
  }
  return { blocked: matches.length > 0, matches };
}

/**
 * Redact every configured pattern in a string.
 * @param {string} text
 * @returns {{ text: string, redactions: Array<{rule: string, count: number}> }}
 */
function _redact(text) {
  let out = text;
  const applied = [];
  for (const rule of REDACTION_RULES) {
    try {
      let count = 0;
      out = out.replace(rule.re, () => { count++; return `<redacted:${rule.label}>`; });
      if (count > 0) applied.push({ rule: rule.id, count });
    } catch { /* skip malformed rule */ }
  }
  return { text: out, redactions: applied };
}

/**
 * Screen an observation that is a candidate for export as a distributed seed.
 * Fail-closed: any unexpected error results in a block.
 *
 * @param {Object} obs — observation row (title, content, type, tags, project_path…)
 * @returns {{ allowed: boolean, reason?: string, blockedBy?: string[] }}
 */
function screenSeed(obs) {
  try {
    const title = String(obs.title || '');
    const content = String(obs.content || '');

    // Never export raw session transcripts or file dumps, whatever the content.
    const tags = (() => { try { return JSON.parse(obs.tags || '[]'); } catch { return []; } })();
    const blockTags = ['raw-transcript', 'session-transcript', 'code-body', 'enterprise-data'];
    const tagHits = tags.filter(t => blockTags.includes(t));
    if (tagHits.length > 0) {
      return { allowed: false, reason: 'tagged as non-exportable: ' + tagHits.join(', ') };
    }

    // Error/observation types are often incident-specific — only distilled
    // types (learning, instruction, fact, decision, principle, pattern,
    // synthesis) are seed candidates. Enforced here as a second gate.
    const seedableTypes = ['learning', 'instruction', 'fact', 'decision', 'principle', 'pattern', 'synthesis'];
    if (!seedableTypes.includes(obs.type)) {
      return { allowed: false, reason: 'type "' + obs.type + '" is not a seedable type (distill first)' };
    }

    // Hard-block content classes (credentials etc.)
    for (const [field, text] of [['title', title], ['content', content]]) {
      const { blocked, matches } = _hardBlockMatches(text);
      if (blocked) {
        return { allowed: false, reason: 'hard-blocked field "' + field + '" contains credential-class content', blockedBy: matches };
      }
    }

    return { allowed: true };
  } catch (err) {
    // Fail closed.
    return { allowed: false, reason: 'sanitizer internal error (fail-closed): ' + (err && err.message ? err.message : err) };
  }
}

/**
 * Sanitize an observation in place (returns a NEW object) for export.
 * Redacts credentials, identity paths, hosts; strips provenance that could
 * identify a person (agent_id, session_id are local-only concepts).
 *
 * @param {Object} obs — observation row
 * @returns {{ ok: boolean, seed?: Object, redactions: Array, reason?: string }}
 */
function sanitizeSeed(obs) {
  const screen = screenSeed(obs);
  if (!screen.allowed) {
    return { ok: false, redactions: [], reason: screen.reason };
  }

  const titleResult = _redact(String(obs.title || ''));
  const contentResult = _redact(String(obs.content || ''));

  const totalRedactions =
    titleResult.redactions.reduce((s, r) => s + r.count, 0) +
    contentResult.redactions.reduce((s, r) => s + r.count, 0);

  if (totalRedactions > MAX_REDACTIONS) {
    return {
      ok: false,
      redactions: [...titleResult.redactions, ...contentResult.redactions],
      reason: 'too many redactions needed (' + totalRedactions + ' > ' + MAX_REDACTIONS + ') — content too machine-specific to share safely',
    };
  }

  const seed = {
    type: obs.type,
    title: titleResult.text.trim(),
    content: contentResult.text.trim(),
    confidence: obs.confidence,
    importance: obs.importance,
    provenance: 'seeded', // never export the original explicit/inferred/observed chain
    tags: (() => {
      try { return JSON.parse(obs.tags || '[]'); } catch { return []; }
    })().filter(t => !/^(machine-global|cross-project|auto-promoted)$/.test(t)),
    // agent_id / session_id / project_path are deliberately NOT exported —
    // they identify a person, a machine, or an internal repo name.
    sanitizedAt: new Date().toISOString(),
    redactionCount: totalRedactions,
  };

  return { ok: true, seed, redactions: [...titleResult.redactions, ...contentResult.redactions] };
}

module.exports = {
  HARD_BLOCK_PATTERNS,
  REDACTION_RULES,
  MAX_REDACTIONS,
  screenSeed,
  sanitizeSeed,
};
