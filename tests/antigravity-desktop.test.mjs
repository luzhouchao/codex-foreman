import test from 'node:test';
import assert from 'node:assert/strict';
import desktop, { createDesktopTransport, desktopCatalog, checkDesktop, desktopUsage, ensureDesktopProject, desktopWorkspaceKey } from '../skills/codex-foreman/scripts/adapters/antigravity-desktop.mjs';

// 只模拟已证实的只读目录 RPC；不模拟生成回答或取消成功。
const SECRET = 'synthetic-csrf-never-log';
const endpoint = 'http://127.0.0.1:45678';
const response = (data) => ({ ok: true, status: 200, json: async () => data });

test('桌面适配仅开放实验分析模式，不宣称续接或硬隔离', () => {
  assert.deepEqual(desktop.capabilities.modes, ['discuss', 'review']);
  assert.equal(desktop.capabilities.isolation, 'none');
  assert.equal(desktop.capabilities.resume, true);
});

test('桌面传输拒绝远程地址、外观相似域名和缺少 CSRF', async () => {
  let calls = 0;
  for (const address of ['http://example.com:45678', 'http://127.0.0.1.example.com', 'http://192.168.1.1:45678', 'http://0.0.0.0:45678']) {
    await assert.rejects(async () => {
      const transport = createDesktopTransport({ endpoint: address, token: SECRET, fetchImpl: async () => { calls++; return response({}); } });
      await transport.request('GetAvailableModels');
    });
  }
  await assert.rejects(async () => {
    const transport = createDesktopTransport({ endpoint, token: '', fetchImpl: async () => { calls++; return response({}); } });
    await transport.request('GetAvailableModels');
  });
  assert.equal(calls, 0);
});

test('桌面传输仅允许只读目录 RPC，不能用 check 发送推理或取消', async () => {
  const calls = [];
  const transport = createDesktopTransport({ endpoint, token: SECRET, fetchImpl: async (...args) => { calls.push(args); return response({ response: { models: [] } }); } });
  for (const method of ['StartCascade', 'SendUserCascadeMessage', 'CancelCascadeInvocation', 'GetUserStatus', 'ListProjects', 'ReadProject', 'CreateProject', '../StartCascade']) {
    await assert.rejects(async () => transport.request(method));
  }
  assert.equal(calls.length, 0);
  await transport.request('GetAvailableModels');
  assert.equal(calls.length, 1);
  assert.match(String(calls[0][0]), /GetAvailableModels$/);
});

test('桌面传输异常不得泄露 CSRF', async () => {
  const transport = createDesktopTransport({ endpoint, token: SECRET, fetchImpl: async () => { throw new Error(`network failure ${SECRET}`); } });
  await assert.rejects(transport.request('GetAvailableModels'), (error) => !String(error.stack).includes(SECRET));
});

const catalogData = { response: { models: {
  'gemini-4-argon-medium': { displayName: 'Gemini 4', model: 'NATIVE_GEMINI_4', maxTokens: 100000 },
  'gemini-3.8-flash-medium': { displayName: 'Gemini Flash', model: 'NATIVE_FLASH' },
} } };

test('桌面目录只读取元数据并保留精确 ID，不伪造回答或用量', async () => {
  const calls = [];
  const cat = await desktopCatalog({}, {
    discover: async () => [{ endpoint, token: SECRET }],
    transportFactory: () => ({ request: async (method) => { calls.push(method); return catalogData; } }),
  });
  assert.equal(cat.ok, true);
  assert.equal(cat.models[0].id, 'gemini-4-argon-medium');
  assert.equal(cat.models[0].native_id, 'NATIVE_GEMINI_4');
  assert.deepEqual(calls, ['GetAvailableModels']);
  assert.equal(JSON.stringify(cat).includes(SECRET), false);
  const check = await checkDesktop('agy', { model: 'gemini-4-argon-medium' }, [], async () => cat);
  assert.equal(check.ok, true);
  assert.equal(check.model_listed, true);
  assert.equal(check.inference_verified, false);
  assert.equal(check.reply, null);
  assert.equal(check.usage, null);
  assert.equal(check.cost, null);
});

