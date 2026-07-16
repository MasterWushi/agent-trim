'use strict';
// go test -v output. "=== RUN/PAUSE/CONT" and "--- PASS:" lines are pure
// progress noise; "ok <pkg>" package summaries are kept (collapse-by-suite),
// and every FAIL block, panic, and log line inside failing tests passes
// through verbatim (t.Log output of failing tests is indented under the
// "--- FAIL:" line, which is never removed).

const NOISE = /^\s*(=== (RUN|PAUSE|CONT)\s|--- PASS:)/;
const GO_MARK = /^(=== RUN\s|--- (PASS|FAIL):|ok\s+\S+\s|FAIL\s+\S+\s)/m;
const MIN_REMOVED = 10;

module.exports = {
  name: 'go-test',
  minBytes: 2000,
  apply(text) {
    if (!GO_MARK.test(text)) return null;
    const lines = text.split('\n');
    const out = [];
    let removed = 0;
    let markerAt = -1;
    for (const line of lines) {
      if (NOISE.test(line)) {
        if (markerAt === -1) {
          markerAt = out.length;
          out.push('');
        }
        removed++;
        continue;
      }
      out.push(line);
    }
    if (removed < MIN_REMOVED) return null;
    out[markerAt] =
      `[trim hook: ${removed} go test RUN/PASS progress lines collapsed; package results, ` +
      `all failures, and panics are kept in full]`;
    return {
      out: out.join('\n'),
      lossy: true, // passing test names dropped (package "ok" lines survive)
      omittedLines: removed,
      reason: 'go test progress lines collapsed; failures kept verbatim',
    };
  },
};
