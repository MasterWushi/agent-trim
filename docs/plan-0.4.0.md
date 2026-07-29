# Agent Trim `0.4.0` — implementation specification

Derived from [`docs/improvement-plan-audit.md`](./improvement-plan-audit.md).
Written to be executed task-by-task without further design decisions.

**Read this whole section before starting.**

---

## Rules for the implementer

1. **Do the tasks in numerical order.** T1–T4 are independent; T5 must precede
   T6; T7 must precede any change to default behaviour. Do not reorder.
2. **After every task, run `npm test`.** It must pass before you start the
   next task. If it fails, fix that task — do not proceed.
3. **One commit per task**, Conventional Commits, subject ≤50 chars. Do not
   bundle. Do not push. Do not commit unless the user asks.
4. **Fail open, always.** Every new code path must be wrapped so that any
   throw results in the original, untouched output being returned. There is no
   acceptable failure mode where a hook error changes a tool result.
5. **Zero new dependencies.** `package.json` `dependencies` must stay absent.
   CommonJS only. Node built-ins only.
6. **Do not touch these** unless a task explicitly says to:
   - the `[trim hook:` marker prefix (frozen protocol surface)
   - FNV-1a sidecar filenames (`cheapHash`) — frozen for PalSync
   - `sidecar-meta` schema version (stays `2`; add fields, never renumber)
   - the `^(Bash|Read)$` matcher default in `adapters/merge-hooks.js`
   - anything in `bin/strategies/`
7. **No new files outside** `bin/lib/`, `test/`, `docs/`.
8. **Stop and ask** if: a task's acceptance test cannot be made to pass
   without changing behaviour the task did not mention; two tasks appear to
   need the same code changed in incompatible ways; or you find an existing
   test that contradicts a task. Do not guess.

### Vocabulary

- **model-visible** — text that ends up in the returned tool result.
- **observe-only** — writes metrics, returns output byte-identical to input.
- **chokepoint** — the single place in `compress()` where every path
  (generic, strategy, sidecar) converges before returning.

---

## T1 — Protected trailer must remain the last line

**Why:** PalSync's published contract
(`palsync/docs/agent-trim-interop.md`) requires that a diagnostic-bearing
result still *ends with* a line matching `^Full result: .+$`. Agent Trim
appends its own note after capped output
(`bin/trim-core.js:834`), so retaining the line is not enough — it must be
re-emitted last.

**File:** `bin/trim-core.js`

**Step 1.** Add near the other regex constants at the top of the file:

```js
// A trailing line another tool has declared load-bearing (e.g. PalSync's
// `Full result: <path>` artifact pointer). If the input's last non-empty
// line matches, the same line must be the last line we return — after any
// marker we add. Retention alone is not enough: the contract is "ends with".
const KEEP_LAST_RE = (() => {
  const custom = process.env.TRIM_KEEP_LAST_RE;
  const base = '^Full result: .+$';
  try {
    return new RegExp(custom ? `(?:${base})|(?:${custom})` : base);
  } catch {
    return new RegExp(base); // invalid user regex must never disable the default
  }
})();

function protectedTrailer(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    return KEEP_LAST_RE.test(lines[i]) ? lines[i] : null;
  }
  return null;
}
```

**Step 2.** `compress()` does **not** have a single `return` statement to patch.
It has something better: a `done(out, extra)` closure defined at
`bin/trim-core.js:711` that every path — generic, strategy, and sidecar —
calls to build its `{ out, stats, meta }` result. That closure is the
chokepoint. Modify `done` itself; do not chase individual return sites.

Capture the trailer from the **input**, before any transformation:

```js
// in compress(), immediately before `const done = (out, extra) => ...`
const trailer = protectedTrailer(text);
```

Then rewrite `done` to re-apply it:

```js
const done = (out, extra) => {
  if (trailer && out !== text) {
    const kept = out.split('\n').filter((l) => l.trim());
    if (kept[kept.length - 1] !== trailer) {
      out = out.replace(new RegExp(`\\n?${escapeRe(trailer)}\\s*$`), '');
      out = out.replace(/\n+$/, '') + '\n' + trailer;
    }
  }
  return {
    out,
    stats: { inBytes, outBytes: Buffer.byteLength(out) },
    meta: buildMeta(text, out, o, { inputLines, ...extra }),
  };
};
```