test('桌面模型精确匹配，未知 ID、显示名和 native ID 均不降级', async () => {
  const cat = await desktopCatalog({}, {
    discover: async () => ({ endpoint, token: SECRET }),
    transportFactory: () => ({ request: async () => catalogData }),
  });
  for (const model of ['gemini-4', 'Gemini 4', 'NATIVE_GEMINI_4', 'gemini-4-argon-medium-unknown']) {
    const check = await checkDesktop('agy', { model }, [], async () => cat);
    assert.equal(check.ok, false, model);
    assert.equal(check.model_listed, false, model);
    assert.equal(check.model, model);
    assert.equal(check.reply, null);
  }
});

test('桌面目录发现和 RPC 错误不会泄露认证或响应正文', async () => {
  for (const injected of [
    { discover: async () => { throw new Error(SECRET); } },
    { discover: async () => ({ endpoint, token: SECRET }), transportFactory: () => ({ request: async () => { throw new Error(SECRET); } }) },
    { discover: async () => ({ endpoint, token: SECRET }), transportFactory: () => ({ request: async () => ({ text: SECRET }) }) },
  ]) {
    const cat = await desktopCatalog({}, injected);
    assert.equal(cat.ok, false);
    assert.deepEqual(cat.models, []);
    assert.equal(JSON.stringify(cat).includes(SECRET), false);
  }
});

test('桌面 HTTP 禁止重定向，CSRF 只进入请求头', async () => {
  let observed;
  const transport = createDesktopTransport({ endpoint, token: SECRET, fetchImpl: async (url, init) => { observed = { url, init }; return response({}); } });
  await transport.request('GetAvailableModels');
  assert.equal(observed.init.redirect, 'error');
  assert.equal(observed.init.headers['x-codeium-csrf-token'], SECRET);
  assert.equal(observed.url.includes(SECRET), false);
  assert.equal(observed.init.body.includes(SECRET), false);
  assert.ok(observed.init.signal instanceof AbortSignal);
});


test('桌面实验执行入口拒绝未显式授权、run 和缺少 session 的续接', async () => {
  await assert.rejects(desktop.execute({ agent: {}, opts: {} }), /experimental/);
  await assert.rejects(desktop.execute({ opts: {}, agent: { experimental: true }, kind: 'exec' }), /run/);
  await assert.rejects(desktop.execute({ opts: {}, agent: { experimental: true }, kind: 'discuss', parent: {} }), /session|续接/);
});

test('桌面实验 RPC 仍拒绝任意方法，不将元数据当执行结果', async () => {
  const calls = [];
  const transport = createDesktopTransport({ endpoint, token: SECRET, experimental: true, fetchImpl: async (url) => { calls.push(url); return response({}); } });
  for (const method of ['UnknownMethod', '../StartCascade', 'DeleteCascade', 'ExecuteCommand']) await assert.rejects(transport.request(method));
  assert.equal(calls.length, 0);
});

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox, baseConfig, json } from './helpers.mjs';
import { initializeRecords } from '../skills/codex-foreman/scripts/records.mjs';

async function executeFixture(t, scenario = {}) {
  const h = sandbox(t), cfg = baseConfig();
  cfg.agents.desktop = { type: 'antigravity desktop', experimental: true };
  cfg.dispatch.runs_dir = path.join(h.cwd, '.runs');
  initializeRecords(cfg, h.cwd);
  const calls = [];
  const executionCwd = scenario.nestedCwd ? path.join(h.cwd, 'review sandbox 材料') : h.cwd;
  fs.mkdirSync(executionCwd, { recursive: true });
  if (scenario.nestedCwd) fs.writeFileSync(path.join(executionCwd, 'material.txt'), '来自执行目录的材料');
  const ctx = { ...scenario.context, agent: { type: 'antigravity desktop', experimental: true }, agentName: 'desktop', model: 'gemini-4-argon-medium', kind: 'review', mode: 'review', cwd: executionCwd, brief: '分析测试', opts: { file: [], timeout: scenario.timeout || 0.1 }, cfg, level: 'complex', ...scenario.context };
  let polls = 0;
  const oldExit = process.exitCode;
  try {
    const result = await desktop.execute(ctx, {
      discover: async () => [{ endpoint, token: SECRET, pid: 999999 }],
      transportFactory: () => ({ request: async (method, body) => {
        calls.push({ method, body });
        if (method === 'GetAvailableModels') return catalogData;
        if (method === 'ListProjects') return { projectIds: ['fixture-project'] };
        if (method === 'ReadProject') return { project: { id: 'fixture-project', name: 'fixture', projectResources: { resources: [{ folderUri: pathToFileURL(h.cwd).href }] } } };
        if (method === 'StartCascade') return { cascadeId: 'synthetic-cascade', projectEnvInfo: { workspaceUris: [pathToFileURL(h.cwd).href] } };
        if (method === 'SendUserCascadeMessage') { scenario.onSend?.(h); return {}; }
        if (method === 'CancelCascadeInvocation') { scenario.onCancel?.(h); return {}; }
        if (method === 'GetCascadeTrajectory') {
          polls++;
          if (scenario.trajectory) return scenario.trajectory(polls, calls, h);
          return { status: 'CASCADE_RUN_STATUS_IDLE', trajectory: { steps: [{ plannerResponse: { response: '完整公开回复。' } }] } };
        }
        throw new Error('Unexpected RPC');
      } }),
    });
    return { result, calls, h };
  } finally { process.exitCode = oldExit; }
}

