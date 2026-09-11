'use strict';
// opencode behaviour contract. This file exists because adapters/opencode-trim.ts
// was reduced to a wiring shim and every decision moved into
// adapters/lib/opencode-runtime.js — which the suite would otherwise not cover
// at all. install.test.js only asserts the rendered plugin file EXISTS; it says
// nothing about what the plugin does.
//
// The critical invariant: a throw from tool.execute.after is FAIL-CLOSED in
// opencode (the tool call itself errors), so the handler must swallow
// everything.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { afterToolExecute, Trim } = require('../adapters/lib/opencode-runtime.js');

const big = Array.from({ length: 900 }, (_, i) => `installed package-${i} ok`).join('\n');

(async () => {
  // --- plugin shape opencode expects ---
  {
    const plugin = await Trim();
    assert.strictEqual(typeof plugin['tool.execute.after'], 'function', 'exports the tool.execute.after hook');
  }

  // --- string output: compressed in place ---
  {
    const output = { output: big };
    await afterToolExecute({ args: { command: 'npm install' } }, output);
    assert.ok(output.output.length < big.length, 'string output compressed');
    assert.ok(/\[trim hook:/.test(output.output), 'omission marker present');
    assert.ok(output.output.includes('installed package-0'), 'head kept');
    assert.ok(output.output.includes('installed package-899'), 'tail kept');
  }

  // --- small output: left alone (netWin gate, not just a byte compare) ---
  {
    const output = { output: 'ok\n' };
    await afterToolExecute({ args: {} }, output);
    assert.strictEqual(output.output, 'ok\n', 'nothing to gain -> untouched');
  }

  // --- MCP content array: text compressed, everything else byte-identical ---
  {
    const image = { type: 'image', data: 'zzz', mimeType: 'image/png' };
    const empty = { type: 'text', text: '' };
    const output = { content: [{ type: 'text', text: big }, image, empty] };
    await afterToolExecute({ args: {} }, output);
    assert.ok(output.content[0].text.length < big.length, 'text block compressed');
    assert.deepStrictEqual(output.content[1], image, 'image block untouched');
    assert.deepStrictEqual(output.content[2], empty, 'empty text block untouched');
    assert.strictEqual(output.content.length, 3, 'block count and order preserved');
  }

  // --- TRIM_OFF=1 inside the command args bypasses ---
  {
    const output = { output: big };
    await afterToolExecute({ args: { command: 'TRIM_OFF=1 npm install' } }, output);
    assert.strictEqual(output.output, big, 'per-command bypass honoured');
  }

  // --- TRIM_OFF=1 in the environment bypasses ---
  {
    const prior = process.env.TRIM_OFF;
    process.env.TRIM_OFF = '1';
    const output = { output: big };
    await afterToolExecute({ args: {} }, output);
    assert.strictEqual(output.output, big, 'env bypass honoured');
    if (prior === undefined) delete process.env.TRIM_OFF;
    else process.env.TRIM_OFF = prior;
  }

  // --- fail-closed guard: no input shape may throw ---
  {
    const shapes = [
      [null, {}],
      [undefined, {}],
      [{}, { output: 42 }],
      [{ args: null }, { output: big }],
      [{ args: { command: 5 } }, { content: 'not-an-array' }],
      [{ args: {} }, { content: [null, 'str', { type: 'text' }] }],
      [{ args: {} }, {}],
    ];
    for (const [input, output] of shapes) {
      await afterToolExecute(input, output); // must not reject
    }
    assert.ok(true, 'no input shape throws out of the handler');
  }

  // --- metrics record exactly the bytes returned ---
  {
    const metrics = path.join(require('os').tmpdir(), `trim-opencode-metrics-${process.pid}.jsonl`);
    process.env.TRIM_METRICS = metrics;
    const output = { output: big };
    await afterToolExecute({ args: { command: 'npm install' } }, output);
    let rec = JSON.parse(fs.readFileSync(metrics, 'utf8').trim().split('\n').pop());
    assert.strictEqual(rec.inBytes, Buffer.byteLength(big));
    assert.strictEqual(rec.outBytes, Buffer.byteLength(output.output), 'string metrics match the bytes returned');

    const blockA = Array.from({ length: 700 }, (_, i) => `row ${i} ok`).join('\n');
    const blockB = `${'x'.repeat(100)}\x1b[31mred\x1b[0m`;
    const mcp = { content: [{ type: 'text', text: blockA }, { type: 'text', text: blockB }] };
    await afterToolExecute({ args: {} }, mcp);
    const returned = Buffer.byteLength(mcp.content[0].text) + Buffer.byteLength(mcp.content[1].text);
    rec = JSON.parse(fs.readFileSync(metrics, 'utf8').trim().split('\n').pop());
    assert.strictEqual(rec.tag, 'opencode-mcp');
    assert.strictEqual(rec.inBytes, Buffer.byteLength(blockA) + Buffer.byteLength(blockB));
    assert.strictEqual(rec.outBytes, returned, 'multi-block metrics match the bytes returned');
    delete process.env.TRIM_METRICS;
    fs.rmSync(metrics, { force: true });
  }

  console.log('opencode-runtime.test.js: all assertions passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
