# Audit — "Agent Trim Improvement Program"

Reviewed document: [`docs/agent-trim-improvement-plan.md`](./agent-trim-improvement-plan.md)
(authored with ChatGPT, dated 2026-07-25). Audit date: 2026-07-28.
Interop target: [contractpal/palsync](https://github.com/contractpal/palsync).

---

## Verdict

**Keep the diagnosis. Cut ~85% of the prescription. Ship a five-item `0.4.0`.**

The plan's central claim is correct and well-sourced: Agent Trim currently
measures itself with the metric the literature says is wrong. That is a real
credibility gap and it justifies real work — so "leave Agent Trim as it is" is
*not* the right answer.

But the plan as written proposes ~15 new library modules, 7 CLI subcommands,
3 JSON schemas, a 20-repository end-to-end benchmark corpus, and a Python
orchestration layer, on top of a 2,830-LOC zero-dependency codebase. It then
gates *every* behavioural feature behind a benchmark that costs real provider
money and cannot run in CI. Executed literally, the plan freezes the project
at `0.4.0` indefinitely while tripling its surface area.

The recommended plan is in [section 4](#4-recommended-040). It is roughly one
tenth the size and keeps the plan's best ideas.

---

## 1. What the plan gets right (verified against primary sources)

**The governing metric.** `primary metric = provider-billed cost / verified
successful task` is the right objective, and the paper behind it is real.
arXiv:2607.12161 (*Token Reduction Is Not Cost Reduction*, Weinberger &
Hozez) — verified — measured 2,848 Claude Code executions across 103 tasks
and found:

- prompt-cache traffic was ~87% of cost composition;
- removing 38% of tool-output tokens **increased** billed cost by 6.8% in
  paired comparisons;
- aggressive compression cut successful patch application from 27/40 to 15/40.

That is a direct, measured threat to Agent Trim's default posture, and the
plan is right to lead with it. Our `bench/` corpus and `trim-stats` report
compression ratios — precisely the metric the paper says does not predict
cost. This is the one genuine gap worth funding.

**Citations are sound.** All five arXiv IDs check out: 2607.12161,
2601.20404 (AGENTS.md efficiency), 2602.10986 (TVCACHE), 2601.06007 (Don't
Break the Cache), 2506.14852 (Agentic Plan Caching). No fabricated
references found.

**Hook-surface claims are accurate.** Verified against
`code.claude.com/docs/en/hooks`: `InstructionsLoaded`, `PostToolBatch`, and
`SubagentStart` all exist; `PostToolUse.updatedToolOutput` is the documented
result-replacement field; `PreCompact` still exposes no way to inject summary
instructions — which matches the entry already in
[`docs/decisions.md`](./decisions.md) and confirms `claude-precompact.js`
should stay uninstalled.

**The rejection list (§11) is good.** Every item in it is either already in
our `docs/decisions.md` with the same reasoning, or a correct call. It should
be merged into `decisions.md` rather than kept as a separate list.

---

## 2. Where the plan is wrong or oversized

### 2.1 The release gate makes the project unshippable

§6.3 requires, before any behavioural feature goes default-on: ≥20 task
manifests × ≥5 repetitions × 2 arms = 200+ full agent sessions, with pinned
model/effort/tool-inventory, randomised arm order, and fresh worktrees.

That is a sound experimental design for a funded lab. For this project it is
unrunnable — it costs real money per gate, cannot execute in CI, and applies
to *every* feature. The consequence is not "high quality"; it is that nothing
after `0.4.0` ever ships.

The plan already contains its own cheaper answer and doesn't notice:
**trajectory recovery detection (§6.4)** turns ordinary daily usage into
outcome evidence at near-zero cost. Promote it from a Phase-0 side item to
*the* measurement strategy. See [4.3](#43-recovery-detection--the-cheap).

### 2.2 Roughly 40% of Phase 1 renames what already exists

| Plan item | Actual current state |
|---|---|
| §7.1 sidecar-meta **v3** | `v2` already carries `contentHash` (SHA-256), `hostComplete`, `diagnostics`, `census`, `totalLinesObserved`. The v3 field list is near-identical. |
| §7.1 SHA-256 canonical object paths | `docs/decisions.md` records the FNV-1a-filenames / SHA-256-content split as **deliberate**, to keep content-addressed filenames stable for PalSync. §7.1 would churn a protocol we intentionally froze, then re-add "compatibility aliases" to undo the churn. |
| §6.1 byte-exact vs normalized duplicates | `bin/lib/dup-detect.js` already hashes with SHA-256; only the *label* is imprecise. This is a one-line naming fix, not a new module. |
| §7.4 shared marker contract | A single marker renderer already exists; the `[trim hook:` prefix is a frozen protocol surface. |

Schema-version bumps for near-identical fields impose migration cost on every
downstream reader (including PalSync) and deliver no user-visible benefit.
Add fields additively; do not renumber.

### 2.3 The quiet environment is mis-sold

§7.2 presents `NO_COLOR=1 / FORCE_COLOR=0 / CLICOLOR=0` as "prevent avoidable
presentation bytes" and the plan's one-page summary ranks it third overall.
That reasoning double-counts: pipeline steps 1 and 2 already strip ANSI and
collapse carriage-return progress bars **losslessly**, before the model sees
anything. Suppressing colour at the source saves approximately zero
model-visible tokens.

The genuine wins are real but different, smaller, and worth stating honestly:

1. **Fidelity under host truncation.** Per our own
   [`docs/research.md`](./research.md), the host cuts Bash output at ~29KB
   (Claude) and 50KB / 2,000 lines (Pi) *before* the hook runs. Escape codes
   consumed by that budget are content Agent Trim never gets to see. Removing
   them at the source buys back real signal on large outputs.
2. **`PAGER=cat` / `GIT_PAGER=cat`** avoids pagers stalling or paginating —
   a correctness win, orthogonal to tokens.

Two further caveats the plan misses:

- **Mechanism risk.** `CLAUDE_ENV_FILE` is real for `SessionStart`, but has
  open defects: it arrives as an empty string in some configurations
  ([#15840](https://github.com/anthropics/claude-code/issues/15840)) and does
  not work for plugin-installed hooks
  ([#11649](https://github.com/anthropics/claude-code/issues/11649)); its
  definition is documented inconsistently
  ([#19357](https://github.com/anthropics/claude-code/issues/19357)). Since
  we install into `~/.claude/settings.json` as a personal hook, the documented
  path should work — but the boring alternative, the documented `env` settings
  key, needs no hook at all and should be preferred or offered as fallback.
- **Contract conflict.** PalSync's interop doc explicitly assigns
  `"ansiCleaningOwner": "Agent Trim"`. Our ANSI stripping is contractually
  load-bearing for a downstream consumer. Pushing that responsibility to the
  source environment must not weaken step 1.

Net: still worth doing, as a fidelity-and-robustness item. Not a headline
token win.

### 2.4 Phase 2 is a different product

§8.2 (deterministic validation batch runner, `.agent-trim/checks.json`
profiles, sequential command execution, per-command artifacts) and §8.3
(`verify --changed`) describe a **task runner**, not a tool-output
compressor. They bring per-repo config, process supervision, timeout/signal
semantics, and a config schema — and they duplicate what every repo's own
`npm` scripts already do.

This is also where the collision with PalSync is worst: `pal_validate`,
`pal_regression`, and `pal_spec_lint` already own batched validation inside a
PalSync workspace. Two tools racing to be the validation entry point is a
worse outcome than neither doing it.

Reject. Keep Agent Trim's single responsibility: *make a tool result that
already exists smaller without destroying its evidence.*

### 2.5 Phases 3–4 are speculative machinery

Context doctor, cache-health observer, tool-footprint recommendations,
compaction preservation ledger, adaptive recovery *controller*, exact
active-result references, `structuredContent` mirror removal, pluggable
tokenizer adapters, command-source shaping, source outline command, optional
MCP retrieval server.

Each is an abstraction with at most one hypothetical caller and no measured
demand — the repo's own standing rule against speculative flexibility rules
them out. Several are already deferred with reasons in `decisions.md`
(exact-duplicate replacement, per-provider cache-breakpoint management,
retroactive re-trimming). The plan re-proposes them without new evidence.

Note the plan also contradicts its own principle #1 (zero dependencies, local
and deterministic) by allowing Python for benchmark orchestration.

---

## 3. Interoperability audit vs PalSync

Verified against PalSync source, not just its README.

### 3.1 Install paths do not collide — confirmed safe

| | Agent Trim | PalSync |
|---|---|---|
| File | `~/.claude/settings.json` (user scope) | `<workspace>/.claude/settings.json` (project scope) |
| Hook events | `PostToolUse`, `SubagentStart`, `PostCompact` | `Stop` only |
| Merge style | additive per event; preserves unknown keys | additive; deep-clones, preserves unknown keys, idempotent, removes only its own entries |

Different files *and* disjoint hook events, so neither installer overwrites
the other's bytes. `src/launcher/claudeHooks.js` deletes `settings.json` only
when uninstalling would leave it completely empty, which cannot happen if
Agent Trim's hooks are present.

File disjointness alone would not be sufficient, because most Claude Code
settings keys *override* across scopes (managed > CLI > local > project >
user) — under override semantics, PalSync writing project-scope `hooks` would
shadow Agent Trim's user-scope hooks entirely, silently disabling it inside
every PalSync workspace. Verified that this does not happen; `hooks` is an
explicit exception, alongside permission rules:

> Hook entries merge across settings levels rather than replacing each other:
> user, project, and local settings add their own hooks without removing
> managed ones […] All matching hooks run in parallel, and identical handlers
> are deduplicated automatically. Command hooks are deduplicated by command
> string and `args`.
> — [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)

Both hook sets are therefore live simultaneously, and Agent Trim's own
repeated installs cannot double-fire (deduplication is by command string,
which is stable for a given `ROOT`). No action needed — but this is a
load-bearing host behaviour, so it belongs in `docs/palsync.md` and in the
hook-surface table in `docs/research.md` rather than remaining an assumption.

On Pi, both register extensions that touch `tool_result`, but Agent Trim's
handler is scoped to `bash` results while PalSync's tools are separately
registered via `src/mcp/registerPi.js`. They compose. This should be stated
explicitly in `docs/palsync.md` rather than left as an assumption.

### 3.2 PalSync has published a contract Agent Trim does not honour

`palsync/docs/agent-trim-interop.md` (which we did not know existed) states
requirements on the downstream trimmer:

```json
{
  "version": 1,
  "fullResultMarker": "^Full result: .+$",
  "preserveTrailer": true,
  "noDoubleOmissionMarkers": true,
  "ansiCleaningOwner": "Agent Trim"
}
```

Compliance status today:

| Requirement | Status |
|---|---|
| Retain final `Full result: <path>` line | **Not guaranteed.** The generic cap keeps a tail (60/40 head/tail split, `DIGEST_TAIL=15`), so it usually survives by luck. A structured strategy replaces output wholesale and would drop it. No rule enforces it. |
| `noDoubleOmissionMarkers` | **Not honoured.** No awareness of upstream grouping. |
| `ansiCleaningOwner: Agent Trim` | Satisfied — see the §2.3 caveat. |
| Field names | **Diverged.** `docs/palsync.md` documents `palsync.nativeBytes`; PalSync ships `rawBytes` / `returnedBytes` / `trimmedBytes` in `.palsync.usage.json` v2. |

These are latent today only because our `PostToolUse` matcher is
`^(Bash|Read)$` — Agent Trim never sees a PalSync MCP result. **The plan's
§7.6 is exactly what would turn all of them into live bugs.**

### 3.3 The plan's MCP matcher is the real hazard

§7.6 proposes changing the default matcher to `^(Bash|Read|mcp__.*)$`.
Against PalSync specifically, `src/mcp/envelope.js` shows PalSync results are
**already semantically condensed**:

- diagnostics are grouped by `severity + code + message` with an
  `occurrences` count — the same transformation as our steps 4–5;
- at the default `detail: "normal"`, each group keeps **only 3 locations**;
- the pre-condensation structured result lives in PalSync's own
  content-addressed artifact, pointed to by the `Full result:` trailer.

So a generic cap applied on top would cut into the *three surviving
`file:line` locations per diagnostic* — the last copy of that information in
context. That is not a compression win; it is the 27/40 → 15/40 patch-success
failure mode from arXiv:2607.12161, reproduced deliberately.

`pal_context` makes it worse: it returns deliberately curated contract
sections. Agent Trim cannot distinguish curated text from noise.
`pal_screenshot` returns image blocks, the concrete mixed-content case.

The discriminating principle, which belongs in `docs/palsync.md`:

> **Whoever owns the condensation contract owns the evidence guarantee.**
> If a tool result is already a digest, compressing it is compressing a
> summary. Agent Trim's safety argument — "every error/warning line survives
> by construction" — only holds over raw output. It does not transfer to
> someone else's digest.

Therefore MCP coverage must be **allowlist opt-in**, never `mcp__.*` by
default. One good outcome: a `self-condensing` convention any MCP server can
declare (by trailer marker, `_meta` field, or our allowlist) that Agent Trim
treats as pass-through.

Checked and *not* a risk: the `jsonl-log` strategy needs ≥20 non-empty lines
each starting with `{`. A single serialized PalSync envelope cannot trigger
it.

### 3.4 Latent foreign-hook hazard in `merge-hooks.js`

Independent of the plan. `adapters/merge-hooks.js:57-62` uses a fallback
idempotency key:

```js
JSON.stringify(h).includes('/adapters/') && (h.matcher || '') === (entry.matcher || '')
```

Any *third-party* hook whose command path happens to contain `/adapters/`,
registered on the same event with the same matcher, gets silently
**replaced** — not merged. The legacy-install fallback should be constrained
to commands under Agent Trim's own `ROOT`. Cheap fix, directly in scope for
"plays nicely with other extensions."

---

## 4. Recommended `0.4.0`

Five items. Ordered by value per unit of risk.

| # | Item | Why | Risk |
|---|---|---|---|
| 1 | Truthful metrics + evidence labels | Closes the real credibility gap | none |
| 2 | Class-based token estimator | Replaces `bytes/4` in gate and stats | low |
| 3 | Recovery detection + trim-vs-bypass comparison | Outcome evidence at zero cost | none (observe-only) |
| 4 | PalSync contract compliance + merge hardening | Fixes a real divergence | none |
| 5 | MCP coverage, observe mode, allowlist opt-in | Real coverage gap, safely | low |

### 4.1 Truthful metrics and evidence labels

Adopt the plan's evidence ladder (`L1-component` … `L8-trajectory`) and its
privacy rules. **Reject** the separate `metrics-v2.schema.json` and the
parallel `appendMetricV2()` path: add fields additively to the existing JSONL
and have `trim-stats.js` normalize at read time (which the plan itself
recommends — "never rewrite existing JSONL").

Concretely: no `trim-stats` or README figure may be printed without its
evidence level attached. The current `estNote` string in `trim-stats.js:77`
is honest about being a `bytes/4` estimate — that honesty should become
structural rather than a footnote.

One deliberate divergence from the plan: it wants command strings reduced to
"first executable token plus salted hash". For a single-user local tool that
destroys most of the diagnostic value of the metrics. Keep the program plus a
normalized-shape fingerprint; the file never leaves the machine and there is
no network path anywhere in Agent Trim.

### 4.2 Class-based token estimator

Implement §7.3's `dense / code / mixed / prose / cjk` classifier and use
`estimatedTokenWin >= TRIM_NET_WIN_TOKENS` alongside the existing byte floor.
`bytes/4` systematically overstates savings on dense output (JSON, hashes,
stack traces) — the exact material we compress hardest.

**Reject** the `TRIM_TOKENIZER` adapter surface (§7.3, optional tokenizers).
One deterministic estimator, calibrated against a committed fixture corpus
including CJK and emoji.

### 4.3 Recovery detection — the cheap substitute for the benchmark

The plan's best idea, and the reason the 200-session harness is unnecessary.
Observe-only, no model-visible change:

- same command fingerprint repeated within the next 1–5 tool results;
- same file re-read, same range, unchanged hash;
- sidecar/artifact read shortly after a lossy digest;
- rerun with `TRIM_OFF=1` after a compressed result;
- validation command repeated with no intervening file change.

Add the discriminator the plan omits — without it, "the model re-ran" cannot
be separated from "the task needed a re-run":

- record **which marker type, if any**, was present on the result
  immediately preceding a rerun;
- compare rerun/re-read rates for trimmed results against results that passed
  through untouched (`TRIM_OFF`, sub-threshold, and pass-through cases).

That is a within-user A/B with no harness, no fixtures, and no provider cost.
It answers the only question that matters — *does trimming cause recovery
work?* — using traffic we already generate. Report it in `trim-stats` at
`L8-trajectory`.

Keep the plan's `bench/e2e/` manifest **format** as documentation of what
good evidence looks like. Do not build the 20-repository corpus now.

### 4.4 PalSync contract compliance

1. Honour `preserveTrailer`: a general rule that a final line matching a
   registered protective pattern always survives every path, generic and
   structured. Generalise rather than special-casing PalSync —
   `TRIM_KEEP_LAST_RE`, defaulting to include `^Full result: .+$`.

   **Ordering matters, and a naive implementation will pass our rule while
   failing PalSync's.** The contract is that the result *ends with* the
   trailer, but Agent Trim appends its own trailing note on capped output
   ("rerun with `TRIM_OFF=1`…"). Merely *retaining* the line leaves our marker
   after it. Specification: a protected trailer must be **re-emitted last**,
   after every Agent Trim marker, so the final line of the delivered result
   still matches `fullResultMarker`. Test this explicitly — retention and
   final-position are two different assertions.
2. Honour `noDoubleOmissionMarkers`: when a result is recognised as
   already-condensed, pass through; never stack a second omission marker on
   someone else's digest.
3. Fix the field-name divergence in `docs/palsync.md`
   (`nativeBytes` → `rawBytes` / `returnedBytes` / `trimmedBytes`) and
   reference `.palsync.usage.json` v2.
4. Document the Pi coexistence story and the disjoint-settings-file finding
   from [3.1](#31-install-paths-do-not-collide--confirmed-safe).
5. Constrain the `merge-hooks.js` legacy fallback to commands under Agent
   Trim's `ROOT` ([3.4](#34-latent-foreign-hook-hazard-in-merge-hooksjs)).
6. Add the "condensation contract owns the evidence guarantee" principle and
   the `self-condensing` pass-through convention.

### 4.5 MCP coverage in observe mode

Take §7.6's mixed-content preservation rules and fixture list — they are
careful and correct. Change the rollout:

- matcher stays opt-in; **no `mcp__.*` default**;
- ship `TRIM_MCP=observe` with metrics and fixtures only;
- promote to `on` per allowlisted server, never globally;
- deny-by-default for any server that declares or is detected as
  self-condensing;
- **reject** the `structuredContent` mirror-removal experiment outright: it
  requires proving what Claude does with a rewritten result, which we cannot
  observe.

Also worth taking from the plan, cheaply: PalSync injects a large bundled
skill set (`bundled-context/CLAUDE.md`, seven-plus skill families), and
`InstructionsLoaded` now exists. A metrics-only record of instruction
footprint (§9.3, observation half only) is a few lines and directly relevant
to a PalSync workspace. Skip the "context doctor" CLI.

---

## 5. Explicitly not doing

| Plan item | Reason |
|---|---|
| §6.3 20-task × 5-rep e2e gate | Unrunnable at this project's scale; §4.3 substitutes |
| §7.1 artifact store v3 / SHA-256 canonical paths | Churns a protocol frozen on purpose for PalSync; v2 already carries the fields |
| §8.1 seven-subcommand CLI | Only `retrieve` has a caller |
| §8.2 checks runner, §8.3 `verify --changed` | Different product; collides with `pal_validate` |
| §9.1 context doctor, §9.2 cache observer | Speculative; we cannot see provider cache state |
| §9.4 compaction ledger | Mutating compaction is the one place a bug is unrecoverable |
| §10.1 exact active-result references | Already deferred in `decisions.md` pending live evidence |
| §10.2 adaptive recovery *controller* | Observe (§4.3) first; a controller needs data we don't have |
| §10.3 command rewriting, §10.5 source outlines | Semantic risk far exceeds byte gain |
| §10.6 MCP retrieval server | Permanent tool-definition cost for an occasional read |
| §7.3 tokenizer adapters | Optionality with no caller |
| §7.6 structuredContent mirror | Requires observing host behaviour we cannot observe |
| Python benchmark orchestration | Contradicts the plan's own zero-dependency principle |

---

## 6. If only one thing ships

**§4.3 recovery detection plus §4.1 honest labels.**

Together they answer the question the plan correctly identifies as the only
one that matters — *does Agent Trim reduce cost per verified success, or just
per tool result?* — for a few hundred lines and zero provider spend. Every
other decision, including whether the current aggressive defaults are
justified at all, becomes evidence-driven afterward.

There is a real possibility that the answer is uncomfortable: the cited paper
found a 38% token reduction *raising* cost by 6.8%. If our own telemetry says
that, the correct `0.5.0` is looser defaults, not more features. Building
measurement before machinery is what keeps that outcome discoverable.

---

## Sources

- [Token Reduction Is Not Cost Reduction (arXiv:2607.12161)](https://arxiv.org/abs/2607.12161)
- [On the Impact of AGENTS.md Files (arXiv:2601.20404)](https://arxiv.org/abs/2601.20404)
- [TVCACHE (arXiv:2602.10986)](https://arxiv.org/abs/2602.10986)
- [Don't Break the Cache (arXiv:2601.06007)](https://arxiv.org/abs/2601.06007)
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Claude Code settings reference](https://code.claude.com/docs/en/settings)
- [CLAUDE_ENV_FILE not provided to SessionStart hooks (#15840)](https://github.com/anthropics/claude-code/issues/15840)
- [CLAUDE_ENV_FILE missing for plugin-installed hooks (#11649)](https://github.com/anthropics/claude-code/issues/11649)
- [CLAUDE_ENV_FILE documentation contradiction (#19357)](https://github.com/anthropics/claude-code/issues/19357)
- [contractpal/palsync](https://github.com/contractpal/palsync) — `docs/agent-trim-interop.md`, `src/launcher/claudeHooks.js`, `src/mcp/envelope.js`
