'use strict';
// Jest / Vitest human output. Passing-test lines are the bulk of a big run
// and carry no signal once the summary confirms the counts; failures are the
// evidence and are kept VERBATIM — assertion diffs, expected/received blocks,
// stack traces, console output, coverage tables, the summary, all untouched.
//
// Only per-test pass lines are removed:  "  ✓ renders header (12 ms)".
// Suite-level lines (jest "PASS src/x.test.js", vitest "✓ src/x.test.ts
// (14 tests) 23ms") are KEPT — that is the collapse-by-suite the model needs
// to see coverage without per-test noise.
const { collapseLines } = require('../lib/collapse-lines');

const SUMMARY = /^\s*(Test Suites:|Tests:\s|Test Files\s{2}|Snapshots:|Duration\s{2})/m;
const PASS_TEST = /^\s*[✓√✔]\s/;
const SUITE_LINE = /\(\d+ tests?[^)]*\)|^(PASS|FAIL)\s/;
const MIN_REMOVED = 10;

module.exports = {
  name: 'jest-vitest',
  minBytes: 2000,
  apply(text) {
    if (!SUMMARY.test(text)) return null;
    const c = collapseLines(text, (line) => PASS_TEST.test(line) && !SUITE_LINE.test(line), MIN_REMOVED, (removed) =>
      `[trim hook: ${removed} passing-test lines collapsed; suite results, all failures, ` +
      `and the summary are kept in full]`);
    if (!c) return null;
    return {
      out: c.out,
      lossy: true, // individual passing test names are gone (counts survive in the summary)
      omittedLines: c.removed,
      reason: 'passing tests collapsed by suite; failures kept verbatim',
    };
  },
};
