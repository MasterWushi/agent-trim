#!/usr/bin/env node
'use strict';
// Bench-only. Reproduces the retired adapters/claude-narration-meter.js entry
// point — a second spawned PostToolUse process doing nothing but the narration
// meter — so bench/adapter.js can time the legacy two-process Claude path
// against the merged one. Never installed; shares the production meter logic.
const fs = require('fs');
const { tailReader } = require('../adapters/lib/transcript');
const { narrationCorrection } = require('../adapters/lib/narration');

if (process.env.TRIM_OFF !== '1') {
  try {
    const evt = JSON.parse(fs.readFileSync(0, 'utf-8') || '{}');
    const correction = narrationCorrection(evt, tailReader(evt.transcript_path)());
    if (correction) {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: correction } })
      );
    }
  } catch {
    /* fail open, exactly as the retired hook did */
  }
}
