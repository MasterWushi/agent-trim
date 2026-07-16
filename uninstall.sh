#!/usr/bin/env bash
# trim uninstaller — removes hooks, plugins, and style blocks from all harnesses.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

strip_style() {
  [[ -f "$1" ]] || return 0
  # delete marker-fenced block (and the blank line install.sh added before it)
  perl -0pi -e 's/\n?\n<!-- trim:style:start -->.*?<!-- trim:style:end -->\n?//s' "$1"
}

node - <<'EOF'
const fs = require('fs'), os = require('os');
for (const f of [os.homedir()+'/.claude/settings.json', os.homedir()+'/.codex/hooks.json']) {
  if (!fs.existsSync(f)) continue;
  const cfg = JSON.parse(fs.readFileSync(f,'utf8'));
  if (cfg.hooks) {
    for (const ev of ['PostToolUse', 'SubagentStart', 'PostCompact']) {
      if (!cfg.hooks[ev]) continue;
      cfg.hooks[ev] = cfg.hooks[ev].filter(h => !JSON.stringify(h).includes('/adapters/'));
      if (!cfg.hooks[ev].length) delete cfg.hooks[ev];
    }
    if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  }
  fs.writeFileSync(f, JSON.stringify(cfg,null,2)+'\n');
  console.log('cleaned '+f);
}
EOF

rm -f "$HOME/.config/opencode/plugins/trim.ts" "$HOME/.pi/agent/extensions/trim.ts"
for f in "$HOME/.claude/CLAUDE.md" "$HOME/.codex/AGENTS.md" "$HOME/.config/opencode/AGENTS.md" "$HOME/.pi/agent/AGENTS.md"; do
  strip_style "$f"
done
echo "trim uninstalled."
