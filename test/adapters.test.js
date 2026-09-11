'use strict';
// Runtime-adapter contract tests: fail-open on malformed input, correct hook
// protocol on good input, silence when there is nothing to do. Each adapter
// runs as a real subprocess, exactly as the harness would run it.
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readState, writeState, statePath } = require('../bin/lib/session-state');

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
// Claude parity telemetry: runtime/profile, duration, and host completeness
{
  const metrics = path.join(os.tmpdir(), `trim-claude-metrics-${process.pid}.jsonl`);
  const huge = Array.from({ length: 1800 }, (_, i) => `unique output row ${i} ${'x'.repeat(i % 11)}`).join('\n');
  const evt = { tool_name: 'Bash', tool_input: { command: 'build' }, tool_response: { stdout: huge }, session_id: 'claude-parity' };
  run('claude-posttooluse.js', JSON.stringify(evt), {
    TRIM_NOTE: 'off', TRIM_METRICS: metrics, TRIM_PROFILE: 'eval', TRIM_SIDECAR_SHELL_MAX: String(Buffer.byteLength(huge) + 1),
  });
  const rec = JSON.parse(fs.readFileSync(metrics, 'utf8').trim());
  assert.strictEqual(rec.runtime, 'claude');
  assert.strictEqual(rec.profile, 'eval');
  assert.strictEqual(rec.hostTruncated, false);
  assert.ok(typeof rec.durMs === 'number');
  fs.rmSync(metrics, { force: true });
}
// T8 observe mode records the counterfactual WITHOUT inflating reported savings
{
  const metrics = path.join(os.tmpdir(), `trim-mcp-metrics-${process.pid}.jsonl`);
  const huge = Array.from({ length: 1200 }, (_, i) => `mcp row ${i} ${'y'.repeat(i % 7)}`).join('\n');
  const evt = {
    tool_name: 'mcp__demo__query',
    tool_input: {},
    tool_response: { content: [{ type: 'text', text: huge }] },
    session_id: 'mcp-observe',
  };
  const r = run('claude-posttooluse.js', JSON.stringify(evt), { TRIM_NOTE: 'off', TRIM_METRICS: metrics });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '', 'observe mode returns no replacement');
  const rec = JSON.parse(fs.readFileSync(metrics, 'utf8').trim());
  assert.strictEqual(rec.tag, 'claude-mcp');
  assert.strictEqual(rec.applied, false, 'observe mode never applies');
  assert.strictEqual(rec.mcp.mode, 'observe');
  assert.ok(rec.mcp.blocks >= 1, 'at least one text block observed');
  assert.ok(rec.mcp.wouldOutBytes < rec.mcp.wouldInBytes, 'counterfactual saving recorded');
  // The counterfactual must not reach the headline totals: a never-applied
  // trim reported as savings is exactly the misreporting T6 exists to stop.
  const stats = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'trim-stats.js'), metrics, '--json'], {
    encoding: 'utf8', env: { ...process.env }, timeout: 10000,
  });
  const summary = JSON.parse(stats.stdout);
  assert.strictEqual(summary.bytesSaved.value, 0, 'observe-mode bytes excluded from reported savings');
  assert.strictEqual(summary.inputBytes.value, 0, 'observe-mode bytes excluded from input totals');
  fs.rmSync(metrics, { force: true });
}
// TRIM_MCP=off → no metrics record at all
{
  const metrics = path.join(os.tmpdir(), `trim-mcp-off-${process.pid}.jsonl`);
  const evt = {
    tool_name: 'mcp__demo__query',
    tool_input: {},
    tool_response: { content: [{ type: 'text', text: bigOut }] },
    session_id: 'mcp-off',
  };
  const r = run('claude-posttooluse.js', JSON.stringify(evt), { TRIM_METRICS: metrics, TRIM_MCP: 'off' });
  assert.strictEqual(r.stdout, '');
  assert.ok(!fs.existsSync(metrics), 'TRIM_MCP=off writes nothing');
  fs.rmSync(metrics, { force: true });
}
// Claude final gate: recorded bytes are the bytes of the emitted result, not
// of the dominant field's attempt
{
  const metrics = path.join(os.tmpdir(), `trim-claude-netwin-${process.pid}.jsonl`);
  const stdout = Array.from({ length: 900 }, (_, i) => `installed package-${i} ok`).join('\n');
  const stderr = Array.from({ length: 120 }, (_, i) => `warn: package-${i} peer mismatch`).join('\n');
  const evt = {
    tool_name: 'Bash',
    tool_input: { command: 'npm install' },
    tool_response: { stdout, stderr },
    session_id: 'claude-netwin',
  };
  const r = run('claude-posttooluse.js', JSON.stringify(evt), { TRIM_NOTE: 'off', TRIM_METRICS: metrics });
  assert.strictEqual(r.status, 0);
  const u = JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput;
  const rec = JSON.parse(fs.readFileSync(metrics, 'utf8').trim());
  assert.strictEqual(rec.inBytes, Buffer.byteLength(stdout) + Buffer.byteLength(stderr));
  assert.strictEqual(
    rec.outBytes,
    Buffer.byteLength(u.stdout) + Buffer.byteLength(u.stderr),
    'recorded output bytes equal the bytes returned'
  );
  assert.strictEqual(rec.changed, true);
  fs.rmSync(metrics, { force: true });
}
// Multi-block MCP: one aggregate gate, and metrics that match the result
{
  const metrics = path.join(os.tmpdir(), `trim-mcp-applied-${process.pid}.jsonl`);
  const blockA = Array.from({ length: 800 }, (_, i) => `mcp row ${i} ${'y'.repeat(i % 7)}`).join('\n');
  const blockB = Array.from({ length: 400 }, (_, i) => `mcp row ${i} ${'z'.repeat(i % 5)}`).join('\n');
  const evt = {
    tool_name: 'mcp__demo__query',
    tool_input: {},
    tool_response: { content: [{ type: 'text', text: blockA }, { type: 'text', text: blockB }] },
    session_id: 'mcp-applied',
  };
  const r = run('claude-posttooluse.js', JSON.stringify(evt), {
    TRIM_NOTE: 'off', TRIM_METRICS: metrics, TRIM_MCP: 'on', TRIM_MCP_ALLOW_RE: '^mcp__demo__',
  });
  assert.strictEqual(r.status, 0);
  const u = JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput;
  assert.strictEqual(u.content.length, 2, 'block count and order preserved');
  const returned = Buffer.byteLength(u.content[0].text) + Buffer.byteLength(u.content[1].text);
  const original = Buffer.byteLength(blockA) + Buffer.byteLength(blockB);
  const rec = JSON.parse(fs.readFileSync(metrics, 'utf8').trim());
  assert.strictEqual(rec.tag, 'claude-mcp');
  assert.strictEqual(rec.applied, undefined, 'an applied transform is not marked unapplied');
  assert.strictEqual(rec.inBytes, original, 'recorded input bytes match the payload considered');
  assert.strictEqual(rec.outBytes, returned, 'recorded output bytes match the bytes returned');
  assert.ok(rec.outBytes < rec.inBytes, 'aggregate saving recorded');
  fs.rmSync(metrics, { force: true });
}
// Observe-only telemetry is skipped entirely when no sink consumes it
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-home-'));
  const id = `telemetry-off-${process.pid}`;
  const evt = {
    tool_name: 'Read',
    tool_input: { file_path: '/var/logs/app.log' },
    tool_response: { file: { filePath: '/var/logs/app.log', content: bigOut, numLines: 900 } },
    session_id: id,
  };
  fs.rmSync(statePath('trim-dup', id), { force: true });
  const off = run('claude-posttooluse.js', JSON.stringify(evt), {
    TRIM_NOTE: 'off', TRIM_METRICS: '', TRIM_LOG: '', HOME: home,
  });
  assert.strictEqual(off.status, 0);
  assert.ok(!fs.existsSync(statePath('trim-dup', id)), 'no duplicate-detection state without a metrics/debug sink');
  const metrics = path.join(os.tmpdir(), `trim-telemetry-${process.pid}.jsonl`);
  run('claude-posttooluse.js', JSON.stringify(evt), { TRIM_NOTE: 'off', TRIM_METRICS: metrics, HOME: home });
  assert.ok(fs.existsSync(statePath('trim-dup', id)), 'duplicate detection runs when a sink exists');
  fs.rmSync(metrics, { force: true });
  fs.rmSync(statePath('trim-dup', id), { force: true });
  fs.rmSync(home, { recursive: true, force: true });
}
// unavailable transcript preserves the prior pressure band
{
  const id = `pressure-preserve-${process.pid}`;
  writeState('trim-pressure', id, { pressureBand: 'high', compactionEpoch: 2 });
  const evt = {
    tool_name: 'Bash', tool_input: { command: 'printf ok' }, tool_response: { stdout: 'ok' },
    transcript_path: `/nonexistent/trim-${process.pid}.jsonl`, session_id: id,
  };
  run('claude-posttooluse.js', JSON.stringify(evt));
  assert.strictEqual(readState('trim-pressure', id).pressureBand, 'high');
  fs.rmSync(statePath('trim-pressure', id), { force: true });
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
// codex: a compression the final gate rejects is not recorded as a saving
{
  const metrics = path.join(os.tmpdir(), `trim-codex-netwin-${process.pid}.jsonl`);
  const attempted = `${'x'.repeat(100)}\x1b[31mred\x1b[0m`;
  const evt = { tool_input: { command: 'ls' }, tool_response: { stdout: attempted, exit_code: 0 } };
  const r = run('codex-posttooluse.js', JSON.stringify(evt), { TRIM_METRICS: metrics });
  assert.strictEqual(r.status, 0, 'below-gate compression is not emitted');
  assert.strictEqual(r.stderr, '');
  const rec = JSON.parse(fs.readFileSync(metrics, 'utf8').trim());
  assert.strictEqual(rec.applied, false);
  assert.strictEqual(rec.changed, false);
  assert.strictEqual(rec.inBytes, Buffer.byteLength(attempted));
  assert.strictEqual(rec.outBytes, rec.inBytes, 'recorded output bytes equal what was returned');
  fs.rmSync(metrics, { force: true });
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
// postcompact resets pressure and bumps epoch
{
  const id = `postcompact-${process.pid}`;
  const r = run('claude-postcompact.js', JSON.stringify({ session_id: id }));
  assert.strictEqual(r.stdout, '');
  const state = readState('trim-pressure', id);
  assert.strictEqual(state.pressureBand, 'low');
  assert.strictEqual(state.compactionEpoch, 1);
}
// current Claude PreCompact contract has no instruction output channel
{
  const r = run('claude-precompact.js', JSON.stringify({ hook_event_name: 'PreCompact' }));
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
