import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, baseConfig, taskArgs, output, read, ROOT, poll } from './helpers.mjs';
import { report, discussion } from './fixtures/reports.mjs';

const BIN = path.join(ROOT, 'tests/fake/antigravity.mjs');
const configure = (h, extra = {}, change = () => {}) => {
  const c = baseConfig();
  c.agents.agy = { type: 'antigravity cli', bin: BIN, model: 'fake-model', ...extra };
  c.levels.discuss.complex = [{ agent: 'agy' }];
  change(c); h.config(c); return c;
};
const runs = (s) => s.calls().filter((c) => c.operation === 'run');
const discuss = (h, s, extra = []) => h.bridge(taskArgs(h, 'discuss', ['--agent', 'agy', ...extra]), { env: s.env, input: '合成议题' });
const arg = (call, name) => call.args[call.args.indexOf(name) + 1];

test('Antigravity models/check：读取版本和目录，不发起真实或合成推理', async (t) => {
  const h = sandbox(t); configure(h); const s = h.scenario();
  const models = output(await h.bridge(['models'], { env: s.env }));
  assert.ok(models.tools['antigravity cli'].models.some((m) => m.id === 'fake-model'));
  assert.equal(models.agents.agy.listed, true);
  const check = output(await h.bridge(['check', '--agent', 'agy'], { env: s.env }));
  assert.equal(check.agents.agy.version, '1.4.5');
  assert.equal(check.agents.agy.model_listed, true);
  assert.equal(runs(s).length, 0);
});

test('Antigravity 结构报告、工作区日志、未知事件、stderr诊断和usage', async (t) => {
  const h = sandbox(t); configure(h);
  const unknown = { type: 'future_event', opaque: { preserved: true } };
  const s = h.scenario({ structured_output: discussion, last_message: '文字回复', stderr: 'synthetic diagnostic\n', steps: [{ event: unknown }] });
  const r = output(await discuss(h, s));
  assert.equal(r.status, 'done'); assert.deepEqual(r.report, discussion);
  assert.equal(r.session_id, 'synthetic-agy-conversation');
  assert.equal(r.usage.input_tokens, 17); assert.equal(r.usage.output_tokens, 5);
  assert.equal(r.usage.cached_input_tokens, 3); assert.equal(r.usage.reasoning_output_tokens, 2);
  assert.equal(r.usage_scope, 'session_total'); assert.equal(r.cost_usd, null);
  const call = runs(s)[0];
  assert.equal(call.cwd, h.cwd); assert.ok(arg(call, '-p').startsWith('合成议题'));
  assert.equal(arg(call, '--output-format'), 'stream-json');
  assert.equal(arg(call, '--mode'), 'plan'); assert.ok(call.args.includes('--print-timeout'));
  assert.equal(call.args.includes('--continue'), false);
  assert.equal(call.args.includes('--dangerously-skip-permissions'), false);
  const log = arg(call, '--log-file'); assert.ok(log.startsWith(r.run_dir + path.sep));
  assert.match(read(log), /synthetic Antigravity log/);
  assert.equal(read(path.join(r.run_dir, 'stderr.log')), 'synthetic diagnostic\n');
  assert.match(read(path.join(r.run_dir, 'antigravity.jsonl')), /future_event/);
  assert.ok(fs.existsSync(arg(call, '--json-schema')));
});

test('Antigravity 显式续接ID，累计usage不按轮次重复相加', async (t) => {
  const h = sandbox(t); configure(h);
  const s = h.scenario({ calls: [{ usage: { input_tokens: 17, output_tokens: 5 } }, { usage: { input_tokens: 30, output_tokens: 9 } }] });
  const first = output(await discuss(h, s));
  const next = output(await h.bridge(['resume', '--run', first.run_id, '--brief', '-', '--level', 'complex'], { env: s.env, input: '继续' }));
  assert.equal(arg(runs(s)[1], '--conversation'), first.session_id);
  assert.equal(next.session_id, first.session_id);
  assert.equal(next.usage.input_tokens, 30); assert.equal(next.usage.output_tokens, 9);
  assert.equal(next.usage_scope, 'session_total');
});

