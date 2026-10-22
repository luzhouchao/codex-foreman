import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, ROOT, baseConfig, output, taskArgs } from './helpers.mjs';

test('Codex 主控默认配置独立，不自动配置外部模型', async (t) => {
  const h = sandbox(t, { config: false });
  const result = await h.bridge(['config']);
  assert.equal(result.code, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.deepEqual(data.effective.agents, {});
  assert.equal(data.effective.levels.run.normal, 'codex host');
  assert.equal(data.effective.dispatch.auto, false);
});

test('相对记录目录锚定主工作区，跨执行目录可查询与续接', async (t) => {
  const h = sandbox(t);
  h.initGit();
  const cfg = baseConfig(); cfg.dispatch.runs_dir = '.codex/foreman/runs'; h.config(cfg);
  const run = output(await h.bridge(taskArgs(h, 'run', ['--workspace', h.cwd]), { input: '合成任务' }));
  const root = path.join(h.cwd, '.codex/foreman/runs');
  assert.equal(path.dirname(run.run_dir), root);
  assert.ok(fs.existsSync(path.join(run.run_dir, 'result.json')));
  assert.ok(run.changes.files.every((file) => !file.path.replaceAll('\\', '/').startsWith('.codex/foreman/runs/')));
  const status = output(await h.bridge(['status', '--workspace', h.cwd, '--run', run.run_id], { cwd: h.home }));
  assert.equal(status.run_id, run.run_id);
  const resume = output(await h.bridge(['resume', '--workspace', h.cwd, '--run', run.run_id, '--level', 'complex', '--brief', '-'], { cwd: h.home, input: '继续' }));
  assert.equal(path.dirname(resume.run_dir), root);
  const launch = await h.start(path.join(root, 'watch.mjs'), ['--run', run.run_id], { cwd: h.home }).done;
  assert.equal(launch.code, 0, launch.stderr);
});

test('主工作区可以由环境指定，绝对记录路径保持兼容', async (t) => {
  const h = sandbox(t); const cfg = baseConfig();
  cfg.dispatch.runs_dir = '.codex/foreman/runs'; h.config(cfg);
  assert.equal(output(await h.bridge(['config'], { cwd: h.home, env: { CODEX_FOREMAN_WORKSPACE: h.cwd } })).runs_dir, path.join(h.cwd, cfg.dispatch.runs_dir));
  cfg.dispatch.runs_dir = h.runs; h.config(cfg);
  assert.equal(output(await h.bridge(['config', '--workspace', h.cwd])).runs_dir, h.runs);
});

test('安装技能与钩子保留原定义、备份且拒绝覆盖已安装技能', async (t) => {
  const h = sandbox(t);
  const home = path.join(h.home, '.codex');
  const hookFile = path.join(home, 'hooks.json');
  const original = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-hook' }] }] } };
  fs.writeFileSync(hookFile, JSON.stringify(original));
  const installer = path.join(ROOT, 'tools/install.mjs');
  const result = await h.start(installer, ['--hooks']).done;
  assert.equal(result.code, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(home, 'skills/codex-foreman/SKILL.md')));
  assert.deepEqual(JSON.parse(fs.readFileSync(hookFile)).hooks.Stop, original.hooks.Stop);
  assert.equal(fs.readdirSync(home).filter((name) => /^hooks.json.\d+.bak$/.test(name)).length, 1);
  const before = fs.readFileSync(hookFile, 'utf8');
  assert.notEqual((await h.start(installer, ['--hooks']).done).code, 0);
  assert.equal(fs.readFileSync(hookFile, 'utf8'), before);
});
