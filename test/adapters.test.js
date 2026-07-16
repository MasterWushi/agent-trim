'use strict';
// Runtime-adapter contract tests: fail-open on malformed input, correct hook
// protocol on good input, silence when there is nothing to do. Each adapter
// runs as a real subprocess, exactly as the harness would run it.
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const A = (f) => path.join(__dirname, '..', 'adapters', f);
function run(script, stdin, env) {
  return spawnSync(process.execPath, [A(script)], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, TRIM_SIDECAR: 'off', ...env },
    timeout: 10000,
  });
}

const bigOut = Array.from({ length: 900 }, (_, i) => `installed package-${i} ok`).join('\n');

// ---- claude-posttooluse ----
// malformed JSON → fail open: exit 0, no output
{
  const r = run('claude-posttooluse.js', '{not json');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
}
// empty stdin → fail open
{
  const r = run('claude-posttooluse.js', '');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
}
// missing tool_response → silent
{
  const r = run('claude-posttooluse.js', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }));
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
}
// unsupported content (image response) → silent
{
  const evt = { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 42, isImage: true } };
  const r = run('claude-posttooluse.js', JSON.stringify(evt));
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
}
// small clean output → silent (no pointless rewrite)
{
  const evt = { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a\nb\n', stderr: '' } };
  const r = run('claude-posttooluse.js', JSON.stringify(evt));
  assert.strictEqual(r.stdout, '');
}
// large output → updatedToolOutput with compressed stdout, markers present
{
  const evt = { tool_name: 'Bash', tool_input: { command: 'npm install' }, tool_response: { stdout: bigOut, stderr: '' }, session_id: 'adap-test' };
  const r = run('claude-posttooluse.js', JSON.stringify(evt), { TRIM_NOTE: 'off' });
  assert.strictEqual(r.status, 0);
  const rsp = JSON.parse(r.stdout);
  assert.strictEqual(rsp.hookSpecificOutput.hookEventName, 'PostToolUse');
  const u = rsp.hookSpecificOutput.updatedToolOutput;
  assert.ok(typeof u.stdout === 'string' && u.stdout.length < bigOut.length / 2, 'stdout compressed');
  assert.strictEqual(u.stderr, '', 'other fields preserved');
  assert.ok(u.stdout.includes('[trim hook:'), 'marker present');
}
// TRIM_OFF=1 env → silent even on large output
{
  const evt = { tool_name: 'Bash', tool_input: { command: 'npm install' }, tool_response: { stdout: bigOut } };
  const r = run('claude-posttooluse.js', JSON.stringify(evt), { TRIM_OFF: '1' });
  assert.strictEqual(r.stdout, '');
}
// TRIM_OFF=1 command prefix → silent
{
  const evt = { tool_name: 'Bash', tool_input: { command: 'TRIM_OFF=1 npm install' }, tool_response: { stdout: bigOut } };
  const r = run('claude-posttooluse.js', JSON.stringify(evt));
  assert.strictEqual(r.stdout, '');
}
// interrupted:true is treated as failure (generous cap) — more lines survive
{
  const mk = (interrupted) => {
    const evt = { tool_name: 'Bash', tool_input: { command: 'make' }, tool_response: { stdout: bigOut, interrupted } };
    const r = run('claude-posttooluse.js', JSON.stringify(evt), { TRIM_NOTE: 'off' });
    return JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput.stdout.split('\n').length;
  };
  assert.ok(mk(true) > mk(false), 'interrupted output keeps more lines');
}
// Read of source code → untouched (silent)
{
  const evt = {
    tool_name: 'Read',
    tool_input: { file_path: '/repo/src/main.rs' },
    tool_response: { file: { filePath: '/repo/src/main.rs', content: bigOut, numLines: 900 } },
  };
  const r = run('claude-posttooluse.js', JSON.stringify(evt));
  assert.strictEqual(r.stdout, '');
}
// Read of a log path → compressed
{
  const evt = {
    tool_name: 'Read',
    tool_input: { file_path: '/var/logs/app.log' },
    tool_response: { file: { filePath: '/var/logs/app.log', content: bigOut, numLines: 900 } },
  };
  const r = run('claude-posttooluse.js', JSON.stringify(evt), { TRIM_NOTE: 'off' });
  const u = JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput;
  assert.ok(u.file.content.length < bigOut.length / 2, 'log read compressed');
  assert.strictEqual(u.file.numLines, u.file.content.split('\n').length, 'numLines consistent');
}

// ---- codex-posttooluse ----
{
  const r = run('codex-posttooluse.js', '{bad');
  assert.strictEqual(r.status, 0, 'codex fails open on malformed input');
}
{
  const evt = { tool_input: { command: 'npm install' }, tool_response: { stdout: bigOut, exit_code: 0 } };
  const r = run('codex-posttooluse.js', JSON.stringify(evt));
  assert.strictEqual(r.status, 2, 'codex exit 2 on rewrite');
  assert.ok(r.stderr.length < bigOut.length / 2 && r.stderr.includes('[trim hook:'), 'replacement on stderr');
}
{
  const evt = { tool_input: { command: 'ls' }, tool_response: { stdout: 'a\nb\n', exit_code: 0 } };
  const r = run('codex-posttooluse.js', JSON.stringify(evt));
  assert.strictEqual(r.status, 0, 'small output passes');
  assert.strictEqual(r.stderr, '');
}

// ---- hooks that must stay silent ----
// narration meter: no transcript → no output
{
  const r = run('claude-narration-meter.js', JSON.stringify({ hook_event_name: 'PostToolUse', transcript_path: '/nonexistent/x.jsonl' }));
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
}
// narration meter: under-budget turn → silent
{
  const tmp = path.join(os.tmpdir(), `trim-test-transcript-${process.pid}.jsonl`);
  fs.writeFileSync(
    tmp,
    [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'prompt' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'short note' }] } }),
    ].join('\n') + '\n'
  );
  const r = run('claude-narration-meter.js', JSON.stringify({ hook_event_name: 'PostToolUse', transcript_path: tmp, session_id: 'meter-quiet' }));
  assert.strictEqual(r.stdout, '', 'quiet under budget');
  fs.unlinkSync(tmp);
}
// postcompact: malformed stdin → silent, exit 0
{
  const r = run('claude-postcompact.js', 'garbage');
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
}
// subagent brief emits exactly one additionalContext payload
{
  const r = run('claude-subagent-brief.js', '{}');
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.hookSpecificOutput.hookEventName, 'SubagentStart');
  assert.ok(j.hookSpecificOutput.additionalContext.includes('final message'));
}
// subagent brief respects TRIM_SUBAGENT=off
{
  const r = run('claude-subagent-brief.js', '{}', { TRIM_SUBAGENT: 'off' });
  assert.strictEqual(r.stdout, '');
}

console.log('adapters.test.js: all assertions passed');
