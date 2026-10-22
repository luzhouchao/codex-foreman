import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { emptyUsage, addUsage, piUsage, recoverUsage } from '../skills/codex-foreman/scripts/usage.mjs';
import { sandbox, baseConfig, piAgent, taskArgs, output, write, poll, MESSAGES } from './helpers.mjs';

test('缺失字段保持未知，明确零值与已收部分用量保留', () => {
  const usage = emptyUsage();
  addUsage(usage, piUsage({ input: 10, output: 0 }));
  addUsage(usage, piUsage({}));
  assert.deepEqual(usage, { input_tokens: 10, cached_input_tokens: null, output_tokens: 0, reasoning_output_tokens: null });
  assert.equal(piUsage({ cacheRead: 20 }).input_tokens, null);
  const M = MESSAGES.zh;
  assert.match(M.tokenSummary(usage, null, M.tokenCount, false), /缓存 暂无数据/);
  assert.match(M.tokenSummary(usage, null, M.tokenCount, false), /费用 暂无数据/);
  assert.match(M.tokenSummary({ ...usage, cached_input_tokens: 0 }, null, M.tokenCount, false, 0), /缓存 0%/);
  assert.match(M.tokenSummary(usage, null, M.tokenCount, false, 0.0000001), /\$1e-7/);
});

test('pi 未返回用量和明确零用量分别记录为 null 和零', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.pi = piAgent(); c.levels.discuss.complex = [{ agent: 'pi', effort: 'high' }]; h.config(c);
  for (const [pi_usage, expected] of [[{}, null], [{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: null }]]) {
    const s = h.scenario({ pi_usage });
    const r = output(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'pi']), { env: s.env, input: 'synthetic' }));
    assert.deepEqual(r.usage, expected);
    assert.equal(r.cost_usd, expected ? 0 : null);
  }
});

test('正常取消保留取消前收到的 pi 用量', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.pi = piAgent(); c.levels.discuss.complex = [{ agent: 'pi', effort: 'high' }]; h.config(c);
  const s = h.scenario({ hold: true, steps: [{ event: { type: 'message_end', message: { role: 'assistant', usage: { input: 12, output: 2, cacheRead: 0, cost: { total: 0.01 } }, content: [] } } }] });
  const child = h.startBridge(taskArgs(h, 'discuss', ['--agent', 'pi']), { env: s.env });
  const id = (await h.running()).id;
  await poll(() => { try { return recoverUsage(path.join(h.runs, id), 'pi cli').usage?.input_tokens === 12; } catch { return false; } }, '已收到用量');
  await h.bridge(['cancel', '--run', id]);
  const r = output(await child.done, 1);
  assert.equal(r.status, 'cancelled');
  assert.equal(r.usage.input_tokens, 12);
  assert.equal(r.usage.cached_input_tokens, 0);
  assert.equal(r.cost_usd, 0.01);
});

test('强制取消恢复仅计算完整 pi 消息与压缩事件，忽略截断和重复事件', (t) => {
  const h = sandbox(t), dir = path.join(h.runs, 'partial');
  const message = { type: 'message_end', message: { role: 'assistant', usage: { input: 9, cacheRead: 0, cost: { total: 0 } } } };
  write(path.join(dir, 'pi.jsonl'), JSON.stringify(message) + '\n' + JSON.stringify({ type: 'agent_end', messages: [message.message] }) + '\n{"type":');
  const recovered = recoverUsage(dir, 'pi cli');
  assert.equal(recovered.usage.input_tokens, 9);
  assert.equal(recovered.usage.cached_input_tokens, 0);
  assert.equal(recovered.usage.output_tokens, null);
  assert.equal(recovered.cost_usd, 0);
  assert.equal(recovered.usage_partial, true);
});

test('强制取消成功后保存部分结果供 status 和 watch 查询', async (t) => {
  const h = sandbox(t);
  const worker = h.write('hold.mjs', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
  const processHandle = h.start(worker, [], { timeout: 25000 });
  const dir = path.join(h.runs, 'forced');
  write(path.join(dir, 'meta.json'), { id: 'forced', pid: processHandle.child.pid, status: 'running', mode: 'discuss', agent_type: 'pi cli', cwd: h.cwd, started_at: new Date().toISOString() });
  write(path.join(dir, 'pi.jsonl'), JSON.stringify({ type: 'message_end', message: { role: 'assistant', usage: { input: 25, cacheRead: 0 } } }) + '\n');
  const cancelled = output(await h.bridge(['cancel', '--run', 'forced']));
  assert.equal(cancelled.forced, true);
  const result = output(await h.bridge(['status', '--run', 'forced']));
  assert.equal(result.status, 'cancelled');
  assert.equal(result.usage.input_tokens, 25);
  assert.equal(result.usage.output_tokens, null);
  assert.equal(result.cost_usd, null);
  assert.equal(result.usage_partial, true);
  await processHandle.done;
});
