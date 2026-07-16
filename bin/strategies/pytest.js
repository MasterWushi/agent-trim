'use strict';
// pytest verbose output. "path::test PASSED [ 42%]" lines dominate a big
// verbose run; the FAILURES section, errors, warnings summary, and the final
// counts line are the signal and pass through verbatim. Non-verbose runs
// (dot progress) don't match and fall through — they're already dense.

const SESSION = /^=+ test session starts =+$/m;
const PASS_LINE = /^(\S+::\S.*?)\s+PASSED(\s+\[\s*\d+%\])?$/;
const MIN_REMOVED = 10;

module.exports = {
  name: 'pytest',
  minBytes: 2000,
  apply(text) {
    if (!SESSION.test(text)) return null;
    const lines = text.split('\n');
    const out = [];
    let removed = 0;
    let markerAt = -1;
    let inFailures = false;
    for (const line of lines) {
      // never touch anything from the FAILURES/ERRORS sections onward
      if (/^=+ (FAILURES|ERRORS|warnings summary|short test summary info) =*/.test(line)) inFailures = true;
      if (!inFailures && PASS_LINE.test(line)) {
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
      `[trim hook: ${removed} PASSED test lines collapsed; failures, errors, warnings, ` +
      `and the summary are kept in full]`;
    return {
      out: out.join('\n'),
      lossy: true, // passing test ids dropped (counts survive in the summary line)
      omittedLines: removed,
      reason: 'pytest PASSED lines collapsed; failures kept verbatim',
    };
  },
};
