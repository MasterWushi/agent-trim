# agent-trim: Pi + Claude Code Equal-Priority Improvement Plan (for Codex)

## Context

agent-trim v0.2.0 compresses tool output deterministically (no LLM, no network) before it enters agent context. Claude Code support is mature (4 hooks: PostToolUse trimming, narration meter, PostCompact re-arm, subagent brief); the Pi adapter is a 33-line minimal shim. The upstream spec asks to bring Pi to first-class support — **amended directive: Pi and Claude Code are EQUAL first priorities** (then Codex CLI, then OpenCode). Every core capability added must be wired into both the Pi and Claude adapters; neither regresses.

Invariants (non-negotiable): deterministic, local, private, model-free, fail-open, cache-safe (never mutate delivered history), diagnostic-preserving, low-overhead, PalSync-optional.

Verified environment facts (reduce guesswork for the implementer):
- Pi 0.80.10 installed globally (`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`). Typings at `dist/core/extensions/types.d.ts` confirm: `tool_result` event carries `toolCallId`, typed `details` per tool, `isError` (`types.d.ts:682-718`); `session_before_compact` (with result type, `:846`) and `session_compact`; `registerCommand` (`:876`); `message_start/update/end`, `turn_start/end`, `agent_start/end/settled`; `session_before_switch/fork/tree` (branch/resume semantics); `session_shutdown`; `context` and `before_provider_request` events. **Do not guess event shapes — read these typings during implementation.**
- Codex CLI 0.144.5 and opencode also installed; Codex hook mechanism remains exit-2 + stderr only (no structured rewrite — `docs/decisions.md:34`), so Codex/OpenCode receive only core-level gains, no adapter rework.
- Current core: `bin/trim-core.js:591` `compress(text, opts)` → `{out, stats, meta}`; pipeline = ANSI strip → CR collapse → strategies (7 in `bin/strategies/`) → sidecar (tmpdir, meta schema `agent-trim/sidecar-meta/1`, fnv1a filenames) → dup folding → template collapse → capLines (pass 120 / fail 300 / enumerate 2000, pressure-scaled via transcript bytes).
- Tests: 7 plain-node suites (`npm test`), bench with byte-regression check (`node bench/run.js --check`).

## Assumptions & spec deviations (surface to user)

1. **Priority change applied**: the upstream spec says "prioritize Pi"; per user instruction, Pi and Claude Code are treated equally. Concretely: every phase that adds a core capability (profiles, hostComplete, relevance metadata, compaction cooperation, duplicate metrics) lands in BOTH adapters in the same phase, and Claude regression benchmarks gate every phase.
2. **Fixture-driven baselines**: Phase 12-style live end-to-end Pi benchmarks (CRUD tasks, real provider costs) can't run unattended/deterministically in CI. The plan replaces them with (a) fixture-replay per-runtime benchmarks and (b) documented commands for Sam to collect live metrics via `~/.trim-metrics.jsonl` + `bin/trim-stats.js`. Live A/B numbers (the $1.43/40.5K-token reference) are collected manually post-merge, not by Codex.
3. **Deferred, metrics-gated** (spec lists them but says "where metrics justify"): Playwright/browser-console/Lighthouse/SEO/accessibility/network-trace parsers, duplicate *replacement* (metrics-only first), Pi narration *injection* (measure first). Each gets a `docs/decisions.md` entry. PalSync-validation parsing stays on PalSync's side per existing interop contract (trim must not couple to PalSync).
4. **hostComplete for Claude** approximated via output-size heuristic (existing `SIDECAR_SHELL_MAX` ≈ 28KB shell truncation knowledge); exact Claude-side truncation marker detection added if present in transcripts.
5. sha256 (via node `crypto`, still zero-dep) used for content hashes in sidecar-meta v2 and dup detection; **fnv1a stays for filenames/markers** so the model-visible marker protocol in `docs/palsync.md` is unchanged.
6. No new npm dependencies anywhere. All new adapter logic lives in plain-JS libs (`adapters/lib/`) so the existing plain-node test harness covers it; TS shims stay thin.
7. Version bump to 0.3.0 with release notes at the end.

