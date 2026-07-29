'use strict';
// Deterministic, dependency-free token estimate. NOT a provider token count —
// it exists so the net-win gate and the stats report stop treating dense JSON
// and English prose as if they tokenize at the same rate. Classify, then
// divide by a per-class chars-per-token divisor.

const DIVISORS = { dense: 2.0, code: 2.6, mixed: 3.2, prose: 3.8 };

// Names the divisor set above, and lives next to it deliberately: the label's
// only job is to say which numbers produced a figure, so a reader comparing
// metrics of different vintages can tell whether they are comparable. Bump it
// whenever DIVISORS or classify() change.
const ESTIMATOR = 'class/1';

function classify(text) {
  const sample = text.length > 65536 ? text.slice(0, 65536) : text;
  if (!sample) return 'mixed';
  const cjk = (sample.match(/[　-鿿가-힯]/g) || []).length;
  if (cjk / sample.length > 0.15) return 'cjk';
  const nonWord = (sample.match(/[^\w\s]/g) || []).length / sample.length;
  const digits = (sample.match(/\d/g) || []).length / sample.length;
  const spaces = (sample.match(/ /g) || []).length / sample.length;
  const avgWord = sample.length / ((sample.match(/\s+/g) || []).length + 1);
  if (nonWord > 0.28 || digits > 0.22 || avgWord > 18) return 'dense';
  if (nonWord > 0.14) return 'code';
  if (spaces > 0.14 && nonWord < 0.09) return 'prose';
  return 'mixed';
}

// CJK: roughly one token per codepoint is the conservative assumption; using a
// chars/N divisor there would claim impossible savings.
function estimate(text) {
  if (!text) return { tokens: 0, cls: 'mixed' };
  const cls = classify(text);
  if (cls === 'cjk') return { tokens: [...text].length, cls };
  return { tokens: Math.ceil(text.length / DIVISORS[cls]), cls };
}

module.exports = { estimate, classify, DIVISORS, ESTIMATOR };
