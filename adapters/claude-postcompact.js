#!/usr/bin/env node
'use strict';
// PostCompact hook (Claude Code only): re-arms the once-per-session
// marker-provenance note after compaction. The note fires once, guarded by a
// sentinel file — but compaction summarizes the note away while the sentinel
// still says "delivered", so markers appearing after compaction arrive
// unexplained and risk being read as prompt injection. Deleting the sentinel
// re-arms delivery on the next marker; deleting the meter's state file too is
// cleanup (its turn anchors are stale post-compaction). Emits nothing:
// re-injecting the note unconditionally on every compaction would spend
// tokens on sessions that never emit another marker. Ported from hush, MIT.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readState, writeState } = require('../bin/lib/session-state');
const { clearDuplicates } = require('../bin/lib/dup-detect');

function main() {
  try {
    if (process.env.TRIM_OFF === '1') return;
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(0, 'utf-8') || '{}');
    } catch {
      return; // malformed stdin — no-op
    }
    if (typeof data.session_id !== 'string' || !data.session_id) return;
    const safe = data.session_id.replace(/[^a-zA-Z0-9-]/g, '_');
    for (const p of [path.join(os.tmpdir(), `trim-note-${safe}`), path.join(os.tmpdir(), `trim-meter-${safe}.json`)]) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ENOENT fine; anything else not worth breaking a session over */
      }
    }
    const state = readState('trim-pressure', data.session_id);
    writeState('trim-pressure', data.session_id, {
      pressureBand: 'low',
      compactionEpoch: (Number.isInteger(state.compactionEpoch) ? state.compactionEpoch : 0) + 1,
    });
    clearDuplicates(data.session_id);
  } catch {
    /* fail-open */
  }
}

if (require.main === module) main();
