# Agent Trim Improvement Program

**Build specification for a coding agent**  
**Repository:** `MasterWushi/agent-trim`  
**Research date:** July 25, 2026  
**Primary runtimes:** Claude Code and Pi  
**Secondary runtimes:** Codex CLI and OpenCode  
**Target release line:** `0.4.x` through `1.0.0`

---

## 1. Mission

Improve Agent Trim so it reduces the **total cost of completing coding tasks successfully**, not merely the number of bytes visible in individual tool results.

The implementation must preserve Agent Trim's strongest properties:

1. **Local and deterministic.** No model calls, remote service, daemon, proxy, or opaque ML component is required for core operation.
2. **Fail open.** Any parser, hook, filesystem, state, or compatibility failure must pass the host result through unchanged.
3. **Source-code safety.** Built-in source-file reads must remain byte-exact unless the user explicitly invokes a separate outline/signature command.
4. **Cache safety.** Never rewrite or prune tool results that have already entered conversation history.
5. **Evidence preservation.** Every lossy transformation must preserve actionable diagnostics and provide a deterministic recovery path to the observed full result.
6. **Host contract preservation.** Preserve typed result fields, errors, non-text blocks, metadata, and output shapes.
7. **Monotonic selection.** Do not apply a candidate representation unless it is smaller under the configured local estimator and clears a minimum safety margin.
8. **No semantic shell changes by default.** Environment quieting may remove presentation noise; command rewriting remains experimental and opt-in.
9. **Privacy.** Metrics must not store raw prompts, raw tool outputs, repository paths, or command arguments by default.
10. **Proof before defaults.** No aggressive feature becomes default-on based only on fixture compression ratios.

### The optimization objective

Use this as the project's governing equation:

```text
primary metric = total provider-billed cost / verified successful task
```

When provider billing is unavailable, use this evidence hierarchy in descending order:

```text
verified success
→ provider-reported usage and cache counters
→ model calls / turns / tool calls / reruns
→ model-visible estimated tokens
→ bytes and lines
```

A feature that removes 40% of a tool result but causes one extra model turn, reread, failed patch, or test rerun may be a net loss. Treat compression ratio as a component metric, never as the final product metric.

---

## 2. Current baseline and gaps

Agent Trim already has a strong core and should be extended rather than redesigned from scratch.

### Existing strengths to preserve

- ANSI and terminal escape removal.
- Carriage-return/progress-bar collapse.
- Whitespace cleanup.
- Exact repeated-line folding.
- Same-shaped log-line folding.
- Failure-aware caps with all detected errors and warnings retained.
- Content sidecars with line-numbered digests.
- Structured strategies for several test runners, compilers, audits, JSONL, and diff statistics.
- Prompt-aware completeness carve-outs and prompt-named identifier preservation.
- Context-pressure scaling.
- Claude narration and subagent controls.
- Pi typed `details` and `isError` preservation.
- Local metrics, benchmark fixtures, and fail-open adapters.

### Concrete gaps found in the current repository

1. **The project measures component compression better than end-to-end outcomes.** There is no paired benchmark system that captures success, billed usage, cache traffic, extra turns, rereads, or cost per successful task.
2. **The duplicate metric is mislabeled.** The current duplicate detector strips ANSI, replaces timestamps, and normalizes whitespace before hashing. That is useful as a similarity metric, but it is not byte-exact duplication.
3. **Claude's hook matcher omits MCP results.** The current Claude installer matches `Bash|Read`, while current Claude Code hooks can match `mcp__...` tools and replace their output before it reaches the model.
4. **Sidecar identity is weaker than its metadata.** Sidecars use a short non-cryptographic filename hash while SHA-256 is only recorded in metadata; an existing object is not verified before reuse.
5. **Presentation noise is removed after execution rather than prevented where possible.** `NO_COLOR`, pager suppression, and related environment controls can reduce output before host truncation or hook work.
6. **The current 32-byte application threshold is not token-aware.** Bytes remain a reasonable zero-dependency proxy, but dense logs, source-like text, prose, Unicode, and JSON have materially different token densities.
7. **Agent Trim does not reduce avoidable model wakeups.** A deterministic lint/typecheck/test sequence still generally creates one tool result and one reasoning opportunity per command.
8. **There is little visibility into always-loaded context.** Instruction files, skills, tool descriptions, and MCP tool inventories can cost more than many individual command outputs.
9. **No formal transformation contract exists.** Human-readable markers contain the guarantees, but adapters and metrics would be safer if they consumed a shared machine-readable preservation contract.
10. **No feedback controller reacts to costly recovery behavior.** Metrics can detect duplicate output, but policy does not loosen after likely rereads or reruns caused by lossy trimming.

---

## 3. Research conclusions that constrain the design

### 3.1 Token reduction is not sufficient evidence

Recent provider-billed coding-agent experiments found that removing raw tool-output tokens can still increase total cost when compression changes behavior, causes retrieval, adds turns, or damages exact edit anchors. Therefore:

- Never use raw source-code compression as a default feature.
- Measure retries, rereads, patch failures, compactions, and total trajectory length.
- Gate defaults on verified task success and cost per successful task.
- Keep raw evidence locally recoverable.

### 3.2 Hooks should operate before content enters history

Agent Trim's PostToolUse placement is fundamentally correct. Once a transformed result enters conversation history, it participates in prefix caching. Retroactively changing it can invalidate cache reuse and produce a larger recomputation. Therefore:

- Do not use Pi's `context` event to prune old messages.
- Do not rewrite historical transcripts.
- Do not perform post-compaction retroactive trimming.
- Keep model-visible output deterministic: no timestamps, random IDs, or unstable path aliases in markers.

### 3.3 Tool definitions and always-loaded instructions matter

Tool definitions and system instructions sit near the beginning of the request prefix. Changing active tools or modifying stable instructions during a session can invalidate large cache regions. Therefore:

- Agent Trim may **audit** tool and instruction footprint.
- Agent Trim must not dynamically toggle tools by default.
- Recommend host-native deferred tool loading or narrower subagent tool scopes rather than silently changing tool inventories.
- Keep retrieval functionality out of the permanent tool list unless the measured benefit exceeds the tool-definition overhead.

### 3.4 Reversible compression is preferable to blind truncation

A lossy digest can be safe when:

- the observed raw output is stored first;
- the artifact is integrity-checked;
- the digest contains real line numbers;
- signal categories and completeness are explicit;
- retrieval is possible with an existing Read/Bash capability;
- the artifact lifetime and host-truncation status are honest.

### 3.5 Structured output beats generic text only when the parser is proven

Machine-readable command formats can be dramatically smaller and easier to summarize, but command rewriting or parser errors can change semantics. Therefore:

- Add strategies from observed metrics, not from a long wish list.
- Every strategy needs real fixtures, malformed-input fallbacks, signal-preservation tests, and an end-to-end benchmark.
- Keep command rewriting behind an allowlist and feature flag.

### 3.6 Runtimes expose different safe surfaces

- Claude Code currently supports `SessionStart`, `InstructionsLoaded`, `PostToolUse`, `PostToolBatch`, `SubagentStart/Stop`, and compaction lifecycle hooks. It can replace tool results with `updatedToolOutput` when the replacement matches the expected shape.
- Pi exposes tool-call mutation, tool-result replacement, structured system-prompt inputs, provider-payload observation, custom compaction, branch/session inspection, and usage data.
- Codex and OpenCode hook coverage is still more uneven. Do not make their limitations dictate Claude/Pi architecture; retain thin adapters and fail open.

---

## 4. Target architecture

Do not turn `bin/trim-core.js` into a larger monolith. Introduce explicit contracts and modules while retaining CommonJS and zero runtime dependencies unless the repository intentionally migrates later.

### 4.1 Proposed repository structure

Existing paths should be modified where noted. New paths may be adjusted to match repository conventions, but keep the responsibility boundaries.

```text
bin/
  trim-core.js                    # orchestration; keep public API compatible
  trim-stats.js                   # consume metrics v1 and v2
  agent-trim.js                   # new CLI dispatcher
  trim-checks.js                  # deterministic validation batch runner
  trim-retrieve.js                # artifact lookup/range retrieval
  trim-doctor-context.js          # context/instruction/tool footprint audit
  lib/
    result-contract.js            # normalized transform/preservation contract
    artifact-store.js             # SHA-256 objects, metadata, TTL, verification
    token-estimate.js             # calibrated zero-dependency estimator
    identifiers.js                # bounded exact identifier extraction
    duplicate-detect.js           # byte-exact and normalized metrics
    recovery-detect.js            # likely reread/rerun detection
    metrics-v2.js                 # schema, append, migration, redaction
    command-shape.js              # conservative shell parsing/classification
    check-config.js               # validation profile loading and validation
    cache-observer.js             # stable hashes/counts only; no payload content
    safe-path.js                  # symlink-safe paths, permissions, sanitization
    atomic-write.js               # shared atomic file writer

adapters/
  claude-posttooluse.js           # extend to typed MCP text blocks
  claude-sessionstart-env.js      # source-side quiet environment
  claude-instructions-loaded.js   # footprint metrics only
  claude-posttoolbatch.js         # metrics only initially
  claude-subagent-brief.js        # bounded result contract
  claude-postcompact.js           # reconcile/reset state and inspect summary
  claude-sessionstart-ledger.js   # optional compact-resume ledger injection
  pi-trim.ts                      # register new events; keep wiring thin
  lib/
    claude-result-shapes.js       # shape-preserving transformations
    mcp-result.js                 # mixed MCP content handling
    pi-runtime.js                 # core Pi state transitions
    provider-observer.js          # Pi hashes/counts only

schemas/
  metrics-v2.schema.json
  sidecar-meta-v3.schema.json
  checks-config.schema.json

bench/
  fixtures/
    mcp/
    artifact-store/
    token-estimate/
    command-shapes/
  e2e/
    README.md
    tasks/
    runners/
    manifests/
    reports/                      # generated reports ignored except curated results

docs/
  architecture.md
  evidence.md
  checks.md
  context-doctor.md
  mcp.md
  security.md
  compatibility.md
```