Note `stats` and `meta` are computed *after* the trailer is restored, so the
reported byte counts stay truthful. `out` is a parameter, so reassigning it is
safe and local.

Add `escapeRe` if the file does not already have it:

```js
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
```

**Step 3.** Export `protectedTrailer` and `KEEP_LAST_RE` from
`module.exports` so tests can reach them.

**Acceptance tests** — add to `test/core.test.js`:

| Assertion |
|---|
| Input whose last line is `Full result: .palsync/artifacts/ab12.json`, large enough to be capped → returned output's last non-empty line is exactly that line |
| Same input → the `[trim hook: output shortened…]` marker is still present, positioned **before** the trailer |
| Input with no matching trailer → output byte-identical to current behaviour (regression guard) |
| Trailer present but `out === text` (nothing changed) → output byte-identical, no duplicate trailer appended |
| Trailer appears twice in input → output ends with exactly one copy |
| `TRIM_KEEP_LAST_RE='^CUSTOM: .+$'` → both the custom pattern and `Full result:` are honoured |
| `TRIM_KEEP_LAST_RE='([unclosed'` (invalid regex) → does not throw; `Full result:` still protected |
| Input where the trailer is the *only* line → unchanged |

**Verify:** `npm test`
**Stop condition:** if protecting the trailer requires changing
`capLines()` internals, stop — the chokepoint approach is deliberate, because
it covers the strategy and sidecar paths too.

---

## T2 — Do not stack a marker on someone else's digest

**Why:** the same contract sets `noDoubleOmissionMarkers: true`. A result
that is already a condensed digest must pass through. Agent Trim's safety
argument ("every error line survives by construction") is only true over raw
output; it does not transfer to a summary someone else produced.

**File:** `bin/trim-core.js`

**Step 1.** Add:

```js
// Results that are already a digest produced by another tool. Compressing a
// summary risks cutting the only surviving copy of evidence, and our
// completeness marker would be a claim about someone else's elision, not
// ours. Pass through, record it, do nothing.
function alreadyCondensed(text) {
  if (process.env.TRIM_CONDENSED_PASSTHROUGH === 'off') return false;
  if (protectedTrailer(text)) return true;          // artifact-pointer trailer
  if (/^\[[a-z][\w-]* (hook|digest):/m.test(text)) return true; // foreign marker
  return false;
}
```

**Step 2.** There is **no `TRIM_OFF` check inside `compress()`** — the only one
in this file is at line 939, in the `require.main` CLI block, and the adapters
each check it themselves. So place the passthrough at the top of `compress()`,
immediately after the existing `if (!text) return { out: text, stats: null,
meta: null };` guard:

```js
if (alreadyCondensed(text)) {
  return {
    out: text,
    stats: { inBytes: Buffer.byteLength(text), outBytes: Buffer.byteLength(text) },
    meta: buildMeta(text, text, o, {
      inputLines: text.split('\n').length,
      strategy: 'passthrough-condensed',
      reason: 'already condensed by another tool; not ours to re-elide',
    }),
  };
}
```

This sits before `done` is defined, which is fine — the trailer logic in T1 is
irrelevant on a path that returns the input verbatim.

**Ordering note:** `const o = { ...(opts || {}) }` must already have run, since
`buildMeta` needs `o`. Insert after that line, not before it.

**Important:** this must return the *unmodified* input. It is not a cap of
zero; it is a bypass.

**Acceptance tests** — `test/core.test.js`:

| Assertion |
|---|
| 40KB input ending in `Full result: …` → output byte-identical to input |
| Same → `meta.strategy === 'passthrough-condensed'`, `meta.changed === false`, `meta.lossy === false` |
| Same → no sidecar file is created |
| Input containing a foreign marker line `[palsync digest: 12 grouped]` → passthrough |
| Input containing **our own** `[trim hook: …]` (a sidecar re-read) → **not** treated as foreign; existing behaviour preserved |
| `TRIM_CONDENSED_PASSTHROUGH=off` → normal compression resumes |

