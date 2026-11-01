// 只索引 Foreman 已登记的目录；不搜索磁盘或原应用的聊天数据库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { replaceFile } from './util.mjs';
import { RUN_ID, keyPath, within, safeAncestors, ordinary, readObject, safeRun, safeViewers, inactive } from './record-safety.mjs';

const SOURCE = 'codex-foreman';
const TYPES = new Set(['pi cli', 'codex cli', 'opencode cli', 'antigravity cli', 'antigravity desktop', 'api']);
const digest = value => createHash('sha256').update(value).digest('hex');
export const historyHome = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'foreman', 'history');
const rootId = root => digest(keyPath(root));
const recordId = (root, id) => digest(`${keyPath(root)}\0${id}`);
function writeAtomic(file, value) {
  // 创建之前先核验每一级，避免 recursive mkdir 在已有 junction 下产生副作用。
  const parent = path.resolve(path.dirname(file)), base = path.parse(parent).root;
  ordinary(base, true); let current = base;
  for (const part of parent.slice(base.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { ordinary(current, true); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { fs.mkdirSync(current); } catch (createError) { if (createError.code !== 'EEXIST') throw createError; }
      ordinary(current, true);
    }
  }
  if (fs.existsSync(file)) ordinary(file);
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); replaceFile(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
function registeredRoot(root, workspace) {
  root = safeAncestors(root); workspace = safeAncestors(workspace);
  const manifest = { schema_version: 1, source: SOURCE, root_id: rootId(root), root, workspace };
  writeAtomic(path.join(historyHome(), 'roots', `${manifest.root_id}.json`), manifest);
  return manifest;
}
function validMeta(meta, id, legacy = false) {
  if (meta.id !== id || !RUN_ID.test(id)) throw new Error('记录 ID 不匹配');
  if (meta.source !== SOURCE && !(legacy && TYPES.has(meta.agent_type) && ['run', 'resume', 'discuss', 'review'].includes(meta.mode))) throw new Error('无法确认记录来自 Foreman');
  if (!Number.isFinite(Date.parse(meta.started_at)) || typeof meta.status !== 'string') throw new Error('缺少有效 Foreman 元数据');
}
function put(manifest, meta, origin) {
  const id = recordId(manifest.root, meta.id), file = path.join(historyHome(), 'entries', `${id}.json`);
  // 删除墓碑不因陈旧刷新或写入复活。
  try { if (readObject(file).deleted_at) return; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  writeAtomic(file, { schema_version: 1, source: SOURCE, id, root_id: manifest.root_id, run_id: meta.id, origin,
    workspace: meta.workspace_root || (keyPath(manifest.root) === keyPath(path.join(path.dirname(historyHome()), 'runs')) && path.isAbsolute(meta.cwd || '') ? meta.cwd : manifest.workspace),
    registered_at: new Date().toISOString() });
}
export function registerHistoryRun({ root, workspace, meta }) {
  validMeta(meta, meta.id); safeAncestors(path.join(root, meta.id));
  put(registeredRoot(root, workspace), meta, 'invocation');
}
export function knownRoots() {
  const dir = path.join(historyHome(), 'roots');
  if (!fs.existsSync(dir)) return [];
  safeAncestors(dir);
  return fs.readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
    try {
      const m = readObject(path.join(dir, name));
      if (m.source !== SOURCE || !path.isAbsolute(m.root) || !path.isAbsolute(m.workspace) || m.root_id !== rootId(m.root) || name !== `${m.root_id}.json`) return [];
      return [m];
    } catch { return []; }
  });
}
// CLI 显式授权导入工作区；网页只能刷新这些 root_id，不接受文件路径。
export function importWorkspace(workspace, configuredRoot = null) {
  workspace = safeAncestors(path.resolve(workspace));
  const root = path.resolve(configuredRoot || path.join(workspace, '.codex', 'foreman', 'runs'));
  return importRoot(root, workspace);
}
export function importLegacyGlobal() {
  const root = path.join(path.dirname(historyHome()), 'runs');
  return importRoot(root, path.dirname(historyHome()));
}
function importRoot(root, workspace) {
  if (!fs.existsSync(root)) return { root, imported: 0, skipped: [], missing: true };
  const manifest = registeredRoot(root, workspace), skipped = [];
  let imported = 0;
  for (const id of fs.readdirSync(root).filter(name => RUN_ID.test(name))) {
    try {
      safeAncestors(path.join(root, id));
      const meta = readObject(path.join(root, id, 'meta.json')); validMeta(meta, id, true);
      put(manifest, meta, meta.source === SOURCE ? 'invocation' : 'legacy-import'); imported++;
    } catch (e) { skipped.push({ run_id: id, reason: e.message }); }
  }
  return { root_id: manifest.root_id, root, imported, skipped };
}
export function refreshHistory(rootIds = null) {
  if (rootIds !== null && (!Array.isArray(rootIds) || rootIds.some(id => !/^[a-f0-9]{64}$/.test(id)))) throw new Error('无效目录标识');
  return knownRoots().filter(m => rootIds === null || rootIds.includes(m.root_id)).map(m => {
    try { return importRoot(m.root, m.workspace); } catch (e) { return { root_id: m.root_id, error: e.message }; }
  });
}
function indexed() {
  const dir = path.join(historyHome(), 'entries'); if (!fs.existsSync(dir)) return [];
  safeAncestors(dir);
  const roots = new Map(knownRoots().map(m => [m.root_id, m]));
  return fs.readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
    try {
      const e = readObject(path.join(dir, name)), m = roots.get(e.root_id);
      if (e.source !== SOURCE || e.deleted_at || !m || !RUN_ID.test(e.run_id) || e.id !== recordId(m.root, e.run_id) || name !== `${e.id}.json` || !['invocation', 'legacy-import'].includes(e.origin)) return [];
      return [{ ...e, manifest: m, dir: path.join(m.root, e.run_id) }];
    } catch { return []; }
  });
}
function live(entry) {
  safeAncestors(entry.dir);
  const meta = readObject(path.join(entry.dir, 'meta.json'));
  validMeta(meta, entry.run_id, entry.origin === 'legacy-import');
  if (meta.runs_root && keyPath(meta.runs_root) !== keyPath(entry.manifest.root)) throw new Error('记录来源目录已变化');
  return meta;
}
const publicText = value => String(value ?? '').slice(0, 12000)
  .replace(/<(think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi, '[思考内容已隐藏]')
  .replace(/\b(Bearer\s+)[\w.+\/-]+/gi, '$1[已隐藏]')
  .replace(/((?:api[_-]?key|authorization|password|secret|csrf|access[_-]?token)\s*["']?\s*[:=]\s*["']?)[^\s,"'\]}]+/gi, '$1[已隐藏]').slice(0, 12000);