### 4.2 Core transformation contract

Every strategy, generic transform, and adapter must use one shared return shape.

```js
/**
 * @typedef {Object} TransformResult
 * @property {string} output
 * @property {boolean} changed
 * @property {'lossless'|'lossy'|'none'} lossiness
 * @property {string} strategy
 * @property {number} inputBytes
 * @property {number} outputBytes
 * @property {number|null} inputTokenEstimate
 * @property {number|null} outputTokenEstimate
 * @property {boolean} hostComplete
 * @property {boolean} semanticComplete
 * @property {Object} preservation
 * @property {number} preservation.errorsObserved
 * @property {number} preservation.errorsPreserved
 * @property {number} preservation.warningsObserved
 * @property {number} preservation.warningsPreserved
 * @property {string[]} preservation.categories
 * @property {string[]} preservation.identifiers
 * @property {Object|null} artifact
 * @property {string|null} artifact.sha256
 * @property {string|null} artifact.path
 * @property {string|null} artifact.id
 * @property {string[]} reasons
 */
```

Rules:

- `hostComplete=false` means Agent Trim did not receive the full host result. No marker may claim the artifact is complete.
- `semanticComplete=true` may only be used by a structured strategy that can prove every relevant record was represented.
- `lossless` means the model-visible form is mechanically reversible from itself or the exact artifact; if an artifact is required, say so in `reasons`.
- `lossy` requires an artifact when `hostComplete=true`, unless the user explicitly disables sidecars.
- Adapters may change only text-bearing fields. Every other field must be copied exactly.
- Marker rendering must be a pure function of this contract.

### 4.3 Metrics schema v2

Create a versioned, append-only JSONL schema. Do not delete v1 support.

Minimum event fields:

```json
{
  "schema": "agent-trim/metrics/2",
  "at": "2026-07-25T00:00:00.000Z",
  "runtime": "claude",
  "sessionHash": "sha256:...",
  "compactionEpoch": 0,
  "toolName": "Bash",
  "toolFamily": "test",
  "commandFingerprint": {
    "program": "npm",
    "hash": "sha256:..."
  },
  "strategy": "vitest-json",
  "applied": true,
  "lossiness": "lossy",
  "hostComplete": true,
  "inputBytes": 120000,
  "outputBytes": 2400,
  "inputTokenEstimate": 43000,
  "outputTokenEstimate": 850,
  "signals": {
    "errorsObserved": 2,
    "errorsPreserved": 2,
    "warningsObserved": 4,
    "warningsPreserved": 4
  },
  "artifact": {
    "sha256": "sha256:...",
    "created": true
  },
  "duplicates": {
    "byteExact": false,
    "normalized": true,
    "ageMs": 12000
  },
  "recovery": {
    "candidate": false,
    "kind": null,
    "priorEventHash": null
  },
  "timingMs": 3.4
}
```

Privacy rules:

- Hash session IDs before logging.
- Keep only the command's first executable token plus a keyed or salted hash of the normalized full command.
- Never log raw command arguments, output, prompt, repository path, file path, or extracted identifiers.
- Allow an explicit debug mode to write richer local data, clearly separated from default metrics.
- Use stable model-visible text but real timestamps may remain in local metrics because they never enter the prompt.

---

## 5. Feature flags and rollout defaults

Use flags so releases can ship measurement before behavior.

| Variable | Initial default | Purpose |
|---|---:|---|
| `TRIM_METRICS_V2` | `on` | New metrics schema; retain v1 reader compatibility |
| `TRIM_PLAIN_ENV` | `on` after compatibility tests | Set safe no-color/pager environment |
| `TRIM_TERM_DUMB` | `off` | Add `TERM=dumb`; higher compatibility risk |
| `TRIM_MCP` | `observe` | `off`, `observe`, or `on` for MCP result transforms |
| `TRIM_TOKEN_ESTIMATOR` | `class` | `bytes`, `class`, optional host/tokenizer adapter |
| `TRIM_NET_WIN_TOKENS` | `24` | Estimated minimum saving before rewrite |
| `TRIM_ARTIFACT_STORE` | `v3` | Verified SHA-256 artifact store |
| `TRIM_IDENTIFIER_FACTSHEET` | `on` | Bounded exact identifiers in lossy digests |
| `TRIM_CHECKS_CONFIG` | auto-discover | Path to deterministic check profiles |
| `TRIM_CONTEXT_AUDIT` | `metrics` | `off`, `metrics`, or explicit CLI report |
| `TRIM_LEDGER` | `off` | Compaction preservation ledger experiment |
| `TRIM_DUP_REF` | `off` | Exact active-result references experiment |
| `TRIM_COMMAND_REWRITE` | `off` | Conservative command-source shaping experiment |
| `TRIM_ADAPTIVE_RECOVERY` | `observe` | Learn likely reread/rerun behavior before acting |

Do not overload `TRIM_OFF=1`; it must continue to bypass all transformations for one command or session as it does now.

---

## 6. Phase 0 — Measurement and safety foundation

**Release target:** `0.4.0`  
**Required before any aggressive feature becomes default-on.**

### 6.1 Fix duplicate terminology and implementation

Current normalized duplicate detection is useful, but it must not be called exact.

#### Implement

In the existing duplicate module or new `bin/lib/duplicate-detect.js`:

```js
function rawSha256(bufferOrString) {
  return crypto.createHash('sha256').update(bufferOrString).digest('hex');
}

function normalizedSha256(text) {
  return crypto.createHash('sha256').update(normalizeForSimilarity(text)).digest('hex');
}
```

Track two independent values:

- `byteExact`: SHA-256 of the untouched result bytes or exact UTF-8 string presented to the adapter.
- `normalized`: current behavior after ANSI, timestamp, and whitespace normalization.

Also record:

- tool name;
- result shape fingerprint;
- compaction epoch;
- age since prior match;
- whether the earlier event is known to remain active in the current branch/context.

#### Do not

- Replace duplicate output yet.
- Treat timestamp-normalized results as interchangeable.
- Share duplicate state across sessions, forks, or compaction epochs.

#### Tests

1. Same bytes twice: both flags true on second result.
2. Same text with different timestamp: only `normalized=true`.
3. Same text with different whitespace: only `normalized=true`.
4. Same output with different `isError` or typed shape: content match is recorded, but result-contract match is false.
5. State resets on compaction, switch, fork, and session end.
6. Parallel hook writes cannot corrupt the bounded ring.

### 6.2 Introduce metrics v2

#### Implement

- Add a schema and a single `appendMetricV2()` path.
- Update every adapter to produce the same event shape.
- Update `trim-stats.js` to read mixed v1/v2 files.
- Add a migration-free approach: never rewrite existing JSONL; normalize at read time.
- Add report sections for:
  - component bytes and estimated tokens saved;
  - lossless versus lossy transformations;
  - host-truncated results;
  - strategies and runtimes;
  - byte-exact and normalized duplicate incidence;
  - probable rereads/reruns;
  - sidecar creation and retrieval;
  - transform latency;
  - evidence level.

#### Evidence-level labels

Use these labels in reports:

| Level | Meaning |
|---|---|
| `L1-component` | bytes/lines/token estimate changed |
| `L2-preservation` | diagnostics/identifiers/artifacts verified |
| `L3-context` | host/model-visible payload verified |
| `L4-activation` | feature used during a real task |
| `L5-task` | task verifier passed |
| `L6-billing` | provider usage/cost captured |
| `L7-success-cost` | cost per successful task compared |
| `L8-trajectory` | turns, retries, rereads, failures explained |

Never print a project-wide savings percentage without naming its evidence level.

### 6.3 Build the end-to-end benchmark harness

Create `bench/e2e/` as a provider-agnostic runner framework. It may use Python for orchestration if that keeps process management and statistics simpler; core Agent Trim must remain dependency-free.

#### Task manifest format

```json
{
  "id": "js-failing-test-fix-001",
  "repository": {
    "fixture": "fixtures/repos/js-failing-test-fix-001.tar.zst",
    "sha256": "..."
  },
  "prompt": "Fix the failing authentication test without changing its expected behavior.",
  "timeoutSeconds": 900,
  "verifier": {
    "command": ["npm", "test", "--", "auth.test.ts"],
    "expectedExit": 0
  },
  "tags": ["edit-anchor", "failing-test", "typescript"],
  "expectedToolFamilies": ["read", "search", "test", "edit"]
}
```

#### Required task categories

Create at least 20 representative tasks before default-on release decisions:

1. Large passing build log.
2. Large failing build log with buried diagnostics.
3. Test runner with assertion diff.
4. Compiler with multi-line code frame.
5. Exact source edit requiring stable string anchors.
6. Generated lockfile or bundle inspection.
7. Large JSON MCP result.
8. Mixed MCP result with text plus non-text blocks.
9. Repository search with many matches.
10. User explicitly asks for every warning/result.
11. Prompt names an exact diagnostic code or identifier.
12. Repeated unchanged file read.
13. Repeated changed file read.
14. Long session that triggers compaction.
15. Subagent exploration returning many findings.
16. Deterministic lint/typecheck/test validation sequence.
17. Host-truncated shell output.
18. Unicode/CJK-heavy output.
19. Minified one-line content.
20. Command that produces no output or tiny output.

Synthetic repeated-line fixtures remain useful for unit tests, but they cannot dominate end-to-end release claims.

#### Experimental design

For each feature comparison:

- Use the same pinned repository fixture and task prompt.
- Use a fresh worktree and fresh agent session per trial.
- Pin model, effort/thinking level, runtime version, instructions, tool inventory, permissions, and timeout.
- Randomize baseline/feature order within task blocks.
- Run at least 3 repetitions for smoke testing.
- Run at least 5 repetitions across at least 20 tasks before enabling a behavioral feature by default.
- Store raw private trajectories outside committed reports; commit sanitized aggregate reports and hashes.
- Record interruptions, rate limits, provider failures, and invalid trials separately; do not silently drop them.

#### Required observations

Capture when available:

```text
verified success/failure
provider input tokens
provider cached input tokens
provider cache-write tokens
provider output tokens
reasoning tokens
reported or calculated cost
model calls
assistant turns
shell/read/search/edit/tool calls
same-command reruns
same-file rereads
sidecar retrievals
compactions
patch failures
verifier retries
wall time
peak context usage
```

For Claude subscription plans where authoritative per-run dollar cost is unavailable, report provider token categories and usage counters without inventing a dollar or plan-quota conversion.

#### Release gate

A feature may become default-on only when all are true:

1. Unit and fixture preservation tests pass.
2. It is activated in meaningful end-to-end tasks.
3. Verified task success is non-inferior to baseline.
4. Median cost per successful task improves or is neutral within measurement noise.
5. It does not materially increase rereads, reruns, turns, or patch failures.
6. Any harmful task category is understood and carved out.
7. Results are reproducible from a committed manifest.

Practical default thresholds for a small OSS project:

- Do not default-enable a feature if median turns or cost per successful task rises by more than 5% in the release suite.
- Do not default-enable it if any source-edit category shows a repeated quality regression.
- If confidence is weak, ship as `observe` or opt-in instead of claiming a win.

### 6.4 Add trajectory recovery detection

Create a deterministic observer that identifies likely recovery behavior without assuming causality.

#### Candidate signals

- Same command fingerprint repeated within the next 1–5 tool results.
- Same file read again with the same range and unchanged byte hash.
- Sidecar artifact read shortly after a lossy digest.
- User/model reruns with `TRIM_OFF=1` after a compressed result.
- Test command repeated without intervening file changes.
- Search repeated with equivalent query and repository state.

Record `recovery.candidate=true` and a kind such as:

```text
same-command
same-read
artifact-retrieval
trim-bypass-rerun
unchanged-validation
```

Do not call every repeat a compression failure. The end-to-end analysis should correlate the repeat with the immediately preceding transformed result, feature flags, and intervening state changes.

### 6.5 Phase 0 definition of done

- [ ] Mixed metrics v1/v2 files produce a valid report.
- [ ] Current normalized duplicate counts are relabeled and byte-exact counts exist.
- [ ] No raw prompt/output/path leaks into default metrics fixtures.
- [ ] At least 20 end-to-end task manifests exist.
- [ ] At least Claude Code and Pi runners can produce sanitized reports.
- [ ] Reports include success, trajectory, cache/usage categories where available, and component compression.
- [ ] CI runs unit/fixture gates; end-to-end suites run manually or on an explicit workflow due provider cost.
- [ ] `docs/evidence.md` explains exactly what every published number means.

---

## 7. Phase 1 — Safe, broad savings

**Release target:** `0.5.x`

### 7.1 Verified artifact store v3

Replace sidecar identity and integrity handling while maintaining compatibility with existing sidecar readers such as PalSync.

#### Storage layout

```text
$TMPDIR/agent-trim/
  objects/
    sha256/
      ab/
        abcdef...fullhash.txt
        abcdef...fullhash.meta.json
  aliases/
    <legacy-session-prefix>-<legacy-cheaphash>.txt
  index/
    sessions/<hashed-session-id>.json
```

The canonical object path must be based on full SHA-256. A legacy flat alias may point to or contain the same object only if required for compatibility.

#### Write algorithm

1. Receive the exact observed cleaned text and `hostComplete` state.
2. Compute SHA-256 before creating model-visible output.
3. Create the object directory with restrictive permissions.
4. If the canonical object exists:
   - reject symlinks;
   - read and hash it;
   - reuse only if bytes match;
   - otherwise fail open and use a collision/corruption-safe alternate path while logging a local warning.
5. Write to a same-directory temporary file using exclusive creation.
6. Set file mode `0600` where supported.
7. `fsync` if practical, then atomically rename.
8. Write metadata atomically after the object exists.
9. Generate aliases only after canonical verification.
10. If any step fails, fall back to inline output without blocking the tool result.

#### Metadata schema v3

```json
{
  "schema": "agent-trim/sidecar-meta/3",
  "sha256": "sha256:...",
  "bytesObserved": 12345,
  "linesObserved": 250,
  "contentStatus": "complete-cleaned",
  "hostComplete": true,
  "runtime": "claude",
  "createdAt": "2026-07-25T00:00:00.000Z",
  "expiresAt": "2026-07-28T00:00:00.000Z",
  "diagnostics": {
    "errors": 2,
    "warnings": 3
  },
  "identifiers": {
    "count": 4
  },
  "compatibilityAliases": ["..."],
  "format": "utf8-text"
}
```

`contentStatus` values:

- `complete-cleaned`: Agent Trim received the complete host result and stored its losslessly cleaned form.
- `host-truncated`: the host may have truncated before the hook.
- `binary-unsupported`: no text artifact was written.

#### Retrieval CLI

Add a unified CLI entrypoint:

```bash
agent-trim retrieve <sha-or-id>
agent-trim retrieve <sha-or-id> --lines 120:180
agent-trim retrieve <sha-or-id> --around 147 --context 20
agent-trim retrieve <sha-or-id> --meta
```

Requirements:

- Resolve only inside the artifact root.
- Reject traversal, symlinks, directories, and malformed IDs.
- Verify SHA-256 before returning content.
- Preserve exact line numbers.
- Exit nonzero with a concise rerun instruction if expired or corrupt.
- Never add a permanent MCP tool by default; Claude and Pi already have Read/Bash paths that can invoke this CLI.

#### TTL behavior

- Keep the existing 72-hour default unless benchmarks show longer sessions need more.
- Sweep a bounded number of entries per write.
- Delete canonical objects only when no live alias/session index references them, or simply tolerate duplicate objects until TTL for simplicity.
- Never include current time in model-visible marker text; use stable statements such as “temporary artifact.”

#### Tests

- Existing object with matching bytes.
- Existing object with mismatched bytes.
- Hash collision simulation via injected hash function.
- Symlink at object and alias paths.
- Concurrent writes.
- Interrupted temporary write.
- Read-only temp directory.
- Windows path and rename behavior.
- Host-truncated metadata never claims completeness.
- Legacy metadata v1/v2 reader compatibility.

### 7.2 Source-side quiet environment

Prevent avoidable presentation bytes before the command runs.

#### Safe default environment

```bash
NO_COLOR=1
CLICOLOR=0
FORCE_COLOR=0
PAGER=cat
GIT_PAGER=cat
GH_PAGER=cat
```

Do **not** set these by default:

```bash
TERM=dumb       # opt-in; can change program behavior
CI=1            # opt-in; can change tests/builds/watch modes
```

#### Claude implementation

Add a `SessionStart` command hook that appends exports to `CLAUDE_ENV_FILE` when `TRIM_PLAIN_ENV` is not `off`.

Requirements:

- Use append mode so other hooks are preserved.
- Add a stable sentinel comment and do not duplicate the block in one env file.
- Quote values safely.
- Support SessionStart reasons `startup`, `resume`, `clear`, `compact`, and `fork` as needed.
- Do not modify `.bashrc`, `.zshrc`, project `.env`, or the user's shell profile.

#### Pi implementation

Prefer a safe per-tool environment mechanism if Pi exposes one. If command mutation is required:

- modify only built-in `bash` calls;
- prepend portable `env KEY=value ...` only when the command shape supports it;
- do not wrap commands containing shell functions, heredocs, platform-specific shells, or explicit environment assignments until tested;
- never alter the visible permission meaning of a dangerous command;
- retain the original command in local state for metrics but do not log it raw.

An even safer Pi approach is to document a launcher environment and add a diagnostic command that reports missing quiet variables. Choose the least invasive method that passes cross-platform tests.

#### Compatibility carve-outs

Allow project-level and per-command bypasses:

```bash
TRIM_PLAIN_ENV=off
TRIM_COLOR=1 <command>       # explicit preservation convention if implemented
TRIM_OFF=1 <command>
```

If a command explicitly sets `FORCE_COLOR`, `NO_COLOR`, `TERM`, or a pager, respect the command's explicit choice.

#### Acceptance criteria

- Color/progress fixture output becomes smaller before `trim-core` processing.
- Snapshot and terminal-detection fixtures behave identically unless `TRIM_TERM_DUMB=1` is enabled.
- Git and GitHub CLI never invoke interactive pagers under the default environment.
- Permission prompts still display the recognizable original command or semantically equivalent environment-prefixed command.
- End-to-end tests show no increase in failed commands.

### 7.3 Calibrated net-win selector

Replace the fixed “32 bytes smaller” decision as the only gate with a zero-dependency content-class estimator plus a byte safety floor.

#### Estimator classes

Implement deterministic classification:

| Class | Examples | Initial estimate |
|---|---|---:|
| `dense` | stack traces, JSON, paths, hashes, minified data | chars / 2.0 |
| `code` | source, compiler frames, diffs | chars / 2.5–3.0 |
| `mixed` | ordinary CLI output | chars / 3.2 |
| `prose` | sentences and documentation | chars / 3.7–4.0 |
| `cjk` | high proportion of CJK code points | code-point-aware conservative estimate |

These are estimates, not provider token counts. Calibrate them against a committed multilingual fixture corpus and optional local tokenizers.

#### Selection rule

```js
const byteWin = inputBytes - outputBytes;
const estimatedTokenWin = inputTokens - outputTokens;
const select =
  byteWin >= MIN_BYTE_WIN &&
  estimatedTokenWin >= TRIM_NET_WIN_TOKENS;
```

Defaults:

