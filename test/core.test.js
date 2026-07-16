'use strict';
const assert = require('assert');
const {
  compress,
  isFileDump,
  looksLikeFailure,
  extractExitCode,
  requestsEnumeration,
  extractRelevanceTokens,
  pressureScale,
} = require('../bin/trim-core.js');

// ANSI strip
assert.strictEqual(compress('\x1b[31mred\x1b[0m ok').out, 'red ok');
// OSC sequence
assert.strictEqual(compress('\x1b]0;title\x07hello').out, 'hello');
// CR progress: keep last repaint
assert.strictEqual(compress('10%\r50%\r100% done').out, '100% done');
// CRLF is a line ending, not a repaint
assert.strictEqual(compress('a\r\nb\r\n').out, 'a\nb\n');
// trailing whitespace + blank collapse
assert.strictEqual(compress('a   \n\n\n\n\nb').out, 'a\n\nb');
// consecutive dedup >=3
assert.strictEqual(compress('x\nx\nx\nx\ny').out, 'x  [trim hook: line repeated 4x]\ny');
// dedup of 2 left alone
assert.strictEqual(compress('x\nx\ny').out, 'x\nx\ny');

// template collapse: same-shaped log lines fold to exemplar + count
{
  const lines = [];
  for (let i = 0; i < 50; i++) lines.push(`INFO worker processing job ${1000 + i}`);
  const out = compress(lines.join('\n')).out;
  assert.ok(out.includes('INFO worker processing job 1000'), 'exemplar kept');
  assert.ok(out.includes('[trim hook: 49 similar lines collapsed'), 'run collapsed');
  assert.ok(!out.includes('job 1049'), 'later lines folded');
}
// template collapse never swallows a signal line
{
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(`INFO worker processing job ${1000 + i}`);
  lines.splice(15, 0, 'WARN worker processing stalled');
  const out = compress(lines.join('\n')).out;
  assert.ok(out.includes('WARN worker processing stalled'), 'signal line survives collapse');
}
// short runs of similar lines left alone
{
  const src = 'INFO worker job 1\nINFO worker job 2\nINFO worker job 3';
  assert.strictEqual(compress(src).out, src);
}

// cap: passing output uses the tight cap, every signal line survives
{
  const lines = [];
  for (let i = 0; i < 1000; i++) lines.push(`installed package-${i}`);
  lines[500] = 'WARNING: deprecated dependency 500';
  lines[700] = 'npm ERR! peer conflict 700';
  const out = compress(lines.join('\n'), { exitCode: 0, noSidecar: true }).out;
  assert.ok(out.includes('WARNING: deprecated dependency 500'), 'warn kept');
  assert.ok(out.includes('npm ERR! peer conflict 700'), 'error kept');
  assert.ok(out.includes('lines omitted from this view, none with errors/warnings'), 'marker present');
  assert.ok(out.includes('TRIM_OFF=1'), 'rerun hint present');
  assert.ok(out.includes('installed package-0') && out.includes('installed package-999'), 'head+tail kept');
  assert.ok(out.split('\n').length < 140, 'pass cap applied');
}
// failing output keeps the generous cap
{
  const lines = [];
  // varying token counts so template collapse can't fold these before the cap
  for (let i = 0; i < 1000; i++) lines.push(Array((i % 5) + 1).fill(`tok${i}`).join(' '));
  const pass = compress(lines.join('\n'), { exitCode: 0, noSidecar: true }).out;
  const fail = compress(lines.join('\n'), { exitCode: 1, noSidecar: true }).out;
  assert.ok(fail.split('\n').length > pass.split('\n').length, 'fail cap > pass cap');
}
// failure sniffed from text when no exit code given
assert.ok(looksLikeFailure('Traceback (most recent call last):'), 'sniffs traceback');
assert.ok(!looksLikeFailure('all good here'), 'clean text not failure');
assert.ok(looksLikeFailure('all good here', 1), 'exit code wins');
assert.ok(!looksLikeFailure('Error: but exit says ok', 0), 'exit 0 wins over sniff');

// file dump detection
assert.ok(isFileDump('cat some/file.txt'), 'cat is a dump');
assert.ok(isFileDump('  cat file'), 'leading space ok');
assert.ok(!isFileDump('cat file | grep x'), 'pipe is not a dump');
assert.ok(!isFileDump('ls -la'), 'ls is not a dump');

// exit code extraction
assert.strictEqual(extractExitCode({ exitCode: 2 }), 2);
assert.strictEqual(extractExitCode({ exit_code: 0 }), 0);
assert.strictEqual(extractExitCode({}), undefined);
assert.strictEqual(extractExitCode('text'), undefined);

// enumeration carve-out: prompt detection
assert.ok(requestsEnumeration('report every warning in the build'), 'quantified noun');
assert.ok(requestsEnumeration('list the files it compiled'), 'verb + noun');
assert.ok(!requestsEnumeration('explore the whole repo'), 'prose does not trigger');
assert.ok(!requestsEnumeration(''), 'empty prompt');
// enumeration disables elision (and template collapse) below CAP_ENUMERATE
{
  const lines = [];
  for (let i = 0; i < 900; i++) lines.push(`compiled module alpha ${i}`);
  const out = compress(lines.join('\n'), { exitCode: 0, enumerate: true }).out;
  assert.ok(!out.includes('omitted') && !out.includes('collapsed'), 'nothing elided');
  assert.ok(out.includes('compiled module alpha 899'), 'all lines present');
}

