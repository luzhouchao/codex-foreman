import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const tests = fs.readdirSync(path.join(root, 'tests')).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => path.join(root, 'tests', name));
// 部分 Desktop 测试直接调用适配器；统一索引也必须落到合成环境，不能污染用户历史。
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-suite-'));
try {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=2', ...tests], { stdio: 'inherit', cwd: root,
    env: { ...process.env, CODEX_HOME: path.join(testHome, '.codex'), PI_CODING_AGENT_DIR: path.join(testHome, '.pi', 'agent') } });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { fs.rmSync(testHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