test('桌面执行固定精确 native model、工作区和独立运行记录，未知用量保持 null', async (t) => {
  const { result, calls, h } = await executeFixture(t);
  assert.equal(result.status, 'done');
  assert.equal(result.usage, null);
  assert.equal(result.cost_usd, null);
  assert.equal(result.cwd, h.cwd);
  assert.ok(result.run_dir.startsWith(path.join(h.cwd, '.runs') + path.sep));
  assert.equal(calls.find(c => c.method === 'StartCascade').body.requestedModel, 'NATIVE_GEMINI_4');
  assert.equal(calls.find(c => c.method === 'SendUserCascadeMessage').body.cascadeConfig.plannerConfig.requestedModel.model, 'NATIVE_GEMINI_4');
  assert.equal(JSON.stringify(json(path.join(result.run_dir, 'meta.json'))).includes(SECRET), false);
  assert.equal(calls.some(c => c.method === 'CancelCascadeInvocation'), false);
});

test('桌面只读快照发现工作区变化必须报警并判失败', async (t) => {
  const { result } = await executeFixture(t, { onSend: h => fs.writeFileSync(path.join(h.cwd, 'unexpected.txt'), 'changed') });
  assert.equal(result.status, 'failed');
  assert.match(result.errors.join('\n'), /修改了工作区/);
});



test('桌面元数据和空轨迹不能当完整回答，超时真实请求取消并确认状态', async (t) => {
  const { result, calls } = await executeFixture(t, { timeout: 0.001, trajectory: (_poll, calls) => ({ status: calls.some(c => c.method === 'CancelCascadeInvocation') ? 'CASCADE_RUN_STATUS_IDLE' : 'CASCADE_RUN_STATUS_RUNNING', trajectory: { steps: [{ metadata: { title: '只是一段元数据' } }] } }) });
  assert.equal(result.status, 'failed');
  assert.equal(result.last_message, '');
  const cancel = calls.findIndex(c => c.method === 'CancelCascadeInvocation');
  assert.ok(cancel >= 0);
  assert.equal(calls[cancel].body.cascadeId, 'synthetic-cascade');
  assert.ok(calls.slice(cancel + 1).some(c => c.method === 'GetCascadeTrajectory'));
  const meta = json(path.join(result.run_dir, 'meta.json'));
  assert.equal(meta.remote_cancel_confirmed, true);
  assert.equal(meta.remote_task_may_be_running, false);
});

