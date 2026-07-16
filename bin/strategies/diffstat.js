'use strict';
// git diff --stat / git show --stat. The +/- histogram after each count is a
// scaled visualization of the number beside it — redundant for a model, and
// it defeats the generic template collapser in the worst way (folding stat
// lines would LOSE filenames). This keeps every filename and change count,
// drops only the bars.
//
// Detection needs both the per-file shape and git's own summary line, so a
// random table with pipes can't match.

const STAT_LINE = /^( .*\S \|\s+\d+)( [+-]+)$/;
const SUMMARY = /^\s*\d+ files? changed(, \d+ insertions?\(\+\))?(, \d+ deletions?\(-\))?/m;
const MIN_LINES = 5;

module.exports = {
  name: 'diffstat',
  minBytes: 2000,
  apply(text) {
    if (!SUMMARY.test(text)) return null;
    const lines = text.split('\n');
    let hits = 0;
    for (const l of lines) if (STAT_LINE.test(l)) hits++;
    if (hits < MIN_LINES) return null;
    const out = lines.map((l) => {
      const m = STAT_LINE.exec(l);
      return m ? m[1] : l;
    });
    return {
      out: out.join('\n'),
      lossy: false, // the bar is a rendering of the kept count, not data
      omittedLines: 0,
      reason: 'diffstat histogram bars stripped; every file and count kept',
    };
  },
};