**Note the interaction with T1:** once T2 lands, a PalSync envelope never
reaches the cap, so T1 becomes a defence-in-depth guarantee rather than the
primary mechanism. Keep both — T1 also covers non-PalSync tools that set
`TRIM_KEEP_LAST_RE` without being digests.

**Verify:** `npm test`

---

## T3 — Stop `merge-hooks.js` replacing third-party hooks

**Why:** `adapters/merge-hooks.js:57-62` uses a legacy fallback idempotency
key that matches *any* hook whose command string contains `/adapters/` on the
same event with the same matcher. A third-party tool installing from a path
containing `/adapters/` gets silently replaced instead of coexisting.

**File:** `adapters/merge-hooks.js`

**Change:** constrain both branches of the `findIndex` predicate to commands
under Agent Trim's own `ROOT`:

```js
const mine = (h) => JSON.stringify(h).includes(ROOT + '/adapters/');
const idx = list.findIndex(
  (h) =>
    JSON.stringify(h).includes(ROOT + '/adapters/' + name) ||
    (mine(h) && (h.matcher || '') === (entry.matcher || ''))
);
```

**Acceptance tests** — add `test/merge-hooks.test.js` (new file; register it
in `package.json` `scripts.test`):

| Assertion |
|---|
| Settings containing a foreign hook `node /opt/other/adapters/thing.js` on `PostToolUse` with matcher `^(Bash\|Read)$` → after merge, the foreign hook is **still present** |
| Same → trim's hook is also present (both coexist) |
| Running the merge twice → trim's entry appears exactly once (idempotency preserved) |
| A legacy trim entry under the real `ROOT` with an old filename → still replaced in place, not duplicated |
| Unrelated top-level keys (`permissions`, `env`, `hooks.Stop`) → preserved byte-for-byte |

The last assertion is the PalSync coexistence guard: PalSync writes
`hooks.Stop` in project settings, and nothing we do may disturb a `Stop` array
if one is present in the file we edit.

**Verify:** `npm test`

---

## T4 — Correct and extend `docs/palsync.md`

**Why:** our documented field names diverged from what PalSync ships, and two
load-bearing host facts are currently unstated assumptions.

**File:** `docs/palsync.md`. Documentation only — no code.

**Step 1 — fix the field names.** Section 3 currently documents
`palsync: { rawBytes, nativeBytes, cacheHit }`. PalSync ships `rawBytes`,
`returnedBytes`, `trimmedBytes` in `.palsync.usage.json` v2. Replace
`nativeBytes` with `returnedBytes`, add `trimmedBytes`, and state that Agent
Trim is the only party that can populate `trimmedBytes` (PalSync's own doc
says it never fabricates it).

**Step 2 — add a section: "Who owns condensation".** State the principle
verbatim:

> Whoever owns the condensation contract owns the evidence guarantee. If a
> tool result is already a digest, compressing it is compressing a summary.
> Agent Trim's guarantee — every error/warning line survives by construction
> — holds only over raw output. It does not transfer to another tool's digest.
> Agent Trim therefore passes already-condensed results through untouched
> (T2) and never adds a second omission marker.

Document `TRIM_CONDENSED_PASSTHROUGH` and `TRIM_KEEP_LAST_RE`.

**Step 3 — add a section: "Coexistence (verified 2026-07-28)".**

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

**Step 4.** Add the same hook-merge fact as a row or note in the
hook-surface table in `docs/research.md`, dated.

**Verify:** `npm test` (should be unaffected); confirm no other doc still says
`nativeBytes`: `rg -n 'nativeBytes' docs/ README.md` returns nothing.

---

## T5 — Class-based token estimator

**Why:** `bytes/4` systematically overstates savings on dense output (JSON,
hashes, stack traces) — exactly the material we compress hardest. Every
figure in `trim-stats` currently rests on it.

**New file:** `bin/lib/token-estimate.js`

