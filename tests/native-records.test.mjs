import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeNativeRecord, validateNativeRecord, cmdNativeRecord } from '../skills/codex-foreman/scripts/native-records.mjs';
import { sandbox, output } from './helpers.mjs';
const sample = () => ({ task_id: 'task-1', agent_id: 'real-agent-id', model: 'gpt-6.1-sol', scope: ['src/'], artifacts: [], tests: [], acceptance: ['主控检查 diff'], status: 'running', status_source: '主控收到派发工具返回' });
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-record-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
test('保存和替换主控记录，包含真实来源且无用量伪造', t => {
  const dir = temp(t), first = writeNativeRecord(dir, sample());
  const next = writeNativeRecord(dir, { ...sample(), status: 'completed', tests: ['node --test: passed'], status_source: '主控收到完成报告并验收' });
  assert.equal(first.record_file, next.record_file);
  assert.equal(JSON.parse(fs.readFileSync(next.record_file)).status, 'completed');
  assert.equal(next.provenance, 'host_reported');
  assert.equal('usage' in next, false);
  assert.deepEqual(fs.readdirSync(path.dirname(next.record_file)), ['task-1.json']);
});
test('校验必填字段、状态、未知字段和路径穿越', () => {
  for (const update of [{ task_id: '../escape' }, { agent_id: '' }, { status: 'done' }, { usage: 0 }, { tests: 'passed' }, { status_source: '' }]) assert.throws(() => validateNativeRecord({ ...sample(), ...update }));
});
test('拒绝链接目录逃逸', t => {
  const dir = temp(t), outside = temp(t);
  fs.mkdirSync(path.join(dir, '.codex'));
  fs.symlinkSync(outside, path.join(dir, '.codex', 'foreman'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => writeNativeRecord(dir, sample()), /普通目录/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
test('命令读取输入文件且 workspace 与 cwd 无关', t => {
  const dir = temp(t), input = path.join(temp(t), 'task.json');
  fs.writeFileSync(input, '\uFEFF' + JSON.stringify(sample()));
  assert.ok(cmdNativeRecord({ workspace: dir, input }).record_file.startsWith(dir));
});
test('真实 CLI JSON stdout、显式 workspace 优先且同任务可更新', async t => {
  const h = sandbox(t), workspace = temp(t), input = path.join(h.home, 'task.json');
  fs.writeFileSync(input, JSON.stringify(sample()));
  const args = ['native-record', '--input', input, '--workspace', workspace];
  const first = output(await h.bridge(args, { cwd: h.home, env: { CODEX_FOREMAN_WORKSPACE: h.cwd } }));
  assert.equal(first.record_file, path.join(workspace, '.codex', 'foreman', 'native-tasks', 'task-1.json'));
  fs.writeFileSync(input, JSON.stringify({ ...sample(), status: 'completed', status_source: '主控收到完成报告并验收' }));
  const next = output(await h.bridge(args, { cwd: h.home }));
  assert.equal(next.status, 'completed');
  assert.equal(JSON.parse(fs.readFileSync(first.record_file)).status, 'completed');
  assert.equal(fs.existsSync(path.join(h.home, '.codex', 'foreman', 'native-tasks')), false);
});
