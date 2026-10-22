// pi CLI：守卫扩展限定工具和目录、JSON 事件翻译、模型清单和检查项。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { emptyUsage, addUsage as mergeUsage, piUsage, hasUsage, addAmount, amount } from '../usage.mjs';
import { SCHEMA, DISCUSS_SCHEMA } from '../config.mjs';
import { discussionPolicy, discussionLimitsPrompt } from '../discuss-limits.mjs';
import { MAX_REVIEW_CHARS } from '../review-scope.mjs';
import { newRunDir, isCancelled, readMeta } from '../records.mjs';
import { startRun, finishDiscussion, execute, eventWriter, runLimits, reportWithRepair, spawnCli, validateSchema } from '../runner.mjs';
import { M, die, isObject, binCommand, pathCommand, npmEntry, killTree, readAttachments, focusFiles, relativePath, whoOf, closestMatches } from '../util.mjs';

function piCommand(agent) {
  if (agent.bin) return binCommand(agent.bin);
  if (process.platform !== 'win32') return pathCommand('pi');
  // Windows 上的 pi 是 npm 生成的 .cmd 包装，直接用 node 运行它的入口脚本。
  const entry = npmEntry('@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
  return entry ? binCommand(entry) : binCommand('pi');
}

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pi-guard.mjs');
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const RUN_ACCESS = ['edit', 'shell'];
const TOOLS = { none: [], read: ['read', 'grep', 'find', 'ls'] };
TOOLS.edit = [...TOOLS.read, 'edit', 'write'];
TOOLS.shell = [...TOOLS.edit, 'bash'];
const capabilities = { modes: ['run', 'review', 'discuss'], isolation: 'tools', reads_code: true, native_schema: false, native_review: false, images: false, resume: true, command_start_events: true };
// 只加载 foreman 的守卫扩展：用户自己的扩展、skill、提示模板、MCP 和项目里的 .pi 设置都不加载；项目的 AGENTS.md / CLAUDE.md 照常读。
const PROGRESS_MS = Number(process.env.CODEX_FOREMAN_TEST_PROGRESS_MS) || 5000;
const LOG_SKIP = new Set(['message_update', 'message_start', 'turn_end', 'agent_end']);
const ISOLATE = ['--no-extensions','--no-skills', '--no-prompt-templates', '--no-themes', '--no-mcp', '--no-approve', '--offline'];

function piArgs({ model, effort, access, session, sessionDir, name, ephemeral = false }) {
  const args = ['--mode', 'json', '--model', model, ...ISOLATE, '-e', GUARD];
  if (effort != null && effort !== 'default') args.push('--thinking', effort);
  args.push(...(TOOLS[access].length ? ['--tools', TOOLS[access].join(',')] : ['--no-tools']));
  if (sessionDir) args.push('--session-dir', sessionDir);
  if (session) args.push('--session', session);
  if (ephemeral) args.push('--no-session');
  if (name) args.push('--name', name);
  return args;
}

// pi 的规则：模型支持思考时，映射为 null 的档位不支持，xhigh 和 max 要明确映射才支持；不支持思考的只有 off。
const supportedLevels = (m) => (m.reasoning
  ? LEVELS.filter((lv) => { const v = m.thinkingLevelMap?.[lv]; return v === null ? false : lv === 'xhigh' || lv === 'max' ? v !== undefined : true; })
  : ['off']);
// 和 pi 一样：不支持的档位先往高处找最近的，找不到再往低处找。
function clampLevel(levels, level) {
  if (levels.includes(level)) return level;
  const i = LEVELS.indexOf(level);
  return [...LEVELS.slice(i + 1), ...LEVELS.slice(0, i).reverse()].find((lv) => levels.includes(lv)) ?? levels[0] ?? 'off';
}

function deniedQuestions(denied, cwd) {
  const shown = (value) => {
    if (typeof value !== 'string' || !value) return value;
    const abs = path.resolve(cwd, value), rel = relativePath(cwd, abs);
    return rel === '..' || rel.startsWith('../') || path.isAbsolute(rel) ? abs : rel;
  };
  const replacer = (key, value) => (['path', 'file_path', 'filePath'].includes(key) ? shown(value) : value);
  const questions = denied.map(({ tool, args }) => ({ source: 'permission_denied', question: `${tool} ${JSON.stringify(args || {}, replacer)}`,
    detail: JSON.stringify({ tool, input: args || {} }, replacer) }));
  return [...new Map(questions.map((q) => [q.detail, q])).values()];
}

function runPi({ agent, args, cwd, prompt = '', timeoutMs, stallMin = 0, runDir, onEvent, access = 'none', discussion = null }) {
  return new Promise((resolve) => {
    const { file, pre } = piCommand(agent);
    const out = { code: null, status: null, stdout: '', stderrTail: '', text: '', errors: [], events: 0, messages: [], questions: [],
      usage: emptyUsage(), cost: null, thinkingLevel: null };
    const running = new Map(), denied = [];
    let finalStop = null, finalError = null;
    const addUsage = (u) => {
      mergeUsage(out.usage, piUsage(u));
      out.cost = addAmount(out.cost, amount(u?.cost?.total));
    };
    const child = spawnCli(file, [...pre, ...args], { cwd, env: { ...process.env, CODEX_FOREMAN_PI_GUARD: JSON.stringify({ root: cwd, access, ...(discussion ? { discussion } : {}) }) },
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' }, {
      busy: () => running.size > 0,
      onInput: (line, min) => {
        out.status = 'needs_input';
        out.questions.push({ source: 'input_prompt', question: line });
        out.errors.push(M.inputWaitDetected(min, line));
      },
    });
    const stop = (status) => { if (out.status) return; out.status = status; if (child.pid) killTree(child.pid); };
    const onSignal = () => stop('cancelled');
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    let lastEventAt = Date.now();
    let buf = '';
    const record = (line) => {
      line = line.replace(/\r$/, '');
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (!isObject(ev) || !ev.type) return;
      // 流式增量和重复的内容不落盘：完整回复在 message_end 里，turn_end 和 agent_end 只是再带一遍。
      if (runDir && !LOG_SKIP.has(ev.type)) fs.appendFileSync(path.join(runDir, 'pi.jsonl'), line + '\n');
      lastEventAt = Date.now();
      out.events++;
      if (ev.type === 'tool_execution_start') running.set(ev.toolCallId, ev);
      if (ev.type === 'tool_execution_end') {
        const start = running.get(ev.toolCallId);
        running.delete(ev.toolCallId);
        const text = (ev.result?.content || []).map((c) => c.text || '').join('');
        if (ev.isError && text.startsWith('foreman guard:')) {
          denied.push({ tool: ev.toolName, args: start?.args });
          if (discussion) { out.questions.push({ source: 'discussion_limit', question: text }); stop('needs_input'); }
        }
      }
      if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
        const m = ev.message;
        addUsage(m.usage);
        out.thinkingLevel = m.thinkingLevel ?? out.thinkingLevel;
        const text = (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
        if (text) { out.text = text; out.messages.push(text); }
        // 出错后 pi 会自动重试，只看最后一条回复的结束原因。
        finalStop = m.stopReason;
        finalError = m.errorMessage || null;
      }
      if (ev.type === 'auto_retry_end' && ev.success === false && ev.finalError) finalError = ev.finalError;
      // 上下文太长时 pi 会自动压缩，压缩请求的用量单独报告。
      if (ev.type === 'compaction_end' && ev.result?.usage) addUsage(ev.result.usage);
      onEvent?.(ev);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (!onEvent) out.stdout += chunk;
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { record(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      out.stderrTail = (out.stderrTail + chunk).slice(-4000);
      if (runDir) fs.appendFileSync(path.join(runDir, 'stderr.log'), chunk);
    });
    const timer = setTimeout(() => stop('timeout'), Math.max(1, timeoutMs));
    const poll = setInterval(() => {
      if (runDir && isCancelled(runDir)) stop('cancelled');
      // 工具（比如测试命令）还在运行时不算卡住。
      else if (stallMin && !running.size && Date.now() - lastEventAt >= stallMin * 60000) stop('stalled');
    }, 1000);
    child.on('error', (e) => out.errors.push(e.message));
    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      if (buf.trim()) record(buf);
      out.questions.push(...deniedQuestions(denied, cwd));
      // JSON 模式下回复出错时 pi 照样以 0 退出，要看最后一条回复。
      if (finalStop === 'error' || finalStop === 'aborted') out.errors.push(finalError || finalStop);
      if (finalStop === 'length') out.errors.push(M.piStopLength);
      out.code = code;
      if (runDir && isCancelled(runDir)) out.status = 'cancelled';
      out.status ||= out.errors.some((e) => /usage limit|quota|insufficient balance/i.test(e)) ? 'quota_exhausted'
        : code === 0 && !out.errors.length ? 'done' : 'failed';
      if (out.status === 'failed' && !out.errors.length) out.errors.push(M.exitCode(code, out.stderrTail.trim().split(/\r?\n/).slice(-6).join('\n'), 'pi'));
      resolve(out);
    });
    child.stdin.on('error', () => { /* 提前退出时忽略 EPIPE */ });
    child.stdin.end(prompt, 'utf8');
  });
}

