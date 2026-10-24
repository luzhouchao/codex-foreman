import { spawnSync } from 'node:child_process';

const SERVICE = '/exa.language_server_pb.LanguageServerService/';
const READ_METHODS = new Set(['GetAvailableModels', 'GetCascadeModelConfigData']);
const unsupported = 'Antigravity Desktop 为实验适配；check 只验证精确目录，不发起模型请求，执行需 experimental: true。';

export function parseDesktopProcess(commandLine = '') {
  const arg = (name) => new RegExp(`--${name}(?:=|\\s+)(?:"([^"]+)"|(\\S+))`).exec(commandLine);
  const csrf = arg('csrf_token'), port = arg('https_server_port');
  return { token: csrf?.[1] || csrf?.[2] || null, httpsPort: port ? Number(port[1] || port[2]) : null };
}

// 子进程结果只在内存中解析，绝不把命令行、CSRF 或完整进程对象写入记录。
export function discoverDesktop() {
  if (process.platform !== 'win32') throw new Error('Antigravity Desktop 自动发现目前仅支持 Windows。');
  const script = String.raw`$ErrorActionPreference='Stop'; $items=@(Get-CimInstance Win32_Process -Filter "Name='language_server.exe'" | Where-Object { $_.CommandLine -match '--standalone' -and $_.ExecutablePath -match '[\\/]Antigravity[\\/].*language_server\.exe$' } | ForEach-Object { $p=$_; $ports=@(Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @('127.0.0.1','::1','0.0.0.0','::') } | Select-Object -ExpandProperty LocalPort -Unique); @{pid=$p.ProcessId; commandLine=$p.CommandLine; ports=$ports} }); ConvertTo-Json -InputObject $items -Depth 4 -Compress`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error('无法发现 Antigravity Desktop language server。');
  let rows;
  try { rows = JSON.parse(r.stdout.replace(/^\uFEFF/, '').trim()); } catch { throw new Error('Antigravity Desktop 进程发现返回无效数据。'); }
  if (!Array.isArray(rows) || rows.length > 1) throw new Error('存在多个 Desktop language server，拒绝猜测连接目标。');
  const candidates = [];
  for (const row of rows) {
    const { token, httpsPort } = parseDesktopProcess(row.commandLine);
    if (!token) continue;
    for (const port of row.ports || []) if (Number.isInteger(port) && port > 0 && port <= 65535 && port !== httpsPort) candidates.push({ endpoint: `http://127.0.0.1:${port}`, token, pid: row.pid });
  }
  if (!candidates.length) throw new Error('没有找到已登录的 Antigravity Desktop HTTP listener；不会使用 --https_server_port=0。');
  return candidates;
}

