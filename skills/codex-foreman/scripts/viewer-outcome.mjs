import { groupRuns, findRun, runOutcome } from './records.mjs';

// 与组查看器一样忽略已被续接替代的旧轮次。
export function viewerProblems(payload) {
  const runs = payload.group ? groupRuns(payload.group, Date.now() - 86400000) : [findRun(payload.run)];
  const replaced = new Set(runs.map((run) => run.meta.parent).filter(Boolean));
  return runs.filter((run) => !replaced.has(run.id)).flatMap((run) => {
    const outcome = runOutcome(run);
    if (outcome.ok) return [];
    const details = outcome.result?.errors?.join('; ') || outcome.result?.questions?.map((item) => item.question).filter(Boolean).join('; ')
      || outcome.result?.report?.open_questions?.join('; ') || outcome.result?.report?.summary || '';
    return [`${run.id}: ${outcome.blocked ? 'needs_input' : outcome.status}${details ? ` — ${details}` : ''}`];
  });
}

export async function holdViewer(problems) {
  console.log(`\n讨论需要处理，窗口已保留：\n${problems.join('\n')}\n按 Enter 或 q 关闭查看窗口，后台任务不受影响。`);
  await new Promise((resolve) => {
    const timer = setInterval(() => {}, 60000);
    const finish = () => {
      clearInterval(timer);
      process.stdin.removeListener('data', onData);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve();
    };
    const onData = (data) => { if (/[qQ\r\n\u0003]/.test(String(data))) finish(); };
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}