// relevance tokens: extraction
assert.deepStrictEqual(extractRelevanceTokens('what does `ioredis` say about "W1042"?'), ['ioredis', 'w1042']);
assert.deepStrictEqual(extractRelevanceTokens('no marked spans here'), []);
// prompt-named lines survive the cap even without error keywords
{
  const lines = [];
  for (let i = 0; i < 1000; i++) lines.push(Array((i % 5) + 1).fill(`tok${i}`).join(' '));
  lines[500] = 'ioredis resolved to 5.3.2';
  const out = compress(lines.join('\n'), { exitCode: 0, noSidecar: true, relevanceTokens: ['ioredis'] }).out;
  assert.ok(out.includes('ioredis resolved to 5.3.2'), 'relevance line kept');
}

// pressure scaling: inert below 400KB, tightens after, floors hold
assert.strictEqual(pressureScale(100 * 1024), 1);
assert.strictEqual(pressureScale(500 * 1024), 0.75);
assert.strictEqual(pressureScale(2 * 1024 * 1024), 0.5);
{
  const lines = [];
  for (let i = 0; i < 1000; i++) lines.push(Array((i % 5) + 1).fill(`tok${i}`).join(' '));
  const full = compress(lines.join('\n'), { exitCode: 0, noSidecar: true, scale: 1 }).out;
  const tight = compress(lines.join('\n'), { exitCode: 0, noSidecar: true, scale: 0.5 }).out;
  assert.ok(tight.split('\n').length < full.split('\n').length, 'scaled cap is tighter');
}

// sidecar: huge output → digest + full copy on disk
{
  const fs = require('fs');
  const path = require('path');
  const { isSidecarPath, isLogPath, isGeneratedPath, SIDECAR_DIR } = require('../bin/trim-core.js');
  const lines = [];
  for (let i = 0; i < 800; i++) lines.push(`build step ${i} completed with artifacts written to output directory`);
  lines[400] = 'WARNING: symbol collision in module foo';
  lines[600] = 'TypeError: cannot read properties of undefined';
  const src = lines.join('\n');
  assert.ok(src.length > 15000, 'fixture large enough');

  const out = compress(src, { exitCode: 0, sessionId: 'sctest' }).out;
  assert.ok(out.includes('saved in full to'), 'digest header present');
  const file = out.match(/saved in full to (\S+);/)[1];
  assert.ok(fs.existsSync(file), 'sidecar file written');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), src, 'sidecar holds full cleaned text');
  assert.ok(out.includes('L401: WARNING: symbol collision in module foo'), 'signal line with real line number');
  assert.ok(out.includes('1 error') && out.includes('1 warning'), 'categorical census');
  assert.ok(out.length < src.length / 5, 'digest is much smaller');
  assert.ok(isSidecarPath(file), 'sidecar path recognized');

  // idempotent: same content → same file, no error
  assert.strictEqual(compress(src, { exitCode: 0, sessionId: 'sctest' }).out, out);

  // shell-truncation guard: same size with hostMayTruncate skips the sidecar
  const guarded = compress(src, { exitCode: 0, hostMayTruncate: true }).out;
  assert.ok(!guarded.includes('saved in full to'), 'guard skips sidecar');
  assert.ok(guarded.includes('omitted') || guarded.includes('collapsed'), 'falls back to inline cap');

  // re-reading a sidecar never re-sidecars — capped inline instead
  const reread = compress(src, { exitCode: 0, noSidecar: true }).out;
  assert.ok(!reread.includes('saved in full to'), 'no nested sidecar');
  assert.ok(reread.includes('TypeError: cannot read properties'), 'signal survives the inline cap');

  // enumeration never sidecars — its point is nothing elided
  const en = compress(src, { exitCode: 0, enumerate: true }).out;
  assert.ok(!en.includes('saved in full to'), 'enumerate skips sidecar');

  fs.rmSync(file, { force: true });

  // path detection
  assert.ok(isLogPath('logs/app.log') && isLogPath('/var/x/app.log.1') && isLogPath('/srv/log/run.txt'), 'log paths');
  assert.ok(!isLogPath('src/main.rs'), 'source is not a log');
  assert.ok(isGeneratedPath('package-lock.json') && isGeneratedPath('a/node_modules/x/index.js') && isGeneratedPath('app.min.js'), 'generated paths');
  assert.ok(!isGeneratedPath('src/lock.js'), 'source is not generated');
  assert.ok(!isSidecarPath(path.join(SIDECAR_DIR, 'nested', 'x.txt')), 'nested path is not sidecar dir');
}

// idempotent-ish: compressing compressed output does not grow
{
  const once = compress('a\n\n\n\nb  \n').out;
  assert.strictEqual(compress(once).out, once);
}
// empty input
assert.strictEqual(compress('').out, '');

// metrics passthrough: palsync block stored verbatim, command never logged raw
{
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { maybeLog } = require('../bin/trim-core.js');
  const mPath = path.join(os.tmpdir(), `trim-metrics-test-${process.pid}.jsonl`);
  process.env.TRIM_METRICS = mPath;
  const { stats, meta } = compress('x\n'.repeat(500), { noSidecar: true });
  maybeLog('palsync', stats, meta, {
    command: 'palsync validate --token SECRET',
    palsync: { rawBytes: 9000, nativeBytes: 4000, cacheHit: false },
  });
  delete process.env.TRIM_METRICS;
  const rec = JSON.parse(fs.readFileSync(mPath, 'utf8').trim());
  assert.deepStrictEqual(rec.palsync, { rawBytes: 9000, nativeBytes: 4000, cacheHit: false }, 'palsync block verbatim');
  assert.strictEqual(rec.cmdWord, 'palsync', 'only first word logged');
  assert.ok(!JSON.stringify(rec).includes('SECRET'), 'full command text never logged');
  assert.strictEqual(rec.strategy, 'generic');
  fs.rmSync(mPath, { force: true });
}

console.log('core.test.js: all assertions passed');
