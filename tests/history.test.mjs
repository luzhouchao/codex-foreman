import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { importWorkspace, importLegacyGlobal, registerHistoryRun, historyHome, listHistory, previewHistory, refreshHistory, deleteHistory } from '../skills/codex-foreman/scripts/history.mjs';
import { startHistoryServer } from '../skills/codex-foreman/scripts/history-ui.mjs';
import { sandbox, output, write, json } from './helpers.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-history-'));
  const previous = { CODEX_HOME: process.env.CODEX_HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.CODEX_HOME = path.join(base, 'home', '.codex'); process.env.PI_CODING_AGENT_DIR = path.join(base, 'pi-agent');
  t.after(() => { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } fs.rmSync(base, { recursive: true, force: true }); });
  let seq = 0;
  const add = (name, extra = {}, { legacy = false, global = false } = {}) => {
    const workspace = path.join(base, name), root = global ? path.join(process.env.CODEX_HOME, 'foreman', 'runs') : path.join(workspace, '.codex', 'foreman', 'runs');
    fs.mkdirSync(workspace, { recursive: true });
    const id = `20260101-1200${String(seq++).padStart(2, '0')}-abcd`, dir = path.join(root, id);
    const meta = { id, source: 'codex-foreman', mode: 'discuss', kind: 'discuss', agent: 'pi', agent_type: 'pi cli', cwd: workspace, title: '测试讨论', model: 'fake/model',
      status: 'done', pid: 2147483647, started_at: '2026-01-01T12:00:00Z', ended_at: '2026-01-01T12:01:00Z', session_id: 'pi-session', ...extra };
    if (legacy) delete meta.source;
    write(path.join(dir, 'meta.json'), meta); write(path.join(dir, 'brief.md'), '测试 brief'); write(path.join(dir, 'last-message.txt'), '<script>alert(1)</script>公开回答');
    return { workspace, root, id, dir, meta, index() { registerHistoryRun({ root, workspace, meta }); return listHistory().find(e => e.run_id === id); } };
  };
  return { base, add, piFile(id = 'pi-session', name = 'session.jsonl') { return write(path.join(process.env.PI_CODING_AGENT_DIR, 'sessions', name), `${JSON.stringify({ type: 'session', id })}\nprivate transcript`); } };
}

