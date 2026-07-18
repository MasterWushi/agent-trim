'use strict';
const assert = require('assert');
const { LIMIT, hashText, detectDuplicate, clearDuplicates } = require('../bin/lib/dup-detect');

const id = `dup-test-${process.pid}`;
clearDuplicates(id);
assert.strictEqual(detectDuplicate(id, '\x1b[31mhello  world\x1b[0m', 100).duplicate, false);
const second = detectDuplicate(id, 'hello world', 150);
assert.strictEqual(second.duplicate, true);
assert.strictEqual(second.ageMs, 50);
for (let i = 0; i < LIMIT + 5; i++) detectDuplicate(id, `value ${i}`, 200 + i);
assert.strictEqual(detectDuplicate(id, 'hello world', 500).duplicate, false, 'old entry evicted');
assert.strictEqual(hashText('2026-01-01T01:02:03Z ok'), hashText('2027-02-02T04:05:06Z ok'));
console.log('dup-detect.test.js: all assertions passed');
