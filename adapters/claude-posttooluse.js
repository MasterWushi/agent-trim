#!/usr/bin/env node
'use strict';
// Claude Code PostToolUse adapter: compress Bash tool output before it
// reaches the model. Reads hook JSON on stdin, emits updatedToolOutput.
const { compress, maybeLog } = require('../bin/trim-core.js');

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (buf += d));
process.stdin.on('end', () => {
  try {
    if (process.env.TRIM_OFF === '1') return process.exit(0);
    const evt = JSON.parse(buf);
    // user opted out for this one command via `TRIM_OFF=1 <cmd>` prefix
    if (String(evt.tool_input && evt.tool_input.command).includes('TRIM_OFF=1')) return process.exit(0);
    // Prefer structured response; fall back to flat string field.
    let original;
    const r = evt.tool_response;
    if (r && typeof r === 'object' && (r.stdout !== undefined || r.stderr !== undefined)) {
      original = [r.stdout || '', r.stderr || ''].filter(Boolean).join('\n');
    } else if (typeof evt.tool_output === 'string') {
      original = evt.tool_output;
    } else {
      return process.exit(0); // nothing we understand — leave untouched
    }
    const { out, stats } = compress(original);
    maybeLog('claude', stats);
    // Only rewrite when it actually saves space; small outputs pass through.
    if (!out || out.length >= original.length - 32) return process.exit(0);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          updatedToolOutput: out,
        },
      })
    );
    process.exit(0);
  } catch {
    process.exit(0); // never block the tool on adapter failure
  }
});
