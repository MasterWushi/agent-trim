#!/usr/bin/env node
'use strict';
// Adapter-boundary benchmark. Times the real entry points — a spawned
// claude/codex hook process and the in-process pi/opencode runtime handlers —
// against an in-process compress() on the same payload.
//   node bench/adapter.js          print the table, write docs/adapter-overhead.md
//   node bench/adapter.js --check  structural assertions only; never a latency gate

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compress, cheapHash, SIDECAR_DIR } = require('../bin/trim-core.js');
const piRuntime = require('../adapters/lib/pi-runtime.js');
const opencodeRuntime = require('../adapters/lib/opencode-runtime.js');

const ROOT = path.join(__dirname, '..');
const CLAUDE_ADAPTER = path.join(ROOT, 'adapters', 'claude-posttooluse.js');
// Stand-in for the retired second PostToolUse hook, so the two-process path
// trim used to install can still be measured against the merged one.
const LEGACY_METER = path.join(__dirname, 'legacy-narration-meter.js');
const CODEX_ADAPTER = path.join(ROOT, 'adapters', 'codex-posttooluse.js');
const DOC = path.join(ROOT, 'docs', 'adapter-overhead.md');
const CHECK = process.argv.includes('--check');
const ITERATIONS = CHECK ? 2 : 20;
const WARMUP = CHECK ? 0 : 1;
const MAXBUF = 64 * 1024 * 1024;
const RUN = Math.random().toString(36).slice(2, 6);
const STATE_KINDS = ['trim-pressure', 'trim-dup', 'trim-recovery', 'trim-pi'];
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-bench-adapter-'));
const fakeHome = path.join(tempRoot, 'home');
fs.mkdirSync(fakeHome);
const metricsSink = path.join(tempRoot, 'metrics.jsonl');
const debugSink = path.join(tempRoot, 'debug.log');

function lines(count, fn) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(fn(i));
  return out.join('\n');
}

function jsonl(entries) {
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
}

const TINY_BASH =
  [
    '$ npm run lint',
    '',
    '> app@1.0.0 lint',
    '> eslint .',
    '',
    'src/handler.js',
    '  12:5  warning  "unused" is assigned a value but never used  no-unused-vars',
    '  41:9  warning  "tmp" is declared but never read  no-unused-vars',
    '',
    '✖ 2 problems (0 errors, 2 warnings)',
  ].join('\n') + '\n';

const MEDIUM_BASH =
  lines(58, (i) => `step ${String(i + 1).padStart(3, '0')}/58: compiling src/features/report/module-${i}.js`) +
  '\n' +
  'src/features/report/index.js:88:3 warning: unused import "sum"\n' +
  'Build complete in 14.2s\n';

const LARGE_BASH =
  lines(330, (i) => `INFO worker processing job ${1000 + i} status=ok elapsed=${i * 7}ms`) +
  '\n' +
  'WARN queue depth 512 exceeds soft limit\n' +
  'Build complete in 41.6s\n';

const SIDECAR_READ_BOUNDED = lines(60, (i) => `${String(i + 1).padStart(4, '0')}  INFO job ${1000 + i} completed status=ok`) + '\n';

const SIDECAR_READ_UNBOUNDED =
  lines(480, (i) => `${String(i + 1).padStart(4, '0')}  INFO job ${1000 + i} completed status=ok`) +
  '\n' +
  'ERROR job 1480 failed: upstream timeout after 5000ms\n';

const SMALL_TRANSCRIPT = jsonl([
  { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'I will run the build.' }] } },
  { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'Run the build and report any warnings.' }] } },
  { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'Running the build now.' }] } },
  { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
  { type: 'user', uuid: 'u3', message: { role: 'user', content: [{ type: 'text', text: 'Now run the build again and report any warnings.' }] } },
]);

function largeTranscript() {
  const entries = [];
  let bytes = 0;
  for (let i = 0; bytes < 1024 * 1024; i++) {
    const entry = {
      type: 'assistant',
      uuid: `la${i}`,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `Step ${i}: inspected src/features/report/module-${i % 64}.js and confirmed the export surface is unchanged; no edits were required for this module in the current pass over the report subsystem.`,
          },
        ],
      },
    };
    entries.push(entry);
    bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
  }
  entries.push({ type: 'user', uuid: 'lu1', message: { role: 'user', content: [{ type: 'text', text: 'Run the build and report any warnings.' }] } });
  return jsonl(entries);
}