async function executePi(ctx) {
  const { model, agent, level, cwd, brief, mode, opts } = ctx;
  if (ctx.parent && !ctx.sessionId) die(M.noSession(ctx.parent));
  const review = ctx.kind === 'review', exec = ctx.kind === 'exec';
  let access = exec ? agent.run_access : 'read';
  const schemaText = review ? null : fs.readFileSync(exec ? SCHEMA : DISCUSS_SCHEMA, 'utf8');
  const schema = review ? null : JSON.parse(schemaText);
  const files = review ? [] : readAttachments(opts.file, cwd, false);
  let discussion = null;
  if (ctx.kind === 'discuss') {
    try { discussion = discussionPolicy(ctx, files); } catch (e) { die(e.message); }
  }
  if (discussion && !discussion.paths.length) access = 'none';
  let prompt;
  if (review) {
    const scope = ctx.reviewScope;
    const parts = [scope ? M.opencodeReviewPrompt(cwd, scope.description) : M.reviewPromptPlain(cwd)];
    if (brief) parts.push(brief);
    if (scope) {
      const fileList = scope.files.map((f) => `- ${f.status} ${f.old_path ? `${f.old_path} → ` : ''}${f.path}`
        + (f.binary ? M.reviewFileBinary : '') + (f.too_large ? M.reviewFileTooLarge : '')).join('\n');
      const chars = fileList.length + scope.patch.length;
      if (chars > MAX_REVIEW_CHARS) die(M.reviewTooLarge(chars, MAX_REVIEW_CHARS));
      const longest = (scope.patch.match(/`+/g) || []).reduce((n, s) => Math.max(n, s.length), 2);
      parts.push(M.reviewMaterial(fileList, scope.patch, '`'.repeat(longest + 1)));
    }
    prompt = [...parts, M.reviewFooter].join('\n\n') + '\n';
  } else if (exec) prompt = ctx.parent
    ? `${brief}${focusFiles(files)}\n\n${M.resumeFooter}\n\n${M.opencodeRunResumeFooter}\n`
    : `${brief}\n\n${M.footer(cwd, ctx.addDirs || [])}\n\n${M.opencodeRunFooter(schemaText, access)}\n`;
  else prompt = `${brief}${focusFiles(files)}\n\n${ctx.parent ? M.opencodeResumeFooter : M.opencodeDiscussFooter(cwd, schemaText)}\n`;
  if (discussion) prompt += `\n${discussionLimitsPrompt(discussion, cwd)}\n`;
  const { id, dir, release } = await newRunDir();
  const context = { ...ctx, id, dir, release, prompt, discussion };
  if (exec) return execute(context, {
    capabilities, describe: () => ({ sandbox: null, modelShown: model, modelName: model }),
    run: ({ run }) => piSession(run, schema, access),
  });
  const run = startRun(context);
  fs.writeFileSync(path.join(dir, 'brief.md'), prompt);
  process.stderr.write(`foreman: ${M.started(mode, whoOf(run.meta), level, dir)}\n`);
  return finishDiscussion(run, { ...await piSession(run, schema, access), files, changesNote: M.piNoChanges });
}

// --session 接受文件路径；复制后续接，避免改写父任务或旧全局会话。
function localSession(ctx) {
  const dir = path.join(ctx.dir, 'pi-sessions');
  fs.mkdirSync(dir, { recursive: true });
  if (!ctx.sessionId) return { dir, file: null };
  const parent = ctx.parentDir && readMeta(ctx.parentDir);
  const candidates = [parent?.native_session_file, ctx.parentDir && path.join(ctx.parentDir, 'pi-native-session.jsonl')].filter(Boolean);
  const roots = [parent?.native_session_dir, path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'sessions')].filter(Boolean);
  const visit = (root) => {
    if (!fs.existsSync(root)) return;
    for (const item of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, item.name);
      if (item.isDirectory()) visit(file);
      else if (item.name.endsWith('.jsonl')) {
        try { const first = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]); if (first.type === 'session' && first.id === ctx.sessionId) candidates.push(file); } catch { /* 非会话文件 */ }
      }
    }
  };
  for (const root of roots) { if (!candidates.some((f) => fs.existsSync(f))) visit(root); }
  const source = candidates.find((f) => fs.existsSync(f));
  if (!source) die(`找不到 pi 原生会话 ${ctx.sessionId}；请恢复父任务的 pi-sessions 或旧全局会话文件后续接。`);
  const file = path.join(dir, path.basename(source));
  fs.copyFileSync(source, file);
  return { dir, file };
}

