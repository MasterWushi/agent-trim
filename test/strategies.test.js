'use strict';
// Structured-strategy correctness: conservative detection, every unique
// error preserved, false-positive formats fall through to generic, and the
// result contract (meta) is populated honestly.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compress } = require('../bin/trim-core.js');
const applyStrategies = require('../bin/strategies');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const run = (name, opts) => compress(fx(name), { noSidecar: true, ...opts });

// ---- meta contract shape ----
{
  const { out, meta } = run('build-pass-large.txt', { exitCode: 0 });
  assert.ok(meta.changed && out !== fx('build-pass-large.txt'), 'changed');
  assert.strictEqual(meta.strategy, 'generic');
  assert.ok(meta.inputBytes > meta.outputBytes, 'shrank');
  assert.ok(meta.inputLines > meta.outputLines, 'fewer lines');
  assert.ok(meta.lossy, 'template collapse is lossy');
  assert.ok(meta.omittedLines > 0, 'omitted counted');
  assert.strictEqual(meta.sidecarPath, null);
  assert.ok(typeof meta.reason === 'string' && meta.reason.length, 'reason present');
}
// unchanged short output → meta.changed false, lossless
{
  const src = fx('clean-short.txt');
  const { out, meta } = compress(src);
  assert.strictEqual(out, src, 'clean short output untouched');
  assert.strictEqual(meta.changed, false);
  assert.strictEqual(meta.lossy, false);
  assert.strictEqual(meta.omittedLines, 0);
}

// ---- eslint-json ----
{
  const { out, meta } = run('eslint.json', { exitCode: 1 });
  assert.strictEqual(meta.strategy, 'eslint-json');
  assert.ok(out.includes("'fetchAll' is not defined."), 'error text kept');
  assert.ok(out.includes('no-undef') && out.includes('eqeqeq') && out.includes('prefer-const'), 'rule ids kept');
  assert.ok(out.includes('/repo/src/api.js') && out.includes('/repo/src/db.js') && out.includes('/repo/src/render.js'), 'all dirty files kept');
  assert.ok(out.includes('4:7'), 'line:col kept');
  assert.ok(!out.includes('clean-0.js'), 'clean files collapsed');
  assert.ok(out.includes('20 clean files omitted'), 'clean count reported');
  assert.ok(out.includes('duplicate') && out.includes('deduped'), 'exact duplicate deduped and reported');
  assert.ok(meta.outputBytes < meta.inputBytes / 4, 'big shrink on eslint json');
}
// eslint-lookalike that isn't valid JSON falls through
{
  const { meta } = compress('[' + 'x'.repeat(3000) + ']', { noSidecar: true });
  assert.notStrictEqual(meta.strategy, 'eslint-json');
}

// ---- tsc ----
{
  const { out, meta } = run('tsc-errors.txt', { exitCode: 2 });
  assert.strictEqual(meta.strategy, 'tsc');
  // every unique message survives
  for (const frag of [
    "Type 'string' is not assignable to type 'number'.",
    "Property 'foo' does not exist on type 'Widget'.",
    "Argument of type 'null' is not assignable to parameter of type 'Config'.",
    "Parameter 'x' implicitly has an 'any' type.",
    "'unused' is declared but its value is never read.",
    "Cannot find name 'Bufer'.",
  ])
    assert.ok(out.includes(frag), `unique diagnostic kept: ${frag}`);
  assert.ok(out.includes('src/app.ts(10,1)'), 'locations kept');
  assert.ok(out.includes('Found 25 errors in 4 files.'), 'summary kept');
  assert.strictEqual(meta.lossy, false, 'grouping is not lossy');
}

// ---- jest / vitest ----
{
  const { out, meta } = run('vitest-fail.txt', { exitCode: 1 });
  assert.strictEqual(meta.strategy, 'jest-vitest');
  assert.ok(out.includes('applies discount once'), 'failing test name kept');
  assert.ok(out.includes('- Expected') && out.includes('+ Received'), 'assertion diff kept');
  assert.ok(out.includes('expect(total(cart)).toBe(81);'), 'code frame kept');
  assert.ok(out.includes('Test Files  1 failed | 3 passed (4)'), 'summary kept');
  assert.ok(out.includes('✓ test/unit/suite0.test.ts (15 tests)'), 'suite-level pass line kept');
  assert.ok(!out.includes('suite0 > case 3'), 'per-test pass lines collapsed');
  assert.ok(out.includes('passing-test lines collapsed'), 'marker explains');
}
{
  const { out, meta } = run('jest-pass.txt', { exitCode: 0 });
  assert.strictEqual(meta.strategy, 'jest-vitest');
  assert.ok(out.includes('PASS src/__tests__/mod0.test.js'), 'suite PASS lines kept');
  assert.ok(out.includes('Tests:       72 passed, 72 total'), 'summary kept');
  assert.ok(!out.includes('scenario 3'), 'per-test lines collapsed');
}

