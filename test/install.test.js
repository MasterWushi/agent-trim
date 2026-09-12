'use strict';
// Installer/uninstaller safety: idempotent double-install, preservation of
// user-owned configuration, clean uninstall. Runs against a sandboxed HOME
// and a copy of the repo so the real environment is never touched.
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = path.join(__dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-install-test-'));
const HOME = path.join(sandbox, 'home');
const WORK = path.join(sandbox, 'repo');

// copy the repo (sans .git/backup) so installer backups don't pollute the checkout
fs.mkdirSync(HOME, { recursive: true });
fs.cpSync(REPO, WORK, {
  recursive: true,
  filter: (src) => !/[\\/](\.git|backup|node_modules)([\\/]|$)/.test(src),
});

// user-owned config that must survive
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
fs.writeFileSync(
  path.join(HOME, '.claude', 'settings.json'),
  JSON.stringify(
    {
      model: 'opus',
      permissions: { allow: ['Bash(npm run:*)'] },
      hooks: {
        PostToolUse: [
          { matcher: '^Bash$', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] },
          { matcher: '^Read$', hooks: [{ type: 'command', command: 'node /opt/other/adapters/thing.js', timeout: 5000 }] },
          { hooks: [{ type: 'command', command: `node ${WORK}/adapters/claude-posttooluse.js`, timeout: 10000 }] },
        ],
      },
    },
    null,
    2
  )
);
fs.writeFileSync(path.join(HOME, '.claude', 'CLAUDE.md'), '# my rules\n\n- be nice\n');
fs.mkdirSync(path.join(HOME, '.config', 'opencode'), { recursive: true });
fs.mkdirSync(path.join(HOME, '.pi', 'agent'), { recursive: true });

const env = { ...process.env, HOME };
const install = () => execFileSync('bash', [path.join(WORK, 'install.sh')], { env, encoding: 'utf8' });
const uninstall = () => execFileSync('bash', [path.join(WORK, 'uninstall.sh')], { env, encoding: 'utf8' });
const settings = () => JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8'));
const claudeMd = () => fs.readFileSync(path.join(HOME, '.claude', 'CLAUDE.md'), 'utf8');

// ---- first install ----
install();
{
  const cfg = settings();
  assert.strictEqual(cfg.model, 'opus', 'user setting preserved');
  assert.deepStrictEqual(cfg.permissions, { allow: ['Bash(npm run:*)'] }, 'user permissions preserved');
  const post = cfg.hooks.PostToolUse;
  assert.ok(post.some((h) => JSON.stringify(h).includes('my-own-hook.sh')), 'user hook preserved');
  assert.ok(post.some((h) => JSON.stringify(h).includes('/opt/other/adapters/thing.js')), 'foreign /adapters/ hook preserved');
  const trimHook = post.find((h) => JSON.stringify(h).includes('claude-posttooluse.js'));
  assert.ok(trimHook, 'trim hook added');
  assert.strictEqual(trimHook.matcher, '^(Bash|Read)$', 'trim hook is scoped to Bash and Read');
  assert.ok(cfg.hooks.SubagentStart && cfg.hooks.PostCompact, 'extras wired');
  assert.ok(claudeMd().includes('<!-- trim:style:start -->'), 'style appended');
  assert.ok(claudeMd().startsWith('# my rules'), 'user CLAUDE.md content intact');
  assert.ok(fs.existsSync(path.join(HOME, '.config', 'opencode', 'plugins', 'trim.ts')), 'opencode plugin installed');
  const piExtension = fs.readFileSync(path.join(HOME, '.pi', 'agent', 'extensions', 'trim.ts'), 'utf8');
  assert.ok(piExtension.includes(path.join(WORK, 'adapters', 'lib', 'pi-runtime.js')), 'pi extension points at installed runtime');
}

// ---- second install: idempotent ----
install();
{
  const cfg = settings();
  const asStr = JSON.stringify(cfg.hooks.PostToolUse);
  assert.strictEqual((asStr.match(/claude-posttooluse\.js/g) || []).length, 1, 'no duplicate compressor hook');
  assert.ok(!asStr.includes('claude-narration-meter.js'), 'obsolete meter hook not installed');
  assert.strictEqual(cfg.hooks.SubagentStart.length, 1, 'no duplicate subagent hook');
  assert.strictEqual(cfg.hooks.PostCompact.length, 1, 'no duplicate compaction hook');
  const styleCount = (claudeMd().match(/<!-- trim:style:start -->/g) || []).length;
  assert.strictEqual(styleCount, 1, 'style block appended once');
}

// ---- uninstall: trim gone, user config intact ----
uninstall();
{
  const cfg = settings();
  assert.strictEqual(cfg.model, 'opus', 'user setting still present');
  const post = (cfg.hooks && cfg.hooks.PostToolUse) || [];
  assert.ok(post.some((h) => JSON.stringify(h).includes('my-own-hook.sh')), 'user hook survives uninstall');
  assert.ok(
    post.some((h) => JSON.stringify(h).includes('/opt/other/adapters/thing.js')),
    'foreign hook at an /adapters/ path survives uninstall'
  );
  assert.ok(!JSON.stringify(cfg).includes(path.join(WORK, 'adapters')), 'trim hooks removed');
  assert.ok(!claudeMd().includes('trim:style:start'), 'style block removed');
  assert.ok(claudeMd().includes('# my rules'), 'user CLAUDE.md text intact');
  assert.ok(!fs.existsSync(path.join(HOME, '.config', 'opencode', 'plugins', 'trim.ts')), 'opencode plugin removed');
  assert.ok(!fs.existsSync(path.join(HOME, '.pi', 'agent', 'extensions', 'trim.ts')), 'pi extension removed');
}

// ---- fresh HOME with .claude dir but NO settings.json (new machine) ----
{
  const home2 = path.join(sandbox, 'home2');
  fs.mkdirSync(path.join(home2, '.claude'), { recursive: true });
  execFileSync('bash', [path.join(WORK, 'install.sh')], { env: { ...process.env, HOME: home2 }, encoding: 'utf8' });
  const cfg = JSON.parse(fs.readFileSync(path.join(home2, '.claude', 'settings.json'), 'utf8'));
  assert.ok(JSON.stringify(cfg).includes('claude-posttooluse.js'), 'fresh install writes hooks');
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log('install.test.js: all assertions passed');