export function createDesktopTransport({ endpoint, token, fetchImpl = globalThis.fetch, experimental = false }) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Desktop endpoint 必须是本机 127.0.0.1 HTTP 端口。');
  if (!token || typeof token !== 'string') throw new Error('Desktop CSRF token 不可为空。');
  return { async request(method, body = {}) {
    if (!READ_METHODS.has(method) && !(experimental && ['StartCascade', 'SendUserCascadeMessage', 'GetCascadeTrajectory', 'CancelCascadeInvocation', 'ListProjects', 'ReadProject', 'CreateProject'].includes(method))) throw new Error('当前 Desktop transport 仅允许已验证的只读接口。');
    let response;
    try { response = await fetchImpl(`${url.origin}${SERVICE}${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': token }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10000) }); }
    catch { throw new Error('Desktop 只读接口连接失败。'); }
    if (!response.ok) {
      let detail = '';
      try { const data = await response.json(); detail = String(data.message || data.error?.message || data.code || '').replaceAll(token, '[REDACTED]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]').slice(0, 800); } catch { /* 不暴露原始响应 */ }
      throw new Error(`Desktop ${method} HTTP ${response.status}: ${detail}`);
    }
    try { return await response.json(); } catch { throw new Error('Desktop 只读接口返回无效 JSON。'); }
  } };
}

export async function desktopCatalog(agent = {}, { discover = discoverDesktop, transportFactory = createDesktopTransport } = {}) {
  try {
    const discovered = await discover(agent), candidates = Array.isArray(discovered) ? discovered : [discovered];
    for (const candidate of candidates) {
      try {
        const data = await transportFactory(candidate).request('GetAvailableModels');
        const native = data?.response?.models;
        if (!native || typeof native !== 'object' || Array.isArray(native)) continue;
        const models = Object.entries(native).map(([id, m]) => ({ id, name: m.displayName || id, native_id: m.model || null, efforts: id.endsWith('-medium') ? ['medium'] : [], default_effort: null, context: m.maxTokens ?? null, cost: null }));
        if (models.length) return { ok: true, source: 'Antigravity Desktop GetAvailableModels', models, error: null };
      } catch { /* 端口可能为 HTTPS/gRPC；只探测下一项，不输出认证或响应正文。 */ }
    }
    return { ok: false, source: 'Antigravity Desktop GetAvailableModels', models: [], error: '未找到响应有效模型目录的 Desktop HTTP listener。' };
  } catch { return { ok: false, source: 'Antigravity Desktop GetAvailableModels', models: [], error: '无法读取 Antigravity Desktop 模型目录；请确认桌面已登录且 language server 正在运行。' }; }
}

export async function checkDesktop(name, agent, variants = [], getCatalog = () => desktopCatalog(agent)) {
  const started = Date.now(), cat = await getCatalog(), listed = cat.models.some((m) => m.id === agent.model);
  return { ok: cat.ok && listed, type: 'antigravity desktop', model: agent.model, model_listed: listed, seconds: (Date.now() - started) / 1000, reply: null, error: cat.error || (!listed ? `模型未列出：${agent.model}` : null), variants: variants.map((v) => ({ ...v, ok: cat.models.some((m) => m.id === v.model) && (!v.variant || (v.variant === 'medium' && v.model.endsWith('-medium'))) })), check_scope: 'desktop_catalog_only', inference_verified: false, execution_supported: agent.experimental === true, experimental: true, usage: null, cost: null, commands: null, warning: unsupported };
}

export default {
  type: 'antigravity desktop', channel: 'Antigravity Desktop', efforts: [null, 'medium'],
  capabilities: { modes: ['discuss', 'review'], isolation: 'none', reads_code: false, native_schema: false, native_review: false, images: false, resume: true, command_start_events: false },
  catalog: desktopCatalog, check: checkDesktop,
  status: (agent = {}) => ({ transport: 'desktop_language_server', experimental: true, execution_supported: agent.experimental === true, isolation: 'none' }),
  execute: executeDesktop,
  validate: (agent, key, check, text) => {
    check(agent.experimental == null || typeof agent.experimental === 'boolean', `${key}.experimental`, '必须为 boolean');
    check(text(agent.model), `${key}.model`, '必须为非空且精确的 Desktop 模型 ID');
    check(agent.run_access == null, `${key}.run_access`, 'Desktop 执行尚未开放');
    check(agent.bin == null, `${key}.bin`, 'Desktop 使用已运行的 language server，不接受 CLI bin');
    check(agent.dangerously_skip_permissions == null || agent.dangerously_skip_permissions === false, `${key}.dangerously_skip_permissions`, '禁止跳过桌面权限');
  },
};
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { SCHEMA, DISCUSS_SCHEMA } from '../config.mjs';
import { WORKSPACE_ROOT, newRunDir, isCancelled } from '../records.mjs';
import { startRun, finishDiscussion, eventWriter, runLimits, parseReport, validateSchema } from '../runner.mjs';
import { makeTracker } from '../tracker.mjs';
import { readAttachments, focusFiles } from '../util.mjs';

const permissionWarning = '实验分析请求禁用模型工具调用，仅使用提供的任务材料；Desktop 权限由现有桌面策略决定；只读要求为提示词约束并以前后快照核验，不提供硬只读隔离。';

// Verified against the official Desktop UI projectManagementFeature and protobuf descriptors.
export function desktopWorkspaceKey(uri) {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'file:') return null;
    return path.win32.normalize(fileURLToPath(url, { windows: true })).replace(/[\\/]+$/, '').toLowerCase();
  } catch { return null; }
}

export async function ensureDesktopProject(transport, workspace) {
  const key = desktopWorkspaceKey(pathToFileURL(path.resolve(workspace)).href);
  const lockPath = path.join(os.tmpdir(), 'codex-foreman-agy-project-' + createHash('sha256').update(key || '').digest('hex') + '.lock');
  const deadline = Date.now() + 15000;
  let fd;
  while (fd === undefined) {
    try { fd = fs.openSync(lockPath, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('Desktop Project 创建锁等待超时；请检查是否有其他 Foreman 进程仍在创建项目。');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try { return await ensureDesktopProjectLocked(transport, workspace); }
  finally { fs.closeSync(fd); fs.unlinkSync(lockPath); }
}

async function ensureDesktopProjectLocked(transport, workspace) {
  const uri = pathToFileURL(path.resolve(workspace)).href;
  const key = desktopWorkspaceKey(uri);
  if (!key) throw new Error('Desktop 主工作区必须是有效本地路径。');
  const listed = await transport.request('ListProjects');
  // ProtoJSON omits empty repeated fields; ListProjectsResponse has only project_ids.
  if (!listed || typeof listed !== 'object' || Array.isArray(listed) || Object.keys(listed).some(key => key !== 'projectIds') || (listed.projectIds !== undefined && (!Array.isArray(listed.projectIds) || listed.projectIds.some(id => typeof id !== 'string' || !id)))) throw new Error('Desktop ListProjects 未返回有效项目列表。');
  const matches = [];
  for (const id of listed.projectIds || []) {
    const result = await transport.request('ReadProject', { id });
    if (result.notFoundOnDisk) continue;
    if (!result.project || result.errorMessage) throw new Error('Desktop 无法读取项目元数据；拒绝创建重复项目。');
    const project = result.project;
    const resources = project.projectResources?.resources || [];
    if (project.isWorkspaceOnly !== true && resources.length === 1 && desktopWorkspaceKey(resources[0].folderUri || resources[0].gitFolder?.folderUri) === key) matches.push(project);
  }
  if (matches.length > 1) throw new Error('Desktop 存在多个对应主工作区的 Project，拒绝猜测。');
  if (matches.length) return { id: matches[0].id, name: matches[0].name, workspace_uri: uri, created: false };
  const project = { id: randomUUID(), name: path.basename(path.resolve(workspace)), projectResources: { resources: [{ folderUri: uri }] }, settings: {}, isWorkspaceOnly: false };
  await transport.request('CreateProject', { project });
  const confirmed = await transport.request('ReadProject', { id: project.id });
  if (confirmed.errorMessage || confirmed.notFoundOnDisk || confirmed.project?.id !== project.id || confirmed.project?.isWorkspaceOnly === true || desktopWorkspaceKey(confirmed.project?.projectResources?.resources?.[0]?.folderUri) !== key) throw new Error('Desktop 创建 Project 后未通过回读核验。');
  return { id: project.id, name: confirmed.project.name, workspace_uri: uri, created: true };
}

export async function executeDesktop(ctx, { discover = discoverDesktop, transportFactory = createDesktopTransport } = {}) {
  if (ctx.opts?.['max-files'] != null || ctx.opts?.['max-tool-calls'] != null) throw new Error('Desktop 不支持硬文件/工具预算；不能忽略 --max-files/--max-tool-calls。');
  if (ctx.agent.experimental !== true) throw new Error('Desktop 执行须显式设置 experimental: true。');
  if (ctx.effort && (ctx.effort !== 'medium' || !ctx.model.endsWith('-medium'))) throw new Error('Desktop effort 仅允许与精确 -medium 模型一致的 medium；不会覆盖模型配置。');
  if (ctx.kind === 'exec') throw new Error('Desktop run 尚未开放；当前实验仅支持 discuss/review。');
  if (ctx.parent && !ctx.sessionId) throw new Error('Desktop 续接缺少已保存的 sessionId。');
  const discovered = await discover();
  const candidates = Array.isArray(discovered) ? discovered : [discovered];
  let transport, selected;
  for (const candidate of candidates) {
    try {
      const t = transportFactory({ ...candidate, experimental: true });
      const c = await t.request('GetAvailableModels');
      const m = c?.response?.models?.[ctx.model];
      if (!m?.model) continue;
      transport = t; selected = m; break;
    } catch { /* 只尝试本机 listener */ }
  }
  if (!transport) throw new Error('无法在 Desktop 目录验证精确模型；未创建任务。');
  const files = readAttachments(ctx.opts.file, ctx.cwd, false);
  const schema = ctx.kind === 'review' ? null : JSON.parse(fs.readFileSync(DISCUSS_SCHEMA, 'utf8'));
  let prompt = `${ctx.brief || ''}${focusFiles(files)}\n工作目录：${ctx.cwd}\n${permissionWarning}\n只分析和提出建议，不修改文件，不执行会改变状态的命令。`;
  if (ctx.opts.scope?.length) prompt += `\n关注范围（仅提示约束）：${ctx.opts.scope.join(', ')}`;
  if (ctx.kind === 'review') prompt += '\n本次仅依据所附 patch 与任务材料审查；禁用工具请求下不读取完整工作区。';
  if (ctx.reviewScope) prompt += `\n审查范围：${ctx.reviewScope.description}\n${ctx.reviewScope.patch}`;
  if (schema) prompt += `\n最终回复必须符合此 JSON schema：${JSON.stringify(schema)}`;
  const context = { ...ctx, ...await newRunDir(), prompt };
  const run = startRun(context), { meta, writeMeta } = run;
  const event = eventWriter(context.dir), { deadline } = runLimits(ctx, run.started);
  meta.desktop_workspace = ctx.sessionId
    ? { assignment: 'preserved_existing_session', requested_uri: null, workspace: null }
    : { assignment: 'main_workspace', requested_uri: pathToFileURL(path.resolve(WORKSPACE_ROOT) + path.sep).href, workspace: WORKSPACE_ROOT };
  meta.experimental = true; meta.permission_policy = { isolation: 'none', hard_read_only: false, force_disable_tool_calling_requested: true }; meta.requested_native_model = selected.model; meta.model_verification = 'requested_only'; writeMeta();
  fs.writeFileSync(path.join(context.dir, 'brief.md'), prompt);
  let tracker, before, last = '', errors = [], status = 'failed', cancelRequested = false, baselineSteps = 0, baselineGenerators = 0, usage = null, ownsInvocation = false, emptyIdlePolls = 0;
  try {
    tracker = makeTracker(context.dir, ctx.cwd, []); before = tracker.snap('before');
    if (isCancelled(context.dir)) { cancelRequested = true; status = 'cancelled'; throw new Error('任务在远端创建前已取消。'); }
    let created;
    if (ctx.sessionId) {
      const baseline = await transport.request('GetCascadeTrajectory', { cascadeId: ctx.sessionId });
      if ((baseline.status ?? baseline.trajectory?.status) !== 'CASCADE_RUN_STATUS_IDLE') throw new Error('Desktop 原会话未空闲，不能续接。');
      baselineSteps = baseline.trajectory?.steps?.length || 0;
      baselineGenerators = baseline.trajectory?.generatorMetadata?.length || 0;
      created = { cascadeId: ctx.sessionId };
     } else {
      meta.desktop_project = await ensureDesktopProject(transport, WORKSPACE_ROOT);
      writeMeta();
      created = await transport.request('StartCascade', { source: 'CORTEX_TRAJECTORY_SOURCE_AGENT_API', requestedModel: selected.model, projectEnvConfig: { projectId: meta.desktop_project.id, defaultProjectEnvironment: {} } });
    }
    if (!created.cascadeId) throw new Error('StartCascade 未返回 cascadeId。');
    meta.session_id = created.cascadeId; ownsInvocation = true; writeMeta();
    if (!ctx.sessionId && !created.projectEnvInfo?.workspaceUris?.some((uri) => desktopWorkspaceKey(uri) === desktopWorkspaceKey(meta.desktop_project.workspace_uri))) throw new Error('Desktop Project 会话工作区未通过核验。');
    if (isCancelled(context.dir)) { cancelRequested = true; throw new Error('任务在发送推理前已收到取消请求。'); }
    await transport.request('SendUserCascadeMessage', { cascadeId: meta.session_id, items: [{ text: prompt }], cascadeConfig: { plannerConfig: { requestedModel: { model: selected.model }, toolConfig: { forceDisableToolCalling: true } } }, blocking: false, propagateError: true });
    event({ type: 'thread.started', thread_id: meta.session_id });
    while (Date.now() < deadline) {
      const raw = await transport.request('GetCascadeTrajectory', { cascadeId: meta.session_id });
      const trajectory = raw.trajectory || {};
      if (meta.desktop_project && trajectory.metadata?.projectId !== undefined && trajectory.metadata.projectId !== meta.desktop_project.id) throw new Error('Desktop 会话实际 Project 与请求不一致。');
      if (meta.desktop_project && trajectory.metadata?.projectId === meta.desktop_project.id) { meta.desktop_project.assignment_verified = true; writeMeta(); }
      const allSteps = trajectory.steps || [];
      if (!Array.isArray(allSteps)) throw new Error('Desktop trajectory.steps 格式错误。');
      const steps = allSteps.slice(baselineSteps);
      const remoteStatus = raw.status ?? trajectory?.status;
      const generators = (trajectory.generatorMetadata || []).slice(baselineGenerators);
      const generatedModels = generators.flatMap((g) => { const m = g.chatModel || {}; return [m.model, m.responseModel, m.responseModelFull, m.modelDisplayName].filter((v) => typeof v === 'string'); });
      if (generatedModels.length) {
        meta.actual_generated_models = [...new Set(generatedModels)];
        const nativeModels = generators.map((g) => g.chatModel?.model);
        const mismatched = nativeModels.some((m) => typeof m === 'string' && m !== selected.model);
        meta.model_verification = mismatched ? 'reported_unmatched' : nativeModels.length && nativeModels.every((m) => m === selected.model) ? 'confirmed' : 'unknown';
        writeMeta();
        if (mismatched) throw new Error('Desktop 实际生成模型与请求的精确模型不一致。');
      }
      usage = desktopUsage((trajectory.generatorMetadata || []).slice(baselineGenerators));
      const texts = steps.map((step) => step.plannerResponse?.modifiedResponse || step.plannerResponse?.response || '').filter(Boolean);
      last = texts.join('\n\n');
      if (steps.some((step) => step.error && Object.keys(step.error).length)) throw new Error('Desktop trajectory 返回步骤错误。');
      event({ type: 'desktop.progress', status: remoteStatus, steps: steps.map((s) => ({ type: s.type, status: s.status })) });
      if (isCancelled(context.dir)) { cancelRequested = true; break; }
      if (remoteStatus === 'CASCADE_RUN_STATUS_IDLE' && last) { status = 'done'; break; }
      emptyIdlePolls = remoteStatus === 'CASCADE_RUN_STATUS_IDLE' ? emptyIdlePolls + 1 : 0;
      if (emptyIdlePolls >= 3) throw new Error('Desktop 任务已空闲但未返回公开正文。');
      if (/ERROR|FAILED|CANCELLED|CANCELED/.test(String(remoteStatus))) throw new Error(`Desktop 任务终止：${remoteStatus}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (status !== 'done') {
      status = 'failed';
      errors.push(cancelRequested ? '已收到取消请求，但尚无远端单任务取消确认；任务可能仍在运行。' : '等待超时；尚无远端单任务取消确认，任务可能仍在运行。');
      meta.remote_task_may_be_running = true;
    }
  } catch (e) { errors.push(e.message); }
  finally {
    if (ownsInvocation && meta.session_id && status !== 'done') {
      try {
        await transport.request('CancelCascadeInvocation', { cascadeId: meta.session_id, killBackgroundTasks: true });
        let confirmed = false;
        for (let i = 0; i < 8; i++) {
          const state = await transport.request('GetCascadeTrajectory', { cascadeId: meta.session_id });
          if ((state.status ?? state.trajectory?.status) === 'CASCADE_RUN_STATUS_IDLE') { confirmed = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        meta.remote_cancel_confirmed = confirmed; meta.remote_task_may_be_running = !confirmed;
        if (confirmed) {
          errors = errors.filter((e) => !e.includes('尚无远端单任务取消确认'));
          if (cancelRequested) status = 'cancelled'; else errors.push('等待 Desktop 响应超时或执行失败；远端本次任务已停止。');
        }
        if (!confirmed) errors.push('远端单任务取消尚未确认；任务可能仍在运行。');
      } catch { meta.remote_cancel_confirmed = false; meta.remote_task_may_be_running = true; errors.push('远端取消接口失败，任务可能仍在运行。'); }
    }
    if (tracker && before) {
      try { const changes = tracker.diff(before, tracker.snap('after'), path.join(context.dir, 'discussion-changes.patch')); if (changes.files.length || changes.large_files_changed.length) { status = 'failed'; errors.push('Desktop 分析期间修改了工作区；详见 discussion-changes.patch。'); } }
      catch { status = 'failed'; errors.push('Desktop 工作区前后快照核验失败。'); }
    }
    tracker?.cleanup();
  }
  meta.status = status; writeMeta();
  fs.writeFileSync(path.join(context.dir, 'last-message.txt'), last);
  const parsed = schema && last ? parseReport(last, schema, validateSchema) : null;
  return finishDiscussion(run, { usage, cost: null, commands: null, errors, notes: [permissionWarning, '实验适配；用量仅按本轮 generatorMetadata 计数，缺失字段保留未知；实际模型验证状态见 meta.json。'], warnings: [...(parsed?.invalid.length ? ['回复未满足报告schema，保留公开正文供主控核验。'] : []), ...(meta.model_verification !== 'confirmed' ? ['未获得所有本轮 generator 的精确 native model，实际模型尚未完全验证。'] : [])], report: parsed?.report || null, last, files, observed: { messages: last ? [last] : [] }, changesNote: '已核验工作区前后快照。' });
}

export function desktopUsage(generators = []) {
  const fields = { input_tokens: 'inputTokens', output_tokens: 'outputTokens', reasoning_output_tokens: 'thinkingOutputTokens', cached_input_tokens: 'cacheReadTokens' };
  const values = {};
  for (const [key, native] of Object.entries(fields)) {
    const entries = generators.map((g) => g.chatModel?.usage?.[native]);
    values[key] = !entries.length || entries.some((v) => v == null || !Number.isFinite(Number(v)) || Number(v) < 0) ? null : entries.reduce((n, v) => n + Number(v), 0);
  }
  return Object.values(values).some((v) => v !== null) ? values : null;
}