function nativePolicy(entry, meta) {
  if (meta.agent_type === 'pi cli' && meta.native_session_file && within(entry.dir, meta.native_session_file)) return 'local-native-included';
  if (meta.session_id || meta.native_session_file) return 'external-native-retained';
  return 'no-native-session';
}
function summary(e) {
  const workspace = e.workspace || e.manifest.workspace;
  const base = { id: e.id, run_id: e.run_id, root_id: e.root_id, workspace, storage_root: e.manifest.root,
    storage_scope: within(workspace, e.manifest.root) ? 'workspace' : 'global-or-custom', source: SOURCE, origin: e.origin };
  try {
    const m = live(e);
    return { ...base, group: publicText(m.group), started_at: m.started_at, ended_at: m.ended_at ?? null, title: publicText(m.title),
      agent: publicText(m.agent || 'codex'), provider: m.agent_type || 'codex cli', model: publicText(m.model_shown || m.model),
      kind: publicText(m.kind || (['discuss', 'review'].includes(m.mode) ? m.mode : 'exec')), mode: publicText(m.mode), effort: publicText(m.effort),
      status: publicText(m.status), session_id: publicText(m.session_id), native_policy: nativePolicy(e, m), available: true };
  } catch (error) { return { ...base, status: error.code === 'ENOENT' ? 'missing' : 'unavailable', available: false, reason: error.message }; }
}
export function listHistory({ search = '', provider = '' } = {}) {
  return indexed().map(summary).filter(e => (!provider || e.provider === provider || e.agent === provider) && (!search || Object.values(e).join(' ').toLowerCase().includes(String(search).toLowerCase())))
    .sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')) || a.id.localeCompare(b.id));
}
function selected(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 500 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) throw new Error('需要 1–500 个唯一记录标识');
  const all = new Map(indexed().map(e => [e.id, e]));
  return ids.map(id => { const e = all.get(id); if (!e) throw new Error('记录标识不存在，请刷新'); return e; });
}
function boundedText(e, name) {
  const file = path.join(e.dir, name); if (!fs.existsSync(file)) return '';
  ordinary(file); const fd = fs.openSync(file, 'r');
  try { const buffer = Buffer.alloc(16000), n = fs.readSync(fd, buffer, 0, buffer.length, 0); return publicText(buffer.subarray(0, n).toString('utf8')); }
  finally { fs.closeSync(fd); }
}
export function previewHistory(id) {
  const [e] = selected([id]), record = summary(e); live(e);
  let answer = boundedText(e, 'last-message.txt');
  if (!answer && fs.existsSync(path.join(e.dir, 'result.json'))) {
    const r = readObject(path.join(e.dir, 'result.json'));
    // 只展示公开回答，不展示 events、原生转录、headers 或 reasoning 字段。
    const report = r.report;
    answer = publicText(r.last_message || (report ? JSON.stringify(Object.fromEntries(['summary', 'findings', 'recommendation', 'conclusion', 'open_questions', 'status'].filter(k => report[k] !== undefined).map(k => [k, report[k]])), null, 2) : ''));
  }
  return { record, brief: boundedText(e, 'brief.md'), answer, limit_chars: 12000 };
}
function sharedLocalSessions(entries) {
  const selectedKeys = new Set(entries.map(e => `${e.root_id}/${e.run_id}`)), blocked = [];
  // 包含尚未导入的同 root 记录，防止删掉别的任务仍引用的本地会话。
  for (const root of knownRoots()) {
    if (!fs.existsSync(root.root)) continue;
    safeAncestors(root.root);
    for (const id of fs.readdirSync(root.root).filter(n => RUN_ID.test(n))) {
      if (selectedKeys.has(`${root.root_id}/${id}`)) continue;
      const dir = path.join(root.root, id);
      let m;
      try { safeAncestors(dir); m = readObject(path.join(dir, 'meta.json')); }
      catch { throw new Error('存在无法核对的保留记录，不能确认原生会话未被共享'); }
      for (const e of entries) {
        if (m.status === 'running' && m.parent === e.run_id && root.root_id === e.root_id) inactive(m.pid);
        if ([m.native_session_file, m.native_session_dir].some(file => typeof file === 'string' && within(e.dir, file))) blocked.push({ id: e.id, reason: `原生会话仍被保留任务 ${id} 引用` });
      }
    }
  }
  return blocked;
}
const piRoot = () => path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'sessions');
function piHeader(file) {
  ordinary(file);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(65536), n = fs.readSync(fd, buffer, 0, buffer.length, 0), first = buffer.subarray(0, n).toString('utf8').split('\n')[0];
    if (Buffer.byteLength(first) >= 65536) throw new Error('pi 会话首行过长');
    const header = JSON.parse(first);
    return header.type === 'session' ? header.id : null;
  } finally { fs.closeSync(fd); }
}
function piFiles(root) {
  if (!fs.existsSync(root)) return [];
  safeAncestors(root);
  const result = []; let visited = 0;
  const visit = dir => {
    for (const name of fs.readdirSync(dir)) {
      if (++visited > 50000) throw new Error('pi 会话目录过大，请先明确 native_session_file');
      const file = path.join(dir, name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) continue; // 不跟随链接，也不从链接目标发现会话。
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile() && name.endsWith('.jsonl')) result.push(file);
    }
  };
  visit(root); return result;
}
function nativePiPlan(entries, requested) {
  const plan = { requested, candidates: [], retained: [] };
  if (!requested) return plan;
  const selectedIds = new Set(entries.map(e => e.id)), byFile = new Map(), root = piRoot();
  let discovered = null;
  for (const entry of entries) {
    const meta = live(entry);
    if (meta.agent_type !== 'pi cli') continue;
    if (meta.native_session_file && within(entry.dir, meta.native_session_file)) continue;
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(meta.session_id || '')) { plan.retained.push({ id: entry.id, reason: '缺少有效 pi session_id，外部聊天保留' }); continue; }
    let files = [];
    if (meta.native_session_file) {
      if (!path.isAbsolute(meta.native_session_file) || !within(root, meta.native_session_file)) { plan.retained.push({ id: entry.id, reason: '原生会话路径不在已授权 pi sessions 目录，外部聊天保留' }); continue; }
      files = [meta.native_session_file];
    } else files = discovered ||= piFiles(root);
    const matches = [];
    for (const file of files) {
      try { safeAncestors(path.dirname(file)); if (piHeader(file) === meta.session_id) matches.push(file); }
      catch (error) { if (meta.native_session_file) throw new Error(`pi 会话无法安全核实：${error.message}`); }
    }
    if (!matches.length) { plan.retained.push({ id: entry.id, reason: '未找到首行 ID 精确匹配的普通 pi 会话文件，外部聊天保留' }); continue; }
    for (const file of matches) {
      const k = keyPath(file), previous = byFile.get(k);
      if (previous) previous.ids.push(entry.id);
      else { const stat = ordinary(file); byFile.set(k, { file, session_id: meta.session_id, ids: [entry.id], size: stat.size, mtime_ms: stat.mtimeMs }); }
    }
  }
  // 未选中的所有已登记 root（包括未索引的同 root run）都参与共享引用核对。
  for (const manifest of knownRoots()) {
    if (!fs.existsSync(manifest.root)) continue;
    safeAncestors(manifest.root);
    for (const id of fs.readdirSync(manifest.root).filter(name => RUN_ID.test(name))) {
      if (selectedIds.has(recordId(manifest.root, id))) continue;
      safeAncestors(path.join(manifest.root, id));
      const m = readObject(path.join(manifest.root, id, 'meta.json'));
      if (m.status === 'running') inactive(m.pid);
      for (const candidate of byFile.values()) if (m.native_session_file && keyPath(m.native_session_file) === keyPath(candidate.file) || m.agent_type === 'pi cli' && m.session_id === candidate.session_id) throw new Error(`pi 会话 ${candidate.session_id} 仍被未选中任务 ${id} 引用`);
    }
  }
  plan.candidates = [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
  return plan;
}
function verifyPiCandidate(candidate) {
  const root = piRoot();
  if (!within(root, candidate.file) || keyPath(root) === keyPath(candidate.file)) throw new Error('pi 会话路径越界');
  safeAncestors(path.dirname(candidate.file));
  const stat = ordinary(candidate.file);
  if (piHeader(candidate.file) !== candidate.session_id || stat.size !== candidate.size || stat.mtimeMs !== candidate.mtime_ms) throw new Error('pi 会话文件已变化，请重新预览');
}
export function deleteHistory(ids, { apply = false, deleteNativePi = false, expectedNative = null } = {}) {
  const entries = selected(ids), registered = knownRoots(), roots = registered.filter(m => fs.existsSync(m.root)).sort((a, b) => a.root_id.localeCompare(b.root_id));
  const checkViewers = (m, pending = entries) => safeViewers(m.root, pending.filter(entry => entry.root_id === m.root_id).map(live), registered.map(manifest => manifest.root));
  const locks = [], result = { apply, candidates: entries.map(summary), blocked: [], deleted: [], native_deleted: [], native_cleanup: { requested: deleteNativePi, candidates: [], retained: [] }, native_policy: '仅删除选中的 Foreman 本地目录；仅显式勾选并验证的 pi 原生会话另行清理，其他原应用聊天保留' };
  try {
    for (const m of roots) {
      safeAncestors(m.root);
      const lock = path.join(m.root, '.start.lock');
      if (apply) { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); locks.push(lock); }
      else if (fs.existsSync(lock)) throw new Error('任务登记锁存在，无法确认清理安全');
    }
    for (const m of roots) checkViewers(m);
    for (const e of entries) {
      try { safeRun(e.dir, live(e)); } catch (error) { result.blocked.push({ id: e.id, reason: error.message }); }
    }
    result.blocked.push(...sharedLocalSessions(entries));
    result.native_cleanup = nativePiPlan(entries, deleteNativePi);
    if (expectedNative && JSON.stringify(result.native_cleanup) !== JSON.stringify(expectedNative)) throw new Error('原生会话清理范围已变化，请重新预览');
    if (apply && !result.blocked.length) {
      if (JSON.stringify(knownRoots().filter(m => fs.existsSync(m.root)).map(m => m.root_id).sort()) !== JSON.stringify(roots.map(m => m.root_id).sort())) throw new Error('已登记目录发生变化，请重新预览');
      // 全批次再次验证，不能用 group/date 扩大用户所选范围。
      for (const e of entries) safeRun(e.dir, live(e));
      for (const m of roots) checkViewers(m);
      for (const candidate of result.native_cleanup.candidates) verifyPiCandidate(candidate);
      for (const candidate of result.native_cleanup.candidates) { verifyPiCandidate(candidate); fs.unlinkSync(candidate.file); result.native_deleted.push(candidate.file); }
      for (const e of entries) {
        checkViewers(e.manifest, [e]);
        safeRun(e.dir, live(e));
        fs.rmSync(e.dir, { recursive: true }); result.deleted.push(e.id);
        const { manifest, dir, ...stored } = e;
        writeAtomic(path.join(historyHome(), 'entries', `${e.id}.json`), { ...stored, deleted_at: new Date().toISOString() });
      }
    }
  } catch (error) { result.blocked.push({ id: null, reason: error.message }); }
  finally { for (const lock of locks.reverse()) { try { fs.unlinkSync(lock); } catch { /* 已退出的进程残留锁由用户检查 */ } } }
  return result;
}
export function cmdHistory(opts, configuredRoot = null) {
  if (opts.help) {
    process.stdout.write('history [--refresh] [--workspace <旧工作区>] [--legacy-global] [--run <索引 id>] [--search <文字>] [--provider <协作方或类型>]\n--refresh 导入指定工作区并刷新已登记目录；--legacy-global 导入旧全局 runs。默认仅输出统一 JSON 索引；--run 预览 brief 和公开回答。\n'); return;
  }
  const imports = [];
  if (opts.refresh && opts.workspace) imports.push(importWorkspace(opts.workspace, configuredRoot));
  if (opts['legacy-global']) imports.push(importLegacyGlobal());
  if (opts.refresh) imports.push(...refreshHistory());
  const value = opts.run ? previewHistory(opts.run) : { roots: knownRoots(), records: listHistory(opts), imports };
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