```js
'use strict';
// Deterministic, dependency-free token estimate. NOT a provider token count —
// it exists so the net-win gate and the stats report stop treating dense JSON
// and English prose as if they tokenize at the same rate. Classify, then
// divide by a per-class chars-per-token divisor.

const DIVISORS = { dense: 2.0, code: 2.6, mixed: 3.2, prose: 3.8 };

function classify(text) {
  const sample = text.length > 65536 ? text.slice(0, 65536) : text;
  if (!sample) return 'mixed';
  const cjk = (sample.match(/[　-鿿가-힯]/g) || []).length;
  if (cjk / sample.length > 0.15) return 'cjk';
  const nonWord = (sample.match(/[^\w\s]/g) || []).length / sample.length;
  const digits = (sample.match(/\d/g) || []).length / sample.length;
  const spaces = (sample.match(/ /g) || []).length / sample.length;
  const avgWord = sample.length / ((sample.match(/\s+/g) || []).length + 1);
  if (nonWord > 0.28 || digits > 0.22 || avgWord > 18) return 'dense';
  if (nonWord > 0.14) return 'code';
  if (spaces > 0.14 && nonWord < 0.09) return 'prose';
  return 'mixed';
}

// CJK: roughly one token per codepoint is the conservative assumption; using a
// chars/N divisor there would claim impossible savings.
function estimate(text) {
  if (!text) return { tokens: 0, cls: 'mixed' };
  const cls = classify(text);
  if (cls === 'cjk') return { tokens: [...text].length, cls };
  return { tokens: Math.ceil(text.length / DIVISORS[cls]), cls };
}

module.exports = { estimate, classify, DIVISORS };
```

**Wire it in — two places only:**

1. `bin/trim-core.js` `buildMeta()`: add
   `inputTokenEstimate`, `outputTokenEstimate`, `tokenClass`, and
   `estimator: 'class/1'`. Additive fields; change nothing existing.
2. The net-win gate. **It is not in `trim-core.js`** — the 32-byte decision is
   duplicated across four adapter sites. Verified locations:

   | File | Line | Context |
   |---|---|---|
   | `adapters/claude-posttooluse.js` | 204 | main Bash path |
   | `adapters/claude-posttooluse.js` | 139 | Read path |
   | `adapters/lib/pi-runtime.js` | 132 | Pi `tool_result` |
   | `adapters/codex-posttooluse.js` | 36 | Codex |

   Do **not** patch these four independently — that is how they drifted.
   Add one shared helper to `bin/trim-core.js` and export it:

   ```js
   // Single net-win decision for every adapter. A candidate must be smaller in
   // bytes AND in estimated tokens: dense output can shrink in bytes while
   // tokenizing no cheaper, and the marker we add is itself tokens.
   function netWin(inText, outText) {
     try {
       if (outText === undefined || outText === null) return false;
       const byteWin = Buffer.byteLength(inText) - Buffer.byteLength(outText);
       if (!(byteWin >= 32)) return false;
       const { estimate } = require('./lib/token-estimate');
       const tokenWin = estimate(inText).tokens - estimate(outText).tokens;
       if (!Number.isFinite(tokenWin)) return false;
       return tokenWin >= Number(process.env.TRIM_NET_WIN_TOKENS || 24);
     } catch {
       return false; // fail closed on the *decision*: keep the original text
     }
   }
   ```

   Then replace each of the four conditions with a `netWin(...)` call,
   preserving each site's existing surrounding behaviour (Codex exits 0, the
   Claude sites call `maybeLog(..., { applied: false })`, Pi returns no patch).
   Note the sense inverts: the current checks test for *rejection*
   (`outBytes >= inBytes - 32`), so they become `if (!netWin(...))`.

   Line numbers will shift as you work — locate the sites by the literal
   `- 32` comparison, not by line number.

   This is the one place in the plan where fail-closed is correct: a failure
   in the *decision* keeps the original text, which is the safe direction.

**Acceptance tests** — new `test/token-estimate.test.js` (register in
`package.json`):

