# Efficiency baseline

Fixture replay through each runtime posture. Latency is informational; committed byte fields are deterministic.
Sidecars are disabled for portable paths, while sidecar behavior is covered by core and adapter tests.

| runtime | fixtures | input bytes | output bytes | ratio |
|---|---:|---:|---:|---:|
| claude | 23 | 337392 | 66766 | 0.198 |
| pi | 23 | 337392 | 66766 | 0.198 |
| codex | 23 | 337392 | 66766 | 0.198 |
| opencode | 23 | 337392 | 66766 | 0.198 |

Live collection:

```bash
touch ~/.trim-metrics.jsonl
node bin/trim-stats.js
```

Run equivalent Pi and Claude tasks with the same profile and compare `byRuntime`; token values remain estimates unless provider telemetry is collected separately.
