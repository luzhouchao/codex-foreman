import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHooks, mergeHooks } from './hook-config.mjs';
const source = fileURLToPath(new URL('../skills/codex-foreman', import.meta.url));
const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const target = path.join(home, 'skills', 'codex-foreman');
const hookFile = path.join(home, 'hooks.json');
const installHooks = process.argv.includes('--hooks');
const hooks = installHooks ? mergeHooks(fs.existsSync(hookFile) ? JSON.parse(fs.readFileSync(hookFile, 'utf8')) : {}, buildHooks(target)) : null;
if (fs.existsSync(target)) throw new Error(`目标已存在，未覆盖：${target}`);
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
fs.copyFileSync(fileURLToPath(new URL('../LICENSE', import.meta.url)), path.join(target, 'LICENSE'));
if (hooks) {
  if (fs.existsSync(hookFile)) fs.copyFileSync(hookFile, `${hookFile}.${Date.now()}.bak`, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(hookFile, JSON.stringify(hooks, null, 2) + '\n');
  console.log(`已合并钩子：${hookFile}\n请在 Codex /hooks 中审阅并信任这两项定义；安装器不会写入信任记录。`);
}
console.log(`已安装：${target}\n重新打开 Codex 会话后使用 $codex-foreman。`);