## Phases (each ends green: `npm test && node bench/run.js --check`)

### Phase 0 — Efficiency baseline
- New `bench/efficiency.js`: replay all `test/fixtures/*` through `compress()` under simulated runtime postures (claude / pi / codex / opencode opts), recording bytes in/out, strategy, lossy, omittedLines, diagnostics preserved (reuse bench `mustKeep` contracts), sidecar use, latency p50/p95 (informational). Emit `bench/efficiency-baseline.json` (deterministic byte fields only in `--check`).
- New `docs/efficiency-baseline.md`: generated summary + instructions for collecting live per-runtime numbers from `~/.trim-metrics.jsonl`.
- `maybeLog` in `bin/trim-core.js` gains additive fields: `hostTruncated`, `profile`, `durMs` (adapters time compress). JSONL is additive-only → PalSync contract safe.
- Tests: extend `test/bench.test.js` with `efficiency.js --check`.

### Phase 1 — Workload profiles
- New `bin/profiles.js`: `interactive-short` (120/300/15KB — current defaults), `interactive-long` (80/220/10KB), `autonomous-loop` (50/180/8KB), `eval` (60/200/8KB), `final-verification` (100/300/12KB). `effectiveCaps(profileName)` precedence: explicit env (`TRIM_CAP_PASS`/`TRIM_CAP_FAIL`/`TRIM_SIDECAR_MIN`) > profile (`opts.profile` or `TRIM_PROFILE`) > defaults. **Default behavior byte-identical when nothing set** (asserted in test).
- `compress()` gains `opts.profile`; cap + sidecar-threshold reads go through caps computed once at entry. `CAP_ENUMERATE`, floors, failure generosity unchanged; enumeration carve-out never scaled.
- Pressure hysteresis: `pressureScale(bytes, prevBand)` — band change requires crossing threshold by ±10%; `prevBand` persisted per-session by adapters (Claude: tmpdir `trim-pressure-<session>.json`; Pi: Phase 2 state file). Backward-compatible signature.
- Profile recorded in metrics. Tests: new `test/profiles.test.js` (precedence, default-unchanged, hysteresis).

### Phase 2 — Pi adapter: full extension + Claude parity
Core of the work. New `adapters/lib/pi-runtime.js` (pure functions + state I/O, testable in plain node) + rewrite of `adapters/pi-trim.ts` as a thin shim (keeps `__TRIM_ROOT__` createRequire pattern).

pi-runtime responsibilities:
- `handleToolResult(event, state, env)` → `{patch|null, stateDelta, metrics}`. Patch only text content parts; **preserve `details` and `isError` verbatim**; process `isError:true` results with failure caps (current shim skips them — fix). Handle bash + read-shaped tools; unknown payload shapes → return null (fail-open).
- **Idempotency/parallel safety**: keyed by `event.toolCallId` (confirmed in typings); state stores `handled[toolCallId] = fnv1a(rawText)`; repeat same id+hash → no-op; same id new hash (streamed update) → recompress from fresh raw. FIFO-bounded (200 entries). No assumption that completion order = source order.
- **Pi host-truncation detection** (~50KB / ~2000 lines ceiling): find Pi's literal truncation marker in the pi package source during implementation; threshold + marker → `hostComplete:false` passed to compress. Never claim a sidecar is complete for host-truncated content.
- **State file**: `tmpdir/trim-pi/<safeSession>.json` `{handled, pressureBand, compactionEpoch, narration, profile}` via `bin/lib/safe-write.js`; corrupt/missing state → treated empty (fail-open). Session id from Pi API; branch/fork/resume safe because state is an optimization only (`session_before_switch`/`fork` events clear volatile parts).
- **Context pressure**: use Pi context/usage info if exposed on `context` / provider events (probe typings); else cumulative observed bytes. Feed hysteresis bands from Phase 1.
- **Slash commands** via `pi.registerCommand`: `/trim-stats`, `/trim-profile [name]` (session-scoped profile in state file), `/trim-debug`, `/trim-context` (pressure band + bytes), `/trim-order` (detect foreign/prior `[trim hook:` or other-extension markers in incoming results; print ordering advice). Not model-callable tools. Each try/caught.