| Assertion |
|---|
| Minified JSON classifies `dense`; an English paragraph classifies `prose`; a source file classifies `code` |
| CJK-heavy text classifies `cjk` and its estimate is ≥ codepoint count |
| A candidate 40 bytes smaller but with a *higher* token estimate is rejected (output unchanged) |
| `netWin()` returns false when `outText` is `undefined`/`null` |
| `netWin()` returns false (not throw) if `token-estimate.js` is unresolvable |
| All four adapter sites route through `netWin()`: `rg -n '\- 32' adapters/` returns no comparison sites |
| Estimator is deterministic: same input → same output across 100 calls |
| Empty string, single char, 10MB string → no throw |
| Emoji/surrogate-pair input → does not report negative or zero savings |

**Do not** add `TRIM_TOKENIZER` or any pluggable tokenizer. One estimator.

**Verify:** `npm test && npm run bench` — bench baseline may shift; if
`bench.test.js` fails on the baseline check, regenerate the baseline **in a
separate commit** and state the before/after in the message.

---

## T6 — Evidence labels in `trim-stats`

**Why:** no published figure should appear without stating what kind of
evidence it is. `bin/trim-stats.js:77` already carries an honest `estNote`
footnote; make it structural.

**File:** `bin/trim-stats.js`

Adopt these labels and attach one to every number the report prints:

| Label | Meaning |
|---|---|
| `L1-component` | bytes / lines / token estimate changed |
| `L2-preservation` | diagnostics and identifiers verified retained |
| `L3-context` | model-visible payload verified |
| `L8-trajectory` | reruns / re-reads / turns observed (T7) |

Requirements:

- Every percentage or token figure prints its label inline, e.g.
  `ratio 0.089 [L1-component]`.
- Token figures additionally print the estimator name and class mix, e.g.
  `~12,400 tokens saved [L1-component, estimator class/1]`.
- Add `--json` emitting the same data with an explicit `evidence` field per
  metric.
- The reader must accept metrics lines both with and without the T5/T7 fields
  (old lines stay valid; normalize at read time; **never rewrite the JSONL**).

**Acceptance tests** — `test/stats.test.js` (new, register it):

| Assertion |
|---|
| A metrics file mixing old lines (no token fields) and new lines produces a valid report with no `NaN` or `undefined` |
| Every line of report output containing `%` or `tokens` also contains a `[L` label |
| `--json` output parses and every metric object has an `evidence` key |
| Empty metrics file → clean "no data" message, exit 0 |

**Verify:** `npm test`

---

## T7 — Recovery detection (observe-only)

**Why:** this is the whole point of the release. It substitutes for a
200-session benchmark by turning ordinary usage into outcome evidence, and it
answers the only question that matters: *does trimming cause extra work?*

**Observe-only. This task must not change a single byte of model-visible
output.** If any acceptance test shows output changing, the task is wrong.

**New file:** `bin/lib/recovery-detect.js`

Maintain a bounded ring buffer (max 32 entries) in the existing session-state
mechanism (`bin/lib/session-state.js`). Per tool result record:

- `commandFingerprint` — first token + hash of the normalized command,
  **never** the raw command. There is no reusable helper today: the logic is
  inlined inside `maybeLog` at `bin/trim-core.js:889` as
  `{ cmdWord: e.command.trim().split(/\s+/, 1)[0].slice(0, 32), cmdHash: cheapHash(e.command) }`.
  **First extract it** into an exported `commandFingerprint(command)` and have
  `maybeLog` call it, so there is one implementation. Keep the emitted field
  names (`cmdWord`, `cmdHash`) byte-identical — `bin/trim-stats.js` and any
  existing metrics files depend on them.
- `contentHash` — SHA-256 of the observed text
- `strategy`, `lossy`, `sidecar` (bool), `markerKind`, `bypass` (bool)
- `seq` — monotonic counter within the compaction epoch

Then flag a **recovery candidate** when a new result matches an entry from the
previous 1–5 results:

