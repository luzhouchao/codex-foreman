// Claude Foreman protocol v3 projection. Only indexed, already-sanitized summaries enter this module.
const ID = /^[a-f0-9]{64}$/;
const running = status => ['running', 'starting', 'queued'].includes(status);
const succeeded = status => ['done', 'completed', 'success', 'succeeded'].includes(status);
const at = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
export const boardAssets = new Map([
  ['/board/', ['history-web/index.html', 'text/html; charset=utf-8']],
  ['/board/app.js', ['history-web/app.js', 'text/javascript; charset=utf-8']],
  ['/board/style.css', ['history-web/style.css', 'text/css; charset=utf-8']],
  ['/board/navigation.css', ['history-web/navigation.css', 'text/css; charset=utf-8']],
]);

export function buildBoard(records, { now = Date.now() } = {}) {
  const projects = new Map(), sessions = [], snapshots = Object.create(null);
  for (const record of records) {
    if (!ID.test(record.id)) continue;
    const project = String(record.workspace || '未标记工作区');
    const started = at(record.started_at), ended = at(record.ended_at);
    // Unavailable records remain manageable in the records view but cannot claim a timestamp on the star map.
    if (started === null) continue;
    const busy = running(record.status), done = succeeded(record.status);
    const kind = record.kind || (['discuss', 'review'].includes(record.mode) ? record.mode : 'exec');
    const run = { id: record.id, lane: record.id, session: record.id, kind, mode: record.mode || '', effort: record.effort || '', history_summary: true, agent: record.agent || record.provider || 'unknown',
      agent_type: record.provider || '', model: record.model || '', group: record.group || null,
      title: record.title || record.run_id, status: record.status, started_at: started, ended_at: ended,
      queued: record.status === 'queued', usage: null, cost_usd: null, source_run_id: record.run_id };
    projects.set(project, { key: project, cwd: project, name: project.replace(/\\/g, '/').split('/').filter(Boolean).pop() || project, older: 0 });
    sessions.push({ id: record.id, project, cwd: project, title: record.title || record.run_id, model: record.model || '',
      state: busy ? 'dispatching' : 'idle', started_at: started, last_at: Math.max(started, ended ?? started),
      runs: [run], models: [{ model: run.model, agent: run.agent_type, running: busy }],
      counts: { running: busy ? 1 : 0, done: done ? 1 : 0, failed: !busy && !done ? 1 : 0 },
      usage: null, cost_usd: null, cost_partial: false,
      alert: !busy && !done ? { kind: record.status, run: record.id, model: run.model, at: ended ?? started } : null });
    snapshots[record.id] = { hello: { v: 3, mode: 'live', now, replay: null }, runs: [run], events: [] };
  }
  return { universe: { v: 3, now, scope: 'all-registered-workspaces', window_h: null, projects: [...projects.values()], sessions, agents: [],
    capabilities: { history: true, public_preview: true, token_usage: false, cost: false, terminal_events: false, configured_slots: false } }, snapshots };
}
