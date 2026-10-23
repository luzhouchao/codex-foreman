import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SCHEMA, DISCUSS_SCHEMA } from '../config.mjs';
import { newRunDir, isCancelled } from '../records.mjs';
import { execute, startRun, finishDiscussion, eventWriter, runLimits, parseReport, validateSchema, spawnCli } from '../runner.mjs';
import { makeTracker } from '../tracker.mjs';
import { amount, hasUsage } from '../usage.mjs';
import { M, die, binCommand, pathCommand, killTree, pidAlive, readAttachments, focusFiles } from '../util.mjs';

const capabilities = { modes: ['run', 'review', 'discuss'], isolation: 'none', reads_code: true, native_schema: true, native_review: false, images: false, resume: true, command_start_events: false };
const efforts = [null, 'low', 'medium', 'high', 'xhigh', 'max'];
const permissionWarning = 'Antigravity 的 mode 和提示词不是操作系统或工具权限隔离；plan 不保证硬只读，工具权限仍由 CLI 本地策略决定。未启用跳过权限。';
function locate(agent = {}) {
  if (agent.bin) return binCommand(agent.bin);
  return pathCommand(process.platform === 'win32' ? 'agy.exe' : 'agy', [process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin') : path.join(os.homedir(), '.local', 'bin')]);
}
export function antigravityUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const usage = { input_tokens: amount(u.input_tokens ?? u.inputTokens ?? u.promptTokenCount), cached_input_tokens: amount(u.cached_input_tokens ?? u.cache_read_tokens ?? u.cachedInputTokens ?? u.cachedContentTokenCount), output_tokens: amount(u.output_tokens ?? u.outputTokens ?? u.candidatesTokenCount), reasoning_output_tokens: amount(u.reasoning_output_tokens ?? u.thinking_tokens ?? u.reasoningTokens ?? u.thoughtsTokenCount) };
  return hasUsage(usage) ? usage : null;
}
const denied = (text) => /permission[^\n]*(?:denied|reject|cannot|could not|not granted|not approved)|(?:denied|reject|cannot|could not)[^\n]*permission|requires? (?:user )?approval|tool[^\n]*(?:auto.?reject|not allowed)/i.test(text);

export function runAntigravity({ agent, args, cwd, timeoutMs, runDir, onEvent }) {
  return new Promise((resolve) => {
    const { file, pre } = locate(agent);
    const out = { code: null, status: null, errors: [], questions: [], messages: [], text: '', result: null, stderrTail: '', usage: null, termination: null };
    let buffer = '', timer, poll;
    const child = spawnCli(file, [...pre, ...args], { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }, {
      onInput: (line) => { out.questions.push({ source: 'input_prompt', question: line }); stop('needs_input'); },
    });
    const stop = (status) => {
      if (out.status) return;
      out.status = status;
      const killed = child.pid ? killTree(child.pid) : true;
      out.termination = { pid: child.pid ?? null, tree_kill_requested: true, kill_succeeded: killed, process_alive: child.pid ? pidAlive(child.pid) : false };
      if (out.termination.process_alive) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* 已退出 */ } }
    };
    const signal = () => stop('cancelled');
    process.once('SIGINT', signal); process.once('SIGTERM', signal);
    const record = (line) => {
      if (!line.trim()) return;
      if (runDir) fs.appendFileSync(path.join(runDir, 'antigravity.jsonl'), line + '\n');
      let ev;
      try { ev = JSON.parse(line); } catch { out.errors.push('Antigravity 输出包含无效 JSON 行。'); return; }
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) { out.errors.push('Antigravity 事件必须为 JSON 对象。'); return; }
      const type = ev.event || ev.type;
      ev = { ...ev, ...(ev[type] && typeof ev[type] === 'object' ? ev[type] : {}), type };
      if (ev.type === 'init' && ev.cwd && path.resolve(ev.cwd).toLowerCase() !== path.resolve(cwd).toLowerCase()) out.errors.push(`Antigravity cwd mismatch: ${ev.cwd}`);
      if (ev.type === 'step_update' && ev.usage) { out.usage = antigravityUsage(ev.usage); out.usage_partial = true; }
      if (ev.type === 'result') {
        out.result = ev;
        out.text = typeof ev.structured_output === 'object' && ev.structured_output !== null ? JSON.stringify(ev.structured_output) : String(ev.response ?? '');
        out.usage = antigravityUsage(ev.usage); // 这是累计快照，不能加上 step_update 或之前的 result。
        out.usage_partial = false;
        out.messages = [out.text];
      }
      if (ev.type === 'error' || ev.error) out.errors.push(typeof ev.error === 'string' ? ev.error : ev.error?.message || ev.message || JSON.stringify(ev));
      if (denied(JSON.stringify(ev))) out.questions.push({ source: 'permission_denied', question: ev.message || 'Antigravity 工具权限被拒绝。', detail: JSON.stringify(ev) });
      onEvent?.(ev);
    };
    child.stdout.on('data', (chunk) => { buffer += chunk; let at; while ((at = buffer.indexOf('\n')) >= 0) { record(buffer.slice(0, at)); buffer = buffer.slice(at + 1); } });
    child.stderr.on('data', (chunk) => { out.stderrTail = (out.stderrTail + chunk).slice(-16000); if (runDir) fs.appendFileSync(path.join(runDir, 'stderr.log'), chunk); });
    child.on('error', (e) => out.errors.push(e.message));
    timer = setTimeout(() => stop('timeout'), Math.max(1, timeoutMs));
    poll = setInterval(() => { if (runDir && isCancelled(runDir)) stop('cancelled'); }, 250);
    child.on('close', (code) => {
      clearTimeout(timer); clearInterval(poll); process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal);
      if (buffer.trim()) record(buffer);
      out.code = code;
      if (out.termination) out.termination.process_alive = child.pid ? pidAlive(child.pid) : false;
      if (denied(out.stderrTail)) out.questions.push({ source: 'permission_denied', question: 'Antigravity 工具权限被软拒绝。', detail: out.stderrTail });
      const status = String(out.result?.status || '').toUpperCase();
      if (!out.result) out.errors.push('Antigravity 未返回终态 result。');
      else if (!['SUCCESS', 'COMPLETED', 'COMPLETE', 'DONE', 'OK'].includes(status)) out.errors.push(`Antigravity result status: ${status || '(missing)'}`);
      if (code !== 0) out.errors.push(`Antigravity exit ${code}: ${out.stderrTail.trim()}`);
      out.status ||= ['CANCELED', 'CANCELLED', 'INTERRUPTED'].includes(status) ? 'cancelled' : out.errors.length ? 'failed' : out.questions.length ? 'needs_input' : 'done';
      resolve(out);
    });
    child.stdin.on('error', () => {}); child.stdin.end();
  });
}