| `kind` | Condition |
|---|---|
| `same-command` | identical command fingerprint |
| `same-read` | identical file path and range, unchanged `contentHash` |
| `artifact-retrieval` | a sidecar path is read shortly after a lossy digest |
| `trim-bypass-rerun` | same fingerprint, now with `TRIM_OFF=1` |
| `unchanged-validation` | same validation command, no intervening edit tool |

**The discriminator — this is the part that makes the data mean anything.**
A rerun count alone cannot distinguish "the model re-ran because we cut
something" from "the task needed a re-run". So record, on every recovery
candidate:

- `precedingMarkerKind` — which marker type, if any, was on the immediately
  preceding result (`null` when that result passed through untouched)
- `precedingLossy` — whether that result was lossy
- `precedingApplied` — whether a transform was actually applied

`trim-stats` then reports **rerun rate for trimmed results vs. rerun rate for
untouched results** (bypassed, sub-threshold, and passthrough cases). That is
a within-user A/B with no harness and no provider cost.

Reset all state on: compaction (`PostCompact` already increments the epoch),
session end, fork, and branch switch. Never share state across sessions.

Write to metrics as a `recovery` object: `{ candidate, kind,
precedingMarkerKind, precedingLossy, ageMs, seqGap }`.

**Reporting** — in `trim-stats`, add an `L8-trajectory` section:

```
Recovery candidates: 14 of 312 results (4.5%) [L8-trajectory]
  after lossy transform:   11 of 128 (8.6%)
  after untouched result:   3 of 184 (1.6%)
  by kind: same-command 8, same-read 4, artifact-retrieval 2
```

State plainly in the report that these are correlations, not proven causes.

**Acceptance tests** — new `test/recovery-detect.test.js`:

| Assertion |
|---|
| Same command fingerprint twice within 5 results → `candidate: true`, `kind: 'same-command'` |
| Same command 6+ results apart → not a candidate |
| Same file, same range, unchanged hash → `same-read` |
| Sidecar read after a lossy digest → `artifact-retrieval` |
| Rerun with `TRIM_OFF=1` → `trim-bypass-rerun` |
| `precedingMarkerKind` is `null` when the prior result was untouched, and set when it was trimmed |
| Ring buffer never exceeds 32 entries under 10,000 pushes |
| State resets on epoch increment |
| **For every fixture in `test/fixtures/`: output with recovery detection enabled is byte-identical to output with it disabled** |
| Metrics file contains no raw command text, file path, or output content |

The last two are the important ones. The byte-identity test is the guarantee
that this task is observe-only; the privacy test is non-negotiable.

**Verify:** `npm test`

---

## T8 — MCP coverage in observe mode

**Why:** the matcher `^(Bash|Read)$` means Agent Trim never sees an MCP
result. That is a real coverage gap — but the naive fix is dangerous, so this
task ships instrumentation only.

**Do not change the installer's matcher default.** Read
[`docs/improvement-plan-audit.md` §3.3](./improvement-plan-audit.md) before
starting to understand why.

**Files:** `adapters/claude-posttooluse.js`, new
`adapters/lib/mcp-result.js`

**Behaviour:**

- New env var `TRIM_MCP`, default `observe`. Values: `off`, `observe`, `on`.
- `observe`: parse the result, compute what a transform *would* produce,
  write metrics, and **return no replacement**. Byte-identical output.
- `on`: transform, but only for tools matching `TRIM_MCP_ALLOW_RE`, which has
  **no default** — with no allowlist set, `on` behaves as `observe`.
- Always deny when `alreadyCondensed()` (T2) returns true for a text block,
  or when the tool matches `TRIM_MCP_DENY_RE`.

**MCP result handling rules** (from the source plan §7.6 — these are correct,
keep them):

1. Deep-copy the result; transform only blocks with an exactly recognized
   text-bearing shape.
2. Preserve images, audio, blobs, resource links, embedded resources,
   annotations, `_meta`, `structuredContent`, `isError`, and unknown fields
   exactly.
3. Preserve block order. Never flatten mixed content into one string.
4. Never convert a structured error into successful text.
5. If any shape is ambiguous, pass the whole result through unchanged.

