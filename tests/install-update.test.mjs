import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { install } from '../tools/install.mjs';
import { buildHooks, mergeHooks } from '../tools/hook-config.mjs';
import { OFFICIAL_REPOSITORY, updateForeman } from '../skills/codex-foreman/scripts/update.mjs';
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-install-'));
  t.after(() => { const relative = path.relative(os.tmpdir(), home); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, target: path.join(home, 'skills/codex-foreman'), hookFile: path.join(home, 'hooks.json') };
}
const read = (file) => fs.readFileSync(file, 'utf8');
const snapshot = (root) => Object.fromEntries(fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? Object.entries(snapshot(path.join(root, entry.name))).map(([key, value]) => [`${entry.name}/${key}`, value]) : [[entry.name, read(path.join(root, entry.name))]]));

test('默认拒绝覆盖，显式更新保留配置/aliases/runs并记录版本', (t) => {
  const h = fixture(t); install(h);
  for (const name of ['config.json', 'agent-aliases.json']) fs.writeFileSync(path.join(h.target, name), `user-${name}`);
  fs.mkdirSync(path.join(h.target, 'runs')); fs.writeFileSync(path.join(h.target, 'runs/result.json'), 'keep');
  const before = snapshot(h.target);
  assert.throws(() => install(h), /目标已存在/);
  assert.deepEqual(snapshot(h.target), before);
  const update = install({ ...h, update: true });
  assert.equal(install({ ...h, version: true }).version, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.equal(read(path.join(h.target, 'config.json')), 'user-config.json');
  assert.equal(read(path.join(h.target, 'agent-aliases.json')), 'user-agent-aliases.json');
  assert.equal(read(path.join(h.target, 'runs/result.json')), 'keep');
  assert.ok(fs.existsSync(path.join(h.home, 'foreman-install-backups', update.backup, 'skill/SKILL.md')));
});

test('已安装补钩子，连续升级幂等并保留用户组与信任数据', (t) => {
  const h = fixture(t); install(h);
  const old = buildHooks(h.target, '/old/node', 'linux');
  old.hooks.SessionStart[0].hooks.push({ type: 'command', command: 'user-shared' });
  old.hooks.SessionStart.push({ matcher: 'user', hooks: [{ type: 'command', command: 'user-only' }] });
  old.trust = { untouched: true };
  fs.writeFileSync(h.hookFile, JSON.stringify(old));
  const skillBefore = snapshot(h.target);
  install({ ...h, hooksOnly: true });
  assert.deepEqual(snapshot(h.target), skillBefore);
  const once = read(h.hookFile);
  install({ ...h, update: true, hooks: true });
  install({ ...h, update: true, hooks: true });
  assert.equal(read(h.hookFile), once);
  const parsed = JSON.parse(once);
  assert.deepEqual(parsed.trust, { untouched: true });
  assert.equal(parsed.hooks.SessionStart.length, 3);
  assert.ok(once.includes('user-shared')); assert.ok(once.includes('user-only'));
});

for (const phase of ['staged', 'backed-up', 'replaced', 'hooks-written']) test(`失败恢复完整安装与hooks：${phase}`, (t) => {
  const h = fixture(t); install(h);
  fs.writeFileSync(h.hookFile, '{"hooks":{"Stop":[]}}\n');
  fs.writeFileSync(path.join(h.target, 'scripts', 'old-extra.txt'), 'old');
  const before = snapshot(h.target), hooks = read(h.hookFile);
  assert.throws(() => install({ ...h, update: true, hooks: true, checkpoint(name) { if (name === phase) throw new Error('injected'); } }), /injected/);
  assert.deepEqual(snapshot(h.target), before); assert.equal(read(h.hookFile), hooks);
});

test('新安装失败恢复为不存在，hooks-only失败恢复已有安装', (t) => {
  const h = fixture(t);
  assert.throws(() => install({ ...h, hooks: true, checkpoint(name) { if (name === 'hooks-written') throw new Error('injected'); } }), /injected/);
  assert.equal(fs.existsSync(h.target), false); assert.equal(fs.existsSync(h.hookFile), false);
  install(h); const before = snapshot(h.target);
  assert.throws(() => install({ ...h, hooksOnly: true, checkpoint(name) { if (name === 'hooks-written') throw new Error('injected'); } }), /injected/);
  assert.deepEqual(snapshot(h.target), before); assert.equal(fs.existsSync(h.hookFile), false);
});

test('显式回退恢复自己备份，并拒绝跨目录ID与后续钩子修改', (t) => {
  const h = fixture(t); install(h);
  fs.writeFileSync(path.join(h.target, 'scripts', 'legacy-extra.txt'), 'restore');
  fs.writeFileSync(h.hookFile, '{"hooks":{"Stop":[]}}\n');
  const before = snapshot(h.target), hooks = read(h.hookFile);
  const updated = install({ ...h, update: true, hooks: true });
  assert.throws(() => install({ ...h, rollback: '../outside' }), /ID/);
  const afterHooks = read(h.hookFile); fs.writeFileSync(h.hookFile, afterHooks + ' ');
  assert.throws(() => install({ ...h, rollback: updated.backup }), /已修改/);
  fs.writeFileSync(h.hookFile, afterHooks);
  install({ ...h, rollback: updated.backup });
  assert.deepEqual(snapshot(h.target), before); assert.equal(read(h.hookFile), hooks);
  assert.throws(() => install({ ...h, rollback: updated.backup }), /尚未完成/);
});

test('无效钩子预检不修改安装；编码的Windows旧hook可替换', (t) => {
  const h = fixture(t); install(h); const before = snapshot(h.target);
  fs.writeFileSync(h.hookFile, '{broken');
  assert.throws(() => install({ ...h, update: true, hooks: true }));
  assert.deepEqual(snapshot(h.target), before);
  const old = buildHooks('C:/skills/codex-foreman', 'C:/old/node.exe', 'win32');
  const added = buildHooks('C:/skills/codex-foreman', 'C:/new/node.exe', 'win32');
  assert.deepEqual(mergeHooks(old, added).hooks, added.hooks);
});

test('回退保留更新后新增的用户配置与运行记录；并发安装拒绝竞争', (t) => {
  const h = fixture(t); install(h);
  const updated = install({ ...h, update: true });
  fs.writeFileSync(path.join(h.target, 'config.json'), 'new-config');
  fs.mkdirSync(path.join(h.target, 'runs')); fs.writeFileSync(path.join(h.target, 'runs/new.json'), 'new-run');
  install({ ...h, rollback: updated.backup });
  assert.equal(read(path.join(h.target, 'config.json')), 'new-config');
  assert.equal(read(path.join(h.target, 'runs/new.json')), 'new-run');
  fs.writeFileSync(path.join(h.home, '.foreman-install.lock'), 'busy');
  assert.throws(() => install({ ...h, update: true }), /安装器已运行/);
  assert.equal(read(path.join(h.home, '.foreman-install.lock')), 'busy');
});

test('回退预检拒绝缺失备份与父目录junction，不移动现安装', (t) => {
  const h = fixture(t); install(h);
  const update = install({ ...h, update: true }); const before = snapshot(h.target);
  const saved = path.join(h.home, 'foreman-install-backups', update.backup, 'skill');
  fs.renameSync(saved, `${saved}-missing`);
  assert.throws(() => install({ ...h, rollback: update.backup }), /备份技能目录缺失/);
  assert.deepEqual(snapshot(h.target), before);
  const other = fixture(t);
  fs.symlinkSync(path.dirname(h.target), path.join(other.home, 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => install({ ...other, update: true }), /junction/);
  assert.deepEqual(snapshot(h.target), before);
});

test('独立官方checkout更新保留用户数据与hooks；旧marker检查只读，同revision不重装', (t) => {
  const h = fixture(t); install(h);
  const source = path.join(h.home, 'official-fixture');
  fs.mkdirSync(path.join(source, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(source, 'skills', 'codex-foreman', 'scripts'), { recursive: true });
  for (const name of ['install.mjs', 'hook-config.mjs']) fs.copyFileSync(new URL(`../tools/${name}`, import.meta.url), path.join(source, 'tools', name));
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'codex-foreman', version: '0.6.6', type: 'module' }));
  fs.writeFileSync(path.join(source, 'LICENSE'), 'fixture license\n');
  fs.writeFileSync(path.join(source, 'skills', 'codex-foreman', 'SKILL.md'), 'fixture skill\n');
  fs.writeFileSync(path.join(source, 'skills', 'codex-foreman', 'scripts', 'new.mjs'), 'export const updated = true;\n');
  const git = args => execFileSync('git', ['-c', 'core.autocrlf=false', '-C', source, ...args], { encoding: 'utf8', windowsHide: true });
  git(['init']); git(['add', '.']); git(['-c', 'user.name=Foreman Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  const revision = git(['rev-parse', 'HEAD']).trim();
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'codex-foreman', version: '9.9.9', type: 'module' }));
  // A dirty/moved source and a recorded non-official URL are never executable inputs.
  const marker = path.join(h.target, '.foreman-install.json');
  fs.writeFileSync(marker, JSON.stringify({ ...JSON.parse(read(marker)), revision: null, source_root: source, repository: 'https://untrusted.invalid/evil.git' }));
  for (const name of ['config.json', 'memory.txt', 'runs.json']) fs.writeFileSync(path.join(h.target, name), `keep-${name}`);
  fs.writeFileSync(h.hookFile, '{user hooks remain byte-for-byte}\n');
  fs.mkdirSync(path.join(h.home, 'foreman')); fs.writeFileSync(path.join(h.home, 'foreman', 'config.json'), '{not valid JSON: must not be loaded}');
  const before = snapshot(h.target), hooks = read(h.hookFile), calls = [], temps = [];
  const run = (command, args, options) => {
    calls.push({ command, args }); temps.push(options.cwd);
    assert.notEqual(options.cwd, source); assert.equal(options.env.CODEX_HOME, h.home);
    assert.equal(options.env.GIT_CONFIG_NOSYSTEM, '1'); assert.equal(read(options.env.GIT_CONFIG_GLOBAL), '');
    if (command === 'git' && args.includes('clone')) {
      assert.equal(args.at(-2), OFFICIAL_REPOSITORY); assert.ok(args.includes('--branch=main'));
      // Substitute only the network transport in this test; checkout and installer are real.
      return spawnSync(command, args.map(arg => arg === OFFICIAL_REPOSITORY ? source : arg).filter(arg => arg !== '--branch=main'), options);
    }
    if (command === process.execPath) assert.deepEqual(args.slice(1), ['--update']);
    return spawnSync(command, args, options);
  };
  const checked = updateForeman({ home: h.home, check: true, run });
  assert.equal(checked.status, 'update_available'); assert.equal(checked.current_revision, null); assert.equal(checked.latest_revision, revision);
  assert.equal(checked.latest_version, '0.6.6');
  assert.deepEqual(snapshot(h.target), before); assert.equal(read(h.hookFile), hooks);
  assert.ok(!calls.some(call => call.command === process.execPath));
  fs.writeFileSync(marker, JSON.stringify({ ...JSON.parse(read(marker)), source_root: path.join(h.home, 'moved-source') }));
  const updated = updateForeman({ home: h.home, run });
  assert.equal(updated.status, 'updated'); assert.ok(updated.installation.backup);
  assert.equal(JSON.parse(read(marker)).revision, revision);
  for (const name of ['config.json', 'memory.txt', 'runs.json']) assert.equal(read(path.join(h.target, name)), `keep-${name}`);
  assert.equal(read(h.hookFile), hooks); assert.equal(JSON.parse(read(path.join(source, 'package.json'))).version, '9.9.9');
  assert.match(git(['status', '--porcelain']), /M package.json/); assert.equal(JSON.parse(read(marker)).version, '0.6.6');
  const backups = fs.readdirSync(path.join(h.home, 'foreman-install-backups'));
  assert.equal(updateForeman({ home: h.home, run }).status, 'up_to_date');
  assert.deepEqual(fs.readdirSync(path.join(h.home, 'foreman-install-backups')), backups);
  assert.ok(temps.every(temp => !fs.existsSync(temp)));
  assert.equal(fs.existsSync(path.join(h.home, '.foreman-update.lock')), false);
});

