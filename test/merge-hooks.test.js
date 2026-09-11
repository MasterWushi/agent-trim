'use strict';
// T3: merge-hooks.js must not silently replace third-party hooks whose
// command path happens to contain '/adapters/'.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = path.join(__dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-merge-hooks-test-'));
const HOME = path.join(sandbox, 'home');
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });

const settingsFile = path.join(HOME, '.claude', 'settings.json');
const foreignHook = {
  matcher: '^(Bash|Read)$',
  hooks: [{ type: 'command', command: 'node /opt/other/adapters/thing.js', timeout: 5000 }],
};
fs.writeFileSync(
  settingsFile,
  JSON.stringify(
    {
      permissions: { allow: ['Bash(npm run:*)'] },
      env: { FOO: 'bar' },
      hooks: {
        PostToolUse: [foreignHook],
        Stop: [{ hooks: [{ type: 'command', command: 'node /opt/palsync/stop.js' }] }],
      },
    },
    null,
    2
  )
);

const runMerge = () =>
  execFileSync('node', [path.join(REPO, 'adapters', 'merge-hooks.js'), 'claude'], {
    env: { ...process.env, HOME, ROOT: REPO },
    encoding: 'utf8',
  });

const settings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));

runMerge();
{
  const cfg = settings();
  const post = cfg.hooks.PostToolUse;
  assert.ok(
    post.some((h) => JSON.stringify(h).includes('/opt/other/adapters/thing.js')),
    'foreign hook still present'
  );
  assert.ok(
    post.some((h) => JSON.stringify(h).includes(`${REPO}/adapters/claude-posttooluse.js`)),
    "trim's hook also present"
  );
}

// running twice: trim's entry appears exactly once (idempotency preserved)
runMerge();
{
  const cfg = settings();
  const post = cfg.hooks.PostToolUse;
  const trimEntries = post.filter((h) => JSON.stringify(h).includes(`${REPO}/adapters/claude-posttooluse.js`));
  assert.strictEqual(trimEntries.length, 1, "trim's PostToolUse entry appears exactly once");
}

// unrelated top-level keys and Stop array preserved byte-for-byte
{
  const cfg = settings();
  assert.deepStrictEqual(cfg.permissions, { allow: ['Bash(npm run:*)'] }, 'permissions preserved');
  assert.deepStrictEqual(cfg.env, { FOO: 'bar' }, 'env preserved');
  assert.deepStrictEqual(
    cfg.hooks.Stop,
    [{ hooks: [{ type: 'command', command: 'node /opt/palsync/stop.js' }] }],
    'Stop array untouched'
  );
}

// an existing install's separate narration-meter entry is removed, not kept
{
  const cfg = settings();
  cfg.hooks.PostToolUse.push({
    hooks: [{ type: 'command', command: `node ${REPO}/adapters/claude-narration-meter.js`, timeout: 10000 }],
  });
  fs.writeFileSync(settingsFile, JSON.stringify(cfg, null, 2) + '\n');
  runMerge();
  const post = settings().hooks.PostToolUse;
  assert.ok(!JSON.stringify(post).includes('claude-narration-meter.js'), 'obsolete meter hook removed');
  assert.strictEqual(post.filter(mineEntry).length, 1, 'exactly one trim PostToolUse entry remains');
  assert.ok(
    post.some((h) => JSON.stringify(h).includes('/opt/other/adapters/thing.js')),
    'foreign hook survives the obsolete sweep'
  );
}

// legacy trim entry under the real ROOT with an old filename -> replaced in place, not duplicated
{
  const legacyFile = path.join(HOME, '.claude', 'settings.json');
  const cfg = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
  cfg.hooks.PostToolUse = cfg.hooks.PostToolUse.filter(
    (h) => !JSON.stringify(h).includes('claude-posttooluse.js')
  );
  cfg.hooks.PostToolUse.push({
    matcher: '^(Bash|Read)$',
    hooks: [{ type: 'command', command: `node ${REPO}/adapters/claude-posttooluse-old.js`, timeout: 10000 }],
  });
  fs.writeFileSync(legacyFile, JSON.stringify(cfg, null, 2) + '\n');
  runMerge();
  const after = settings();
  const post = after.hooks.PostToolUse;
  const trimEntries = post.filter((h) => mineEntry(h));
  assert.strictEqual(trimEntries.length, 1, 'legacy entry replaced in place, not duplicated');
  assert.ok(
    post.some((h) => JSON.stringify(h).includes('claude-posttooluse.js') && !JSON.stringify(h).includes('-old.js')),
    'legacy filename replaced by current one'
  );
}

function mineEntry(h) {
  return JSON.stringify(h).includes(`${REPO}/adapters/`);
}

console.log('merge-hooks.test.js: all assertions passed');