**Required fixtures** — `test/fixtures/mcp/`: text-only success; text-only
error; multiple text blocks; text + image; text + audio; text + resource
link; embedded text resource; embedded blob resource; `structuredContent` plus
identical JSON text; unknown future block type; a two-line
`JSON envelope + "Full result: …"` result (the PalSync shape).

**Acceptance tests** — `test/mcp-result.test.js`:

| Assertion |
|---|
| Every fixture, `TRIM_MCP=observe` → returned result deep-equals input |
| Non-text blocks deep-equal the input in all modes |
| `isError: true` is never cleared |
| Unknown block type → whole result passes through |
| The PalSync-shaped fixture → passthrough even with `TRIM_MCP=on` and a matching allowlist (T2 wins) |
| `TRIM_MCP=on` with no `TRIM_MCP_ALLOW_RE` → no transform |
| Malformed/truncated JSON result → no throw, passthrough |

**Do not implement** the `structuredContent` mirror-removal experiment. It
requires proving what the host does with a rewritten result, which we cannot
observe.

**Verify:** `npm test`

---

## Definition of done

- [ ] T1–T8 complete, `npm test` green, one commit each
- [ ] `rg -n 'nativeBytes' docs/ README.md` → no matches
- [ ] No new entries under `dependencies` in `package.json`
- [ ] Byte-identity tests prove T7 and T8-observe change no output
- [ ] No metrics fixture contains a raw command, path, or output body
- [ ] README updated: every savings figure carries an evidence label; the
      `bytes/4` claim is replaced or labelled
- [ ] `docs/decisions.md` gains entries for what this plan rejected
      (checks runner, context doctor, cache observer, compaction ledger,
      tokenizer adapters, structuredContent mirror, e2e gate) with reasons
- [ ] `docs/palsync.md` reflects T4

## Explicitly out of scope

Do not build any of these, even if they seem easy: deterministic checks
runner, `verify --changed`, unified multi-subcommand CLI, context doctor,
cache-health observer, compaction preservation ledger, adaptive recovery
*controller* (T7 observes only), exact active-result replacement, command
rewriting, source outline command, MCP retrieval server, `sidecar-meta` v3,
SHA-256 canonical artifact paths, pluggable tokenizers, Python tooling, the
20-repository end-to-end benchmark corpus.

---

## Appendix — what this does for PalSync, in measurable terms

Honest accounting. Most of this release is measurement and regression
prevention, not compression, and the PalSync-facing numbers reflect that.

### A1. Token savings on PalSync MCP results: structurally ~0%

This is derivable from PalSync's source without running anything.
`src/mcp/envelope.js` `serializeEnvelope()` returns:

```js
message: JSON.stringify(envelope) + "\n" + trailer
```

That is **exactly two lines**: one long single-line JSON object, plus
`Full result: <path>`. Check each Agent Trim stage against a two-line input:

| Stage | Threshold | Fires? |
|---|---|---|
| Strip ANSI | — | No — JSON envelope carries no escapes |
| Collapse progress bars | `\r` runs | No |
| Whitespace tidy | — | Negligible (compact JSON) |
| Fold repeated lines | ≥3 identical | No — 2 lines |
| Fold same-shaped lines | ≥5 similar | No — 2 lines |
| Line cap | 120 pass / 300 fail | No — 2 lines |
| `jsonl-log` strategy | ≥20 lines each starting `{` | No |
| Sidecar digest | ~15KB | **Only above threshold** |

So for any envelope under ~15KB, Agent Trim's achievable token reduction is
**zero by construction** — there is nothing in a two-line result for a
line-oriented pipeline to remove. PalSync already did the semantic work:
`collapseFindings()` groups diagnostics by `severity + code + message` with an
`occurrences` count, which is the same transformation as our steps 4–5.

**Claiming any percentage improvement here would be false.** The correct
policy is the deny-list in T2/T8, and its value is avoided risk, not savings.

### A2. Regression prevented: bounded, and quantifiable in advance

The one path that *would* fire is the sidecar digest above ~15KB. Envelope
size scales with diagnostic groups at roughly 150–250 bytes per group (five
scalar fields plus up to three `{file, line}` locations), so the threshold sits
near **60–100 unique diagnostic groups**.