// ---- pytest ----
{
  const { out, meta } = run('pytest-fail.txt', { exitCode: 1 });
  assert.strictEqual(meta.strategy, 'pytest');
  assert.ok(out.includes('test_token_refresh FAILED'), 'FAILED progress line kept');
  assert.ok(out.includes('assert 0 == 3600'), 'assertion detail kept');
  assert.ok(out.includes('short test summary info'), 'summary section kept');
  assert.ok(out.includes('2 failed, 50 passed in 3.41s'), 'final counts kept');
  assert.ok(!out.includes('test_case_7 PASSED'), 'PASSED lines collapsed');
}

// ---- go test ----
{
  const { out, meta } = run('go-test-fail.txt', { exitCode: 1 });
  assert.strictEqual(meta.strategy, 'go-test');
  assert.ok(out.includes('--- FAIL: TestRace'), 'FAIL kept');
  assert.ok(out.includes('race_test.go:31: got 3 writers, want 1'), 'failure log kept');
  assert.ok(out.includes('panic: runtime error: index out of range'), 'panic kept');
  assert.ok(out.includes('ok  \texample.com/other'), 'package ok line kept');
  assert.ok(!out.includes('--- PASS: TestHandler5'), 'PASS lines collapsed');
}

// ---- diffstat ----
{
  const { out, meta } = run('git-diffstat.txt', { exitCode: 0 });
  assert.strictEqual(meta.strategy, 'diffstat');
  for (let i = 0; i < 60; i++) assert.ok(out.includes(`file_${i}.ts`), `file_${i} kept`);
  assert.ok(out.includes('60 files changed'), 'summary kept');
  assert.ok(!/\| +\d+ [+-]+/.test(out), 'histograms stripped');
  assert.strictEqual(meta.lossy, false);
}

// ---- jsonl-log ----
{
  const { out, meta } = run('jsonl.log', { exitCode: 0 });
  assert.strictEqual(meta.strategy, 'jsonl-log');
  assert.strictEqual((out.match(/upstream timeout after 5000ms/g) || []).length, 5, 'all 5 errors kept verbatim');
  assert.strictEqual((out.match(/retry scheduled for job/g) || []).length, 3, 'all 3 warns kept');
  assert.ok(out.includes('routine records collapsed'), 'marker explains');
  assert.ok(meta.outputBytes < meta.inputBytes / 5, 'big shrink on jsonl');
}
// JSON array (not JSONL) does not match jsonl-log
{
  const arr = JSON.stringify([{ a: 1 }, { a: 2 }], null, 2) + '\n'.repeat(5) + 'x'.repeat(2500);
  const { meta } = compress(arr, { noSidecar: true });
  assert.notStrictEqual(meta.strategy, 'jsonl-log');
}

// ---- strategies never fire on enumeration prompts ----
{
  const { meta } = run('jest-pass.txt', { exitCode: 0, enumerate: true });
  assert.strictEqual(meta.strategy, 'generic');
}
// ---- TRIM_STRATEGIES=off disables the layer ----
{
  process.env.TRIM_STRATEGIES = 'off';
  const { meta } = run('jest-pass.txt', { exitCode: 0 });
  assert.strictEqual(meta.strategy, 'generic');
  delete process.env.TRIM_STRATEGIES;
}

