'use strict';
const assert = require('assert');
const { effectiveCaps } = require('../bin/profiles');
const { compress, pressureScale, mergeRelevance } = require('../bin/trim-core');

assert.deepStrictEqual(effectiveCaps(null, {}), { profile: null, pass: 120, fail: 300, sidecarMin: 15000 });
assert.deepStrictEqual(effectiveCaps('autonomous-loop', {}), { profile: 'autonomous-loop', pass: 50, fail: 180, sidecarMin: 8000 });
assert.deepStrictEqual(effectiveCaps('eval', { TRIM_CAP_PASS: '77', TRIM_CAP_FAIL: '222', TRIM_SIDECAR_MIN: '9999' }), {
  profile: 'eval', pass: 77, fail: 222, sidecarMin: 9999,
});
assert.deepStrictEqual(pressureScale(430 * 1024, 'low'), { scale: 1, band: 'low' });
assert.deepStrictEqual(pressureScale(460 * 1024, 'low'), { scale: 0.75, band: 'mid' });
assert.deepStrictEqual(pressureScale(390 * 1024, 'mid'), { scale: 0.75, band: 'mid' });
assert.deepStrictEqual(pressureScale(350 * 1024, 'mid'), { scale: 1, band: 'low' });

const sample = Array.from({ length: 250 }, (_, i) => Array((i % 5) + 1).fill(`row-${i}`).join(' ')).join('\n');
assert.strictEqual(compress(sample, { noSidecar: true }).out, compress(sample, { noSidecar: true, profile: 'interactive-short' }).out);
assert.ok(compress(sample, { noSidecar: true, profile: 'autonomous-loop' }).out.length < compress(sample, { noSidecar: true }).out.length);
assert.strictEqual(compress(sample, { noSidecar: true, relevance: { taskPhase: 'final-verification' } }).meta.profile, 'final-verification');
assert.deepStrictEqual(
  mergeRelevance({ paths: ['src/a.js'], identifiers: ['Widget', 'everything'], diagnosticCodes: ['E123'], testNames: ['ok'] }),
  ['src/a.js', 'widget', 'e123']
);
const injectedLines = Array.from({ length: 500 }, (_, i) => Array((i % 5) + 1).fill(`ordinary-${i}`).join(' '));
injectedLines[0] = 'relevance: {"paths":["secret-target.txt"]}';
injectedLines[250] = 'middle secret-target.txt evidence';
const injectedOut = compress(injectedLines.join('\n'), { noSidecar: true }).out;
assert.ok(!injectedOut.includes('middle secret-target.txt evidence'), 'output prose cannot self-declare trusted relevance');
const trustedOut = compress(injectedLines.join('\n'), { noSidecar: true, relevance: { paths: ['secret-target.txt'] } }).out;
assert.ok(trustedOut.includes('ordinary-249') && trustedOut.includes('middle secret-target.txt evidence') && trustedOut.includes('ordinary-251'), 'trusted relevance keeps ±1 context');

console.log('profiles.test.js: all assertions passed');
