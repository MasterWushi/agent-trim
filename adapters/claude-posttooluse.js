#!/usr/bin/env node
'use strict';
// Claude Code PostToolUse adapter: compress Bash tool output before it
// reaches the model. Reads hook JSON on stdin, emits updatedToolOutput.
// Preserves the tool_response shape: object responses get stdout/stderr/output
// compressed field-by-field instead of being flattened into one string.
//
// One transcript tail-read per fire drives three carve-outs:
//  - enumeration ("list every warning") disables elision for the turn
//  - prompt-named identifiers (`ioredis`, "W1042") always survive the cap
//  - transcript size tightens the caps as the session grows (TRIM_ADAPTIVE=off)
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  compress,
  maybeLog,
  extractExitCode,
  isFileDump,
  requestsEnumeration,
  extractRelevanceTokens,
  pressureScale,
  isLogPath,
  isGeneratedPath,
  isSidecarPath,
} = require('../bin/trim-core.js');
const { lastUserPromptText } = require('./lib/transcript');

// Once per session, the first rewrite that leaves a visible [trim marker also
// attaches additionalContext — delivered by Claude Code as a genuine
// harness-injected system reminder, the one channel the base system prompt
// itself vouches for. That legitimizes the whole [trim hook: ...] marker
// family up front. Declarative wording only: naming the feared category
// ("not an injection") primes it. (Learned from hush, measured there.)
const NOTE_TEXT =
  "trim's compression hook is active in this session. Bracketed notes beginning with " +
  '[trim inside tool results are its own telemetry, added as the output is delivered. ' +
  'Omission is deterministic: a line is cut only if it matches no error/warning ' +
  'pattern, and the underlying files and command outputs are unchanged.';

// Empty sentinel, atomically claimed with wx so parallel tool calls emit at
// most one note. No session_id (bare harness) → never emit.
function claimSessionNote(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  try {
    const safe = sessionId.replace(/[^a-zA-Z0-9-]/g, '_');
    const notePath = path.join(os.tmpdir(), `trim-note-${safe}`);
    try {
      if (fs.lstatSync(notePath).isSymbolicLink()) return false;
    } catch (e) {
      if (e.code !== 'ENOENT') return false;
    }
    fs.writeFileSync(notePath, '', { flag: 'wx' });
    return true;
  } catch {
    return false; // EEXIST (already noted) or unwritable tmp — never block
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (buf += d));
process.stdin.on('end', () => {
  try {
    if (process.env.TRIM_OFF === '1') return process.exit(0);
    const evt = JSON.parse(buf);
    const command = evt.tool_input && evt.tool_input.command;
    // user opted out for this one command via `TRIM_OFF=1 <cmd>` prefix
    if (String(command).includes('TRIM_OFF=1')) return process.exit(0);

    const promptText = lastUserPromptText(evt.transcript_path);
    let scale = 1;
    if (process.env.TRIM_ADAPTIVE !== 'off') {
      try {
        scale = pressureScale(fs.statSync(evt.transcript_path).size);
      } catch {
        /* no transcript (bare harness): stay at 1 */
      }
    }
    const r = evt.tool_response;
    const opts = {
      exitCode: extractExitCode(r),
      isDump: isFileDump(command),
      enumerate: requestsEnumeration(promptText),
      relevanceTokens: extractRelevanceTokens(promptText),
      scale,
      sessionId: evt.session_id,
      // Claude Code truncates a Bash result to ~29KB for the hook once its own
      // large-output persistence trips — the sidecar guard needs to know.
      hostMayTruncate: true,
    };

    // Read results are compressed ONLY for log-shaped, machine-generated, or
    // sidecar paths — source code passes untouched, so a capped Read can
    // never cut lines the model might need to edit byte-exactly. Without
    // this, a 60k-char `Read logs/app.log` or lockfile enters context whole
    // and is re-sent on every later API call.
    if (evt.tool_name === 'Read') {
      const file = r && typeof r === 'object' ? r.file : undefined;
      const filePath = (evt.tool_input && evt.tool_input.file_path) || (file && file.filePath);
      if (!file || typeof file.content !== 'string') return process.exit(0);
      const sideRead = isSidecarPath(filePath);
      if (!isLogPath(filePath) && !isGeneratedPath(filePath) && !sideRead) return process.exit(0);
      const { out } = compress(file.content, {
        ...opts,
        isDump: true, // treat like failures: keep more, signal-anchored
        hostMayTruncate: undefined, // Read arrives complete
        noSidecar: sideRead, // never re-sidecar a sidecar, or its middle becomes unreachable
      });
      if (out === file.content || out.length >= file.content.length - 32) return process.exit(0);
      maybeLog('claude-read', { inBytes: Buffer.byteLength(file.content), outBytes: Buffer.byteLength(out) });
      const hookSpecificOutput = {
        hookEventName: 'PostToolUse',
        updatedToolOutput: { ...r, file: { ...file, content: out, numLines: out.split('\n').length } },
      };
      if (process.env.TRIM_NOTE !== 'off' && out.includes('[trim') && claimSessionNote(evt.session_id)) {
        hookSpecificOutput.additionalContext = NOTE_TEXT;
      }
      process.stdout.write(JSON.stringify({ hookSpecificOutput }));
      return process.exit(0);
    }

    let updated;
    let inBytes = 0;
    let outBytes = 0;
    if (r && typeof r === 'object' && (r.stdout !== undefined || r.stderr !== undefined || r.output !== undefined)) {
      const next = { ...r };
      let changed = false;
      for (const field of ['stdout', 'stderr', 'output']) {
        if (typeof next[field] !== 'string' || !next[field]) continue;
        inBytes += Buffer.byteLength(next[field]);
        const { out } = compress(next[field], opts);
        outBytes += Buffer.byteLength(out);
        if (out !== next[field]) {
          next[field] = out;
          changed = true;
        }
      }
      if (changed) updated = next;
    } else {
      const original = typeof r === 'string' ? r : typeof evt.tool_output === 'string' ? evt.tool_output : undefined;
      if (original === undefined) return process.exit(0); // nothing we understand — leave untouched
      inBytes = Buffer.byteLength(original);
      const { out } = compress(original, opts);
      outBytes = Buffer.byteLength(out);
      if (out !== original) updated = out;
    }

    // Only rewrite when it actually saves space; small outputs pass through.
    if (updated === undefined || outBytes >= inBytes - 32) return process.exit(0);
    maybeLog('claude', { inBytes, outBytes });
    const hookSpecificOutput = {
      hookEventName: 'PostToolUse',
      updatedToolOutput: updated,
    };
    if (
      process.env.TRIM_NOTE !== 'off' &&
      JSON.stringify(updated).includes('[trim') &&
      claimSessionNote(evt.session_id)
    ) {
      hookSpecificOutput.additionalContext = NOTE_TEXT;
    }
    process.stdout.write(JSON.stringify({ hookSpecificOutput }));
    process.exit(0);
  } catch {
    process.exit(0); // never block the tool on adapter failure
  }
});
