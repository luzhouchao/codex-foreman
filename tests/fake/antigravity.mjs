// 独立模拟 Antigravity 1.4.5 headless NDJSON；绝不调用真实 CLI 或模型。
import { setup, replay, finish, write } from './common.mjs';
import { discussion } from '../fixtures/reports.mjs';

const args = process.argv.slice(2);
const operation = args.includes('--version') ? 'version' : args[0] === 'models' ? 'models' : args.includes('-p') ? 'run' : args[0];
const { scenario: s } = await setup('antigravity', operation, args);
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
if (operation === 'version') console.log(s.version ?? '1.4.5');
else if (operation === 'models') {
  if (s.models_raw !== undefined) process.stdout.write(s.models_raw);
  else console.log(s.models_text ?? 'Available models:\n  fake-model (Fake Model)\n  other-model (Other Model)');
  process.exitCode = s.models_exit_code ?? 0;
} else if (operation === 'run') {
  if (value('--log-file')) write(value('--log-file'), 'synthetic Antigravity log\n');
  const id = s.conversation_id ?? value('--conversation') ?? 'synthetic-agy-conversation';
  if (!s.no_init) emit({ event: 'init', init: { conversation_id: id, cwd: s.init_cwd ?? process.cwd(), model: value('--model') } });
  await replay(s.steps);
  for (const line of s.raw_lines ?? []) process.stdout.write(line + '\n');
  if (!s.no_result && !s.hold) {
    const text = s.last_message ?? discussion;
    emit({ event: 'result', result: { conversation_id: id, status: s.status ?? 'SUCCESS',
      response: typeof text === 'string' ? text : JSON.stringify(text),
      structured_output: s.structured_output ?? (typeof text === 'object' ? text : undefined),
      usage: s.usage ?? { input_tokens: 17, output_tokens: 5, total_tokens: 22, cache_read_tokens: 3, thinking_tokens: 2 },
      ...(s.result_extra ?? {}) } });
  }
  await finish(s);
} else throw new Error(`假 Antigravity 不支持 ${operation}`);
