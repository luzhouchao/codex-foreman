// Command recognizer adapted from DaydayupV/claude-foreman (MIT).
const CODEX_SUBCOMMANDS = new Set(['exec', 'e', 'review']);
// pi 除了下面这些用法都会运行模型：查询类参数（要在 -- 之前），以及放在第一个位置的管理类子命令。
const PI_QUERY_FLAGS = new Set(['--version', '-v', '--help', '-h', '--list-models', '--export']);
const PI_ADMIN = new Set(['install', 'remove', 'uninstall', 'update', 'list', 'config', 'auth', 'mcp']);
// 带一个值的选项：值不能当成子命令或查询参数。
const PI_VALUE_OPTIONS = new Set(['--provider', '--model', '--api-key', '--system-prompt', '--append-system-prompt', '--mode', '--session', '--session-id',
  '--fork', '--session-dir', '--name', '-n', '--models', '--tools', '-t', '--exclude-tools', '-xt', '--thinking', '--extension', '-e', '--skill',
  '--prompt-template', '--theme', '--use-theme', '--tui-mode']);
const PI_ENTRY = /pi-coding-agent[\\/]dist[\\/](bundle[\\/])?cli\.js$/i;

function piRunsModel(words) {
  if (PI_ADMIN.has(words[0])) return false;
  for (let n = 0; n < words.length; n++) {
    const w = words[n];
    if (w === '--') return true; // 后面都是提示词
    if (PI_QUERY_FLAGS.has(w)) return false;
    if (PI_VALUE_OPTIONS.has(w)) n++;
  }
  return true;
}

// npx 先跳过它自己的选项，再看要运行的包；-p / --package 后面跟的就是包名。
function npxPackage(tokens, i) {
  for (let n = i + 1; n < tokens.length; n++) {
    const t = tokens[n].replace(/^["']|["']$/g, '');
    if (t === '-p' || t === '--package') return { pkg: (tokens[n + 1] || '').replace(/^["']|["']$/g, ''), rest: n + 3 };
    if (t.startsWith('--package=')) return { pkg: t.slice('--package='.length), rest: n + 2 };
    if (!t.startsWith('-')) return { pkg: t, rest: n + 1 };
  }
  return { pkg: '', rest: tokens.length };
}

const base = (p) => p.replace(/^["']|["']$/g, '').split(/[\\/]/).pop().toLowerCase();

// 按 ; | && || 和换行把命令拆成几段，引号里的分隔符不算。
function splitSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      current += c;
    } else if (c === ';' || c === '|' || c === '\n' || (c === '&' && command[i + 1] === '&')) {
      segments.push(current);
      current = '';
      if ((c === '&' || c === '|') && command[i + 1] === c) i++;
    } else {
      current += c;
    }
  }
  segments.push(current);
  return segments;
}

// 只看每段命令开头真正被执行的程序，文字里提到调用不算。
function callsAgentDirectly(command) {
  for (const segment of splitSegments(command)) {
    const tokens = segment.replace(/^[\s(`$&.]+/, '').match(/"[^"]*"|'[^']*'|\S+/g) || [];
    let i = 0;
    while (i < tokens.length && /^\w+=/.test(tokens[i])) i++; // 跳过 VAR=value 前缀
    const first = base(tokens[i] || '');
    let rest;
    let opencode = false, pi = false;
    if (/^codex(\.exe|\.cmd|\.ps1)?$/.test(first)) rest = tokens.slice(i + 1);
    else if (/^node(\.exe)?$/.test(first) && base(tokens[i + 1] || '') === 'codex.js') rest = tokens.slice(i + 2);
    else if (/^npx(\.cmd)?$/.test(first) && /^(@openai\/codex|codex)(@.*)?$/.test((tokens[i + 1] || '').replace(/["']/g, ''))) rest = tokens.slice(i + 2);
    else if (/^opencode(\.exe|\.cmd|\.ps1)?$/.test(first)) { rest = tokens.slice(i + 1); opencode = true; }
    else if (/^npx(\.cmd)?$/.test(first) && /^(opencode-ai|@opencode\/cli)(@.*)?$/.test((tokens[i + 1] || '').replace(/["']/g, ''))) { rest = tokens.slice(i + 2); opencode = true; }
    else if (/^pi(\.exe|\.cmd|\.ps1)?$/.test(first)) { rest = tokens.slice(i + 1); pi = true; }
    else if (/^node(\.exe)?$/.test(first) && PI_ENTRY.test((tokens[i + 1] || '').replace(/^["']|["']$/g, ''))) { rest = tokens.slice(i + 2); pi = true; }
    else if (/^npx(\.cmd)?$/.test(first) && /^@earendil-works\/pi-coding-agent(@.*)?$/.test(npxPackage(tokens, i).pkg)) { rest = tokens.slice(npxPackage(tokens, i).rest); pi = true; }
    else continue;
    const words = rest.map((t) => t.replace(/^["']|["']$/g, ''));
    if (pi) {
      if (piRunsModel(words)) return true;
      continue;
    }
    if (words.some((w) => w === '--help' || w === '-h')) continue;
    // session 等子命令后也可能出现名为 run 的参数。
    if (opencode ? words.find((w, n) => !w.startsWith('-') && words[n - 1] !== '--log-level') === 'run'
      : words.some((w) => CODEX_SUBCOMMANDS.has(w))) return true;
  }
  return false;
}


export { callsAgentDirectly };