```text
MIN_BYTE_WIN = 32
TRIM_NET_WIN_TOKENS = 24
```

Use the original unchanged result when estimates are equal, negative, unavailable, or suspicious.

#### Optional tokenizer adapters

Allow but do not require adapters such as:

```text
TRIM_TOKENIZER=off
TRIM_TOKENIZER=auto
TRIM_TOKENIZER=o200k_base
TRIM_TOKENIZER=/absolute/path/to/local-counter
```

Rules:

- No network calls.
- No core dependency.
- Timeout quickly and fail back to the class estimator.
- Never call the provider's token-count endpoint from a hook.
- Report exact/local/estimated provenance separately.

#### Tests

- Candidate with fewer bytes but more estimated tokens is rejected.
- Tiny marker overhead is rejected.
- CJK and emoji fixtures do not report impossible savings.
- Estimator is deterministic across Node versions supported by the project.
- Optional counter failure passes through without blocking.

### 7.4 Shared completeness and marker contract

Replace ad hoc marker strings with a renderer driven by `TransformResult`.

#### Example model-visible marker

```text
[trim hook: 812 lines were reduced to this view. The observed result contained
2 errors and 4 warnings; all 6 matching diagnostic lines are present below.
The complete observed text is stored as artifact sha256:abcd… and can be read
with `agent-trim retrieve sha256:abcd… --lines A:B`. Host completeness: verified.]
```

For host-truncated input:

```text
[trim hook: this digest covers the output Agent Trim received, but the host may
have truncated it first. The artifact is complete only for the observed text.]
```

Rules:

- Never claim “all errors” unless the signal detector counted and retained every matching line.
- Say “matching diagnostic lines,” not “all possible problems,” because heuristic detection is not semantic proof.
- Do not put raw untrusted tool output inside the marker header.
- Sanitize paths and control characters.
- Keep markers short enough that they still clear the net-win gate.
- Marker wording and ordering must be deterministic.

### 7.5 Bounded identifier factsheet

Extend prompt-named relevance with exact identifier preservation for lossy transformations.

#### Candidate identifier categories

- file paths containing a directory separator or recognized extension;
- compiler/test diagnostic codes such as `TS2345`, `E0308`, `W1042`;
- Git SHAs of 7–40 hex characters when context indicates Git;
- UUIDs;
- semantic versions;
- issue/ticket keys such as `ABC-123`;
- test names in structured test output;
- explicitly quoted/backticked prompt terms.

#### Safety bounds

```text
maximum facts: 16
maximum total characters: 512
maximum single fact: 120
minimum discriminating length: 3
```

- Deduplicate while preserving first occurrence.
- Reject common tokens and timestamps.
- Keep exact case and punctuation.
- Prefer prompt-named identifiers, then diagnostic codes, paths, test names, versions, and IDs.
- Include line numbers where available.
- Never use this feature to justify automatic source-code truncation.

#### Tests

- Exact Git SHA survives a lossy log digest.
- Timestamp-like hex/numeric strings do not flood the factsheet.
- Secret-looking tokens are not specially extracted. Agent Trim must not amplify potentially sensitive values into a header.
- Prompt-named identifier wins when the cap is full.
- Unicode file paths survive exactly.

### 7.6 Claude MCP result compression

This is one of the largest safe coverage expansions because current Claude Code exposes MCP tools as ordinary PostToolUse events, while Agent Trim's current matcher only covers Bash and Read.

#### Installer change

Change the Claude PostToolUse matcher from:

```text
^(Bash|Read)$
```

to a version-compatible matcher such as:

```text
^(Bash|Read|mcp__.*)$
```

Keep the adapter's own allow/deny logic; do not rely on the matcher as the only guard.

#### MCP result model

MCP tool results may contain:

- `content` arrays;
- text blocks;
- images;
- audio;
- resource links;
- embedded text or blob resources;
- `structuredContent`;
- `isError`;
- `_meta` and annotations.

#### Transformation rules

1. Copy the complete result object.
2. Transform only blocks with an exact recognized text-bearing shape.
3. Preserve images, audio, blobs, resource links, embedded resources, annotations, `_meta`, `structuredContent`, `isError`, and unknown fields exactly.
4. Preserve block order.
5. Never flatten mixed content into one string.
6. Never convert structured errors to successful text.
7. If any shape is ambiguous, pass the whole result through unchanged.
8. Apply a transform only if total model-visible size clears the net-win gate.
9. Use per-block and aggregate metrics without storing content.
10. Use `updatedToolOutput`, which current Claude Code documents as the preferred replacement field for all tool types.

#### Modes

```text
TRIM_MCP=off       # no observation or transformation
TRIM_MCP=observe   # metrics and fixtures only; return no replacement
TRIM_MCP=on        # transform eligible text blocks
```

Ship one release in `observe` mode before considering default-on behavior.

#### Per-server/tool policy

Support a simple configuration without requiring a parser dependency:

```text
TRIM_MCP_ALLOW_RE=^mcp__(github|filesystem|playwright)__
TRIM_MCP_DENY_RE=__(write|delete|create|update)
```

The default transformation decision must be based on result shape, not whether a tool is read-only. Read-only status matters for future duplicate references, not for compressing a result that already exists.

#### Structured-content mirror experiment

Some MCP servers return the same JSON both as `structuredContent` and serialized text. Add observation first:

- canonicalize only JSON values, not arbitrary text;
- compare canonical `structuredContent` to a parsed text block;
- record `structuredMirror=true` if they are equivalent;
- do not remove the text block until host fixtures prove Claude sends and understands retained `structuredContent` after replacement;
- if later enabled, preserve a concise statement that structured content remains present and keep error text.

This subfeature starts behind:

```text
TRIM_MCP_STRUCTURED_MIRROR=observe
```

#### Required fixtures

- Text-only success.
- Text-only error.
- Multiple text blocks.
- Text plus image.
- Text plus audio.
- Text plus resource link.
- Embedded text resource.
- Embedded blob resource.
- `structuredContent` plus identical JSON text.
- `structuredContent` plus non-identical explanatory text.
- Unknown future block type.
- Tool result containing injection-shaped text.
- Large GitHub search result.
- Large browser/accessibility result.
- Large database table result.

#### Acceptance criteria

- Non-text blocks are byte-for-byte/deep-equal unchanged.
- Unknown blocks cause safe passthrough or remain untouched while recognized text blocks are safely transformed; choose one behavior and test it consistently.
- `isError` and all metadata fields remain unchanged.
- No MCP tool call is blocked because the adapter failed.
- Real Claude fixture confirms `updatedToolOutput` is accepted for the tested MCP shape.
- End-to-end MCP tasks preserve solve rate and reduce successful-task cost or remain experimental.

### 7.7 Phase 1 definition of done

- [ ] Artifact store uses verified SHA-256 canonical objects and atomic writes.
- [ ] Retrieval CLI works with line ranges and refuses unsafe paths.
- [ ] Safe quiet environment is installed for Claude and a tested Pi approach exists.
- [ ] Class-aware net-win gate is active and reports estimator provenance.
- [ ] Shared preservation contract drives markers and metrics.
- [ ] Bounded identifier factsheet has adversarial tests.
- [ ] Claude MCP support has observe-mode telemetry and mixed-content fixtures.
- [ ] No default-on feature regresses the Phase 0 end-to-end release suite.

---

## 8. Phase 2 — Reduce model calls and repeated work

**Release target:** `0.6.x`

### 8.1 Unified Agent Trim CLI

Add `bin/agent-trim.js` and expose it from `package.json`:

```json
{
  "bin": {
    "agent-trim": "bin/agent-trim.js"
  }
}
```

Subcommands:

```text
agent-trim stats
agent-trim retrieve <id> [...]
agent-trim checks <profile> [...]
agent-trim verify --changed [...]
agent-trim doctor context [...]
agent-trim doctor runtime [...]
agent-trim config show
```

Requirements:

- Preserve existing `node bin/trim-stats.js` usage.
- No global install is required when running from a cloned repository; installer may create a small shim.
- Stable JSON output is available with `--json` for every diagnostic command.
- Human output goes to stdout; progress for batch execution goes to stderr so model-facing stdout can remain one compact result.

### 8.2 Deterministic validation batch runner

The goal is to replace multiple model-visible validation cycles with one explicit command result.

#### Configuration discovery

Search in this order:

```text
.agent-trim/checks.json
agent-trim.checks.json
package.json -> agentTrim.checks
```

Do not silently execute a profile discovered outside the current repository root.

#### Schema

```json
{
  "$schema": "https://example.invalid/agent-trim/checks-config.schema.json",
  "version": 1,
  "profiles": {
    "quick": {
      "description": "Fast checks after ordinary edits",
      "continueOnFailure": true,
      "commands": [
        {
          "name": "lint",
          "file": "npm",
          "args": ["run", "lint"],
          "timeoutSeconds": 120
        },
        {
          "name": "typecheck",
          "command": "npm run typecheck",
          "timeoutSeconds": 180
        },
        {
          "name": "tests",
          "file": "npm",
          "args": ["test", "--", "--runInBand"],
          "timeoutSeconds": 300
        }
      ]
    },
    "final": {
      "description": "Release-level verification",
      "continueOnFailure": false,
      "commands": [
        { "name": "lint", "file": "npm", "args": ["run", "lint"] },
        { "name": "typecheck", "file": "npm", "args": ["run", "typecheck"] },
        { "name": "test", "file": "npm", "args": ["test"] },
        { "name": "build", "file": "npm", "args": ["run", "build"] }
      ]
    }
  }
}
```

Support either:

- `file` plus `args`, preferred because it avoids shell interpretation; or
- `command`, executed through the platform shell.

Reject entries containing both.

#### Execution behavior

1. Resolve repository root and configuration.
2. Validate the entire profile before executing anything.
3. Run commands sequentially by default.
4. Print local progress to stderr:

```text
[1/3] lint
[2/3] typecheck
[3/3] tests
```

