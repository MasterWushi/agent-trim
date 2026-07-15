# agent-trim

Cut your AI coding agent's token bill by cleaning up tool output before the model ever sees it.

Works with **Claude Code**, **Codex CLI**, **opencode**, and **pi.dev**. No dependencies, no background processes, no model calls — just a small deterministic script wired into each agent's hook system.

## The problem

When your coding agent runs a shell command, the full output goes into the model's context. That output is full of stuff the model doesn't need:

- ANSI color codes and terminal escape sequences (`\x1b[31m...`)
- Progress bars that repaint themselves hundreds of times (`10%\r11%\r12%...`)
- The same log line repeated 500 times
- 2,000 lines of build output when only 5 lines matter

Here's the expensive part: that junk doesn't cost you once. Everything in context gets **re-sent to the API on every following turn** of the session. A 4,000-token build log in a 30-turn session costs roughly 4,000 tokens × the remaining turns. Input tokens — not the model's replies — are what dominate an agent bill.

## The fix

agent-trim hooks into the moment *after* a tool runs and *before* the result reaches the model, and applies five cleanups in order:

| Step | What it does | Lossy? |
|---|---|---|
| 1. Strip escape codes | Removes ANSI colors, cursor moves, terminal titles | No |
| 2. Collapse progress bars | `10%\r50%\r100%` becomes just `100%` | No |
| 3. Tidy whitespace | Trailing spaces gone, blank-line runs collapsed | No |
| 4. Fold repeated lines | 3+ identical lines become `line  [trim: line repeated 47x]` | No — count preserved |
| 5. Shorten huge outputs | Past 300 lines: keep the first 120, the last 80, and up to 40 error/warning lines from the middle | Yes — clearly marked |

Step 5 is the only step that drops information, and it tells the model exactly what happened:

```
[trim: 745 lines elided; 3 error/warn lines kept below — rerun with TRIM_OFF=1 for full output]
```

So if the model needs the missing part, it knows to rerun the command with `TRIM_OFF=1` in front, which passes everything through untouched.

Typical result: noisy output (test runners, npm installs, docker builds) shrinks ~80%. Short clean output is left completely alone — if compression would save less than 32 bytes, nothing changes.

There's also an optional style file (`style/TERSE.md`) that tells the agent how to answer — terse writing (drop filler, keep code/errors/numbers exact, no restating the question), plus a stance (have opinions, be resourceful before asking, bring a recommendation when you do ask). That trims the *output* side the same way the hooks trim the *input* side.

## Install

```bash
git clone https://github.com/MasterWushi/agent-trim && cd agent-trim
./install.sh              # compression hooks + terse style
./install.sh --no-style   # hooks only, keep your own style rules
```

Requires Node.js. The installer detects which of the four agents you have, wires the hook into each, and backs up every file it touches into `backup/`. Safe to re-run.

To remove everything:

```bash
./uninstall.sh
```

**Codex users:** the first interactive `codex` run after installing will ask you to trust the new hook — approve it once.

## How it plugs into each agent

One shared compressor (`bin/trim-core.js`), four thin adapters using each agent's official extension point:

| Agent | Hook | How the output gets replaced |
|---|---|---|
| Claude Code | `PostToolUse` hook | returns `updatedToolOutput` JSON |
| Codex CLI | `PostToolUse` hook | exit code 2 + replacement on stderr |
| opencode | plugin `tool.execute.after` | mutates `output.output` |
| pi.dev | extension `tool_result` | returns new `content` |

The style file is appended to each agent's global instructions file (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, etc.) inside `<!-- trim:style:start/end -->` markers, so the uninstaller can remove exactly what was added.

## Tuning

Environment variables on the core (defaults in parentheses):

- `TRIM_MAX_LINES` (300) — output longer than this gets shortened
- `TRIM_HEAD_LINES` (120) / `TRIM_TAIL_LINES` (80) — how much of the start/end to keep
- `TRIM_KEEP_MATCH_MAX` (40) — max error/warning lines rescued from the middle
- `TRIM_KEEP_RE` — regex for which middle lines count as worth keeping

Per-command bypass: prefix the command with `TRIM_OFF=1`.

Debugging: `touch ~/.trim-debug` and every compression appends a `tag inBytes -> outBytes` line there. `rm ~/.trim-debug` to stop.

If an adapter ever fails, it fails open — the tool output passes through unmodified. Compression never blocks or breaks a tool call.

## Test

```bash
node test/core.test.js
```

Live check: enable the debug log, ask any agent to run `seq 1 1000`, and confirm the log shows something like `3893 -> 758`.

## Limitations

- Codex fires tool hooks for shell commands only (not MCP or file tools).
- Step 5 can hide a line the model needed — the marker plus the rescued error lines plus the `TRIM_OFF=1` rerun path cover that case, but it's a real tradeoff.
- Compression applies to shell/tool output, not to file reads the agent does through its native read tools.

MIT licensed.
