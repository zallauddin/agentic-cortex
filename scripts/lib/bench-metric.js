'use strict';
/**
 * Shared deterministic retrieval metric for the benchmark scripts.
 *
 * Extracted so `longmemeval-h2h.js`, `strategy-sweep.js` and
 * `retrieval-headroom.js` cannot drift apart — MEMORYBENCH.md promises the
 * same matcher everywhere, and a change in one of them silently invalidates
 * the others' numbers.
 *
 * THE RULE
 *   hit@k = at least half of the ground-truth answer's significant words
 *   (length > 2) appear in the concatenated top-k context.
 *
 * THE SCORABILITY RULE (added 2026-10-06 after a real defect)
 *   An earlier version returned `false` whenever `gt.length <= 3`, which was
 *   meant to skip unanswerable questions but also silently auto-failed every
 *   SHORT answer — LongMemEval's multi-session answers are "$12", "$50",
 *   "20%", "2". Nine of thirty questions were therefore unmeasurable for
 *   every provider, capping the metric at 21/30 no matter how good retrieval
 *   was. Non-scorable questions are now *excluded from the denominator*
 *   instead of counted as misses, and the count is reported alongside so the
 *   reader can see the raw hits/total too.
 */

/** Unanswerable-by-design markers (LoCoMo adversarial rows, empty answers). */
const UNANSWERABLE = /^(undefined|null|nan|n\/a|none|unknown|)$/i;

/** Normalise a ground-truth value to a trimmed string, '' when unanswerable. */
function normalizeAnswer(gt) {
  if (gt == null) return '';
  const s = String(gt).trim();
  if (UNANSWERABLE.test(s)) return '';
  return s;
}

/** Significant answer words — the units the overlap threshold counts. */
function answerWords(gt) {
  const s = normalizeAnswer(gt).toLowerCase();
  if (!s) return [];
  return [...new Set(s.split(/\s+/).filter((w) => w.length > 2))];
}

/**
 * Can this answer be judged by word-overlap at all?
 * False when there is no answer, or when the answer carries no word of
 * length > 2 (pure numerics like "2" / "25") — those cannot be distinguished
 * from a coincidental substring in a large context blob, so scoring them
 * would be noise rather than signal.
 */
function isScorable(gt) {
  return answerWords(gt).length > 0;
}

/** Does `blob` contain at least half of `words`? */
function coversWords(blob, words) {
  if (!words.length) return false;
  const lower = blob.toLowerCase();
  return words.filter((w) => lower.includes(w)).length >= Math.ceil(words.length * 0.5);
}

/** hit@k for a ground-truth answer. Returns false for non-scorable answers. */
function evaluate(contents, groundTruth) {
  const words = answerWords(groundTruth);
  if (words.length === 0) return false;
  return coversWords(contents.join(' '), words);
}

module.exports = { normalizeAnswer, answerWords, isScorable, coversWords, evaluate };
