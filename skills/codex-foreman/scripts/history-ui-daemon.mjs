// Dedicated hidden process; never opens a browser and never imports an arbitrary working directory.
import { runHistoryUiService } from './history-ui-service.mjs';
try {
  const raw = process.env.CODEX_FOREMAN_UI_LAUNCH;
  delete process.env.CODEX_FOREMAN_UI_LAUNCH;
  if (process.env.CODEX_FOREMAN_UI_INTERNAL !== '1' || !raw || raw.length > 8192) throw new Error('缺少内部启动凭证');
  const launch = JSON.parse(raw);
  if (!/^[a-f0-9]{64}$/.test(launch.launch_id || '') || typeof launch.manual !== 'boolean' || !launch.manual && !launch.owner) throw new Error('无效后台启动请求');
  await runHistoryUiService(launch);
} catch { process.exitCode = 1; }
