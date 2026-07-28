# Engineering research note

Why Agent Trim is shaped the way it is, grounded in provider documentation
(facts) and research papers (findings — weaker evidence, flagged as such).
Compiled 2026-07-16 from primary sources.

## Provider facts (documentation)

**Prompt caching is exact-prefix.** All providers cache by matching the start
of a request against recently processed content; a change anywhere in the
prefix recomputes everything after it. Claude Code re-sends the full context
every turn — system prompt, project context, every prior message and tool
result — and only the newest exchange is uncached
(code.claude.com/docs/en/prompt-caching). OpenAI works the same way with
automatic longest-prefix matching, 1,024-token minimum, ~5–10 min lifetime
(developers.openai.com prompt-caching guide; openai.com blog returned 403,
figures taken from the developer guide).

**Consequences for Agent Trim:**

1. **Trimming at PostToolUse is cache-safe and maximally leveraged.** The hook
   rewrites the result *before* it enters conversation history, so the
   provider only ever sees the trimmed version — appended once, then re-served
   from cache at ~10% of input price on every later turn. The saving therefore
   recurs every turn the session continues.
2. **Never mutate already-emitted output.** Retroactively re-trimming an older
   tool result would change the cached prefix and force a full recompute.
   Agent Trim has no retroactive path today; this is now a documented
   invariant, not an accident.
3. **Determinism is load-bearing.** Identical input must produce identical
   trimmed output (no timestamps, no randomness in model-visible text), or
   resumed/forked sessions diverge from their cached prefix. Sidecar filenames
   are content-addressed for this reason.
4. **Don't touch tool definitions.** Tool definitions live in the topmost
   cache layer; changing the tool list invalidates the entire cache
   (platform.claude.com tool-use-with-prompt-caching). Agent Trim never
   alters an agent's tool list.
5. **Anthropic endorses exactly this pattern.** The costs doc's own example is
   a hook that filters a 10,000-line log to its ERROR lines, "reducing context
   from tens of thousands of tokens to hundreds"
   (code.claude.com/docs/en/costs). Agent Trim is the generalized,
   signal-preserving form of that recommendation.
6. **Compaction & subagents.** Compaction rebuilds the conversation layer (the
   note re-arm hook exists because of this); subagents build their own cache
   and leave the parent prefix intact — trimming a subagent's tool results
   pays off inside the subagent AND in the parent when the final report lands.

**Claude cache mechanics** (platform.claude.com prompt-caching): hierarchy
tools → system → messages; up to 4 explicit breakpoints, 20-block lookback;
minimum cacheable prefix 512–4,096 tokens depending on model; 5-minute default
TTL, 1-hour TTL at 2× write cost; telemetry via `cache_creation_input_tokens`
/ `cache_read_input_tokens` (OpenAI: `usage.prompt_tokens_details.cached_tokens`).
Agent Trim does not and cannot control any of this — it reduces the bytes that
flow through the mechanism. The README makes no claim otherwise.

## Research findings (papers — treat as directional)

**"Don't Break the Cache" (arXiv:2601.06007).** Reports 41–80% cost reduction
from caching on long-horizon agent tasks, but naive full-context caching
*regressed* time-to-first-token on some providers because dynamic tool results
generate cache writes that are never read. Methodology caveats: n=40 sessions
per condition, one benchmark (DeepResearch-style web tasks, not coding), costs
computed from list prices. Adopted lesson: the volatile tail of the
conversation (tool results) is the highest-churn, lowest-cache-value segment —
shrinking it (what trim does) is the provider-independent win; micro-managing
breakpoints is not trim's job.

**"Agentic Plan Caching" (arXiv:2506.14852).** Caches plan templates at test
time. Every component needs a model call (keyword extraction, plan adaptation)
and it performs worst on heterogeneous tasks — the coding-agent regime.
**Rejected**: violates Agent Trim's no-model-call constraint, weakest exactly
where we operate.

**TVCACHE (arXiv:2602.10986).** Tool-value caching for post-training
pipelines. Central correctness lesson: a cached tool result is valid only when
the relevant environment state is equivalent — keying on command text returns
stale data the moment a file changes (`cat` → patch → `cat`). Its redundancy
comes from parallel rollouts of identical tasks in forkable sandboxes, which
interactive coding agents don't have (hit rates were lowest on terminal tasks
even there). **Rejected as architecture; adopted as an invariant**: Agent Trim
stays stateless and within a single tool result. Any future "same command,
reuse earlier output" feature is unsafe unless it can prove filesystem-state
equivalence, which a hook cannot — so it is out of scope by policy
(see "Explicit non-goals" in the README).

## Hook-surface verification (2026-07-16)

Full details in the adapter comments; the load-bearing facts, all verified
against primary docs/source:

| Runtime | Replace mechanism | Trim can see | Host truncation before hook |
|---|---|---|---|
| Claude Code | `hookSpecificOutput.updatedToolOutput` (schema-validated; Bash response = `{stdout, stderr, interrupted, isImage}` — **no exit code**) | Bash, Read, MCP, Agent results | undocumented; ~29KB observed for Bash |
| Codex CLI | exit 2 + stderr (feedback **replaces** the result; no structured rewrite yet — `updatedMCPToolOutput` parsed but unsupported) | Bash, apply_patch, MCP ("simple" shell calls only) | undocumented |
| opencode | mutate `output.output` in place (MCP results: mutate `content` array); **a throw is fail-closed** → whole handler wrapped in try/catch | built-ins, Task, MCP | yes — truncates before hook, `metadata.truncated` set |
| pi | return partial `{content}` patch from `tool_result` | bash + registered tools (MCP undocumented) | yes — 50KB / 2,000 lines built-in |

Implications implemented: the Claude adapter treats `interrupted: true` as
failure and otherwise sniffs failure from text (no exit code exists to read);
all adapters pass `hostMayTruncate` for shell output so the sidecar never
falsely claims "saved in full" for text the host already cut.

**Hook merge across settings scopes (verified 2026-07-28):** Claude Code
merges `hooks` across settings scopes (user/project/local) rather than
applying the usual managed > CLI > local > project > user override
precedence; both scopes' hook sets run simultaneously, deduplicated by
command string. This is load-bearing for PalSync coexistence — see
`docs/palsync.md` "Coexistence" section — since PalSync installs a
project-scope `Stop` hook while Agent Trim installs user-scope
`PostToolUse`/`SubagentStart`/`PostCompact` hooks; override semantics would
have let PalSync's project-scope write silently disable Agent Trim.
