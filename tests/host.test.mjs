import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, ROOT } from './helpers.mjs';

test('Codex 主控默认配置独立，不自动配置外部模型', async (t) => {
  const h = sandbox(t, { config: false });
  const result = await h.bridge(['config']);
  assert.equal(result.code, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.deepEqual(data.effective.agents, {});
  assert.equal(data.effective.levels.run.normal, 'codex host');
  assert.equal(data.effective.dispatch.auto, false);
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
