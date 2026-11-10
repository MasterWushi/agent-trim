'use strict';
// go test -v output. "=== RUN/PAUSE/CONT" and "--- PASS:" lines are pure
// progress noise; "ok <pkg>" package summaries are kept (collapse-by-suite),
// and every FAIL block, panic, and log line inside failing tests passes
// through verbatim (t.Log output of failing tests is indented under the
// "--- FAIL:" line, which is never removed).
const { collapseLines } = require('../lib/collapse-lines');

const NOISE = /^\s*(=== (RUN|PAUSE|CONT)\s|--- PASS:)/;
const GO_MARK = /^(=== RUN\s|--- (PASS|FAIL):|ok\s+\S+\s|FAIL\s+\S+\s)/m;
const MIN_REMOVED = 10;

module.exports = {
  name: 'go-test',
  minBytes: 2000,
  apply(text) {
    if (!GO_MARK.test(text)) return null;
    const c = collapseLines(text, (line) => NOISE.test(line), MIN_REMOVED, (removed) =>
      `[trim hook: ${removed} go test RUN/PASS progress lines collapsed; package results, ` +
      `all failures, and panics are kept in full]`);
    if (!c) return null;
    return {
      out: c.out,
      lossy: true, // passing test names dropped (package "ok" lines survive)
      omittedLines: c.removed,
      reason: 'go test progress lines collapsed; failures kept verbatim',
    };
  },
};
