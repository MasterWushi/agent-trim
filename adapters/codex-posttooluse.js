#!/usr/bin/env node
'use strict';
// Codex CLI PostToolUse adapter. Reads hook event JSON on stdin; if the shell
// output compresses meaningfully, exits 2 with the compressed replacement on
// stderr (Codex substitutes it for the tool result). Otherwise exits 0.
const { compress, maybeLog, extractExitCode, isFileDump } = require('../bin/trim-core.js');

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (buf += d));
process.stdin.on('end', () => {
  try {
    if (process.env.TRIM_OFF === '1') return process.exit(0);
    const evt = JSON.parse(buf);
    if (JSON.stringify(evt.tool_input || '').includes('TRIM_OFF=1')) return process.exit(0);
    const r = evt.tool_response || evt.output || {};
    let original =
      typeof r === 'string'
        ? r
        : [r.stdout, r.stderr, r.output].filter((x) => typeof x === 'string' && x).join('\n');
    if (!original && typeof evt.tool_output === 'string') original = evt.tool_output;
    if (!original) return process.exit(0);
    const command =
      evt.tool_input && (typeof evt.tool_input === 'string' ? evt.tool_input : evt.tool_input.command);
    const { out, stats } = compress(original, {
      exitCode: extractExitCode(typeof r === 'object' ? r : evt),
      isDump: isFileDump(command),
      sessionId: evt.session_id || evt.thread_id,
      hostMayTruncate: true, // shell output; the harness may cut before we see it
    });
    maybeLog('codex', stats);
    if (!out || out.length >= original.length - 32) return process.exit(0);
    process.stderr.write(out);
    process.exit(2);
  } catch {
    process.exit(0);
  }
});
