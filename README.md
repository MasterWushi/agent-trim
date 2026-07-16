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

agent-trim hooks into the moment *after* a tool runs and *before* the result reaches the model, and applies seven cleanups in order:

| Step | What it does | Lossy? |
|---|---|---|
| 1. Strip escape codes | Removes ANSI colors, cursor moves, terminal titles | No |
| 2. Collapse progress bars | `10%\r50%\r100%` becomes just `100%` | No |
| 3. Tidy whitespace | Trailing spaces gone, blank-line runs collapsed | No |
| 4. Fold repeated lines | 3+ identical lines become `line  [trim hook: line repeated 47x]` | No — count preserved |
| 5. Fold same-shaped lines | 5+ log lines with the same shape but varying values (`INFO worker job 8841` ×500) become one example + a count | Mostly — one exemplar kept, count preserved |
| 6. Sidecar huge outputs | Past ~15KB, the full cleaned text goes to a local file (`$TMPDIR/trim-sidecar/`) and a line-numbered digest takes its place in context: head, tail, every error/warning line with its real `L<n>` number and a categorical census ("2 errors, 3 warnings"), so a follow-up can read just the needed range. Shell outputs past ~28KB skip this (the harness may have already truncated them) | No — full text one read away |
| 7. Shorten what remains | Cap by line count — **120 lines for passing output, 300 for failing output** (failure = evidence, keep more). Every error/warning line survives the cap wherever it sits; only surrounding noise is cut | Yes — clearly marked |

Before the generic steps 5–7, a **structured-strategy layer** checks whether the output is a format it can compress semantically instead of line-by-line: eslint `--format json`, TypeScript compiler diagnostics, jest/vitest, pytest, `go test -v`, `git diff --stat`, and JSON-Lines logs. Detection is deliberately conservative — a miss falls through to the generic pipeline, a match keeps **every unique diagnostic, failure, assertion diff, and stack trace verbatim** and collapses only passing/routine noise (passing tests by suite, info-level log records by level, diffstat histogram bars). Measured on the committed corpus this took eslint JSON from 8.3KB to 0.6KB and a 40KB JSONL log to 2KB — cases the generic compressor couldn't touch without hiding signal (`bench/before-after.md`). `TRIM_STRATEGIES=off` disables the layer.

Step 7 is failure-aware: a non-zero exit code (or error-looking text when no exit code is available) switches to the generous cap, and a plain `cat somefile` also gets the generous cap since file contents aren't "log noise". Because every error/warning line is kept *by construction*, the omission markers can make a guarantee the model can act on:

```
[trim hook: 745 lines omitted from this view, none with errors/warnings]
```

That wording matters: a bare "745 lines elided" makes the model rationally distrust the gap and re-run the command — which re-sends the whole context and cancels the savings. A marker that (provably) promises no signal was cut removes the reason to re-run. Naming its own provenance ("trim hook") also keeps models from flagging the marker as a prompt injection. If the model does need the missing part, a trailing note tells it to rerun with `TRIM_OFF=1` in front, which passes everything through untouched.

## Claude Code extras

Claude Code exposes more hook surface than the other harnesses (transcript access, subagent and compaction events), so its install gets four hooks instead of one:

| Hook | What it does |
|---|---|
| Compressor (`PostToolUse`, Bash + Read) | Everything above, and Read results too — but ONLY for log-shaped files, machine-generated files (lockfiles, minified bundles, `node_modules`), and sidecar re-reads; source code always passes untouched, so a capped Read can never cut lines the model needs to edit byte-exactly. Plus three transcript-driven carve-outs: a prompt asking for **every/all/each** of something countable disables elision for that turn (a capped view of a completeness task just triggers re-runs); identifiers the prompt names in backticks/quotes always survive the cap; and caps tighten as the session transcript grows past 400KB/1MB (`TRIM_ADAPTIVE=off` to disable). The first visible marker also delivers a once-per-session note over the hook `additionalContext` channel telling the model the `[trim hook: ...]` markers are trusted tooling (`TRIM_NOTE=off` to disable). |
| Narration meter (`PostToolUse`, all tools) | Counts words of mid-turn narration (text the model emits between tool calls — billed as output, then re-billed as input every following turn, and nobody reads it). Past 120 words (`TRIM_NARRATION_BUDGET`) it injects one corrective line; re-arms only if narration keeps growing. Costs zero tokens while the agent behaves. `TRIM_NARRATION=off` to disable. |
| Subagent brief (`SubagentStart`) | Style files never reach subagents, so spawned workers pad their reports with preamble — which lands in the parent conversation and is re-sent every later turn. Injects one line per spawn: final message is a tool result, findings only. `TRIM_SUBAGENT=off` to disable. |
| Compaction re-arm (`PostCompact`) | Compaction summarizes the marker-provenance note away while its once-per-session guard still says "delivered"; this re-arms it (and resets the meter's stale turn state). Emits nothing itself. |

These are ported from [hush](https://github.com/V-Songbird/hush) (MIT), which measured the design choices — including the ones that look odd, like the meter never firing at Stop (a Stop-time correction forces an extra model turn that degenerates into a stray acknowledgment).

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

- `TRIM_CAP_PASS` (120) — line cap for passing output
- `TRIM_CAP_FAIL` (300) — line cap for failing output and file dumps; `TRIM_MAX_LINES` still works as a legacy alias
- `TRIM_CAP_ENUMERATE` (2000) — bound on the "report every warning" carve-out (Claude Code only)
- `TRIM_KEEP_RE` — regex for which lines count as signal (always survive the cap)
- `TRIM_TEMPLATE=off` — disable same-shaped-line folding; `TRIM_TEMPLATE_MIN_RUN` (5) sets the minimum run length
- `TRIM_SIDECAR=off` — keep huge outputs inline instead of moving them to a file; `TRIM_SIDECAR_MIN` (15000) sets the size threshold, `TRIM_SIDECAR_SHELL_MAX` (28000) the shell-output ceiling above which the harness's own truncation is assumed
- Claude Code extras: `TRIM_ADAPTIVE=off`, `TRIM_NOTE=off`, `TRIM_NARRATION=off`, `TRIM_NARRATION_BUDGET` (120), `TRIM_SUBAGENT=off` — see the table above

- `TRIM_STRATEGIES=off` — disable the structured-format layer (eslint/tsc/test-runners/diffstat/JSONL)
- `TRIM_SIDECAR_TTL_HOURS` (72) — sidecar retention before best-effort sweep
- `TRIM_METRICS=/path` — structured metrics log (see below)

Per-command bypass: prefix the command with `TRIM_OFF=1`.

Debugging: `touch ~/.trim-debug` and every compression appends a `tag inBytes -> outBytes` line there. `rm ~/.trim-debug` to stop.

## Measuring what it saves

Opt-in, local-only metrics: `touch ~/.trim-metrics.jsonl` (or set
`TRIM_METRICS=/path`) and every compression appends one JSON line with the
full result contract — strategy, bytes/lines in and out, lossy flag, preserved
error/warning counts, sidecar use — plus a command *fingerprint* (first word +
hash; the command text itself is never logged, so secrets in arguments can't
leak). Nothing ever leaves the machine.

Summarize with:

```bash
node bin/trim-stats.js          # or: npm run stats
```

which reports calls processed/changed, bytes saved, compression ratio,
estimated tokens (clearly labeled bytes/4 **estimates** — real provider token
counts aren't visible from a hook), breakdowns by strategy/runtime/command,
sidecar and bypass counts, and possible re-runs after lossy trims (the
canary that a marker failed to earn trust).

`node bench/run.js` runs the committed fixture corpus (huge builds, failing
tests, JSONL logs, adversarial prose, injection-shaped text, CRLF/unicode)
and checks that every unique error survives; `--check` gates regressions
against `bench/baseline.json`. Before/after numbers for the strategy layer
are in `bench/before-after.md`.

If an adapter ever fails, it fails open — the tool output passes through unmodified. Compression never blocks or breaks a tool call.

## Test

```bash
npm test   # core, signal detection, strategies, hooks, adapters, installer, bench gate
```

Live check: enable the debug log, ask any agent to run `seq 1 1000`, and confirm the log shows something like `3893 -> 758`.

## Limitations

- Codex fires tool hooks for shell commands only (not MCP or file tools).
- Step 7 can hide a line the model needed — the signal-preserving cap plus the `TRIM_OFF=1` rerun path cover that case, but it's a real tradeoff.
- On Codex/opencode/pi.dev, compression applies to shell/tool output only, not to native file reads (their hook surfaces don't expose Read results); Claude Code gets Read compression for logs, lockfiles, and generated files.
- In Claude Code, a Bash call that exits non-zero may route through a different hook event (`PostToolUseFailure`) that this adapter doesn't watch — failing output there passes through untouched, which is the safe direction (failures keep everything). Claude Code's Bash hook payload carries no exit code at all (`{stdout, stderr, interrupted, isImage}`), so failure detection relies on `interrupted` plus text sniffing.
- Codex CLI hooks can only *replace the whole result with feedback text* (exit 2 + stderr) — structured field-by-field rewriting isn't supported by the runtime yet.
- opencode and pi truncate output *before* the hook sees it (pi: 50KB/2,000 lines); trim compresses what remains.
- Estimated token figures are byte-based approximations, never provider-billed counts.

Design rationale and sources: `docs/research.md` (provider caching facts, paper findings), `docs/decisions.md` (rejected proposals and why), `docs/palsync.md` (optional interop contract for embedding tools).

MIT licensed.
