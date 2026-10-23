// 配置路径、改名迁移、合并校验和任务等级选择；类型字段校验由调用方传入。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { HERE, M, notice, isObject, readJson, die, replaceFile, closestMatches } from './util.mjs';

const ENTRY = path.join(HERE, 'cli.mjs');
const SCHEMA = path.join(HERE, '..', 'schemas', 'report.schema.json');
const DISCUSS_SCHEMA = path.join(HERE, '..', 'schemas', 'discuss.schema.json');

// 旧项目文件常量保留兼容接口；不会自动导入旧全局配置。
const LEGACY_PROJECT_CONFIG = path.join('.codex', 'codex-bridge.json');
const LEGACY_PROJECT_PREFS = path.join('.codex', 'codex-bridge.md');

// 环境变量改了名，旧名字还认，用到时提示一句（同一个进程只提示一次）。
const legacyEnvNoticed = new Set();
function envOf(name, legacy) {
  if (process.env[name]) return process.env[name];
  if (!process.env[legacy]) return undefined;
  if (!legacyEnvNoticed.has(legacy)) { legacyEnvNoticed.add(legacy); notice(M.legacyEnv(legacy, name)); }
  return process.env[legacy];
}

const HOME_DIR = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'foreman');
const CUSTOM_CONFIG = envOf('CODEX_FOREMAN_CONFIG', 'CODEX_FOREMAN_LEGACY_CONFIG');
const USER_CONFIG = CUSTOM_CONFIG || path.join(HOME_DIR, 'config.json');
const USER_PREFS = path.join(path.dirname(USER_CONFIG), 'preferences.md');
const PROJECT_CONFIG = path.join('.codex', 'foreman.json');
const PROJECT_PREFS = path.join('.codex', 'foreman.md');

// 项目里的文件还是旧名字时照常读取，提示改名，不改动项目里的文件。
function projectFile(cwd, current, legacy) { return path.join(cwd, current); }

const DEFAULT_AGENT_PARALLEL = 4;
const LEVELS = ['simple', 'normal', 'complex'];
const MODES = ['run', 'review', 'discuss'];
const HOST_CODEX = 'codex host';
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const DEFAULT_CONFIG = {
  dispatch: { auto: false, watch: 'off', intro: false, discuss_max_rounds: 2, discuss_max_files: null, discuss_max_tool_calls: 24, timeout_min: 480, stall_min: 40, busy_ask_min: 2, runs_dir: null },
  agents: {},
  levels: Object.fromEntries(MODES.map((mode) => [mode, Object.fromEntries(LEVELS.map((lv) => [lv, HOST_CODEX]))])),
};

// 只在迁移时使用旧默认值，还原逐字段继承后的实际配置。
const CODEX_LEVEL_FALLBACK = Object.fromEntries(LEVELS.map((lv, i) => [lv, { agent: 'codex', effort: ['medium', 'high', 'max'][i] }]));
const LEGACY_DEFAULT_CONFIG = {
  ...DEFAULT_CONFIG,
  agents: { codex: { type: 'codex', bin: null, model: null, max_parallel: 4, sandbox: { run: null, review: null, discuss: null }, approval: null } },
  levels: { run: { simple: 'claude', normal: 'claude', complex: CODEX_LEVEL_FALLBACK.complex },
    review: CODEX_LEVEL_FALLBACK, discuss: Object.fromEntries(LEVELS.map((lv) => [lv, [CODEX_LEVEL_FALLBACK[lv]]])) },
};
const OLD_TYPES = { codex: 'codex cli', opencode: 'opencode cli', 'openai-compatible': 'api' };
const migratedConfigs = new Map();
let memoryAliases = {};
const aliasesFile = path.join(path.dirname(USER_CONFIG), 'agent-aliases.json');
const readAgentAliases = () => ({ ...(readJson(aliasesFile) || {}), ...memoryAliases });

function resolveAgentAlias(name, cfg, announce = false) {
  const aliases = readAgentAliases(), seen = new Set();
  let resolved = name;
  while (!Object.hasOwn(cfg.agents, resolved) && aliases[resolved] && !seen.has(resolved)) {
    seen.add(resolved);
    resolved = aliases[resolved];
  }
  if (announce && resolved !== name) notice(M.legacyAgentAlias(name, resolved));
  return resolved;
}

