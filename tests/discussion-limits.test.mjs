import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import guard from '../skills/codex-foreman/scripts/adapters/pi-guard.mjs';
import { discussionPolicy } from '../skills/codex-foreman/scripts/discuss-limits.mjs';
import { sandbox, baseConfig, piAgent, taskArgs, output, failed, read } from './helpers.mjs';

function setup(t, dispatch = {}) {
  const h = sandbox(t), c = baseConfig();
  c.agents.pi = piAgent();
  c.levels.discuss.complex = [{ agent: 'pi' }];
  Object.assign(c.dispatch, dispatch);
  h.config(c);
  h.write('src/a.txt', 'a'); h.write('src/b.txt', 'b'); h.write('outside.txt', 'outside');
  return h;
}

function handler(root, discussion) {
  const saved = process.env.CODEX_FOREMAN_PI_GUARD;
  process.env.CODEX_FOREMAN_PI_GUARD = JSON.stringify({ root, access: 'read', discussion });
  let call;
  guard({ on: (name, fn) => { if (name === 'tool_call') call = fn; } });
  if (saved === undefined) delete process.env.CODEX_FOREMAN_PI_GUARD;
  else process.env.CODEX_FOREMAN_PI_GUARD = saved;
  return (toolName, input = {}) => call({ toolName, input });
}

test('讨论守卫：范围、缺省路径、目录grep与唯一文件预算', async (t) => {
  const h = setup(t), policy = { paths: [path.join(h.cwd, 'src')], max_files: 1, max_tool_calls: 24 };
  let call = handler(h.cwd, policy);
  assert.equal(await call('read', { path: 'src/a.txt' }), undefined);
  assert.equal(await call('read', { path: 'src/a.txt', offset: 2 }), undefined);
  assert.match((await call('read', { path: 'src/b.txt' })).reason, /file budget/);
  call = handler(h.cwd, policy);
  assert.match((await call('ls')).reason, /scope/);
  assert.match((await call('read', { path: 'outside.txt' })).reason, /scope/);
  assert.match((await call('grep', { path: 'src', pattern: 'a' })).reason, /explicit file/);
  assert.equal(await call('find', { path: 'src', pattern: '*.txt' }), undefined);
});

test('讨论守卫：所有工具尝试计入预算，超限前禁止执行', async (t) => {
  const h = setup(t);
  const call = handler(h.cwd, { paths: [h.cwd], max_files: 12, max_tool_calls: 1 });
  assert.equal(await call('ls'), undefined);
  assert.match((await call('read', { path: 'src/a.txt' })).reason, /tool-call budget/);
});

test('pi讨论：无范围只分析brief；显式范围与预算落盘', async (t) => {
  const h = setup(t), s = h.scenario({});
  const r = output(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'pi']), { env: s.env, input: '分析这些材料' }));
  const call = s.calls().find((c) => c.operation === 'run');
  assert.ok(call.args.includes('--no-tools'));
  assert.ok(call.stdin.includes('未指定 --scope/--file'));
  const meta = JSON.parse(read(path.join(r.run_dir, 'meta.json')));
  assert.deepEqual(meta.discussion_limits, { paths: [], max_files: null, max_tool_calls: 24, max_rounds: 2 });
  assert.ok(call.stdin.includes('自动预载'));
});

test('pi讨论：守卫拒绝立刻交主控，记录原因，不做格式修复重试', async (t) => {
  const h = setup(t), s = h.scenario({ hold: true, steps: [
    { event: { type: 'tool_execution_start', toolCallId: 'x', toolName: 'read', args: { path: 'outside.txt' } } },
    { event: { type: 'tool_execution_end', toolCallId: 'x', toolName: 'read', isError: true,
      result: { content: [{ type: 'text', text: 'foreman guard: path is outside the discussion scope; dispatcher decision required' }] } } },
  ] });
  const result = await h.bridge(taskArgs(h, 'discuss', ['--agent', 'pi', '--scope', 'src']), { env: s.env, input: '分析' });
  const r = output(result, 1);
  assert.equal(r.status, 'needs_input');
  assert.equal(s.calls().filter((c) => c.operation === 'run').length, 1);
  assert.match(JSON.parse(read(path.join(r.run_dir, 'meta.json'))).discussion_stop_reason, /dispatcher decision/);
  assert.ok(r.questions.some((q) => q.source === 'discussion_limit'));
});

