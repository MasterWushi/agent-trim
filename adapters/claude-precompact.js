#!/usr/bin/env node
'use strict';

// Claude Code's current PreCompact contract can block compaction but cannot
// add or replace summary instructions. Keep the shared text exported for
// contract tests and future host support; executable mode stays silent.
const PRESERVATION_INSTRUCTIONS =
  'Preserve the current goal, unresolved failures and diagnostics, modified file paths, and every [trim hook: sidecar path. Omit passing logs, resolved diagnostics, and repeated prose.';

module.exports = { PRESERVATION_INSTRUCTIONS };
