import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createLatestRequest,filterRecords,selectionCounts,ticketReady,toggleSelection} from '../history-front/src/state.mjs';
import {startHistoryServer} from '../skills/codex-foreman/scripts/history-ui.mjs';
const filters={search:'',workspace:'',model:'',provider:'',status:'',from:'',to:''};
const records=[{id:'a',title:'修复中文任务',workspace:'A',model:'mimo',provider:'pi cli',status:'done'},{id:'b',title:'审查',workspace:'B',model:'gemini',provider:'antigravity desktop',status:'running'},{id:'c',title:'另一项',workspace:'A',model:'mimo',provider:'pi cli',status:'failed'}];
test('筛选保留跨工作区隐藏选择；Shift区间仅作用于可见ID',()=>{
  assert.deepEqual(filterRecords(records,{...filters,search:'中文',workspace:'A'}).map(r=>r.id),['a']);
  assert.deepEqual(filterRecords(records,{...filters,status:'running'}).map(r=>r.id),['b']);
  const selected=toggleSelection(new Set(['b']),'c',['a','c'],'a',true);
  assert.deepEqual([...selected].sort(),['a','b','c']);assert.deepEqual(selectionCounts(selected,['a','c']),{total:3,visible:2,hidden:1});
  assert.deepEqual([...toggleSelection(selected,'c',['a','c'],'a',true)],['b']);
});
test('删除凭证必须有效、未阻止且输入精确文案，过期不能确认',()=>{
  const data={ticket:'ticket',blocked:[]};
  assert.equal(ticketReady(data,'删除所选记录',5000,4999),true);
  for(const [value,text,time]of [[data,'删除',4000],[data,'删除所选记录',5000],[{...data,ticket:null},'删除所选记录',4000],[{...data,blocked:[{reason:'busy'}]},'删除所选记录',4000]])assert.equal(ticketReady(value,text,5000,time),false);
});
test('详情最新请求胜出，旧请求即使忽略取消也不能覆盖新记录；离开详情后不提交结果',async()=>{
  const latest=createLatestRequest(),accepted=[],rejected=[];let resolveFirst,resolveSecond;
  const first=latest.run(()=>new Promise(resolve=>resolveFirst=resolve),value=>accepted.push(value),error=>rejected.push(error));
  const second=latest.run(()=>new Promise(resolve=>resolveSecond=resolve),value=>accepted.push(value),error=>rejected.push(error));
  resolveSecond('B');await second;resolveFirst('A');await first;assert.deepEqual(accepted,['B']);assert.deepEqual(rejected,[]);
  let resolveRemoved;const removed=latest.run(()=>new Promise(resolve=>resolveRemoved=resolve),value=>accepted.push(value),error=>rejected.push(error));latest.cancel();resolveRemoved('removed');await removed;assert.deepEqual(accepted,['B']);
});
test('固定静态产物、源码许可及Gemini设计出处可核对',()=>{
  const root=new URL('../history-front/',import.meta.url),manifest=JSON.parse(fs.readFileSync(new URL('component-sources.json',root)));
  assert.equal(manifest.design.run_id,'20261101-114824-8jd1');assert.equal(manifest.design.native_model,'M319');
  for(const file of manifest.files){assert.equal(createHash('sha256').update(fs.readFileSync(new URL(file.original,root))).digest('hex'),file.sha256);assert.ok(fs.existsSync(new URL(file.adapted,root)));}
  const html=fs.readFileSync(new URL('../skills/codex-foreman/scripts/history-ui/index.html',import.meta.url),'utf8');
  assert.match(html,/src="\/app.js"/);assert.match(html,/href="\/style.css"/);assert.ok(!html.includes('https://'));assert.match(html,/FOREMAN_STYLE_NONCE/);
  for(const license of ['reui','shadcn','spectrum','beui'])assert.ok(fs.statSync(new URL(`vendor/licenses/${license}.LICENSE`,root)).size>700);
});
test('HTML深链只接受合法索引ID，动态style使用每响应nonce且script无放宽',async t=>{
  for(const port of [-1,80,65536,1.5,'50418'])await assert.rejects(startHistoryServer({port}),/端口/);
  const server=await startHistoryServer({port:0});t.after(()=>server.close());const id='a'.repeat(64);
  for(const route of ['/',`/?preview=${id}`,'/board/',`/board/?s=${id}`])assert.equal((await fetch(server.origin+route)).status,200);
  for(const route of [`/?preview=${id}&preview=${id}`,`/?s=${id}`,`/board/?preview=${id}`,'/?preview=../../etc',`/app.js?v=1`,`/style.css?v=1`])assert.equal((await fetch(server.origin+route)).status,400);
  const response=await fetch(server.origin),html=await response.text(),csp=response.headers.get('content-security-policy'),nonce=/name="foreman-style-nonce" content="([^"]+)"/.exec(html)?.[1];
  assert.ok(nonce);assert.ok(csp.includes(`'nonce-${nonce}'`));assert.match(csp,/script-src 'self';/);assert.ok(!csp.includes('unsafe-inline'));assert.ok(!csp.includes('unsafe-eval'));
  const next=await fetch(server.origin),nextHtml=await next.text();assert.ok(!nextHtml.includes(`content="${nonce}"`));
});
