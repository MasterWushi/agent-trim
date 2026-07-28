'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { observe, MAX_ENTRIES } = require('../bin/lib/recovery-detect');
const { compress, commandFingerprint } = require('../bin/trim-core.js');
const { readState } = require('../bin/lib/session-state');

const sid = () => 'recovery-test-' + crypto.randomBytes(6).toString('hex');

// same command fingerprint twice within 5 results -> candidate, same-command
{
  const s = sid();
  const cf = commandFingerprint('npm test');
  observe(s, 1, { commandFingerprint: cf, ts: 1000 });
  observe(s, 1, { commandFingerprint: commandFingerprint('git status'), isEditTool: true, ts: 1100 });
  const r = observe(s, 1, { commandFingerprint: cf, ts: 1200 });
  assert.strictEqual(r.candidate, true, 'repeat within window is a candidate');
  assert.strictEqual(r.kind, 'same-command', 'kind is same-command when an edit intervened');
}

// same command 6+ results apart -> not a candidate
{
  const s = sid();
  const cf = commandFingerprint('npm test');
  observe(s, 1, { commandFingerprint: cf, ts: 1000 });
  for (let i = 0; i < 6; i++) observe(s, 1, { commandFingerprint: commandFingerprint('other ' + i), ts: 1100 + i });
  const r = observe(s, 1, { commandFingerprint: cf, ts: 2000 });
  assert.strictEqual(r.candidate, false, 'repeat outside the 5-result window is not a candidate');
}

// same file, same range, unchanged hash -> same-read
{
  const s = sid();
  observe(s, 1, { filePath: '/a/b.js', range: '1-50', contentHash: 'abc', ts: 1000 });
  const r = observe(s, 1, { filePath: '/a/b.js', range: '1-50', contentHash: 'abc', ts: 1100 });
  assert.strictEqual(r.candidate, true, 'identical read is a candidate');
  assert.strictEqual(r.kind, 'same-read', 'kind is same-read');
}

// sidecar read after a lossy digest -> artifact-retrieval
{
  const s = sid();
  observe(s, 1, { commandFingerprint: commandFingerprint('npm run build'), lossy: true, sidecar: true, markerKind: 'sidecar', ts: 1000 });
  const r = observe(s, 1, { isSidecarRead: true, filePath: '/tmp/trim-sidecar/x.txt', ts: 1100 });
  assert.strictEqual(r.candidate, true, 'sidecar read after lossy digest is a candidate');
  assert.strictEqual(r.kind, 'artifact-retrieval', 'kind is artifact-retrieval');
}

// rerun with TRIM_OFF=1 -> trim-bypass-rerun
{
  const s = sid();
  const cf = commandFingerprint('npm test');
  observe(s, 1, { commandFingerprint: cf, ts: 1000 });
  const r = observe(s, 1, { commandFingerprint: cf, bypass: true, ts: 1100 });
  assert.strictEqual(r.candidate, true, 'bypass rerun is a candidate');
  assert.strictEqual(r.kind, 'trim-bypass-rerun', 'kind is trim-bypass-rerun');
}

// precedingMarkerKind: null when prior result untouched, set when trimmed
{
  const s = sid();
  const cf = commandFingerprint('npm test');
  observe(s, 1, { commandFingerprint: cf, ts: 1000 }); // untouched (no markerKind)
  const r1 = observe(s, 1, { commandFingerprint: cf, ts: 1100 });
  assert.strictEqual(r1.precedingMarkerKind, null, 'preceding untouched result has null markerKind');

  const s2 = sid();
  observe(s2, 1, { commandFingerprint: cf, markerKind: 'sidecar', lossy: true, ts: 1000 });
  const r2 = observe(s2, 1, { commandFingerprint: cf, ts: 1100 });
  assert.strictEqual(r2.precedingMarkerKind, 'sidecar', 'preceding trimmed result has its markerKind set');
}

// ring buffer never exceeds 32 entries under 10,000 pushes
{
  const s = sid();
  for (let i = 0; i < 10000; i++) observe(s, 1, { commandFingerprint: commandFingerprint('cmd ' + i), ts: i });
  const state = readState('trim-recovery', s);
  assert.ok(state.ring.length <= MAX_ENTRIES, 'ring buffer bounded at MAX_ENTRIES');
}

// state resets on epoch increment
{
  const s = sid();
  const cf = commandFingerprint('npm test');
  observe(s, 1, { commandFingerprint: cf, ts: 1000 });
  const r = observe(s, 2, { commandFingerprint: cf, ts: 1100 }); // epoch bump = compaction
  assert.strictEqual(r.candidate, false, 'epoch increment resets ring state');
}

// for every fixture: compress() output is byte-identical whether or not
// recovery detection runs alongside it (T7 must never touch model-visible
// output — recovery-detect is a wholly separate call, not a compress() path)
{
  const fixturesDir = path.join(__dirname, 'fixtures');
  const files = fs.readdirSync(fixturesDir).filter((f) => /\.(txt|json|log)$/.test(f));
  assert.ok(files.length > 0, 'fixtures directory is non-empty');
  for (const f of files) {
    const text = fs.readFileSync(path.join(fixturesDir, f), 'utf8');
    const withoutRecovery = compress(text, { noSidecar: true }).out;
    // call recovery-detect alongside compress(), as a caller would
    const s = sid();
    observe(s, 1, { commandFingerprint: commandFingerprint(f), contentHash: crypto.createHash('sha256').update(text).digest('hex'), ts: 1 });
    const withRecovery = compress(text, { noSidecar: true }).out;
    assert.strictEqual(withRecovery, withoutRecovery, `${f}: compress() output unaffected by recovery detection`);
  }
}

// metrics privacy: no raw command, file path, or output content in stored state
{
  const s = sid();
  observe(s, 1, {
    commandFingerprint: commandFingerprint('npm test --grep "secret token ABC123"'),
    filePath: '/Users/me/secret-project/config.js',
    contentHash: crypto.createHash('sha256').update('super secret file contents').digest('hex'),
    ts: 1000,
  });
  const state = readState('trim-recovery', s);
  const dump = JSON.stringify(state);
  assert.ok(!dump.includes('secret'), 'no raw command/path/content text in stored recovery state');
  assert.ok(!dump.includes('/Users/me/secret-project'), 'raw file path never stored');
  assert.ok(!dump.includes('npm test --grep'), 'raw command text never stored');
}

console.log('recovery-detect.test.js: all assertions passed');