const LARGE_TRANSCRIPT = largeTranscript();

const smallTranscriptPath = path.join(tempRoot, 'small-transcript.jsonl');
const largeTranscriptPath = path.join(tempRoot, 'large-transcript.jsonl');
fs.writeFileSync(smallTranscriptPath, SMALL_TRANSCRIPT);
fs.writeFileSync(largeTranscriptPath, LARGE_TRANSCRIPT);

const sessionIds = [];
function sessionFor(tag) {
  const id = `b${RUN}${tag}`.slice(0, 8);
  sessionIds.push(id);
  return id;
}

function removeSidecars(id) {
  let names = [];
  try {
    names = fs.readdirSync(SIDECAR_DIR);
  } catch {
    names = [];
  }
  const prefix = `${id.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 8)}-`;
  for (const name of names) {
    if (name.startsWith(prefix)) fs.rmSync(path.join(SIDECAR_DIR, name), { force: true });
  }
}

function removeUnprefixedSidecars(text) {
  const base = path.join(SIDECAR_DIR, cheapHash(text));
  for (const file of [`${base}.txt`, `${base}.meta.json`]) fs.rmSync(file, { force: true });
}

function cleanupSession(id) {
  removeSidecars(id);
  const safe = id.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 120);
  fs.rmSync(path.join(os.tmpdir(), `trim-note-${safe}`), { force: true });
  for (const kind of STATE_KINDS) fs.rmSync(path.join(os.tmpdir(), kind, `${safe}.json`), { force: true });
}

function cleanupAll() {
  for (const id of sessionIds) cleanupSession(id);
  for (const file of [smallTranscriptPath, largeTranscriptPath, metricsSink, debugSink]) {
    fs.rmSync(file, { force: true });
  }
  fs.rmSync(tempRoot, { force: true, recursive: true });
}

function claudeBashEvent(payload, transcriptPath, session) {
  return {
    session_id: session,
    transcript_path: transcriptPath,
    cwd: ROOT,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm run build' },
    tool_response: { stdout: payload, stderr: '', interrupted: false, isImage: false },
  };
}

function claudeReadEvent(content, filePath, input, session) {
  return {
    session_id: session,
    transcript_path: smallTranscriptPath,
    cwd: ROOT,
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: filePath, ...input },
    tool_response: { type: 'text', file: { filePath, content, numLines: content.split('\n').length, startLine: 1, totalLines: content.split('\n').length } },
  };
}

function codexBashEvent(payload, session) {
  return {
    session_id: session,
    tool_input: { command: 'npm run build' },
    tool_response: { stdout: payload, stderr: '', exitCode: 0 },
  };
}

function spawnAdapter(adapterPath, event, childEnv) {
  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [adapterPath], {
    input: JSON.stringify(event),
    env: childEnv,
    encoding: 'utf8',
    maxBuffer: MAXBUF,
  });
  if (result.error) throw result.error;
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, result };
}

function claudeEmitted(stdout, fallback) {
  if (!stdout) return fallback;
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return fallback;
  }
  const out = parsed.hookSpecificOutput && parsed.hookSpecificOutput.updatedToolOutput;
  if (typeof out === 'string') return Buffer.byteLength(out);
  if (out && typeof out === 'object') {
    if (out.file && typeof out.file.content === 'string') return Buffer.byteLength(out.file.content);
    let total = 0;
    for (const field of ['stdout', 'stderr', 'output']) {
      if (typeof out[field] === 'string') total += Buffer.byteLength(out[field]);
    }
    return total;
  }
  return fallback;
}

function piEmitted(patch, fallback) {
  if (!patch || !Array.isArray(patch.content)) return fallback;
  let total = 0;
  for (const part of patch.content) if (part && typeof part.text === 'string') total += Buffer.byteLength(part.text);
  return total;
}

let callSeq = 0;

