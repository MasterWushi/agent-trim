#!/usr/bin/env node
'use strict';
// SubagentStart hook (Claude Code only): extend trim's terse-report style to
// subagents. Style files never reach a subagent — they ride the main loop's
// system prompt — so spawned workers pad their final messages with preamble
// and restated instructions. That padding is pure context tax on the PARENT:
// a subagent's final message lands in the main conversation and is re-sent
// with every later API call. One short injected line per spawn buys that back
// for the whole session. Injected into EVERY subagent, no agent-type gating:
// a report is exactly what a read-only agent produces too. Ported from hush.

const fs = require('fs');

const BRIEF =
  'Your final message is consumed by the calling agent as a tool result, not read as chat: ' +
  'return the findings themselves — data, paths, identifiers, verbatim errors — in complete ' +
  'clauses, with no preamble, no restating of your instructions, and no offers of further help. ' +
  'Emit no text between tool calls either: nobody reads it, so a progress update has no audience. ' +
  'Chain the calls and put everything in that one final message.';

function main() {
  if (process.env.TRIM_OFF === '1') return;
  if (process.env.TRIM_SUBAGENT === 'off') return;
  try {
    fs.readFileSync(0, 'utf-8'); // consume stdin per hook contract
  } catch {
    /* ignore */
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
        additionalContext: BRIEF,
      },
    })
  );
}

if (require.main === module) main();

module.exports = { BRIEF };
