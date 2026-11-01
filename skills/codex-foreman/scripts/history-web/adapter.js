// Codex Foreman integration. The upstream renderer and camera stay intact; only its transport is replaced.
const HISTORY_TOKEN_KEY = 'codex-foreman-history-token';
const HISTORY_TOKEN = (() => {
  const value = location.hash.slice(1);
  if (/^[a-f0-9]{64}$/.test(value)) { sessionStorage.setItem(HISTORY_TOKEN_KEY, value); history.replaceState(null, '', location.pathname + location.search); return value; }
  return sessionStorage.getItem(HISTORY_TOKEN_KEY) || '';
})();
U.demo = false; U.page.replay = null; U.page.t = null; B.params.replay = null; B.params.t = null;
TEXT.costTitle = '历史索引未采集费用，显示 —。'; TEXT.nowTitle = TEXT.recentTitle = TEXT.genAvgTitle = '历史索引未采集 token 用量或生成速度，显示 —。';
TABLE_HEAD.splice(0, TABLE_HEAD.length, '', '模型', '状态', '当前速度', '速度曲线', '平均速度', '输入 / 缓存', '输出', '费用', '用时');
UNI_HEAD.splice(0, UNI_HEAD.length, '', '调用', '工作区', '状态', '运行', '完成 · 其他', '输入 / 缓存', '输出', '费用', '最近');
function seatStatus(lane, run, t) {
  if (!run?.history_summary) return upstream_seatStatus(lane, run, t);
  // The history index knows metadata status, but does not validate report completeness.
  const busy = ['running', 'starting', 'queued'].includes(run.status), ok = ['done', 'completed', 'success', 'succeeded'].includes(run.status), blocked = run.status === 'needs_input';
  const kind = busy ? run.queued ? 'queued' : 'running' : ok ? 'ok' : blocked ? 'blocked' : 'failed';
  const style = { mark: busy ? run.queued ? '⋯' : '●' : ok ? '✔' : blocked ? '?' : '✗', word: run.status, color: text => text };
  return { kind, running: busy, style, right: [run.status] };
}
function fateAt(lane, run, t) {
  if (!run?.history_summary) return upstream_fateAt(lane, run, t);
  if (run.started_at > t) return null;
  const state = seatStatus(lane, run, t);
  return state.kind === 'ok' ? 'done' : run.status === 'cancelled' ? 'cancelled' : state.kind;
}
function fillCard(el, lane, t) {
  upstream_fillCard(el, lane, t);
  const rate = el.querySelector('.rate'); rate.textContent = '用量 / 生成速度：未采集'; rate.title = TEXT.nowTitle;
  const run = currentRun(lane, t) || latest(lane), state = seatStatus(lane, run, t);
  if (run?.history_summary && !state.running && run.ended_at == null) setText(el.querySelector('.st'), `${state.style.mark} ${run.status} · 未记录结束时间`);
}
function renderTable(t) {
  const done = upstream_renderTable(t);
  for (const row of $('usage').querySelectorAll('.tr[data-lane], .tr.total')) for (const index of [3,4,5,6,7,8]) {
    const cell = row.children[index]; if (cell) { cell.replaceChildren(document.createTextNode('—')); cell.title = '历史索引未采集此项'; }
  }
  return done;
}
let historyUniverseTimer = null, historyBoardTimer = null, historyBoardGeneration = 0, historyUniverseGeneration = 0;
async function historyFetch(path) {
  const response = await fetch(path, { headers: { Authorization: `Bearer ${HISTORY_TOKEN}` }, cache: 'no-store' });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}
function connectUniverse() {
  if (historyUniverseTimer || streamsReleased) return;
  const generation = ++historyUniverseGeneration;
  const tick = async () => {
    try {
      const value = await historyFetch('/api/board');
      if (generation !== historyUniverseGeneration) return;
      uHello({ v: 3, mode: 'live', now: value.now, window_h: null });
      const old = new Set(U.sessions.keys());
      for (const project of value.projects) uProject(project);
      for (const session of value.sessions) { uSession(session, !U.loadedAt); old.delete(session.id); }
      for (const id of old) uGone({ id });
      const projects = new Set(value.projects.map(project => project.key));
      for (const key of U.projects.keys()) if (!projects.has(key)) U.projects.delete(key);
      U.agents = []; U.loadedAt ??= performance.now(); U.version++; U.error = null; U.lostAt = null;
      if (!value.sessions.length) showNotice('暂无可显示的调用。请先在记录管理中刷新已登记工作区。', true);
    } catch (error) { if (generation === historyUniverseGeneration) { U.error = error.message; showNotice(error.message, true); } }
    if (generation === historyUniverseGeneration) historyUniverseTimer = setTimeout(tick, 2000);
  };
  historyUniverseTimer = -1; tick();
}
function disconnectUniverse() { ++historyUniverseGeneration; clearTimeout(historyUniverseTimer); historyUniverseTimer = null; }
function connect() {
  if (historyBoardTimer || streamsReleased) return;
  const id = B.params.session, generation = ++historyBoardGeneration;
  if (!/^[a-f0-9]{64}$/.test(id || '')) { showNotice('调用标识无效，请返回星图。', true); return; }
  const tick = async () => {
    try {
      const value = await historyFetch(`/api/board?id=${encodeURIComponent(id)}`);
      if (generation !== historyBoardGeneration) return;
      if (!B.hello) onHello(value.hello);
      for (const run of value.runs) onRun(run);
      B.connected = true; B.error = null; B.synced = true;
    } catch (error) { if (generation === historyBoardGeneration) { B.error = error.message; showNotice(error.message, true); } }
    if (generation === historyBoardGeneration) historyBoardTimer = setTimeout(tick, 2000);
  };
  historyBoardTimer = -1; tick();
}
function disconnect() { ++historyBoardGeneration; clearTimeout(historyBoardTimer); historyBoardTimer = null; B.connected = false; }
function resolveLegacyFocus() { /* All navigation is by indexed record ID. */ }
function loadFinals() { /* No event-derived usage is available in the history index. */ }
function renderSlots() { $('uslots').hidden = true; }
function renderUniTop() {
  setText($('scope'), `全局记录 · ${U.projects.size} 个工作区 · ${U.sessions.size} 次调用`);
  setText($('clock'), '每 2 秒读取本地索引');
  setText($('status'), U.error || '');
}
function historyNavigation() {
  const nav = document.createElement('nav'); nav.id = 'history-navigation'; nav.setAttribute('aria-label', 'Foreman 页面');
  const manage = document.createElement('a'); manage.href = '/'; manage.textContent = '记录管理';
  const preview = document.createElement('a'); preview.textContent = '预览本次调用'; preview.hidden = true;
  const note = document.createElement('span'); note.textContent = '星云 = 工作区 · 星系 = 调用；用量与费用未采集';
  nav.append(manage, preview, note); document.body.append(nav);
  setInterval(() => { const id = FLY.id; preview.hidden = FLY.mode === 'universe' || !/^[a-f0-9]{64}$/.test(id || ''); preview.href = `/?preview=${encodeURIComponent(id || '')}`; }, 200);
  // Public answers live in the management preview; no private transcript is loaded into the renderer.
  $('more').hidden = true; $('termsec').hidden = true;
}
historyNavigation();
