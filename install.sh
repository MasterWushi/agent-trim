#!/usr/bin/env bash
# trim installer — wires the compressor into every detected agent harness.
# Usage: ./install.sh [--no-style]
# Idempotent: safe to re-run. Backups of every modified file go to backup/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
command -v node >/dev/null || { echo "node required"; exit 1; }

# --check reports drift between this repo and what the agents actually run,
# and changes nothing. Kept here so there is one entry point to remember.
if [[ "${1:-}" == "--check" ]]; then
  exec node "$ROOT/bin/trim-doctor.js" "${@:2}"
fi

STYLE=1
[[ "${1:-}" == "--no-style" ]] && STYLE=0

BK="$ROOT/backup/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BK"
# Always return 0: a missing file is "nothing to back up", and under set -e
# a bare [[ -f ]] && ... failing would abort the whole install.
backup() { if [[ -f "$1" ]]; then cp "$1" "$BK/$(echo "$1" | tr / _)"; fi; }

MARK_START="<!-- trim:style:start -->"
MARK_END="<!-- trim:style:end -->"
append_style() { # $1 = instructions file
  [[ $STYLE == 1 ]] || return 0
  mkdir -p "$(dirname "$1")"; touch "$1"
  grep -qF "$MARK_START" "$1" && return 0
  backup "$1"
  { echo; echo "$MARK_START"; cat "$ROOT/style/TERSE.md"; echo "$MARK_END"; } >> "$1"
  echo "  style block appended to $1"
}

render() { # $1 template, $2 dest — substitute repo root path
  sed "s|__TRIM_ROOT__|$ROOT|g" "$1" > "$2"
}

echo "trim root: $ROOT"

# ---- Claude Code ----
if [[ -d "$HOME/.claude" ]]; then
  echo "[claude code]"
  backup "$HOME/.claude/settings.json"
  ROOT="$ROOT" node "$ROOT/adapters/merge-hooks.js" claude
  append_style "$HOME/.claude/CLAUDE.md"
fi

# ---- Codex CLI ----
if [[ -d "$HOME/.codex" ]]; then
  echo "[codex]"
  backup "$HOME/.codex/hooks.json"
  ROOT="$ROOT" node "$ROOT/adapters/merge-hooks.js" codex
  append_style "$HOME/.codex/AGENTS.md"
  echo "  NOTE: next interactive codex run will ask to trust the new hook — approve once."
fi

# ---- opencode ----
if [[ -d "$HOME/.config/opencode" ]]; then
  echo "[opencode]"
  mkdir -p "$HOME/.config/opencode/plugins"
  render "$ROOT/adapters/opencode-trim.ts" "$HOME/.config/opencode/plugins/trim.ts"
  append_style "$HOME/.config/opencode/AGENTS.md"
  echo "  plugin installed"
fi

# ---- pi.dev ----
if [[ -d "$HOME/.pi/agent" ]]; then
  echo "[pi]"
  mkdir -p "$HOME/.pi/agent/extensions"
  render "$ROOT/adapters/pi-trim.ts" "$HOME/.pi/agent/extensions/trim.ts"
  append_style "$HOME/.pi/agent/AGENTS.md"
  echo "  extension installed"
fi

echo "done. verify: touch ~/.trim-debug, run any harness on a long command, check the log. rm ~/.trim-debug after."
echo
node "$ROOT/bin/trim-doctor.js" || true
