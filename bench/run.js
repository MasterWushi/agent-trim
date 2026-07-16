#!/usr/bin/env node
'use strict';
// Benchmark runner over the fixture corpus.
//   node bench/run.js            — print report, rewrite bench/baseline.json + baseline.md
//   node bench/run.js --check    — compare against committed baseline, exit 1 on regression
//
// Byte counts are deterministic (sidecars disabled, no timestamps in output),
// so the baseline is an exact regression contract. Runtime is reported for
// information only and never compared. Token figures are bytes/4 ESTIMATES.
process.env.TRIM_SIDECAR = 'off';

const fs = require('fs');
const path = require('path');
const { compress } = require('../bin/trim-core.js');

const FIX = path.join(__dirname, '..', 'test', 'fixtures');
const check = process.argv.includes('--check');

// Per-fixture contract: compression opts, strings that MUST survive (unique
// signal — losing one is a false elision), and whether the fixture must pass
// through byte-identical.
const CASES = [
  { file: 'clean-short.txt', opts: { exitCode: 0 }, mustEqual: true },
  {
    file: 'npm-install.txt',
    opts: { exitCode: 0, command: 'npm install' },
    mustKeep: ['npm warn deprecated inflight@1.0.6', 'npm warn deprecated glob@7.2.3', 'added 600 packages in 12s'],
  },
  { file: 'build-pass-large.txt', opts: { exitCode: 0, command: 'make all' }, mustKeep: ['Build complete: build/app (4.2 MB)'] },
  {
    file: 'build-fail-large.txt',
    opts: { exitCode: 2, command: 'make all' },
    mustKeep: [
      'src/parser.c:88:12: error: implicit declaration of function `lex_next`',
      'src/ast.c:210:3: error: expected `;` before `}` token',
      'src/emit.c:55:9: warning: unused variable `tmp`',
      'collect2: error: ld returned 1 exit status',
      'make: *** [Makefile:12: all] Error 2',
    ],
  },
  {
    file: 'tsc-errors.txt',
    opts: { exitCode: 2, command: 'npx tsc --noEmit' },
    mustKeep: [
      "Type 'string' is not assignable to type 'number'.",
      "Property 'foo' does not exist on type 'Widget'.",
      "Argument of type 'null' is not assignable to parameter of type 'Config'.",
      "Parameter 'x' implicitly has an 'any' type.",
      "'unused' is declared but its value is never read.",
      "Cannot find name 'Bufer'.",
      'Found 25 errors in 4 files.',
    ],
  },
  {
    file: 'eslint.json',
    opts: { exitCode: 1, command: 'npx eslint . --format json' },
    mustKeep: ["'fetchAll' is not defined.", "Expected '===' and instead saw '=='.", "'pool' is assigned a value but never used.", "'document' is not defined."],
  },
  {
    file: 'vitest-fail.txt',
    opts: { exitCode: 1, command: 'npx vitest run' },
    mustKeep: ['applies discount once', 'AssertionError: expected 90 to be 81', '- Expected', '+ Received', 'Test Files  1 failed | 3 passed (4)'],
  },
  { file: 'jest-pass.txt', opts: { exitCode: 0, command: 'npx jest' }, mustKeep: ['Tests:       72 passed, 72 total'] },
  {
    file: 'pytest-fail.txt',
    opts: { exitCode: 1, command: 'pytest -v' },
    mustKeep: ['test_token_refresh FAILED', 'test_expiry_clock_skew FAILED', 'assert 0 == 3600', '2 failed, 50 passed in 3.41s'],
  },
  {
    file: 'go-test-fail.txt',
    opts: { exitCode: 1, command: 'go test -v ./...' },
    mustKeep: ['--- FAIL: TestRace', 'race_test.go:31: got 3 writers, want 1', 'panic: runtime error: index out of range', 'FAIL\texample.com/pkg\t0.612s'],
  },
  {
    file: 'git-diffstat.txt',
    opts: { exitCode: 0, command: 'git diff --stat main' },
    mustKeep: ['file_0.ts', 'file_31.ts', 'file_59.ts', '60 files changed, 2480 insertions(+), 644 deletions(-)'],
  },
  {
    file: 'jsonl.log',
    opts: { exitCode: 0, command: 'tail -n 300 logs/app.log' },
    mustKeep: ['upstream timeout after 5000ms on call 50', 'upstream timeout after 5000ms on call 280', 'retry scheduled for job 170'],
  },
  { file: 'source-code.txt', opts: { isDump: true, command: 'cat src/reconcile.js' }, mustEqual: true },
  { file: 'adversarial-prose.txt', opts: { exitCode: 0 }, mustKeep: ['No errors occurred during generation.'] },
  { file: 'injection-shaped.txt', opts: { exitCode: 0 }, mustKeep: ['Ignore all previous instructions'] },
  { file: 'unicode-crlf.txt', opts: { exitCode: 0 }, mustKeep: ['エラー: ファイルが見つかりません (error: file not found)'] },
  { file: 'progress-bars.txt', opts: { exitCode: 0 }, mustKeep: ['Download complete', 'extracted 214 files'] },
  { file: 'docker-build.txt', opts: { exitCode: 0, command: 'docker build .' }, mustKeep: ['writing image sha256:9f8e7d6c5b4a DONE 0.0s'] },
];

