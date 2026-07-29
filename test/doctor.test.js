'use strict';
// trim-doctor contract: it must find every drift class that `git pull` cannot
// fix, and stay silent about the ones a pull already handles. Driven against a
// fake HOME via TRIM_DOCTOR_HOME so the real install is never touched.
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCTOR = path.join(ROOT, 'bin', 'trim-doctor.js');

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-doctor-'));
  return home;
}
function run(home) {
  const r = spawnSync(process.execPath, [DOCTOR, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, TRIM_DOCTOR_HOME: home },
    timeout: 10000,
  });
  return { status: r.status, report: JSON.parse(r.stdout) };
}
const find = (rep, area) => rep.findings.filter((f) => f.area === area);
const rendered = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').split('__TRIM_ROOT__').join(ROOT);
const write = (p, s) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s);
};

// --- empty home: nothing installed, nothing to report as drift ---
{
  const home = fakeHome();
  const { status, report } = run(home);
  assert.strictEqual(status, 0, 'no harnesses -> exit 0');
  assert.ok(report.inSync, 'no harnesses -> in sync');
  assert.ok(report.findings.every((f) => f.level === 'absent'), 'everything reported absent');
  fs.rmSync(home, { recursive: true, force: true });
}

// --- opencode wrapper in sync -> ok; drifted -> stale + nonzero exit ---
{
  const home = fakeHome();
  const dest = path.join(home, '.config', 'opencode', 'plugins', 'trim.ts');
  write(dest, rendered('adapters/opencode-trim.ts'));
  let r = run(home);
  assert.strictEqual(r.status, 0, 'matching wrapper -> exit 0');
  assert.strictEqual(find(r.report, 'opencode')[0].level, 'ok');

  // simulate the real 0.4.0 drift: an older build left behind by a git pull
  write(dest, rendered('adapters/opencode-trim.ts').replace('runtime.Trim', 'runtime.TrimOld'));
  r = run(home);
  assert.strictEqual(r.status, 1, 'drifted wrapper -> exit 1 so a script can gate on it');
  assert.strictEqual(find(r.report, 'opencode')[0].level, 'stale');
  assert.match(find(r.report, 'opencode')[0].fix, /install\.sh/);
  fs.rmSync(home, { recursive: true, force: true });
}

// --- harness present but never wired at all ---
{
  const home = fakeHome();
  fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
  const { status, report } = run(home);
  assert.strictEqual(status, 1, 'unwired harness is drift');
  assert.match(find(report, 'opencode')[0].detail, /not wired/);
  fs.rmSync(home, { recursive: true, force: true });
}

// --- claude hooks pointing at a DIFFERENT checkout: the drift a pull cannot fix ---
{
  const home = fakeHome();
  const settings = path.join(home, '.claude', 'settings.json');
  write(
    settings,
    JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: '^(Bash|Read)$', hooks: [{ type: 'command', command: 'node /old/clone/adapters/claude-posttooluse.js' }] },
        ],
      },
    })
  );
  const { status, report } = run(home);
  assert.strictEqual(status, 1, 'foreign checkout is drift');
  assert.match(find(report, 'claude')[0].detail, /DIFFERENT checkout/);

  // repointed at this repo -> ok
  write(
    settings,
    JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: '^(Bash|Read)$', hooks: [{ type: 'command', command: `node ${ROOT}/adapters/claude-posttooluse.js` }] },
        ],
      },
    })
  );
  assert.strictEqual(find(run(home).report, 'claude')[0].level, 'ok', 'own repo -> ok');
  fs.rmSync(home, { recursive: true, force: true });
}

// --- malformed settings.json warns instead of throwing ---
{
  const home = fakeHome();
  write(path.join(home, '.claude', 'settings.json'), '{not json');
  const { report } = run(home);
  assert.strictEqual(find(report, 'claude')[0].level, 'warn', 'unparseable settings warns, does not crash');
  fs.rmSync(home, { recursive: true, force: true });
}

// --- style block drift: install.sh skips files already carrying the marker ---
{
  const home = fakeHome();
  const style = fs.readFileSync(path.join(ROOT, 'style', 'TERSE.md'), 'utf8');
  const md = path.join(home, '.claude', 'CLAUDE.md');
  write(md, `# mine\n\n<!-- trim:style:start -->\n${style}\n<!-- trim:style:end -->\n`);
  assert.strictEqual(find(run(home).report, 'claude style')[0].level, 'ok', 'matching style block -> ok');

  write(md, `# mine\n\n<!-- trim:style:start -->\nan older revision of the style guide\n<!-- trim:style:end -->\n`);
  const drift = find(run(home).report, 'claude style')[0];
  assert.strictEqual(drift.level, 'stale', 'edited style/TERSE.md never reaches an installed file');
  assert.match(drift.fix, /delete the trim:style block/);

  // no block at all (installed with --no-style) is a choice, not drift
  write(md, '# mine, no trim block\n');
  assert.strictEqual(find(run(home).report, 'claude style').length, 0, '--no-style install is not reported as drift');
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('doctor.test.js: all assertions passed');