function staleAliases(cfg) {
  return Object.keys(readAgentAliases()).filter((old) => !Object.hasOwn(cfg.agents, old)).map((old) => [old, resolveAgentAlias(old, cfg)])
    .filter(([, target]) => !Object.hasOwn(cfg.agents, target))
    .map(([old, target]) => ({ old, target, closest: closestMatches(target, Object.keys(cfg.agents)) }));
}

// 代号写错时，提示里带上最接近的代号。
const unknownAgentError = (key, name, cfg) => {
  const near = closestMatches(name, Object.keys(cfg.agents));
  return (key === '--agent' ? M.unknownAgentFlag(name) : M.unknownAgent(key, name)) + (near.length ? M.closestHint(M.list(near)) : '');
};

function mergeConfig(base, extra) {
  const out = { ...base };
  for (const k of ['dispatch', 'agents', 'levels']) {
    if (!extra || !(k in extra)) continue;
    const v = extra[k];
    out[k] = isObject(v) ? { ...base[k], ...v } : v;
    if ((k === 'agents' || k === 'levels') && isObject(v)) {
      for (const [name, value] of Object.entries(v)) {
        out[k][name] = isObject(value) ? { ...base[k]?.[name], ...value } : value;
        if (k === 'agents' && isObject(value?.sandbox)) out[k][name].sandbox = { ...base[k]?.[name]?.sandbox, ...value.sandbox };
      }
    }
  }
  return out;
}

function mergeLegacyConfig(base, extra) {
  const out = mergeConfig(base, extra);
  for (const [mode, levels] of Object.entries(extra.levels || {})) {
    if (mode === 'discuss' || !isObject(levels)) continue;
    for (const [lv, entry] of Object.entries(levels)) {
      if (!isObject(entry)) continue;
      const prev = base.levels?.[mode]?.[lv];
      out.levels[mode][lv] = { ...(isObject(prev) ? prev : CODEX_LEVEL_FALLBACK[lv]), ...entry };
    }
  }
  return out;
}

function migrateConfig(config, file, base, project) {
  if (!isObject(config)) die(M.configInvalid(file, M.invalid.object));
  const oldKeys = ['auto_dispatch', 'watch', 'discuss_max_rounds', 'codex_bin', 'model', 'max_parallel', 'sandbox', 'approval', 'timeout_min', 'stall_min', 'runs_dir'];
  let old = oldKeys.some((key) => Object.hasOwn(config, key));
  const codexName = project ? resolveAgentAlias('codex', base) : 'codex';
  const legacy = { dispatch: {}, agents: { [codexName]: project ? {} : { type: 'codex' } } };
  for (const key of oldKeys) {
    if (!Object.hasOwn(config, key)) continue;
    if (['model', 'max_parallel', 'sandbox', 'approval', 'codex_bin'].includes(key)) legacy.agents[codexName][key === 'codex_bin' ? 'bin' : key] = config[key];
    else legacy.dispatch[key === 'auto_dispatch' ? 'auto' : key] = config[key];
  }
  const converted = mergeConfig(legacy, config);
  const convert = (item) => {
    if (!isObject(item) || Object.hasOwn(item, 'agent')) return item;
    old = true;
    const result = { agent: codexName, ...item };
    if (!project && result.model === null) delete result.model;
    return result;
  };
  for (const [mode, levels] of Object.entries(isObject(config.levels) ? config.levels : {})) {
    if (!isObject(levels)) continue;
    for (const [lv, entry] of Object.entries(levels)) {
      if (mode !== 'discuss') converted.levels[mode][lv] = convert(entry);
      else if (!isObject(entry)) converted.levels[mode][lv] = Array.isArray(entry) ? entry.map(convert) : entry;
      else {
        old = true;
        const list = Array.isArray(base.levels?.discuss?.[lv]) ? base.levels.discuss[lv] : [];
        const prev = list.find((e) => e?.agent === codexName);
        const merged = convert({ ...(prev || CODEX_LEVEL_FALLBACK[lv]), ...entry, agent: codexName });
        converted.levels[mode][lv] = prev ? list.map((e) => e === prev ? merged : e) : [merged, ...list];
      }
    }
  }
  if (!old) return config;
  const result = { ...converted };
  for (const [key, value] of Object.entries(config)) if (!oldKeys.includes(key) && !Object.hasOwn(result, key)) result[key] = value;
  if (project) notice(M.projectOldFormat(file));
  return mergeLegacyConfig(base, result);
}

