'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const runtime = require('../adapters/lib/pi-runtime');

process.env.TRIM_SIDECAR = 'off';
const raw = Array.from({ length: 500 }, (_, i) => `installed package ${i} ok`).join('\n');
const event = {
  toolName: 'bash', toolCallId: 'one', input: { command: 'npm install' },
  content: [{ type: 'text', text: raw }], details: { exitCode: 0, token: 'keep' }, isError: false,
};
const sid = `pi-test-${process.pid}`;
const first = runtime.handleToolResult(event, {}, { sessionId: sid, TRIM_OFF: '0' });
assert.ok(first.patch && first.patch.content[0].text.length < raw.length);
assert.deepStrictEqual(first.patch.details, event.details);
assert.strictEqual(first.patch.isError, false);
const repeat = runtime.handleToolResult(event, first.stateDelta, { sessionId: sid, TRIM_OFF: '0' });
assert.strictEqual(repeat.patch, null);
assert.strictEqual(repeat.metrics.repeated, true);
assert.doesNotThrow(() => runtime.handleToolResult({ ...event, content: [{ type: 'text', text: raw + '\nmore' }] }, first.stateDelta, { sessionId: sid, TRIM_OFF: '0' }));
const parallel = runtime.handleToolResult({ ...event, toolCallId: 'two' }, first.stateDelta, { sessionId: sid, TRIM_OFF: '0' });
assert.ok(Object.hasOwn(parallel.stateDelta.handled, 'one') && Object.hasOwn(parallel.stateDelta.handled, 'two'));

const failed = runtime.handleToolResult({ ...event, toolCallId: 'err', isError: true, details: { code: 1 } }, {}, { sessionId: sid, TRIM_OFF: '0' });
assert.strictEqual(failed.patch.isError, true);
assert.deepStrictEqual(failed.patch.details, { code: 1 });
assert.strictEqual(runtime.hostComplete({ details: {} }, 'x'.repeat(50 * 1024 - 1)), true);
assert.strictEqual(runtime.hostComplete({ details: {} }, 'x'.repeat(50 * 1024)), false);
assert.strictEqual(runtime.hostComplete({ details: { truncated: true } }, 'small'), false);
assert.strictEqual(runtime.hostComplete({ details: { truncation: { truncated: true } } }, 'small'), false);
assert.strictEqual(runtime.hostComplete({ details: {} }, '🙂'.repeat(13000)), false);

const readSource = runtime.handleToolResult({ toolName: 'read', toolCallId: 'read', input: { path: 'src/a.js' }, content: [{ type: 'text', text: raw }], details: {}, isError: false }, {}, { TRIM_OFF: '0' });
assert.strictEqual(readSource.patch, null);
assert.strictEqual(runtime.handleToolResult(event, {}, { TRIM_OFF: '1' }).metrics.bypass, true);
const stateFile = runtime.statePath(`corrupt-${process.pid}`);
fs.mkdirSync(path.dirname(stateFile), { recursive: true });
fs.writeFileSync(stateFile, '{bad');
assert.deepStrictEqual(runtime.readState(`corrupt-${process.pid}`).handled, {});

const reset = runtime.resetForCompaction({ compactionEpoch: 2, observedBytes: 99, narration: { words: 5 } });
assert.strictEqual(reset.compactionEpoch, 3);
assert.strictEqual(reset.observedBytes, 0);
let narration = runtime.stepNarration({}, 'word '.repeat(71), 'eval', 't1');
assert.strictEqual(narration.exceeded, true);
narration = runtime.stepNarration(narration.state, 'word '.repeat(10), 'eval', 't1');
assert.strictEqual(narration.exceeded, false);
assert.strictEqual(runtime.stepNarration({}, 'fatal error blocked', 'eval', 't1').exceeded, false);

// The extension keys narration from persisted tool-result state, not message timestamps.
const turn = runtime.handleToolResult({ ...event, toolCallId: 'turn-boundary' }, {}, { sessionId: sid, TRIM_OFF: '0' }).stateDelta;
assert.strictEqual(turn.turnCounter, 1);
let accumulated = runtime.stepNarration(turn, 'word '.repeat(40), 'eval', turn.turnCounter);
assert.strictEqual(accumulated.exceeded, false);
accumulated = runtime.stepNarration(accumulated.state, 'word '.repeat(40), 'eval', accumulated.state.turnCounter);
assert.strictEqual(accumulated.exceeded, true, 'two messages in one persisted turn accumulate');

// Attempted compression below the adapter's 32-byte patch gate logs unchanged metrics.
{
  const metrics = path.join(require('os').tmpdir(), `trim-pi-metrics-${process.pid}.jsonl`);
  process.env.TRIM_METRICS = metrics;
  const smallRaw = `${'x'.repeat(100)}\x1b[31mred\x1b[0m`;
  const small = runtime.handleToolResult(
    { ...event, toolCallId: 'small', content: [{ type: 'text', text: smallRaw }] },
    {},
    { sessionId: sid, TRIM_OFF: '0' }
  );
  assert.strictEqual(small.patch, null);
  runtime.logMetrics(small.metrics);
  delete process.env.TRIM_METRICS;
  const record = JSON.parse(fs.readFileSync(metrics, 'utf8').trim());
  assert.strictEqual(record.changed, false);
  assert.strictEqual(record.outBytes, record.inBytes);
  fs.rmSync(metrics, { force: true });
}

delete process.env.TRIM_SIDECAR;
console.log('pi-runtime.test.js: all assertions passed');
