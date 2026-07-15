# trim

Deterministic token compressor for AI agent tool output. One small, model-free pipeline that cuts the noise (ANSI codes, progress bars, repeated lines, giant dumps) out of shell output before it hits your model's context — plus an optional 10-line terse-style instruction.

Why it saves real money: agent bills are dominated by input tokens. Every tool output enters context and is re-sent on **every subsequent turn**. Compressing a 4k-token build log once saves 4k × remaining-turns, not 4k.

## Install

```
git clone https://github.com/MasterWushi/agent-trim && cd agent-trim
./install.sh            # hooks + terse style block
./install.sh --no-style # hooks only (you already have style rules)
```

Auto-detects installed harnesses: Claude Code, Codex CLI, opencode, pi.dev. Idempotent; backs up every file it touches into `backup/`. `./uninstall.sh` reverses everything (hooks, plugins, style blocks).

Style injection = marker-fenced block (`<!-- trim:style:start/end -->`) appended to each harness's global instructions file (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md`, `~/.pi/agent/AGENTS.md`). Edit `style/TERSE.md` to taste before installing.

## What it does

`bin/trim-core.js` (stdin→stdout, zero deps), applied to Bash/tool output before the model sees it:

1. Strip ANSI/OSC escape sequences (lossless)
2. Carriage-return progress lines → keep final repaint (lossless)
3. Strip control chars + trailing whitespace, collapse blank runs (lossless)
4. Consecutive duplicate lines ≥3 → `line  [trim: line repeated Nx]`
5. Past 300 lines: keep head 120 + tail 80 + up to 40 error/warn lines from middle, with explicit `[trim: N lines elided …]` marker (lossy, marked)

Style side: `style/TERSE.md` — ~10-line terse-output instruction (caveman replacement).

## Installed adapters

| Harness | Mechanism | Installed at |
|---|---|---|
| Claude Code | PostToolUse hook → `updatedToolOutput` | `~/.claude/settings.json` → `adapters/claude-posttooluse.js` |
| Codex CLI | PostToolUse hook, exit 2 + stderr replacement | `~/.codex/hooks.json` → `adapters/codex-posttooluse.js` |
| opencode | plugin `tool.execute.after` mutates `output.output` | `~/.config/opencode/plugins/trim.ts` |
| pi.dev | extension `tool_result` returns new `content` | `~/.pi/agent/extensions/trim.ts` |

opencode/pi installed files are rendered from `adapters/*.ts` templates (repo path substituted) — re-run `./install.sh` after editing them.

## Escape hatches / config

- Per command: prefix `TRIM_OFF=1 <cmd>` (adapters detect it in the command string and pass output through untouched).
- Env knobs on core: `TRIM_MAX_LINES` (300), `TRIM_HEAD_LINES` (120), `TRIM_TAIL_LINES` (80), `TRIM_KEEP_MATCH_MAX` (40), `TRIM_KEEP_RE`.
- Debug: `touch ~/.trim-debug` → adapters append `tag inBytes -> outBytes` lines there; `rm` to stop.
- Small outputs (savings < 32 bytes) pass through untouched. Adapter failure never blocks the tool (always exit 0 / no-op).

## Test

```
node test/core.test.js
```

Live smoke: `touch ~/.trim-debug`, run harness headless with `seq 1 1000` prompt, check log shows `~3893 -> ~758`.

## Known caveats

- Codex hook needs one-time trust approval on next interactive `codex` run (hash prompt). Headless runs before that: use `--dangerously-bypass-hook-trust` or just approve once interactively.
- Codex Pre/PostToolUse fires for shell tool only (no MCP/file tools).
- Elision is lossy by design; marker + kept error lines + `TRIM_OFF=1` rerun cover the miss case.
