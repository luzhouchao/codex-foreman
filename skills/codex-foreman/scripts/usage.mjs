import fs from 'node:fs';
import path from 'node:path';
// 缺失字段保持 null；明确返回的 0 才计为零。
export const amount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export const addAmount = (a, b) => { a = amount(a); b = amount(b); return a == null ? b : b == null ? a : a + b; };
export const emptyUsage = () => ({ input_tokens: null, cached_input_tokens: null, output_tokens: null, reasoning_output_tokens: null });
export function addUsage(total, current) {
  for (const key of Object.keys(total)) total[key] = addAmount(total[key], current?.[key]);
  return total;
}
export const hasUsage = (usage) => Object.values(usage).some((value) => value != null);
export const piUsage = (u) => ({
  input_tokens: amount(u?.input) == null ? null : [u.input, u.cacheRead, u.cacheWrite].reduce((sum, value) => addAmount(sum, amount(value)), null),
  cached_input_tokens: amount(u?.cacheRead), output_tokens: amount(u?.output), reasoning_output_tokens: amount(u?.reasoning),
});

// 强制取消来不及写 result 时，从已经落盘的完整事件恢复；不推算未返回用量。
export function recoverUsage(dir, type) {
  const usage = emptyUsage();
  let cost = null;
  const file = type === 'pi cli' ? 'pi.jsonl' : type === 'opencode cli' ? 'opencode.jsonl' : type === 'antigravity cli' ? 'antigravity.jsonl' : 'events.jsonl';
  let text;
  try { text = fs.readFileSync(path.join(dir, file), 'utf8'); } catch { return { usage: null, cost_usd: null }; }
  for (const line of text.split('\n').slice(0, -1)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (type === 'antigravity cli') {
      const eventType = event.event || event.type;
      event = { ...event, ...(event[eventType] && typeof event[eventType] === 'object' ? event[eventType] : {}), type: eventType };
      if ((event.type === 'result' || event.type === 'step_update') && event.usage) {
        const u = event.usage;
        Object.assign(usage, { input_tokens: amount(u.input_tokens ?? u.inputTokens ?? u.promptTokenCount), cached_input_tokens: amount(u.cached_input_tokens ?? u.cache_read_tokens ?? u.cachedInputTokens ?? u.cachedContentTokenCount), output_tokens: amount(u.output_tokens ?? u.outputTokens ?? u.candidatesTokenCount), reasoning_output_tokens: amount(u.reasoning_output_tokens ?? u.thinking_tokens ?? u.reasoningTokens ?? u.thoughtsTokenCount) });
      }
    } else if (type === 'pi cli') {
      const u = event.type === 'message_end' && event.message?.role === 'assistant' ? event.message.usage
        : event.type === 'compaction_end' ? event.result?.usage : null;
      if (u) { addUsage(usage, piUsage(u)); cost = addAmount(cost, amount(u.cost?.total)); }
    } else if (type === 'opencode cli' && event.type === 'step_finish') {
      const t = event.part?.tokens;
      addUsage(usage, piUsage({ input: t?.input, cacheRead: t?.cache?.read, cacheWrite: t?.cache?.write, output: t?.output, reasoning: t?.reasoning }));
      cost = addAmount(cost, amount(event.part?.cost));
    } else if (event.type === 'api.usage' || event.type === 'turn.completed') addUsage(usage, event.usage);
  }
  return { usage: hasUsage(usage) ? usage : null, cost_usd: cost, usage_scope: type === 'antigravity cli' ? 'session_total' : 'this_run', usage_partial: true };
}
