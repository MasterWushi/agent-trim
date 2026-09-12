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

Before the generic steps 5–7, a **structured-strategy layer** checks whether the output is a format it can compress semantically instead of line-by-line: eslint `--format json`, TypeScript compiler diagnostics, jest/vitest, pytest, `go test -v`, `git diff --stat`, JSON-Lines logs, `npm audit --json`, and generic compiler diagnostic blocks. Detection is deliberately conservative — a miss falls through to the generic pipeline, while diagnostic code frames stay attached and only normalized-identical blocks fold. `TRIM_STRATEGIES=off` disables the layer.

Step 7 is failure-aware: a non-zero exit code (or error-looking text when no exit code is available) switches to the generous cap, and a plain `cat somefile` also gets the generous cap since file contents aren't "log noise". Because every error/warning line is kept *by construction*, the omission markers can make a guarantee the model can act on:

```
[trim hook: 745 lines omitted from this view, none with errors/warnings]
```

That wording matters: a bare "745 lines elided" makes the model rationally distrust the gap and re-run the command — which re-sends the whole context and cancels the savings. A marker that (provably) promises no signal was cut removes the reason to re-run. Naming its own provenance ("trim hook") also keeps models from flagging the marker as a prompt injection. If the model does need the missing part, a trailing note tells it to rerun with `TRIM_OFF=1` in front, which passes everything through untouched.

## Runtime cooperation

Claude Code exposes more hook surface than the other harnesses (transcript access, subagent and compaction events), so its install gets three hooks instead of one. Its `PostToolUse` hook has the narrow `^(Bash|Read)$` matcher, so Edit, Grep, Glob, Write, and other tools do not start Trim at all (see [`docs/adapter-overhead.md`](docs/adapter-overhead.md)).

| Hook | What it does |
|---|---|
| Compressor (`PostToolUse`, `^(Bash\|Read)$`) | Everything above, and Read results too — but ONLY for log-shaped files, machine-generated files (lockfiles, minified bundles, `node_modules`), and sidecar re-reads (a bounded `offset`/`limit` read of a sidecar comes back verbatim, not re-elided); source code always passes untouched, so a capped Read can never cut lines the model needs to edit byte-exactly. Plus three transcript-driven carve-outs: a prompt asking for **every/all/each** of something countable disables elision for that turn (a capped view of a completeness task just triggers re-runs); identifiers the prompt names in backticks/quotes always survive the cap; and caps tighten as the session transcript grows past 400KB/1MB (`TRIM_ADAPTIVE=off` to disable). The first visible marker also delivers a once-per-session note over the hook `additionalContext` channel telling the model the `[trim hook: ...]` markers are trusted tooling (`TRIM_NOTE=off` to disable). |
| Subagent brief (`SubagentStart`) | Style files never reach subagents, so spawned workers pad their reports with preamble — which lands in the parent conversation and is re-sent every later turn. Injects one line per spawn: final message is a tool result, findings only. `TRIM_SUBAGENT=off` to disable. |
| Compaction re-arm (`PostCompact`) | Re-arms marker provenance, resets pressure and duplicate state, and increments the compaction epoch. Claude's current PreCompact contract cannot add summary instructions, so no dead hook is installed. |

Pi now advances with Claude on core capabilities: typed error/detail-preserving
result rewrites, log/generated reads, workload profiles, exact host-completeness
metadata, pressure state, compaction instructions/reset, duplicate metrics, and
slash diagnostics. See [`docs/pi.md`](docs/pi.md) for extension order and
commands. Pi narration is measurement-only because its available injection
channels either replace model output or create/queue another turn.

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

## Updating

**One command, from your clone:**

```bash
npm run update
```

That is `git pull --ff-only && npm test && ./install.sh` — pull, prove the suite
still passes, re-wire anything that needs it, then print a drift report. Run it
whenever you want the latest; it is safe to run when already current.

**To check without changing anything:**

```bash
./install.sh --check      # same as: npm run doctor
```

Reports every difference between this repo and what your agents actually run,
writes nothing, and exits non-zero if anything drifted — so you can gate a
script on it. A clean report looks like this:

```
trim doctor — /path/to/agent-trim
  ok    claude         .claude/settings.json points at this repo
  ok    pi             .pi/agent/extensions/trim.ts matches adapters/pi-trim.ts
  ...
everything your agents run matches this repo. `git pull` keeps it that way.
```

### Why a pull is usually enough

Hook commands and every `require` resolve to absolute paths **inside your
clone** — `node /path/to/agent-trim/adapters/claude-posttooluse.js`. Your agents
execute your working tree directly, so one `git pull` updates all four at once.
There is no copy of the compressor anywhere else on disk to go stale.

### The three things a pull cannot fix

