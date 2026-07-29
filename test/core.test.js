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
  readSidecarMeta,
  capLines,
  protectedTrailer,
  alreadyCondensed,
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
// scattered relevance hits cannot tile a dense log and bypass the cap
{
  const lines = Array.from({ length: 2000 }, (_, i) =>
    i % 50 === 0 ? `ok widgetfoo step ${i}` : `line ${i} filler text`
  );
  const out = capLines(lines, 120, ['widgetfoo']);
  assert.ok(out.length <= 140, `relevance view stays near cap: ${out.length}`);
  assert.ok(out.includes('ok widgetfoo step 0'), 'relevance hit kept');
  assert.ok(out.some((line) => line.includes('lines omitted')), 'omission marker present');
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

  // exact host truncation knowledge permits an observed-only sidecar whose
  // marker and metadata never claim completeness
  const observed = compress(src, { exitCode: 0, hostMayTruncate: true, hostComplete: false, runtime: 'pi', sessionId: 'observed' }).out;
  assert.ok(observed.includes('saved as observed (host may have truncated)'), 'honest observed-only marker');
  const observedFile = observed.match(/truncated\) to (\S+);/)[1];
  const observedMeta = JSON.parse(fs.readFileSync(observedFile.replace(/\.txt$/, '.meta.json'), 'utf8'));
  assert.strictEqual(observedMeta.content, 'host-truncated');
  assert.strictEqual(observedMeta.hostComplete, false);
  assert.strictEqual(observedMeta.runtime, 'pi');
  fs.rmSync(observedFile, { force: true });
  fs.rmSync(observedFile.replace(/\.txt$/, '.meta.json'), { force: true });

  // re-reading a sidecar never re-sidecars — capped inline instead
  const reread = compress(src, { exitCode: 0, noSidecar: true }).out;
  assert.ok(!reread.includes('saved in full to'), 'no nested sidecar');
  assert.ok(reread.includes('TypeError: cannot read properties'), 'signal survives the inline cap');

  // enumeration never sidecars — its point is nothing elided
  const en = compress(src, { exitCode: 0, enumerate: true }).out;
  assert.ok(!en.includes('saved in full to'), 'enumerate skips sidecar');

  // metadata companion: machine-readable, correct schema and counts
  {
    const metaFile = file.replace(/\.txt$/, '.meta.json');
    assert.ok(fs.existsSync(metaFile), 'meta.json companion written');
    const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    assert.strictEqual(m.schema, 'agent-trim/sidecar-meta/2');
    assert.strictEqual(m.content, 'complete-cleaned');
    assert.strictEqual(m.totalLinesObserved, src.split('\n').length);
    assert.strictEqual(m.bytesObserved, Buffer.byteLength(src));
    assert.strictEqual(m.hostComplete, true);
    assert.ok(/^sha256:[0-9a-f]{64}$/.test(m.contentHash));
    assert.ok(m.census.includes('1 error'), 'census in companion');
    fs.rmSync(metaFile, { force: true });
  }

  // bounded retention: a stale sidecar is swept on the next write
  {
    const stale = path.join(SIDECAR_DIR, 'stale-test.txt');
    fs.writeFileSync(stale, 'old');
    const old = (Date.now() - 80 * 3600 * 1000) / 1000; // 80h > 72h TTL
    fs.utimesSync(stale, old, old);
    compress(src + '\nsweep trigger', { exitCode: 0, sessionId: 'sctest2' });
    assert.ok(!fs.existsSync(stale), 'stale sidecar swept');
    // fresh files survive the sweep
    assert.ok(fs.existsSync(file), 'fresh sidecar kept');
  }

  fs.rmSync(file, { force: true });
  for (const n of fs.readdirSync(SIDECAR_DIR)) if (n.startsWith('sctest2-')) fs.rmSync(path.join(SIDECAR_DIR, n), { force: true });

  // path detection
  assert.ok(isLogPath('logs/app.log') && isLogPath('/var/x/app.log.1') && isLogPath('/srv/log/run.txt'), 'log paths');
  assert.ok(!isLogPath('src/main.rs'), 'source is not a log');
  assert.ok(isGeneratedPath('package-lock.json') && isGeneratedPath('a/node_modules/x/index.js') && isGeneratedPath('app.min.js'), 'generated paths');
  assert.ok(!isGeneratedPath('src/lock.js'), 'source is not generated');
  assert.ok(!isSidecarPath(path.join(SIDECAR_DIR, 'nested', 'x.txt')), 'nested path is not sidecar dir');
}

