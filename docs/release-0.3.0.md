# 0.3.0 — Pi and Claude parity

## Delivered

1. Shared workload profiles with environment precedence and unchanged defaults.
2. Pressure-band hysteresis persisted per session in Pi and Claude adapters.
3. Full Pi `tool_result` handling keyed by `toolCallId`, including errors and typed detail preservation.
4. Pi slash diagnostics and session-scoped profile selection.
5. Exact Pi host-truncation detection from typed details, plus guarded thresholds/markers.
6. Sidecar metadata v2 with runtime, completeness, diagnostic census, and SHA-256 provenance.
7. Trusted adapter relevance metadata with bounded terms and diagnostic context; output prose cannot self-declare relevance.
8. `npm audit --json` and generic diagnostic-block strategies with conservative fallback.
9. Pi compaction instructions and Pi/Claude post-compaction state/epoch reset without history mutation.
10. Metrics-only exact duplicate detection with a bounded per-session SHA-256 ring.
11. Pi narration measurement for autonomous/eval profiles; injection remains evidence-gated.
12. Fixture replay across Claude, Pi, Codex, and OpenCode postures.
13. 1/10 MB throughput guards for repetitive, error-dense, and single-line input.
14. Small-clean-output fast path and a no-growth fallback for marker-heavy diagnostics.
15. PalSync-compatible markers/filenames, v1 metadata normalization, and v2 documentation.
16. Pi ordering, truncation, cache-retention, live metrics, and reproduction guidance.

## Reproduction

```bash
npm test
node bench/run.js --check
node bench/efficiency.js --check
node bench/perf.js --check
```

Live provider cost benchmarks remain manual and post-merge: enable
`~/.trim-metrics.jsonl`, run equivalent Pi/Claude CRUD or PalSync tasks, then
use `node bin/trim-stats.js`. Compare against the prior $1.43 / 40.5K-token /
216.6K-cache-write reference only with the same model, task, and cache posture.

## Risks and guarded limitations

- Profiles are opt-in until live task-success evidence supports new defaults.
- Claude Code currently exposes no supported PreCompact summary-instruction output; only post-compaction cooperation ships there.
- Duplicate replacement, browser-specific parsers, and Pi narration injection remain metrics-gated.
- Sidecars for host-truncated input preserve only what the host delivered and say so explicitly.
