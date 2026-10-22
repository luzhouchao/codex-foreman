import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, ROOT, write, poll } from './helpers.mjs';
import { setTimeout as pause } from 'node:timers/promises';
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

test('失败、超时和需要输入的讨论保留窗口并展示原因', async (t) => {
  await Promise.all(['failed', 'timeout', 'needs_input', 'cancelled'].map(async (status) => {
    const h = sandbox(t);
    const dir = path.join(h.runs, 'issue');
    write(path.join(dir, 'meta.json'), { id: 'issue', mode: 'discuss', kind: 'discuss', status, cwd: h.cwd, started_at: new Date().toISOString(), host_session: 'test-session' });
    write(path.join(dir, 'result.json'), { status, errors: ['synthetic reason'] });
    const lease = path.join(h.runs, 'lease.json');
    write(lease, { token: status });
    const payload = { lease, token: status, ready: path.join(dir, 'ready.json'), root: h.runs, run: 'issue', session: 'test-session', autoClose: true };
    const viewer = h.start(path.join(ROOT, 'skills/codex-foreman/scripts/watch-window.mjs'), [Buffer.from(JSON.stringify(payload)).toString('base64')]);
    await poll(() => viewer.stdout.includes('窗口已保留'), status);
    assert.equal(viewer.child.exitCode, null);
    assert.match(viewer.stdout, /synthetic reason/);
    assert.equal(fs.existsSync(path.join(dir, 'cancel')), false);
    viewer.stop();
    await viewer.done;
  }));
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

test('讨论、执行及对应续接自动关闭，审查保留窗口', (t) => {
  const { ctx, meta } = fixture(t);
  for (const [mode, kind, autoClose] of [['discuss', 'discuss', true], ['resume', 'discuss', true], ['run', 'exec', true], ['review', 'review', false], ['resume', 'exec', true]]) {
    let payload;
    openAutoWatch(ctx, { ...meta, id: `${mode}-${kind}`, group: null, mode, kind }, { platform: 'win32', launch: (p) => { payload = p; } });
    assert.equal(payload.kind, kind);
    assert.equal(payload.autoClose, autoClose);
    assert.equal(windowsLaunchScript(payload).includes('-NoExit'), !autoClose);
  }
});

test('自动讨论查看器等待同会话整组结束，自然退出且不取消任务', async (t) => {
  const h = sandbox(t);
  const task = (id, status, session = 'test-session') => write(path.join(h.runs, id, 'meta.json'), {
    id, kind: 'discuss', mode: 'discuss', group: 'discussion', host_session: session,
    status, pid: process.pid, cwd: h.cwd, started_at: new Date().toISOString(), model: 'synthetic',
  });
  task('first', 'running'); task('second', 'running'); task('other-session', 'running', 'other');
  const lease = path.join(h.runs, 'lease.json');
  write(lease, { token: 'synthetic' });
  const ready = path.join(h.runs, 'ready.json');
  const payload = { lease, token: 'synthetic', ready, root: h.runs, run: 'first', group: 'discussion', session: 'test-session', kind: 'discuss', autoClose: true };
  const viewer = h.start(path.join(ROOT, 'skills/codex-foreman/scripts/watch-window.mjs'), [Buffer.from(JSON.stringify(payload)).toString('base64')]);
  await poll(() => fs.existsSync(ready), '查看器启动');
  task('first', 'done');
  await pause(6100); // 超过已有的 5 秒组登记稳定期，第二个任务仍在运行。
  assert.equal(viewer.child.exitCode, null);
  task('second', 'done');
  const result = await viewer.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(lease), false);
  for (const id of ['first', 'second', 'other-session']) assert.equal(fs.existsSync(path.join(h.runs, id, 'cancel')), false);
});

for (const mode of ['run', 'resume']) {
  test(`自动执行查看器 ${mode} 正常完成后自然退出`, async (t) => {
    const h = sandbox(t);
    const dir = path.join(h.runs, 'execution');
    write(path.join(dir, 'meta.json'), { id: 'execution', mode, kind: 'exec', status: 'done', cwd: h.cwd, started_at: new Date().toISOString(), host_session: 'test-session' });
    write(path.join(dir, 'result.json'), { status: 'done', needs_decision: false });
    const lease = path.join(h.runs, 'lease.json');
    write(lease, { token: 'execution' });
    const payload = { lease, token: 'execution', ready: path.join(dir, 'ready.json'), root: h.runs, run: 'execution', session: 'test-session', kind: 'exec', autoClose: true };
    const viewer = h.start(path.join(ROOT, 'skills/codex-foreman/scripts/watch-window.mjs'), [Buffer.from(JSON.stringify(payload)).toString('base64')]);
    const result = await viewer.done;
    assert.equal(result.code, 0, result.stderr);
    assert.match(viewer.stdout, /同组任务正常完成后自动关闭/);
    assert.equal(fs.existsSync(lease), false);
    assert.equal(fs.existsSync(path.join(dir, 'cancel')), false);
  });

  test(`自动执行查看器 ${mode} 异常或需要处理时保留窗口`, async (t) => {
    await Promise.all(['failed', 'timeout', 'cancelled', 'needs_input', 'needs_decision'].map(async (outcome) => {
      const h = sandbox(t);
      const dir = path.join(h.runs, 'execution');
      const status = outcome === 'needs_decision' ? 'done' : outcome;
      write(path.join(dir, 'meta.json'), { id: 'execution', mode, kind: 'exec', status, cwd: h.cwd, started_at: new Date().toISOString(), host_session: 'test-session' });
      write(path.join(dir, 'result.json'), { status, needs_decision: outcome === 'needs_decision', errors: ['execution needs attention'] });
      const lease = path.join(h.runs, 'lease.json');
      write(lease, { token: outcome });
      const payload = { lease, token: outcome, ready: path.join(dir, 'ready.json'), root: h.runs, run: 'execution', session: 'test-session', kind: 'exec', autoClose: true };
      const viewer = h.start(path.join(ROOT, 'skills/codex-foreman/scripts/watch-window.mjs'), [Buffer.from(JSON.stringify(payload)).toString('base64')]);
      await poll(() => viewer.stdout.includes('任务需要处理，窗口已保留'), outcome);
      assert.equal(viewer.child.exitCode, null);
      assert.match(viewer.stdout, /execution needs attention/);
      assert.equal(fs.existsSync(path.join(dir, 'cancel')), false);
      viewer.stop();
      await viewer.done;
    }));
  });
}
