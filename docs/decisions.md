# Proposals considered and rejected (or deferred)

Each entry records the technical reason; revisit only if the premise changes.

**LLM-summarized tool output** — rejected. Violates the core design (local,
deterministic, free, private); adds latency to every tool call; summaries
can't be trusted not to drop the one line that mattered. Determinism is also
cache-load-bearing (docs/research.md).

**Semantic caching of shell command results** — rejected. A cached result is
valid only under environment-state equivalence, which a hook cannot prove
(TVCACHE lesson, docs/research.md). Stateless, within-one-result compression
only.

**Plan caching (arXiv:2506.14852)** — rejected. Requires model calls at every
cache hit; weakest on heterogeneous coding tasks.

**Dedicated npm/pnpm/docker-build strategies** — rejected for now. Measured on
the corpus: the generic pipeline already hits ratio 0.089 (npm) and 0.050
(docker) because these logs are exactly the shape template-collapse handles.
A parser would add detection risk for ~no gain (bench/before-after.md).

**Cargo/rustc and generic "file:line" strategies** — deferred. rustc's
multi-line diagnostic blocks (error header + source span + help) need a real
block parser to compress without cutting remediation text; the generic
fail-cap already keeps every `error[E...]`/`warning:` line. Revisit with real
fixtures from a Rust project.

**tsc --pretty parsing** — deferred. After ANSI stripping, pretty output
interleaves code frames with diagnostics; a wrong merge could detach a frame
from its error. Non-pretty format is handled; pretty falls through to the
generic signal-preserving cap.

**Codex structured output rewrite** — blocked by the runtime. Codex hooks
support only feedback-replacement (exit 2 + stderr); `updatedMCPToolOutput`
is parsed but unsupported today. The adapter uses the supported protocol and
should be revisited when Codex ships structured replacement.

**pi MCP coverage** — blocked: not documented; the adapter stays scoped to
`bash` results.

**Per-provider cache-breakpoint management** — rejected. Agent Trim reduces
bytes; it does not and must not claim to control provider caching. Harnesses
own their breakpoints.

**Retroactive re-trimming of older turns** (e.g. on context pressure) —
rejected. Mutating history behind the current prefix invalidates the provider
cache and forces a full-context recompute; worse than the bytes it saves
(docs/research.md).

**Trimming the Claude Code `PostToolUseFailure` path** — deferred
deliberately. Failing output passes through untouched there, which is the
safe direction (failures keep everything); wiring it would mostly add risk.
