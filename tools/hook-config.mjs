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
  if (existing.hooks !== undefined && (!existing.hooks || typeof existing.hooks !== 'object' || Array.isArray(existing.hooks))) throw new Error('现有 hooks 字段必须是对象');
  const hooks = { ...(existing.hooks || {}) };
  for (const [event, groups] of Object.entries(added.hooks)) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) throw new Error(`现有 ${event} 格式无效`);
    const names = event === 'SessionStart' ? ['session-start.mjs'] : event === 'PreToolUse' ? ['pre-tool-use.mjs'] : [];
    const own = (hook) => {
      if (hook?.type !== 'command' || typeof hook.command !== 'string') return false;
      let command = hook.command;
      const encoded = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/i);
      if (encoded) command = Buffer.from(encoded[1], 'base64').toString('utf16le');
      return names.some((name) => command.replaceAll('\\', '/').includes(`/codex-foreman/hooks/${name}`));
    };
    // Remove only our command, including from a group shared with user hooks.
    hooks[event] = (hooks[event] || []).map((group) => {
      if (!Array.isArray(group?.hooks)) return group;
      const remaining = group.hooks.filter((hook) => !own(hook));
      if (remaining.length === group.hooks.length) return group;
      return remaining.length ? { ...group, hooks: remaining } : null;
    }).filter(Boolean);
    for (const group of groups) {
      if (!hooks[event].some((g) => JSON.stringify(g) === JSON.stringify(group))) hooks[event].push(group);
    }
  }
  return { ...existing, hooks };
}
