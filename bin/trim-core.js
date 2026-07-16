#!/usr/bin/env node
'use strict';
// trim-core: deterministic, model-free compression of tool/command output.
// stdin -> compressed stdout. Lossless transforms always; lossy elision only
// past size caps — and the cap keeps EVERY error/warning line by construction,
// so omission markers can honestly promise no signal was cut. Failing runs
// are evidence, not noise: they get a much larger cap than passing runs.

// Caps are in lines. TRIM_MAX_LINES is honored as a legacy alias for the fail cap.
const CAP_PASS = int(process.env.TRIM_CAP_PASS, 120);
const CAP_FAIL = int(process.env.TRIM_CAP_FAIL, int(process.env.TRIM_MAX_LINES, 300));
// Enumeration carve-out cap: large enough that a normal noisy build/log passes
// whole — no omission markers at all — so a model asked to report EVERY item
// has nothing elided to distrust. Still bounded against pathological dumps.
const CAP_ENUMERATE = int(process.env.TRIM_CAP_ENUMERATE, 2000);
const TEMPLATE_MIN_RUN = int(process.env.TRIM_TEMPLATE_MIN_RUN, 5);

// Lines carrying the task's actual signal (errors, warnings, failures) survive
// the cap regardless of position. Deliberately broad: over-matching keeps a few
// extra lines, never fewer. The trailing \w*(?:Error|Warning)\b catches compound
// runtime names (TypeError, ReferenceError) that \bERROR\b misses.
const SIGNAL_RE = new RegExp(
  process.env.TRIM_KEEP_RE ||
    '\\b(err(or)?|warn(ing)?|fail(ed|ure)?|exception|traceback|panic|fatal|denied|refused|timeout|timed out|not found|cannot|unable|deprecated|critical)\\b|\\w*(?:Error|Warning)\\b',
  'i'
);

// Failure sniff for when no exit code is available. False positives only make
// the cap more generous — safe direction.
const FAILURE_RE =
  /(^|[^0-9a-zA-Z])(FAIL(ED|URE)?|fail(ed|ure)?s?:|Error|error:|ERR!|✗|✘|not ok|Traceback|exception|panic|fatal)([^0-9a-zA-Z]|$)/m;

// A command that just dumps a file (cat/type/Get-Content, no pipe/redirect)
// exits 0 without meaning "safe to trim like a build log" — source text has no
// ERROR markers for the cap to anchor on, so a tight cap would cut arbitrary
// middle lines. Treat like failures: keep more.
const FILE_DUMP_RE = /^\s*(cat|type|gc|Get-Content)\s+[^|;&<>]+$/i;

function int(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

// Progress bars redraw via a bare \r; only the final state of each physical
// line matters. \r\n is an ordinary Windows line ending, not a redraw —
// normalize it first or every CRLF line collapses to empty.
function resolveCarriageReturns(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const i = line.lastIndexOf('\r');
      return i === -1 ? line : line.slice(i + 1);
    })
    .join('\n');
}

function looksLikeFailure(text, exitCode) {
  if (typeof exitCode === 'number') return exitCode !== 0;
  return FAILURE_RE.test(text);
}

function isFileDump(command) {
  if (typeof command !== 'string') return false;
  const firstLine = command.split('\n', 1)[0];
  return FILE_DUMP_RE.test(firstLine.trim());
}

// Real logs repeat the same SHAPE far more than identical lines ("INFO
// worker-3 processing job 8841" x hundreds, each with a different id). Two
// lines share a template iff: same token count; >=50% of positions
// token-identical; and >=2 identical positions are "anchor" tokens (>=3 chars,
// no digits) — the anchor floor stops merges on a shared timestamp alone.
// Comparison is always against the run's first line, so the run stays anchored
// to one shape. A SIGNAL_RE line never joins a run and always breaks one —
// over-normalizing distinct errors is the failure mode this sidesteps.
function templateTokens(line) {
  return line.trim().split(/\s+/).filter(Boolean);
}

function shareTemplate(aTokens, bTokens) {
  if (!aTokens.length || aTokens.length !== bTokens.length) return false;
  let same = 0;
  let anchors = 0;
  for (let i = 0; i < aTokens.length; i++) {
    if (aTokens[i] === bTokens[i]) {
      same++;
      if (aTokens[i].length >= 3 && !/\d/.test(aTokens[i])) anchors++;
    }
  }
  return same / aTokens.length >= 0.5 && anchors >= 2;
}

