import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupRecords } from '../skills/codex-foreman/scripts/cleanup.mjs';
import { sandbox, output } from './helpers.mjs';

function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-cleanup-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const root = path.join(workspace, '.codex', 'foreman', 'runs');
  fs.mkdirSync(root, { recursive: true });
  const add = (id = '20260101-120000-abcd', extra = {}) => {
    const dir = path.join(root, id); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, group: 'topic', host_session: 'session-a', status: 'done', pid: 2147483647, started_at: '2026-01-01T12:00:00Z', ended_at: '2026-01-01T12:01:00Z', ...extra }));
    fs.writeFileSync(path.join(dir, 'report.md'), 'record'); return dir;
  };
  return { workspace, root, add };
}
test('默认预览；显式 apply 只删除选中 runs，保留源码配置及原生记录', t => {
  const f = fixture(t), target = f.add(); f.add('20260102-120000-abcd', { group: 'other' });
  const protectedFiles = ['src/main.mjs', '.codex/foreman.json', '.codex/foreman/native-tasks/task.json', '.codex/sessions/native.json'];
  for (const name of protectedFiles) { const file = path.join(f.workspace, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'keep'); }
  const preview = cleanupRecords({ workspace: f.workspace, group: 'topic' });
  assert.equal(preview.candidates.length, 1); assert.equal(preview.candidates[0].host_session, 'session-a'); assert.deepEqual(preview.deleted, []); assert.ok(fs.existsSync(target));
  assert.equal(cleanupRecords({ workspace: f.workspace, group: 'topic', apply: true }).deleted.length, 1);
  assert.equal(fs.existsSync(target), false); for (const name of protectedFiles) assert.equal(fs.readFileSync(path.join(f.workspace, name), 'utf8'), 'keep');
});
test('UTC 日期边界且要求筛选，拒绝非法日期和路径式组名', t => {
  const f = fixture(t); f.add();
  assert.equal(cleanupRecords({ workspace: f.workspace, before: '2026-01-01' }).candidates.length, 0);
  assert.equal(cleanupRecords({ workspace: f.workspace, before: '2026-01-02' }).candidates.length, 1);
  for (const opts of [{}, { before: '2026-02-30' }, { group: '../topic' }]) assert.throws(() => cleanupRecords({ workspace: f.workspace, ...opts }));
  assert.throws(() => cleanupRecords({ workspace: f.workspace, group: 'topic' }, f.workspace), /不匹配/);
});
test('活跃/不明状态或 PID 阻止整批删除', t => {
  for (const extra of [{ status: 'running' }, { pid: process.pid }, { pid: null }, { ended_at: null }, { id: '../escape' }]) {
    const f = fixture(t), first = f.add(); f.add('20260102-120000-abcd', extra);
    const result = cleanupRecords({ workspace: f.workspace, group: 'topic', apply: true });
    assert.ok(result.blocked.length); assert.deepEqual(result.deleted, []); assert.ok(fs.existsSync(first)); assert.equal(fs.existsSync(path.join(f.root, '.start.lock')), false);
  }
});
test('登记锁、活跃 viewer、启动中 viewer 和损坏 metadata 均阻止', t => {
  const f = fixture(t), dir = f.add();
  const ready = path.join(dir, 'viewer-ready.json'); fs.writeFileSync(ready, JSON.stringify({ pid: process.pid }));
  assert.ok(cleanupRecords({ workspace: f.workspace, group: 'topic' }).blocked.length); fs.unlinkSync(ready);
  const lease = path.join(f.root, '.viewer-test.json'); fs.writeFileSync(lease, JSON.stringify({ pid: process.pid, pending: true }));
  assert.ok(cleanupRecords({ workspace: f.workspace, group: 'topic', apply: true }).blocked.length); fs.unlinkSync(lease);
  fs.writeFileSync(path.join(dir, 'meta.json'), '{broken'); assert.ok(cleanupRecords({ workspace: f.workspace, group: 'topic', apply: true }).blocked.length);
  fs.writeFileSync(path.join(f.root, '.start.lock'), '123'); assert.throws(() => cleanupRecords({ workspace: f.workspace, group: 'topic', apply: true }), /EEXIST/);
});
test('拒绝 runs 祖先、run 目录和嵌套内容的 junction/symlink，保留外部目标', t => {
  const outside = fixture(t); fs.writeFileSync(path.join(outside.workspace, 'keep'), 'keep');
  for (const location of ['ancestor', 'run', 'nested']) {
    const f = fixture(t);
    if (location === 'ancestor') { fs.rmSync(f.root, { recursive: true }); fs.symlinkSync(outside.root, f.root, process.platform === 'win32' ? 'junction' : 'dir'); assert.throws(() => cleanupRecords({ workspace: f.workspace, group: 'topic', apply: true }), /普通目录/); }
    else {
      if (location === 'run') fs.symlinkSync(outside.workspace, path.join(f.root, '20260101-120000-abcd'), process.platform === 'win32' ? 'junction' : 'dir');
      else fs.symlinkSync(outside.workspace, path.join(f.add(), 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
      assert.ok(cleanupRecords({ workspace: f.workspace, group: 'topic', apply: true }).blocked.length);
    }
    assert.equal(fs.readFileSync(path.join(outside.workspace, 'keep'), 'utf8'), 'keep');
  }
});
test('CLI cleanup 路由默认 JSON 预览，apply 布尔开关且预览不生成启动器', async t => {
  const h = sandbox(t), f = fixture(t); f.add();
  const args = ['cleanup', '--workspace', f.workspace, '--group', 'topic'];
  const preview = output(await h.bridge(args)); assert.equal(preview.apply, false); assert.equal(preview.candidates.length, 1);
  assert.equal(fs.existsSync(path.join(f.root, 'watch.mjs')), false);
  const applied = output(await h.bridge([...args, '--apply'])); assert.equal(applied.deleted.length, 1);
});
