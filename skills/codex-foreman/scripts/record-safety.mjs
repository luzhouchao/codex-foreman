import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const RUN_ID = /^\d{8}-\d{6}-[a-z0-9]{4}$/;
export const TERMINAL = new Set(['done', 'failed', 'cancelled', 'interrupted', 'quota_exhausted', 'stalled', 'timeout', 'needs_input']);
export const keyPath = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
export const within = (base, file) => keyPath(file) === keyPath(base) || keyPath(file).startsWith(`${keyPath(base)}${path.sep}`);
export function ordinary(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error(`拒绝非普通${directory ? '目录' : '文件'}: ${file}`);
  return stat;
}
// 检查绝对路径的每一级，不能用 realpath 隐去 junction 或符号链接。
export function safeAncestors(dir, { allowMissing = false } = {}) {
  const absolute = path.resolve(dir), root = path.parse(absolute).root;
  ordinary(root, true);
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { ordinary(current, true); }
    catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw error; }
  }
  return absolute;
}
export function safeTree(dir) {
  ordinary(dir, true);
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`拒绝链接: ${file}`);
    if (stat.isDirectory()) safeTree(file); else ordinary(file);
  }
}
export function readObject(file, limit = 1024 * 1024) {
  if (ordinary(file).size > limit) throw new Error('记录文件超过大小限制');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('记录必须为 JSON 对象');
  return value;
}
function processEvidence(pid) {
  if (process.platform !== 'win32') return { state: 'unknown' };
  // 只读取 OS 进程身份。受保护的系统进程可能拒绝 kill(0)/StartTime，但允许 CIM CreationDate。
  const script = `$ErrorActionPreference='Stop';try{$historyProcess=Get-Process -Id ${pid} -ErrorAction Stop;$historyCreated=$historyProcess.StartTime.ToUniversalTime().ToString('o');@{state='found';pid=[int]$historyProcess.Id;started_at=$historyCreated}|ConvertTo-Json -Compress;exit 0}catch{};try{$historyProcess=Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop;if($historyProcess){@{state='found';pid=[int]$historyProcess.ProcessId;started_at=$historyProcess.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}else{@{state='absent';pid=${pid}}|ConvertTo-Json -Compress}}catch{@{state='unknown';pid=${pid}}|ConvertTo-Json -Compress}`;
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 2500, maxBuffer: 8192 });
    if (result.error || result.status !== 0) return { state: 'unknown' };
    const current = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
    if (current.pid !== pid) return { state: 'unknown' };
    if (current.state === 'absent') return current;
    const started = Date.parse(current.started_at);
    return current.state === 'found' && Number.isFinite(started) ? { state: 'found', started } : { state: 'unknown' };
  } catch { return { state: 'unknown' }; }
}
export function inactive(pid, publishedBy = undefined) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) throw new Error('缺少有效 PID，无法确认任务安全');
  let denied = false;
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; denied = true; }
  const recorded = Date.parse(publishedBy);
  if (denied || Number.isFinite(recorded)) {
    const evidence = processEvidence(pid);
    if (evidence.state === 'absent' || evidence.state === 'found' && Number.isFinite(recorded) && evidence.started > recorded) return;
  }
  if (denied) throw new Error(`无法确认 PID ${pid} 已退出`);
  throw new Error(`PID ${pid} 仍在运行`);
}
export function safeRun(dir, meta) {
  safeAncestors(dir); safeTree(dir);
  if (!RUN_ID.test(meta.id) || meta.id !== path.basename(dir)) throw new Error('任务 ID 与记录目录不匹配');
  if (!TERMINAL.has(meta.status) || !Number.isFinite(Date.parse(meta.ended_at))) throw new Error('任务未明确结束，无法安全清理');
  inactive(meta.pid, meta.ended_at);
  const viewer = path.join(dir, 'viewer-ready.json');
  if (fs.existsSync(viewer)) {
    const ready = readObject(viewer), published = Date.parse(ready.started_at), started = Date.parse(meta.started_at);
    // ready 是该 viewer PID 发布后的证据；任务 ended_at 和 spawn 前的 lease.created 都不能替代它。
    const verified = ready.run === meta.id && (ready.group ?? null) === (meta.group ?? null)
      && Number.isFinite(published) && Number.isFinite(started) && published >= started;
    inactive(ready.pid, verified ? ready.started_at : undefined);
  }
  if (meta.viewer?.status === 'requested' && !fs.existsSync(viewer)) throw new Error('查看器已请求但未确认退出');
}
export function viewerLeaseName(meta) {
  const key = JSON.stringify([meta.host_session, meta.group ? ['group', meta.group] : ['run', meta.id]]);
  return `.viewer-${createHash('sha256').update(key).digest('hex').slice(0, 24)}.json`;
}
function inactiveViewer(lease, name) {
  if (lease.pending) throw new Error(`所选任务的查看器仍在启动（${name}）；请先关闭该查看窗口`);
  try { inactive(lease.pid); }
  catch (error) { throw new Error(`所选任务的查看器尚未退出（${name}）：${error.message}；请先关闭该查看窗口`); }
}
export function safeViewers(root, selected, registeredRoots = []) {
  if (!selected.length) return;
  const trusted = new Set([root, ...registeredRoots].map(keyPath));
  const relevant = new Set(selected.map(meta => viewerLeaseName(meta)));
  for (const meta of selected) {
    if (!meta.viewer?.lease) continue;
    const file = meta.viewer.lease, expected = viewerLeaseName(meta);
    if (typeof file !== 'string' || !path.isAbsolute(file) || file.split(/[\\/]/).some(part => part === '.' || part === '..') || path.basename(file) !== expected) throw new Error('所选任务的查看器登记路径不匹配');
    const source = path.dirname(file);
    if (!trusted.has(keyPath(source))) throw new Error('所选任务的查看器登记路径不匹配（来源目录尚未登记）');
    relevant.add(expected);
    if (keyPath(source) !== keyPath(root)) {
      // 迁移记录可以保留旧绝对路径。只读取已登记 root 中对应同一任务/组的 lease，绝不删除它。
      // 只允许确实缺失；链接、权限错误、损坏状态及活跃 PID 均继续阻止。
      if (!safeAncestors(source, { allowMissing: true })) continue;
      let lease;
      try { lease = readObject(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      inactiveViewer(lease, file);
    }
  }
  for (const name of fs.readdirSync(root).filter(name => /^\.viewer-.*\.json$/.test(name))) {
    // 自动查看器按 host_session + group/run 去重，只保护正在被删除的这一批。
    // 无法辨认归属的旧/损坏文件名继续保守阻止，不猜测它属于无关任务。
    if (/^\.viewer-[a-f0-9]{24}\.json$/.test(name) && !relevant.has(name)) continue;
    inactiveViewer(readObject(path.join(root, name)), name);
  }
}