test('桌面用户取消须远端 CancelCascadeInvocation 后确认 IDLE 才标 cancelled', async (t) => {
  const { result, calls } = await executeFixture(t, {
    onSend: h => {
      const runs = path.join(h.cwd, '.runs');
      const dir = fs.readdirSync(runs).find(name => fs.existsSync(path.join(runs, name, 'meta.json')));
      fs.writeFileSync(path.join(runs, dir, 'cancel'), 'requested');
    },
    trajectory: (_poll, calls) => ({ status: calls.some(c => c.method === 'CancelCascadeInvocation') ? 'CASCADE_RUN_STATUS_IDLE' : 'CASCADE_RUN_STATUS_RUNNING', trajectory: { steps: [] } }),
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(calls.filter(c => c.method === 'CancelCascadeInvocation').length, 1);
  assert.equal(json(path.join(result.run_dir, 'meta.json')).remote_cancel_confirmed, true);
});

test('桌面远端取消失败不能伪造 cancelled 或宣称任务停止', async (t) => {
  const { result } = await executeFixture(t, { timeout: 0.001, onCancel: () => { throw new Error('synthetic cancellation failure'); }, trajectory: () => ({ status: 'CASCADE_RUN_STATUS_RUNNING', trajectory: { steps: [] } }) });
  assert.equal(result.status, 'failed');
  const meta = json(path.join(result.run_dir, 'meta.json'));
  assert.equal(meta.remote_cancel_confirmed, false);
  assert.equal(meta.remote_task_may_be_running, true);
  assert.match(result.errors.join('\n'), /远端取消接口失败/);
});



test('桌面 generator usage 只求本轮显式数据，缺失与零值不同', () => {
  assert.equal(desktopUsage(), null);
  assert.equal(desktopUsage([{ chatModel: {} }]), null);
  assert.deepEqual(desktopUsage([{ chatModel: { usage: { inputTokens: 0, outputTokens: 0 } } }]), { input_tokens: 0, output_tokens: 0, reasoning_output_tokens: null, cached_input_tokens: null });
  const usage = desktopUsage([{ chatModel: { usage: { inputTokens: 2, outputTokens: 3, thinkingOutputTokens: 1 } } }, { chatModel: { usage: { inputTokens: 4, outputTokens: 5 } } }]);
  assert.equal(usage.input_tokens, 6);
  assert.equal(usage.output_tokens, 8);
  assert.equal(usage.reasoning_output_tokens, null);
});

test('桌面 startup 空 steps 是暂态，随后公开完整回复才能完成', async (t) => {
  const { result, calls } = await executeFixture(t, { trajectory: poll => poll === 1 ? { status: 'CASCADE_RUN_STATUS_RUNNING', trajectory: {} } : { status: 'CASCADE_RUN_STATUS_IDLE', trajectory: { steps: [{ plannerResponse: { response: '稍后返回的公开回复。' } }] } } });
  assert.equal(result.status, 'done');
  assert.match(result.last_message, /稍后返回/);
  assert.equal(calls.filter(c => c.method === 'GetCascadeTrajectory').length, 2);
});

test('桌面 resume 复用空闲会话，仅返回新增 steps 与 generator usage', async (t) => {
  const oldStep = { plannerResponse: { response: '旧回复' } };
  const newStep = { plannerResponse: { response: '本轮新回复' } };
  const oldGenerator = { chatModel: { usage: { inputTokens: 100, outputTokens: 100 } } };
  const newGenerator = { chatModel: { usage: { inputTokens: 5, outputTokens: 6 } } };
  const { result, calls } = await executeFixture(t, { context: { mode: 'resume', parent: 'old-run', sessionId: 'saved-cascade' }, trajectory: poll => ({ status: 'CASCADE_RUN_STATUS_IDLE', trajectory: { steps: poll === 1 ? [oldStep] : [oldStep, newStep], generatorMetadata: poll === 1 ? [oldGenerator] : [oldGenerator, newGenerator] } }) });
  assert.equal(result.status, 'done');
  assert.equal(result.session_id, 'saved-cascade');
  assert.deepEqual(json(path.join(result.run_dir, 'meta.json')).desktop_workspace, { assignment: 'preserved_existing_session', requested_uri: null, workspace: null });
  assert.equal(result.last_message, '本轮新回复');
  assert.equal(result.usage.input_tokens, 5);
  assert.equal(result.usage.output_tokens, 6);
  assert.equal(calls.some(c => ['StartCascade', 'ListProjects', 'ReadProject', 'CreateProject'].includes(c.method)), false);
  assert.equal(calls.find(c => c.method === 'SendUserCascadeMessage').body.cascadeId, 'saved-cascade');
});

test('桌面 resume 拒绝忙碌会话且不取消共享的原任务', async (t) => {
  const { result, calls } = await executeFixture(t, { context: { mode: 'resume', parent: 'old-run', sessionId: 'busy-cascade' }, trajectory: () => ({ status: 'CASCADE_RUN_STATUS_RUNNING', trajectory: { steps: [] } }) });
  assert.equal(result.status, 'failed');
  assert.match(result.errors.join('\n'), /原会话未空闲/);
  assert.equal(calls.some(c => c.method === 'SendUserCascadeMessage'), false);
  assert.equal(calls.some(c => c.method === 'CancelCascadeInvocation'), false);
});

import { ROOT } from './helpers.mjs';

test('CLI resume 在配置默认模型不同的情况下继承 Desktop 父模型，显式覆盖仍生效', async () => {
  // 对实际命令函数做依赖替换，避免为验证路由启动真实 Desktop LS。
  const source = fs.readFileSync(path.join(ROOT, 'skills/codex-foreman/scripts/cli.mjs'), 'utf8');
  const resumeSource = source.slice(source.indexOf('async function cmdResume('), source.indexOf('\nasync function cmdReview('));
  assert.ok(resumeSource.startsWith('async function cmdResume('));
  const parent = { id: 'parent', dir: '/fixture/run', meta: { kind: 'discuss', agent_type: 'antigravity desktop', agent: 'desktop', model: 'gemini-4-argon-medium', session_id: 'saved-session', cwd: '/fixture/workspace' } };
  const cfg = { dispatch: { discuss_max_rounds: 3 }, agents: { desktop: { model: 'gemini-3.8-flash-medium' } } };
  let observed;
  const dependencies = {
    findRun: () => parent, need: (o, key) => o[key], agentTypeOf: m => m.agent_type,
    adapters: { 'antigravity desktop': { execute: async ctx => ctx } },
    load: () => cfg, readBrief: () => '继续', readMeta: () => null, path, RUNS_ROOT: '/fixture',
    die: message => { throw new Error(message); }, M: {},
    pickProfile: (_cfg, opts) => { observed = opts.model || cfg.agents.desktop.model; return { agent: { type: 'antigravity desktop' }, model: observed }; },
  };
  const command = new Function(...Object.keys(dependencies), `${resumeSource}; return cmdResume;`)(...Object.values(dependencies));
  for (const [explicit, expected] of [[undefined, parent.meta.model], ['gemini-3.8-flash-medium', 'gemini-3.8-flash-medium']]) {
    const result = await command({ run: 'parent', track: [], scope: [], model: explicit });
    assert.equal(observed, expected);
    assert.equal(result.model, expected);
    assert.equal(result.sessionId, 'saved-session');
    assert.equal(result.cwd, '/fixture/workspace');
  }
});

test('桌面任一本轮 generator native 模型不匹配必须失败，不能用首个匹配掩盖', async (t) => {
  const { result, calls } = await executeFixture(t, { trajectory: (_poll, calls) => ({ status: 'CASCADE_RUN_STATUS_IDLE', trajectory: { steps: [{ plannerResponse: { response: '公开回答' } }], generatorMetadata: [{ chatModel: { model: 'NATIVE_GEMINI_4' } }, { chatModel: { model: 'NATIVE_FLASH' } }] } }) });
  assert.equal(result.status, 'failed');
  assert.ok(calls.some(c => c.method === 'CancelCascadeInvocation'));
});


test('桌面新会话归属主工作区，临时 cwd 仍用于材料和快照', async (t) => {
  const { result, calls, h } = await executeFixture(t, {
    nestedCwd: true,
    context: { opts: { file: ['material.txt'], timeout: 0.1 } },
    onSend: h => fs.writeFileSync(path.join(h.cwd, 'review sandbox 材料', 'changed.txt'), 'changed'),
  });
  const executionCwd = path.join(h.cwd, 'review sandbox 材料');
  const uri = pathToFileURL(h.cwd + path.sep).href;
  assert.deepEqual(calls.find(c => c.method === 'StartCascade').body.projectEnvConfig, { projectId: 'fixture-project', defaultProjectEnvironment: {} });
  assert.equal(calls.find(c => c.method === 'StartCascade').body.overrideWorkspaceUris, undefined);
  const prompt = calls.find(c => c.method === 'SendUserCascadeMessage').body.items[0].text;
  assert.ok(prompt.includes(executionCwd));
  assert.equal(result.files[0].path, path.join(executionCwd, 'material.txt'));
  assert.equal(result.cwd, executionCwd);
  assert.equal(result.status, 'failed');
  assert.match(result.errors.join('\n'), /修改了工作区/);
  assert.deepEqual(json(path.join(result.run_dir, 'meta.json')).desktop_workspace,
    { assignment: 'main_workspace', requested_uri: uri, workspace: h.cwd });
});


test('Project 按完整路径复用，大小写、编码与尾分隔符一致，同名异路径新建并回读', async () => {
  assert.equal(desktopWorkspaceKey('file:///e%3A/subagent/'), desktopWorkspaceKey('file:///E:/SUBAGENT'));
  const projects = [{ id: 'other', name: 'subagent', projectResources: { resources: [{ folderUri: 'file:///D:/subagent' }] } }];
  const calls = [];
  const transport = { request: async (method, body) => {
    calls.push(method);
    if (method === 'ListProjects') return { projectIds: projects.map(p => p.id) };
    if (method === 'ReadProject') return { project: projects.find(p => p.id === body.id) };
    if (method === 'CreateProject') { projects.push(body.project); return {}; }
    throw new Error(method);
  } };
  const first = await ensureDesktopProject(transport, 'E:\\subagent');
  assert.equal(first.created, true);
  assert.equal(first.name, 'subagent');
  assert.equal(projects[1].isWorkspaceOnly, false);
  const [second, concurrent] = await Promise.all([ensureDesktopProject(transport, 'E:\\subagent'), ensureDesktopProject(transport, 'E:\\subagent')]);
  assert.equal(concurrent.id, first.id);
  assert.equal(second.id, first.id);
  assert.equal(second.created, false);
  assert.equal(calls.filter(m => m === 'CreateProject').length, 1);
});

test('项目列表或读取失败时拒绝创建，重复完整路径拒绝猜测', async () => {
  await assert.rejects(ensureDesktopProject({ request: async () => ({ error: 'bad response' }) }, 'E:\\subagent'), /列表/);
  await assert.rejects(ensureDesktopProject({ request: async method => method === 'ListProjects' ? { projectIds: ['broken'] } : { errorMessage: 'unreadable' } }, 'E:\\subagent'), /元数据/);
  await assert.rejects(ensureDesktopProject({ request: async method => method === 'ListProjects' ? { projectIds: ['a', 'b'] } : { project: { id: 'x', projectResources: { resources: [{ folderUri: 'file:///E:/subagent' }] } } } }, 'E:\\subagent'), /多个/);
});


test('Project 实际轨迹归属不一致时失败并取消自己创建的会话', async (t) => {
  const { result, calls } = await executeFixture(t, { trajectory: () => ({ status: 'CASCADE_RUN_STATUS_IDLE', trajectory: { metadata: { projectId: 'wrong-project' }, steps: [{ plannerResponse: { response: '错误归属' } }] } }) });
  assert.equal(result.status, 'failed');
  assert.match(result.errors.join(' '), /实际 Project/);
  assert.ok(calls.some(c => c.method === 'CancelCascadeInvocation'));
});


test('隐藏 workspace-only 项目不作为 UI Project 复用，空 ProtoJSON 列表允许首次创建', async () => {
  for (const empty of [false, true]) {
    const projects = empty ? [] : [{ id: 'hidden-workspace', name: 'subagent', isWorkspaceOnly: true, projectResources: { resources: [{ folderUri: 'file:///E:/subagent' }] } }];
    let created = 0;
    const transport = { request: async (method, body) => {
      if (method === 'ListProjects') return projects.length ? { projectIds: projects.map(p => p.id) } : {};
      if (method === 'ReadProject') return { project: projects.find(p => p.id === body.id) };
      if (method === 'CreateProject') { created++; projects.push(body.project); return {}; }
      throw new Error(method);
    } };
    const result = await ensureDesktopProject(transport, 'E:\\subagent');
    assert.equal(result.created, true);
    assert.notEqual(result.id, 'hidden-workspace');
    assert.equal(created, 1);
    assert.equal(projects.at(-1).isWorkspaceOnly, false);
    const reused = await ensureDesktopProject(transport, 'E:\\subagent');
    assert.equal(reused.id, result.id);
    assert.equal(created, 1);
  }
});

test('错误或畸形 ListProjects 响应不能伪装成空列表触发创建', async () => {
  for (const malformed of [null, [], { error: 'failed' }, { code: 'internal', message: 'failed' }, { projectIds: null }, { projectIds: 'id' }, { projectIds: [null] }]) {
    const calls = [];
    await assert.rejects(ensureDesktopProject({ request: async method => { calls.push(method); return malformed; } }, 'E:\\subagent'), /列表/);
    assert.deepEqual(calls, ['ListProjects']);
  }
});