function renameAgentsByModel(config, adapters) {
  const agents = {}, aliases = {};
  const nameOf = (name, agent) => {
    let model = agent.model || (agent.type === 'codex cli' ? adapters[agent.type].status(agent).model : null);
    if (!model) return name;
    if (agent.type === 'opencode cli' || agent.type === 'pi cli') model = model.split('/').at(-1);
    let id = model.replace(/[^A-Za-z0-9._-]/g, '-');
    if (!/^[A-Za-z0-9]/.test(id)) id = `agent-${id}`;
    if (id === 'claude') id += '-agent';
    return id;
  };
  const add = (name, agent) => {
    const base = nameOf(name, agent), suffix = { 'codex cli': 'codex', 'opencode cli': 'opencode', 'pi cli': 'pi', 'antigravity cli': 'agy', 'antigravity desktop': 'agy-desktop', api: 'api' }[agent.type];
    let id = base;
    for (let n = 1; Object.hasOwn(agents, id); n++) {
      if (isDeepStrictEqual(agents[id], agent)) return id;
      id = `${base}-${suffix}${n > 1 ? `-${n}` : ''}`;
    }
    agents[id] = agent;
    return id;
  };
  // 已按模型命名的代号优先保留，避免被前面同名但不同配置的协作方占用。
  const entries = Object.entries(config.agents).sort(([a, x], [b, y]) => Number(nameOf(b, y) === b) - Number(nameOf(a, x) === a));
  for (const [name, agent] of entries) aliases[name] = add(name, agent);
  const convert = (item) => {
    if (!isObject(item)) return item;
    const original = config.agents[item.agent];
    const { model, ...rest } = item;
    return { ...rest, agent: model && original ? add(item.agent, { ...original, model }) : aliases[item.agent] || item.agent };
  };
  for (const levels of Object.values(config.levels)) {
    for (const [lv, entry] of Object.entries(levels)) levels[lv] = Array.isArray(entry)
      ? entry.map(convert).filter((item, i, list) => !list.slice(0, i).some((prev) => isDeepStrictEqual(prev, item))) : convert(entry);
  }
  return { config: { ...config, agents }, aliases: Object.fromEntries(Object.entries(aliases).filter(([a, b]) => a !== b)) };
}

