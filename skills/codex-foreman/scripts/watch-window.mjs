import fs from 'node:fs';
const payload = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
const lease = JSON.parse(fs.readFileSync(payload.lease, 'utf8'));
if (lease.token !== payload.token) process.exit(0);
fs.writeFileSync(payload.lease, JSON.stringify({ ...lease, pid: process.pid, pending: false }));
fs.writeFileSync(payload.ready, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), tty: !!process.stdout.isTTY, run: payload.run, group: payload.group }));
const release = () => {
  try { if (JSON.parse(fs.readFileSync(payload.lease)).token === payload.token) fs.rmSync(payload.lease); } catch { /* window may be forcibly closed */ }
};
process.once('exit', release);
process.env.CODEX_FOREMAN_RUNS_DIR = payload.root;
if (payload.session) process.env.CODEX_THREAD_ID = payload.session;
console.log(`Codex Foreman · 实时进度\n关闭窗口或按 q 只退出查看，后台任务继续。${payload.autoClose ? '同组任务正常完成后自动关闭；异常或需要处理时保留窗口。' : '完成后保留结果，可直接关闭窗口。'}\n`);
process.argv = [process.execPath, new URL('./cli.mjs', import.meta.url).pathname, 'watch', payload.group ? '--group' : '--run', payload.group || payload.run];
await import('./cli.mjs');
if (payload.autoClose) {
  const { viewerProblems, holdViewer } = await import('./viewer-outcome.mjs');
  let problems;
  try { problems = viewerProblems(payload); }
  catch (error) { problems = [`无法读取任务结果：${error.message}`]; }
  if (problems.length) await holdViewer(problems);
}
