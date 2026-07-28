#!/usr/bin/env node
'use strict';
// trim-core: deterministic, model-free compression of tool/command output.
// stdin -> compressed stdout. Lossless transforms always; lossy elision only
// past size caps — and the cap keeps EVERY error/warning line by construction,
// so omission markers can honestly promise no signal was cut. Failing runs
// are evidence, not noise: they get a much larger cap than passing runs.

// Caps are in lines. TRIM_MAX_LINES is honored as a legacy alias for the fail cap.
const crypto = require('crypto');
const { effectiveCaps } = require('./profiles');
// Enumeration carve-out cap: large enough that a normal noisy build/log passes
// whole — no omission markers at all — so a model asked to report EVERY item
// has nothing elided to distrust. Still bounded against pathological dumps.
const CAP_ENUMERATE = int(process.env.TRIM_CAP_ENUMERATE, 2000);
const TEMPLATE_MIN_RUN = int(process.env.TRIM_TEMPLATE_MIN_RUN, 5);

// Lines carrying the task's actual signal (errors, warnings, failures) survive
// the cap regardless of position. Deliberately broad: over-matching keeps a few
// extra lines, never fewer. The trailing \w*(?:Error|Warning)\b catches compound
// runtime names (TypeError, ReferenceError) that \bERROR\b misses.
// Pattern groups, in plain terms:
//  - classic keywords incl. plurals ("2 errors", "3 warnings" summary lines)
//  - compound runtime names (TypeError, DeprecationWarning, IOException)
//  - assertion vocabulary (assert/expected/received/actual — Jest/pytest
//    diff blocks have no "error" on the diff lines themselves)
//  - process-death vocabulary (segfault, core dumped, killed, OOM,
//    non-zero exit) — compilers and shells report failure without "error"
//  - test-runner glyph prefixes (✗ ✘ × ✖ ❯) and TAP "not ok"
//  - pytest "E   <detail>" continuation lines
const SIGNAL_RE = new RegExp(
  process.env.TRIM_KEEP_RE ||
    '\\b(err(or)?s?|warn(ing)?s?|fail(s|ed|ing|ure|ures)?|exception|traceback|panic|fatal|denied|refused|' +
      'timeout|timed out|not found|cannot|unable|deprecated|critical|assert(ion)?|expected|received|actual|' +
      'missing|unresolved|undefined reference|segfault|segmentation fault|core dumped|killed|aborted|' +
      'out of memory|stack overflow|unhandled|uncaught|non-zero exit|exit code [1-9][0-9]*)\\b|' +
      '^\\s*(?:✗|✘|×|✖|❯)|\\bnot ok\\b|^E\\s{2,}\\S',
  'i'
);
// Compound runtime names (TypeError, DeprecationWarning, IOException) need
// their CamelCase intact — under /i, \w*Error\b would match "Terror". Kept
// case-sensitive in a second pattern; isSignal() is the one true test.
const COMPOUND_RE = /\w*(?:Error|Warning|Exception)\b/;

function isSignal(line) {
  return (
    SIGNAL_RE.test(line) ||
    ((line.includes('Error') || line.includes('Warning') || line.includes('Exception')) && COMPOUND_RE.test(line))
  );
}

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

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function protectedTrailer(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    return KEEP_LAST_RE.test(lines[i]) ? lines[i] : null;
  }
  return null;
}

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