async function piSession(run, schema, access) {
  const { ctx, started, meta, writeMeta } = run;
  const { dir, agentName, agent, model, effort, cwd, prompt } = ctx;
  const { deadline, stallMin } = runLimits(ctx, started);
  const native = localSession(ctx);
  meta.native_session_dir = native.dir;
  meta.native_session_file = native.file;
  writeMeta();
  const syncNative = () => {
    if (!meta.session_id) return;
    for (const name of fs.readdirSync(native.dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(native.dir, name);
      try { if (JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]).id === meta.session_id) { meta.native_session_file = file; break; } } catch { /* 会话写入中 */ }
    }
    writeMeta();
  };
  if (ctx.discussion) { meta.discussion_limits = ctx.discussion; writeMeta(); }
  const event = eventWriter(dir);
  for (const file of ['events.jsonl', 'pi.jsonl', 'stderr.log']) fs.writeFileSync(path.join(dir, file), '');
  const errors = [], warnings = [], notes = [];
  const observed = { messages: [], questions: [] };
  const usage = emptyUsage();
  const fileChanges = new Set(), started_tools = new Map();
  let cost = null, commands = 0, items = 0, repairing = false, last = '', report = null, thinkingLevel = null;
  // 流式输出的字数；完整内容要等 message_end 才写进时间线，这期间每隔几秒写一条进度，免得看起来像卡住了。
  const stream = { thinking: 0, text: 0, at: 0 };
  // 翻译成 Codex 的事件形状，让 watch 和 status 共用现有的时间线、命令和报告显示。
  const translate = (ev) => {
    if (ev.type === 'session' && ev.id && !meta.session_id) {
      meta.session_id = ev.id;
      writeMeta();
      event({ type: 'thread.started', thread_id: ev.id });
    } else if (ev.type === 'message_start') {
      stream.thinking = 0; stream.text = 0;
    } else if (ev.type === 'message_update') {
      const delta = ev.assistantMessageEvent;
      const phase = delta?.type === 'thinking_delta' ? 'thinking' : delta?.type === 'text_delta' ? 'text' : null;
      if (!phase) return;
      stream[phase] += String(delta.delta || '').length;
      if (Date.now() - stream.at < PROGRESS_MS) return;
      stream.at = Date.now();
      event({ type: 'pi.progress', phase: phase === 'thinking' ? 'thinking' : 'answering', total_chars: stream[phase] });
    } else if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
      for (const block of ev.message.content || []) {
        if (block.type === 'thinking' && block.thinking) event({ type: 'item.completed', item: { type: 'reasoning', text: block.thinking } });
        if (block.type === 'text' && block.text) { last = block.text; event({ type: 'item.completed', item: { type: 'agent_message', text: block.text } }); }
      }
    } else if (ev.type === 'tool_execution_start') {
      const item = { id: `pi-${++items}`, tool: ev.toolName };
      started_tools.set(ev.toolCallId, { item, args: ev.args || {} });
      if (ev.toolName === 'bash') event({ type: 'item.started', item: { ...item, type: 'command_execution', category: 'shell', command: String(ev.args?.command || '') } });
    } else if (ev.type === 'tool_execution_end') {
      const { item = { id: `pi-${++items}`, tool: ev.toolName }, args = {} } = started_tools.get(ev.toolCallId) || {};
      started_tools.delete(ev.toolCallId);
      const output = (ev.result?.content || []).map((c) => c.text || '').join('').slice(0, 2000);
      const target = args.path ?? args.file_path;
      if (ev.toolName === 'edit' || ev.toolName === 'write') {
        const changes = typeof target === 'string' && !ev.isError ? [{ path: target, kind: ev.toolName === 'write' ? 'add' : 'update' }] : [];
        for (const change of changes) fileChanges.add(change.path);
        event({ type: 'item.completed', item: { ...item, category: 'edit', type: 'file_change', changes } });
        return;
      }
      if (ev.toolName === 'bash') commands++;
      const shown = (value) => (path.isAbsolute(String(value)) ? relativePath(cwd, String(value)) : String(value));
      const command = ev.toolName === 'bash' ? String(args.command || '')
        : [ev.toolName, ...['pattern', 'path', 'glob'].filter((k) => args[k] != null).map((k) => (k === 'path' ? shown(args[k]) : String(args[k])))].join(' ');
      event({ type: 'item.completed', item: { ...item, type: 'command_execution', category: ev.toolName === 'bash' ? 'shell' : ['grep', 'find', 'ls'].includes(ev.toolName) ? 'search' : 'read',
        command, exit_code: ev.isError ? 1 : 0, aggregated_output: output } });
    } else if (ev.type === 'auto_retry_start') event({ type: 'error', message: M.piRetrying(ev.attempt, ev.maxAttempts, ev.errorMessage || '') });
  };
  let nextPrompt = prompt;
  const request = async () => {
    if (isCancelled(dir)) { meta.status = 'cancelled'; return null; }
    if (Date.now() >= deadline) { meta.status = 'timeout'; return null; }
    // 格式修复用同一个会话，不开任何工具。
    const current = repairing ? 'none' : access;
    const out = await runPi({ agent, args: piArgs({ model, effort, access: current, session: meta.native_session_file, sessionDir: native.dir, name: meta.title || `foreman ${ctx.kind}` }),
      cwd, access: current, discussion: ctx.discussion, prompt: nextPrompt, runDir: dir, onEvent: translate, timeoutMs: deadline - Date.now(), stallMin });
    syncNative();
    errors.push(...out.errors);
    observed.questions.push(...out.questions);
    if (!repairing) observed.messages = out.messages;
    mergeUsage(usage, out.usage);
    cost = addAmount(cost, out.cost);
    thinkingLevel = out.thinkingLevel ?? thinkingLevel;
    meta.status = out.status;
    if (out.questions.some((q) => q.source === 'discussion_limit')) meta.discussion_stop_reason = out.questions.find((q) => q.source === 'discussion_limit').question;
    return meta.status === 'done' ? { last, canRepair: !!meta.session_id } : null;
  };
  if (ctx.kind === 'review') await request();
  else report = await reportWithRepair({
    schema, validate: validateSchema, request,
    onInvalid: () => warnings.push(M.reportInvalid(agentName, path.join(dir, 'last-message.txt'))),
    repair: (invalid) => { repairing = true; nextPrompt = M.reportRepairPrompt(invalid.join('\n')); },
  });
  if (meta.status === 'cancelled') errors.push(M.runCancelled(model));
  if (meta.status === 'stalled') errors.push(M.stalled(stallMin));
  if (meta.status === 'failed' && errors.some((e) => /rate.?limit|concurrency|too many requests|\b429\b/i.test(e))) notes.push(M.rateLimited(model, 'pi'));
  if (meta.status === 'failed' && errors.some((e) => /^400\s+event:\s*error\s+data:\s*\{\s*\}\s*$/.test(e))) {
    notes.push(M.piOpaque400(model, meta.id, meta.session_id, dir));
  }
  // pi 遇到模型不支持的档位不报错，会悄悄换一档。
  if (effort != null && effort !== 'default' && thinkingLevel && thinkingLevel !== effort) notes.push(M.piEffortChanged(effort, thinkingLevel));
  fs.writeFileSync(path.join(dir, 'last-message.txt'), last);
  return { usage: hasUsage(usage) ? usage : null, usage_scope: 'this_run', cost, commands, errors, notes, warnings, report, last, observed,
    status: meta.status, code: meta.status === 'done' ? 0 : 1, sessionId: meta.session_id,
    fileChanges, images: [], messages: observed.messages, questions: observed.questions };
}