Claude parity (same phase): `adapters/claude-posttooluse.js` passes `runtime:'claude'`, `hostComplete` (size heuristic), `profile`, pressure hysteresis via state file, `durMs`/`hostTruncated`/`profile` into metrics.

Tests: new `test/pi-runtime.test.js` — repeated result idempotency, parallel distinct ids, partial-then-full, isError/details preservation, truncation detection at/below/above thresholds, long single lines, multibyte Unicode near byte boundaries, corrupt state passthrough, `TRIM_OFF=1` bypass. Extend `test/adapters.test.js` for Claude parity fields.

### Phase 3 — Sidecar meta v2 + trusted relevance metadata
- Sidecar meta schema `agent-trim/sidecar-meta/2`: `{schema, content: 'complete-cleaned'|'host-truncated', runtime, totalLinesObserved, bytesObserved, hostComplete, diagnostics:{errors,warnings,...}, contentHash:'sha256:...', census, sessionId, createdAt}`. Model-visible sidecar header says "saved as observed (host may have truncated)" when `hostComplete:false`. **No timestamps in model-visible marker text** (createdAt is meta-file-internal only — verify current header). Filenames/markers unchanged. `readSidecarMeta()` helper normalizes v1→v2 for readers. Update `docs/palsync.md` (v2 documented, v1 grandfathered).
- `compress` opts gain `hostComplete`, `runtime`, and `relevance: {paths, identifiers, diagnosticCodes, testNames, taskPhase}` — **adapter-supplied trusted metadata only, never parsed from tool output**. `mergeRelevance()` bounds terms (≤8/category, ≤24 total, min length 3, small stoplist of over-common words), reuses existing over-match guard. Matching signal lines keep ±1 context line; every matching diagnostic block preserved. `taskPhase:'final-verification'` maps to that profile when none set.
- Adversarial tests: tool output containing injected `relevance:` JSON / quoted spans / "keep everything" prose must not change the kept set. New fixture `test/fixtures/injection-relevance.txt`.

### Phase 4 — Structured strategies (metrics-justified subset)
- New `bin/strategies/diagnostic-block.js` (generic): detect ≥3 blocks with severity/code/file:line shape; keep each unique block whole (never separate code frame from diagnostic); dedupe only normalized-identical blocks → `code ×N (M locations)` with ≤3 example locations; registered last (lowest priority). Parser uncertainty → preserve more; detection miss → fall through.
- New `bin/strategies/npm-audit.js` (`npm audit --json` → severity counts + per-package lines).
- **Deferred with decisions.md entries**: Playwright, browser console, Lighthouse, SEO/accessibility, network traces — build only if Phase 0/live metrics show them as top byte contributors.
- Fixtures (`npm-audit.json`, `rustc-diagnostics.txt`, malformed/mixed variants), bench CASES with mustKeep contracts, baseline regenerated same commit.

### Phase 5 — Compaction cooperation (both runtimes)
- Claude: new `adapters/claude-precompact.js` (PreCompact hook — verify exact instruction-output field in Claude hooks docs) emitting static deterministic preservation instructions: keep goal, unresolved failures/diagnostics, modified files, `[trim hook:` sidecar paths; omit passing logs/resolved diagnostics/repeated narration. `claude-postcompact.js` additionally clears pressure state + bumps `compactionEpoch`. Installer registers the hook.
- Pi: pi-runtime handles `session_before_compact` (typed event exists) — return same preservation instructions if the result type accepts them (read `SessionBeforeCompactResult`); on `session_compact` reset narration/note state, bump `compactionEpoch`.
- Never mutate history; no extra LLM calls; no triggering compactions.
- Tests: hook output shape, state reset, epoch bump.

