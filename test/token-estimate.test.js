'use strict';
const assert = require('assert');
const { estimate, classify } = require('../bin/lib/token-estimate');
const { netWin } = require('../bin/trim-core.js');

// classification
assert.strictEqual(classify('{"a":1,"b":[1,2,3],"c":{"d":4,"e":5}}'.repeat(20)), 'dense', 'minified JSON classifies dense');
assert.strictEqual(
  classify(
    'The quick brown fox jumps over the lazy dog and continues running through the meadow under a clear blue sky. '.repeat(
      20
    )
  ),
  'prose',
  'English paragraph classifies prose'
);
assert.strictEqual(
  classify(
    'function add(a, b) {\n  return a + b;\n}\nfunction sub(a, b) {\n  return a - b;\n}\n'.repeat(20)
  ),
  'code',
  'source-like text classifies code'
);

// CJK
{
  const cjk = '日本語のテキストです。'.repeat(50);
  const cls = classify(cjk);
  assert.strictEqual(cls, 'cjk', 'CJK-heavy text classifies cjk');
  const { tokens } = estimate(cjk);
  assert.ok(tokens >= [...cjk].length, 'CJK estimate is >= codepoint count');
}

// netWin: byte win but worse token estimate -> rejected
{
  const inText = 'a '.repeat(100); // spacious prose-ish, cheap per-token
  const outText = '{'.repeat(60); // fewer bytes, denser tokenization
  assert.ok(Buffer.byteLength(inText) - Buffer.byteLength(outText) >= 32, 'fixture is smaller by >=32 bytes');
  const win = netWin(inText, outText);
  assert.strictEqual(win, false, 'byte-smaller-but-token-worse candidate rejected');
}

// netWin: undefined/null outText
assert.strictEqual(netWin('abc', undefined), false, 'undefined outText rejected');
assert.strictEqual(netWin('abc', null), false, 'null outText rejected');

// netWin: fails closed if token-estimate is unresolvable
{
  const Module = require('module');
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === './lib/token-estimate') throw new Error('boom');
    return orig.apply(this, arguments);
  };
  delete require.cache[require.resolve('../bin/trim-core.js')];
  const { netWin: netWin2 } = require('../bin/trim-core.js');
  let threw = false;
  let result;
  try {
    result = netWin2('a'.repeat(1000), 'b'.repeat(10));
  } catch {
    threw = true;
  }
  Module.prototype.require = orig;
  delete require.cache[require.resolve('../bin/trim-core.js')];
  assert.strictEqual(threw, false, 'netWin does not throw when token-estimate is unresolvable');
  assert.strictEqual(result, false, 'netWin returns false when token-estimate is unresolvable');
}

// all four adapter sites route through netWin()
{
  const { execSync } = require('child_process');
  const hits = execSync("grep -rn '\\- 32' adapters/ || true", { cwd: __dirname + '/..', encoding: 'utf8' });
  assert.strictEqual(hits.trim(), '', 'no remaining `- 32` comparison sites in adapters/');
}

// deterministic: same input -> same output across 100 calls
{
  const sample = 'mixed content 123 {"a":1} and some prose here.\n'.repeat(30);
  const first = estimate(sample).tokens;
  for (let i = 0; i < 100; i++) {
    assert.strictEqual(estimate(sample).tokens, first, 'estimator deterministic across repeated calls');
  }
}

// empty string, single char, 10MB string -> no throw
{
  assert.doesNotThrow(() => estimate(''));
  assert.doesNotThrow(() => estimate('a'));
  assert.doesNotThrow(() => estimate('x'.repeat(10 * 1024 * 1024)));
  assert.strictEqual(estimate('').tokens, 0, 'empty string estimates 0 tokens');
}

// emoji/surrogate-pair input -> no negative or zero savings misreport
{
  const emoji = '🔥🚀✨'.repeat(200);
  const { tokens } = estimate(emoji);
  assert.ok(tokens > 0, 'emoji input estimates positive tokens');
  const win = netWin(emoji + emoji, emoji);
  assert.ok(typeof win === 'boolean', 'netWin on emoji input returns a boolean, not a throw/NaN');
}

console.log('token-estimate.test.js: all assertions passed');