async function session(run, schema) {
  const { ctx, meta, writeMeta, started } = run;
  const { dir, cwd, agent, model, prompt } = ctx;
  const { deadline } = runLimits(ctx, started);
  const event = eventWriter(dir);
  for (const name of ['events.jsonl', 'antigravity.jsonl', 'stderr.log']) fs.writeFileSync(path.join(dir, name), '');
  const mode = agent.agy_mode || (ctx.kind === 'exec' ? 'accept-edits' : 'plan');
  meta.permission_policy = { mode, isolation: 'none', hard_read_only: false, skip_permissions: false };
  meta.native_log_file = path.join(dir, 'antigravity.log'); writeMeta();
  const args = ['-p', prompt, '--output-format', 'stream-json', '--model', model, '--mode', mode, '--print-timeout', `${Math.max(1, Math.ceil((deadline - Date.now()) / 1000))}s`, '--log-file', meta.native_log_file];
  if (ctx.effort) args.push('--effort', ctx.effort);
  if (meta.session_id) args.push('--conversation', meta.session_id);
  if (schema) args.push('--json-schema', ctx.kind === 'exec' ? SCHEMA : DISCUSS_SCHEMA);
  for (const addDir of ctx.addDirs || []) args.push('--add-dir', addDir);
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ args, cwd, permission_policy: meta.permission_policy }, null, 2));
  const out = await runAntigravity({ agent, args, cwd, timeoutMs: deadline - Date.now(), runDir: dir, onEvent: (ev) => {
    if (ev.conversation_id && (ev.type === 'init' || ev.type === 'result')) { meta.session_id = ev.conversation_id; writeMeta(); }
    if (ev.type === 'init') {
      event({ type: 'thread.started', thread_id: ev.conversation_id });
      if (ev.cwd && path.resolve(ev.cwd).toLowerCase() !== path.resolve(cwd).toLowerCase()) event({ type: 'error', message: `Antigravity cwd mismatch: ${ev.cwd}` });
    } else if (ev.type === 'result') event({ type: 'item.completed', item: { type: 'agent_message', text: typeof ev.structured_output === 'object' && ev.structured_output !== null ? JSON.stringify(ev.structured_output) : String(ev.response ?? '') } });
    else event({ type: 'antigravity.step', native_type: ev.type, step: ev });
  } });
  meta.status = out.status; if (out.termination) meta.termination = out.termination; writeMeta();
  fs.writeFileSync(path.join(dir, 'last-message.txt'), out.text);
  const parsed = schema && out.text ? parseReport(out.text, schema, validateSchema) : null;
  return { ...out, usage_scope: 'session_total', cost: null, commands: 0, warnings: parsed?.invalid.length ? ['Antigravity 返回的报告不符合 schema；保留原始回复供主控核查。'] : [], notes: [permissionWarning, '用量按 CLI 最后 result 的累计会话快照展示；不与步骤事件或父任务相加，费用暂无数据。'], report: parsed?.report || null, last: out.text, sessionId: meta.session_id, fileChanges: new Set(), images: [], observed: { messages: out.messages, questions: out.questions } };
}

