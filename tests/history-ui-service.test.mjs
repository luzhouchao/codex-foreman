import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { autoStartHistoryUi, ensureHistoryUi, historyUiSettings, historyUiStatus, remainingOwnerIds, runHistoryUiService, servicePaths, stopHistoryUi } from '../skills/codex-foreman/scripts/history-ui-service.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 4500) { const end = Date.now() + timeout; while (Date.now() < end) { if (await check()) return; await sleep(50); } assert.fail('等待服务状态超时'); }
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-ui-service-')), old = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(async () => { await stopHistoryUi(); await until(() => !fs.existsSync(servicePaths().state)); if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old; fs.rmSync(home, { recursive: true, force: true }); });
  return home;
}
test('默认禁用on_use不创建服务状态；并发后台启动只复用认证实例，停止与失效重启均需身份匹配', async t => {
  fixture(t);
  assert.equal(historyUiSettings().on_use, false); assert.deepEqual(await autoStartHistoryUi(), { skipped: 'disabled' }); assert.equal(fs.existsSync(servicePaths().dir), false);
  const results = await Promise.all([ensureHistoryUi({ port: 0, manual: true }), ensureHistoryUi({ port: 0, manual: true })]);
  assert.equal(results[0].state.instance_id, results[1].state.instance_id); assert.equal(results[0].state.pid, results[1].state.pid); assert.notEqual(results[0].state.pid, process.pid);
  const first = await historyUiStatus(); assert.equal(first.running, true);
  assert.equal(fs.existsSync(servicePaths().lock), false, 'ready 后父进程不能重建启动锁');
  assert.equal((await fetch(`${first.state.origin}/api/service/health`)).status, 401);
  const headers = { Authorization: `Bearer ${first.state.token}`, Origin: first.state.origin, 'Content-Type': 'application/json', 'X-Foreman-CSRF': first.health.csrf };
  assert.equal((await fetch(`${first.state.origin}/api/service/stop`, { method: 'POST', headers, body: JSON.stringify({ instance_id: 'f'.repeat(64) }) })).status, 400);
  assert.equal((await historyUiStatus()).running, true);
  assert.equal((await stopHistoryUi()).stopped, true); await until(() => !fs.existsSync(servicePaths().state));
  fs.writeFileSync(servicePaths().state, JSON.stringify(first.state));
  const restarted = await ensureHistoryUi({ port: 0, manual: true }); assert.notEqual(restarted.state.instance_id, first.state.instance_id);
});
test('未知端口服务不因伪造ready/PID被复用或停止，占用时明确报错而不杀进程', async t => {
  fixture(t); let calls = 0;
  const unknown = http.createServer((_req, res) => { calls++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ service: 'another-app' })); });
  await new Promise(resolve => unknown.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => unknown.close(resolve)));
  const port = unknown.address().port, files = servicePaths(); fs.mkdirSync(files.dir, { recursive: true });
  fs.writeFileSync(files.state, JSON.stringify({ service: 'codex-foreman-history-ui', protocol: 1, pid: process.pid, port, origin: `http://127.0.0.1:${port}`, token: randomBytes(32).toString('hex'), instance_id: randomBytes(32).toString('hex'), started_at: new Date().toISOString() }));
  assert.equal((await historyUiStatus()).running, false); assert.equal((await stopHistoryUi()).stopped, false);
  await assert.rejects(ensureHistoryUi({ port, manual: true }), /占用|启动未完成/); assert.equal(unknown.listening, true); assert.ok(calls > 0);
  fs.unlinkSync(files.state);
});
test('合成Codex宿主退出令自有服务自然关闭，unknown保守保留；启动验证失败不遗留锁', async t => {
  fixture(t);
  assert.deepEqual(remainingOwnerIds(['a','b','c'], ['alive','unknown','exited']), ['a','b']);
  const synthetic = pid => {
    const value = { schema_version: 1, platform: 'win32', kind: 'codex-desktop', pid, started_at: new Date().toISOString(), executable: `${process.env.ProgramFiles || 'C:/Program Files'}/WindowsApps/OpenAI.Codex_synthetic/app/ChatGPT.exe` };
    value.owner_id = createHash('sha256').update(JSON.stringify([value.platform,value.kind,value.pid,value.started_at,value.executable.replace(/\\/g,'/').toLowerCase()])).digest('hex'); return value;
  };
  const owner = synthetic(100001), nextOwner = synthetic(100002); let state = 'alive', nextState = 'alive', attachmentStarted = false, finishAttachment;
  const managed = await runHistoryUiService({ port: 0, owner, inspectOwner: async value => value.owner_id === owner.owner_id ? state : (attachmentStarted = true, await new Promise(resolve => { finishAttachment = () => resolve(nextState); })) });
  assert.equal((await historyUiStatus()).running, true); state = 'unknown'; await sleep(2150); assert.equal((await historyUiStatus()).running, true);
  const status = await historyUiStatus();
  const attaching = fetch(`${status.state.origin}/api/service/attach`, { method: 'POST', headers: { Authorization: `Bearer ${status.state.token}`, Origin: status.state.origin, 'Content-Type': 'application/json', 'X-Foreman-CSRF': status.health.csrf }, body: JSON.stringify({ owner: nextOwner }) });
  await until(() => attachmentStarted); state = 'exited'; await sleep(2100);
  assert.equal((await historyUiStatus()).running, true, '新宿主验证尚未完成时不得因旧宿主退出而关闭');
  finishAttachment(); assert.equal((await attaching).status, 200);
  // Subsequent polls have an immediate synthetic answer rather than a pending attachment.
  nextState = 'exited'; const finishing = setInterval(() => finishAttachment?.(), 30);
  try { await until(async () => !(await historyUiStatus()).running); } finally { clearInterval(finishing); }
  assert.equal(fs.existsSync(servicePaths().state), false); await managed.close();
  await assert.rejects(runHistoryUiService({ port: 0, owner, inspectOwner: async () => 'exited' }), /启动失败/); assert.equal(fs.existsSync(servicePaths().lock), false);
  const originalRename = fs.renameSync, originalListen = http.Server.prototype.listen, listening = [];
  const renameMock = t.mock.method(fs, 'renameSync', (from, to) => { if ([servicePaths().state, servicePaths().failure].includes(to)) throw new Error('synthetic disk failure'); return originalRename(from, to); });
  const listenMock = t.mock.method(http.Server.prototype, 'listen', function(...args) { this.once('listening', () => listening.push({ server: this, port: this.address().port })); return originalListen.apply(this, args); });
  await assert.rejects(runHistoryUiService({ port: 0, manual: true }), /启动失败/);
  renameMock.mock.restore(); listenMock.mock.restore();
  assert.equal(fs.existsSync(servicePaths().lock), false); assert.equal(listening.length, 1); assert.equal(listening[0].server.listening, false, 'ready 和 failure 都写盘失败仍须关闭自己的监听');
  const probe = http.createServer(); await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(listening[0].port, '127.0.0.1', resolve); }); await new Promise(resolve => probe.close(resolve));
});
