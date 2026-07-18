'use strict';
// Tests for the Claude-Code-only hooks: narration meter logic, transcript
// turn-boundary rules, subagent brief shape.
const assert = require('assert');
const { stepMeter, measureCurrentTurn, wordCount } = require('../adapters/claude-narration-meter.js');
const { isRealUserPrompt } = require('../adapters/lib/transcript.js');
const { BRIEF } = require('../adapters/claude-subagent-brief.js');
const { PRESERVATION_INSTRUCTIONS } = require('../adapters/claude-precompact.js');

assert.ok(PRESERVATION_INSTRUCTIONS.includes('unresolved failures') && PRESERVATION_INSTRUCTIONS.includes('[trim hook:'));

// --- stepMeter: pure firing decision ---
// under budget: never fires
assert.deepStrictEqual(stepMeter(undefined, 't1', 100, 120), { fire: false });
// crossing the budget on a fresh turn fires
{
  const r = stepMeter(undefined, 't1', 150, 120);
  assert.ok(r.fire && r.nextState.firedAt === 150, 'fires over budget');
}
// same turn, no growth: silent
assert.deepStrictEqual(stepMeter({ turnKey: 't1', firedAt: 150 }, 't1', 155, 120), { fire: false });
// same turn, quarter-budget fresh growth: re-arms
assert.ok(stepMeter({ turnKey: 't1', firedAt: 150 }, 't1', 180, 120).fire, 're-arms on growth');
// new turn resets
assert.deepStrictEqual(stepMeter({ turnKey: 't1', firedAt: 150 }, 't2', 100, 120), { fire: false });

// --- transcript turn boundaries ---
const humanPrompt = { type: 'user', message: { content: 'hello' } };
const toolResult = { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } };
const metaEntry = { type: 'user', isMeta: true, message: { content: 'wakeup' } };
const notification = { type: 'user', origin: { kind: 'task-notification' }, message: { content: 'done' } };
assert.ok(isRealUserPrompt(humanPrompt), 'plain human prompt');
assert.ok(!isRealUserPrompt(toolResult), 'tool result is not a prompt');
assert.ok(!isRealUserPrompt(metaEntry), 'meta entry is not a prompt');
assert.ok(!isRealUserPrompt(notification), 'notification is not a prompt');

// --- measureCurrentTurn: counts assistant text since last human prompt ---
{
  const lines = [
    JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'old prompt' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'old old old narration' }] } }),
    JSON.stringify({ type: 'user', uuid: 'u2', message: { content: 'new prompt' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'three words here' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'two more' }] } }),
  ];
  const m = measureCurrentTurn(lines);
  assert.strictEqual(m.narration, 5, 'counts only current-turn words');
  assert.strictEqual(m.blocks, 2, 'counts blocks');
  assert.strictEqual(m.turnKey, 'u2', 'keys on the boundary prompt');
}
// sidechain (subagent) assistant text never counts
{
  const lines = [
    JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'prompt' } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'a b c d e' }] } }),
  ];
  assert.strictEqual(measureCurrentTurn(lines).narration, 0, 'sidechain excluded');
}

assert.strictEqual(wordCount('  a  b\nc '), 3);
assert.ok(BRIEF.includes('tool result'), 'brief text present');

console.log('claude-hooks.test.js: all assertions passed');
