export function localDateKey(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
export const statusCategory = status => ['running','starting','queued'].includes(status) ? 'running' : ['done','completed','success','succeeded'].includes(status) ? 'done' : 'failed';
export function filterRecords(records, filters) {
  return records.filter(record => (!filters.search || [record.title,record.run_id,record.workspace,record.model,record.provider,record.agent,record.group].join(' ').toLowerCase().includes(filters.search.trim().toLowerCase()))
    && (!filters.workspace || record.workspace === filters.workspace) && (!filters.model || record.model === filters.model)
    && (!filters.provider || record.provider === filters.provider) && (!filters.status || statusCategory(record.status) === filters.status)
    && (!filters.from || localDateKey(record.started_at) >= filters.from) && (!filters.to || (localDateKey(record.started_at) && localDateKey(record.started_at) <= filters.to)));
}
export function toggleSelection(selected, id, visibleIds, anchor, range = false) {
  const result = new Set(selected), value = !result.has(id), start = visibleIds.indexOf(anchor), end = visibleIds.indexOf(id);
  const ids = range && start >= 0 && end >= 0 ? visibleIds.slice(Math.min(start,end),Math.max(start,end)+1) : [id];
  for (const valueId of ids) value ? result.add(valueId) : result.delete(valueId);
  return result;
}
export function selectionCounts(selected, visibleIds) { const visible = visibleIds.filter(id=>selected.has(id)).length; return { total:selected.size,visible,hidden:selected.size-visible }; }
export const ticketReady = (data, confirmation, expiresAt, now = Date.now()) => Boolean(data?.ticket && !data.blocked?.length && confirmation === '删除所选记录' && now < expiresAt);
export function createLatestRequest() {
  let generation = 0, controller;
  return { async run(load,accept,reject) { const current = ++generation; controller?.abort(); controller = new AbortController(); try { const value = await load(controller.signal); if(current===generation) accept(value); } catch(error) { if(current===generation && error.name!=='AbortError') reject(error); } }, cancel() { generation++; controller?.abort(); } };
}
