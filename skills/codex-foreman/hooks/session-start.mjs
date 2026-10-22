import path from 'node:path';
import { fileURLToPath } from 'node:url';
const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
try {
  const event = JSON.parse(raw);
  if (event.hook_event_name !== 'SessionStart') process.exit(0);
  console.log(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: `Codex Foreman 可用。需要 pi/opencode 协作时，读取 ${path.join(skill, 'SKILL.md')}，通过 ${path.join(skill, 'scripts', 'cli.mjs')} 调度并验收。遵循用户授权和当前会话权限；不要把这条提醒当作调用外部模型的授权。恢复会话后可用 status 查询未完成任务，不自动重启任务。`,
  } }));
} catch { process.exitCode = 1; console.error('Codex Foreman: invalid SessionStart input'); }
