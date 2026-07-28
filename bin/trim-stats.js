#!/usr/bin/env node
'use strict';
// Summarize the local metrics log (see maybeLog in trim-core.js).
//   node bin/trim-stats.js [path] [--json]
// Default path: $TRIM_METRICS or ~/.trim-metrics.jsonl.
//
// Every figure printed here carries an evidence label so a reader knows what
// kind of claim it is, never an unqualified percentage:
//   L1-component   — bytes / lines / token estimate changed
//   L2-preservation — diagnostics and identifiers verified retained
//   L3-context     — model-visible payload verified
//   L8-trajectory  — reruns / re-reads / turns observed
//
// Token figures use the class-based estimator (bin/lib/token-estimate.js)
// when a record carries it; older metrics lines (pre-T5) fall back to the
// bytes/4 heuristic so mixed-vintage logs still produce a valid report —
// the JSONL itself is never rewritten.
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

if (!recs.length) {
  if (asJson) console.log(JSON.stringify({ file, message: 'no data' }));
  else console.log(`trim metrics — ${file}\n  no data`);
  process.exit(0);
}

const L = (label, value) => `${value} [${label}]`;
const evidence = (label, value) => ({ value, evidence: label });

// Estimator name/class-mix per record: prefer T5's class-based fields when
// present, fall back to bytes/4 for old lines so mixed logs don't NaN.
function recTokEst(r) {
  if (typeof r.inTokEst === 'number' && typeof r.outTokEst === 'number') {
    return { inTok: r.inTokEst, outTok: r.outTokEst, cls: r.tokenClass || 'mixed', estimator: r.estimator || 'class/1' };
  }
  const inBytes = r.inBytes || 0;
  const outBytes = r.outBytes || 0;
  return { inTok: Math.round(inBytes / 4), outTok: Math.round(outBytes / 4), cls: null, estimator: 'bytes/4' };
}

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

// Per-record token estimates (class-based when available, bytes/4 fallback)
// and the class mix, for the "estimator class/1" footnote.
let tokenInSum = 0;
let tokenOutSum = 0;
const classMix = new Map();
let usedClassEstimator = false;
for (const r of processed) {
  const { inTok, outTok, cls, estimator } = recTokEst(r);
  tokenInSum += inTok;
  tokenOutSum += outTok;
  if (estimator === 'class/1') usedClassEstimator = true;
  if (cls) classMix.set(cls, (classMix.get(cls) || 0) + 1);
}
const classMixStr = [...classMix.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([k, n]) => `${k} ${n}`)
  .join(', ');
const estimatorLabel = usedClassEstimator ? 'class/1' : 'bytes/4';

const summary = {
  file,
  callsProcessed: evidence('L1-component', processed.length),
  callsChanged: evidence('L1-component', changed.length),
  bypasses: recs.filter((r) => r.bypass).length,
  inputBytes: evidence('L1-component', inBytes),
  outputBytes: evidence('L1-component', outBytes),
  bytesSaved: evidence('L1-component', inBytes - outBytes),
  compressionRatio: evidence('L1-component', inBytes ? +(outBytes / inBytes).toFixed(3) : null),
  estTokensSavedPerSend: evidence('L1-component', tokenInSum - tokenOutSum),
  estimator: estimatorLabel,
  tokenClassMix: classMixStr || null,
  estNote: `token figures use the ${estimatorLabel} estimator; savings recur every turn the result stays in context`,
  lossy: evidence('L2-preservation', processed.filter((r) => r.lossy).length),
  lossless: evidence('L2-preservation', changed.filter((r) => !r.lossy).length),
  sidecars: processed.filter((r) => r.sidecar).length,
  strategyDetections: processed.filter((r) => r.strategy && r.strategy !== 'generic').length,
  possibleRepeatCommands: evidence('L8-trajectory', repeats.length),
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
console.log(`  calls processed:   ${L('L1-component', num(summary.callsProcessed.value))} (${num(summary.callsChanged.value)} changed, ${num(summary.bypasses)} bypassed via TRIM_OFF)`);
console.log(`  bytes:             ${num(inBytes)} -> ${num(outBytes)} (saved ${L('L1-component', num(summary.bytesSaved.value))}, ratio ${L('L1-component', summary.compressionRatio.value ?? 'n/a')})`);
console.log(`  est. tokens saved: ~${L(`L1-component, estimator ${estimatorLabel}`, num(summary.estTokensSavedPerSend.value))} per send${classMixStr ? ` (class mix: ${classMixStr})` : ''}`);
console.log(`  lossy/lossless:    ${L('L2-preservation', num(summary.lossy.value))} lossy, ${L('L2-preservation', num(summary.lossless.value))} lossless-only`);
console.log(`  sidecars written:  ${num(summary.sidecars)}   structured detections: ${num(summary.strategyDetections)}`);
console.log(`  exact duplicates:  ${num(summary.exactDuplicates)} (metrics-only; output unchanged)`);
if (summary.possibleRepeatCommands.value) console.log(`  ⚠ possible re-runs after lossy trims: ${L('L8-trajectory', num(summary.possibleRepeatCommands.value))} (same command within 5 min)`);
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
