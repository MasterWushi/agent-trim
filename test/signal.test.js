'use strict';
// Signal-detection fixtures: false negatives (diagnostic lines that carry no
// literal "error") and false positives (prose that must NOT match, so word
// boundaries actually bound). The kept direction is safe — these tests exist
// so the boundary is deliberate, not accidental.
const assert = require('assert');
const { compress, signalCensus } = require('../bin/trim-core.js');

// A line survives a tight cap iff SIGNAL_RE matches it. Probe via compress:
// bury the probe line mid-file in 400 filler lines and check survival.
function survivesCap(probe) {
  const filler = [];
  for (let i = 0; i < 400; i++) filler.push(`>>> filler item number ${i} <<<`);
  filler[200] = probe;
  const { out } = compress(filler.join('\n'), { exitCode: 0, noSidecar: true });
  return out.includes(probe);
}

// --- false negatives: all of these MUST be treated as signal ---
const mustKeep = [
  'Found 3 errors and 2 warnings.', // plural summary
  '- Expected', // jest assertion diff
  '+ Received',
  'E       assert 0 == 3600', // pytest continuation
  'not ok 3 - handles empty input', // TAP
  '✗ should update the cache', // mocha/vitest glyph
  '× order > applies discount once', // vitest windows glyph
  'Segmentation fault (core dumped)',
  'command terminated with exit code 137',
  'Process exited with non-zero exit status',
  'FATAL: could not connect to server',
  'thread panicked at src/main.rs:14',
  'DeprecationWarning: Buffer() is deprecated',
  'UnhandledPromiseRejection: connection reset',
  'ld: undefined reference to `png_create_read_struct`',
  'Killed (OOM)',
  'AssertionError: expected 90 to be 81',
];
for (const probe of mustKeep) assert.ok(survivesCap(probe), `must keep: ${probe}`);

// --- false positives: none of these should match as signal ---
// (checked directly against the regex via a helper compress on a single line
// being NOT counted in the census)
const mustNotMatch = [
  'The Terror is a novel by Dan Simmons', // 'error' inside a word
  'errorless operation is the goal', // trailing chars
  'unexpectedly fast build', // 'expected' inside a word
  'cd /app/warnings_archive/2024', // no — wait, "warnings" IS a word here
];
// the archive path genuinely contains the word "warnings"; drop it from the
// negative set — it SHOULD match (safe direction) and documents the tradeoff.
mustNotMatch.pop();
for (const probe of mustNotMatch) {
  const filler = [];
  for (let i = 0; i < 400; i++) filler.push(`>>> filler item number ${i} <<<`);
  filler[200] = probe;
  const { meta } = compress(filler.join('\n'), { exitCode: 0, noSidecar: true });
  assert.strictEqual(meta.preservedErrors + meta.preservedWarnings, 0, `must not count as signal: ${probe}`);
}

// --- census with plurals and glyphs ---
{
  const lines = ['npm ERR! peer dep conflict', '✗ renders the header', 'WARNING: low disk', '3 warnings generated'];
  const census = signalCensus(lines, [0, 1, 2, 3]);
  assert.ok(census.includes('1 error'), `census errors: ${census}`);
  assert.ok(census.includes('1 failure'), `census failures: ${census}`);
  assert.ok(census.includes('2 warnings'), `census warnings: ${census}`);
}

// --- mostly-signal output is never cut into a grown, tail-less view ---
{
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push(`error in module ${i}: unique failure detail ${i}`);
  lines.push('done with 300 errors');
  const src = lines.join('\n');
  const { out, meta } = compress(src, { exitCode: 1, noSidecar: true });
  assert.strictEqual(out, src, 'all-signal output left whole');
  assert.ok(!meta.lossy, 'not lossy');
  assert.ok(meta.outputBytes <= meta.inputBytes, 'never grows');
}

console.log('signal.test.js: all assertions passed');
