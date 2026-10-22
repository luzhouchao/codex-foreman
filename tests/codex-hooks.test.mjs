import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildHooks, mergeHooks } from '../tools/hook-config.mjs';
const hook = (name, input) => spawnSync(process.execPath, [fileURLToPath(new URL(`../skills/codex-foreman/hooks/${name}.mjs`, import.meta.url))], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
test('Codex SessionStart 返回上下文，不授权自动派活', () => {
  const r = hook('session-start', { hook_event_name: 'SessionStart', source: 'compact' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /不要把这条提醒/);
});
test('Codex Bash 和 exec_command 拒绝直接 pi 模型调用', () => {
  for (const tool_name of ['Bash', 'exec_command']) for (const command of ['pi -p "hi"', 'node "C:/pi web/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" --mode json "hi"', 'opencode run "hi"', 'codex exec "hi"']) {
    const r = hook('pre-tool-use', { hook_event_name: 'PreToolUse', tool_name, tool_input: { command } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  }
});
test('查询、调度器和普通文字不被拦截，apply_patch 不当作 shell', () => {
  for (const command of ['pi --list-models', 'pi auth check', 'node "C:/skill/scripts/cli.mjs" run --level normal', 'echo "pi -p hi"', 'git status']) {
    const r = hook('pre-tool-use', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
    assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, '');
  }
  assert.equal(hook('pre-tool-use', { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: 'pi hi' } }).stdout, '');
});
test('合并保留已有钩子且重复安装幂等', () => {
  const original = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing' }] }] } };
  const added = buildHooks('C:/skill with space', 'C:/Program Files/nodejs/node.exe', 'win32');
  const merged = mergeHooks(original, added);
  assert.deepEqual(merged.hooks.Stop, original.hooks.Stop);
  assert.deepEqual(mergeHooks(merged, added), merged);
  assert.match(merged.hooks.PreToolUse[0].hooks[0].command, /^powershell.exe -NoProfile -NonInteractive -EncodedCommand /);
});
