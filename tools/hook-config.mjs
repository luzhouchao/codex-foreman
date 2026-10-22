import path from 'node:path';
export function buildHooks(skill, node = process.execPath, platform = process.platform) {
  const command = (name) => {
    const script = path.join(skill, 'hooks', name).replaceAll('\\', '/');
    const executable = node.replaceAll('\\', '/');
    // Hook commands use the host shell. PowerShell requires & for a quoted executable.
    if (platform === 'win32') {
      const ps = `& '${executable.replaceAll("'", "''")}' '${script.replaceAll("'", "''")}'`;
      return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`;
    }
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    return `${quote(executable)} ${quote(script)}`;
  };
  return { description: 'Codex Foreman：会话提醒和外部模型调度约束', hooks: {
    SessionStart: [{ matcher: 'startup|resume|clear|compact|fork', hooks: [{ type: 'command', command: command('session-start.mjs'), timeout: 5, statusMessage: 'Codex Foreman：加载协作提醒' }] }],
    PreToolUse: [{ matcher: '^(Bash|PowerShell|exec_command|shell|shell_command)$', hooks: [{ type: 'command', command: command('pre-tool-use.mjs'), timeout: 5, statusMessage: 'Codex Foreman：检查调度入口' }] }],
  } };
}
export function mergeHooks(existing, added) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('现有 hooks.json 必须是对象');
  const hooks = { ...(existing.hooks || {}) };
  for (const [event, groups] of Object.entries(added.hooks)) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) throw new Error(`现有 ${event} 格式无效`);
    hooks[event] = [...(hooks[event] || [])];
    for (const group of groups) {
      if (!hooks[event].some((g) => JSON.stringify(g) === JSON.stringify(group))) hooks[event].push(group);
    }
  }
  return { ...existing, hooks };
}
