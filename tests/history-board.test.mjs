import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildBoard, boardAssets } from '../skills/codex-foreman/scripts/history-board.mjs';
import { startHistoryServer } from '../skills/codex-foreman/scripts/history-ui.mjs';
import { registerHistoryRun, listHistory } from '../skills/codex-foreman/scripts/history.mjs';

const scriptRoot = new URL('../skills/codex-foreman/scripts/', import.meta.url);
const record = (id, workspace, status = 'done') => ({ id: id.repeat(64), run_id: `20261101-010101-${id.repeat(4)}`, workspace,
  started_at: '2026-11-01T00:00:00Z', ended_at: status === 'running' ? null : '2026-11-01T00:02:00Z',
  model: 'opencode-go/mimo-v2.6-flash', agent: 'mimo', provider: 'pi cli', title: '<img src=x onerror=alert(1)>调用', status });

test('跨工作区真实调用投影为原版星图协议，所有ID保留索引ID且未伪造用量/并发上限', () => {
  const input = [record('a', 'E:\\工作区 A'), record('b', 'E:\\工作区 B', 'running'), record('c', 'E:\\工作区 A', 'failed')];
  const { universe, snapshots } = buildBoard(input, { now: 1793491200000 });
  assert.equal(universe.projects.length, 2); assert.equal(universe.sessions.length, 3);
  assert.deepEqual(universe.agents, []); assert.equal(universe.scope, 'all-registered-workspaces');
  assert.equal(universe.sessions[1].counts.running, 1); assert.equal(universe.sessions[2].counts.failed, 1);
  for (const source of input) {
    const session = universe.sessions.find(value => value.id === source.id), snapshot = snapshots[source.id];
    assert.equal(session.title, source.title); assert.equal(session.project, source.workspace);
    assert.equal(snapshot.runs[0].id, source.id); assert.equal(snapshot.runs[0].source_run_id, source.run_id);
    assert.equal(snapshot.runs[0].usage, null); assert.equal(snapshot.runs[0].cost_usd, null);
    assert.deepEqual(snapshot.events, []); assert.equal(snapshot.hello.mode, 'live');
  }
});

test('投影只允许合法记录ID，拒绝无时间记录，不泄漏来源对象的认证与私有转录字段', () => {
  const source = { ...record('a', 'E:\\safe'), authorization: 'Bearer private', transcript: 'PRIVATE THINKING', reasoning: 'SECRET', private_path: 'C:\\secret' };
  const result = buildBoard([source, { ...record('b','E:\\bad'), id: '../../outside' }, { ...record('c','E:\\bad'), started_at: undefined }]);
  assert.equal(result.universe.sessions.length, 1); assert.equal(Object.keys(result.snapshots).length, 1);
  const serialized = JSON.stringify(result);
  for (const forbidden of ['Bearer private','PRIVATE THINKING','SECRET','private_path','C:\\\\secret']) assert.ok(!serialized.includes(forbidden));
});

test('星图按真实kind/mode/effort区分讨论、审查和旧记录模式', () => {
  const input = [{...record('a','E:\\project'),kind:'discuss',mode:'resume',effort:'low'}, {...record('b','E:\\project'),kind:'review',mode:'review',effort:'high'}, {...record('c','E:\\project'),mode:'discuss'}];
  const result = buildBoard(input);
  assert.deepEqual(input.map(source => result.snapshots[source.id].runs[0].kind), ['discuss','review','discuss']);
  assert.equal(result.snapshots[input[0].id].runs[0].mode,'resume'); assert.equal(result.snapshots[input[0].id].runs[0].effort,'low');
  assert.equal(result.snapshots[input[1].id].runs[0].effort,'high');
});

test('管理页日期筛选使用本地日历，UTC午夜前后与显示的当地日期一致', () => {
  const statePath = new URL('../history-front/src/state.mjs',import.meta.url).href;
  const script = `import {localDateKey} from ${JSON.stringify(statePath)}; process.stdout.write(JSON.stringify([localDateKey("2026-11-01T16:01:00Z"),localDateKey("2026-11-01T00:01:00Z"),localDateKey("invalid"),localDateKey(null)]));`;
  const dates = timezone => JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,TZ:timezone},encoding:'utf8'}));
  assert.deepEqual(dates('Asia/Shanghai'),['2026-11-02','2026-11-01','','']);
  assert.deepEqual(dates('America/Los_Angeles'),['2026-11-01','2026-10-31','','']);
});

