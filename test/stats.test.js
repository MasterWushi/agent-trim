'use strict';
// T6: evidence labels in trim-stats output.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const STATS = path.join(REPO, 'bin', 'trim-stats.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-stats-test-'));

function run(args, file) {
  return execFileSync('node', [STATS, file, ...args], { encoding: 'utf8' });
}

// mixed old (no token fields) and new (with token fields) lines
{
  const file = path.join(tmp, 'mixed.jsonl');
  const oldRec = { ts: new Date().toISOString(), tag: 'claude', strategy: 'generic', changed: true, lossy: true, inBytes: 1000, outBytes: 200, cmdWord: 'npm' };
  const newRec = {
    ts: new Date().toISOString(),
    tag: 'claude',
    strategy: 'generic',
    changed: true,
    lossy: true,
    inBytes: 2000,
    outBytes: 300,
    inTokEst: 500,
    outTokEst: 80,
    tokenClass: 'dense',
    estimator: 'class/1',
    cmdWord: 'jest',
  };
  fs.writeFileSync(file, JSON.stringify(oldRec) + '\n' + JSON.stringify(newRec) + '\n');

  const out = run([], file);
  assert.ok(!/NaN/.test(out), 'no NaN in report output');
  assert.ok(!/\bundefined\b/.test(out), 'no undefined in report output');

  // every line containing % or "tokens" also contains a [L label
  for (const line of out.split('\n')) {
    if (line.includes('%') || line.includes('tokens')) {
      assert.ok(/\[L\d/.test(line), `line missing [L label: ${line}`);
    }
  }

  const json = JSON.parse(run(['--json'], file));
  for (const [key, val] of Object.entries(json)) {
    if (val && typeof val === 'object' && !Array.isArray(val) && 'value' in val) {
      assert.ok('evidence' in val, `${key} metric object missing evidence key`);
    }
  }
}

// empty metrics file -> clean "no data" message, exit 0
{
  const file = path.join(tmp, 'empty.jsonl');
  fs.writeFileSync(file, '');
  const out = execFileSync('node', [STATS, file], { encoding: 'utf8' });
  assert.ok(/no data/i.test(out), 'empty file produces a clean no-data message');
}

console.log('stats.test.js: all assertions passed');