// variant 'merged' = today's single PostToolUse process; 'legacy' = the two
// processes trim used to install (compressor with the meter disabled, then a
// separate meter process), summed as the harness would pay them.
function claudeBashScenario(label, payload, options) {
  const settings = options || {};
  const session = sessionFor(settings.tag);
  const transcriptPath = settings.transcriptPath || smallTranscriptPath;
  const scale = Buffer.byteLength(fs.readFileSync(transcriptPath, 'utf8')) >= 1024 * 1024 ? 0.5 : 1;
  const legacy = !!settings.legacy;
  const shownLabel = legacy ? `${label} [legacy 2-process]` : label;
  return {
    id: `claude/${shownLabel}`,
    adapter: 'claude',
    label: shownLabel,
    pair: settings.pair,
    variant: legacy ? 'legacy' : 'merged',
    sidecarOff: !!settings.sidecarOff,
    reset: () => cleanupSession(session),
    prep: () => removeSidecars(session),
    invoke: (childEnv) => {
      const event = claudeBashEvent(payload, transcriptPath, session);
      const inBytes = Buffer.byteLength(payload);
      if (!legacy) {
        const run = spawnAdapter(CLAUDE_ADAPTER, event, childEnv);
        return { ms: run.ms, inBytes, outBytes: claudeEmitted(run.result.stdout, inBytes) };
      }
      const compressor = spawnAdapter(CLAUDE_ADAPTER, event, { ...childEnv, TRIM_NARRATION: 'off' });
      const meter = spawnAdapter(LEGACY_METER, event, childEnv);
      return { ms: compressor.ms + meter.ms, inBytes, outBytes: claudeEmitted(compressor.result.stdout, inBytes) };
    },
    core: () =>
      compress(payload, {
        command: 'npm run build',
        exitCode: 0,
        isDump: false,
        enumerate: false,
        relevanceTokens: [],
        scale,
        sessionId: session,
        runtime: 'claude',
        hostMayTruncate: true,
        hostComplete: true,
      }),
  };
}

function claudeReadScenario(label, content, input, options) {
  const settings = options || {};
  const session = sessionFor(settings.tag);
  const filePath = path.join(SIDECAR_DIR, `${session}-read.txt`);
  fs.mkdirSync(SIDECAR_DIR, { recursive: true });
  fs.writeFileSync(filePath, content);
  return {
    id: `claude/${label}`,
    adapter: 'claude',
    label,
    reset: () => cleanupSession(session),
    prep: () => {},
    teardown: () => fs.rmSync(filePath, { force: true }),
    invoke: (childEnv) => {
      const run = spawnAdapter(CLAUDE_ADAPTER, claudeReadEvent(content, filePath, input, session), childEnv);
      const inBytes = Buffer.byteLength(content);
      return { ms: run.ms, inBytes, outBytes: claudeEmitted(run.result.stdout, inBytes) };
    },
    core: () =>
      compress(content, {
        command: filePath,
        exitCode: 0,
        isDump: true,
        enumerate: false,
        relevanceTokens: [],
        sessionId: session,
        runtime: 'claude',
        hostComplete: true,
        noSidecar: true,
      }),
  };
}

function codexBashScenario(label, payload, options) {
  const settings = options || {};
  const session = sessionFor(settings.tag);
  return {
    id: `codex/${label}`,
    adapter: 'codex',
    label,
    sidecarOff: !!settings.sidecarOff,
    reset: () => cleanupSession(session),
    prep: () => removeSidecars(session),
    invoke: (childEnv) => {
      const run = spawnAdapter(CODEX_ADAPTER, codexBashEvent(payload, session), childEnv);
      const inBytes = Buffer.byteLength(payload);
      const outBytes = run.result.status === 2 ? Buffer.byteLength(run.result.stderr) : inBytes;
      return { ms: run.ms, inBytes, outBytes };
    },
    core: () =>
      compress(payload, {
        command: 'npm run build',
        exitCode: 0,
        isDump: false,
        sessionId: session,
        hostMayTruncate: true,
      }),
  };
}

function piScenario(label, event, options) {
  const settings = options || {};
  const session = sessionFor(settings.tag);
  return {
    id: `pi/${label}`,
    adapter: 'pi',
    label,
    sidecarOff: !!settings.sidecarOff,
    reset: () => cleanupSession(session),
    prep: () => removeSidecars(session),
    teardown: settings.teardown,
    invoke: () => {
      const id = `${session}-${++callSeq}`;
      const running = { ...event, toolCallId: id };
      const started = process.hrtime.bigint();
      const prior = piRuntime.readState(session);
      const result = piRuntime.handleToolResult(running, prior, { sessionId: session });
      piRuntime.writeState(session, result.stateDelta);
      piRuntime.logMetrics(result.metrics);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const inBytes = Buffer.byteLength(settings.payload);
      return { ms, inBytes, outBytes: piEmitted(result.patch, inBytes) };
    },
    core: () => compress(settings.payload, settings.coreOpts(session)),
  };
}