async function executeAntigravity(ctx) {
  if (ctx.parent && !ctx.sessionId) die(M.noSession(ctx.parent));
  if (ctx.kind === 'exec' && ctx.agent.run_access !== 'shell') die('Antigravity run 必须显式设置 run_access: shell；不支持禁止 shell 的 edit 权限。');
  if (ctx.opts['max-files'] != null || ctx.opts['max-tool-calls'] != null) die('Antigravity 不支持硬工具预算；--max-files/--max-tool-calls 仅 pi 支持。');
  const files = ctx.kind === 'review' ? [] : readAttachments(ctx.opts.file, ctx.cwd, false);
  const schema = ctx.kind === 'review' ? null : JSON.parse(fs.readFileSync(ctx.kind === 'exec' ? SCHEMA : DISCUSS_SCHEMA, 'utf8'));
  let prompt = `${ctx.brief || ''}${focusFiles(files)}\n\n工作目录：${ctx.cwd}\n${permissionWarning}\n`;
  if (ctx.kind !== 'exec') prompt += '只分析和提出建议，不修改文件，不执行会改变状态的命令。\n';
  if (ctx.reviewScope) prompt += `\n审查范围：${ctx.reviewScope.description}\n${ctx.reviewScope.patch}\n`;
  if (ctx.opts.scope?.length) prompt += `\n用户指定关注范围（提示词约束，不是硬权限守卫）：${ctx.opts.scope.join(', ')}\n`;
  if (schema) prompt += `\n最终回复必须符合此 JSON schema：\n${JSON.stringify(schema)}\n`;
  else prompt += `\n${M.reviewFooter}\n`;
  const context = { ...ctx, ...await newRunDir(), prompt };
  if (ctx.kind === 'exec') return execute(context, { capabilities, describe: () => ({ sandbox: null, modelShown: ctx.model, modelName: ctx.model }), run: ({ run }) => session(run, schema) });
  const run = startRun(context);
  fs.writeFileSync(path.join(context.dir, 'brief.md'), prompt);
  let tracker, before, result;
  try { tracker = makeTracker(context.dir, ctx.cwd, []); before = tracker.snap('before'); }
  catch (e) { result = { usage: null, cost: null, errors: [`只读核验快照失败，未启动 Antigravity：${e.message}`], notes: [permissionWarning], warnings: [], report: null, last: '', observed: {} }; run.meta.status = 'failed'; }
  if (!result) {
    try {
      result = await session(run, schema);
      const changes = tracker.diff(before, tracker.snap('after'), path.join(context.dir, 'discussion-changes.patch'));
      if (changes.files.length || changes.large_files_changed.length) { run.meta.status = 'failed'; result.errors.push('Antigravity 分析期间修改了工作区；详见 discussion-changes.patch。'); }
    } catch (e) {
      run.meta.status = 'failed';
      result ||= { usage: null, cost: null, errors: [], notes: [permissionWarning], warnings: [], report: null, last: '', observed: {} };
      result.errors.push(`Antigravity 执行或工作区核验失败：${e.message}`);
    } finally { tracker?.cleanup(); }
  } else tracker?.cleanup();
  return finishDiscussion(run, { ...result, files, usage_scope: 'session_total', changesNote: '已对工作区拍摄前后快照；plan 不是硬只读隔离。' });
}

