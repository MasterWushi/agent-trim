'use strict';
// Tests for Claude-Code-only transcript boundaries and hook text.
const assert = require('assert');
const { isRealUserPrompt } = require('../adapters/lib/transcript.js');
const { BRIEF } = require('../adapters/claude-subagent-brief.js');
const { PRESERVATION_INSTRUCTIONS } = require('../adapters/claude-precompact.js');

assert.ok(PRESERVATION_INSTRUCTIONS.includes('unresolved failures') && PRESERVATION_INSTRUCTIONS.includes('[trim hook:'));

const humanPrompt = { type: 'user', message: { content: 'hello' } };
const toolResult = { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } };
const metaEntry = { type: 'user', isMeta: true, message: { content: 'wakeup' } };
const notification = { type: 'user', origin: { kind: 'task-notification' }, message: { content: 'done' } };
assert.ok(isRealUserPrompt(humanPrompt), 'plain human prompt');
assert.ok(!isRealUserPrompt(toolResult), 'tool result is not a prompt');
assert.ok(!isRealUserPrompt(metaEntry), 'meta entry is not a prompt');
assert.ok(!isRealUserPrompt(notification), 'notification is not a prompt');
assert.ok(BRIEF.includes('tool result'), 'brief text present');

console.log('claude-hooks.test.js: all assertions passed');
