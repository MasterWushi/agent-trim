#!/usr/bin/env node
'use strict';

process.env.TRIM_SIDECAR = 'off';
delete process.env.TRIM_PROFILE;
const { compress } = require('../bin/trim-core');
const check = process.argv.includes('--check');

function sized(line, bytes) {
  const count = Math.ceil(bytes / Buffer.byteLength(line));
  return line.repeat(count).slice(0, bytes);
}
const kinds = {
  repetitive: (bytes) => sized('INFO worker processing job 12345\n', bytes),
  'error-dense': (bytes) => sized('src/app.ts:10:2 error TS1234: expected value\n  frame context\n\n', bytes),
  'single-line': (bytes) => 'x'.repeat(bytes),
};
const rows = [];
for (const mb of [1, 10]) {
  for (const [kind, build] of Object.entries(kinds)) {
    const source = build(mb * 1024 * 1024);
    const times = [];
    let outputBytes = 0;
    for (let i = 0; i < 3; i++) {
      const start = process.hrtime.bigint();
      const result = compress(source, { noSidecar: true, exitCode: kind === 'error-dense' ? 1 : 0 });
      times.push(Number(process.hrtime.bigint() - start) / 1e6);
      outputBytes = result.meta.outputBytes;
    }
    times.sort((a, b) => a - b);
    const p50 = times[1];
    rows.push({ kind, mb, outputBytes, p50Ms: +p50.toFixed(2), p95Ms: +times[2].toFixed(2), throughputMBps: +(mb / (p50 / 1000)).toFixed(1) });
  }
}
for (const row of rows) console.log(`${row.mb}MB ${row.kind}: p50 ${row.p50Ms}ms, p95 ${row.p95Ms}ms, ${row.throughputMBps} MB/s, out ${row.outputBytes}`);
if (check && rows.some((row) => !Number.isFinite(row.throughputMBps) || row.throughputMBps < 0.5 || row.p95Ms > 20000)) {
  console.error('perf --check: loose throughput/latency guard failed');
  process.exit(1);
}
if (check) console.log('perf --check: ok');