5. Capture combined, stdout, and stderr streams separately.
6. Preserve exit code, signal, timeout, and duration.
7. Write raw observed streams to the verified artifact store.
8. Apply Agent Trim strategies independently to each command output.
9. Return one stable model-visible summary on stdout.
10. Exit `0` only if profile success criteria pass; otherwise exit nonzero.
11. Respect `continueOnFailure`.
12. Forward Ctrl+C and terminate child processes cleanly.
13. Never run in the background by default.

#### Model-visible output

```text
agent-trim checks: quick

PASS  lint        2.1s   0 errors, 3 warnings
PASS  typecheck   4.8s   0 diagnostics
FAIL  tests       8.3s   2 failed, 184 passed

Failure details:
- auth.test.ts:42 — expected 401, received 200
- session.test.ts:88 — timed out after 5000 ms

Artifacts:
- tests stdout: sha256:...
- tests stderr: sha256:...

Overall exit: 1
```

Do not include passing output unless it contains warnings, requested completeness data, or a strategy-specific concise summary.

#### Integration guidance

Add one short line to the optional Agent Trim style/instruction block only when a checks profile exists:

```text
When validation requires several deterministic commands, prefer `agent-trim checks <profile>` so they run once and return one result; do not invent profiles.
```

Do not force the model to use it for debugging where individual command iteration is useful.

#### Security

- Configuration is code execution. Treat project configs as trusted only after the host's normal project trust flow.
- Do not auto-run profiles on install or session start.
- Show the exact command list in `agent-trim checks <profile> --dry-run`.
- Never interpolate model-generated variables into commands unless the schema explicitly supports and sanitizes them.
- Restrict working directories to the repository root or descendants.

#### Tests

- Passing sequence.
- Failing first command, stop-on-failure.
- Continue-on-failure.
- Timeout and signal handling.
- Spaces and Unicode in arguments.
- Shell-free command does not interpret metacharacters.
- Malformed config executes nothing.
- Artifact write failure still returns command evidence inline.
- Ctrl+C cleans child processes.
- Windows command execution.
- Strategy-specific summaries preserve every failure.

### 8.3 Changed-file verification command

Add:

```bash
agent-trim verify --changed
agent-trim verify --changed --profile quick
agent-trim verify --base HEAD~1
```

This command does not infer arbitrary checks. It maps changed files to explicitly configured commands.

Example configuration:

```json
{
  "changed": {
    "rules": [
      {
        "globs": ["src/**/*.ts", "test/**/*.ts"],
        "profile": "quick"
      },
      {
        "globs": ["docs/**/*.md"],
        "commands": [
          { "name": "markdown", "file": "npm", "args": ["run", "lint:md"] }
        ]
      }
    ]
  }
}
```

Requirements:

- Use Git to enumerate changed paths.
- Deduplicate commands matched by multiple files.
- Print the paths and selected checks under `--dry-run`.
- If no rule matches, return a clear no-op result and exit 0.
- Never guess a formatter/test command from package files in the execution path. A future `doctor` may recommend configuration, but execution must remain explicit.

### 8.4 Subagent return contracts

Agent Trim already injects a concise subagent brief. Make it more precise and measurable without blocking subagent completion.

#### New brief

```text
Your final message becomes a tool result in the parent context. Return findings only:
- conclusions first;
- exact file paths, line numbers, symbols, diagnostic codes, and commands needed by the parent;
- unresolved uncertainty and blockers;
- no greeting, plan recap, narration, or restatement of the task;
- do not paste large source/log blocks when a path and line range is sufficient.
```

Keep this one compact paragraph. Do not include a fixed word cap that could suppress necessary evidence.

#### Metrics

Use `SubagentStop` or available final-message fields to record:

- final report bytes/estimated tokens;
- number of paths/line references/diagnostic codes;
- whether the report contains repeated preamble;
- parent rereads shortly after the report;
- parent tool calls that repeat subagent exploration.

Start as observation only. Do not automatically rewrite a subagent's final report until fixtures prove the exact host result shape and end-to-end tasks demonstrate benefit.

### 8.5 Claude PostToolBatch metrics

Current Claude Code exposes a hook after all parallel tool calls resolve and before the next model call. Use it for **measurement only** in the first release.

Record:

- batch size;
- aggregate model-visible bytes;
- number of transformed results;
- duplicate hashes within the batch;
- tool-family mix;
- parallel versus sequential patterns when inferable;
- whether the next turn repeats or retrieves any result.

Do not inject aggregate context by default. An extra summary can itself cost tokens or confuse the model because the individual results are already present.

Only consider an aggregate batch census later if end-to-end evidence shows it prevents repeated follow-up calls.

### 8.6 Phase 2 definition of done

- [ ] Unified CLI is installed and documented.
- [ ] Check profiles validate before execution and support shell-free commands.
- [ ] One batch result preserves every failing command's actionable evidence.
- [ ] `verify --changed` runs only configured checks.
- [ ] Subagent contract is concise and fixture-tested.
- [ ] PostToolBatch metrics are recorded without model-visible additions.
- [ ] End-to-end validation tasks show fewer model calls or lower successful-task cost without solve-rate regression.

---

## 9. Phase 3 — Context footprint and compaction quality

**Release target:** `0.7.x`

### 9.1 Context doctor

Add an explicit diagnostic command:

```bash
agent-trim doctor context
agent-trim doctor context --json
agent-trim doctor context --runtime claude
agent-trim doctor context --runtime pi
```

This command reports likely always-loaded context costs and cache instability. It must not edit files automatically.

#### Local file audit

Inspect known instruction locations when they exist:

```text
~/.claude/CLAUDE.md
project CLAUDE.md files
.claude/rules/*.md
~/.pi/agent/AGENTS.md
project AGENTS.md files
known skill descriptions and metadata
Agent Trim's own injected style block
```

Report:

- byte count and estimated tokens;
- duplicate paragraphs or exact repeated blocks across files;
- files containing timestamps, generated dates, random IDs, volatile status, or absolute temporary paths;
- extremely long always-loaded sections;
- nested instruction files that overlap parent guidance;
- repeated generic behavior rules already supplied by the host;
- Agent Trim blocks and version markers;
- invalid/unclosed Agent Trim marker blocks.

Recommendations must be concrete but non-destructive:

```text
HIGH: ~/.claude/CLAUDE.md contains a generated timestamp that changes daily and may destabilize the prefix.
MEDIUM: 742 estimated tokens are repeated verbatim in two instruction files.
INFO: Move task-specific deployment instructions to a scoped rule or skill rather than global context.
```

Do not attempt generic prose deletion or automatically “compress” user-authored instructions. Research suggests useful repository instructions can improve coding-agent efficiency; the goal is relevance and stability, not minimum length at any cost.

#### Claude runtime observation

Register an `InstructionsLoaded` observer that records only:

- hashed path;
- scope/load reason;
- byte size when locally readable;
- content hash;
- session/compaction epoch.

This can reveal repeated lazy loads or dynamic content without logging instructions.

#### Pi runtime observation

At `before_agent_start`, Pi exposes structured prompt components. Record counts and estimated sizes for:

- selected tools;
- tool snippets;
- context files;
- skills;
- custom prompt;
- appended system prompt;
- total system prompt.

Do not replace the system prompt in the observer.

### 9.2 Cache-health observer

Create a privacy-preserving local profiler. It must observe and hash request components, never mutate provider payloads.

#### Pi implementation

Use `before_provider_request` for instrumentation only.

Compute stable hashes and counts for:

- serialized tool definitions;
- system instructions;
- message prefix excluding the newest exchange, when safely identifiable;
- selected model/provider;
- relevant provider cache settings;
- active skill/context inventory.

Log transitions:

```text
stable
model-changed
tools-changed
system-changed
prefix-diverged
unknown-shape
```

Never write the payload content to default metrics.

#### Claude implementation

Claude hooks do not expose the exact outgoing provider payload. Use available proxies:

- instruction file load hashes;
- transcript size and event order;
- tool configuration inventory from local config where safe;
- provider-reported usage/cache counters if available through session data;
- model and compaction changes.

Clearly label these as inferred cache-health indicators, not exact provider cache diagnostics.

#### Report

```bash
agent-trim stats --cache
```

Example:

```text
Cache stability observations
- 31 requests observed
- tool inventory stable: 31/31
- instruction inventory changed: 2 times
- model changed: 1 time
- compaction epochs: 1
- estimated always-loaded context: 8,420 tokens
- largest source: MCP tool definitions (estimated 4,900 tokens)
```

Do not translate cache counters into plan messages or subscription usage unless the provider publishes that mapping.

### 9.3 Tool footprint recommendations

Audit, do not automatically alter, active tool surfaces.

Report:

- tool count;
- estimated schema/description footprint when observable;
- MCP servers with many tools;
- tools never called in the observed session;
- tools repeatedly called through a broad parent when a scoped subagent might isolate them;
- host-native deferred-loading capability when available.

Recommendations may include:

- enable host-native tool search/deferred loading;
- scope an MCP server to a research subagent;
- disable unused servers in project configuration;
- shorten redundant tool descriptions at the server source;
- avoid changing tool inventories mid-session if cache stability is valuable.

Agent Trim must not silently remove, defer, or toggle tools.

### 9.4 Compaction preservation ledger

Compaction can discard exact state and trigger rediscovery. Build a bounded, deterministic ledger, but keep it experimental until it proves useful.

#### Ledger contents

Track only state likely to remain actionable after compaction:

- files edited;
- files read recently and relevant exact line ranges;
- unresolved diagnostic codes and test names;
- latest failing and passing validation profiles;
- current Git HEAD and worktree dirty status fingerprint;
- active sidecar artifact IDs;
- explicit user constraints detected from the current task, only when available from host events;
- pending decisions or blockers explicitly stated by the model/user.

Do not track:

