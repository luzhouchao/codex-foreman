import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const tests = fs.readdirSync(path.join(root, 'tests')).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => path.join(root, 'tests', name));
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=2', ...tests], { stdio: 'inherit', cwd: root });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