function collapseTemplates(lines) {
  if (process.env.TRIM_TEMPLATE === 'off') return lines;
  const out = [];
  let runStart = -1;
  let anchorTokens = null;
  let runLen = 0;

  function flushRun() {
    if (runLen >= TEMPLATE_MIN_RUN) {
      out.push(lines[runStart]);
      out.push(`[trim hook: ${runLen - 1} similar lines collapsed (same shape, varying values)]`);
    } else {
      for (let i = runStart; i < runStart + runLen; i++) out.push(lines[i]);
    }
    runStart = -1;
    anchorTokens = null;
    runLen = 0;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (SIGNAL_RE.test(line)) {
      if (runLen > 0) flushRun();
      out.push(line);
      continue;
    }
    const tokens = templateTokens(line);
    if (runLen > 0 && shareTemplate(anchorTokens, tokens)) {
      runLen++;
      continue;
    }
    if (runLen > 0) flushRun();
    runStart = i;
    anchorTokens = tokens;
    runLen = 1;
  }
  if (runLen > 0) flushRun();
  return out;
}

// When the user's prompt explicitly asks to enumerate EVERY / ALL / EACH of
// some countable thing, a capped slice — even one that promises "no signal
// cut" — still reads as incomplete: the model can't audit a completeness claim
// it can't see the whole of, so it re-runs the command and the compression
// backfires exactly on the noisy task where it would save the most. On those
// prompts, skip the cap (raise to CAP_ENUMERATE) and skip template collapse:
// nothing is elided, so there is nothing to distrust. Kept tight — a countable
// noun is required — so ordinary prose doesn't disable compression wholesale.
const ENUM_NOUN =
  'warn(?:ing)?s?|errors?|failures?|deprecat\\w*|issues?|items?|entr(?:y|ies)|' +
  'lines?|occurrences?|matches|results?|files?|records?|rows?|messages?|' +
  'violations?|findings?|instances?|columns?|tests?';
const ENUM_QUANTIFIED = new RegExp(
  `\\b(?:every|each|all|complete|full|entire|exhaustive)\\b[^.?!\\n]{0,30}?\\b(?:${ENUM_NOUN})\\b`,
  'i'
);
const ENUM_VERB = new RegExp(`\\b(?:list|enumerate)\\b[^.?!\\n]{0,20}?\\b(?:${ENUM_NOUN})\\b`, 'i');

function requestsEnumeration(prompt) {
  if (typeof prompt !== 'string' || !prompt) return false;
  return ENUM_QUANTIFIED.test(prompt) || ENUM_VERB.test(prompt);
}

// Identifiers the user's own prompt names — backticked or quoted spans like
// `ioredis` or "W1042" — are that turn's signal even when they match no
// error pattern. Keeping prompt-named lines makes the single-read path the
// common case (a capped view that cuts the one entry the prompt asked about
// forces a second lookup). High-precision only: explicitly marked spans,
// never bare words; a span matching more than RELEVANCE_COMMON lines is
// dropped as too common to discriminate.
const RELEVANCE_COMMON = 50;
const RELEVANCE_MAX_TOKENS = 8;