test('Antigravity result用量为会话累计值，重复事件不重复计费，缺失与零值不同', async (t) => {
  const h = sandbox(t); configure(h);
  for (const [usage, expected] of [[{}, null], [{ input_tokens: 0, output_tokens: 0 }, 0], [{ input_tokens: 20, output_tokens: 6 }, 20]]) {
    const s = h.scenario({ usage, steps: [{ event: { event: 'result', result: { conversation_id: 'synthetic-agy-conversation', status: 'SUCCESS', structured_output: discussion, usage } } }] });
    const r = output(await discuss(h, s));
    if (expected === null) assert.equal(r.usage, null);
    else assert.equal(r.usage.input_tokens, expected);
    assert.equal(r.cost_usd, null);
  }
});

test('Antigravity 权限软拒绝退出0也留下待处理问题', async (t) => {
  const h = sandbox(t); configure(h);
  const s = h.scenario({ stderr: 'Permission denied: tool execution requires approval in headless mode\n' });
  const r = output(await discuss(h, s), 1);
  assert.equal(r.status, 'needs_input');
  assert.ok(r.questions.some((q) => q.source === 'permission_denied'));
  assert.match(read(path.join(r.run_dir, 'stderr.log')), /Permission denied/);
});

for (const [name, scenario] of [
  ['非零退出', { exit_code: 7, stderr: 'synthetic broken\n' }],
  ['缺失result', { no_result: true }],
  ['损坏NDJSON', { raw_lines: ['{"type":broken'] }],
  ['错误终态', { status: 'ERROR' }],
]) test(`Antigravity ${name}不能误报完成`, async (t) => {
  const h = sandbox(t); configure(h); const s = h.scenario(scenario);
  const r = output(await discuss(h, s), 1);
  assert.equal(r.status, 'failed'); assert.ok(r.errors.length);
  assert.equal(runs(s).length, 1);
});

test('Antigravity 执行权限必须显式声明，接受shell并记录权限边界', async (t) => {
  const h = sandbox(t); const c = configure(h, {}, (c) => { c.levels.run.complex = { agent: 'agy' }; });
  const missing = await h.bridge(['config']); assert.equal(missing.code, 2);
  c.agents.agy.run_access = 'edit'; h.config(c); assert.equal((await h.bridge(['config'])).code, 2);
  c.agents.agy.run_access = 'shell'; h.config(c);
  const s = h.scenario({ structured_output: report });
  assert.equal((await h.bridge(taskArgs(h, 'run', ['--no-snapshot']), { env: s.env })).code, 2);
  const r = output(await h.bridge(taskArgs(h), { env: s.env }));
  assert.deepEqual(r.report, report); assert.equal(r.run_access, 'shell');
  assert.equal(arg(runs(s)[0], '--mode'), 'accept-edits');
  assert.notEqual(r.isolation, 'sandbox');
});

for (const operation of ['timeout', 'cancel']) test(`Antigravity ${operation}保留已收到的usage和原始事件`, async (t) => {
  const h = sandbox(t); configure(h);
  const s = h.scenario({ hold: true, steps: [{ event: { event: 'step_update', step_update: { usage: { input_tokens: 7, output_tokens: 2 } } } }] });
  let r;
  if (operation === 'timeout') r = output(await discuss(h, s, ['--timeout', '0.02']), 1);
  else {
    const child = h.startBridge(taskArgs(h, 'discuss', ['--agent', 'agy']), { env: s.env });
    const meta = await h.running();
    await poll(() => fs.existsSync(path.join(meta.run_dir ?? path.join(h.runs, meta.id), 'antigravity.jsonl')) && read(path.join(meta.run_dir ?? path.join(h.runs, meta.id), 'antigravity.jsonl')).includes('step_update'), '合成事件已写入');
    assert.equal(output(await h.bridge(['cancel', '--run', meta.id])).status, 'cancelled');
    r = output(await child.done, 1);
  }
  assert.equal(r.status, operation === 'timeout' ? 'timeout' : 'cancelled');
  assert.equal(r.usage.input_tokens, 7); assert.equal(r.usage.output_tokens, 2);
  assert.equal(r.usage_partial, true);
  assert.match(read(path.join(r.run_dir, 'antigravity.jsonl')), /step_update/);
});
