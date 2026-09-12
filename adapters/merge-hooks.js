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
        // Compression only needs Bash and eligible Read results. Keeping the
        // matcher here prevents a Node process from starting for other tools.
        PostToolUse: [
          {
            matcher: '^(Bash|Read)$',
            hooks: [{ type: 'command', command: `node ${ROOT}/adapters/claude-posttooluse.js`, timeout: 10000 }],
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

// Trim adapters that used to be installed and no longer are. Removed before
// merging so an upgrade can't leave a stale trim process behind, and so the
// matcher-based fallback below never matches one of our own retired entries.
const obsolete = which === 'claude' ? ['claude-narration-meter.js'] : [];

let cfg = {};
if (fs.existsSync(file)) {
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    console.error(`cannot merge hooks: ${file} is not valid JSON`);
    process.exit(1);
  }
}
cfg.hooks = cfg.hooks || {};
for (const event of Object.keys(cfg.hooks)) {
  if (!Array.isArray(cfg.hooks[event])) continue;
  cfg.hooks[event] = cfg.hooks[event].filter(
    (h) => !obsolete.some((name) => JSON.stringify(h).includes(`${ROOT}/adapters/${name}`))
  );
  if (!cfg.hooks[event].length) delete cfg.hooks[event];
}
for (const [event, entries] of Object.entries(wanted)) {
  const list = (cfg.hooks[event] = cfg.hooks[event] || []);
  for (const entry of entries) {
    const name = entry.hooks[0].command.match(/adapters\/([\w-]+\.js)/)[1];
    // legacy installs keyed everything on '/adapters/': match by filename,
    // falling back to any trim entry for this event — trim owns exactly one
    // entry per event, so an older filename or matcher is replaced in place
    // rather than duplicated. Both branches are constrained to commands under
    // our own ROOT — a third-party hook whose path happens to contain
    // '/adapters/' must coexist, not be silently replaced.
    const mine = (h) => JSON.stringify(h).includes(ROOT + '/adapters/');
    const idx = list.findIndex((h) => JSON.stringify(h).includes(ROOT + '/adapters/' + name) || mine(h));
    if (idx >= 0) {
      list[idx] = entry;
      cfg.hooks[event] = list.filter((h, i) => i === idx || !mine(h));
    } else list.push(entry);
  }
}
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
console.log('  hooks merged into ' + file);
