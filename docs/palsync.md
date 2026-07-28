# PalSync interoperability contract (optional)

Agent Trim works standalone; nothing here is required for normal operation.
This document pins the small, stable surfaces another tool (PalSync or
anything else) can build on without coupling the two codebases.

## 1. Library API

Zero-dependency CommonJS; call it in-process instead of shelling out:

```js
const { compress } = require('agent-trim'); // main = bin/trim-core.js

const { out, stats, meta } = compress(rawText, {
  exitCode: 1,             // optional; failure is sniffed from text otherwise
  command: 'npx vitest',   // optional; enables structured-format detection context
  sessionId: 'abc123',     // optional; prefixes sidecar filenames
  noSidecar: true,         // set when you don't want files written
});
```

Stability promise: `out` (string), `stats` (`{inBytes, outBytes}` or null) and
the `meta` fields below are the public contract. New `meta` fields may be
added; existing ones won't change meaning.

## 2. The trimming result contract (`meta`)

```jsonc
{
  "changed": true,
  "strategy": "jest-vitest",   // "generic" | "sidecar" | a strategy name
  "inputBytes": 48291,
  "outputBytes": 2714,
  "inputLines": 1302,
  "outputLines": 71,
  "lossy": true,               // false = fully reconstructible cleanup only
  "preservedErrors": 4,
  "preservedWarnings": 2,
  "omittedLines": 1231,
  "sidecarPath": "/tmp/trim-sidecar/abc123-9f3a1c2e.txt", // or null
  "hostComplete": true,
  "runtime": "pi",
  "profile": "interactive-long",
  "reason": "passing tests collapsed by suite; failures kept verbatim"
}
```

PalSync can report its own pipeline as `raw → after PalSync native
summarization → after Agent Trim` by calling `compress()` on its already-
summarized text and combining its own byte counts with `meta`.

## 3. Metrics log passthrough

With metrics enabled (`TRIM_METRICS=/path` or `touch ~/.trim-metrics.jsonl`),
`maybeLog(tag, stats, meta, extra)` appends one JSON line per compression.
A caller may attach an opaque block that is stored verbatim under `palsync`,
matching the three fields PalSync ships in `.palsync.usage.json` v2 —
`rawBytes`, `returnedBytes`, `trimmedBytes`:

```js
maybeLog('palsync', stats, meta, {
  command: 'palsync validate',
  palsync: { rawBytes: 120000, returnedBytes: 61000, trimmedBytes: 48000, cacheHit: false },
});
```

Agent Trim is the only party that can populate `trimmedBytes` — PalSync's own
interop doc states it never fabricates that field; it is "Agent Trim-owned
bytes after downstream trimming; not observed or stored by PalSync."

Everything stays local; there is no network path anywhere in Agent Trim.

## Who owns condensation

> Whoever owns the condensation contract owns the evidence guarantee. If a
> tool result is already a digest, compressing it is compressing a summary.
> Agent Trim's guarantee — every error/warning line survives by construction
> — holds only over raw output. It does not transfer to another tool's digest.
> Agent Trim therefore passes already-condensed results through untouched
> (T2) and never adds a second omission marker.

Two environment variables implement this:

- `TRIM_KEEP_LAST_RE` — an additional regex (alongside the built-in
  `^Full result: .+$`) whose match on the input's last non-empty line is
  preserved as the literal last line of output, even after any marker Agent
  Trim appends.
- `TRIM_CONDENSED_PASSTHROUGH` — set to `off` to disable the already-condensed
  passthrough and force normal compression (default: passthrough is active).

## Coexistence (verified 2026-07-28)

- Agent Trim installs into `~/.claude/settings.json` (user scope), events
  `PostToolUse`, `SubagentStart`, `PostCompact`.
- PalSync installs into `<workspace>/.claude/settings.json` (project scope),
  event `Stop` only, additively and idempotently.
- Claude Code **merges** `hooks` across settings scopes rather than
  overriding — unlike most settings keys, which follow
  managed > CLI > local > project > user precedence. Both hook sets are live
  simultaneously. Command hooks are deduplicated by command string.
  Source: [Claude Code hooks reference](https://code.claude.com/docs/en/hooks).
  This is load-bearing: under override semantics, PalSync's project-scope
  write would silently disable Agent Trim inside every PalSync workspace.
- On Pi, Agent Trim's `tool_result` handler is scoped to `bash` results;
  PalSync registers its own tools via `src/mcp/registerPi.js`. They compose.

## 4. Sidecar metadata companion

Every sidecar `X.txt` gets an `X.meta.json` (schema id
`agent-trim/sidecar-meta/2`):

```jsonc
{
  "schema": "agent-trim/sidecar-meta/2",
  "content": "complete-cleaned", // or "host-truncated"
  "runtime": "pi",
  "totalLinesObserved": 1302,
  "bytesObserved": 48291,
  "hostComplete": true,
  "diagnostics": { "errors": 2, "warnings": 3 },
  "contentHash": "sha256:...",
  "census": "2 errors, 3 warnings",
  "sessionId": "abc123",
  "createdAt": "2026-07-16T21:00:00.000Z"
}
```

Readers should call `readSidecarMeta(path)`; it normalizes legacy v1 companions
into the v2 shape. V1 remains grandfathered. Content filenames and visible
markers continue using FNV-1a, preserving the stable PalSync marker protocol;
SHA-256 is used only for v2 provenance and duplicate metrics.

Sidecars are content-addressed (`<session>-<fnv1a(content)>.txt`) in
`os.tmpdir()/trim-sidecar/`, written atomically with 0600 permissions, and
swept after `TRIM_SIDECAR_TTL_HOURS` (default 72). They never live inside a
project directory, so they cannot leak into Git.

## 5. Marker protocol

Every model-visible annotation Agent Trim adds starts with the literal prefix
`[trim hook:` and is a single bracketed line. That prefix is stable and safe
to pattern-match; nothing else in the output is ever rewritten (lines are only
removed or kept verbatim). A downstream tool can therefore detect "this result
was trimmed" from the text alone.

## 6. Environment variables

The full list is in the README; the ones relevant to embedding:
`TRIM_OFF=1` (bypass), `TRIM_STRATEGIES=off`, `TRIM_SIDECAR=off`,
`TRIM_METRICS=<path>`, `TRIM_KEEP_RE=<regex>`, `TRIM_PROFILE=<name>`.

## Explicitly out of scope

- Agent Trim never calls PalSync, imports it, or detects its presence.
- No result caching: a cached tool result is only valid when the environment
  state it observed is unchanged, which Agent Trim cannot prove (see
  docs/research.md, TVCACHE). PalSync owns any caching decisions and can
  record them via the `palsync.cacheHit` passthrough.