- full source snippets;
- generic narration;
- speculative plans;
- secrets;
- stale state from unrelated sessions;
- a permanent cross-session memory by default.

#### Bounds

```text
max ledger entries: 40
max model-visible characters: 3000
max file entries: 20
max diagnostics: 12
max artifacts: 8
```

Use stable ordering and no timestamps in model-visible output.

#### Pi path

Pi allows custom compaction instructions or summaries.

Initial implementation:

- append a compact preservation brief to `session_before_compact.customInstructions`;
- do not replace Pi's full compaction summary initially;
- after compaction, compare retained state and record whether important ledger items disappeared;
- only offer a custom summary implementation after end-to-end proof.

#### Claude path

Current Claude PostCompact exposes the generated compact summary but does not itself replace it.

Use two hooks:

1. `PostCompact`: inspect the summary, reconcile state, reset pressure/duplicate epochs, and determine which bounded ledger items are absent.
2. `SessionStart` for the `compact` reason: inject at most one small, deterministic ledger supplement through the documented session-start context channel, but only if important exact items are missing.

Do not reinject the entire pre-compaction history. Do not include an item already represented in the compact summary.

#### Evaluation

Create long-session tasks where success after compaction depends on:

- exact test name;
- exact file and line range;
- unresolved diagnostic code;
- a previous validation result;
- a user constraint.

Measure rediscovery calls and total cost. Disable the ledger if its added prompt cost exceeds the calls it prevents.

### 9.5 Phase 3 definition of done

- [ ] Context doctor gives stable, actionable, non-destructive reports.
- [ ] Claude instruction-load and Pi prompt-component metrics contain hashes/counts only.
- [ ] Cache observer never modifies provider payloads.
- [ ] Tool footprint report distinguishes observation from provider-specific recommendations.
- [ ] Compaction ledger is bounded, deterministic, opt-in, and tested on long-session tasks.
- [ ] No cross-session memory is enabled by default.

---

## 10. Phase 4 — Experimental optimizations

**Release target:** `0.8.x` and later  
**All features in this phase start default-off.**

### 10.1 Exact active-result references

This is narrower and safer than semantic command caching. The command or read still executes; Agent Trim may replace the repeated model-visible content with a reference only when equivalence and context presence are proven.

#### Preconditions

All must be true:

1. Raw model-visible content is byte-identical by SHA-256.
2. Result shape and critical metadata match or current metadata can be preserved separately.
3. The operation is in a strictly supported class.
4. Source state is unchanged when that matters.
5. The original result is proven active in the current branch/context.
6. Both results are in the same compaction epoch.
7. The reference clears the net-win gate.
8. End-to-end evidence shows references do not trigger costly rereads.

#### Initial scope: Pi unchanged reads only

Pi exposes branch/session inspection, so start there.

Supported operation:

```text
built-in read of the same canonical path and exact range
```

Required source-state evidence:

- current file SHA-256;
- offset and limit;
- file stat identity as a secondary diagnostic, not sole proof;
- result byte SHA-256;
- original tool result ID is still in `getBranch()`.

Do not begin with Bash commands, Git state, remote requests, MCP results, searches, or generated data.

#### Reference form

```text
[trim hook: this Read result is byte-identical to active result <stable-short-id>
from this compaction epoch. Current file hash and requested range are unchanged.
The current Read succeeded; repeated content was omitted.]
```

Do not expose opaque host message IDs if they are unstable or sensitive. Derive a deterministic short reference from content hash plus epoch.

#### Claude status

Keep metrics-only until the adapter can prove the original result remains active after compaction/fork/resume. Transcript presence alone may not prove provider-active context after compaction.

#### Kill criteria

Disable or abandon this feature if:

- same-read recovery increases materially;
- models ask to see the original frequently;
- branch/context proof is unreliable;
- reference overhead is close to typical repeated result size;
- host changes make IDs or branch state unavailable.

### 10.2 Adaptive recovery controller

Use observed recovery behavior to tune lossy policy within one session. This is a deterministic state machine, not ML.

#### State per command/tool family

```json
{
  "family": "vitest",
  "lossyResults": 6,
  "likelyRecoveries": 2,
  "consecutiveRecoveries": 1,
  "capMultiplier": 1.5,
  "sidecarDigestMode": "expanded",
  "disabledUntilEpoch": false
}
```

#### Policy

- Begin with normal profile settings.
- After one likely recovery, record only.
- After two likely recoveries for the same family in one epoch, increase caps or include a larger signal sample.
- After three consecutive likely recoveries, disable lossy trimming for that family until compaction/session reset.
- Never reduce caps more aggressively based solely on lack of recovery.
- Do not adapt source reads, completeness/enumeration requests, or failures toward more aggressive compression.
- Expose state through `/trim-stats` and metrics.

Because recovery inference is imperfect, ship `TRIM_ADAPTIVE_RECOVERY=observe` first. Action mode needs paired benchmark evidence.

### 10.3 Conservative command-source shaping

Source shaping can produce machine-readable, quieter output, but it changes command input and therefore carries higher risk.

#### Scope

Only rewrite a command when all are true:

- `TRIM_COMMAND_REWRITE=on`;
- command is a single simple invocation;
- no pipes, redirects, command substitution, heredoc, shell function, `&&`, `||`, or semicolon;
- no conflicting user-specified option;
- recipe is explicitly allowlisted;
- parser/renderer has real fixtures;
- rewritten command preserves working directory, environment, permissions, exit semantics, and scope.

#### Candidate recipes

Begin with observation and dry-run recommendations:

```text
eslint          -> add a supported JSON formatter only if no formatter exists
tsc             -> add --pretty false only if pretty output is not explicitly requested
pytest          -> use a supported concise/machine format only with installed-compatible configuration
git             -> pager/color suppression via environment, not command rewrite
```

Do not add Cargo/rustc, Playwright, Gradle, Maven, Docker, or arbitrary package-manager recipes until metrics show they are top contributors and fixtures prove the parser.

#### Safety workflow

1. `agent-trim doctor runtime` reports eligible commands and expected recipe.
2. `TRIM_COMMAND_REWRITE=dry-run` records what would change.
3. Unit tests compare original versus rewritten exit status and diagnostic identity on fixtures.
4. End-to-end benchmark compares task success and cost.
5. Only then allow opt-in execution.

Never blanket-wrap every shell command through a proxy binary.

### 10.4 Strategy plugin API

Make structured strategies easier to add without bloating core logic.

#### Interface

```js
module.exports = {
  id: 'vitest-json-v1',
  priority: 100,
  detect(input, context) {
    return { confidence: 0.99, reason: '...' };
  },
  transform(input, context) {
    return {
      output: '...',
      lossiness: 'lossy',
      semanticComplete: true,
      preservation: { /* ... */ },
      reasons: []
    };
  },
  validate(result, input, context) {
    return { valid: true, errors: [] };
  }
};
```

#### Mandatory strategy contract

Every strategy must include:

- minimum detection confidence;
- supported versions/shapes;
- malformed-input passthrough;
- unique diagnostic extraction;
- preservation validation;
- no-result and tiny-result handling;
- fixture provenance;
- benchmark activation data;
- explicit behavior for host-truncated input.

Load built-in strategies from a static registry. Optional external packs may be supported later through an explicit directory, but do not execute untrusted project code automatically.

#### Strategy admission criteria

Add a strategy only when metrics show one of these:

- the command family is a top contributor to model-visible bytes;
- generic compression causes frequent recovery;
- structured data can preserve more evidence in less space;
- a new runtime/tool result is otherwise not safely handled.

### 10.5 Explicit source outline command

Do not compress built-in source Read results. A separate user/model-invoked outline tool may help repository exploration without sacrificing edit anchors.

Possible command:

```bash
agent-trim outline path/to/file.ts
agent-trim outline path/to/file.ts --language typescript
agent-trim outline path/to/file.ts --symbols public
```

Initial zero-dependency implementation may support only conservative languages/shapes using regex-based top-level symbol extraction, but regex parsing can be misleading. Prefer one of these routes:

1. Call an existing language-native parser/compiler already in the project.
2. Support a small set of proven syntax formats.
3. Make Tree-sitter support optional, not a core dependency.

Output must include:

- imports/dependencies summary;
- top-level symbols and line ranges;
- exported API;
- classes/functions/method signatures;
- no function bodies unless requested.

Rules:

- Explicit invocation only.
- Never substitute this for a source Read when exact editing is required.
- Include a clear instruction to read exact line ranges before editing.
- Benchmark only on repository exploration tasks.

If this cannot be implemented reliably without substantial dependencies, leave it out of the core release. It is lower priority than checks batching, MCP coverage, and context diagnostics.

### 10.6 Optional MCP retrieval server

A retrieval MCP tool is convenient but adds a permanent tool definition to context and can affect cache behavior. Therefore:

- Keep CLI/Read retrieval as the default.
- Offer an optional `agent-trim mcp` server only for runtimes that cannot conveniently read artifacts.
- Expose one narrow read-only tool, not a broad memory platform.
- Tool input: artifact ID plus line range.
- Validate all paths and hashes in the same artifact-store module.
- Measure tool-definition overhead and actual retrieval frequency.
- Do not install or enable it automatically.

### 10.7 Phase 4 definition of done

- [ ] Exact references are restricted to proven active, byte-identical Pi reads or remain disabled.
- [ ] Adaptive recovery has observe-mode evidence before changing caps.
- [ ] Command rewrite supports only allowlisted simple commands and has dry-run mode.
- [ ] Strategy API enforces validation and fixture metadata.
- [ ] Source outline remains explicit and cannot replace built-in source reads automatically.
- [ ] Optional MCP retrieval is not installed by default.

---

## 11. Ideas explicitly rejected from the core roadmap

Do not implement these unless the project's governing constraints change and new evidence overturns the reasons below.

### 11.1 LLM-generated summaries of tool output