// v1 sidecar readers normalize into the v2 contract
{
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const file = path.join(os.tmpdir(), `trim-v1-meta-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ schema: 'agent-trim/sidecar-meta/1', content: 'cleaned', totalLines: 4, bytes: 10, census: '1 warning' }));
  const normalized = readSidecarMeta(file);
  assert.strictEqual(normalized.schema, 'agent-trim/sidecar-meta/2');
  assert.strictEqual(normalized.totalLinesObserved, 4);
  assert.strictEqual(normalized.hostComplete, true);
  fs.rmSync(file, { force: true });
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

// T1: protected trailer stays the last line.
// Runs on the DEFAULT path with no env override — a log-shaped (non-JSON) body
// ending in a protected trailer is not a digest, so it compresses normally and
// the trailer is re-emitted after the marker. Only JSON-bodied envelopes are
// passed through by T2 (see condensedEnvelope).
{
  const trailer = 'Full result: .palsync/artifacts/ab12.json';
  const big = 'installed package-' + Array.from({ length: 2000 }, (_, i) => i).join('\ninstalled package-') + `\n${trailer}`;
  const { out } = compress(big);
  const nonEmpty = out.split('\n').filter((l) => l.trim());
  assert.strictEqual(nonEmpty[nonEmpty.length - 1], trailer, 'trailer is last non-empty line');
  const markerIdx = out.indexOf('[trim hook:');
  const trailerIdx = out.lastIndexOf(trailer);
  assert.ok(markerIdx !== -1 && markerIdx < trailerIdx, 'marker present before trailer');
  assert.ok(Buffer.byteLength(out) < Buffer.byteLength(big), 'log-shaped body is still compressed');
}

// no matching trailer -> byte-identical to current (pre-T1) behaviour
{
  const before = compress('x\nx\nx\nx\ny').out;
  assert.strictEqual(before, 'x  [trim hook: line repeated 4x]\ny', 'regression guard: unrelated behaviour unchanged');
}

// trailer present but out === text (nothing changed) -> byte-identical, no duplicate
{
  const clean = 'ok\nFull result: .palsync/artifacts/ab12.json';
  const { out } = compress(clean);
  assert.strictEqual(out, clean, 'unchanged input stays unchanged, no duplicate trailer');
}

// trailer appears twice in input -> output ends with exactly one copy
{
  const trailer = 'Full result: .palsync/artifacts/ab12.json';
  const big =
    trailer +
    '\n' +
    'installed package-' +
    Array.from({ length: 2000 }, (_, i) => i).join('\ninstalled package-') +
    `\n${trailer}`;
  const { out } = compress(big);
  const count = out.split('\n').filter((l) => l.trim() === trailer).length;
  assert.strictEqual(count, 1, 'exactly one trailer copy survives');
  const nonEmpty = out.split('\n').filter((l) => l.trim());
  assert.strictEqual(nonEmpty[nonEmpty.length - 1], trailer, 'the surviving copy is last');
}

// input where the trailer is the only line -> unchanged
{
  const only = 'Full result: .palsync/artifacts/ab12.json';
  assert.strictEqual(compress(only).out, only, 'single-line trailer-only input unchanged');
}

// TRIM_KEEP_LAST_RE: custom pattern honoured alongside the default
{
  delete require.cache[require.resolve('../bin/trim-core.js')];
  process.env.TRIM_KEEP_LAST_RE = '^CUSTOM: .+$';
  const { compress: compress2, protectedTrailer: protectedTrailer2 } = require('../bin/trim-core.js');
  assert.ok(protectedTrailer2('a\nCUSTOM: keep-me'), 'custom pattern recognized');
  assert.ok(protectedTrailer2('a\nFull result: x'), 'default pattern still recognized alongside custom');
  const big = 'installed package-' + Array.from({ length: 2000 }, (_, i) => i).join('\ninstalled package-') + '\nCUSTOM: keep-me';
  const out = compress2(big).out;
  const nonEmpty = out.split('\n').filter((l) => l.trim());
  assert.strictEqual(nonEmpty[nonEmpty.length - 1], 'CUSTOM: keep-me', 'custom trailer kept last');
  delete process.env.TRIM_KEEP_LAST_RE;
  delete require.cache[require.resolve('../bin/trim-core.js')];
}

// TRIM_KEEP_LAST_RE invalid regex -> does not throw; default still protected
{
  delete require.cache[require.resolve('../bin/trim-core.js')];
  process.env.TRIM_KEEP_LAST_RE = '([unclosed';
  const { compress: compress3, protectedTrailer: protectedTrailer3 } = require('../bin/trim-core.js');
  assert.ok(protectedTrailer3('a\nFull result: x'), 'default pattern still protected despite invalid custom regex');
  const trailer = 'Full result: .palsync/artifacts/ab12.json';
  const big = 'installed package-' + Array.from({ length: 2000 }, (_, i) => i).join('\ninstalled package-') + `\n${trailer}`;
  const out = compress3(big).out;
  const nonEmpty = out.split('\n').filter((l) => l.trim());
  assert.strictEqual(nonEmpty[nonEmpty.length - 1], trailer, 'default trailer kept despite invalid TRIM_KEEP_LAST_RE');
  delete process.env.TRIM_KEEP_LAST_RE;
  delete require.cache[require.resolve('../bin/trim-core.js')];
}

// T2: already-condensed passthrough
{
  const fs = require('fs');
  const { SIDECAR_DIR } = require('../bin/trim-core.js');
  const trailer = 'Full result: .palsync/artifacts/ab12.json';
  const envelope = '{"x":1}'.repeat(6000) + `\n${trailer}`; // ~40KB
  assert.ok(Buffer.byteLength(envelope) > 40000, 'fixture is ~40KB');
  const before = fs.existsSync(SIDECAR_DIR) ? new Set(fs.readdirSync(SIDECAR_DIR)) : new Set();
  const { out, meta } = compress(envelope);
  assert.strictEqual(out, envelope, '40KB envelope with Full result trailer passes through byte-identical');
  assert.strictEqual(meta.strategy, 'passthrough-condensed');
  assert.strictEqual(meta.changed, false);
  assert.strictEqual(meta.lossy, false);
  const after = fs.existsSync(SIDECAR_DIR) ? new Set(fs.readdirSync(SIDECAR_DIR)) : new Set();
  assert.strictEqual(after.size, before.size, 'no sidecar file created');

  const foreign = 'plain text\n[palsync digest: 12 grouped]\nmore text';
  assert.strictEqual(compress(foreign).out, foreign, 'foreign marker line triggers passthrough');

  const ours = 'installed package-' + Array.from({ length: 2000 }, (_, i) => i).join('\ninstalled package-') + '\n[trim hook: full 2000-line output saved to /tmp/x.txt — read with offset/limit if needed]';
  assert.ok(!alreadyCondensed(ours), 'our own trim hook marker is not treated as foreign');

  // The env override needs a fixture that (a) passes through by default and
  // (b) is actually compressible once the passthrough is disabled. A log-shaped
  // body fails (a) — it now compresses either way. The single-line `envelope`
  // above fails (b): one 42KB line gives a line-oriented pipeline nothing to
  // remove, which is Appendix A1's whole argument. A pretty-printed JSON body
  // satisfies both.
  const prettyEnvelope =
    JSON.stringify({ findings: Array.from({ length: 300 }, (_, i) => ({ code: `E${i}`, msg: 'x'.repeat(30) })) }, null, 2) +
    `\n${trailer}`;
  assert.strictEqual(compress(prettyEnvelope).out, prettyEnvelope, 'pretty JSON envelope passes through by default');
  process.env.TRIM_CONDENSED_PASSTHROUGH = 'off';
  const resumed = compress(prettyEnvelope).out;
  assert.notStrictEqual(resumed, prettyEnvelope, 'TRIM_CONDENSED_PASSTHROUGH=off resumes normal compression');
  delete process.env.TRIM_CONDENSED_PASSTHROUGH;
}

// T2/A2 guarantee, stated as its own assertion rather than left incidental:
// digest-ness is a property of the BODY, not of the trailer.
{
  const { condensedEnvelope } = require('../bin/trim-core.js');
  const trailer = 'Full result: .palsync/artifacts/ab12.json';
  // JSON body big enough to cap -> passthrough, so the envelope stays parseable
  const jsonBody = JSON.stringify({ diagnostics: Array.from({ length: 400 }, (_, i) => ({ severity: 'error', code: `E${i}`, message: 'x'.repeat(40), occurrences: i })) });
  const jsonEnvelope = `${jsonBody}\n${trailer}`;
  assert.ok(Buffer.byteLength(jsonEnvelope) > 15000, 'past the sidecar threshold');
  const j = compress(jsonEnvelope);
  assert.ok(condensedEnvelope(jsonEnvelope), 'JSON body + trailer is a digest envelope');
  assert.strictEqual(j.out, jsonEnvelope, 'JSON envelope byte-identical: parseability preserved');
  assert.strictEqual(j.meta.strategy, 'passthrough-condensed');

  // pretty-printed JSON body spans many lines and must still pass through
  const pretty = `${JSON.stringify(JSON.parse(jsonBody), null, 2)}\n${trailer}`;
  assert.ok(pretty.split('\n').length > 300, 'pretty body is multi-line');
  assert.strictEqual(compress(pretty).out, pretty, 'pretty-printed envelope also passes through');

  // log-shaped body is NOT a digest, however it ends -> compressed, trailer last
  const logEnvelope = 'installed package-' + Array.from({ length: 2000 }, (_, i) => i).join('\ninstalled package-') + `\n${trailer}`;
  assert.ok(!condensedEnvelope(logEnvelope), 'log body + trailer is not a digest envelope');
  const l = compress(logEnvelope);
  assert.notStrictEqual(l.meta.strategy, 'passthrough-condensed', 'log-shaped body is compressed');

  // a log body carrying someone else's marker is still a digest
  const marked = `plain log line\n[palsync digest: 12 grouped]\nmore log\n${trailer}`;
  assert.ok(alreadyCondensed(marked), 'foreign marker still wins on a non-JSON body');
}

console.log('core.test.js: all assertions passed');
