import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildHooks, mergeHooks } from './hook-config.mjs';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MARKER = '.foreman-install.json';
const read = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
function inside(root, file) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`路径不在预期目录内：${file}`);
  return file;
}
function remove(root, file) { fs.rmSync(inside(root, file), { recursive: true, force: true }); }
function move(root, from, to) { inside(root, from); inside(root, to); fs.renameSync(from, to); }
function noLinks(root, file) {
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`路径越界：${file}`);
  let current = root;
  for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`安装路径包含符号链接或 junction：${current}`);
  }
}
function replace(file, contents) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, contents, { flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

// Exported checkpoints allow deterministic failure tests without production fault flags.
function performInstall({ home, update = false, hooks = false, hooksOnly = false, version = false, rollback, checkpoint = () => {} } = {}) {
  home = path.resolve(home);
  const target = path.join(home, 'skills', 'codex-foreman');
  const hookFile = path.join(home, 'hooks.json');
  const backups = path.join(home, 'foreman-install-backups');
  if (version) return { target, version: fs.existsSync(path.join(target, MARKER)) ? json(path.join(target, MARKER)).version : fs.existsSync(target) ? 'legacy (无版本标记)' : null };
  noLinks(home, target); noLinks(home, backups); noLinks(home, hookFile);
  if ([update, hooksOnly, Boolean(rollback)].filter(Boolean).length > 1) throw new Error('--update、--hooks-only 和 --rollback 不能组合');
  if (rollback) {
    if (!/^[0-9A-Za-z-]+$/.test(rollback)) throw new Error('备份 ID 无效');
    const backup = inside(backups, path.join(backups, rollback));
    noLinks(home, backup);
    const manifest = json(path.join(backup, 'manifest.json'));
    if (manifest.owner !== 'codex-foreman-installer' || manifest.target !== target || manifest.state !== 'complete') throw new Error('备份不属于当前安装或尚未完成');
    if (manifest.targetChanged && !manifest.hadTarget) throw new Error('初次安装没有旧版本可回退');
    if (manifest.targetChanged) {
      const saved = path.join(backup, 'skill');
      noLinks(home, saved);
      if (!fs.existsSync(saved) || !fs.statSync(saved).isDirectory() || !fs.existsSync(path.join(saved, 'SKILL.md'))) throw new Error('备份技能目录缺失或不完整');
    }
    if (manifest.hooksChanged && read(hookFile) !== manifest.hooksAfter) throw new Error('钩子在更新后已修改，拒绝覆盖；请先手动合并 hooks.json');
    const displaced = path.join(backup, `displaced-${randomUUID()}`);
    const restored = path.join(backup, `restore-${randomUUID()}`);
    if (manifest.targetChanged) {
      fs.cpSync(path.join(backup, 'skill'), restored, { recursive: true });
      // Roll back program files while retaining current local data, including new runs.
      if (fs.existsSync(target)) {
        const marker = path.join(target, MARKER);
        const managed = fs.existsSync(marker) ? json(marker).managed : ['hooks', 'references', 'schemas', 'scripts', 'LICENSE', 'SKILL.md'];
        for (const entry of fs.readdirSync(target)) {
          if (entry !== MARKER && !managed.includes(entry)) {
            remove(home, path.join(restored, entry));
            fs.cpSync(path.join(target, entry), path.join(restored, entry), { recursive: true });
          }
        }
      }
    }
    let moved = false, targetTouched = false;
    try {
      if (manifest.targetChanged) {
        if (fs.existsSync(target)) { move(home, target, displaced); moved = true; }
        targetTouched = true;
        move(home, restored, target);
      }
      if (manifest.hooksChanged) {
        if (manifest.hooksBefore === null) fs.rmSync(hookFile, { force: true });
        else replace(hookFile, manifest.hooksBefore);
      }
    } catch (error) {
      if (manifest.targetChanged && targetTouched) {
        remove(home, target);
        if (moved) move(home, displaced, target);
      }
      throw error;
    }
    manifest.state = 'rolled-back'; write(path.join(backup, 'manifest.json'), manifest);
    return { target, rolledBack: rollback };
  }
  const hadTarget = fs.existsSync(target);
  if (hadTarget && !update && !hooksOnly) throw new Error(`目标已存在，未覆盖：${target}；更新使用 --update，补装钩子使用 --hooks-only`);
  if ((update || hooksOnly) && !hadTarget) throw new Error('尚未安装，不能更新或补装钩子');
  if (hadTarget && (fs.lstatSync(target).isSymbolicLink() || !fs.statSync(target).isDirectory() || !fs.existsSync(path.join(target, 'SKILL.md')))) throw new Error('目标不是普通技能安装目录');
  const source = path.join(ROOT, 'skills', 'codex-foreman');
  const pkg = json(path.join(ROOT, 'package.json'));
  const hooksBefore = read(hookFile);
  const hooksAfter = hooks || hooksOnly ? JSON.stringify(mergeHooks(hooksBefore === null ? {} : JSON.parse(hooksBefore), buildHooks(target)), null, 2) + '\n' : hooksBefore;
  const id = `${Date.now()}-${randomUUID()}`;
  const backup = path.join(backups, id);
  fs.mkdirSync(backup, { recursive: true });
  const stage = path.join(backup, 'stage');
  const manifest = { owner: 'codex-foreman-installer', target, version: pkg.version, hadTarget, targetChanged: !hooksOnly, hooksChanged: hooksAfter !== hooksBefore, hooksBefore, hooksAfter, state: 'prepared' };
  let moved = false, installed = false, hookWritten = false;
  try {
    if (!hooksOnly) {
      fs.cpSync(source, stage, { recursive: true });
      fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(stage, 'LICENSE'));
      const managed = fs.readdirSync(stage);
      if (hadTarget) {
        const oldMarker = path.join(target, MARKER);
        const oldManaged = fs.existsSync(oldMarker) ? json(oldMarker).managed : ['hooks', 'references', 'schemas', 'scripts', 'LICENSE', 'SKILL.md'];
        for (const entry of fs.readdirSync(target)) {
          if (entry !== MARKER && !managed.includes(entry) && !oldManaged.includes(entry)) fs.cpSync(path.join(target, entry), path.join(stage, entry), { recursive: true });
        }
      }
      write(path.join(stage, MARKER), { version: pkg.version, installedAt: new Date().toISOString(), managed });
    }
    write(path.join(backup, 'manifest.json'), manifest);
    checkpoint('staged');
    if (!hooksOnly) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (hadTarget) { move(home, target, path.join(backup, 'skill')); moved = true; }
      checkpoint('backed-up');
      move(home, stage, target); installed = true;
    }
    checkpoint('replaced');
    if (manifest.hooksChanged) {
      if (hooksBefore !== null) fs.writeFileSync(`${hookFile}.${Date.now()}.bak`, hooksBefore, { flag: 'wx' });
      replace(hookFile, hooksAfter); hookWritten = true;
    }
    checkpoint('hooks-written');
    manifest.state = 'complete'; write(path.join(backup, 'manifest.json'), manifest);
  } catch (error) {
    // Keep the backup and report any recovery failure rather than hiding it.
    try {
      if (hookWritten) { if (hooksBefore === null) fs.rmSync(hookFile, { force: true }); else replace(hookFile, hooksBefore); }
      if (installed) remove(home, target);
      if (moved) move(home, path.join(backup, 'skill'), target);
      manifest.state = 'failed-restored'; write(path.join(backup, 'manifest.json'), manifest);
    } catch (recovery) { throw new AggregateError([error, recovery], `更新失败且自动恢复未完成，备份：${backup}`); }
    throw error;
  }
  return { target, version: pkg.version, backup: id, hooks: hooks || hooksOnly };
}

export function install(options = {}) {
  const home = path.resolve(options.home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  if (options.version) return performInstall({ ...options, home });
  fs.mkdirSync(home, { recursive: true });
  const lock = path.join(home, '.foreman-install.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`安装器已运行或上次被中断，请检查后移除锁：${lock}`); throw error; }
  try { return performInstall({ ...options, home }); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const known = new Set(['--update', '--hooks', '--hooks-only', '--version', '--rollback']);
    for (let i = 0; i < args.length; i++) { if (!known.has(args[i])) throw new Error(`未知参数：${args[i]}`); if (args[i] === '--rollback') { if (!args[++i]) throw new Error('--rollback 需要备份 ID'); } }
    const result = install({ update: args.includes('--update'), hooks: args.includes('--hooks'), hooksOnly: args.includes('--hooks-only'), version: args.includes('--version'), rollback: args.includes('--rollback') ? args[args.indexOf('--rollback') + 1] : undefined });
    console.log(JSON.stringify(result, null, 2));
    if (result.hooks) console.log('请在 Codex /hooks 中审阅并信任定义；安装器不会写入信任记录。');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
