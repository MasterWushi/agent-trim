'use strict';
const assert = require('assert');
const { compress } = require('../bin/trim-core.js');

// ANSI strip
assert.strictEqual(compress('\x1b[31mred\x1b[0m ok').out, 'red ok');
// OSC sequence
assert.strictEqual(compress('\x1b]0;title\x07hello').out, 'hello');
// CR progress: keep last repaint
assert.strictEqual(compress('10%\r50%\r100% done').out, '100% done');
// trailing whitespace + blank collapse
assert.strictEqual(compress('a   \n\n\n\n\nb').out, 'a\n\nb');
// consecutive dedup >=3
assert.strictEqual(compress('x\nx\nx\nx\ny').out, 'x  [trim: line repeated 4x]\ny');
// dedup of 2 left alone
assert.strictEqual(compress('x\nx\ny').out, 'x\nx\ny');
// elision keeps error lines and marker, respects caps
{
  const lines = [];
  for (let i = 0; i < 1000; i++) lines.push(`line ${i}`);
  lines[500] = 'ERROR: disk on fire 500';
  const out = compress(lines.join('\n')).out;
  assert.ok(out.includes('[trim:'), 'marker present');
  assert.ok(out.includes('ERROR: disk on fire 500'), 'error line kept');
  assert.ok(out.includes('line 0') && out.includes('line 999'), 'head+tail kept');
  assert.ok(out.split('\n').length < 260, 'output capped');
}
// idempotent-ish: compressing compressed output does not grow
{
  const once = compress('a\n\n\n\nb  \n').out;
  assert.strictEqual(compress(once).out, once);
}
// empty input
assert.strictEqual(compress('').out, '');

console.log('core.test.js: all assertions passed');
