#!/usr/bin/env node
'use strict';
// trim doctor — answers one question: is what my agents actually run the same
// as what is in this repo?
//
//   node bin/trim-doctor.js          # or: npm run doctor, ./install.sh --check
//   node bin/trim-doctor.js --json
//
// Exit 0 = everything in sync. Exit 1 = at least one drift found (so it can gate
// a pull in a script). Never writes anything; `./install.sh` is the fix for
// every drift it reports.
//
// Background: installed files fall into two classes with opposite update
// semantics. Hook commands and `require`s point at absolute paths inside this
// repo, so `git pull` updates them for every harness at once — nothing to check.
// The rendered harness wrappers and the appended style blocks are COPIES, and a
// pull cannot touch them. Those are what this checks.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOME = process.env.TRIM_DOCTOR_HOME || os.homedir();
const asJson = process.argv.includes('--json');
const findings = [];

function add(level, area, detail, fix) {
  findings.push({ level, area, detail, fix });
}

function render(srcRelPath) {
  return fs.readFileSync(path.join(ROOT, srcRelPath), 'utf8').split('__TRIM_ROOT__').join(ROOT);
}

// --- 1. rendered wrappers: snapshot vs current source ---
const WRAPPERS = [
  { name: 'opencode', src: 'adapters/opencode-trim.ts', dest: '.config/opencode/plugins/trim.ts', hostDir: '.config/opencode' },
  { name: 'pi', src: 'adapters/pi-trim.ts', dest: '.pi/agent/extensions/trim.ts', hostDir: '.pi/agent' },
];
for (const w of WRAPPERS) {
  const hostPresent = fs.existsSync(path.join(HOME, w.hostDir));
  const dest = path.join(HOME, w.dest);
  if (!fs.existsSync(dest)) {
    if (hostPresent) add('stale', w.name, `${w.name} is installed but ${w.dest} is missing — trim is not wired into it`, './install.sh');
    continue;
  }
  const want = render(w.src);
  const have = fs.readFileSync(dest, 'utf8');
  if (want === have) add('ok', w.name, `${w.dest} matches ${w.src}`, null);
  else {
    const wl = want.split('\n');
    const hl = have.split('\n');
    const n = wl.reduce((c, line, i) => c + (line !== hl[i] ? 1 : 0), 0) + Math.max(0, hl.length - wl.length);
    add('stale', w.name, `${w.dest} differs from ${w.src} (${n} line(s)) — running an older build than this repo`, './install.sh');
  }
}

// --- 2. hook wiring: does the harness point at THIS repo? ---
// A hook command naming a different checkout means an old clone is still live —
// the failure mode a pull cannot fix and that silently halves your metrics.
const HOOKS = [
  { name: 'claude', file: '.claude/settings.json', hostDir: '.claude' },
  { name: 'codex', file: '.codex/hooks.json', hostDir: '.codex' },
];
for (const h of HOOKS) {
  if (!fs.existsSync(path.join(HOME, h.hostDir))) continue;
  const file = path.join(HOME, h.file);
  if (!fs.existsSync(file)) {
    add('stale', h.name, `${h.name} is installed but ${h.file} is missing — trim is not wired into it`, './install.sh');
    continue;
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
    JSON.parse(raw);
  } catch {
    add('warn', h.name, `${h.file} is not valid JSON — cannot verify wiring`, 'inspect the file by hand');
    continue;
  }
  const mine = raw.includes(`${ROOT}/adapters/`);
  const foreign = /"command":\s*"[^"]*\/adapters\/(claude|codex)-[\w-]+\.js/.test(raw) && !mine;
  if (mine && !foreign) add('ok', h.name, `${h.file} points at this repo`, null);
  else if (foreign) add('stale', h.name, `${h.file} runs trim adapters from a DIFFERENT checkout, not ${ROOT}`, './install.sh');
  else add('stale', h.name, `${h.file} has no trim hooks`, './install.sh');
}

// --- 3. style blocks: appended once, then frozen ---
// install.sh's append_style returns early when the start marker exists, so an
// edited style/TERSE.md never reaches an already-installed instructions file.
const STYLE_SRC = fs.existsSync(path.join(ROOT, 'style', 'TERSE.md'))
  ? fs.readFileSync(path.join(ROOT, 'style', 'TERSE.md'), 'utf8')
  : null;
const STYLE_TARGETS = [
  { name: 'claude', file: '.claude/CLAUDE.md', hostDir: '.claude' },
  { name: 'codex', file: '.codex/AGENTS.md', hostDir: '.codex' },
  { name: 'opencode', file: '.config/opencode/AGENTS.md', hostDir: '.config/opencode' },
  { name: 'pi', file: '.pi/agent/AGENTS.md', hostDir: '.pi/agent' },
];
if (STYLE_SRC) {
  for (const t of STYLE_TARGETS) {
    if (!fs.existsSync(path.join(HOME, t.hostDir))) continue;
    const file = path.join(HOME, t.file);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const start = text.indexOf('<!-- trim:style:start -->');
    const end = text.indexOf('<!-- trim:style:end -->');
    if (start === -1 || end === -1 || end < start) continue; // no block: user opted out with --no-style
    const installed = text.slice(start + '<!-- trim:style:start -->'.length, end).trim();
    if (installed === STYLE_SRC.trim()) add('ok', `${t.name} style`, `${t.file} style block matches style/TERSE.md`, null);
    else
      add(
        'stale',
        `${t.name} style`,
        `${t.file} style block differs from style/TERSE.md — install.sh skips files that already carry the marker`,
        `delete the trim:style block in ${t.file}, then ./install.sh`
      );
  }
}

// --- 4. harnesses present but never wired at all ---
for (const h of [...WRAPPERS, ...HOOKS]) {
  if (!fs.existsSync(path.join(HOME, h.hostDir))) add('absent', h.name, `${h.hostDir} not present — nothing to install`, null);
}

const stale = findings.filter((f) => f.level === 'stale');
const warn = findings.filter((f) => f.level === 'warn');

if (asJson) {
  console.log(JSON.stringify({ root: ROOT, inSync: stale.length === 0, findings }, null, 2));
} else {
  console.log(`trim doctor — ${ROOT}`);
  const glyph = { ok: '  ok  ', stale: ' STALE', warn: ' warn ', absent: '  --  ' };
  for (const f of findings) console.log(`${glyph[f.level]}  ${f.area.padEnd(14)} ${f.detail}`);
  console.log('');
  if (!stale.length && !warn.length) console.log('everything your agents run matches this repo. `git pull` keeps it that way.');
  else {
    if (stale.length) console.log(`${stale.length} drift(s) found. Fix: ${[...new Set(stale.map((f) => f.fix))].join('  |  ')}`);
    if (warn.length) console.log(`${warn.length} warning(s) — see above.`);
  }
}

process.exit(stale.length ? 1 : 0);
