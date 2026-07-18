'use strict';
// Structured-format strategy registry. Each strategy owns its detection and
// returns null unless it is CONFIDENT the text is its format — a wrong "no"
// costs nothing (the generic compressor runs), a wrong "yes" could mangle
// output, so every detector is deliberately conservative.
//
// Strategy module shape:
//   {
//     name: string,          // goes into meta.strategy and telemetry
//     minBytes?: number,     // skip below this size (default 2000 — small
//                            // outputs aren't worth semantic work)
//     apply(text, ctx) -> { out, lossy, omittedLines?, reason } | null
//   }
// ctx: { command?, exitCode?, signalRe } — never required for correctness.
//
// Hard invariants enforced here, not trusted per-strategy:
//   - a throw inside one strategy skips it, never the whole pipeline
//   - a result that isn't smaller than the input is discarded
//   - a result over the absolute line backstop is discarded (a strategy is
//     supposed to produce bounded output; if it can't, generic capping wins)

const BACKSTOP_LINES = 2000;

const strategies = [
  require('./eslint-json'),
  require('./tsc'),
  require('./test-runner-js'),
  require('./pytest'),
  require('./go-test'),
  require('./diffstat'),
  require('./jsonl-log'),
  require('./npm-audit'),
  require('./diagnostic-block'),
];

module.exports = function applyStrategies(text, ctx) {
  for (const s of strategies) {
    if (text.length < (s.minBytes || 2000)) continue;
    if (s.maxBytes && Buffer.byteLength(text) > s.maxBytes) continue;
    let r;
    try {
      r = s.apply(text, ctx);
    } catch {
      continue; // one broken strategy never blocks the rest
    }
    if (!r || typeof r.out !== 'string') continue;
    if (r.out.length >= text.length) continue;
    const outLines = r.out.split('\n').length;
    if (outLines > BACKSTOP_LINES) continue;
    if (typeof r.omittedLines !== 'number') {
      r.omittedLines = Math.max(0, text.split('\n').length - outLines);
    }
    return { ...r, strategy: s.name };
  }
  return null;
};

module.exports.strategies = strategies;
