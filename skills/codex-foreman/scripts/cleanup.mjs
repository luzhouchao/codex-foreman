// 仅清理主工作区内有明确结束证据的外部任务记录。
import fs from 'node:fs';
import path from 'node:path';

const terminal = new Set(['done', 'failed', 'cancelled', 'interrupted', 'quota_exhausted', 'stalled', 'timeout', 'needs_input']);
const runId = /^\d{8}-\d{6}-[a-z0-9]{4}$/;
function ordinary(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error(`拒绝非普通${directory ? '目录' : '文件'}: ${file}`);
  return stat;
}
function tree(dir) {
  ordinary(dir, true);
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`拒绝链接: ${file}`);
    if (stat.isDirectory()) tree(file);
    else ordinary(file);
  }
}
function json(file) { ordinary(file); return JSON.parse(fs.readFileSync(file, 'utf8')); }
function inactive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('缺少有效 PID，无法确认任务安全');
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw new Error(`无法确认 PID ${pid} 已退出`); }
  throw new Error(`PID ${pid} 仍在运行`);
}
function safeRun(dir, meta) {
  tree(dir);
  if (meta.id !== path.basename(dir)) throw new Error('任务 ID 与记录目录不匹配');
  if (!terminal.has(meta.status) || !Number.isFinite(Date.parse(meta.ended_at))) throw new Error('任务未明确结束，无法安全清理');
  inactive(meta.pid);
  const viewer = path.join(dir, 'viewer-ready.json');
  if (fs.existsSync(viewer)) inactive(json(viewer).pid);
  if (meta.viewer?.status === 'requested' && !fs.existsSync(viewer)) throw new Error('查看器已请求但未确认退出');
}

export function cleanupRecords(opts, configuredRoot = null) {
  if (!opts.group && !opts.before) throw new Error('cleanup 需要 --group <组名> 或 --before YYYY-MM-DD');
  if (opts.group != null && !/^[A-Za-z0-9._-]{1,64}$/.test(opts.group)) throw new Error('无效讨论组名');
  let before = null;
  if (opts.before != null) {
    before = Date.parse(`${opts.before}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.before) || !Number.isFinite(before) || new Date(before).toISOString().slice(0, 10) !== opts.before) throw new Error('before 必须是有效 YYYY-MM-DD（UTC 零点之前）');
  }
  const workspace = fs.realpathSync(path.resolve(opts.workspace || process.env.CODEX_FOREMAN_WORKSPACE || process.cwd()));
  const root = path.join(workspace, '.codex', 'foreman', 'runs');
  const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
  if (configuredRoot && pathKey(path.resolve(configuredRoot)) !== pathKey(root)) throw new Error('仅允许清理主工作区 .codex/foreman/runs；当前 runs_dir 不匹配');
  let current = workspace;
  for (const part of ['.codex', 'foreman', 'runs']) {
    current = path.join(current, part);
    try { ordinary(current, true); } catch (error) { if (error.code === 'ENOENT') return { apply: !!opts.apply, root, candidates: [], blocked: [], deleted: [] }; throw error; }
  }
  const lock = path.join(root, '.start.lock');
  let locked = false;
  const inspect = () => {
    const candidates = [], blocked = [];
    for (const id of fs.readdirSync(root).filter(name => runId.test(name)).sort()) {
      const dir = path.join(root, id);
      let meta;
      try { ordinary(dir, true); meta = json(path.join(dir, 'meta.json')); }
      catch (error) { blocked.push({ id, reason: error.message }); continue; }
      if (opts.group && meta.group !== opts.group) continue;
      if (before !== null) {
        if (!Number.isFinite(Date.parse(meta.started_at))) { blocked.push({ id, reason: '开始日期不明' }); continue; }
        if (Date.parse(meta.started_at) >= before) continue;
      }
      candidates.push({ id, dir, group: meta.group ?? null, host_session: meta.host_session ?? null, parent: meta.parent ?? null, started_at: meta.started_at, status: meta.status });
      try { safeRun(dir, meta); } catch (error) { blocked.push({ id, reason: error.message }); }
    }
    for (const name of fs.readdirSync(root).filter(name => /^\.viewer-.*\.json$/.test(name))) {
      try { const lease = json(path.join(root, name)); if (lease.pending) throw new Error('查看器仍在启动'); inactive(lease.pid); }
      catch (error) { blocked.push({ id: name, reason: error.message }); }
    }
    return { apply: !!opts.apply, root, before_utc: before === null ? null : new Date(before).toISOString(), candidates, blocked, deleted: [], warnings: ['讨论组筛选跨 Codex 会话，请核对 host_session。删除父记录会使保留的续接记录失去父链；不自动级联删除。'] };
  };
  try {
    // 与任务登记共用锁；不清除残留锁，无法确定安全时交回用户检查。
    if (opts.apply) { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); locked = true; }
    else if (fs.existsSync(lock)) throw new Error('任务登记锁存在，无法确认清理安全');
    const result = inspect();
    if (opts.apply && !result.blocked.length) {
      // 整批确认后才删除，任何不明状态都阻止整批操作。
      for (const entry of result.candidates) {
        let ancestor = workspace;
        for (const part of ['.codex', 'foreman', 'runs']) { ancestor = path.join(ancestor, part); ordinary(ancestor, true); }
        safeRun(entry.dir, json(path.join(entry.dir, 'meta.json')));
        fs.rmSync(entry.dir, { recursive: true });
        result.deleted.push(entry.id);
      }
    }
    return result;
  } finally { if (locked) fs.unlinkSync(lock); }
}

export function cmdCleanup(opts, root) {
  if (opts.help) {
    process.stdout.write('cleanup --workspace <主工作区> (--group <讨论组> | --before YYYY-MM-DD) [--apply]\n默认输出 JSON 预览；--apply 才执行删除。before 为 UTC 当日零点之前；同时指定两个筛选条件时取交集。\n仅清理 .codex/foreman/runs 内明确结束且进程已退出的记录。讨论组跨会话；核对 host_session。任何不明任务、链接、登记锁或活跃查看器都会阻止清理。\n');
    return;
  }
  const result = cleanupRecords(opts, root);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.blocked.length) process.exitCode = 1;
}