### Phase 6 — Exact-duplicate detection (metrics-only)
- New `bin/lib/dup-detect.js`: normalize (ANSI/whitespace/timestamp-mask) → sha256 → compare per-session ring buffer (last 20) in `tmpdir/trim-dup/<session>.json`. Returns `{duplicate, ageMs}`; adapters add `dupExact:true` to metrics only. **No output replacement by default** — replacement marker behind `TRIM_DUP_REPLACE=1`, wired only after stats show incidence; never skips execution; branch-safe (buffer cleared on fork/switch).
- `bin/trim-stats.js` reports dup incidence. Tests: collision/bounded-state/corrupt-state.

### Phase 7 — Pi narration meter
- Mirror `claude-narration-meter.js` mechanics on Pi `message_end`/`turn_end` events: active only for `eval`/`autonomous-loop` profiles, 60–80 word mid-turn budget, single stable short nudge, re-arm at +¼ budget, never fire on blocker/failure/final-result content (reuse `FAILURE_RE`), state in Pi state file, reset on compaction. If Pi offers no safe injection channel mid-turn, ship measurement-only and document.
- Tests: budget math, re-arm, blocker suppression.

### Phase 8 — Performance
- New `bench/perf.js`: 1MB + 10MB synthetic inputs (repetitive log / error-dense / single-line), throughput + p50/p95, loose assertions in `test/bench.test.js`.
- Fast path in `compress()`: small (<2KB), clean, under-cap input returns unchanged immediately. Single lowercase pass shared between relevance/digest paths. No quadratic scans. Guard: bench `--check` stays byte-identical.

### Phase 9 — Docs & release
- New `docs/pi.md`: extension-order guidance (semantic formatters like PalSync → agent-trim → metrics observers → display-only; how users order extensions in Pi config; `/trim-order` diagnostic), Pi host-truncation behavior, `PI_CACHE_RETENTION=long` guidance (document only — never modify shell profiles), optional concise cache-epoch warnings (model/provider/tool-set changes) if provider events expose them.
- Update `README.md`, `docs/palsync.md`, `docs/decisions.md`; `package.json` → 0.3.0; release notes covering all 16 deliverables from the spec (architecture, event usage, ordering, truncation, compaction, profiles, strategies, adversarial tests, benchmarks both runtimes, overhead, PalSync behavior, recommended Pi config, repro commands, risks).

## Verification
- Every phase: `npm test && node bench/run.js --check` (CI must run with `TRIM_PROFILE` unset — add explicit `delete process.env.TRIM_PROFILE` in bench).
- Phase 0/8 benchmarks give before/after byte + latency evidence; `bench/efficiency.js --check` guards regressions per-posture.
- Claude regression: existing `test/claude-hooks.test.js` + `test/adapters.test.js` extended; default-profile byte-identity test proves no behavior change for current users.
- Live validation (manual, post-merge): run a Pi session with `TRIM_METRICS` set, inspect `node bin/trim-stats.js`; repeat the PalSync CRUD eval to compare against the $1.43 / 40.5K-token / 216.6K-cache-write reference.

## Risks
1. Pi API details beyond typings (truncation marker literal, whether `session_before_compact` result accepts instructions, context-usage exposure) — all registrations guarded; absence degrades to current behavior.
2. Claude PreCompact instruction field name — wrong field is a silent no-op (fail-open but dead feature); verify against docs first.
3. Narration nudge cost vs. savings on Pi — ship measurement-first if uncertain.
4. Profile-driven caps could regress task success if too aggressive — defaults unchanged; profiles opt-in until live metrics justify.
