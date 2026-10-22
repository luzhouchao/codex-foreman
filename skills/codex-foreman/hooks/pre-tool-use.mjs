import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callsAgentDirectly } from './command-policy.mjs';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
try {
  const event = JSON.parse(raw);
  if (event.hook_event_name !== 'PreToolUse' || !['Bash', 'PowerShell', 'exec_command', 'shell', 'shell_command'].includes(event.tool_name)) process.exit(0);
  const command = event.tool_input?.command ?? event.tool_input?.cmd;
  if (typeof command !== 'string' || !callsAgentDirectly(command)) process.exit(0);
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/cli.mjs');
  console.log(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: `Codex Foreman：请通过 node "${cli}" <run|discuss|review|resume> 调度外部模型，以保留任务范围、日志与验收记录。版本、模型列表和登录管理命令可直接运行。若用户确实需要直接调用，可在 /hooks 禁用此钩子；不要改变权限或伪装命令规避。`,
  } }));
} catch { process.exitCode = 1; console.error('Codex Foreman: invalid PreToolUse input'); }
