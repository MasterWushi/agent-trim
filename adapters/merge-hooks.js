#!/usr/bin/env node
'use strict';
// Idempotently merge trim's hooks into Claude Code settings.json or Codex
// hooks.json. Invoked by install.sh with ROOT env set.
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

// Per event: the entries trim owns. Idempotency key is the adapter filename —
// any existing entry mentioning it gets replaced in place.
const wanted =
  which === 'claude'
    ? {
        PostToolUse: [
          {
            matcher: '^(Bash|Read)$',
            hooks: [{ type: 'command', command: `node ${ROOT}/adapters/claude-posttooluse.js`, timeout: 10000 }],
          },
          {
            hooks: [{ type: 'command', command: `node ${ROOT}/adapters/claude-narration-meter.js`, timeout: 10000 }],
          },
        ],
        SubagentStart: [
          {
            hooks: [{ type: 'command', command: `node ${ROOT}/adapters/claude-subagent-brief.js`, timeout: 5000 }],
          },
        ],
        PostCompact: [
          {
            hooks: [{ type: 'command', command: `node ${ROOT}/adapters/claude-postcompact.js`, timeout: 5000 }],
          },
        ],
      }
    : {
        PostToolUse: [
          { hooks: [{ type: 'command', command: `node ${ROOT}/adapters/codex-posttooluse.js`, timeout: 10 }] },
        ],
      };

const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
cfg.hooks = cfg.hooks || {};
for (const [event, entries] of Object.entries(wanted)) {
  const list = (cfg.hooks[event] = cfg.hooks[event] || []);
  for (const entry of entries) {
    const name = entry.hooks[0].command.match(/adapters\/([\w-]+\.js)/)[1];
    // legacy installs keyed everything on '/adapters/': match by filename,
    // falling back to any trim entry for this event with the same matcher
    const idx = list.findIndex(
      (h) =>
        JSON.stringify(h).includes('/adapters/' + name) ||
        (JSON.stringify(h).includes('/adapters/') && (h.matcher || '') === (entry.matcher || ''))
    );
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
  }
}
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
console.log('  hooks merged into ' + file);
