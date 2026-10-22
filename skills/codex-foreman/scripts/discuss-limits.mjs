import fs from 'node:fs';
import path from 'node:path';

// These limits govern pi file tools, not its preloaded instructions or session history.
export function discussionPolicy(ctx, files = []) {
  const root = fs.realpathSync.native(ctx.cwd);
  const scopes = [...(ctx.opts.scope || []), ...files.map((f) => f.path)].map((value) => {
    const target = fs.realpathSync.native(path.resolve(root, value));
    const rel = path.relative(root, target);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`讨论读取范围不能超出项目目录：${value}`);
    return target;
  });
  const budget = (option, field) => {
    const raw = ctx.opts[option];
    if (raw == null) {
      const previous = ctx.previousDiscussionLimits?.[field.replace('discuss_', '')];
      const value = previous === undefined ? ctx.cfg.dispatch[field] : previous;
      const cap = ctx.cfg.discussionProjectLimits?.[field];
      return cap == null ? value : value == null ? cap : Math.min(value, cap);
    }
    if (!/^[1-9]\d*$/.test(String(raw)) || !Number.isSafeInteger(Number(raw))) throw new Error(`--${option} 必须是正整数`);
    const value = Number(raw), cap = ctx.cfg.discussionProjectLimits?.[field];
    if (cap != null && value > cap) throw new Error(`--${option} 超出项目上限 ${cap}`);
    return value;
  };
  return { paths: [...new Set(scopes)], max_files: budget('max-files', 'discuss_max_files'),
    max_tool_calls: budget('max-tool-calls', 'discuss_max_tool_calls'), max_rounds: ctx.cfg.dispatch.discuss_max_rounds };
}

export function discussionLimitsPrompt(policy, cwd) {
  const paths = policy.paths.map((p) => path.relative(cwd, p) || '.');
  return `讨论读取预算：${policy.max_files == null ? '文件数量由主控临场指定，本轮未设固定数量上限' : `本轮最多读取 ${policy.max_files} 个不同文件`}，最多 ${policy.max_tool_calls} 次工具调用；讨论最多 ${policy.max_rounds} 轮（包括失败或中止的尝试）。\n`
    + (paths.length ? `只能读取以下明确范围：${paths.join('、')}。grep 只能针对单个文件；目录遍历请使用 find/ls，再读取相关文件。\n`
      : '本轮未指定 --scope/--file，仅依据议题提供的材料分析，不提供文件工具。\n')
    + '范围或预算不足时停止，由主控决定是否调整范围或上限后继续。独立提出观点，不要求主控先提供其独立判断。\n'
    + '能力边界：工具守卫不限制 pi 自动预载的 AGENTS.md/CLAUDE.md、已有会话上下文或模型内部推理；这些预算不是操作系统沙箱。';
}