// The sidecar file is content-addressed on the CLEANED text, which the bench
// cannot predict from the raw payload: deleting a guessed path would silently
// stop forcing the write path the moment cleaning changed. Instead each
// iteration diffs the sidecar directory, deletes exactly what it created, and
// asserts that a sidecar-producing scenario really wrote one every time.
function sidecarNames() {
  try {
    return new Set(fs.readdirSync(SIDECAR_DIR));
  } catch {
    return new Set();
  }
}

function opencodeScenario(label, payload, options) {
  const settings = options || {};
  let created = [];
  const dropCreated = () => {
    for (const name of created) fs.rmSync(path.join(SIDECAR_DIR, name), { force: true });
    created = [];
  };
  return {
    id: `opencode/${label}`,
    adapter: 'opencode',
    label,
    sidecarOff: !!settings.sidecarOff,
    reset: () => {
      dropCreated();
      removeUnprefixedSidecars(payload); // best effort against a leftover from an aborted run
    },
    prep: dropCreated,
    teardown: () => {
      dropCreated();
      removeUnprefixedSidecars(payload);
    },
    invoke: async () => {
      const before = sidecarNames();
      const output = { output: payload };
      const started = process.hrtime.bigint();
      await opencodeRuntime.afterToolExecute({ args: { command: 'npm run build' } }, output);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      created = [...sidecarNames()].filter((name) => !before.has(name));
      if (settings.expectSidecar && !created.some((name) => name.endsWith('.txt'))) {
        throw new Error(`${label}: sidecar-on iteration wrote no sidecar — the write path is no longer measured`);
      }
      const inBytes = Buffer.byteLength(payload);
      return { ms, inBytes, outBytes: Buffer.byteLength(output.output) };
    },
    core: () => compress(payload, { command: 'npm run build', hostMayTruncate: true }),
  };
}

function piBashCoreOpts(session) {
  return {
    command: 'npm run build',
    exitCode: 0,
    isDump: false,
    noSidecar: false,
    hostMayTruncate: true,
    hostComplete: true,
    runtime: 'pi',
    sessionId: session,
    scale: 1,
  };
}

function piReadEvent(content, filePath, input) {
  return { toolName: 'read', input: { path: filePath, ...input }, content: [{ type: 'text', text: content }], details: { exitCode: 0 }, isError: false };
}

