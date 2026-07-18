#!/usr/bin/env node
'use strict';
// Summarize the local metrics log (see maybeLog in trim-core.js).
//   node bin/trim-stats.js [path] [--json]
// Default path: $TRIM_METRICS or ~/.trim-metrics.jsonl.
//
// Token figures are ESTIMATES (bytes / 4, the usual rough heuristic for
// English/code) — actual provider token counts are not available here, and
// this tool never claims otherwise. Real savings compound further because
// tool results are re-sent as input on every following turn of a session.
const fs = require('fs');
const os = require('os');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const file = args.find((a) => !a.startsWith('--')) || process.env.TRIM_METRICS || os.homedir() + '/.trim-metrics.jsonl';

if (!fs.existsSync(file)) {
  console.error(`no metrics log at ${file}\nenable with: touch ~/.trim-metrics.jsonl (or set TRIM_METRICS=/path)`);
  process.exit(1);
}

const recs = [];
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try {
    recs.push(JSON.parse(line));
  } catch {
    /* skip malformed line */
  }
}

const est = (bytes) => Math.round(bytes / 4);
const num = (n) => n.toLocaleString('en-US');
const processed = recs.filter((r) => !r.bypass);
const changed = processed.filter((r) => r.changed);
const inBytes = processed.reduce((s, r) => s + (r.inBytes || 0), 0);
const outBytes = processed.reduce((s, r) => s + (r.outBytes || 0), 0);

function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = r[key] || '(none)';
    const g = m.get(k) || { n: 0, in: 0, out: 0 };
    g.n++;
    g.in += r.inBytes || 0;
    g.out += r.outBytes || 0;
    m.set(k, g);
  }
  return [...m.entries()].sort((a, b) => b[1].in - a[1].in - (b[1].out - a[1].out));
}

// Possible re-runs: the same command fingerprint appearing again within
// 5 minutes of a LOSSY trim of that command — the signal that a marker
// failed to earn trust. Heuristic, not proof (watch loops re-run too).
const repeats = [];
const lastLossy = new Map();
for (const r of recs) {
  if (!r.cmdHash || !r.ts) continue;
  const t = Date.parse(r.ts);
  const prev = lastLossy.get(r.cmdHash);
  if (prev !== undefined && t - prev < 5 * 60 * 1000) repeats.push(r.cmdWord || r.cmdHash);
  if (r.lossy) lastLossy.set(r.cmdHash, t);
  else lastLossy.delete(r.cmdHash);
}

const summary = {
  file,
  callsProcessed: processed.length,
  callsChanged: changed.length,
  bypasses: recs.filter((r) => r.bypass).length,
  inputBytes: inBytes,
  outputBytes: outBytes,
  bytesSaved: inBytes - outBytes,
  compressionRatio: inBytes ? +(outBytes / inBytes).toFixed(3) : null,
  estTokensSavedPerSend: est(inBytes - outBytes),
  estNote: 'token figures are bytes/4 estimates, not provider counts; savings recur every turn the result stays in context',
  lossy: processed.filter((r) => r.lossy).length,
  lossless: changed.filter((r) => !r.lossy).length,
  sidecars: processed.filter((r) => r.sidecar).length,
  strategyDetections: processed.filter((r) => r.strategy && r.strategy !== 'generic').length,
  possibleRepeatCommands: repeats.length,
  exactDuplicates: processed.filter((r) => r.dupExact).length,
  byStrategy: Object.fromEntries(groupBy(processed, 'strategy').map(([k, g]) => [k, { calls: g.n, inBytes: g.in, outBytes: g.out }])),
  byRuntime: Object.fromEntries(groupBy(processed, 'tag').map(([k, g]) => [k, { calls: g.n, inBytes: g.in, outBytes: g.out }])),
  byCommand: Object.fromEntries(groupBy(processed.filter((r) => r.cmdWord), 'cmdWord').slice(0, 15).map(([k, g]) => [k, { calls: g.n, inBytes: g.in, outBytes: g.out }])),
  largest: processed
    .slice()
    .sort((a, b) => (b.inBytes || 0) - (a.inBytes || 0))
    .slice(0, 5)
    .map((r) => ({ ts: r.ts, tag: r.tag, cmdWord: r.cmdWord, strategy: r.strategy, inBytes: r.inBytes, outBytes: r.outBytes })),
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

console.log(`trim metrics — ${file}`);
console.log(`  calls processed:   ${num(summary.callsProcessed)} (${num(summary.callsChanged)} changed, ${num(summary.bypasses)} bypassed via TRIM_OFF)`);
console.log(`  bytes:             ${num(inBytes)} -> ${num(outBytes)} (saved ${num(summary.bytesSaved)}, ratio ${summary.compressionRatio ?? 'n/a'})`);
console.log(`  est. tokens saved: ~${num(summary.estTokensSavedPerSend)} per send (bytes/4 ESTIMATE, recurs each turn)`);
console.log(`  lossy/lossless:    ${num(summary.lossy)} lossy, ${num(summary.lossless)} lossless-only`);
console.log(`  sidecars written:  ${num(summary.sidecars)}   structured detections: ${num(summary.strategyDetections)}`);
console.log(`  exact duplicates:  ${num(summary.exactDuplicates)} (metrics-only; output unchanged)`);
if (summary.possibleRepeatCommands) console.log(`  ⚠ possible re-runs after lossy trims: ${num(summary.possibleRepeatCommands)} (same command within 5 min)`);
const table = (title, obj) => {
  const keys = Object.keys(obj);
  if (!keys.length) return;
  console.log(`  ${title}:`);
  for (const k of keys) {
    const g = obj[k];
    console.log(`    ${k.padEnd(14)} ${String(g.calls).padStart(5)} calls  ${num(g.inBytes).padStart(12)} -> ${num(g.outBytes)}`);
  }
};
table('by strategy', summary.byStrategy);
table('by runtime', summary.byRuntime);
table('by command', summary.byCommand);
if (summary.largest.length) {
  console.log('  largest outputs:');
  for (const l of summary.largest) console.log(`    ${l.ts}  ${(l.cmdWord || l.tag || '?').padEnd(12)} ${(l.strategy || '-').padEnd(12)} ${num(l.inBytes || 0)} -> ${num(l.outBytes || 0)}`);
}