test('摘要状态不套用上游完整报告校验，缺失usage的讨论/审查仍显示真实done状态', () => {
  const adapter = fs.readFileSync(new URL('history-web/adapter.js',scriptRoot),'utf8');
  const context = vm.createContext({upstream_seatStatus(){throw Error('must not validate a missing report')},upstream_fateAt(){throw Error('must use metadata status')}});
  vm.runInContext(adapter.slice(adapter.indexOf('function seatStatus('),adapter.indexOf('function fillCard(')),context);
  const input = [{...record('a','E:\\project'),kind:'discuss'}, {...record('b','E:\\project'),kind:'review',status:'failed'}, {...record('c','E:\\project','running'),status:'queued'}];
  const board = buildBoard(input);
  for (const source of input) {
    const run = board.snapshots[source.id].runs[0]; context.run = run; context.t = Date.parse('2026-11-02T00:00:00Z');
    const state = vm.runInContext('seatStatus(null,run,t)',context); assert.equal(state.style.word,source.status);
    assert.equal(vm.runInContext('fateAt(null,run,t)',context),source.status === 'done' ? 'done' : source.status === 'queued' ? 'queued' : 'failed');
    assert.equal(run.usage,null); assert.equal(run.cost_usd,null); assert.ok(Number.isFinite(board.universe.sessions.find(s=>s.id===source.id).last_at));
  }
});

test('完整上游渲染/头像与MIT来源可复核，生成脚本可解析且DOM动态文本不使用HTML插值', () => {
  const provenance = JSON.parse(fs.readFileSync(new URL('history-web/upstream.json',scriptRoot),'utf8'));
  assert.equal(provenance.commit,'a1e52825b42e4137188ef0d7d2ecaf689147556c');
  assert.equal(provenance.license,'MIT'); assert.ok(provenance.files.length > 40);
  assert.match(fs.readFileSync(new URL('history-web/upstream/LICENSE',scriptRoot),'utf8'), /Copyright \(c\) 2026 DaydayupV/);
  for (const entry of provenance.files) assert.equal(createHash('sha256').update(fs.readFileSync(new URL(`history-web/${entry.file}`,scriptRoot))).digest('hex'),entry.sha256);
  const app = fs.readFileSync(new URL('history-web/app.js',scriptRoot),'utf8');
  new vm.Script(app); assert.match(app,/function drawUniverse\(/); assert.match(app,/function flyIn\(/); assert.match(app,/data:image\/png;base64,/);
  const management = fs.readFileSync(new URL('history-ui/app.js',scriptRoot),'utf8'); new vm.Script(management);
  const source = fs.readFileSync(new URL('../history-front/src/App.tsx',import.meta.url),'utf8');
  assert.ok(!source.includes('dangerouslySetInnerHTML')); assert.match(source,/data.answer\|\|/);
  for (const [route,[file]] of boardAssets) { assert.ok(route.startsWith('/board/')); assert.ok(fs.statSync(new URL(file,scriptRoot)).isFile()); }
});

test('HTTP星图API沿用Bearer鉴权、严格id查询和安全静态资产，两个工作区可从同一服务读取', async t => {
  const previous = process.env.CODEX_HOME, home = fs.mkdtempSync(path.join(os.tmpdir(),'foreman-board-'));
  process.env.CODEX_HOME = path.join(home,'.codex');
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; fs.rmSync(home,{recursive:true,force:true}); });
  for (let i = 0; i < 2; i++) {
    const workspace = path.join(home,`workspace-${i}`), root = path.join(workspace,'.codex','foreman','runs'), run = `20261101-01010${i}-abcd`, dir = path.join(root,run);
    const meta = { source:'codex-foreman',id:run,workspace_root:workspace,cwd:workspace,agent:'test',agent_type:'pi cli',model:'test/model',kind:i?'review':'discuss',mode:i?'review':'discuss',effort:i?'high':'low',status:'done',started_at:'2026-11-01T00:00:00Z',ended_at:'2026-11-01T00:01:00Z' };
    fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,'meta.json'),JSON.stringify(meta)); registerHistoryRun({root,workspace,meta});
  }
  const server = await startHistoryServer(); t.after(() => server.close());
  const headers = { Authorization:`Bearer ${new URL(server.url).hash.slice(1)}` };
  assert.equal((await fetch(`${server.origin}/api/board`)).status,401);
  const response = await fetch(`${server.origin}/api/board`,{headers}), universe = await response.json();
  assert.equal(response.status,200); assert.equal(universe.projects.length,2); assert.equal(universe.sessions.length,2);
  for (const record of listHistory()) { const run = universe.sessions.find(s=>s.id===record.id).runs[0]; assert.equal(run.kind,record.kind); assert.equal(run.mode,record.mode); assert.equal(run.effort,record.effort); }
  assert.deepEqual(new Set(universe.sessions.map(s=>s.runs[0].kind)),new Set(['discuss','review']));
  const id = listHistory()[0].id;
  assert.equal((await fetch(`${server.origin}/api/board?id=${id}`,{headers})).status,200);
  assert.equal((await fetch(`${server.origin}/api/board?id=${'f'.repeat(64)}`,{headers})).status,404);
  for (const query of ['?path=C:/secret','?id=../../outside',`?id=${id}&id=${id}`,`?id=${id}&extra=1`]) assert.equal((await fetch(`${server.origin}/api/board${query}`,{headers})).status,400);
  for (const route of boardAssets.keys()) { const asset = await fetch(server.origin+route); assert.equal(asset.status,200); assert.match(asset.headers.get('content-security-policy'), /script-src 'self'/); }
  assert.equal((await fetch(`${server.origin}/board/upstream/display.mjs`)).status,404);
});