function buildScenarios() {
  const list = [
    claudeBashScenario('tiny bash', TINY_BASH, { tag: 'ct', pair: 'tiny bash' }),
    claudeBashScenario('tiny bash', TINY_BASH, { tag: '1t', pair: 'tiny bash', legacy: true }),
    claudeBashScenario('medium bash', MEDIUM_BASH, { tag: 'cm', pair: 'medium bash' }),
    claudeBashScenario('medium bash', MEDIUM_BASH, { tag: '1m', pair: 'medium bash', legacy: true }),
    claudeBashScenario('large bash (sidecar)', LARGE_BASH, { tag: 'cl', pair: 'large bash (sidecar)' }),
    claudeBashScenario('large bash (sidecar)', LARGE_BASH, { tag: '1l', pair: 'large bash (sidecar)', legacy: true }),
    claudeBashScenario('large bash (sidecar off)', LARGE_BASH, { tag: 'co', sidecarOff: true }),
    claudeBashScenario('tiny bash (small transcript)', TINY_BASH, { tag: 'cs', transcriptPath: smallTranscriptPath, pair: 'tiny bash (small transcript)' }),
    claudeBashScenario('tiny bash (small transcript)', TINY_BASH, {
      tag: '1s',
      transcriptPath: smallTranscriptPath,
      pair: 'tiny bash (small transcript)',
      legacy: true,
    }),
    claudeBashScenario('tiny bash (1MB transcript)', TINY_BASH, { tag: 'cb', transcriptPath: largeTranscriptPath, pair: 'tiny bash (1MB transcript)' }),
    claudeBashScenario('tiny bash (1MB transcript)', TINY_BASH, {
      tag: '1b',
      transcriptPath: largeTranscriptPath,
      pair: 'tiny bash (1MB transcript)',
      legacy: true,
    }),
    claudeReadScenario('read sidecar (bounded range)', SIDECAR_READ_BOUNDED, { offset: 20, limit: 60 }, { tag: 'cr' }),
    claudeReadScenario('read sidecar (unbounded)', SIDECAR_READ_UNBOUNDED, {}, { tag: 'cu' }),
    codexBashScenario('tiny bash', TINY_BASH, { tag: 'xt' }),
    codexBashScenario('medium bash', MEDIUM_BASH, { tag: 'xm' }),
    codexBashScenario('large bash (sidecar)', LARGE_BASH, { tag: 'xl' }),
    codexBashScenario('large bash (sidecar off)', LARGE_BASH, { tag: 'xo', sidecarOff: true }),
    opencodeScenario('tiny bash', TINY_BASH),
    opencodeScenario('medium bash', MEDIUM_BASH),
    opencodeScenario('large bash (sidecar)', LARGE_BASH, { expectSidecar: true }),
    opencodeScenario('large bash (sidecar off)', LARGE_BASH, { sidecarOff: true }),
  ];
  const piBash = (label, payload, tag, sidecarOff) =>
    piScenario(
      label,
      { toolName: 'bash', input: { command: 'npm run build' }, content: [{ type: 'text', text: payload }], details: { exitCode: 0 }, isError: false },
      { tag, sidecarOff, payload, coreOpts: piBashCoreOpts }
    );
  list.push(
    piBash('tiny bash', TINY_BASH, 'pt'),
    piBash('medium bash', MEDIUM_BASH, 'pm'),
    piBash('large bash (sidecar)', LARGE_BASH, 'pl'),
    piBash('large bash (sidecar off)', LARGE_BASH, 'po', true)
  );
  const boundedPath = path.join(SIDECAR_DIR, `${sessionFor('pr')}-read.txt`);
  const unboundedPath = path.join(SIDECAR_DIR, `${sessionFor('pu')}-read.txt`);
  fs.mkdirSync(SIDECAR_DIR, { recursive: true });
  fs.writeFileSync(boundedPath, SIDECAR_READ_BOUNDED);
  fs.writeFileSync(unboundedPath, SIDECAR_READ_UNBOUNDED);
  list.push(
    piScenario('read sidecar (bounded range)', piReadEvent(SIDECAR_READ_BOUNDED, boundedPath, { offset: 20, limit: 60 }), {
      tag: 'pr2',
      payload: SIDECAR_READ_BOUNDED,
      teardown: () => fs.rmSync(boundedPath, { force: true }),
      coreOpts: (session) => ({
        command: boundedPath,
        exitCode: 0,
        isDump: true,
        relevanceTokens: [],
        sessionId: session,
        runtime: 'pi',
        hostComplete: true,
        noSidecar: true,
      }),
    }),
    piScenario('read sidecar (unbounded)', piReadEvent(SIDECAR_READ_UNBOUNDED, unboundedPath, {}), {
      tag: 'pu2',
      payload: SIDECAR_READ_UNBOUNDED,
      teardown: () => fs.rmSync(unboundedPath, { force: true }),
      coreOpts: (session) => ({
        command: unboundedPath,
        exitCode: 0,
        isDump: true,
        relevanceTokens: [],
        sessionId: session,
        runtime: 'pi',
        hostComplete: true,
        noSidecar: true,
      }),
    })
  );
  return list;
}

function envFor(telemetry, sidecarOff) {
  const env = { ...process.env, HOME: fakeHome };
  delete env.TRIM_PROFILE;
  if (sidecarOff) env.TRIM_SIDECAR = 'off';
  else delete env.TRIM_SIDECAR;
  if (telemetry) {
    env.TRIM_METRICS = metricsSink;
    env.TRIM_LOG = debugSink;
  } else {
    delete env.TRIM_METRICS;
    delete env.TRIM_LOG;
  }
  return env;
}

function applyProcessEnv(telemetry, sidecarOff) {
  const env = envFor(telemetry, sidecarOff);
  for (const key of ['TRIM_METRICS', 'TRIM_LOG', 'TRIM_SIDECAR', 'TRIM_PROFILE', 'HOME']) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  return env;
}

function percentile(samples, p) {
  const sorted = samples.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * p))];
}

function timeSync(fn) {
  const started = process.hrtime.bigint();
  const value = fn();
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, value };
}