function catalog(agent = {}) {
  const { file, pre } = locate(agent);
  const r = spawnSync(file, [...pre, 'models'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.error || r.status !== 0) return { ok: false, source: 'agy models', models: [], error: r.error?.message || r.stderr || `exit ${r.status}` };
  const models = (r.stdout || '').split(/\r?\n/).map((line) => /^\s*([\w][\w./:-]*)\s+(?:\t|\()?(.+?)\)?\s*$/.exec(line)).filter((m) => m && !/^(Available|Fetching)$/i.test(m[1])).map((m) => ({ id: m[1], name: m[2], efforts: efforts.filter(Boolean), default_effort: null, context: null, cost: null }));
  return { ok: models.length > 0, source: 'agy models', models, error: models.length ? null : '未能解析 agy models 输出。' };
}
async function check(name, agent, variants = [], getCatalog = () => catalog(agent)) {
  const { file, pre } = locate(agent), started = Date.now();
  const version = spawnSync(file, [...pre, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const cat = version.status === 0 ? getCatalog() : { ok: false, models: [], error: version.error?.message || version.stderr || 'agy --version 失败' };
  const listed = cat.models.some((m) => m.id === agent.model);
  return { ok: version.status === 0 && cat.ok && listed, type: 'antigravity cli', model: agent.model, version: version.stdout?.trim() || null, model_listed: listed, seconds: (Date.now() - started) / 1000, reply: null, error: cat.error || (!listed ? `模型未列出：${agent.model}` : null), fix: null, variants: variants.map((v) => ({ ...v, ok: cat.models.some((m) => m.id === v.model) && (!v.variant || efforts.includes(v.variant)) })), check_scope: 'version_and_catalog_only', inference_verified: false };
}
export default {
  type: 'antigravity cli', capabilities, channel: 'Antigravity CLI', efforts, listModelsArgs: ['models'], locate, catalog, check, execute: executeAntigravity,
  status: (agent) => ({ bin: locate(agent).file, run_access: agent.run_access ?? null, agy_mode: agent.agy_mode ?? null, isolation: 'none' }),
  validate: (agent, key, check, text) => {
    check(text(agent.model), `${key}.model`, '必须为非空模型 ID');
    check(agent.bin == null || text(agent.bin), `${key}.bin`, '必须为路径或 null');
    check(agent.run_access == null || agent.run_access === 'shell', `${key}.run_access`, 'Antigravity 仅支持显式 shell；不能保证 edit 禁止 shell');
    check(agent.agy_mode == null || ['accept-edits', 'auto', 'plan'].includes(agent.agy_mode), `${key}.agy_mode`, '必须为 accept-edits / auto / plan');
    check(agent.dangerously_skip_permissions == null || agent.dangerously_skip_permissions === false, `${key}.dangerously_skip_permissions`, '此适配器不支持跳过权限');
  },
  validateResume: (parent) => { if (!parent.meta.session_id) die(M.noSession(parent.id)); },
};
