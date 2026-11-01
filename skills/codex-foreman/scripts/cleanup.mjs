// 仅清理主工作区内有明确结束证据的外部任务记录。
import fs from 'node:fs';
import path from 'node:path';
import { ordinary, readObject as json, safeRun, safeViewers, safeAncestors, within } from './record-safety.mjs';
import { knownRoots } from './history.mjs';

const runId = /^\d{8}-\d{6}-[a-z0-9]{4}$/;

export function cleanupRecords(opts, configuredRoot = null) {
  if (!opts.group && !opts.before) throw new Error('cleanup 需要 --group <组名> 或 --before YYYY-MM-DD');
  if (opts.group != null && !/^[A-Za-z0-9._-]{1,64}$/.test(opts.group)) throw new Error('无效讨论组名');
  let before = null;
  if (opts.before != null) {
    before = Date.parse(`${opts.before}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.before) || !Number.isFinite(before) || new Date(before).toISOString().slice(0, 10) !== opts.before) throw new Error('before 必须是有效 YYYY-MM-DD（UTC 零点之前）');
  }
  const workspace = safeAncestors(path.resolve(opts.workspace || process.env.CODEX_FOREMAN_WORKSPACE || process.cwd()));
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
    try { safeViewers(root, candidates.map(entry => json(path.join(entry.dir, 'meta.json'))), knownRoots().map(manifest => manifest.root)); }
    catch (error) { blocked.push({ id: null, reason: error.message }); }
    const chosen = new Set(candidates.map(entry => entry.id));
    for (const id of fs.readdirSync(root).filter(name => runId.test(name) && !chosen.has(name))) {
      try {
        safeAncestors(path.join(root, id));
        const meta = json(path.join(root, id, 'meta.json'));
        for (const entry of candidates) if ([meta.native_session_file, meta.native_session_dir].some(file => typeof file === 'string' && within(entry.dir, file))) blocked.push({ id: entry.id, reason: `原生会话仍被保留任务 ${id} 引用` });
      } catch (error) { blocked.push({ id, reason: `无法核对保留记录的共享原生会话：${error.message}` }); }
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
        safeViewers(root, [json(path.join(entry.dir, 'meta.json'))], knownRoots().map(manifest => manifest.root));
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