For results past that point, a naive MCP expansion would:

1. replace a machine-parseable JSON envelope with a human-readable digest —
   **100% loss of parseability** for that result;
2. append `[trim hook: …]` after the trailer, breaking the documented
   "ends with `^Full result: .+$`" contract;
3. cut into the **three surviving `file:line` locations per diagnostic group**
   that PalSync deliberately retained at `detail: "normal"` — the last copy of
   that information in context, with the full data only in PalSync's artifact.

Item 3 is the failure mode arXiv:2607.12161 measured as 27/40 → 15/40 patch
success. T1, T2, and T8's deny-by-default each independently prevent it.

**Measurable claim:** envelope corruption goes from **possible** (for results
above the sidecar threshold, under a naive `^(Bash|Read|mcp__.*)$` expansion)
to **impossible in all cases**. Verified by the T8 fixture "PalSync-shaped
result passes through even with `TRIM_MCP=on`".

Stated that way deliberately. The ~15KB threshold and the 60–100-group range
are my own derivations from field-size arithmetic, and `maybeSidecar` carries
further conditions (per the README, shell output past ~28KB skips sidecar
entirely). The bounded-risk argument does not depend on those figures being
exact; a specific probability would. Treat the numbers as scale indicators and
the elimination as the verified claim.

### A3. Byte accounting completed: 2 of 3 fields → 3 of 3

PalSync's interop doc defines three fields and states that `trimmedBytes` is
*"Agent Trim-owned bytes after downstream trimming; not observed or stored by
PalSync"*. Today nobody measures that hop: `palsync cost` reports `rawBytes`
and `returnedBytes` and cannot report the third.

After T5 and T6, Agent Trim's metrics carry `inputBytes`, `outputBytes`, and
per-class token estimates for every result, and can populate `trimmedBytes`
through the existing `maybeLog(..., { palsync: {...} })` passthrough.

**Measurable claim:** `palsync cost`'s raw → returned → trimmed pipeline
becomes end-to-end complete for the first time — 3 of 3 fields populated
instead of 2 of 3, with the third labelled `L1-component` and carrying a named
estimator rather than an unqualified `bytes/4`.

### A4. Where real savings exist for PalSync users — and why no number is given

PalSync's **CLI** path, not its MCP path. `palsync validate`, `palsync push`,
`pal-loop`, and friends run as Bash commands, so Agent Trim compresses their
output *today*. That output is multi-line human log text — exactly the shape
the generic pipeline handles well.

That path is currently **unmeasured**, and the honest position is that no
percentage should be quoted until T5–T7 are in place. Quoting a fixture ratio
here would repeat the mistake this whole release exists to correct.

After this release, the number becomes obtainable by:

```bash
touch ~/.trim-metrics.jsonl     # enable local metrics
# ... use palsync normally for a few sessions ...
node bin/trim-stats.js --json | jq '.byCommand["palsync"]'
```

and the answer arrives with an evidence label attached, plus the T7 comparison
of rerun rates for trimmed vs. untouched PalSync output — which is what
determines whether the savings are real or merely visible.

### A5. Summary

| Claim | Value | Evidence |
|---|---|---|
| Token reduction on PalSync MCP envelopes | ~0% | Structural: 2-line result, derived from `envelope.js` |
| Envelope corruption risk above ~15KB | 1.0 → 0 | T8 fixture test |
| `Full result:` trailer preserved as final line | not guaranteed → guaranteed | T1 tests |
| Double omission markers | possible → impossible | T2 tests |
| Third-party hook silently replaced | possible → impossible | T3 tests |
| `palsync cost` byte accounting | 2 of 3 fields → 3 of 3 | T5/T6 |
| Savings on PalSync CLI-via-Bash output | unmeasured → measured with evidence label | T5–T7 |

The headline is deliberately unglamorous: **this release makes the Agent Trim
↔ PalSync boundary correct and measurable rather than faster.** The
compression win on PalSync's MCP surface was never available, and the main
risk was that a future release would take it anyway.
