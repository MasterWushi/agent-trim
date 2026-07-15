#!/usr/bin/env node
'use strict';
// trim-core: deterministic, model-free compression of tool/command output.
// stdin -> compressed stdout. Lossless transforms always; lossy elision only
// past size caps, and elided regions keep error/warning lines plus a marker.

const MAX_LINES = int(process.env.TRIM_MAX_LINES, 300);
const HEAD_LINES = int(process.env.TRIM_HEAD_LINES, 120);
const TAIL_LINES = int(process.env.TRIM_TAIL_LINES, 80);
const KEEP_MATCH_MAX = int(process.env.TRIM_KEEP_MATCH_MAX, 40);
const KEEP_RE = new RegExp(
  process.env.TRIM_KEEP_RE ||
    '\\b(error|err!|warn(ing)?|fail(ed|ure)?|exception|traceback|panic|fatal|denied|refused|timeout|timed out|not found|cannot|unable)\\b',
  'i'
);

function int(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

function compress(text) {
  if (!text) return { out: text, stats: null };
  const inBytes = Buffer.byteLength(text);

  // 1. ANSI / OSC escape sequences
  let s = text.replace(ANSI_RE, '');
  // 2. carriage-return progress lines: keep only final repaint per line
  s = s
    .split('\n')
    .map((l) => {
      if (!l.includes('\r')) return l;
      const parts = l.split('\r');
      return parts[parts.length - 1] || parts[parts.length - 2] || '';
    })
    .join('\n');
  // 3. trailing whitespace + other control chars (keep \t)
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/[ \t]+$/gm, '');
  // 4. collapse 2+ blank lines to one
  s = s.replace(/\n{3,}/g, '\n\n');

  // 5. consecutive duplicate lines -> single line with repeat count
  let lines = s.split('\n');
  const dedup = [];
  for (let i = 0; i < lines.length; ) {
    let n = 1;
    while (i + n < lines.length && lines[i + n] === lines[i] && lines[i] !== '') n++;
    if (n >= 3) {
      dedup.push(`${lines[i]}  [trim: line repeated ${n}x]`);
    } else {
      for (let k = 0; k < n; k++) dedup.push(lines[i]);
    }
    i += n;
  }
  lines = dedup;

  // 6. size cap with error-aware elision
  if (lines.length > MAX_LINES) {
    const head = lines.slice(0, HEAD_LINES);
    const tail = lines.slice(lines.length - TAIL_LINES);
    const middle = lines.slice(HEAD_LINES, lines.length - TAIL_LINES);
    const kept = middle.filter((l) => KEEP_RE.test(l)).slice(0, KEEP_MATCH_MAX);
    const marker = `[trim: ${middle.length - kept.length} lines elided${kept.length ? `; ${kept.length} error/warn lines kept below` : ''} — rerun with TRIM_OFF=1 for full output]`;
    lines = [...head, '', marker, ...kept, '', ...tail];
  }

  const out = lines.join('\n');
  return { out, stats: { inBytes, outBytes: Buffer.byteLength(out) } };
}

// Optional install-verification logging: set TRIM_LOG=/path to append one
// line per compression. Used by live smoke tests; off by default.
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

module.exports = { compress, maybeLog };

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
