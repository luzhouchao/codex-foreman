// 主控明确报告的内置任务记录；不连接、驱动或监测 Codex agent。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { replaceFile } from './util.mjs';

const fields = ['task_id', 'agent_id', 'model', 'scope', 'artifacts', 'tests', 'acceptance', 'status', 'status_source'];
const statuses = new Set(['assigned', 'running', 'completed', 'failed', 'cancelled', 'blocked']);
function text(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 必须是非空字符串`);
}
export function validateNativeRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('任务记录必须是 JSON 对象');
  for (const key of Object.keys(input)) if (!fields.includes(key)) throw new Error(`未知字段: ${key}`);
  for (const key of ['task_id', 'agent_id', 'model', 'status', 'status_source']) text(input[key], key);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(input.task_id)) throw new Error('task_id 只能包含字母、数字、下划线和连字符，最多 96 字符');
  if (!statuses.has(input.status)) throw new Error('不支持的 status');
  for (const key of ['scope', 'artifacts', 'tests', 'acceptance']) {
    if (!Array.isArray(input[key])) throw new Error(`${key} 必须是字符串数组`);
    for (const value of input[key]) text(value, key);
  }
  if (!input.scope.length || !input.acceptance.length) throw new Error('scope 和 acceptance 不能为空');
  return Object.fromEntries(fields.map(key => [key, Array.isArray(input[key]) ? [...input[key]] : input[key]]));
}

// 拒绝已存在的符号链接/Windows junction，避免记录落到工作区之外。
function safeDirectory(workspace) {
  const base = fs.realpathSync(path.resolve(workspace));
  let current = base;
  for (const part of ['.codex', 'foreman', 'native-tasks']) {
    current = path.join(current, part);
    try { fs.mkdirSync(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`记录路径不是普通目录: ${current}`);
  }
  return current;
}

export function writeNativeRecord(workspace, input) {
  const record = validateNativeRecord(input);
  const dir = safeDirectory(workspace);
  const file = path.join(dir, `${record.task_id}.json`);
  if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) throw new Error('目标记录不是普通文件');
  const temp = path.join(dir, `.${record.task_id}.${randomUUID()}.tmp`);
  const result = { schema_version: 1, ...record, recorded_at: new Date().toISOString(), provenance: 'host_reported' };
  try {
    fs.writeFileSync(temp, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    replaceFile(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
  return { ...result, record_file: file };
}

export function cmdNativeRecord(opts) {
  if (!opts.input) throw new Error('native-record 需要 --input <JSON 文件>');
  const workspace = opts.workspace || process.env.CODEX_FOREMAN_WORKSPACE || process.cwd();
  return writeNativeRecord(workspace, JSON.parse(fs.readFileSync(path.resolve(opts.input), 'utf8').replace(/^\uFEFF/, '')));
}