| Drift | Why | Fix |
|---|---|---|
| Rendered harness wrappers (`~/.config/opencode/plugins/trim.ts`, `~/.pi/agent/extensions/trim.ts`) | `install.sh` **copies** these, substituting the repo path. Both are kept thin — they `require` their behaviour from `adapters/lib/*-runtime.js` in the repo — so they only change when a host's own plugin API does. | `./install.sh` |
| Style block in `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, … | `append_style` skips any file already carrying the `<!-- trim:style:start -->` marker, so edits to `style/TERSE.md` never reach an existing install. | delete the block, then `./install.sh` |
| Hooks pointing at an **older clone** | Nothing you pull *in this directory* can change a hook that names a different path. | `./install.sh` |

The doctor also flags a harness you installed *after* trim: `install.sh` only
wires directories that exist when it runs, so a newly added agent sits unwired
with no other signal.

### Verifying it is actually working

The doctor compares files. To confirm the running system compresses, enable the
debug log and watch a real call:

```bash
touch ~/.trim-debug        # enable
# ask any agent to run: seq 1 1000
tail ~/.trim-debug         # 2026-07-29T03:35:00.360Z claude 22389 -> 1553
rm ~/.trim-debug           # disable
```

## How it plugs into each agent

One shared compressor (`bin/trim-core.js`), four thin adapters using each agent's official extension point:

| Agent | Hook | How the output gets replaced |
|---|---|---|
| Claude Code | `PostToolUse` hook | returns `updatedToolOutput` JSON |
| Codex CLI | `PostToolUse` hook | exit code 2 + replacement on stderr |
| opencode | plugin `tool.execute.after` | mutates `output.output` |
| pi.dev | extension `tool_result` | returns `content`, preserving `details` and `isError` |

The style file is appended to each agent's global instructions file (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, etc.) inside `<!-- trim:style:start/end -->` markers, so the uninstaller can remove exactly what was added.

## Tuning

Environment variables on the core (defaults in parentheses):

- `TRIM_CAP_PASS` (120) — line cap for passing output
- `TRIM_CAP_FAIL` (300) — line cap for failing output and file dumps; `TRIM_MAX_LINES` still works as a legacy alias
- `TRIM_CAP_ENUMERATE` (2000) — bound on the "report every warning" carve-out (Claude Code only)
- `TRIM_PROFILE` — opt-in workload posture: `interactive-short` (current defaults), `interactive-long`, `autonomous-loop`, `eval`, or `final-verification`; explicit cap variables override it
- `TRIM_KEEP_RE` — regex for which lines count as signal (always survive the cap)
- `TRIM_TEMPLATE=off` — disable same-shaped-line folding; `TRIM_TEMPLATE_MIN_RUN` (5) sets the minimum run length
- `TRIM_SIDECAR=off` — keep huge outputs inline instead of moving them to a file; `TRIM_SIDECAR_MIN` (15000) sets the size threshold, `TRIM_SIDECAR_SHELL_MAX` (28000) the shell-output ceiling above which the harness's own truncation is assumed
- Claude Code extras: `TRIM_ADAPTIVE=off`, `TRIM_NOTE=off`, `TRIM_SUBAGENT=off` — see the table above

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
estimated tokens, breakdowns by strategy/runtime/command, sidecar, bypass,
and exact-duplicate incidence, and possible re-runs after lossy trims (the
canary that a marker failed to earn trust). Every figure is printed with an
evidence label (`[L1-component]`, `[L2-preservation]`, `[L8-trajectory]`, ...)
so a percentage never appears as an unqualified claim — see `docs/palsync.md`.
`--json` consumers, note the 0.4.0 shape change: labelled figures are now
`{ value, evidence }` objects rather than bare numbers (`.bytesSaved` →
`.bytesSaved.value`). The `byStrategy` / `byRuntime` / `byCommand` tables are
unchanged.

Token figures use a deterministic, class-based estimator
(`bin/lib/token-estimate.js`; dense JSON/hashes/stack traces tokenize
differently from English prose, so a flat bytes/4 divisor overstated savings
on exactly the material trimmed hardest) — still not a provider-billed count,
labeled `estimator class/1` in the output.

`node bench/run.js` runs the committed fixture corpus (huge builds, failing
tests, JSONL logs, adversarial prose, injection-shaped text, CRLF/unicode)
and checks that every unique error survives; `--check` gates regressions
against `bench/baseline.json`. Before/after numbers for the strategy layer
are in `bench/before-after.md`.
`node bench/efficiency.js --check` replays the corpus through `compress()`
under each host's option posture (Claude/Pi/Codex/OpenCode) — core compressor
cost, not adapter cost; `node bench/perf.js --check` guards 1/10 MB throughput.
`node bench/adapter.js` (or `npm run bench:adapter`) times the real adapter
entry points — spawned Claude/Codex hook processes and the in-process Pi/
OpenCode handlers — against `compress()` on the same payload, and writes the
results to `docs/adapter-overhead.md`.

If an adapter ever fails, it fails open — the tool output passes through unmodified. Compression never blocks or breaks a tool call.

## Test

```bash
npm test   # core, signal detection, strategies, hooks, adapters, installer, bench gate
```

Live check: enable the debug log, ask any agent to run `seq 1 1000`, and confirm the log shows something like `3893 -> 758`.

## Limitations

- Codex fires tool hooks for shell commands only (not MCP or file tools).
- Step 7 can hide a line the model needed — the signal-preserving cap plus the `TRIM_OFF=1` rerun path cover that case, but it's a real tradeoff.
- Codex and OpenCode remain shell/tool-output only. Pi and Claude also compress log-shaped, generated, and sidecar reads; source reads pass unchanged.
- In Claude Code, a Bash call that exits non-zero may route through a different hook event (`PostToolUseFailure`) that this adapter doesn't watch — failing output there passes through untouched, which is the safe direction (failures keep everything). Claude Code's Bash hook payload carries no exit code at all (`{stdout, stderr, interrupted, isImage}`), so failure detection relies on `interrupted` plus text sniffing.
- Codex CLI hooks can only *replace the whole result with feedback text* (exit 2 + stderr) — structured field-by-field rewriting isn't supported by the runtime yet.
- OpenCode and Pi may truncate output *before* the hook sees it (Pi: 50 KiB/2,000 lines). Host-truncated sidecars are labeled “saved as observed” and never claim completeness.
- Estimated token figures use a deterministic class-based estimator (`bin/lib/token-estimate.js`), never provider-billed counts.

Design rationale and sources: `docs/research.md` (provider caching facts, paper findings), `docs/decisions.md` (rejected proposals and why), `docs/palsync.md` (optional interop contract for embedding tools).

MIT licensed.