test('真实公共执行路径统一登记且旧watch auto配置不再创建终端查看器', async t => {
  const h = sandbox(t), cfg = h.config(); cfg.dispatch.runs_dir = '.codex/foreman/runs'; cfg.dispatch.watch = 'auto'; h.config(cfg);
  const second = path.join(h.home, 'project-b'); fs.mkdirSync(second);
  for (const workspace of [h.cwd, second]) output(await h.bridge(['discuss', '--agent', 'codex', '--effort', 'medium', '--workspace', workspace, '--cwd', workspace, '--brief', '-']));
  const fromA = output(await h.bridge(['history'], { cwd: h.cwd })), fromB = output(await h.bridge(['history'], { cwd: second }));
  assert.equal(fromA.records.length, 2); assert.deepEqual(fromA.records, fromB.records);
  assert.deepEqual(new Set(fromA.records.map(e => e.workspace)), new Set([h.cwd, second]));
  for (const e of fromA.records) { assert.equal(e.source, 'codex-foreman'); assert.ok(e.session_id); assert.equal(e.status, 'done'); assert.equal(e.origin, 'invocation'); }
  for (const record of fromA.records) {
    const dir = path.join(record.storage_root, record.run_id);
    assert.equal(json(path.join(dir, 'meta.json')).viewer.status, 'off');
    assert.equal(fs.existsSync(path.join(dir, 'viewer-ready.json')), false);
    assert.equal(fs.readdirSync(record.storage_root).some(name => name.startsWith('.viewer-')), false);
  }
  output(await h.bridge(['check'])); assert.equal(output(await h.bridge(['history'])).records.length, 2);
});
test('旧工作区和旧全局 runs 显式导入，拒绝未知来源，缺失目录显示 missing，墓碑不会复活', t => {
  const f = fixture(t), a = f.add('a', {}, { legacy: true }), g = f.add('b', {}, { legacy: true, global: true });
  const unknown = f.add('a', { agent_type: 'unknown' }, { legacy: true });
  assert.equal(listHistory().length, 0);
  const imported = importWorkspace(a.workspace); assert.equal(imported.imported, 1); assert.equal(imported.skipped.length, 1);
  assert.equal(importLegacyGlobal().imported, 1); assert.equal(listHistory().length, 2);
  assert.equal(listHistory().find(e => e.run_id === g.id).workspace, g.workspace);
  const e = listHistory().find(e => e.run_id === a.id); fs.rmSync(a.dir, { recursive: true }); refreshHistory();
  assert.equal(listHistory().find(e => e.id === e.id && e.run_id === a.id).status, 'missing');
  assert.equal(fs.existsSync(unknown.dir), true);
  const globalEntry = listHistory().find(e => e.run_id === g.id); assert.equal(deleteHistory([globalEntry.id], { apply: true }).deleted.length, 1);
  write(path.join(g.dir, 'meta.json'), g.meta); importLegacyGlobal(); assert.equal(listHistory().some(e => e.run_id === g.id), false);
});
test('精确跨工作区删除只影响所选记录，本地 pi session 随 run 清除，未知原生聊天默认保留', t => {
  const f = fixture(t), a = f.add('a'), b = f.add('b', { agent_type: 'opencode cli' }), keep = f.add('a');
  const local = write(path.join(a.dir, 'pi-sessions', 'local.jsonl'), 'local'); a.meta.native_session_file = local; write(path.join(a.dir, 'meta.json'), a.meta);
  const native = f.piFile(); a.meta.native_session_dir = path.dirname(local);
  const ids = [a.index().id, b.index().id]; keep.index();
  const preview = deleteHistory(ids); assert.equal(preview.candidates.length, 2); assert.deepEqual(preview.deleted, []); assert.ok(fs.existsSync(local));
  const result = deleteHistory(ids, { apply: true }); assert.deepEqual(result.blocked, []); assert.equal(result.deleted.length, 2);
  assert.ok(fs.existsSync(keep.dir)); assert.ok(fs.existsSync(native)); assert.ok(!fs.existsSync(local)); assert.equal(listHistory().length, 1);
  assert.throws(() => deleteHistory(['../../escape']));
});
test('外部 pi 首行精确定位且默认保留；显式选择只删匹配文件，个人聊天保留', t => {
  const f = fixture(t), a = f.add('a', {}, { legacy: true }), native = f.piFile(), personal = f.piFile('personal', 'personal.jsonl');
  importWorkspace(a.workspace); const [e] = listHistory();
  const normal = deleteHistory([e.id]); assert.equal(normal.native_cleanup.candidates.length, 0); assert.ok(fs.existsSync(native));
  const preview = deleteHistory([e.id], { deleteNativePi: true }); assert.deepEqual(preview.blocked, []); assert.equal(preview.native_cleanup.candidates[0].file, native);
  const applied = deleteHistory([e.id], { apply: true, deleteNativePi: true, expectedNative: preview.native_cleanup });
  assert.deepEqual(applied.blocked, []); assert.deepEqual(applied.native_deleted, [native]); assert.ok(!fs.existsSync(native)); assert.ok(fs.existsSync(personal));
});
test('共享外部 pi session 与保留 run 内 session 的引用均阻止删除；全部选中才可清理', t => {
  const f = fixture(t), a = f.add('a'), b = f.add('b'), native = f.piFile(); const ea = a.index(), eb = b.index();
  const shared = deleteHistory([ea.id], { apply: true, deleteNativePi: true }); assert.ok(shared.blocked.some(e => /未选中/.test(e.reason))); assert.ok(fs.existsSync(native)); assert.ok(fs.existsSync(a.dir));
  const local = write(path.join(a.dir, 'pi-sessions', 'local.jsonl'), 'local'); b.meta.native_session_file = local; write(path.join(b.dir, 'meta.json'), b.meta);
  assert.ok(deleteHistory([ea.id], { apply: true }).blocked.some(e => /引用/.test(e.reason)));
  b.meta.native_session_file = native; write(path.join(b.dir, 'meta.json'), b.meta);
  const all = deleteHistory([ea.id, eb.id], { apply: true, deleteNativePi: true }); assert.deepEqual(all.blocked, []); assert.equal(all.native_deleted.length, 1);
});
test('未明示/不匹配/越界原生会话不得误删；预览后文件变动使删除失效', t => {
  const f = fixture(t), unrelated = f.piFile('personal'), a = f.add('a', { native_session_file: path.join(f.base, 'outside.jsonl') });
  write(a.meta.native_session_file, JSON.stringify({ type: 'session', id: 'pi-session' })); const e = a.index();
  const outside = deleteHistory([e.id], { deleteNativePi: true }); assert.equal(outside.native_cleanup.candidates.length, 0); assert.equal(outside.native_cleanup.retained.length, 1);
  delete a.meta.native_session_file; write(path.join(a.dir, 'meta.json'), a.meta);
  assert.equal(deleteHistory([e.id], { deleteNativePi: true }).native_cleanup.candidates.length, 0); assert.ok(fs.existsSync(unrelated));
  const target = f.piFile('pi-session', 'match.jsonl'), preview = deleteHistory([e.id], { deleteNativePi: true });
  fs.appendFileSync(target, 'changed');
  const applied = deleteHistory([e.id], { apply: true, deleteNativePi: true, expectedNative: preview.native_cleanup }); assert.ok(applied.blocked.length); assert.ok(fs.existsSync(a.dir)); assert.ok(fs.existsSync(target));
});
test('活跃任务/登记锁/查看器/来源篡改及嵌套链接阻止清理', t => {
  const f = fixture(t), a = f.add('a'), e = a.index();
  for (const changes of [{ pid: process.pid, ended_at: new Date().toISOString() }, { status: 'running' }, { ended_at: null }, { source: 'personal' }, { runs_root: f.base }]) {
    write(path.join(a.dir, 'meta.json'), { ...a.meta, ...changes }); assert.ok(deleteHistory([e.id], { apply: true }).blocked.length); assert.ok(fs.existsSync(a.dir));
  }
  write(path.join(a.dir, 'meta.json'), a.meta);
  for (const [name, content] of [['.start.lock', '123'], ['.viewer-test.json', { pending: true, pid: process.pid }]]) {
    write(path.join(a.root, name), content); assert.ok(deleteHistory([e.id], { apply: true }).blocked.length); fs.unlinkSync(path.join(a.root, name));
  }
  write(path.join(a.dir, 'viewer-ready.json'), { pid: process.pid }); assert.ok(deleteHistory([e.id]).blocked.length); fs.unlinkSync(path.join(a.dir, 'viewer-ready.json'));
  const target = path.join(f.base, 'target'); fs.mkdirSync(target); write(path.join(target, 'keep'), 'keep');
  fs.symlinkSync(target, path.join(a.dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.ok(deleteHistory([e.id], { apply: true }).blocked.length); assert.ok(fs.existsSync(path.join(target, 'keep')));
});
test('祖先 junction、全局 pi 会话 symlink 和冒充 Foreman 的索引路径都不可访问', t => {
  const f = fixture(t), a = f.add('a'), e = a.index(), native = f.piFile();
  const link = path.join(f.base, 'alias'); fs.symlinkSync(a.workspace, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => importWorkspace(link), /普通目录/);
  const outside = write(path.join(f.base, 'outside.jsonl'), JSON.stringify({ type: 'session', id: 'pi-session' })); fs.unlinkSync(native); fs.symlinkSync(outside, native, process.platform === 'win32' ? 'file' : undefined);
  a.meta.native_session_file = native; write(path.join(a.dir, 'meta.json'), a.meta);
  assert.ok(deleteHistory([e.id], { deleteNativePi: true }).blocked.length); assert.ok(fs.existsSync(outside));
  const entryFile = path.join(historyHome(), 'entries', `${e.id}.json`), index = json(entryFile); index.run_id = '../outside'; write(entryFile, index);
  assert.equal(listHistory().length, 0);
});
test('索引祖先 junction 在 mkdir 前拒绝，外部目录不产生任何副作用', t => {
  const f = fixture(t), a = f.add('a'), target = path.join(f.base, 'outside-index'); fs.mkdirSync(target);
  const home = historyHome(); fs.mkdirSync(path.dirname(home), { recursive: true });
  fs.symlinkSync(target, home, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => a.index(), /普通目录/); assert.deepEqual(fs.readdirSync(target), []);
});
test('全局共享 runs root 仍保留每条调用的真实工作区，并发登记不会覆盖其他 run', async t => {
  const h = sandbox(t), second = path.join(h.home, 'project-b'); fs.mkdirSync(second);
  const results = await Promise.all([h.cwd, second].map(workspace => h.bridge(['discuss', '--agent', 'codex', '--effort', 'medium', '--workspace', workspace, '--cwd', workspace, '--brief', '-'])));
  for (const r of results) output(r);
  const records = output(await h.bridge(['history'])).records;
  assert.equal(records.length, 2); assert.deepEqual(new Set(records.map(e => e.workspace)), new Set([h.cwd, second]));
  assert.equal(new Set(records.map(e => e.root_id)).size, 1);
});
test('原生清理拒绝已登记其他工作区仍在运行的 pi，登记锁不被强行清除', t => {
  const f = fixture(t), a = f.add('a'), b = f.add('b', { status: 'running', pid: process.pid, session_id: null }); f.piFile(); const e = a.index(); b.index();
  const result = deleteHistory([e.id], { apply: true, deleteNativePi: true }); assert.ok(result.blocked.some(x => /仍在运行/.test(x.reason))); assert.ok(fs.existsSync(a.dir));
  write(path.join(b.root, '.start.lock'), 'unrelated-lock');
  const locked = deleteHistory([e.id], { apply: true }); assert.ok(locked.blocked.length); assert.equal(fs.readFileSync(path.join(b.root, '.start.lock'), 'utf8'), 'unrelated-lock');
  assert.ok(!fs.existsSync(path.join(a.root, '.start.lock')));
});
test('无关组/工作区的活跃查看器不阻止所选已结束任务，所选同会话共享查看器仍受保护', t => {
  const f = fixture(t), a = f.add('a', { group: 'selected', host_session: 'host-a' }), other = f.add('other');
  const e = a.index(); other.index();
  const lease = (root, session, group) => path.join(root, `.viewer-${createHash('sha256').update(JSON.stringify([session, ['group', group]])).digest('hex').slice(0, 24)}.json`);
  write(lease(a.root, 'host-a', 'unrelated'), { pid: process.pid, pending: false });
  write(lease(other.root, 'host-a', 'selected'), { pid: process.pid, pending: false });
  assert.deepEqual(deleteHistory([e.id]).blocked, [], '无关查看器不能全局阻塞');
  write(lease(a.root, 'host-a', 'selected'), { pid: process.pid, pending: false });
  assert.ok(deleteHistory([e.id]).blocked.some(x => /仍在运行/.test(x.reason)), '共享所选组的查看器必须阻止');
});
test('已登记旧root的迁移查看器引用仅在安全核实后放行，活跃和越界引用仍阻止', t => {
  const f = fixture(t), source = f.add('old', { session_id: null }, { global: true }), copy = f.add('copy', { session_id: null, group: 'migrated', host_session: 'host' });
  source.index();
  const name = `.viewer-${createHash('sha256').update(JSON.stringify(['host', ['group', 'migrated']])).digest('hex').slice(0, 24)}.json`;
  const lease = path.join(source.root, name), ready = path.join(copy.dir, 'viewer-ready.json');
  copy.meta.viewer = { status: 'requested', lease }; write(path.join(copy.dir, 'meta.json'), copy.meta);
  write(ready, { pid: 2147483647, run: copy.id, group: 'migrated' });
  const e = copy.index(), preview = () => deleteHistory([e.id], { deleteNativePi: true });
  assert.deepEqual(preview().blocked, [], '迁移后已消失的旧登记不能阻止本地记录');
  write(lease, { pid: process.pid, pending: false }); assert.ok(preview().blocked.some(x => /仍在运行/.test(x.reason)), '真实旧root查看器仍受保护');
  write(lease, { pid: 2147483647, pending: true }); assert.ok(preview().blocked.some(x => /启动/.test(x.reason)));
  write(lease, '{broken'); assert.ok(preview().blocked.length, '未知状态不能忽略'); fs.unlinkSync(lease);
  const outside = path.join(f.base, 'not-registered', name); write(outside, { pid: 2147483647, pending: false });
  copy.meta.viewer.lease = outside; write(path.join(copy.dir, 'meta.json'), copy.meta); assert.ok(preview().blocked.some(x => /路径/.test(x.reason))); assert.ok(fs.existsSync(outside));
  copy.meta.viewer.lease = lease; write(path.join(copy.dir, 'meta.json'), copy.meta);
  fs.symlinkSync(outside, lease, process.platform === 'win32' ? 'file' : undefined); assert.ok(preview().blocked.some(x => /普通文件|链接/.test(x.reason))); fs.unlinkSync(lease);
  write(ready, { pid: process.pid, run: copy.id, group: 'migrated' }); assert.ok(preview().blocked.some(x => /仍在运行/.test(x.reason)), '所选记录自己的查看器仍受保护');
  assert.ok(fs.existsSync(copy.dir)); assert.ok(fs.existsSync(source.dir));
});
test('Windows 仅在OS创建时间晚于任务终态时识别PID复用，真实存活任务和查看器仍阻止', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t), a = f.add('a', { pid: process.pid }), e = a.index();
  assert.deepEqual(deleteHistory([e.id]).blocked, [], '当前测试进程确实晚于旧任务结束时间，应识别为复用');
  a.meta.ended_at = new Date().toISOString(); write(path.join(a.dir, 'meta.json'), a.meta);
  assert.ok(deleteHistory([e.id]).blocked.some(x => /仍在运行/.test(x.reason)), '早于ended_at启动的同一存活进程不能放行');
  a.meta.pid = 2147483647; write(path.join(a.dir, 'meta.json'), a.meta);
  write(path.join(a.dir, 'viewer-ready.json'), { pid: process.pid, started_at: '2026-01-01T12:00:00Z' });
  assert.ok(deleteHistory([e.id]).blocked.some(x => /仍在运行/.test(x.reason)), '未知查看器身份不采用任务ended_at推断');
});
test('Windows 统一进程证据核对EPERM和旧ready复用，未知或真实存活身份仍受保护', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t), a = f.add('a', { pid: process.pid, group: 'viewer-group' }), e = a.index();
  const originalKill = process.kill;
  t.mock.method(process, 'kill', (pid, signal) => { if (pid === process.pid && signal === 0) throw Object.assign(new Error('synthetic EPERM'), { code: 'EPERM' }); return originalKill.call(process, pid, signal); });
  for (const pid of [2147483648, Number.MAX_SAFE_INTEGER + 1]) {
    write(path.join(a.dir, 'meta.json'), { ...a.meta, pid }); assert.ok(deleteHistory([e.id]).blocked.some(x => /有效 PID/.test(x.reason)), '无效超大PID不得落入OS absent分支');
  }
  write(path.join(a.dir, 'meta.json'), a.meta);
  assert.deepEqual(deleteHistory([e.id]).blocked, [], 'kill(0) EPERM不能遮蔽OS可核实的创建时间复用证据');
  a.meta.ended_at = new Date().toISOString(); write(path.join(a.dir, 'meta.json'), a.meta);
  assert.ok(deleteHistory([e.id]).blocked.length, '同一存活进程不能因EPERM放行');
  a.meta.pid = 2147483647; a.meta.ended_at = '2026-01-01T12:01:00Z'; write(path.join(a.dir, 'meta.json'), a.meta);
  const ready = path.join(a.dir, 'viewer-ready.json'), published = { pid: process.pid, run: a.id, group: 'viewer-group', started_at: '2026-01-01T12:00:00.500Z' };
  write(ready, published); assert.deepEqual(deleteHistory([e.id]).blocked, [], '可验证的旧ready发布时刻可证明viewer PID已被复用');
  for (const changed of [{ run: 'another-run' }, { group: 'another-group' }, { started_at: 'invalid' }, { started_at: '2025-01-01T00:00:00Z' }, { started_at: new Date().toISOString() }]) {
    write(ready, { ...published, ...changed }); assert.ok(deleteHistory([e.id]).blocked.length, '未知、错配或仍存活的viewer不能放行');
  }
  fs.unlinkSync(ready);
  const key = JSON.stringify([a.meta.host_session, ['group', a.meta.group]]), lease = path.join(a.root, `.viewer-${createHash('sha256').update(key).digest('hex').slice(0, 24)}.json`);
  write(lease, { pid: process.pid, pending: false, created: Date.parse('2026-01-01T12:00:00Z') });
  assert.ok(deleteHistory([e.id]).blocked.length, 'lease.created早于spawn，不能作为viewer进程的发布时间证据');
});
test('预览只读取 brief 和公开回答，截断且隐藏认证和思考字段', t => {
  const f = fixture(t), a = f.add('a'), e = a.index();
  write(path.join(a.dir, 'last-message.txt'), 'Bearer abc.secret\n<think>private thought</think>\n公开答案\n' + '字'.repeat(20000));
  write(path.join(a.dir, 'events.jsonl'), 'NEVER_READ_REASONING');
  const p = previewHistory(e.id); assert.ok(p.answer.length <= 12000); assert.ok(!p.answer.includes('private thought')); assert.ok(!p.answer.includes('abc.secret')); assert.ok(!JSON.stringify(p).includes('NEVER_READ_REASONING'));
});
test('GUI API smoke：认证、Host/Origin/CSRF、防路径注入、两阶段确认及一次性票据', async t => {
  const f = fixture(t), a = f.add('a'), e = a.index(), b = f.add('b'); b.index();
  const ui = await startHistoryServer(); t.after(() => ui.close());
  const token = new URL(ui.url).hash.slice(1), auth = { Authorization: `Bearer ${token}` };
  const get = (url, headers = auth) => fetch(`${ui.origin}${url}`, { headers });
  assert.equal((await get('/api/records', {})).status, 401);
  const badHost = await new Promise((resolve, reject) => { const req = http.get(`${ui.origin}/api/records`, { headers: { ...auth, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(badHost, 403);
  assert.equal((await get('/api/records', { ...auth, Origin: 'http://evil.example' })).status, 403);
  assert.equal((await get('/api/preview?id=../../file')).status, 400);
  assert.equal((await get('/%2e%2e/package.json')).status, 404);
  const state = await (await get('/api/records')).json(); assert.equal(state.records.length, 2);
  const post = (url, value, headers = {}) => fetch(`${ui.origin}${url}`, { method: 'POST', headers: { ...auth, Origin: ui.origin, 'Content-Type': 'application/json', 'X-Foreman-CSRF': state.csrf, ...headers }, body: JSON.stringify(value) });
  assert.equal((await post('/api/delete-preview', { ids: [e.id] }, { 'X-Foreman-CSRF': '' })).status, 403);
  assert.equal((await post('/api/refresh', { path: f.base })).status, 400);
  assert.equal((await post('/api/delete-preview', { ids: [e.id], group: 'all' })).status, 400);
  const preview = await (await post('/api/delete-preview', { ids: [e.id] })).json(); assert.ok(preview.ticket); assert.ok(preview.previews[0].brief); assert.ok(fs.existsSync(a.dir));
  assert.equal((await post('/api/delete-confirm', { ticket: preview.ticket, confirmation: 'yes' })).status, 400); assert.ok(fs.existsSync(a.dir));
  const next = await (await post('/api/delete-preview', { ids: [e.id] })).json();
  const applied = await (await post('/api/delete-confirm', { ticket: next.ticket, confirmation: '删除所选记录' })).json(); assert.deepEqual(applied.deleted, [e.id]); assert.ok(fs.existsSync(b.dir));
  assert.equal((await post('/api/delete-confirm', { ticket: next.ticket, confirmation: '删除所选记录' })).status, 400); assert.equal((await (await get('/api/records')).json()).records.length, 1);
});
