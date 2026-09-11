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
  isExactSidecarRange,
  hostCompleteness,
  netWin,
  netWinTotals,
  telemetryEnabled,
  commandFingerprint,
  sha256,
} = require('../bin/trim-core.js');
const { observe: observeRecovery } = require('../bin/lib/recovery-detect');
const { lastUserPromptText } = require('./lib/transcript');
const { readState, writeState } = require('../bin/lib/session-state');
const { detectDuplicate } = require('../bin/lib/dup-detect');

const PRESSURE_KIND = 'trim-pressure';
function claudeHostComplete(text, isRead) {
  return hostCompleteness(text, isRead);
}

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
    const promptText = lastUserPromptText(evt.transcript_path);
    const pressureState = readState(PRESSURE_KIND, evt.session_id);
    const observed = telemetryEnabled();
    if (String(command).includes('TRIM_OFF=1')) {
      let recovery;
      if (observed) {
        try {
          recovery = observeRecovery(evt.session_id, pressureState.compactionEpoch || 0, {
            commandFingerprint: commandFingerprint(command),
            bypass: true,
            ts: Date.now(),
          });
        } catch {
          recovery = undefined;
        }
      }
      maybeLog('claude', null, null, { command: String(command), bypass: true, recovery });
      return process.exit(0);
    }
    let scale = 1;
    let pressureBand = pressureState.pressureBand || 'low';
    if (process.env.TRIM_ADAPTIVE !== 'off') {
      try {
        const pressure = pressureScale(fs.statSync(evt.transcript_path).size, pressureState.pressureBand || 'low');
        scale = pressure.scale;
        pressureBand = pressure.band;
      } catch {
        /* no transcript (bare harness): stay at 1 */
      }
    }
    if (pressureBand !== pressureState.pressureBand) {
      writeState(PRESSURE_KIND, evt.session_id, { pressureBand, compactionEpoch: pressureState.compactionEpoch || 0 });
    }
    const r = evt.tool_response;
    // Claude Code's Bash tool_response carries no exit code ({stdout, stderr,
    // interrupted, isImage} per the hooks doc) — extractExitCode covers other
    // shapes, `interrupted` marks a killed/timed-out run as a failure, and
    // otherwise failure is sniffed from the text.
    const exitCode = r && typeof r === 'object' && r.interrupted === true ? 1 : extractExitCode(r);
    const opts = {
      command: typeof command === 'string' ? command : undefined,
      exitCode,
      isDump: isFileDump(command),
      enumerate: requestsEnumeration(promptText),
      relevanceTokens: extractRelevanceTokens(promptText),
      scale,
      sessionId: evt.session_id,
      profile: process.env.TRIM_PROFILE,
      runtime: 'claude',
      relevance: evt.relevance,
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
      const readDup = observed ? detectDuplicate(evt.session_id, file.content) : { duplicate: false, ageMs: null };
      // T7 observe-only: never affects the trim decision above, only metrics.
      let recovery;
      if (observed) {
        try {
          recovery = observeRecovery(evt.session_id, pressureState.compactionEpoch || 0, {
            isSidecarRead: sideRead,
            filePath,
            range: evt.tool_input && `${evt.tool_input.offset || 0}-${evt.tool_input.limit || ''}`,
            contentHash: sha256(file.content),
            ts: Date.now(),
          });
        } catch {
          recovery = undefined;
        }
      }
      const logExtra = {
        command: filePath,
        durMs: 0,
        dupExact: readDup.duplicate,
        dupAgeMs: readDup.ageMs,
        recovery,
      };
      // A bounded read of a sidecar is the agent retrieving the exact evidence
      // the digest hid: return that range untouched, or it is re-elided into
      // another reread. Unbounded or oversized ranges keep the normal cap.
      if (isExactSidecarRange(filePath, evt.tool_input, file.content)) {
        maybeLog(
          'claude-read',
          { inBytes: Buffer.byteLength(file.content), outBytes: Buffer.byteLength(file.content) },
          null,
          { ...logExtra, applied: false, verbatim: true }
        );
        return process.exit(0);
      }
      const { out, meta } = compress(file.content, {
        ...opts,
        isDump: true, // treat like failures: keep more, signal-anchored
        hostMayTruncate: undefined, // Read arrives complete
        hostComplete: true,
        noSidecar: sideRead, // never re-sidecar a sidecar, or its middle becomes unreachable
      });
      if (!meta) return process.exit(0);
      if (!netWin(file.content, out, meta)) {
        maybeLog('claude-read', { inBytes: meta.inputBytes, outBytes: meta.inputBytes }, meta, { ...logExtra, applied: false });
        return process.exit(0);
      }
      maybeLog('claude-read', { inBytes: meta.inputBytes, outBytes: meta.outputBytes }, meta, logExtra);
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

    // T8 — MCP coverage, observe mode only. Never fires under the installed
    // ^(Bash|Read)$ matcher default; only relevant if a user has broadened
    // their own matcher to include mcp__* tools. See adapters/lib/mcp-result.js.
    if (typeof evt.tool_name === 'string' && /^mcp__/.test(evt.tool_name)) {
      const mcpMode = process.env.TRIM_MCP || 'observe';
      if (mcpMode === 'off') return process.exit(0);
      let allowRe;
      let denyRe;
      try {
        allowRe = process.env.TRIM_MCP_ALLOW_RE ? new RegExp(process.env.TRIM_MCP_ALLOW_RE) : undefined;
      } catch {
        allowRe = undefined;
      }
      try {
        denyRe = process.env.TRIM_MCP_DENY_RE ? new RegExp(process.env.TRIM_MCP_DENY_RE) : undefined;
      } catch {
        denyRe = undefined;
      }
      const { processMcpResult } = require('./lib/mcp-result');
      const { out: mcpOut, applied, observed: blocks, totals, meta: mcpMeta } = processMcpResult(r, {
        toolName: evt.tool_name,
        mode: mcpMode,
        allowRe,
        denyRe,
        compressOpts: { ...opts, hostMayTruncate: false },
      });
      const mcp = {
        mode: mcpMode,
        blocks: blocks.length,
        wouldInBytes: blocks.reduce((s, b) => s + (b.inBytes || 0), 0),
        wouldOutBytes: blocks.reduce((s, b) => s + (b.outBytes || 0), 0),
        lossy: blocks.some((b) => b.lossy),
        strategies: [...new Set(blocks.map((b) => b.strategy).filter(Boolean))],
      };
      // Observe mode is only worth anything if the counterfactual is recorded.
      // Only a transform the final aggregate gate actually let through joins
      // the headline totals; a never-applied trim must not inflate savings.
      if (!applied) {
        maybeLog('claude-mcp', null, null, { command: evt.tool_name, applied: false, mcp });
        return process.exit(0);
      }
      maybeLog('claude-mcp', { inBytes: totals.inBytes, outBytes: totals.outBytes }, mcpMeta, {
        command: evt.tool_name,
        mcp,
        emitted: { inLines: totals.inLines, outLines: totals.outLines, inTokEst: totals.inTokEst, outTokEst: totals.outTokEst },
      });
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: mcpOut } })
      );
      return process.exit(0);
    }

    let updated;
    let inBytes = 0;
    let outBytes = 0;
    let inLines = 0;
    let outLines = 0;
    let inTokEst = 0;
    let outTokEst = 0;
    let bestMeta = null; // contract of the dominant field, for telemetry
    let started = process.hrtime.bigint();
    let allRaw = '';
    if (r && typeof r === 'object' && (r.stdout !== undefined || r.stderr !== undefined || r.output !== undefined)) {
      const next = { ...r };
      let changed = false;
      for (const field of ['stdout', 'stderr', 'output']) {
        if (typeof next[field] !== 'string' || !next[field]) continue;
        if (observed) allRaw += next[field] + '\n';
        inBytes += Buffer.byteLength(next[field]);
        const { out, meta } = compress(next[field], { ...opts, hostComplete: claudeHostComplete(next[field], false) });
        outBytes += Buffer.byteLength(out);
        if (meta) {
          inLines += meta.inputLines;
          outLines += meta.outputLines;
          inTokEst += meta.inputTokenEstimate;
          outTokEst += meta.outputTokenEstimate;
        }
        if (!bestMeta || (meta && meta.inputBytes > bestMeta.inputBytes)) bestMeta = meta;
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
      allRaw = original;
      const { out, meta } = compress(original, { ...opts, hostComplete: claudeHostComplete(original, false) });
      outBytes = Buffer.byteLength(out);
      bestMeta = meta;
      if (meta) {
        inLines = meta.inputLines;
        outLines = meta.outputLines;
        inTokEst = meta.inputTokenEstimate;
        outTokEst = meta.outputTokenEstimate;
      }
      if (out !== original) updated = out;
    }

    const duplicate = observed ? detectDuplicate(evt.session_id, allRaw) : { duplicate: false, ageMs: null };
    // T7 observe-only: never affects the trim decision above, only metrics.
    let recovery;
    if (observed) {
      try {
        recovery = observeRecovery(evt.session_id, pressureState.compactionEpoch || 0, {
          commandFingerprint: commandFingerprint(opts.command),
          lossy: !!(bestMeta && bestMeta.lossy),
          sidecar: !!(bestMeta && bestMeta.sidecarPath),
          markerKind: bestMeta && bestMeta.strategy,
          bypass: false,
          ts: Date.now(),
        });
      } catch {
        recovery = undefined;
      }
    }
    // The final gate runs over the whole model-visible result, after every
    // field has been compressed: nothing is rewritten unless the aggregate
    // wins, and the log records the bytes that are actually emitted.
    const win = updated !== undefined && netWinTotals(inBytes, outBytes, inTokEst, outTokEst);
    const logExtra = {
      command: opts.command,
      durMs: Number(process.hrtime.bigint() - started) / 1e6,
      dupExact: duplicate.duplicate,
      dupAgeMs: duplicate.ageMs,
      recovery,
      emitted: {
        inLines,
        outLines: win ? outLines : inLines,
        inTokEst,
        outTokEst: win ? outTokEst : inTokEst,
      },
    };
    // Only rewrite when the aggregate actually saves space; small outputs pass
    // through, but duplicate incidence is still recorded.
    if (!win) {
      maybeLog('claude', { inBytes, outBytes: inBytes }, bestMeta, { ...logExtra, applied: false });
      return process.exit(0);
    }
    maybeLog('claude', { inBytes, outBytes }, bestMeta, {
      ...logExtra,
    });
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