Rejected because they add latency and model cost, are nondeterministic, weaken cache stability, and can omit the one line that matters.

### 11.2 API proxy that rewrites conversation history

Rejected from core because it is heavier, provider-specific, operationally invasive, and can invalidate prefix caching or alter old evidence. It could be a separate experimental project, not Agent Trim's default architecture.

### 11.3 Automatic compression of source-code reads

Rejected because exact code, whitespace, strings, and anchors are required for reliable edits. Research indicates compressed source views can reduce patch success even when token count falls.

### 11.4 Retroactive pruning through Pi's `context` event

Rejected because changing old messages can destroy cache reuse and silently alter conversation semantics.

### 11.5 Fuzzy cross-call replacement

Normalized hashes, trigram similarity, or Jaccard overlap are useful metrics, not proof of equivalence. Never replace content based on fuzzy similarity.

### 11.6 Semantic caching of shell commands

Rejected because a hook cannot generally prove environment-state equivalence. Running `cat file`, changing the file, and running it again is the obvious failure case. Exact active-result references after execution are a separate, narrower feature.

### 11.7 Dynamic tool removal or routing by Agent Trim

Rejected as default behavior because tool definitions affect capability and cache prefixes. Audit and recommend; let the user/host control tools.

### 11.8 Blanket command rewriting

Rejected because wrappers can change permissions, shell semantics, output, exit behavior, and agent trajectories. Only narrow opt-in recipes may be tested.

### 11.9 Always-on cross-session memory

Rejected because stale facts and unrelated task state can create more cost and errors than they save. Compaction preservation should remain session-local and bounded.

### 11.10 Automatic subagent spawning to save context

Rejected because subagents have startup/context cost and can bloat the parent with reports. Agent Trim may improve existing subagent contracts, not spawn workers merely for token reduction.

### 11.11 Background monitor/daemon by default

Rejected because the project currently works without background processes. Reports can be generated on demand. File watchers or services should not become a requirement.

### 11.12 Text rendered as images

Rejected because visual encoding is lossy for exact strings, code, identifiers, and edit anchors even when image-token pricing looks attractive.

### 11.13 Secret redaction as a core compression strategy

Do not silently redact tool output in the compression core. Security redaction has different correctness and policy requirements and could hide needed authentication errors. Keep it a separate explicit feature if pursued later.

---

## 12. Security and robustness requirements

These are release-blocking.

### Filesystem

- Canonicalize artifact roots once.
- Reject traversal and NUL/control characters.
- Reject symlinks for objects, metadata, aliases, and retrieval targets.
- Use exclusive temporary files and atomic rename.
- Use restrictive permissions.
- Bound directory scans and TTL work.
- Verify SHA-256 before reuse and retrieval.
- Treat artifact paths in model output as untrusted inputs when reread.

### Hook behavior

- Wrap every adapter entrypoint in a top-level fail-open guard.
- Time-bound hook work.
- Never block a successful tool because compression failed.
- Preserve native permission systems; do not auto-approve commands.
- Avoid running arbitrary project code during observation hooks.
- Do not trust MCP tool annotations as proof that a tool is read-only or safe.
- Preserve `isError`, exit information, signals, interruption state, and unknown fields.

### Prompt-injection resistance

- Tool output is untrusted data.
- Marker headers must be generated only from local counters/contracts, not copied tool text.
- Keep provenance markers stable and clearly attributable to Agent Trim.
- Do not interpret instructions found in output when deciding preservation or command safety.
- Extract identifiers syntactically and with strict bounds; do not elevate arbitrary sentences into additional context.

### Resource bounds

Define hard limits:

```text
max input processed per hook: host-observed result, with streaming or bounded fallback for very large data
max strategy parse time: configurable, default under 50 ms for normal results
max sidecar sweep entries: 200
max duplicate ring entries: 50 per session
max ledger entries: 40
max identifier facts: 16
max metrics event size: 8 KB
```

A timeout or exceeded bound must return the original output.

---

## 13. Testing strategy

### 13.1 Unit tests

Required invariants:

1. **Determinism:** same input/options produce byte-identical model output.
2. **Idempotence:** already-trimmed marked output does not get recursively sidecarred or corrupted.
3. **Signal preservation:** every detected unique error/warning line survives or is represented by a proven structured record.
4. **Shape preservation:** typed fields and non-text content remain deep-equal.
5. **Net win:** selected candidate clears byte and token-estimate thresholds.
6. **Host honesty:** `hostComplete=false` can never render a complete-artifact claim.
7. **Source safety:** ordinary source Read fixtures pass through unchanged.
8. **Fail open:** injected exceptions return no patch/replacement.
9. **Path safety:** traversal/symlink/collision tests fail safely.
10. **Privacy:** metrics fixtures contain no raw paths, prompts, outputs, or command arguments.

### 13.2 Property and fuzz tests

Without adding runtime dependencies, dev dependencies or small custom fuzz loops may test:

- arbitrary Unicode;
- CRLF/LF/mixed endings;
- malformed JSON and JSONL;
- partial ANSI/OSC sequences;
- giant single lines;
- repeated and near-repeated diagnostics;
- injection-shaped bracketed text;
- random MCP content arrays and unknown fields;
- random sidecar filenames and traversal attempts;
- parallel state updates.

Properties:

```text
output is valid UTF-8 when input is valid UTF-8
preserved fields deep-equal original
output length never exceeds original when applied
unapplied transform returns original exactly
all marker claims derive from contract booleans/counters
```

### 13.3 Adapter contract tests

Run recorded host payload fixtures for each supported runtime version family.

Claude:

- Bash object response.
- Read response.
- MCP mixed result.
- PostToolBatch payload.
- InstructionsLoaded payload.
- SessionStart with/without `CLAUDE_ENV_FILE`.
- PostCompact summary.
- Unknown/new fields.

Pi:

- bash and read results;
- typed details and `isError`;
- model/provider changes;
- compaction, switch, fork, shutdown;
- before-provider payload observation;
- parallel tool results;
- active branch proof for experimental references.

Codex/OpenCode:

- continue current supported fixtures;
- add compatibility tests only for behavior verified against their current released hook surface;
- never assume Claude result shapes apply.

### 13.4 Performance gates

Keep or strengthen current throughput tests.

Suggested gates on a typical CI runner:

```text
1 MB generic log: < 75 ms
10 MB generic log: < 750 ms
peak memory: bounded and documented
small clean output: effectively no-op
artifact write: no model-visible delay beyond configured hook timeout
```

Use relative regression baselines rather than promising universal hardware timings.

### 13.5 End-to-end release report template

Every behavioral release report must include:

```text
commit and runtime versions
models and effort/thinking settings
task manifest hash
number of tasks/trials/invalid trials
verified successes
provider usage categories
cost or reason cost is unavailable
cost per successful task
turns/tool calls/rereads/reruns/compactions
feature activation counts
component compression by strategy
harmful or neutral task categories
confidence limitations
raw evidence hashes
```

Never combine optional terse-prompt savings with tool-result savings into one percentage unless the factorial experiment isolates and reports the interaction.

---

## 14. Documentation requirements

Update documentation as part of each PR, not after implementation.

### README

- Keep the main explanation simple.
- Separate “measured component savings” from “end-to-end benchmark results.”
- State which features are default, observe-only, and experimental.
- Document the retrieval path and artifact lifetime.
- Do not claim dollar or subscription-quota savings without provider-supported accounting.

### `docs/architecture.md`

Explain:

- transformation contract;
- artifact store;
- selection gate;
- adapter boundaries;
- metrics and privacy;
- compaction/session state;
- failure behavior.

### `docs/evidence.md`

Explain evidence levels L1–L8 and link every public claim to a committed report.

### `docs/checks.md`

Include schemas, examples, trust implications, dry-run, exit behavior, and CI usage.

### `docs/context-doctor.md`

Explain findings versus recommendations and why automatic instruction/tool changes are intentionally excluded.

### `docs/mcp.md`

Document mixed content, preservation guarantees, observe mode, allow/deny controls, and unsupported shapes.

### `docs/security.md`

Document artifact permissions, symlink defenses, prompt-injection boundaries, metrics privacy, and command execution trust.

### `docs/compatibility.md`

Use a tested matrix:

| Runtime | Tested version | Transformable tools | Host truncation | Compaction support | Known limitations |
|---|---|---|---|---|---|

Do not write “supports all MCP” or “supports all tools” without fixtures.

---

## 15. Recommended pull-request sequence

Keep PRs independently testable and avoid mixing measurement with several behavior changes.

### PR 1 — Metrics truthfulness

- Split byte-exact and normalized duplicates.
- Add metrics v2 schema and mixed reader.
- Add recovery-candidate observation.
- Add evidence-level labels.
- No model-visible behavior change.

**Gate:** all existing tests pass; privacy tests pass.

### PR 2 — End-to-end harness

- Add task manifest, runner interface, verifier, sanitized report generator.
- Add initial 20-task corpus.
- Produce baseline Claude/Pi reports.

**Gate:** repeated baseline runs are reproducible enough to compare features; invalid trials are explicit.

### PR 3 — Artifact store v3

- Add SHA-256 canonical objects, atomic writes, verification, secure retrieval CLI.
- Preserve legacy sidecar compatibility.

**Gate:** corruption, collision, symlink, concurrency, and TTL tests pass.

### PR 4 — Safe quiet environment

- Add Claude SessionStart environment hook.
- Add conservative Pi implementation or launcher diagnostics.
- Add opt-outs and cross-platform fixtures.

**Gate:** no behavior regression in snapshot/terminal fixtures or end-to-end suite.

### PR 5 — Result contract and net-win gate

- Add shared `TransformResult`.
- Add token-class estimator.
- Move markers and metrics onto the contract.
- Add identifier factsheet.

**Gate:** every existing strategy produces valid contracts; no candidate with negative estimated savings is selected.

### PR 6 — Claude MCP observe mode