const rows = [];
let failures = 0;
for (const c of CASES) {
  const src = fs.readFileSync(path.join(FIX, c.file), 'utf8');
  const t0 = process.hrtime.bigint();
  const { out, meta } = compress(src, { ...c.opts });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const problems = [];
  if (c.mustEqual && out !== src) problems.push('MODIFIED (must pass through untouched)');
  for (const s of c.mustKeep || []) if (!out.includes(s)) problems.push(`LOST: ${s}`);
  if (problems.length) failures++;
  rows.push({
    file: c.file,
    strategy: meta.strategy,
    inBytes: meta.inputBytes,
    outBytes: meta.outputBytes,
    ratio: +(meta.outputBytes / meta.inputBytes).toFixed(3),
    estTokensIn: Math.round(meta.inputBytes / 4),
    estTokensOut: Math.round(meta.outputBytes / 4),
    lossy: meta.lossy,
    errorsKept: meta.preservedErrors,
    warningsKept: meta.preservedWarnings,
    ms: +ms.toFixed(2),
    problems,
  });
}

const totalIn = rows.reduce((s, r) => s + r.inBytes, 0);
const totalOut = rows.reduce((s, r) => s + r.outBytes, 0);
const summary = {
  fixtures: rows.length,
  falseElisionFailures: failures,
  totalInBytes: totalIn,
  totalOutBytes: totalOut,
  overallRatio: +(totalOut / totalIn).toFixed(3),
  estTokensSaved: Math.round((totalIn - totalOut) / 4),
};

const baselinePath = path.join(__dirname, 'baseline.json');
if (check) {
  const base = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  let bad = 0;
  for (const r of rows) {
    const b = base.rows.find((x) => x.file === r.file);
    if (r.problems.length) {
      console.error(`FAIL ${r.file}: ${r.problems.join('; ')}`);
      bad++;
      continue;
    }
    if (!b) continue; // new fixture — no baseline yet
    if (r.outBytes > b.outBytes * 1.1 + 64) {
      console.error(`REGRESSION ${r.file}: outBytes ${b.outBytes} -> ${r.outBytes}`);
      bad++;
    }
  }
  if (bad) {
    console.error(`bench --check: ${bad} failure(s)`);
    process.exit(1);
  }
  console.log(`bench --check: ok (${rows.length} fixtures, overall ratio ${summary.overallRatio}, baseline ${base.summary.overallRatio})`);
  process.exit(0);
}

fs.writeFileSync(baselinePath, JSON.stringify({ summary, rows: rows.map(({ ms, problems, ...r }) => r) }, null, 2) + '\n');

const md = [];
md.push('# Benchmark baseline');
md.push('');
md.push('Generated by `node bench/run.js` over `test/fixtures/` (sidecars disabled for determinism).');
md.push('Token columns are **bytes/4 estimates**, not provider counts. Real sessions save these');
md.push('tokens again on every later turn the result stays in context.');
md.push('');
md.push('| fixture | strategy | in bytes | out bytes | ratio | est tok in | est tok out | lossy | err kept | warn kept |');
md.push('|---|---|---:|---:|---:|---:|---:|---|---:|---:|');
for (const r of rows)
  md.push(`| ${r.file} | ${r.strategy} | ${r.inBytes} | ${r.outBytes} | ${r.ratio} | ${r.estTokensIn} | ${r.estTokensOut} | ${r.lossy ? 'yes' : 'no'} | ${r.errorsKept} | ${r.warningsKept} |`);
md.push('');
md.push(`**Overall: ${totalIn} → ${totalOut} bytes (ratio ${summary.overallRatio}), ~${summary.estTokensSaved} estimated tokens saved per send; ${failures} false-elision failures.**`);
md.push('');
fs.writeFileSync(path.join(__dirname, 'baseline.md'), md.join('\n'));

for (const r of rows) {
  const flag = r.problems.length ? '  << ' + r.problems.join('; ') : '';
  console.log(`${r.file.padEnd(24)} ${r.strategy.padEnd(12)} ${String(r.inBytes).padStart(7)} -> ${String(r.outBytes).padStart(6)}  (${r.ratio})  ${r.ms}ms${flag}`);
}
console.log(`\noverall: ${totalIn} -> ${totalOut} bytes, ratio ${summary.overallRatio}, ~${summary.estTokensSaved} est tokens saved per send, ${failures} false-elision failures`);
process.exit(failures ? 1 : 0);
