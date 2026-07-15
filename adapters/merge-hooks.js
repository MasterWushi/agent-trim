#!/usr/bin/env node
'use strict';
// Idempotently merge trim's PostToolUse hook into Claude Code settings.json
// or Codex hooks.json. Invoked by install.sh with ROOT env set.
const fs = require('fs');
const os = require('os');
const ROOT = process.env.ROOT;
const which = process.argv[2];
if (!ROOT || !['claude', 'codex'].includes(which)) {
  console.error('usage: ROOT=<repo> merge-hooks.js claude|codex');
  process.exit(1);
}

const file =
  which === 'claude'
    ? os.homedir() + '/.claude/settings.json'
    : os.homedir() + '/.codex/hooks.json';
const cmd =
  which === 'claude'
    ? `node ${ROOT}/adapters/claude-posttooluse.js`
    : `node ${ROOT}/adapters/codex-posttooluse.js`;
const entry =
  which === 'claude'
    ? { matcher: 'Bash', hooks: [{ type: 'command', command: cmd, timeout: 10000 }] }
    : { hooks: [{ type: 'command', command: cmd, timeout: 10 }] };

const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
cfg.hooks = cfg.hooks || {};
const list = (cfg.hooks.PostToolUse = cfg.hooks.PostToolUse || []);
const mine = (h) => JSON.stringify(h).includes('/adapters/'); // any prior trim install
const idx = list.findIndex(mine);
if (idx >= 0) list[idx] = entry;
else list.push(entry);
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
console.log('  hook merged into ' + file);