// 本机 pi 能用的模型清单：用 RPC 的 get_available_models 读，不发模型请求。读不到时返回 ok: false。
function piCatalog(agent = {}) {
  const { file, pre } = piCommand(agent);
  const source = 'pi --mode rpc get_available_models';
  const r = spawnSync(file, [...pre, '--mode', 'rpc', '--no-session', ...ISOLATE], { input: `${JSON.stringify({ id: 'models', type: 'get_available_models' })}\n`,
    encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  try {
    if (r.error) throw r.error;
    const response = (r.stdout || '').split('\n').map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((x) => x?.id === 'models');
    if (!response?.success) throw new Error(response?.error || (r.stderr || '').trim().split('\n').pop() || `exit ${r.status}`);
    const models = response.data.models.map((m) => ({ id: `${m.provider}/${m.id}`, name: m.name || m.id, efforts: supportedLevels(m), default_effort: null,
      context: m.contextWindow ?? null, cost: m.cost ? { input: m.cost.input, output: m.cost.output } : null }));
    return { ok: true, source, models, error: null };
  } catch (e) { return { ok: false, source, models: [], error: e.message }; }
}

async function checkPiAgent(name, agent, efforts = [], catalog = () => piCatalog(agent)) {
  const started = Date.now();
  const out = { ok: false, type: 'pi cli', model: agent.model, version: null, model_listed: false, seconds: null, reply: null, error: null, fix: null, efforts: [] };
  const call = (args, timeoutMs = 60000, prompt = '') => runPi({ agent, args, cwd: process.cwd(), timeoutMs, prompt });
  const failed = (result) => result.errors.join('; ') || result.stderrTail.trim() || result.status;
  const finish = () => ({ ...out, seconds: Number(((Date.now() - started) / 1000).toFixed(1)) });
  const version = await call(['--version']);
  if (version.status !== 'done') { out.error = failed(version); out.fix = M.fixPiMissing(name); return finish(); }
  out.version = version.stdout.trim();
  out.verified_versions = ['1.2.0'];
  out.version_verified = /^(?:v)?1\.2\.0$/.test(out.version);
  out.version_warning = out.version_verified ? null : `pi ${out.version} 尚未验证；当前已验证 1.2.0，继续执行兼容性检查。`;
  const cat = catalog();
  if (!cat.ok) { out.error = cat.error; out.fix = M.fixPiCatalog(name, cat.error); return finish(); }
  const listed = cat.models.find((m) => m.id === agent.model);
  out.model_listed = !!listed;
  if (!listed) {
    const near = closestMatches(agent.model, cat.models.map((m) => m.id));
    out.fix = M.fixPiModel(name, agent.model) + (near.length ? M.closestHint(M.list(near)) : '');
    return finish();
  }
  const reply = await call(piArgs({ model: agent.model, effort: null, access: 'none', ephemeral: true }), 120000, 'Reply with the single word OK.');
  out.ok = reply.status === 'done';
  out.reply = reply.text.trim().slice(0, 40);
  if (!out.ok) { out.error = failed(reply); out.fix = M.fixPiRun(name, out.error); return finish(); }
  // 推理强度只按清单核对：pi 遇到模型不支持的档位不会报错，会悄悄换成最接近的一档，发请求试不出来。
  for (const item of efforts) {
    const model = cat.models.find((m) => m.id === item.model);
    if (!model) { out.efforts.push({ ...item, ok: false, error: M.modelNotInCatalog(item.model), supported: [] }); continue; }
    const ok = item.variant === 'default' || model.efforts.includes(item.variant);
    out.efforts.push({ ...item, ok, error: ok ? null : M.piEffortClamped(item.variant, clampLevel(model.efforts, item.variant), M.list(model.efforts)), supported: model.efforts });
  }
  const unsupported = out.efforts.filter((e) => !e.ok);
  if (unsupported.length) {
    out.ok = false;
    out.error = unsupported[0].error;
    out.fix = M.fixEffortUnsupported(name, M.list(unsupported.map((e) => M.effortAt(e.variant, M.list(e.used_at), e.model, e.supported.length ? M.list(e.supported) : M.noEfforts))));
  }
  return finish();
}

function validate(agent, key, check, text) {
  const why = M.invalid;
  check(text(agent.model) && agent.model.includes('/'), `${key}.model`, why.piModel);
  check(agent.bin == null || text(agent.bin), `${key}.bin`, why.stringOrNull);
  check(agent.run_access === undefined || RUN_ACCESS.includes(agent.run_access), `${key}.run_access`, why.runAccess);
}

export default {
  type: 'pi cli', capabilities, channel: M.channel.pi, efforts: LEVELS,
  // 环境检测用：列模型前 pi 会加载扩展，所以同样带上隔离参数。
  listModelsArgs: ['--list-models', ...ISOLATE],
  validate,
  status: (agent) => { const { file, pre } = piCommand(agent); return { bin: agent.bin || pre[0] || file, run_access: agent.run_access ?? null }; },
  check: checkPiAgent,
  catalog: piCatalog,
  locate: piCommand,
  execute: executePi,
  validateResume: (parent) => { if (!parent.meta.session_id) die(M.noSession(parent.id)); },
};
