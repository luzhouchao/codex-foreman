import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.mjs';
import { openAutoWatch, windowsLaunchScript, powerShellExecutable } from '../skills/codex-foreman/scripts/auto-watch.mjs';

function fixture(t) {
  const h = sandbox(t);
  const dir = path.join(h.runs, 'test-run');
  fs.mkdirSync(dir, { recursive: true });
  return { ctx: { dir, cfg: { dispatch: { watch: 'auto' } } }, meta: { id: 'test-run', group: 'discussion', host_session: 'host-a' } };
}
test('优先 PowerShell 7，没有安装时回退 Windows PowerShell', () => {
  const env = { ProgramFiles: 'C:/Program Files', PATH: '' };
  const expected = path.join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
  assert.equal(powerShellExecutable(env, (file) => file === expected), expected);
  assert.equal(powerShellExecutable(env, () => false), 'powershell.exe');
  assert.ok(windowsLaunchScript({}, expected).includes(expected));
});
test('watch off 与非 Windows 不启动外部窗口', (t) => {
  const { ctx, meta } = fixture(t);
  const launch = () => assert.fail('不应启动');
  assert.equal(openAutoWatch(ctx, meta, { platform: 'linux', launch }).status, 'manual');
  ctx.cfg.dispatch.watch = 'off';
  assert.equal(openAutoWatch(ctx, meta, { platform: 'win32', launch }).status, 'off');
});
test('同一会话同组只启动一个窗口，不同会话独立', (t) => {
  const { ctx, meta } = fixture(t);
  const calls = [];
  const opts = { platform: 'win32', launch: (p) => calls.push(p) };
  assert.equal(openAutoWatch(ctx, meta, opts).status, 'requested');
  assert.equal(openAutoWatch(ctx, { ...meta, id: 'second-run' }, opts).status, 'shared');
  assert.equal(openAutoWatch(ctx, { ...meta, host_session: 'host-b' }, opts).status, 'requested');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].group, 'discussion');
});
test('窗口启动失败释放登记，后续可重试', (t) => {
  const { ctx, meta } = fixture(t);
  assert.equal(openAutoWatch(ctx, meta, { platform: 'win32', launch: () => { throw Error('模拟失败'); } }).status, 'failed');
  assert.equal(openAutoWatch(ctx, meta, { platform: 'win32', launch: () => {} }).status, 'requested');
});
test('过期启动登记和截断登记可恢复', (t) => {
  const { ctx, meta } = fixture(t);
  const opts = { platform: 'win32', launch: () => {} };
  const first = openAutoWatch(ctx, meta, opts);
  const old = JSON.parse(fs.readFileSync(first.lease));
  fs.writeFileSync(first.lease, JSON.stringify({ ...old, created: Date.now() - 20000 }));
  assert.equal(openAutoWatch(ctx, meta, opts).status, 'requested');
  fs.writeFileSync(first.lease, '{');
  const then = new Date(Date.now() - 20000); fs.utimesSync(first.lease, then, then);
  assert.equal(openAutoWatch(ctx, meta, opts).status, 'requested');
});
test('无组任务分别开窗，特殊字符只作为数据传递', (t) => {
  const { ctx, meta } = fixture(t);
  const opts = { platform: 'win32', launch: () => {} };
  assert.equal(openAutoWatch(ctx, { ...meta, group: null }, opts).status, 'requested');
  assert.equal(openAutoWatch(ctx, { ...meta, group: null, id: 'other' }, opts).status, 'requested');
  const payload = { group: "x'; Write-Host unexpected; #", root: 'C:/路径 with spaces' };
  const script = windowsLaunchScript(payload);
  assert.ok(!script.includes(payload.group));
  assert.match(script, /-WindowStyle Normal/);
  assert.match(script, /-NoExit/);
});
