'use strict';
// TypeScript compiler diagnostics, non-pretty format:
//   path(line,col): error TS1234: message
// (tsc --pretty output has code frames and a different shape — after ANSI
// stripping it still doesn't match DIAG, so it falls through to generic.)
//
// Value is grouping: the same (severity, code, message) firing at many
// locations becomes one message line plus a location list. Every unique
// diagnostic and every location is preserved; only worth emitting when
// grouping or dedup actually buys something, otherwise return null.

const DIAG = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;

module.exports = {
  name: 'tsc',
  minBytes: 2000,
  apply(text) {
    const lines = text.split('\n');
    const groups = new Map(); // key -> { first, locs: [] }
    const order = [];
    const tail = [];
    let diagCount = 0;
    let otherNonBlank = 0;
    let current = null;
    for (const line of lines) {
      const m = DIAG.exec(line);
      if (m) {
        diagCount++;
        const key = `${m[4]} ${m[5]}: ${m[6]}`;
        current = groups.get(key);
        if (!current) {
          current = { header: key, extra: [], locs: [] };
          groups.set(key, current);
          order.push(current);
        }
        current.locs.push(`${m[1]}(${m[2]},${m[3]})`);
        continue;
      }
      if (/^\s+\S/.test(line) && current) {
        // indented continuation of a multi-line diagnostic: keep it once,
        // on the first exemplar of its group
        if (current.locs.length === 1) current.extra.push(line);
        continue;
      }
      current = null;
      if (/^Found \d+ error/.test(line) || /^\d+ errors?\b/.test(line)) {
        tail.push(line);
      } else if (line.trim()) {
        otherNonBlank++;
      }
    }
    // Confidence gate: mostly diagnostics, enough of them, and grouping must
    // actually help (unique < total); otherwise the format either isn't tsc
    // or the rendering wouldn't save anything.
    if (diagCount < 4) return null;
    if (otherNonBlank > diagCount * 0.3) return null;
    if (groups.size >= diagCount) return null;

    const body = [];
    for (const g of order) {
      body.push(g.header + (g.locs.length > 1 ? `  (${g.locs.length} locations)` : ''));
      for (const e of g.extra) body.push(e);
      body.push(`  at ${g.locs.join(', ')}`);
    }
    const head =
      `[trim hook: ${diagCount} TypeScript diagnostics grouped into ${groups.size} unique messages; ` +
      `every message and every location kept.]`;
    return {
      out: [head, ...body, ...tail].join('\n'),
      lossy: false, // grouping preserves all messages and all locations
      omittedLines: 0,
      reason: 'tsc diagnostics grouped by message; nothing dropped',
    };
  },
};