- Expand matcher.
- Add mixed-content parser and fixtures.
- Log eligibility/savings estimates without rewriting.

**Gate:** real Claude payloads captured and all fields preserved in simulated transforms.

### PR 7 — Claude MCP transform mode

- Enable text-block transformations behind `TRIM_MCP=on`.
- Run end-to-end MCP tasks.

**Gate:** no solve-rate regression; mixed non-text content unchanged; cost/success neutral or improved.

### PR 8 — Unified CLI and checks runner

- Add CLI, checks schema, artifacts, summaries, dry-run, and exit behavior.
- Add `verify --changed` afterward or in a separate PR if scope grows.

**Gate:** validation tasks use fewer model calls without hiding failures.

### PR 9 — Context doctor and cache observer

- Add explicit doctor.
- Add Claude InstructionsLoaded metrics.
- Add Pi structured prompt/provider observation.
- No prompt mutation.

**Gate:** privacy tests and stable reports.

### PR 10 — Compaction ledger experiment

- Add bounded ledger, Pi custom instructions, Claude compact resume supplement.
- Default off.

**Gate:** long-session task suite shows fewer rediscovery calls and neutral/improved cost.

### PR 11 — Adaptive recovery experiment

- Observe, then optionally act after evidence.

**Gate:** policy reduces recovery without increasing average context substantially.

### PR 12 — Exact Pi read references

- Only after byte-exact duplicate incidence and active-branch evidence justify it.
- Default off.

**Gate:** no reread increase and clear cost/success improvement.

Command rewriting, source outline, and optional retrieval MCP should be separate later PRs, each justified by metrics.

---

## 16. Coding-agent execution instructions

The coding agent implementing this plan must follow this order:

1. Read the full repository and current tests before changing code.
2. Create a short implementation map that matches existing module conventions.
3. Preserve public APIs and environment aliases unless a migration is documented.
4. Implement one PR-sized milestone at a time.
5. Add tests before or alongside behavior.
6. Run the full existing suite after every milestone.
7. Run benchmark regression gates where applicable.
8. Update docs in the same change.
9. Never enable an experimental flag by default merely because fixtures compress well.
10. Report exact files changed, tests run, benchmark results, known limitations, and remaining gates.

### Mandatory implementation rules

- Do not add an LLM dependency.
- Do not add network calls to hook execution.
- Do not add a default background service.
- Do not mutate historical context.
- Do not compress ordinary source reads.
- Do not flatten typed results.
- Do not trust command text or MCP annotations as proof of safety/read-only behavior.
- Do not make new model-visible marker text nondeterministic.
- Do not publish estimated token savings as provider-billed savings.
- Do not skip malformed-input, host-truncation, or adapter-failure tests.

### Stop conditions

Pause a feature and leave it behind a flag when:

- the host output contract cannot be confirmed;
- exact evidence cannot be preserved;
- the end-to-end benchmark is underpowered or contradictory;
- provider accounting is unavailable and trajectory metrics worsen;
- a feature causes source-edit failures;
- recovery calls erase the component savings;
- cross-platform behavior is not known.

A smaller, trustworthy Agent Trim is better than a broad optimizer that saves tokens in fixtures and loses tasks in real use.

---

## 17. Final product milestones

### `0.4.0` — Evidence first

- Metrics v2.
- Correct duplicate semantics.
- Recovery observation.
- End-to-end benchmark harness and baseline.

### `0.5.0` — Safe payload reduction

- Artifact store v3.
- Quiet environment.
- Shared transform contract.
- Calibrated net-win gate.
- Identifier factsheet.
- Claude MCP observe mode.

### `0.6.0` — Fewer model wakeups

- Unified CLI.
- Deterministic check batching.
- Changed-file validation.
- Improved subagent return contracts.
- PostToolBatch metrics.

### `0.7.0` — Context intelligence

- Context doctor.
- Instruction/tool footprint metrics.
- Pi provider/cache observer.
- Optional compaction ledger experiment.

### `0.8.x` — Evidence-gated experiments

- Adaptive recovery.
- Exact active Pi Read references.
- Narrow command rewrite recipes.
- Optional source outline and retrieval MCP.

### `1.0.0` — Trustworthy default optimizer

Release 1.0 only when:

- default features have end-to-end evidence across Claude Code and Pi;
- every lossy path is recoverable and honest about host completeness;
- source reads remain safe;
- published claims distinguish estimates from billing;
- compatibility and security tests are mature;
- experimental features remain clearly separated.

---

## 18. References

The coding agent should re-check current host documentation before implementing because hook contracts change.

### Agent Trim and adjacent implementations

1. Agent Trim repository: https://github.com/MasterWushi/agent-trim
2. Agent Trim README: https://github.com/MasterWushi/agent-trim/blob/main/README.md
3. Agent Trim research note: https://github.com/MasterWushi/agent-trim/blob/main/docs/research.md
4. Agent Trim decisions: https://github.com/MasterWushi/agent-trim/blob/main/docs/decisions.md
5. CodexZero repository: https://github.com/Retro2512/CodexZero
6. CodexZero architecture: https://github.com/Retro2512/CodexZero/blob/main/docs/architecture.md
7. CodexZero measurement: https://github.com/Retro2512/CodexZero/blob/main/docs/measurement.md
8. Squeez repository, used only as an inspiration inventory rather than independent evidence: https://github.com/claudioemmanuel/squeez
9. RTK repository, used to study command-source shaping and command-specific output filters: https://github.com/rtk-ai/rtk

### Claude Code and Anthropic primary documentation

10. Claude Code hooks reference: https://code.claude.com/docs/en/hooks
11. Claude Code subagents: https://code.claude.com/docs/en/sub-agents
12. Claude Code context windows: https://code.claude.com/docs/en/context-windows
13. Claude Code costs: https://code.claude.com/docs/en/costs
14. Claude prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
15. Tool use with prompt caching: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching
16. Anthropic tool search/deferred loading: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool

Key host facts to verify during implementation:

- `SessionStart` can persist environment variables via `CLAUDE_ENV_FILE`.
- `PostToolUse.updatedToolOutput` replaces a tool result before Claude receives it and must preserve expected shape.
- MCP tools use names such as `mcp__<server>__<tool>` in hook matchers.
- `InstructionsLoaded` reports instruction-file loads and reasons.
- `PostToolBatch` fires after parallel tools resolve and before the next model call.
- `PostCompact` exposes the generated compact summary.

### Pi primary documentation/source

17. Pi repository: https://github.com/earendil-works/pi
18. Pi extension documentation: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
19. Pi compaction documentation: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md
20. Pi session format and SessionManager: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md

Key Pi facts to verify during implementation:

- `tool_call` can mutate built-in tool input before execution.
- `tool_result` can replace result content while preserving details/error state.
- `before_agent_start` exposes structured prompt components.
- `before_provider_request` can inspect or replace payloads; Agent Trim should observe only.
- `session_before_compact` can customize compaction.
- SessionManager branch inspection may support proof that an earlier result remains active.

### MCP primary specification

21. Model Context Protocol specification: https://modelcontextprotocol.io/specification/2025-06-18
22. MCP TypeScript schema: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-06-18/schema.ts

Important MCP constraints:

- Tool results can contain mixed content blocks and optional `structuredContent`.
- Preserve `isError`, metadata, non-text blocks, and unknown fields.
- Tool annotations are hints and must not be trusted for security or equivalence decisions.

### Research papers

23. Weinberger and coauthor, **Token Reduction Is Not Cost Reduction**, arXiv:2607.12161: https://arxiv.org/abs/2607.12161
24. Lulla et al., **On the Impact of AGENTS.md Files on the Efficiency of AI Coding Agents**, arXiv:2601.20404: https://arxiv.org/abs/2601.20404
25. Wang et al., **RepoMaster: Autonomous Exploration and Understanding of GitHub Repositories for Complex Task Solving**, arXiv:2505.21577: https://arxiv.org/abs/2505.21577
26. **Don't Break the Cache**, arXiv:2601.06007: https://arxiv.org/abs/2601.06007
27. **Agentic Plan Caching**, arXiv:2506.14852: https://arxiv.org/abs/2506.14852
28. **TVCACHE**, arXiv:2602.10986: https://arxiv.org/abs/2602.10986

Treat research findings as directional until reproduced on Agent Trim's own coding-task suite. The most important practical lesson is to evaluate the full trajectory and cost per verified success.

### OpenAI/Codex primary sources and compatibility tracking

29. OpenAI developer documentation: https://developers.openai.com/
30. OpenAI Codex repository: https://github.com/openai/codex
31. OpenAI model/prompt-caching guidance: https://developers.openai.com/api/docs/guides/latest-model

Codex hook coverage has changed rapidly. Before modifying the Codex adapter, verify the released CLI's actual hook schema and behavior against official source/tests. Do not infer parity from Claude Code.

---

## 19. One-page implementation priority summary

Build in this order:

1. **Prove outcomes:** metrics v2, duplicate truthfulness, recovery observation, end-to-end benchmark.
2. **Make evidence safe:** verified SHA-256 artifact store and retrieval.
3. **Prevent noise:** no-color/pager environment.
4. **Make transformations honest:** shared contract, calibrated net-win gate, bounded identifiers.
5. **Cover real missing surfaces:** Claude MCP text blocks with full mixed-content preservation.
6. **Remove turns:** deterministic check batching and changed-file verification.
7. **Find larger context waste:** instruction/tool footprint doctor and cache observer.
8. **Preserve long-session state carefully:** bounded compaction ledger.
9. **Experiment only after evidence:** adaptive recovery, exact active Read references, command rewriting, source outlines.

The core creative direction is:

```text
prevent avoidable output
→ batch deterministic work
→ preserve exact evidence locally
→ send the smallest trustworthy view
→ detect when the model had to recover
→ loosen policy when compression backfires
→ judge everything by verified cost per successful task
```
