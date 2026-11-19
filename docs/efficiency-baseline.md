# Efficiency baseline

Fixture replay through each runtime posture. Latency is informational; committed byte fields are deterministic.
Sidecars are disabled for portable paths, while sidecar behavior is covered by core and adapter tests.
These rows measure the core compressor under each host's option posture, not adapter cost; `docs/adapter-overhead.md` covers adapter cost.

| runtime posture | fixtures | input bytes | output bytes | ratio |
|---|---:|---:|---:|---:|
| claude | 25 | 339934 | 69308 | 0.204 |
| pi | 25 | 339934 | 69308 | 0.204 |
| codex | 25 | 339934 | 69308 | 0.204 |
| opencode | 25 | 339934 | 69308 | 0.204 |

Live collection:

```bash
touch ~/.trim-metrics.jsonl
node bin/trim-stats.js
```

Run equivalent Pi and Claude tasks with the same profile and compare `byPosture`; token values remain estimates unless provider telemetry is collected separately.