function migrateStructure(config, file, base, project, adapters) {
  if (!project && migratedConfigs.has(file)) return migratedConfigs.get(file);
  const converted = migrateConfig(config, file, base, project);
  const old = converted !== config || Object.values(converted.agents || {}).some((a) => Object.hasOwn(OLD_TYPES, a?.type))
    || Object.values(converted.levels || {}).some((levels) => Object.values(levels || {}).includes('claude'));
  if (!old) return config;
  let result = project ? mergeLegacyConfig(base, converted) : mergeLegacyConfig(LEGACY_DEFAULT_CONFIG, converted);
  result = structuredClone(result);
  if (!project && isObject(converted.agents) && !Object.hasOwn(converted.agents, 'codex')
    && !Object.values(result.levels).some((levels) => Object.values(levels).some((entry) => (Array.isArray(entry) ? entry : [entry]).some((item) => item?.agent === 'codex')))) delete result.agents.codex;
  for (const agent of Object.values(result.agents || {})) if (Object.hasOwn(OLD_TYPES, agent?.type)) agent.type = OLD_TYPES[agent.type];
  for (const levels of Object.values(result.levels || {})) for (const [lv, entry] of Object.entries(levels)) if (entry === 'claude') levels[lv] = HOST_CODEX;
  if (project) {
    // 项目只能贡献自己写的格子，不能把继承的用户配置当成项目覆盖。
    const limited = { ...converted, levels: {} };
    for (const [mode, levels] of Object.entries(config.levels || {})) limited.levels[mode] = Object.fromEntries(Object.keys(levels).map((lv) => [lv, result.levels[mode][lv]]));
    return limited;
  }
  let renamed = { aliases: {} };
  const lock = `${file}.structure.lock`, tmp = `${file}.${process.pid}.tmp`, aliasTmp = `${aliasesFile}.${process.pid}.tmp`;
  let locked = false;
  try {
    renamed = renameAgentsByModel(result, adapters);
    result = renamed.config;
    validateConfig(result, adapters, (msg) => { throw new Error(msg); });
    for (;;) {
      try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); locked = true; break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let owner;
        try { owner = Number(fs.readFileSync(lock, 'utf8')); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        if (owner && !pidAlive(owner)) fs.rmSync(lock, { force: true });
        else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    const current = readJson(file);
    if (!isDeepStrictEqual(current, config)) {
      fs.rmSync(lock, { force: true });
      locked = false;
      return migrateStructure(current, file, base, false, adapters);
    }
    let bak = `${file}.bak`;
    if (fs.existsSync(bak)) bak += `-${Date.now()}-${process.pid}`;
    fs.copyFileSync(file, bak, fs.constants.COPYFILE_EXCL);
    const aliases = { ...readAgentAliases(), ...renamed.aliases };
    fs.writeFileSync(aliasTmp, JSON.stringify(aliases, null, 2) + '\n', { flag: 'wx' });
    replaceFile(aliasTmp, aliasesFile);
    fs.writeFileSync(tmp, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    replaceFile(tmp, file);
    notice(M.configStructureMigrated(file, bak, M.list(Object.entries(renamed.aliases).map(([a, b]) => `${a} → ${b}`))));
  } catch (e) {
    notice(M.configMigrateFailed(file, e.message));
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(aliasTmp, { force: true });
    if (locked) fs.rmSync(lock, { force: true });
  }
  memoryAliases = { ...memoryAliases, ...renamed.aliases };
  migratedConfigs.set(file, result);
  return result;
}

function validateConfig(cfg, adapters, fail = die) {
  const why = M.invalid;
  const check = (ok, key, reason) => { if (!ok) fail(M.configInvalid(key, reason)); };
  const text = (v) => typeof v === 'string' && !!v.trim();
  for (const key of ['dispatch', 'agents', 'levels']) check(isObject(cfg[key]), key, why.object);
  check(typeof cfg.dispatch.auto === 'boolean', 'dispatch.auto', why.boolean);
  check(['auto', 'off'].includes(cfg.dispatch.watch), 'dispatch.watch', why.watch);
  check(typeof cfg.dispatch.intro === 'boolean', 'dispatch.intro', why.boolean);
  check(cfg.dispatch.discuss_max_files === null || (Number.isInteger(cfg.dispatch.discuss_max_files) && cfg.dispatch.discuss_max_files >= 1), 'dispatch.discuss_max_files', why.positiveInt);
  for (const field of ['discuss_max_tool_calls']) check(Number.isInteger(cfg.dispatch[field]) && cfg.dispatch[field] >= 1, `dispatch.${field}`, why.positiveInt);
  check(Number.isInteger(cfg.dispatch.discuss_max_rounds) && cfg.dispatch.discuss_max_rounds >= 1, 'dispatch.discuss_max_rounds', why.positiveInt);
  for (const key of ['timeout_min', 'stall_min', 'busy_ask_min']) check(Number.isFinite(cfg.dispatch[key]) && (key === 'timeout_min' ? cfg.dispatch[key] > 0 : cfg.dispatch[key] >= 0), `dispatch.${key}`, why.minutes);
  check(cfg.dispatch.runs_dir === null || text(cfg.dispatch.runs_dir), 'dispatch.runs_dir', why.pathOrNull);
  for (const [name, agent] of Object.entries(cfg.agents)) {
    const key = `agents.${name}`;
    check(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !['claude', HOST_CODEX].includes(name), key, why.agentName);
    check(isObject(agent), key, why.object);
    check(Object.hasOwn(adapters, agent.type), `${key}.type`, why.agentType);
    check(agent.model == null || (text(agent.model) && agent.model !== HOST_CODEX), `${key}.model`, why.modelName);
    check(agent.max_parallel === undefined || (Number.isInteger(agent.max_parallel) && agent.max_parallel >= 1), `${key}.max_parallel`, why.positiveInt);
    adapters[agent.type].validate(agent, key, check, text);
  }
  for (const mode of Object.keys(cfg.levels)) check(MODES.includes(mode), `levels.${mode}`, why.mode);
  for (const mode of MODES) {
    check(isObject(cfg.levels[mode]), `levels.${mode}`, why.object);
    for (const lv of Object.keys(cfg.levels[mode])) check(LEVELS.includes(lv), `levels.${mode}.${lv}`, why.level);
    for (const lv of LEVELS) {
      const key = `levels.${mode}.${lv}`, entry = cfg.levels[mode][lv];
      if (entry === HOST_CODEX) continue;
      if (mode === 'discuss') check(Array.isArray(entry) && entry.length > 0, key, why.participants);
      const seen = new Set();
      for (const [i, item] of (mode === 'discuss' ? entry : [entry]).entries()) {
        const at = mode === 'discuss' ? `${key}[${i}]` : key;
        check(isObject(item), at, M.levelEntryChoices);
        check(text(item.agent), `${at}.agent`, why.agentRef);
        if (!Object.hasOwn(cfg.agents, item.agent)) fail(unknownAgentError(at, item.agent, cfg));
        const agent = cfg.agents[item.agent], adapter = adapters[agent.type];
        check(!seen.has(item.agent), at, why.duplicate);
        seen.add(item.agent);
        check(adapter.capabilities.modes.includes(mode), `${at}.agent`, M.modeNotSupported(item.agent, agent.type, mode, M.list(adapter.capabilities.modes)));
        if (mode === 'run' && ['tools', 'none'].includes(adapter.capabilities.isolation) && !agent.run_access) fail(M.runAccessRequired(item.agent, agent.type));
        check(item.model == null || (text(item.model) && item.model !== HOST_CODEX), `${at}.model`, why.modelName);
        check(item.effort === undefined || (adapter.efforts ? adapter.efforts.includes(item.effort) : item.effort === null || text(item.effort)), `${at}.effort`, adapter.efforts?.join(' / ') || why.apiEffort);
      }
    }
  }
}

function projectConfig(cfg, project) {
  const allowed = {}, ignored = [];
  for (const [key, value] of Object.entries(project)) {
    if (key === 'dispatch' && isObject(value)) {
      allowed.dispatch = {};
      for (const [field, val] of Object.entries(value)) {
        if (['timeout_min', 'stall_min', 'busy_ask_min'].includes(field)) allowed.dispatch[field] = val;
        else if (['discuss_max_rounds', 'discuss_max_files', 'discuss_max_tool_calls'].includes(field) && Number.isInteger(val) && val >= 1 && (cfg.dispatch[field] == null || val <= cfg.dispatch[field])) allowed.dispatch[field] = val;
        else ignored.push(`dispatch.${field}`);
      }
    } else if (key === 'levels' && isObject(value)) {
      allowed.levels = {};
      for (const [mode, levels] of Object.entries(value)) {
        allowed.levels[mode] = {};
        for (const [lv, entry] of Object.entries(levels)) {
          const at = `levels.${mode}.${lv}`, original = cfg.levels[mode]?.[lv];
          if (entry === HOST_CODEX) { allowed.levels[mode][lv] = entry; continue; }
          const candidates = Array.isArray(original) ? original : isObject(original) ? [original] : [];
          const entries = mode === 'discuss' && Array.isArray(entry) ? entry : [entry];
          const kept = entries.flatMap((item) => {
            const name = resolveAgentAlias(item?.agent, cfg), prev = candidates.find((p) => p.agent === name);
            if (!prev || (mode === 'discuss' && !Array.isArray(entry))) { notice(M.projectAgentDropped(item?.agent ?? JSON.stringify(item), at)); return []; }
            for (const field of Object.keys(item)) if (!['agent', 'effort'].includes(field)) notice(M.projectAgentDropped(field, at));
            if (Object.keys(item).some((field) => !['agent', 'effort', 'model'].includes(field))) return [];
            return [{ agent: name, ...(Object.hasOwn(item, 'effort') ? { effort: item.effort } : {}) }];
          });
          if (mode === 'discuss' && !kept.length) die(M.projectLevelEmpty(at));
          if (kept.length) allowed.levels[mode][lv] = mode === 'discuss' ? kept : kept[0];
        }
      }
    } else ignored.push(key);
  }
  if (ignored.length) notice(M.projectIgnored(M.list(ignored)));
  return allowed;
}

function detectEnvironment(adapters, agents = {}) {
  const commands = {}, started = {};
  const call = (type, args) => {
    if (!commands[type]) {
      started[type] = Date.now();
      commands[type] = adapters[type].locate(Object.values(agents).find((a) => a.type === type) || {});
    }
    const timeout = 30000 - (Date.now() - started[type]);
    if (timeout <= 0) return { status: null };
    const { file, pre } = commands[type];
    return spawnSync(file, [...pre, ...args], { encoding: 'utf8', windowsHide: true, timeout });
  };
  const version = call('codex cli', ['--version']), found = !version.error && version.status === 0;
  const login = found ? call('codex cli', ['login', 'status']) : null;
  const oc = call('opencode cli', ['--version']), ocFound = !oc.error && oc.status === 0;
  const models = ocFound ? call('opencode cli', ['models']) : null;
  const pi = call('pi cli', ['--version']), piFound = !pi.error && pi.status === 0;
  const piModels = piFound ? call('pi cli', adapters['pi cli'].listModelsArgs) : null;
  return { codex: { found, logged_in: !!login && !login.error && login.status === 0 && /logged in/i.test(`${login.stdout}${login.stderr}`) && !/not logged in/i.test(`${login.stdout}${login.stderr}`) },
    opencode: { found: ocFound, models: models?.status === 0 ? new Set(models.stdout.split(/\s+/).filter((s) => s.includes('/'))).size : 0 },
    // pi --list-models 输出一张表：第一行是表头，之后每行一个模型。
    pi: { found: piFound, models: piModels?.status === 0 ? Math.max(0, piModels.stdout.trim().split(/\r?\n/).filter(Boolean).length - 1) : 0 },
    api_keys: ['DEEPSEEK_API_KEY', 'KIMI_API_KEY', 'MOONSHOT_API_KEY', 'MIMO_API_KEY'].filter((key) => !!process.env[key]) };
}

function buildStarterConfig(environment) {
  return structuredClone(DEFAULT_CONFIG);
}

function loadConfig(cwd, adapters) {
  const sources = [];
  let discussionProjectLimits = {};
  let cfg = DEFAULT_CONFIG;
  if (!fs.existsSync(USER_CONFIG)) {
    try {
      const environment = detectEnvironment(adapters), starter = buildStarterConfig(environment);
      fs.mkdirSync(path.dirname(USER_CONFIG), { recursive: true });
      fs.writeFileSync(USER_CONFIG, JSON.stringify(starter, null, 2) + '\n', { flag: 'wx' });
      let parts = '默认由 Codex 主控处理；请配置 pi 或 opencode 的实际模型后启用调度。';
      if (environment.opencode.models) parts += M.starterOpencode(environment.opencode.models);
      if (environment.pi.models) parts += M.starterPi(environment.pi.models);
      notice(M.starterCreated(USER_CONFIG, parts + M.starterNext));
    } catch (e) { if (e.code !== 'EEXIST') notice(M.starterFailed(USER_CONFIG, e.message)); }
  }
  const user = readJson(USER_CONFIG);
  if (user) { cfg = mergeConfig(cfg, migrateStructure(user, USER_CONFIG, LEGACY_DEFAULT_CONFIG, false, adapters)); sources.push(USER_CONFIG); }
  if (cwd) {
    const file = projectFile(cwd, PROJECT_CONFIG, LEGACY_PROJECT_CONFIG), project = readJson(file);
    if (project) {
      const allowed = projectConfig(cfg, migrateStructure(project, file, cfg, true, adapters));
      discussionProjectLimits = Object.fromEntries(Object.entries(allowed.dispatch || {}).filter(([k]) => k.startsWith('discuss_')));
      cfg = mergeConfig(cfg, allowed); sources.push(file);
    }
  }
  const runsDir = envOf('CODEX_FOREMAN_RUNS_DIR', 'CODEX_FOREMAN_LEGACY_RUNS_DIR');
  if (runsDir) cfg = mergeConfig(cfg, { dispatch: { runs_dir: runsDir } });
  validateConfig(cfg, adapters);
  return Object.defineProperty({ ...cfg, sources }, 'discussionProjectLimits', { value: discussionProjectLimits });
}


// 默认记录目录；不会自动移动旧全局记录。
function defaultRunsRoot() { return path.join(HOME_DIR, 'runs'); }

function pickProfile(cfg, o, mode, adapters, fallbackModel = null, parentAgent = null) {
  let requested = o.agent && resolveAgentAlias(o.agent, cfg);
  const legacyRequested = requested && requested !== o.agent;
  parentAgent = parentAgent && resolveAgentAlias(parentAgent, cfg);
  // 旧等级的模型覆盖已拆成独立协作方，续接要找同一连接配置下的原模型。
  if (parentAgent && fallbackModel && cfg.agents[parentAgent]?.model !== fallbackModel) {
    const source = cfg.agents[parentAgent];
    const matches = Object.keys(cfg.agents).filter((name) => cfg.agents[name].model === fallbackModel
      && isDeepStrictEqual({ ...cfg.agents[name], model: null }, { ...source, model: null }));
    if (matches.length === 1) {
      if (requested === parentAgent) requested = matches[0];
      parentAgent = matches[0];
    }
  }
  if (legacyRequested) notice(M.legacyAgentAlias(o.agent, requested));
  if (parentAgent && requested && requested !== parentAgent) die(M.resumeAgentMismatch(requested, parentAgent));
  const selected = parentAgent || requested;
  if (requested && !Object.hasOwn(cfg.agents, requested)) die(unknownAgentError('--agent', requested, cfg));
  if (!o.level && !o.effort) die(M.missingLevel(LEVELS.join(' / '), CODEX_EFFORTS.join(' / ')));
  if (o.level && !LEVELS.includes(o.level)) die(M.levelChoices(LEVELS.join(' / ')));
  const level = o.level || null, key = `levels.${mode}.${level}`;
  let entry = level ? cfg.levels[mode][level] : HOST_CODEX;
  if (entry === HOST_CODEX) {
    // 这一级由 Codex 做：只有点名（--agent）或指定推理强度时才派出；续接也一样，不因为上一轮有协作方就自动派。
    let name = requested || (o.effort ? parentAgent : null);
    if (!name && o.effort) {
      const names = Object.keys(cfg.agents).filter((n) => adapters[cfg.agents[n].type].capabilities.modes.includes(mode));
      if (!names.length) die(M.noAgentForMode(mode));
      if (names.length > 1) die(M.agentRequiredForEffort(mode, M.list(names)));
      name = names[0];
    }
    if (!name) die(mode === 'run' ? M.levelForCodex(level) : M.levelIsCodex(key));
    const adapter = adapters[cfg.agents[name]?.type];
    entry = { agent: name, effort: adapter?.defaultEffort?.(level) ?? null };
  } else if (Array.isArray(entry)) {
    const names = M.list(entry.map((v) => v.agent));
    if (!selected && entry.length > 1) die(o.effort ? M.agentRequiredForEffort(mode, names) : M.agentRequired(key, names));
    const found = selected ? entry.find((v) => v.agent === selected) : entry[0];
    if (!found) die(M.agentNotInLevel(selected, key, names));
    entry = found;
  } else if (selected && selected !== entry.agent) die(M.agentMismatch(selected, key, entry.agent));
  if (!Object.hasOwn(cfg.agents, entry.agent)) die(unknownAgentError('--agent', entry.agent, cfg));
  const agent = cfg.agents[entry.agent], adapter = adapters[agent.type], effort = o.effort ?? entry.effort;
  if (!adapter.capabilities.modes.includes(mode)) die(M.modeNotSupported(entry.agent, agent.type, mode, M.list(adapter.capabilities.modes)));
  if (mode === 'run' && ['tools', 'none'].includes(adapter.capabilities.isolation) && !agent.run_access) die(M.runAccessRequired(entry.agent, agent.type));
  if (mode === 'run' && adapter.capabilities.isolation !== 'os' && o['no-snapshot']) die(M.snapshotRequired);
  if (effort !== undefined && adapter.efforts && !adapter.efforts.includes(effort)) die(M.effortChoices(adapter.efforts.join(' / ')));
  return { level, agentName: entry.agent, agent, model: o.model || entry.model || agent.model || fallbackModel, effort: effort ?? null };
}

export { ENTRY, SCHEMA, DISCUSS_SCHEMA, USER_CONFIG, USER_PREFS, PROJECT_PREFS, LEGACY_PROJECT_PREFS, DEFAULT_AGENT_PARALLEL, DEFAULT_CONFIG, HOST_CODEX, projectFile, loadConfig, pickProfile, defaultRunsRoot, readAgentAliases, resolveAgentAlias, migrateStructure, renameAgentsByModel, detectEnvironment, buildStarterConfig , staleAliases, unknownAgentError };
