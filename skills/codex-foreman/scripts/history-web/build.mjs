// Rebuild the vendored upstream renderer, then insert the local authenticated transport before its entrypoint.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const dir = new URL('./', import.meta.url), source = new URL('upstream/', dir);
const read = name => fs.readFileSync(new URL(name, source), 'utf8');
const scripts = fs.readdirSync(new URL('web/', source)).filter(name => /^\d\d-.+\.js$/.test(name) && name !== '02-uni-demo.js').sort();
const avatarFiles = fs.readdirSync(new URL('avatars/', source)).filter(name => name.endsWith('.png')).sort();
const avatars = Object.fromEntries(avatarFiles.map(name => [name.slice(0, -4), `data:image/png;base64,${fs.readFileSync(new URL(`avatars/${name}`, source)).toString('base64')}`]));
const display = read('display.mjs'), names = /export \{([\s\S]*?)\};/.exec(display)[1];
const shared = `const Display = (() => {\n${display.replace(/export \{[\s\S]*?\};/, '')}\nreturn {${names}};\n})();\n`;
const prelude = `window.__LANG__='zh';window.__BOARD_MODE__='history';window.__AVATARS__=${JSON.stringify(avatars)};\n`;
const adapted = new Set(['connectUniverse', 'disconnectUniverse', 'connect', 'disconnect', 'resolveLegacyFocus', 'loadFinals', 'renderSlots', 'renderUniTop', 'fillCard', 'renderTable', 'seatStatus', 'fateAt']);
const body = scripts.map(name => {
  const original = read(`web/${name}`).replace(/function (\w+)\(/g, (match, fn) => adapted.has(fn) ? `function upstream_${fn}(` : match);
  return `${name === '09-main.js' ? fs.readFileSync(new URL('adapter.js', dir), 'utf8') : ''}\n// upstream: ${name}\n${original}`;
}).join('\n');
fs.writeFileSync(new URL('app.js', dir), `// MIT Copyright (c) 2026 DaydayupV; see upstream/LICENSE and upstream.json\n${prelude}${shared}${body}`);
fs.writeFileSync(new URL('style.css', dir), read('web/board.css'));
fs.writeFileSync(new URL('index.html', dir), read('web/shell.html')
  .replace('<title>foreman board</title>', '<title>Foreman 全局星图</title>')
  .replace('<style>/*CSS*/</style>', '<link rel="stylesheet" href="/board/style.css"><link rel="stylesheet" href="/board/navigation.css">')
  .replace('<script>/*JS*/</script>', '<script src="/board/app.js" defer></script>'));
const files = [...scripts.map(name => `web/${name}`), 'web/board.css', 'web/shell.html', 'display.mjs', ...avatarFiles.map(name => `avatars/${name}`)];
fs.writeFileSync(new URL('upstream.json', dir), JSON.stringify({ repository: 'https://github.com/DaydayupV/claude-foreman',
  commit: 'a1e52825b42e4137188ef0d7d2ecaf689147556c', commit_date: '2026-10-30', license: 'MIT', license_file: 'upstream/LICENSE',
  original_board_path: 'board/web', integration: 'adapter.js', build: 'node build.mjs', excluded_demo: '02-uni-demo.js',
  files: files.map(file => ({ file: `upstream/${file}`, sha256: createHash('sha256').update(fs.readFileSync(new URL(file, source))).digest('hex') })) }, null, 2) + '\n');
console.log(`Vendored ${scripts.length} upstream modules and ${avatarFiles.length} avatars; local history transport inserted.`);
