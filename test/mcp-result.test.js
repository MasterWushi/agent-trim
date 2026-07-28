'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { processMcpResult } = require('../adapters/lib/mcp-result');

const fixturesDir = path.join(__dirname, 'fixtures', 'mcp');
const fixtureFiles = fs.readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));
assert.ok(fixtureFiles.length >= 11, 'at least 11 mcp fixtures present');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8'));
}

// every fixture, TRIM_MCP=observe -> returned result deep-equals input
for (const f of fixtureFiles) {
  const input = loadFixture(f);
  const { out } = processMcpResult(input, { toolName: 'mcp__test__thing', mode: 'observe' });
  assert.deepStrictEqual(out, input, `${f}: observe mode returns input unchanged (deep-equal)`);
}

// non-text blocks deep-equal the input in all modes
for (const mode of ['observe', 'on']) {
  const input = loadFixture('text-plus-image.json');
  const { out } = processMcpResult(input, {
    toolName: 'mcp__test__thing',
    mode,
    allowRe: /^mcp__test__/,
  });
  assert.deepStrictEqual(out.content[1], input.content[1], `image block untouched in ${mode} mode`);
}

// isError: true is never cleared
{
  const input = loadFixture('text-only-error.json');
  const { out } = processMcpResult(input, { toolName: 'mcp__test__thing', mode: 'on', allowRe: /.*/ });
  assert.strictEqual(out.isError, true, 'isError stays true even when applied');
}

// unknown block type -> whole result passes through
{
  const input = loadFixture('unknown-block-type.json');
  const { out, applied } = processMcpResult(input, { toolName: 'mcp__test__thing', mode: 'on', allowRe: /.*/ });
  assert.deepStrictEqual(out.content[1], input.content[1], 'unknown block type preserved exactly');
  // the text block may still be eligible for transform; only the unknown
  // block itself is guaranteed untouched — assert no error thrown
  assert.ok(typeof applied === 'boolean');
}

// PalSync-shaped fixture -> passthrough even with TRIM_MCP=on and a matching allowlist (T2 wins)
{
  const input = loadFixture('palsync-envelope.json');
  const { out, applied } = processMcpResult(input, {
    toolName: 'mcp__palsync__validate',
    mode: 'on',
    allowRe: /^mcp__palsync__/,
  });
  assert.strictEqual(applied, false, 'PalSync envelope never transformed even when allowlisted');
  assert.deepStrictEqual(out, input, 'PalSync envelope passes through byte/structure-identical');
}

// TRIM_MCP=on with no TRIM_MCP_ALLOW_RE -> no transform
{
  const input = loadFixture('text-only-success.json');
  const { out, applied } = processMcpResult(input, { toolName: 'mcp__test__thing', mode: 'on', allowRe: undefined });
  assert.strictEqual(applied, false, 'on mode with no allowlist never applies');
  assert.deepStrictEqual(out, input, 'result unchanged when on mode has no allowlist');
}

// malformed/truncated JSON result -> no throw, passthrough
{
  const malformed = '{"content": [{"type": "text", "text": "unterminated';
  let threw = false;
  let result;
  try {
    result = processMcpResult(malformed, { toolName: 'mcp__test__thing', mode: 'observe' });
  } catch {
    threw = true;
  }
  assert.strictEqual(threw, false, 'malformed input does not throw');
  assert.strictEqual(result.out, malformed, 'malformed input passes through unchanged');
  assert.strictEqual(result.applied, false);
}

// structuredContent + isError + _meta + annotations preserved exactly in 'on' mode
{
  const input = {
    content: [{ type: 'text', text: 'x'.repeat(500) + '\n'.repeat(3) + 'y'.repeat(500) }],
    structuredContent: { a: 1 },
    _meta: { custom: true },
    annotations: { audience: ['user'] },
    isError: false,
  };
  const { out } = processMcpResult(input, { toolName: 'mcp__test__thing', mode: 'on', allowRe: /.*/ });
  assert.deepStrictEqual(out.structuredContent, input.structuredContent, 'structuredContent preserved');
  assert.deepStrictEqual(out._meta, input._meta, '_meta preserved');
  assert.deepStrictEqual(out.annotations, input.annotations, 'annotations preserved');
}

// block order preserved, never flattened
{
  const input = loadFixture('multiple-text-blocks.json');
  const { out } = processMcpResult(input, { toolName: 'mcp__test__thing', mode: 'on', allowRe: /.*/ });
  assert.strictEqual(out.content.length, input.content.length, 'block count/order preserved, not flattened');
}

console.log('mcp-result.test.js: all assertions passed');