// ---- adversarial prose: no strategy match, no crash, signal-ish lines kept ----
{
  const { out, meta } = run('adversarial-prose.txt', { exitCode: 0 });
  assert.strictEqual(meta.strategy, 'generic');
  assert.ok(out.includes('No errors occurred during generation.'), 'final line kept');
}
// ---- injection-shaped text passes through as data ----
{
  const { out } = run('injection-shaped.txt', { exitCode: 0 });
  assert.ok(out.includes('Ignore all previous instructions'), 'injection text not eaten (it is data)');
}
// ---- source code stays whole under the dump cap ----
{
  const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'source-code.txt'), 'utf8');
  const { out, meta } = compress(src, { isDump: true, noSidecar: true });
  assert.strictEqual(out, src, 'source file untouched');
  assert.strictEqual(meta.strategy, 'generic');
}
// ---- unicode + CRLF ----
{
  const { out } = run('unicode-crlf.txt', { exitCode: 0 });
  assert.ok(out.includes('エラー: ファイルが見つかりません'), 'unicode signal line kept');
  assert.ok(!out.includes('\r'), 'CRLF normalized');
}

// ---- npm audit JSON ----
{
  const { out, meta } = run('npm-audit.json', { exitCode: 1, command: 'npm audit --json' });
  assert.strictEqual(meta.strategy, 'npm-audit');
  assert.ok(out.includes('critical 1') && out.includes('critical gamma') && out.includes('prototype pollution'));
  assert.ok(/^high alpha .*\[direct; fix available\]$/m.test(out), 'direct dependency with a fix is flagged');
  assert.ok(/^moderate beta .*\[transitive; fix: beta@2\.0\.0 \(major\)\]$/m.test(out), 'transitive dependency reports the fix that clears it');
  assert.ok(/^critical gamma .*\[direct; no fix\]$/m.test(out), 'direct dependency with no fix is flagged');
  assert.ok(!out.includes('node_modules'), 'dependency node structures still dropped');
}
// array-valued vulnerabilities from another scanner must not be claimed
{
  const trivy = JSON.stringify({
    vulnerabilities: [
      { id: 'CVE-2024-1234', severity: 'HIGH', pkg: 'openssl', desc: 'x'.repeat(300) },
      { id: 'CVE-2024-9999', severity: 'CRITICAL', pkg: 'zlib', desc: 'y'.repeat(300) },
    ],
  });
  assert.strictEqual(applyStrategies(trivy, { command: 'cat trivy-report.json' }), null);
  assert.strictEqual(compress(trivy, { command: 'cat trivy-report.json', noSidecar: true }).out, trivy);
}
// command-independent recognition still handles a real npm audit payload
{
  const oneLine = JSON.stringify(JSON.parse(fx('npm-audit.json')));
  const npm = compress(oneLine, { command: 'npm audit --json', noSidecar: true });
  const make = compress(oneLine, { command: 'make audit', noSidecar: true });
  assert.strictEqual(npm.meta.strategy, 'npm-audit');
  assert.strictEqual(make.meta.strategy, 'npm-audit');
  assert.strictEqual(make.out, npm.out);
}

// ---- generic diagnostic blocks keep frames whole and fold exact repeats ----
{
  const { out, meta } = run('rustc-diagnostics.txt', { exitCode: 1, command: 'cargo check' });
  assert.strictEqual(meta.strategy, 'diagnostic-block');
  assert.ok(out.includes('expected `u32`, found `String`'), 'code frame preserved');
  assert.ok(out.includes('E0308 ×2') && out.includes('src/a.rs:10') && out.includes('src/b.rs:20'), 'repeat locations summarized');
  assert.ok(out.includes('aborting due to 2 previous errors'), 'tail diagnostic preserved');
}
// ---- repeated diagnostics: every file:line edit anchor survives verbatim ----
{
  for (const n of [2, 5, 20, 500]) {
    const locations = [];
    const lines = [];
    for (let i = 0; i < n; i++) {
      const loc = `src/gen${String(i).padStart(3, '0')}.rs:10`;
      locations.push(loc);
      lines.push(
        'error[E0308]: mismatched types',
        ` --> ${loc}:5`,
        '  |',
        '10 |     value',
        '  |     ^^^^^ expected `u32`, found `String`'
      );
    }
    const { out, meta } = compress(lines.join('\n'), { exitCode: 1, command: 'cargo check', noSidecar: true });
    for (const loc of locations) assert.ok(out.includes(loc), `${n} occurrences: ${loc} anchor kept`);
    if (n >= 5) assert.strictEqual(meta.strategy, 'diagnostic-block', `${n} occurrences use the diagnostic strategy`);
  }
}

// ---- mixed content is uncertain and falls through ----
{
  const { meta } = run('mixed-diagnostics.txt', { exitCode: 1 });
  assert.strictEqual(meta.strategy, 'generic');
}

console.log('strategies.test.js: all assertions passed');