function collapseTemplates(lines, counter) {
  if (process.env.TRIM_TEMPLATE === 'off') return lines;
  const out = [];
  let runStart = -1;
  let anchorTokens = null;
  let runLen = 0;

  function flushRun() {
    if (runLen >= TEMPLATE_MIN_RUN) {
      out.push(lines[runStart]);
      out.push(`[trim hook: ${runLen - 1} similar lines collapsed (same shape, varying values)]`);
      if (counter) counter.collapsed = (counter.collapsed || 0) + runLen - 1;
    } else {
      for (let i = runStart; i < runStart + runLen; i++) out.push(lines[i]);
    }
    runStart = -1;
    anchorTokens = null;
    runLen = 0;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isSignal(line)) {
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
const RELEVANCE_STOP = new Set(['error', 'warning', 'failed', 'output', 'result', 'everything', 'all', 'keep']);

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

function mergeRelevance(relevance, legacyTokens) {
  const out = [];
  const add = (value) => {
    if (typeof value !== 'string') return;
    const token = value.trim().toLowerCase();
    if (token.length < 3 || token.length > 120 || RELEVANCE_STOP.has(token) || out.includes(token)) return;
    out.push(token);
  };
  for (const token of Array.isArray(legacyTokens) ? legacyTokens.slice(0, 8) : []) add(token);
  if (relevance && typeof relevance === 'object' && !Array.isArray(relevance)) {
    for (const key of ['paths', 'identifiers', 'diagnosticCodes', 'testNames']) {
      const values = Array.isArray(relevance[key]) ? relevance[key].slice(0, 8) : [];
      for (const value of values) add(value);
    }
  }
  return out.slice(0, 24);
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

function pressureScale(transcriptBytes, prevBand) {
  if (!Number.isFinite(transcriptBytes)) return bandResult('low', prevBand);
  let band;
  if (prevBand === 'high' && transcriptBytes >= PRESSURE_HIGH_BYTES * 0.9) band = 'high';
  else if (prevBand === 'mid' && transcriptBytes >= PRESSURE_MID_BYTES * 0.9 && transcriptBytes < PRESSURE_HIGH_BYTES * 1.1) band = 'mid';
  else if (prevBand === 'low' && transcriptBytes < PRESSURE_MID_BYTES * 1.1) band = 'low';
  else band = transcriptBytes < PRESSURE_MID_BYTES ? 'low' : transcriptBytes < PRESSURE_HIGH_BYTES ? 'mid' : 'high';
  return bandResult(band, prevBand);
}

function bandResult(band, prevBand) {
  const scale = band === 'high' ? 0.5 : band === 'mid' ? 0.75 : 1;
  return prevBand === undefined ? scale : { scale, band };
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
  { singular: 'error', plural: 'errors', re: /\w*(?:Error|Exception)\b|\berr(or)?s?\b|\bpanic\b|\btraceback\b|\bfatal\b/i },
  { singular: 'failure', plural: 'failures', re: /\bfail(s|ed|ing|ure|ures)?\b|^\s*[✗✘×✖]|\bnot ok\b/i },
  { singular: 'critical', plural: 'criticals', re: /\bcritical\b/i },
  { singular: 'warning', plural: 'warnings', re: /\w*Warning\b|\bwarn(ing)?s?\b/i },
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

function stripAnsi(text) {
  return String(text || '').replace(ANSI_RE, '');
}

function hostCompleteness(text, isRead) {
  if (isRead) return true;
  return Buffer.byteLength(text || '') < SIDECAR_SHELL_MAX && !/\boutput (?:was )?truncated\b|full output saved/i.test(text || '');
}

function buildSidecarDigest(cleaned, relevanceTokens) {
  const lines = cleaned.split('\n');
  const total = lines.length;
  const signalIdx = [];
  lines.forEach((l, i) => {
    if (isSignal(l)) signalIdx.push(i);
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

// Bounded retention: sidecars live in tmpdir and the OS eventually clears
// them, but Linux tmp cleaning can be days away. On each write, best-effort
// delete sidecar files older than TRIM_SIDECAR_TTL_HOURS (default 72h).
// Scan is capped so a pathological directory can't slow a hook down.
const SIDECAR_TTL_MS = int(process.env.TRIM_SIDECAR_TTL_HOURS, 72) * 3600 * 1000;
const SIDECAR_SWEEP_MAX = 200;

function sweepSidecars(fs, path, now) {
  try {
    const names = fs.readdirSync(SIDECAR_DIR).slice(0, SIDECAR_SWEEP_MAX);
    for (const n of names) {
      const p = path.join(SIDECAR_DIR, n);
      try {
        if (now - fs.statSync(p).mtimeMs > SIDECAR_TTL_MS) fs.unlinkSync(p);
      } catch {
        /* raced or unreadable — skip */
      }
    }
  } catch {
    /* directory missing or unreadable — nothing to sweep */
  }
}

// Content-addressed sidecar write: full cleaned text plus a .meta.json
// companion (machine-readable, for tooling like PalSync — never shown to the
// model). Idempotent per content. Returns the file path, or null on any
// filesystem trouble (callers fall back to inline capping).
function sha256(text) {
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

function writeSidecarFile(cleaned, sessionId, census, opts) {
  if (process.env.TRIM_SIDECAR === 'off') return null;
  try {
    const fs = require('fs');
    const path = require('path');
    const name = (sessionId ? `${String(sessionId).replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 8)}-` : '') + `${cheapHash(cleaned)}.txt`;
    const file = path.join(SIDECAR_DIR, name);
    fs.mkdirSync(SIDECAR_DIR, { recursive: true });
    sweepSidecars(fs, path, Date.now());
    const { safeWriteFileSync } = require('./lib/safe-write');
    if (!fs.existsSync(file)) {
      safeWriteFileSync(file, cleaned);
      const o = opts || {};
      const observed = countSignals(cleaned);
      safeWriteFileSync(
        file.replace(/\.txt$/, '.meta.json'),
        JSON.stringify({
          schema: 'agent-trim/sidecar-meta/2',
          content: o.hostComplete === false ? 'host-truncated' : 'complete-cleaned',
          runtime: o.runtime || 'unknown',
          totalLinesObserved: cleaned.split('\n').length,
          bytesObserved: Buffer.byteLength(cleaned),
          hostComplete: o.hostComplete !== false,
          diagnostics: { errors: observed.errors, warnings: observed.warnings },
          contentHash: sha256(cleaned),
          census: census || '',
          sessionId: sessionId || null,
          createdAt: new Date().toISOString(),
        }) + '\n'
      );
    }
    return file;
  } catch {
    return null;
  }
}

function readSidecarMeta(file) {
  try {
    const fs = require('fs');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.schema === 'agent-trim/sidecar-meta/2') return value;
    if (value.schema !== 'agent-trim/sidecar-meta/1') return null;
    return {
      schema: 'agent-trim/sidecar-meta/2',
      content: 'complete-cleaned',
      runtime: 'unknown',
      totalLinesObserved: value.totalLines,
      bytesObserved: value.bytes,
      hostComplete: true,
      diagnostics: { errors: 0, warnings: 0 },
      contentHash: null,
      census: value.census || '',
      sessionId: value.sessionId || null,
      createdAt: value.createdAt || null,
    };
  } catch {
    return null;
  }
}

// Digest-view sidecar for very large generic outputs. Returns { out, file }
// or null when the sidecar path doesn't apply.
function maybeSidecar(cleaned, relevanceTokens, sessionId, hostMayTruncate, opts) {
  if (process.env.TRIM_SIDECAR === 'off') return null;
  const o = opts || {};
  if (typeof cleaned !== 'string' || cleaned.length < (o.sidecarMin || effectiveCaps(o.profile).sidecarMin)) return null;
  // A shell output at/above the host-truncation size was likely already cut
  // by the harness (see SIDECAR_SHELL_MAX): step aside to the inline cap.
  if (hostMayTruncate && o.hostComplete === undefined && cleaned.length >= SIDECAR_SHELL_MAX) return null;
  try {
    const path = require('path');
    const name = (sessionId ? `${String(sessionId).replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 8)}-` : '') + `${cheapHash(cleaned)}.txt`;
    const file = path.join(SIDECAR_DIR, name);
    const d = buildSidecarDigest(cleaned, relevanceTokens);
    const header =
      `[trim hook: this output is ${d.total} lines (${d.census || '0 signal lines'}) ` +
      `and was ${o.hostComplete === false ? 'saved as observed (host may have truncated)' : 'saved in full'} to ${file.replace(/\\/g, '/')}; the digest below keeps the head, tail, ` +
      `every prompt-named line, and a sample of the signal lines, each with its L<n> line number. ` +
      `For anything else, read that file with a line offset/limit around the L<n> numbers you need. ` +
      `If that file no longer exists, re-run the command instead.]`;
    const out = `${header}\n${d.body}`;
    // A near-line-free payload (one giant minified line) leaves the digest
    // nothing to cut — it would reproduce the input plus header overhead.
    // Bail before touching disk; the inline cap is a no-op there too.
    if (out.length >= cleaned.length) return null;
    const written = writeSidecarFile(cleaned, sessionId, d.census, o);
    if (!written) return null;
    return { out, file: written };
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
// `counter`, when given, accumulates how many real lines were dropped.
function capLines(lines, cap, relevanceTokens, counter) {
  if (lines.length <= cap) return lines;
  const kept = new Set();
  const signalKept = new Set();
  lines.forEach((line, i) => {
    if (isSignal(line)) {
      kept.add(i);
      signalKept.add(i);
    }
  });
  const relevanceKept = new Set();
  const relevanceBudget = cap;
  const keepRelevant = (i) => {
    if (i < 0 || i >= lines.length || relevanceKept.has(i) || relevanceKept.size >= relevanceBudget) return;
    relevanceKept.add(i);
    kept.add(i);
  };
  for (const i of relevanceHits(lines, relevanceTokens)) {
    keepRelevant(i);
    keepRelevant(i - 1);
    keepRelevant(i + 1);
    // Blank-line-delimited diagnostic blocks stay intact when relevance lands
    // inside one. A small per-hit window and total budget prevent scattered
    // hits from tiling a dense log and bypassing the cap.
    for (let j = i - 2, n = 0; j >= 0 && lines[j].trim() && n < 20; j--, n++) keepRelevant(j);
    for (let j = i + 2, n = 0; j < lines.length && lines[j].trim() && n < 20; j++, n++) keepRelevant(j);
    if (relevanceKept.size >= relevanceBudget) break;
  }
  // Mostly-signal output (error dumps, adversarial prose full of the word
  // "error"): cutting the few non-signal lines saves almost nothing and the
  // markers can even GROW the result while dropping the tail. Keep it whole.
  if (signalKept.size >= lines.length * 0.9) return lines;
  const budget = Math.max(0, cap - kept.size);
  const head = Math.ceil(budget * 0.6);
  const tail = budget - head;
  for (let i = 0; i < head && i < lines.length; i++) kept.add(i);
  for (let i = Math.max(0, lines.length - tail); i < lines.length; i++) kept.add(i);

  const sortedKept = [...kept].sort((a, b) => a - b);
  const out = [];
  let last = -1;
  let omitted = 0;
  for (const i of sortedKept) {
    if (i - last > 1) {
      out.push(omittedMarker(i - last - 1));
      omitted += i - last - 1;
    }
    out.push(lines[i]);
    last = i;
  }
  if (lines.length - 1 - last > 0) {
    out.push(omittedMarker(lines.length - 1 - last));
    omitted += lines.length - 1 - last;
  }
  out.push('[trim hook: output shortened; rerun with TRIM_OFF=1 prefix for the full version]');
  if (counter) counter.omitted = (counter.omitted || 0) + omitted;
  return out;
}

// ---- structured-format strategies ----
// Semantic compressors for recognizable machine formats (test runners,
// eslint --format json, diffstat, JSONL logs, ...). Live in bin/strategies/;
// each does its own conservative detection. Any throw — including a missing
// strategies directory — falls back to the generic pipeline. TRIM_STRATEGIES=off
// disables the whole layer.
function applyStrategies(cleaned, opts) {
  if (process.env.TRIM_STRATEGIES === 'off') return null;
  try {
    return require('./strategies')(cleaned, {
      command: opts.command,
      exitCode: opts.exitCode,
      isSignal,
    });
  } catch {
    return null;
  }
}

// Signal counts over an output view, for the result contract. Marker lines
// the hook itself added are excluded so counts describe the tool's output.
function countSignals(text) {
  let errors = 0;
  let warnings = 0;
  for (const l of text.split('\n')) {
    if (l.includes('[trim hook:')) continue;
    if (!isSignal(l)) continue;
    const cat = CENSUS_CATEGORIES.findIndex((c) => c.re.test(l));
    if (cat >= 0 && cat <= 2) errors++; // error / failure / critical
    else if (cat > 2) warnings++; // warning / deprecation
  }
  return { errors, warnings };
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
//   command?: string           — the shell command, for strategy detection
//
// Returns { out, stats, meta }:
//   stats — { inBytes, outBytes } (legacy shape, kept for compatibility)
//   meta  — the full trimming result contract (see buildMeta); internal
//           metadata for adapters/telemetry, never shown to the model.
function buildMeta(text, out, o, extra) {
  const kept = countSignals(out);
  return {
    changed: out !== text,
    strategy: extra.strategy,
    inputBytes: Buffer.byteLength(text),
    outputBytes: Buffer.byteLength(out),
    inputLines: extra.inputLines,
    outputLines: out.split('\n').length,
    lossy: !!extra.lossy,
    preservedErrors: kept.errors,
    preservedWarnings: kept.warnings,
    omittedLines: extra.omittedLines || 0,
    sidecarPath: extra.sidecarPath || null,
    hostComplete: o.hostComplete !== false,
    runtime: o.runtime || null,
    profile: o._profile || null,
    reason: extra.reason,
  };
}

function compress(text, opts) {
  if (!text) return { out: text, stats: null, meta: null };
  const o = { ...(opts || {}) };
  if (!o.profile && !process.env.TRIM_PROFILE && o.relevance && o.relevance.taskPhase === 'final-verification') {
    o.profile = 'final-verification';
  }
  const caps = effectiveCaps(o.profile);
  o._profile = caps.profile;
  const relevanceTokens = mergeRelevance(o.relevance, o.relevanceTokens);
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
  const inputLines = s.split('\n').length;
  const trailer = protectedTrailer(text);
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

  // 4.4 structured-format strategies: when the cleaned text is recognizably a
  // known machine format (test runner, eslint --format json, diffstat, ...),
  // semantic compression beats generic line capping. Detection is
  // conservative; any miss or throw falls through to the generic path.
  // Enumeration prompts skip strategies too — their point is nothing elided.
  if (!o.enumerate) {
    const strat = applyStrategies(s, o);
    if (strat !== null) {
      // Lossy strategy output over the sidecar threshold still gets a full
      // recoverable copy on disk, pointer appended to the rendered view.
      let sidecarPath = null;
      let out = strat.out;
      if (
        strat.lossy &&
        !o.noSidecar &&
        s.length >= caps.sidecarMin &&
        !(o.hostMayTruncate && o.hostComplete === undefined && s.length >= SIDECAR_SHELL_MAX)
      ) {
        const side = writeSidecarFile(s, o.sessionId, '', o);
        if (side) {
          sidecarPath = side;
          out +=
            o.hostComplete === false
              ? `\n[trim hook: ${inputLines}-line output saved as observed (host may have truncated) to ${side.replace(/\\/g, '/')} — read with offset/limit if needed]`
              : `\n[trim hook: full ${inputLines}-line output saved to ${side.replace(/\\/g, '/')} — read with offset/limit if needed]`;
        }
      }
      if (out.length < s.length) {
        return done(out, {
          strategy: strat.strategy,
          lossy: strat.lossy,
          omittedLines: strat.omittedLines || 0,
          sidecarPath,
          reason: strat.reason,
        });
      }
      // strategy didn't actually shrink it — fall through to generic
    }
  }

  // 4.5 very large outputs: full text to a sidecar file, digest in its place.
  // The enumeration carve-out is exempt — its whole point is nothing elided.
  if (!o.enumerate && !o.noSidecar) {
    const side = maybeSidecar(s, relevanceTokens, o.sessionId, o.hostMayTruncate, { ...o, sidecarMin: caps.sidecarMin });
    if (side !== null) {
      return done(side.out, {
        strategy: 'sidecar',
        lossy: true,
        omittedLines: Math.max(0, inputLines - side.out.split('\n').length),
        sidecarPath: side.file,
        reason: 'very large output moved to sidecar file, digest kept inline',
      });
    }
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
  const counter = { omitted: 0, collapsed: 0 };
  if (!o.enumerate) lines = collapseTemplates(lines, counter);

  // 7. size cap: failing output (or a file dump) is evidence — keep ~2.5x
  // more; enumeration requests get an effectively uncapped view
  const scale = typeof o.scale === 'number' ? o.scale : 1;
  const cap = o.enumerate
    ? CAP_ENUMERATE
    : o.isDump || looksLikeFailure(s, o.exitCode)
      ? Math.max(FLOOR_FAIL, Math.round(caps.fail * scale))
      : Math.max(FLOOR_PASS, Math.round(caps.pass * scale));
  lines = capLines(lines, cap, relevanceTokens, counter);

  const out = lines.join('\n');
  const lossy = counter.omitted > 0 || counter.collapsed > 0;
  if (out.length >= s.length && counter.omitted > 0) {
    return done(s, {
      strategy: 'generic',
      lossy: false,
      omittedLines: 0,
      sidecarPath: null,
      reason: 'lossless cleanup only; elision markers would not shrink output',
    });
  }
  return done(out, {
    strategy: 'generic',
    lossy,
    omittedLines: counter.omitted + counter.collapsed,
    sidecarPath: null,
    reason: lossy
      ? counter.omitted > 0
        ? 'capped repetitive output, all signal lines kept'
        : 'same-shaped log runs collapsed, counts kept'
      : 'lossless cleanup only',
  });
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
//
// Structured metrics (opt-in, local only, never leaves the machine): set
// TRIM_METRICS=/path or `touch ~/.trim-metrics.jsonl` and every compression
// appends one JSON line carrying the full result contract plus a command
// FINGERPRINT (first word + content hash — never the command text itself,
// so secrets in arguments can't leak into the log). Summarize with
// bin/trim-stats.js. `extra.bypass` records TRIM_OFF usage.
function metricsPath() {
  const fs = require('fs');
  if (process.env.TRIM_METRICS) return process.env.TRIM_METRICS;
  const p = require('os').homedir() + '/.trim-metrics.jsonl';
  return fs.existsSync(p) ? p : null;
}

function maybeLog(tag, stats, meta, extra) {
  try {
    const fs = require('fs');
    if (stats) {
      const dbg = require('os').homedir() + '/.trim-debug';
      const path = process.env.TRIM_LOG || (fs.existsSync(dbg) ? dbg : null);
      if (path) fs.appendFileSync(path, `${new Date().toISOString()} ${tag} ${stats.inBytes} -> ${stats.outBytes}\n`);
    }
    const mPath = metricsPath();
    if (mPath) {
      const e = extra || {};
      const rec = {
        ts: new Date().toISOString(),
        tag,
        ...(meta
          ? {
              strategy: meta.strategy,
              changed: e.applied === false ? false : meta.changed,
              lossy: e.applied === false ? false : meta.lossy,
              inBytes: meta.inputBytes,
              outBytes: e.applied === false ? meta.inputBytes : meta.outputBytes,
              inLines: meta.inputLines,
              outLines: e.applied === false ? meta.inputLines : meta.outputLines,
              omittedLines: e.applied === false ? 0 : meta.omittedLines,
              errors: meta.preservedErrors,
              warnings: meta.preservedWarnings,
              sidecar: e.applied === false ? false : !!meta.sidecarPath,
              hostTruncated: meta.hostComplete === false,
              runtime: meta.runtime,
              profile: meta.profile,
            }
          : stats
            ? { inBytes: stats.inBytes, outBytes: stats.outBytes }
            : {}),
        ...(typeof e.command === 'string' && e.command
          ? { cmdWord: e.command.trim().split(/\s+/, 1)[0].slice(0, 32), cmdHash: cheapHash(e.command) }
          : {}),
        ...(e.bypass ? { bypass: true } : {}),
        ...(e.applied === false ? { applied: false } : {}),
        ...(typeof e.durMs === 'number' ? { durMs: +e.durMs.toFixed(3) } : {}),
        ...(e.dupExact ? { dupExact: true, dupAgeMs: e.dupAgeMs ?? null } : {}),
        ...(typeof e.narrationWords === 'number' ? { narrationWords: e.narrationWords } : {}),
        ...(e.narrationExceeded ? { narrationExceeded: true } : {}),
        ...(typeof e.profile === 'string' && e.profile ? { profile: e.profile } : {}),
        // Optional caller-owned block (see docs/palsync.md): embedding tools
        // like PalSync attach their own measurements (raw bytes before their
        // native summarization, cache hits) without trim knowing about them.
        ...(e.palsync && typeof e.palsync === 'object' ? { palsync: e.palsync } : {}),
      };
      fs.appendFileSync(mPath, JSON.stringify(rec) + '\n');
    }
  } catch {}
}

module.exports = {
  compress,
  countSignals,
  isSignal,
  writeSidecarFile,
  readSidecarMeta,
  sha256,
  mergeRelevance,
  maybeLog,
  extractExitCode,
  isFileDump,
  looksLikeFailure,
  FAILURE_RE,
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
  cheapHash,
  stripAnsi,
  hostCompleteness,
  SIDECAR_DIR,
  protectedTrailer,
  KEEP_LAST_RE,
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