function extractRelevanceTokens(prompt) {
  if (typeof prompt !== 'string' || !prompt) return [];
  const spans = [];
  for (const m of prompt.matchAll(/`([^`\n]{3,80})`|"([^"\n]{3,80})"|'([^'\n]{3,80})'/g)) {
    const s = (m[1] || m[2] || m[3] || '').trim().toLowerCase();
    if (s && !spans.includes(s)) spans.push(s);
  }
  return spans.slice(0, RELEVANCE_MAX_TOKENS);
}

// Indices of lines containing any relevance token, unless the token is too
// common to discriminate.
function relevanceHits(lines, relevanceTokens) {
  const hits = new Set();
  if (!relevanceTokens || !relevanceTokens.length) return hits;
  const lower = lines.map((l) => l.toLowerCase());
  for (const tok of relevanceTokens) {
    const tokHits = [];
    for (let i = 0; i < lower.length; i++) if (lower[i].includes(tok)) tokHits.push(i);
    if (tokHits.length > 0 && tokHits.length <= RELEVANCE_COMMON) for (const i of tokHits) hits.add(i);
  }
  return hits;
}

// Context-pressure scaling: transcript size is a free local proxy for how full
// the context already is. Deep in a long session every kept line is re-sent
// more times and pushes auto-compaction closer — so caps tighten as the
// session grows. Inert below 400KB; floors keep failing output useful; the
// enumeration carve-out is never scaled (its point is a completeness promise).
const PRESSURE_MID_BYTES = 400 * 1024;
const PRESSURE_HIGH_BYTES = 1024 * 1024;
const FLOOR_PASS = 30;
const FLOOR_FAIL = 125;

function pressureScale(transcriptBytes) {
  if (!Number.isFinite(transcriptBytes) || transcriptBytes < PRESSURE_MID_BYTES) return 1;
  return transcriptBytes < PRESSURE_HIGH_BYTES ? 0.75 : 0.5;
}

// ---- sidecar: very large outputs don't enter context at all ----
// The full cleaned text goes to a tmp file and a line-numbered digest goes in
// its place. Even a capped inline view of a huge log is re-sent with every
// later API call; the digest is an order of magnitude smaller and the file is
// one targeted read away — real L<n> line numbers let a follow-up read use
// offset/limit (or sed -n) surgically. The digest keeps the head, the tail, a
// bounded sample of signal lines with an exact categorical census, and every
// prompt-named line, so most tasks never need the follow-up at all.
// Fail-open: any filesystem trouble falls back to the normal capped view.
// Files are content-addressed (idempotent on re-fire) and left to OS temp
// cleaning, like the other state files.
const SIDECAR_MIN_CHARS = int(process.env.TRIM_SIDECAR_MIN, 15000);
// Upper bound for SHELL outputs only: harnesses (Claude Code measured at
// ~29KB) may truncate a shell result before the hook sees it, keeping the
// full text in their own file. Sidecaring an already-truncated output would
// write a "saved in full" file that isn't, and add a second "full output
// elsewhere" pointer competing with the harness's own. Above this bound,
// shell outputs fall through to the normal inline cap. Reads are exempt —
// they arrive complete.
const SIDECAR_SHELL_MAX = int(process.env.TRIM_SIDECAR_SHELL_MAX, 28000);
const SIDECAR_DIR = require('path').join(require('os').tmpdir(), 'trim-sidecar');
const DIGEST_HEAD = 20;
const DIGEST_TAIL = 15;
const DIGEST_SIGNAL_SAMPLE = 10; // first N + last N signal lines
const OTHER_SIGNAL_CAP = 15; // max line numbers listed in the "not shown" line

// Subpatterns of SIGNAL_RE's alternation. Priority when a line matches
// several: error > failure > critical > warning > deprecation — each line
// counts once. A bare count ("14 signal lines") makes a model misreport on a
// completeness task; a categorical census ("2 errors, 3 warnings") lets it
// answer without re-reading (hush measured this against live models).
const CENSUS_CATEGORIES = [
  { singular: 'error', plural: 'errors', re: /\w*Error\b|\berr(or)?\b/i },
  { singular: 'failure', plural: 'failures', re: /\bfail(ed|ure)?s?\b/i },
  { singular: 'critical', plural: 'criticals', re: /\bcritical\b/i },
  { singular: 'warning', plural: 'warnings', re: /\w*Warning\b|\bwarn(ing)?\b/i },
  { singular: 'deprecation', plural: 'deprecations', re: /\bdeprecated\b/i },
];

function signalCensus(lines, signalIdx) {
  const counts = CENSUS_CATEGORIES.map(() => 0);
  for (const i of signalIdx) {
    const catIdx = CENSUS_CATEGORIES.findIndex((c) => c.re.test(lines[i]));
    if (catIdx !== -1) counts[catIdx]++;
  }
  const parts = [];
  CENSUS_CATEGORIES.forEach((c, idx) => {
    const n = counts[idx];
    if (n > 0) parts.push(`${n} ${n === 1 ? c.singular : c.plural}`);
  });
  return parts.join(', ');
}

function cheapHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function buildSidecarDigest(cleaned, relevanceTokens) {
  const lines = cleaned.split('\n');
  const total = lines.length;
  const signalIdx = [];
  lines.forEach((l, i) => {
    if (SIGNAL_RE.test(l)) signalIdx.push(i);
  });

  // Signal (and prompt-named) lines lead the digest, ahead of the structural
  // head/tail: if the harness shows only a truncated preview of this digest,
  // the errors must sit inside that window or the model re-reads the raw
  // output and re-inflates everything just saved. Line numbers stay real —
  // they exist for targeted reads, not reading order.
  const lead = [...new Set([...signalIdx.slice(0, DIGEST_SIGNAL_SAMPLE), ...signalIdx.slice(-DIGEST_SIGNAL_SAMPLE)])];
  for (const i of relevanceHits(lines, relevanceTokens)) lead.push(i);
  const leadSet = new Set(lead);
  const leadSorted = [...leadSet].sort((a, b) => a - b);

  const structIdx = new Set();
  for (let i = 0; i < Math.min(DIGEST_HEAD, total); i++) if (!leadSet.has(i)) structIdx.add(i);
  for (let i = Math.max(0, total - DIGEST_TAIL); i < total; i++) if (!leadSet.has(i)) structIdx.add(i);
  const structSorted = [...structIdx].sort((a, b) => a - b);
  const census = signalCensus(lines, signalIdx);

  const out = [];
  if (leadSorted.length) {
    out.push(`Signal lines (${signalIdx.length} total: ${census}):`);
    for (const i of leadSorted) out.push(`L${i + 1}: ${lines[i]}`);
    // signalIdx is every matching line, so naming exactly which ones aren't
    // shown (with real L<n> targets) is a completeness claim the hook can
    // actually prove, not a bare "trust me" count.
    const unshown = signalIdx.filter((i) => !leadSet.has(i));
    if (unshown.length) {
      const shown = unshown.slice(0, OTHER_SIGNAL_CAP);
      const remaining = unshown.length - shown.length;
      let line = `Other signal lines (not shown): ${shown.map((i) => `L${i + 1}`).join(', ')}`;
      if (remaining > 0) line += ` ... (+${remaining} more)`;
      out.push(line);
    }
    out.push('');
  }
  out.push('Structure (head + tail; read the file for the rest):');
  let last = -1;
  for (const i of structSorted) {
    if (i - last > 1) out.push(`  ... ${i - last - 1} lines in the file only ...`);
    out.push(`L${i + 1}: ${lines[i]}`);
    last = i;
  }
  return { body: out.join('\n'), total, census };
}

function maybeSidecar(cleaned, relevanceTokens, sessionId, hostMayTruncate) {
  if (process.env.TRIM_SIDECAR === 'off') return null;
  if (typeof cleaned !== 'string' || cleaned.length < SIDECAR_MIN_CHARS) return null;
  // A shell output at/above the host-truncation size was likely already cut
  // by the harness (see SIDECAR_SHELL_MAX): step aside to the inline cap.
  if (hostMayTruncate && cleaned.length >= SIDECAR_SHELL_MAX) return null;
  try {
    const fs = require('fs');
    const path = require('path');
    const name = (sessionId ? `${String(sessionId).replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 8)}-` : '') + `${cheapHash(cleaned)}.txt`;
    const file = path.join(SIDECAR_DIR, name);
    const d = buildSidecarDigest(cleaned, relevanceTokens);
    const header =
      `[trim hook: this output is ${d.total} lines (${d.census || '0 signal lines'}) ` +
      `and was saved in full to ${file.replace(/\\/g, '/')}; the digest below keeps the head, tail, ` +
      `every prompt-named line, and a sample of the signal lines, each with its L<n> line number. ` +
      `For anything else, read that file with a line offset/limit around the L<n> numbers you need. ` +
      `If that file no longer exists, re-run the command instead.]`;
    const out = `${header}\n${d.body}`;
    // A near-line-free payload (one giant minified line) leaves the digest
    // nothing to cut — it would reproduce the input plus header overhead.
    // Bail before touching disk; the inline cap is a no-op there too.
    if (out.length >= cleaned.length) return null;
    fs.mkdirSync(SIDECAR_DIR, { recursive: true });
    if (!fs.existsSync(file)) require('./lib/safe-write').safeWriteFileSync(file, cleaned);
    return out;
  } catch {
    return null; // fall back to the normal capped view
  }
}

// A full re-read of a sidecar file would pull the entire saved output straight
// back into context. Adapters that see file reads cap those like any log but
// never re-sidecar them (or the middle of the file becomes unreachable);
// range reads come back small and pass untouched — the intended path.
function isSidecarPath(filePath) {
  if (typeof filePath !== 'string') return false;
  const path = require('path');
  return path.resolve(path.dirname(filePath.trim())) === path.resolve(SIDECAR_DIR);
}

// ---- read-path detection (adapters that hook file reads) ----
// Log-shaped: a .log (optionally rotated) extension anywhere, or a
// .log/.txt/.out file under a directory literally named log/logs. Source code
// never matches, so a capped read can never cut lines the model might need to
// edit byte-exactly.
const LOG_PATH_RE = /\.log(?:\.\d+)?$|[\\/]logs?[\\/][^\\/]+\.(?:log|txt|out)$/i;

function isLogPath(filePath) {
  return typeof filePath === 'string' && LOG_PATH_RE.test(filePath.trim());
}

// Machine-generated files nobody edits by hand: lockfiles, minified bundles,
// sourcemaps, anything under node_modules or a build-output directory. The
// model usually needs one entry, which the omission marker's re-read path
// (or a grep) still reaches. Path-shaped detection only.
const GENERATED_PATH_RE = new RegExp(
  '(?:^|[\\\\/])(?:package-lock\\.json|yarn\\.lock|pnpm-lock\\.yaml|npm-shrinkwrap\\.json|' +
    'cargo\\.lock|poetry\\.lock|gemfile\\.lock|composer\\.lock|go\\.sum|uv\\.lock|flake\\.lock)$' +
    '|\\.(?:min\\.(?:js|css)|bundle\\.js|map)$' +
    '|(?:^|[\\\\/])(?:node_modules|dist|\\.next|__pycache__)[\\\\/]',
  'i'
);

function isGeneratedPath(filePath) {
  return typeof filePath === 'string' && GENERATED_PATH_RE.test(filePath.trim());
}

// A bare "N lines elided" reads to the model as "signal might be hidden in
// this gap" — rational distrust that triggers an expensive re-run. But
// capLines keeps every SIGNAL_RE match by construction, so an omitted span
// PROVABLY contains no error/warning line; the marker states that guarantee.
// It also names its own provenance ("trim hook") so it attaches to a fact the
// harness planted ("hooks may intercept tool calls") instead of reading as an
// anonymous — injection-shaped — claim inside tool output.
function omittedMarker(n) {
  return `[trim hook: ${n} lines omitted from this view, none with errors/warnings]`;
}

// Keep every signal line (and every prompt-named line) wherever it sits, then
// spend the remaining budget 60/40 on head/tail. Gaps get in-place markers.
function capLines(lines, cap, relevanceTokens) {
  if (lines.length <= cap) return lines;
  const kept = new Set();
  lines.forEach((line, i) => {
    if (SIGNAL_RE.test(line)) kept.add(i);
  });
  for (const i of relevanceHits(lines, relevanceTokens)) kept.add(i);
  const budget = Math.max(0, cap - kept.size);
  const head = Math.ceil(budget * 0.6);
  const tail = budget - head;
  for (let i = 0; i < head && i < lines.length; i++) kept.add(i);
  for (let i = Math.max(0, lines.length - tail); i < lines.length; i++) kept.add(i);

  const sortedKept = [...kept].sort((a, b) => a - b);
  const out = [];
  let last = -1;
  for (const i of sortedKept) {
    if (i - last > 1) out.push(omittedMarker(i - last - 1));
    out.push(lines[i]);
    last = i;
  }
  if (lines.length - 1 - last > 0) out.push(omittedMarker(lines.length - 1 - last));
  out.push('[trim hook: output shortened; rerun with TRIM_OFF=1 prefix for the full version]');
  return out;
}

// opts (all optional):
//   exitCode?: number          — real exit code; otherwise failure is sniffed
//   isDump?: boolean           — plain file-dump command, use the fail cap
//   enumerate?: boolean        — prompt asked for EVERY/ALL: no elision at all
//   relevanceTokens?: string[] — prompt-named spans that must survive the cap
//   scale?: number             — context-pressure multiplier on the caps
//   sessionId?: string         — prefixes sidecar filenames
//   hostMayTruncate?: boolean  — shell output the harness may have already cut
//   noSidecar?: boolean        — cap inline, never write a sidecar (e.g. when
//                                the input IS a sidecar file being re-read)
function compress(text, opts) {
  if (!text) return { out: text, stats: null };
  const o = opts || {};
  const inBytes = Buffer.byteLength(text);

  // 1. ANSI / OSC escape sequences
  let s = text.replace(ANSI_RE, '');
  // 2. carriage-return progress lines: keep only final repaint per line
  s = resolveCarriageReturns(s);
  // 3. trailing whitespace + other control chars (keep \t)
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/[ \t]+$/gm, '');
  // 4. collapse 2+ blank lines to one
  s = s.replace(/\n{3,}/g, '\n\n');

  // 4.5 very large outputs: full text to a sidecar file, digest in its place.
  // The enumeration carve-out is exempt — its whole point is nothing elided.
  if (!o.enumerate && !o.noSidecar) {
    const side = maybeSidecar(s, o.relevanceTokens, o.sessionId, o.hostMayTruncate);
    if (side !== null) return { out: side, stats: { inBytes, outBytes: Buffer.byteLength(side) } };
  }

  // 5. consecutive duplicate lines -> single line with repeat count
  let lines = s.split('\n');
  const dedup = [];
  for (let i = 0; i < lines.length; ) {
    let n = 1;
    while (i + n < lines.length && lines[i + n] === lines[i] && lines[i] !== '') n++;
    if (n >= 3) {
      dedup.push(`${lines[i]}  [trim hook: line repeated ${n}x]`);
    } else {
      for (let k = 0; k < n; k++) dedup.push(lines[i]);
    }
    i += n;
  }
  lines = dedup;

  // 6. collapse runs of same-shaped log lines — skipped for enumeration
  // requests, where collapsing would remove the very items asked for
  if (!o.enumerate) lines = collapseTemplates(lines);

  // 7. size cap: failing output (or a file dump) is evidence — keep ~2.5x
  // more; enumeration requests get an effectively uncapped view
  const scale = typeof o.scale === 'number' ? o.scale : 1;
  const cap = o.enumerate
    ? CAP_ENUMERATE
    : o.isDump || looksLikeFailure(s, o.exitCode)
      ? Math.max(FLOOR_FAIL, Math.round(CAP_FAIL * scale))
      : Math.max(FLOOR_PASS, Math.round(CAP_PASS * scale));
  lines = capLines(lines, cap, o.relevanceTokens);

  const out = lines.join('\n');
  return { out, stats: { inBytes, outBytes: Buffer.byteLength(out) } };
}

// Pull an exit code out of a structured tool response, when the agent
// provides one. Adapters pass it via opts.exitCode.
function extractExitCode(response) {
  if (response && typeof response === 'object') {
    for (const key of ['exitCode', 'exit_code', 'code']) {
      if (typeof response[key] === 'number') return response[key];
    }
  }
  return undefined;
}

// Optional install-verification logging: set TRIM_LOG=/path to append one
// line per compression. Hooks run without our shell env, so `touch
// ~/.trim-debug` also enables it (rm to disable).
function maybeLog(tag, stats) {
  if (!stats) return;
  try {
    const fs = require('fs');
    const dbg = require('os').homedir() + '/.trim-debug';
    const path = process.env.TRIM_LOG || (fs.existsSync(dbg) ? dbg : null);
    if (!path) return;
    fs.appendFileSync(path, `${new Date().toISOString()} ${tag} ${stats.inBytes} -> ${stats.outBytes}\n`);
  } catch {}
}

module.exports = {
  compress,
  maybeLog,
  extractExitCode,
  isFileDump,
  looksLikeFailure,
  capLines,
  collapseTemplates,
  requestsEnumeration,
  extractRelevanceTokens,
  pressureScale,
  signalCensus,
  buildSidecarDigest,
  maybeSidecar,
  isSidecarPath,
  isLogPath,
  isGeneratedPath,
  SIDECAR_DIR,
};

if (require.main === module) {
  if (process.env.TRIM_OFF === '1') {
    process.stdin.pipe(process.stdout);
  } else {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => {
      const { out, stats } = compress(buf);
      process.stdout.write(out);
      if (stats && process.env.TRIM_STATS === '1') {
        process.stderr.write(`trim: ${stats.inBytes} -> ${stats.outBytes} bytes\n`);
      }
    });
  }
}