async function runScenario(scenario, telemetry) {
  const childEnv = applyProcessEnv(telemetry, scenario.sidecarOff);
  const adapterSamples = [];
  const coreSamples = [];
  let inBytes = 0;
  let outBytes = 0;
  if (scenario.reset) scenario.reset();
  for (let i = 0; i < WARMUP; i++) {
    scenario.prep();
    await scenario.invoke(childEnv);
  }
  for (let i = 0; i < ITERATIONS; i++) {
    scenario.prep();
    const run = await scenario.invoke(childEnv);
    adapterSamples.push(run.ms);
    inBytes = run.inBytes;
    outBytes = run.outBytes;
  }
  for (let i = 0; i < WARMUP; i++) {
    scenario.prep();
    scenario.core();
  }
  for (let i = 0; i < ITERATIONS; i++) {
    scenario.prep();
    coreSamples.push(timeSync(() => scenario.core()).ms);
  }
  if (scenario.teardown) scenario.teardown();
  return {
    id: scenario.id,
    adapter: scenario.adapter,
    label: scenario.label,
    pair: scenario.pair,
    variant: scenario.variant,
    telemetry,
    iterations: ITERATIONS,
    p50Ms: +percentile(adapterSamples, 0.5).toFixed(2),
    p95Ms: +percentile(adapterSamples, 0.95).toFixed(2),
    inBytes,
    outBytes,
    coreP50Ms: +percentile(coreSamples, 0.5).toFixed(3),
    coreP95Ms: +percentile(coreSamples, 0.95).toFixed(3),
  };
}

// Claude PostToolUse before/after: legacy two spawned processes vs the merged
// one, same payload and same machine.
function comparisons(rows) {
  const out = [];
  for (const row of rows) {
    if (row.variant !== 'merged' || !row.pair) continue;
    const legacy = rows.find((r) => r.pair === row.pair && r.variant === 'legacy' && r.telemetry === row.telemetry);
    if (!legacy) continue;
    out.push({
      pair: row.pair,
      telemetry: row.telemetry,
      legacyP50: legacy.p50Ms,
      mergedP50: row.p50Ms,
      savedMs: +(legacy.p50Ms - row.p50Ms).toFixed(2),
      savedPct: +(((legacy.p50Ms - row.p50Ms) / legacy.p50Ms) * 100).toFixed(1),
      bytesMatch: legacy.outBytes === row.outBytes,
    });
  }
  return out;
}

function comparisonTable(pairs) {
  const header = ['claude posttooluse', 'telemetry', 'legacy p50 ms', 'merged p50 ms', 'saved ms', 'saved %', 'emitted bytes equal'];
  const table = [header, header.map(() => '---')];
  for (const p of pairs) {
    table.push([p.pair, p.telemetry ? 'on' : 'off', String(p.legacyP50), String(p.mergedP50), String(p.savedMs), String(p.savedPct), p.bytesMatch ? 'yes' : 'NO']);
  }
  const widths = header.map((_, i) => Math.max(...table.map((line) => line[i].length)));
  return table.map((line) => line.map((cell, i) => cell.padEnd(widths[i])).join('  ')).join('\n');
}

function report(rows) {
  const header = ['scenario', 'adapter', 'telemetry', 'iters', 'p50 ms', 'p95 ms', 'in bytes', 'emitted bytes', 'core p50 ms', 'core p95 ms'];
  const table = [header, header.map(() => '---')];
  for (const row of rows) {
    table.push([
      row.label,
      row.adapter,
      row.telemetry ? 'on' : 'off',
      String(row.iterations),
      String(row.p50Ms),
      String(row.p95Ms),
      String(row.inBytes),
      String(row.outBytes),
      String(row.coreP50Ms),
      String(row.coreP95Ms),
    ]);
  }
  const widths = header.map((_, i) => Math.max(...table.map((line) => line[i].length)));
  return table.map((line) => line.map((cell, i) => cell.padEnd(widths[i])).join('  ')).join('\n');
}

