import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoverCodexOwner, ownerStatus, readOwnerFromEnv } from './codex-owner.mjs';
const SERVICE = 'codex-foreman-history-ui', PROTOCOL = 1;
const secret = () => randomBytes(32).toString('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const servicePaths = () => {
  const home = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')), foreman = path.join(home, 'foreman'), dir = path.join(foreman, 'history-ui-service');
  return { home, foreman, dir, settings: path.join(foreman, 'history-ui-settings.json'), state: path.join(dir, 'ready.json'), lock: path.join(dir, 'start.lock'), failure: path.join(dir, 'failure.json') };
};
function noLinks(file) {
  const absolute = path.resolve(file), root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('服务状态路径包含链接，已拒绝'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function read(file, limit = 65536) {
  noLinks(file);
  try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.size > limit) throw new Error('无效服务状态文件'); return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function directory() { const files = servicePaths(); noLinks(files.dir); fs.mkdirSync(files.dir, { recursive: true, mode: 0o700 }); noLinks(files.dir); return files; }
function write(file, value) {
  noLinks(file); const temporary = `${file}.${secret()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function validPort(port) { if (!Number.isInteger(port) || port !== 0 && (port < 1024 || port > 65535)) throw new Error('端口需要为 0 或 1024–65535 的整数'); return port; }
export function historyUiSettings() {
  const value = read(servicePaths().settings, 8192);
  if (!value) return { on_use: false, port: 50418 };
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['on_use', 'port', 'schema_version'].includes(key)) || typeof value.on_use !== 'boolean' || value.schema_version !== undefined && value.schema_version !== 1) throw new Error('history-ui-settings.json 需要布尔 on_use 和可选 port');
  return { on_use: value.on_use, port: validPort(value.port ?? 50418) };
}
function validState(state) {
  return state && state.service === SERVICE && state.protocol === PROTOCOL && /^[a-f0-9]{64}$/.test(state.instance_id) && /^[a-f0-9]{64}$/.test(state.token)
    && Number.isInteger(state.pid) && state.pid > 0 && Number.isInteger(state.port) && state.port >= 1024 && state.port <= 65535
    && state.origin === `http://127.0.0.1:${state.port}` && typeof state.started_at === 'string' && Number.isFinite(Date.parse(state.started_at));
}
function request(state, route, input, csrf) {
  return new Promise((resolve, reject) => {
    const content = input === undefined ? null : Buffer.from(JSON.stringify(input));
    const req = http.request(`${state.origin}${route}`, { method: content ? 'POST' : 'GET', headers: { Authorization: `Bearer ${state.token}`, ...(content ? { Origin: state.origin, 'Content-Type': 'application/json', 'Content-Length': content.length, 'X-Foreman-CSRF': csrf } : {}) } }, res => {
      let size = 0; const chunks = [];
      res.on('data', chunk => { size += chunk.length; if (size > 65536) req.destroy(new Error('服务响应过大')); else chunks.push(chunk); });
      res.on('end', () => { clearTimeout(timer); try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (res.statusCode !== 200) throw new Error(value.error || `HTTP ${res.statusCode}`); resolve(value); } catch (error) { reject(error); } });
      res.on('error', error => { clearTimeout(timer); reject(error); });
    });
    const timer = setTimeout(() => req.destroy(new Error('服务健康检查超时')), 500);
    req.on('error', error => { clearTimeout(timer); reject(error); }); if (content) req.write(content); req.end();
  });
}
export async function historyUiStatus() {
  const state = read(servicePaths().state);
  if (!state) return { running: false, reason: 'not-started' };
  if (!validState(state)) return { running: false, reason: 'invalid-state' };
  try {
    const health = await request(state, '/api/service/health');
    if (health.service !== SERVICE || health.protocol !== PROTOCOL || health.instance_id !== state.instance_id || health.pid !== state.pid || health.started_at !== state.started_at || !/^[a-f0-9]{64}$/.test(health.csrf || '')) return { running: false, reason: 'identity-mismatch' };
    return { running: true, state, health, url: `${state.origin}/#${state.token}` };
  } catch { return { running: false, reason: 'unreachable' }; }
}
function livePid(pid) { if (!Number.isInteger(pid) || pid <= 0) return true; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }
function removeOwn(file, field, value) { const current = read(file); if (current?.[field] === value) fs.unlinkSync(file); }
function acquire() {
  const files = directory(), launchId = secret(), lock = { service: SERVICE, launch_id: launchId, pid: process.pid, child_pid: null, created_at: Date.now() };
  try { fs.writeFileSync(files.lock, JSON.stringify(lock), { flag: 'wx', mode: 0o600 }); return lock; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = read(files.lock);
    // PID liveness can only keep a lock; it is never sufficient to reuse or stop a server.
    if (previous?.service === SERVICE && Number.isFinite(previous.created_at) && Date.now() - previous.created_at > 10000 && !livePid(previous.pid) && (!previous.child_pid || !livePid(previous.child_pid))) { removeOwn(files.lock, 'launch_id', previous.launch_id); return acquire(); }
    return null;
  }
}
async function attach(status, owner) {
  if (owner && !status.health.owners?.some(item => item.owner_id === owner.owner_id)) await request(status.state, '/api/service/attach', { owner }, status.health.csrf);
  return { ...status, reused: true };
}
// Unknown inspection results retain ownership; only a definite exit removes an owner.
export function remainingOwnerIds(ownerIds, statuses) { return ownerIds.filter((id, index) => statuses[index] !== 'exited'); }
export async function ensureHistoryUi({ port, owner = null, manual = false, timeoutMs = 3000 } = {}) {
  const settings = historyUiSettings(); port = validPort(port ?? settings.port);
  if (owner && await ownerStatus(owner) !== 'alive') throw new Error('无法确认 Codex 宿主身份，未启动自动服务');
  let status = await historyUiStatus(); if (status.running) return attach(status, owner);
  const files = servicePaths(), lock = acquire();
  if (lock) {
    const payload = { launch_id: lock.launch_id, port, owner, manual: Boolean(manual) };
    const child = spawn(process.execPath, [fileURLToPath(new URL('history-ui-daemon.mjs', import.meta.url))], { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(fileURLToPath(import.meta.url)), env: { ...process.env, CODEX_FOREMAN_UI_INTERNAL: '1', CODEX_FOREMAN_UI_LAUNCH: JSON.stringify(payload), ...(owner ? { CODEX_FOREMAN_OWNER_JSON: JSON.stringify(owner) } : {}) } });
    child.on('error', () => { try { write(files.failure, { launch_id: lock.launch_id, error: '后台 Node 服务未能启动' }); removeOwn(files.lock, 'launch_id', lock.launch_id); } catch {} });
    // The child claims the existing lock itself. A parent rewrite could recreate a lock the ready child already removed.
    child.unref();
  }
  const deadline = Date.now() + Math.min(3500, Math.max(100, timeoutMs));
  while (Date.now() < deadline) {
    status = await historyUiStatus(); if (status.running) return { ...await attach(status, owner), reused: !lock };
    const failure = read(files.failure); if (lock && failure?.launch_id === lock.launch_id) throw new Error(failure.error);
    await sleep(80);
  }
  throw new Error('后台服务正在启动或启动未完成；可稍后运行 history-ui --status 检查');
}
export async function stopHistoryUi() {
  const status = await historyUiStatus();
  if (!status.running) return { stopped: false, running: false, reason: status.reason };
  await request(status.state, '/api/service/stop', { instance_id: status.state.instance_id }, status.health.csrf);
  return { stopped: true, instance_id: status.state.instance_id };
}
export async function runHistoryUiService({ port, owner = null, manual = false, launch_id, inspectOwner = ownerStatus } = {}) {
  if (!manual && !owner) throw new Error('自动服务需要已验证的 Codex 宿主；无法识别时请显式后台启动');
  const files = directory(), existing = await historyUiStatus(); if (existing.running) { if (launch_id) removeOwn(files.lock, 'launch_id', launch_id); return { ...await attach(existing, owner), reused: true }; }
  const lock = launch_id ? read(files.lock) : acquire();
  if (!lock || launch_id && lock.launch_id !== launch_id) throw new Error('服务启动锁已被其他实例持有');
  const launch = launch_id || lock.launch_id, started_at = new Date().toISOString(), instance_id = secret(), owners = new Map();
  let ui, timer, signalHandler, closing = false, closePromise, pendingAttachments = 0, state;
  const save = () => { if (closing) throw new Error('后台服务正在关闭，请重新连接'); write(files.state, { ...state, owners: [...owners.values()] }); };
  const close = () => {
    if (closePromise) return closePromise; closing = true; clearInterval(timer);
    closePromise = (async () => {
      try { await ui?.close(); } finally {
        if (signalHandler) for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, signalHandler);
        try { removeOwn(files.state, 'instance_id', instance_id); } catch { /* Refuse to remove a replaced or unreadable state file. */ }
        try { removeOwn(files.lock, 'launch_id', launch); } catch { /* Never remove another launch's lock. */ }
      }
    })();
    return closePromise;
  };
  try {
    write(files.lock, { ...lock, pid: process.pid, child_pid: process.pid });
    // Dependency injection keeps owner-exit tests synthetic; daemon JSON cannot provide functions.
    if (owner) { if (await inspectOwner(owner) !== 'alive') throw new Error('Codex 宿主已退出或无法核验'); owners.set(owner.owner_id, owner); }
    const { startHistoryServer } = await import('./history-ui.mjs');
    ui = await startHistoryServer({ port: validPort(port ?? historyUiSettings().port), service: {
      health: () => ({ service: SERVICE, protocol: PROTOCOL, instance_id, pid: process.pid, started_at, owners: [...owners.values()], manual_lifetime: manual }),
      attach: async value => {
        if (closing) throw new Error('后台服务正在关闭，请重新连接');
        pendingAttachments++;
        try {
          const valid = readOwnerFromEnv({ CODEX_FOREMAN_OWNER_JSON: JSON.stringify(value) });
          if (!valid || await inspectOwner(valid) !== 'alive') throw new Error('无法核验 Codex 宿主身份');
          if (closing) throw new Error('后台服务正在关闭，请重新连接');
          owners.set(valid.owner_id, valid); save(); return { attached: true };
        } finally { pendingAttachments--; }
      },
      stop: close,
    } });
    const address = new URL(ui.url); state = { service: SERVICE, protocol: PROTOCOL, instance_id, pid: process.pid, started_at, port: Number(address.port), origin: ui.origin, token: address.hash.slice(1), manual_lifetime: manual };
    save(); removeOwn(files.lock, 'launch_id', launch);
    let checking = false;
    timer = setInterval(async () => { if (checking || closing || manual || pendingAttachments) return; checking = true; try { const entries = [...owners], statuses = await Promise.all(entries.map(([,value]) => inspectOwner(value))), remaining = new Set(remainingOwnerIds(entries.map(([id]) => id), statuses)); for (const id of owners.keys()) if (!remaining.has(id) && entries.some(([oldId]) => oldId === id)) owners.delete(id); if (!owners.size && !pendingAttachments) await close(); else if (!closing) save(); } catch {} finally { checking = false; } }, 2000);
    timer.unref();
    signalHandler = () => { void close(); };
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, signalHandler);
    return { running: true, url: ui.url, state: { ...state, owners: [...owners.values()] }, reused: false, close };
  } catch (error) {
    const message = error.code === 'EADDRINUSE' ? `端口 ${port ?? historyUiSettings().port} 已被其他进程占用，未接管；请停止原服务或修改用户级端口。` : '后台历史服务启动失败，请运行 history-ui --status 检查。';
    // Listen may already have succeeded when ready-state persistence fails. Release our socket before any fallible diagnostics.
    try { await close(); } catch { /* Cleanup still precedes error reporting. */ }
    try { write(files.failure, { launch_id: launch, error: message }); } catch { /* Disk failures must not strand a listening daemon. */ }
    throw new Error(message);
  }
}
export async function autoStartHistoryUi() {
  if (process.env.CODEX_FOREMAN_UI_INTERNAL === '1') return { skipped: 'internal' };
  const settings = historyUiSettings(); if (!settings.on_use) return { skipped: 'disabled' };
  const owner = await discoverCodexOwner(); if (!owner) return { skipped: 'unverified-owner' };
  process.env.CODEX_FOREMAN_OWNER_JSON = JSON.stringify(owner);
  return ensureHistoryUi({ port: settings.port, owner, manual: false, timeoutMs: 2200 });
}
