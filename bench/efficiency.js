#!/usr/bin/env node
'use strict';

process.env.TRIM_SIDECAR = 'off';
delete process.env.TRIM_PROFILE;
const fs = require('fs');
const path = require('path');
const { compress } = require('../bin/trim-core');

const check = process.argv.includes('--check');
const fixtures = fs.readdirSync(path.join(__dirname, '..', 'test', 'fixtures')).filter((name) => !name.startsWith('.')).sort();
const runtimes = {
  claude: { runtime: 'claude', hostComplete: true },
  pi: { runtime: 'pi', hostComplete: true },
  codex: { runtime: 'codex', hostComplete: true },
  opencode: { runtime: 'opencode', hostComplete: true },
};
const rows = [];
for (const [runtime, posture] of Object.entries(runtimes)) {
  for (const file of fixtures) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', file), 'utf8');
    const failing = /fail|error|eslint|audit|rustc/i.test(file);
    const samples = [];
    let result;
    for (let i = 0; i < 3; i++) {
      const start = process.hrtime.bigint();
      result = compress(source, { ...posture, exitCode: failing ? 1 : 0, command: file, noSidecar: false });
      samples.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    samples.sort((a, b) => a - b);
    rows.push({
      runtime,
      file,
      inBytes: result.meta.inputBytes,
      outBytes: result.meta.outputBytes,
      strategy: result.meta.strategy,
      lossy: result.meta.lossy,
      omittedLines: result.meta.omittedLines,
      errors: result.meta.preservedErrors,
      warnings: result.meta.preservedWarnings,
      sidecar: !!result.meta.sidecarPath,
      p50Ms: +samples[1].toFixed(3),
      p95Ms: +samples[2].toFixed(3),
    });
  }
}
const deterministicRows = rows.map(({ p50Ms, p95Ms, ...row }) => row);
const byRuntime = {};
for (const runtime of Object.keys(runtimes)) {
  const selected = rows.filter((row) => row.runtime === runtime);
  byRuntime[runtime] = {
    fixtures: selected.length,
    inBytes: selected.reduce((sum, row) => sum + row.inBytes, 0),
    outBytes: selected.reduce((sum, row) => sum + row.outBytes, 0),
    sidecars: selected.filter((row) => row.sidecar).length,
  };
}
const baselineFile = path.join(__dirname, 'efficiency-baseline.json');
if (check) {
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  if (JSON.stringify(baseline.rows) !== JSON.stringify(deterministicRows)) {
    console.error('efficiency --check: deterministic fixture/runtime byte contract changed; regenerate and review bench/efficiency-baseline.json');
    process.exit(1);
  }
  console.log(`efficiency --check: ok (${rows.length} runtime-fixture replays)`);
  process.exit(0);
}
fs.writeFileSync(baselineFile, JSON.stringify({ byRuntime, rows: deterministicRows }, null, 2) + '\n');
const md = [
  '# Efficiency baseline',
  '',
  'Fixture replay through each runtime posture. Latency is informational; committed byte fields are deterministic.',
  'Sidecars are disabled for portable paths, while sidecar behavior is covered by core and adapter tests.',
  '',
  '| runtime | fixtures | input bytes | output bytes | ratio |',
  '|---|---:|---:|---:|---:|',
];
for (const [runtime, value] of Object.entries(byRuntime)) md.push(`| ${runtime} | ${value.fixtures} | ${value.inBytes} | ${value.outBytes} | ${(value.outBytes / value.inBytes).toFixed(3)} |`);
md.push('', 'Live collection:', '', '```bash', 'touch ~/.trim-metrics.jsonl', 'node bin/trim-stats.js', '```', '', 'Run equivalent Pi and Claude tasks with the same profile and compare `byRuntime`; token values remain estimates unless provider telemetry is collected separately.', '');
fs.writeFileSync(path.join(__dirname, '..', 'docs', 'efficiency-baseline.md'), md.join('\n'));
console.log(`efficiency baseline written (${rows.length} runtime-fixture replays)`);