function markdown(rows) {
  const md = [
    '# Adapter overhead',
    '',
    'Generated by `node bench/adapter.js`. Every figure is wall-clock on the machine that',
    'ran it, at that moment: use it for before/after comparison on one machine, never as a',
    'cross-machine contract and never as a CI latency gate (`--check` asserts structure only).',
    '',
    '`emitted bytes` is the model-visible tool result after the adapter ran — equal to the',
    'input when the adapter passed the result through untouched. `core` is an in-process',
    '`compress()` call on the same payload, so the gap against `p50 ms` is the adapter',
    'boundary: process startup, stdin parsing, transcript/state I/O, sidecar writes, and',
    'hook-JSON serialization.',
    '',
    'The sidecar scenarios delete exactly the sidecar files the previous iteration',
    'created (the path is content-addressed on cleaned text, so it cannot be guessed',
    'from the payload) and assert that a sidecar-producing scenario writes one every',
    'iteration; the sidecar-off variants measure the same payload through',
    '`TRIM_SIDECAR=off`.',
    '',
    'Rows marked `[legacy 2-process]` spawn the two PostToolUse hooks trim used to',
    'install (compressor + a separate narration meter) and sum them; the unmarked',
    'claude rows are the single merged process that replaced them.',
    '',
    `Iterations: ${ITERATIONS} measured per scenario, ${WARMUP} warmup discarded.`,
    '',
    '| scenario | adapter | telemetry | iters | p50 ms | p95 ms | in bytes | emitted bytes | core p50 ms | core p95 ms |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const row of rows) {
    md.push(
      `| ${row.label} | ${row.adapter} | ${row.telemetry ? 'on' : 'off'} | ${row.iterations} | ${row.p50Ms} | ${row.p95Ms} | ${row.inBytes} | ${row.outBytes} | ${row.coreP50Ms} | ${row.coreP95Ms} |`
    );
  }
  const pairs = comparisons(rows);
  if (pairs.length) {
    md.push(
      '',
      '## Claude PostToolUse: legacy two-process vs merged one-process',
      '',
      'Same payload, same machine, same iteration count. `emitted bytes equal` confirms',
      'the merged hook returns byte-identical model-visible output.',
      '',
      '| scenario | telemetry | legacy p50 ms | merged p50 ms | saved ms | saved % | emitted bytes equal |',
      '|---|---|---:|---:|---:|---:|---|'
    );
    for (const p of pairs) {
      md.push(
        `| ${p.pair} | ${p.telemetry ? 'on' : 'off'} | ${p.legacyP50} | ${p.mergedP50} | ${p.savedMs} | ${p.savedPct} | ${p.bytesMatch ? 'yes' : 'NO'} |`
      );
    }
  }
  md.push('');
  return md.join('\n');
}

async function main() {
  const scenarios = buildScenarios();
  const rows = [];
  for (const scenario of scenarios) {
    for (const telemetry of [false, true]) rows.push(await runScenario(scenario, telemetry));
  }
  const broken = rows.filter(
    (row) =>
      !Number.isFinite(row.p50Ms) ||
      !Number.isFinite(row.p95Ms) ||
      !Number.isFinite(row.coreP50Ms) ||
      !Number.isFinite(row.coreP95Ms) ||
      row.iterations < 1 ||
      !(row.inBytes > 0) ||
      !(row.outBytes > 0)
  );
  const pairs = comparisons(rows);
  const mergedPairs = new Set(rows.filter((r) => r.variant === 'merged' && r.pair).map((r) => `${r.pair}/${r.telemetry}`));
  const missing = [...mergedPairs].filter((key) => !pairs.some((p) => `${p.pair}/${p.telemetry}` === key));
  const mismatched = pairs.filter((p) => !p.bytesMatch);
  if (CHECK) {
    if (missing.length || mismatched.length) {
      for (const key of missing) console.error(`adapter --check: no legacy counterpart for ${key}`);
      for (const p of mismatched) console.error(`adapter --check: emitted bytes differ for ${p.pair} telemetry=${p.telemetry ? 'on' : 'off'}`);
      cleanupAll();
      process.exit(1);
    }
    if (broken.length) {
      console.error(`adapter --check: ${broken.length} scenario(s) failed structural assertions`);
      for (const row of broken) console.error(`  ${row.id} telemetry=${row.telemetry ? 'on' : 'off'}`);
      cleanupAll();
      process.exit(1);
    }
    console.log(`adapter --check: ok (${rows.length} scenario replays, structural only)`);
    cleanupAll();
    return;
  }
  console.log(report(rows));
  if (pairs.length) console.log(`\n${comparisonTable(pairs)}`);
  for (const p of mismatched) console.error(`WARNING: emitted bytes differ for ${p.pair} telemetry=${p.telemetry ? 'on' : 'off'}`);
  fs.writeFileSync(DOC, markdown(rows));
  console.log(`\nwrote ${path.relative(ROOT, DOC)}`);
  cleanupAll();
  process.exit(broken.length ? 1 : 0);
}

main().catch((error) => {
  cleanupAll();
  console.error(error);
  process.exit(1);
});
