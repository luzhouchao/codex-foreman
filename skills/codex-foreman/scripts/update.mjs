import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const OFFICIAL_REPOSITORY = 'https://github.com/luzhouchao/codex-foreman.git';

// Never use a workspace remote or the informational source_root in the install marker.
export function updateForeman({ home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), check = false, run = spawnSync } = {}) {
  home = path.resolve(home);
  const target = path.join(home, 'skills', 'codex-foreman');
  if (!fs.existsSync(path.join(target, 'SKILL.md'))) throw new Error('尚未安装 Foreman，不能更新');
  let current = home;
  for (const segment of ['', 'skills', 'codex-foreman']) {
    if (segment) current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`更新路径包含符号链接或 junction：${current}`);
  }
  const markerFile = path.join(target, '.foreman-install.json');
  const installed = fs.existsSync(markerFile) ? JSON.parse(fs.readFileSync(markerFile, 'utf8')) : {};
  const lock = path.join(home, '.foreman-update.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`更新器已运行或上次被中断，请检查后移除锁：${lock}`); throw error; }
  let temp, tempParent;
  try {
    tempParent = fs.realpathSync(os.tmpdir());
    temp = fs.mkdtempSync(path.join(tempParent, 'foreman-update-'));
    const source = path.join(temp, 'source'), empty = path.join(temp, 'empty');
    fs.mkdirSync(empty);
    const gitConfig = path.join(temp, 'gitconfig');
    fs.writeFileSync(gitConfig, '');
    // Isolate Git from caller repositories, URL rewrites, hooks and external filters.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfig, GIT_CEILING_DIRECTORIES: tempParent, GIT_TERMINAL_PROMPT: '0', CODEX_HOME: home });
    const execute = (command, args) => {
      const result = run(command, args, { cwd: temp, env, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
      if (result.error || result.status !== 0) throw new Error(`${command === 'git' ? '获取官方更新失败' : '安装更新失败'}：${result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `退出码 ${result.status}`}`);
      return result.stdout?.trim() || '';
    };
    const git = ['-c', `core.hooksPath=${empty}`, '-c', 'core.autocrlf=false'];
    execute('git', [...git, 'clone', '--depth=1', '--single-branch', '--branch=main', `--template=${empty}`, '--', OFFICIAL_REPOSITORY, source]);
    const revision = execute('git', [...git, '-C', source, 'rev-parse', 'HEAD']);
    if (!/^[a-f0-9]{40}$/.test(revision) || execute('git', [...git, '-C', source, 'status', '--porcelain'])) throw new Error('官方更新材料不是干净的 Git checkout');
    const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    const installer = path.join(source, 'tools', 'install.mjs');
    if (pkg.name !== 'codex-foreman' || typeof pkg.version !== 'string' || !fs.statSync(installer).isFile()) throw new Error('官方更新材料缺少有效的安装器或版本');
    const available = installed.revision !== revision;
    const result = { status: available ? 'update_available' : 'up_to_date', repository: OFFICIAL_REPOSITORY,
      current_version: installed.version || null, current_revision: installed.revision || null,
      latest_version: pkg.version, latest_revision: revision, source_root: installed.source_root || null };
    if (check || !available) return result;
    const output = execute(process.execPath, [installer, '--update']);
    return { ...result, status: 'updated', installation: JSON.parse(output) };
  } finally {
    try {
      if (temp) {
        if (path.dirname(temp) !== tempParent || !path.basename(temp).startsWith('foreman-update-') || fs.lstatSync(temp).isSymbolicLink()) throw new Error(`拒绝清理边界外的临时目录：${temp}`);
        fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
}