test('讨论配置：项目只能收紧预算，非法用户预算拒绝', async (t) => {
  const h = setup(t);
  h.write('.codex/foreman.json', JSON.stringify({ dispatch: { discuss_max_files: 3, discuss_max_tool_calls: 100, discuss_max_rounds: 1 } }));
  const config = output(await h.bridge(['config', '--cwd', h.cwd]));
  const effective = config.effective;
  // Config output's dispatch is the effective public config.
  assert.equal(effective.dispatch.discuss_max_files, 3);
  assert.equal(effective.dispatch.discuss_max_tool_calls, 24);
  assert.equal(effective.dispatch.discuss_max_rounds, 1);
  const bad = baseConfig(); bad.dispatch.discuss_max_files = 0; h.config(bad);
  failed(await h.bridge(['config']), 'dispatch.discuss_max_files');
});

test('讨论临场预算：指定文件数和工具数，项目上限仍生效，错误值不启动模型', async (t) => {
  const h = setup(t), cfg = { dispatch: { discuss_max_files: null, discuss_max_tool_calls: 24, discuss_max_rounds: 2 } };
  const ctx = { cwd: h.cwd, cfg, opts: { scope: ['src'], 'max-files': '40', 'max-tool-calls': '60' } };
  assert.equal(discussionPolicy(ctx).max_files, 40);
  assert.equal(discussionPolicy(ctx).max_tool_calls, 60);
  const resumed = { ...ctx, opts: { scope: ['src'] }, previousDiscussionLimits: { max_files: 7, max_tool_calls: 8 } };
  assert.equal(discussionPolicy(resumed).max_files, 7);
  assert.equal(discussionPolicy(resumed).max_tool_calls, 8);
  cfg.discussionProjectLimits = { discuss_max_tool_calls: 10 };
  assert.throws(() => discussionPolicy(ctx), /项目上限/);
  cfg.discussionProjectLimits.discuss_max_files = 4;
  assert.equal(discussionPolicy(resumed).max_files, 4);
  ctx.opts['max-files'] = '3';
  ctx.opts['max-tool-calls'] = '0';
  assert.throws(() => discussionPolicy(ctx), /正整数/);
  const s = h.scenario({});
  failed(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'pi', '--max-files', '0']), { env: s.env, input: '分析' }), '--max-files');
  assert.equal(s.calls().filter((c) => c.operation === 'run').length, 0);
});

test('pi讨论续接继承主控临场文件数与工具数', async (t) => {
  const h = setup(t), s = h.scenario({});
  const first = output(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'pi', '--scope', 'src', '--max-files', '30', '--max-tool-calls', '40']), { env: s.env, input: '分析' }));
  const next = output(await h.bridge(['resume', '--run', first.run_id, '--brief', '-', '--level', 'complex'], { env: s.env, input: '继续核对' }));
  const limits = JSON.parse(read(path.join(next.run_dir, 'meta.json'))).discussion_limits;
  assert.equal(limits.max_files, 30);
  assert.equal(limits.max_tool_calls, 40);
  assert.deepEqual(limits.paths, [path.join(h.cwd, 'src')]);
});

test('讨论轮数：失败中止也计轮数，并使用项目有效上限', async (t) => {
  const h = setup(t), s = h.scenario({});
  h.write('.codex/foreman.json', JSON.stringify({ dispatch: { discuss_max_rounds: 1 } }));
  const r = output(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'pi']), { env: s.env, input: '分析' }));
  const metaPath = path.join(r.run_dir, 'meta.json'), meta = JSON.parse(read(metaPath));
  meta.status = 'needs_input'; fs.writeFileSync(metaPath, JSON.stringify(meta));
  failed(await h.bridge(['resume', '--run', r.run_id, '--brief', '-', '--level', 'complex'], { env: s.env, input: '继续' }), '1');
  assert.equal(s.calls().filter((c) => c.operation === 'run').length, 1);
});