test('网络失败不动安装并清理临时目录；独立更新锁拒绝并发', (t) => {
  const h = fixture(t); install(h); const before = snapshot(h.target); let temp;
  assert.throws(() => updateForeman({ home: h.home, run(command, args, options) { temp = options.cwd; return { status: 1, stderr: 'network unavailable' }; } }), /获取官方更新失败.*network unavailable/);
  assert.deepEqual(snapshot(h.target), before); assert.equal(fs.existsSync(temp), false);
  const lock = path.join(h.home, '.foreman-update.lock'); assert.equal(fs.existsSync(lock), false);
  fs.writeFileSync(lock, 'busy');
  assert.throws(() => updateForeman({ home: h.home, run() { assert.fail('must not fetch while locked'); } }), /更新器已运行/);
  assert.equal(read(lock), 'busy'); assert.deepEqual(snapshot(h.target), before);
});

test('任意目录调用update严格拒绝参数，并在检查时跳过配置、记录初始化与工作台', (t) => {
  const h = fixture(t), cwd = path.join(h.home, 'unrelated'); fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(h.home, 'foreman')); fs.writeFileSync(path.join(h.home, 'foreman', 'config.json'), '{broken');
  const before = snapshot(h.home), cli = fileURLToPath(new URL('../skills/codex-foreman/scripts/cli.mjs', import.meta.url));
  for (const args of [['--hooks'], ['--check', '--check'], ['--cwd', cwd], ['extra'], ['--check=value'], ['--check']]) {
    const result = spawnSync(process.execPath, [cli, 'update', ...args], { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEX_HOME: h.home } });
    const checking = args.length === 1 && args[0] === '--check';
    assert.equal(result.status, checking ? 1 : 2); assert.match(result.stderr, checking ? /尚未安装 Foreman/ : /用法：update/);
    assert.deepEqual(snapshot(h.home), before);
  }
});
