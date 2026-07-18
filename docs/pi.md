# Pi extension

Pi 0.80.10 is a first-class runtime. The installed extension handles `bash`
and log/generated/sidecar-shaped `read` results, including `isError: true`,
while preserving typed `details` and `isError` verbatim. Unknown shapes pass
through.

## Extension order

Order extensions by semantics:

1. semantic formatters such as PalSync
2. agent-trim
3. metrics observers
4. display-only extensions

Pi loads extension paths in configured order. Put the generated
`~/.pi/agent/extensions/trim.ts` after semantic summarizers. `/trim-order`
reports whether incoming results already contain trim/foreign markers and
prints this recommendation; it never becomes a model-callable tool.

## Commands

- `/trim-stats` — handled-result count, observed bytes, pressure, compaction epoch
- `/trim-profile [name]` — session profile or default when blank
- `/trim-debug` — state-file path
- `/trim-context` — pressure band and observed bytes
- `/trim-order` — ordering diagnostic

Profiles: `interactive-short`, `interactive-long`, `autonomous-loop`, `eval`,
and `final-verification`. They are opt-in; unset behavior keeps 0.2 caps.

## Truncation and compaction

Pi truncates at 50 KiB or 2,000 lines. Agent Trim reads structured
`details.truncated`, `details.truncation`, and `fullOutputPath`, with guarded
threshold/marker fallbacks. A sidecar created from incomplete host input says
“saved as observed (host may have truncated)” and records
`hostComplete:false`; it never claims to hold the full result.

Before compaction, Pi's mutable `customInstructions` receives the deterministic
preservation brief. After compaction, narration/pressure state resets and the
epoch increments. Switch/fork events clear volatile optimization state; no
history is mutated.

Pi has no safe zero-turn-cost mid-turn narration injection channel. Under
`eval` and `autonomous-loop`, the 70-word meter records crossings only. This is
intentional until metrics justify another mechanism.

For long sessions, consider `PI_CACHE_RETENTION=long` in your own launch
environment. Agent Trim never edits shell profiles and does not claim control
over provider cache epochs. Model/provider/tool-set changes may break cache
reuse; compare live runs rather than inferring savings from byte estimates.

## Live measurement

```bash
touch ~/.trim-metrics.jsonl
# run representative Pi tasks
node bin/trim-stats.js
```

Repeat with the same tasks/profile in Claude Code. Fixture replay is available
through `node bench/efficiency.js --check`; provider cost/cache-write numbers
must be collected manually.
