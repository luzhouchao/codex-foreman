import fs from 'node:fs';
import http from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listHistory, knownRoots, importWorkspace, importLegacyGlobal, refreshHistory, previewHistory, deleteHistory } from './history.mjs';
import { boardAssets, buildBoard } from './history-board.mjs';

const assets = new Map([
  ['/', ['history-ui/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['history-ui/app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['history-ui/style.css', 'text/css; charset=utf-8']],
  ...boardAssets,
]);
const secret = () => randomBytes(32).toString('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function onlyKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new Error('不支持的请求字段');
}
async function body(req) {
  let size = 0, chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new Error('请求过大'); chunks.push(chunk); }
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new Error('请求需要 application/json');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function startHistoryServer({ port = 0, service = null } = {}) {
  if (!Number.isInteger(port) || port !== 0 && (port < 1024 || port > 65535)) throw new Error('端口需要为 0 或 1024–65535 的整数');
  const token = secret(), csrf = secret(), tickets = new Map();
  let origin;
  const server = http.createServer(async (req, res) => {
    const send = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const styleNonce = randomBytes(18).toString('base64');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-${styleNonce}'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    try {
      if (req.headers.host !== new URL(origin).host || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return send(403, { error: '只允许本机地址访问' });
      if (req.headers.origin && req.headers.origin !== origin) return send(403, { error: 'Origin 校验失败' });
      if (!req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) return send(400, { error: '无效路径' });
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && assets.has(url.pathname)) {
        if (url.search) {
          const key = url.pathname === '/' ? 'preview' : url.pathname === '/board/' ? 's' : null;
          if (!key || [...url.searchParams.keys()].some(name => name !== key) || url.searchParams.getAll(key).length !== 1 || !/^[a-f0-9]{64}$/.test(url.searchParams.get(key))) throw new Error('页面只接受唯一的记录索引标识');
        }
        const [file, mime] = assets.get(url.pathname);
        const content = fs.readFileSync(new URL(file, import.meta.url));
        res.writeHead(200, { 'Content-Type': mime }); res.end(url.pathname === '/' ? content.toString('utf8').replace('<!--FOREMAN_STYLE_NONCE-->', `<meta name="foreman-style-nonce" content="${styleNonce}">`) : content); return;
      }
      if (!url.pathname.startsWith('/api/')) return send(404, { error: '路径不存在' });
      if (!equal(req.headers.authorization, `Bearer ${token}`)) return send(401, { error: '请使用启动命令给出的完整链接打开' });
      if (req.method === 'GET') {
        if (url.pathname === '/api/service/health' && service && !url.search) return send(200, { ...service.health(), csrf });
        if (url.pathname === '/api/records') return send(200, { records: listHistory({ search: url.searchParams.get('search') || '', provider: url.searchParams.get('provider') || '' }), roots: knownRoots(), csrf,
          import_cli: { executable: process.execPath, script: fileURLToPath(new URL('cli.mjs', import.meta.url)), arguments: ['history', '--refresh', '--workspace', '<工作区绝对路径>'] } });
        if (url.pathname === '/api/board') {
          if ([...url.searchParams.keys()].some(k => k !== 'id') || url.searchParams.getAll('id').length > 1) throw new Error('只允许记录标识');
          const board = buildBoard(listHistory()), id = url.searchParams.get('id');
          if (id === null) return send(200, board.universe);
          if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('无效记录标识');
          return board.snapshots[id] ? send(200, board.snapshots[id]) : send(404, { error: '记录不存在或缺少时间戳' });
        }
        if (url.pathname === '/api/preview') {
          if ([...url.searchParams.keys()].some(k => k !== 'id') || url.searchParams.getAll('id').length !== 1) throw new Error('只允许记录标识');
          return send(200, previewHistory(url.searchParams.get('id')));
        }
        return send(404, { error: '接口不存在' });
      }
      if (req.method !== 'POST') return send(405, { error: '不支持的方法' });
      if (req.headers.origin !== origin || !equal(req.headers['x-foreman-csrf'], csrf)) return send(403, { error: 'CSRF 校验失败' });
      if (url.search) throw new Error('此接口不接受查询参数');
      const input = await body(req);
      if (url.pathname === '/api/service/attach' && service) {
        onlyKeys(input, ['owner']);
        return send(200, await service.attach(input.owner));
      }
      if (url.pathname === '/api/service/stop' && service) {
        onlyKeys(input, ['instance_id']);
        if (!equal(input.instance_id, service.health().instance_id)) throw new Error('后台服务实例标识不匹配');
        res.once('finish', () => { setTimeout(() => { void service.stop(); }, 10); });
        return send(200, { stopped: true });
      }
      if (url.pathname === '/api/refresh') {
        onlyKeys(input, ['root_ids']);
        return send(200, { imports: refreshHistory(input.root_ids ?? null), records: listHistory(), roots: knownRoots() });
      }
      if (url.pathname === '/api/delete-preview') {
        onlyKeys(input, ['ids', 'delete_native_pi']);
        if (input.delete_native_pi !== undefined && typeof input.delete_native_pi !== 'boolean') throw new Error('delete_native_pi 需要布尔值');
        const deleteNativePi = input.delete_native_pi === true;
        const result = deleteHistory(input.ids, { deleteNativePi }), previews = input.ids.map(id => { try { return previewHistory(id); } catch (e) { return { id, error: e.message }; } });
        let ticket = null;
        if (!result.blocked.length) {
          for (const [id, value] of tickets) if (value.expires < Date.now()) tickets.delete(id);
          if (tickets.size >= 100) tickets.delete(tickets.keys().next().value);
          ticket = secret(); tickets.set(ticket, { ids: [...input.ids], fingerprint: hash(result.candidates), native: result.native_cleanup, deleteNativePi, expires: Date.now() + 300000 });
        }
        return send(200, { ...result, previews, ticket });
      }
      if (url.pathname === '/api/delete-confirm') {
        onlyKeys(input, ['ticket', 'confirmation']);
        const pending = tickets.get(input.ticket); tickets.delete(input.ticket);
        if (!pending || pending.expires < Date.now() || input.confirmation !== '删除所选记录') throw new Error('删除预览已失效或尚未确认，请重新预览');
        const current = deleteHistory(pending.ids, { deleteNativePi: pending.deleteNativePi });
        if (current.blocked.length || hash(current.candidates) !== pending.fingerprint) return send(409, { error: '记录状态已变化，请重新预览', blocked: current.blocked });
        return send(200, deleteHistory(pending.ids, { apply: true, deleteNativePi: pending.deleteNativePi, expectedNative: pending.native }));
      }
      return send(404, { error: '接口不存在' });
    } catch (error) { if (!res.headersSent) send(400, { error: error.message }); else res.end(); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, url: `${origin}/#${token}`, close: () => new Promise((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); server.closeIdleConnections?.(); }) };
}
export async function cmdHistoryUi(opts, configuredRoot = null) {
  if (opts.help) { process.stdout.write('history-ui [--background|--status|--stop] [--workspace <旧工作区>] [--legacy-global] [--no-open] [--port <0|1024–65535>]\n默认使用用户级端口 50418；已运行且身份核验通过则复用。--background 隐藏运行并返回，默认前台运行可 Ctrl+C 停止；--no-open 不打开浏览器。--status/--stop 只检查或停止已证明归属的后台实例。\n用户级 foreman/history-ui-settings.json 的 on_use:true 仅在实际调用 Foreman 时按需启动；默认关闭，不由 SessionStart 启动。可靠识别到 Windows Codex 宿主后，宿主退出会自然关闭服务。\n'); return; }
  if ([opts.background, opts.status, opts.stop].filter(Boolean).length > 1) throw new Error('--background、--status、--stop 不能组合');
  const { ensureHistoryUi, historyUiSettings, historyUiStatus, runHistoryUiService, stopHistoryUi } = await import('./history-ui-service.mjs');
  if (opts.status) {
    const status = await historyUiStatus(), settings = historyUiSettings();
    process.stdout.write(JSON.stringify({ running: status.running, reason: status.reason, on_use: settings.on_use, ...(status.running ? { url: status.url, pid: status.state.pid, port: status.state.port, owners: status.health.owners?.length || 0, manual_lifetime: status.health.manual_lifetime } : {}) }) + '\n'); return;
  }
  if (opts.stop) { process.stdout.write(JSON.stringify(await stopHistoryUi()) + '\n'); return; }
  if (opts.workspace) importWorkspace(opts.workspace, configuredRoot);
  if (opts['legacy-global']) importLegacyGlobal();
  refreshHistory();
  const requestedPort = opts.port === undefined ? historyUiSettings().port : /^\d+$/.test(String(opts.port)) ? Number(opts.port) : NaN;
  const { discoverCodexOwner } = await import('./codex-owner.mjs');
  const owner = await discoverCodexOwner();
  const status = await historyUiStatus();
  const ui = status.running || opts.background ? await ensureHistoryUi({ port: requestedPort, owner, manual: !owner }) : await runHistoryUiService({ port: requestedPort, owner, manual: !owner });
  process.stdout.write(`${JSON.stringify({ url: ui.url, pid: ui.state.pid, reused: ui.reused, background: Boolean(opts.background || ui.reused), scope: 'all-registered-workspaces' })}\n`);
  if (!opts['no-open']) {
    const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', ui.url] : [ui.url];
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', error => process.stderr.write(`foreman: 浏览器未打开，请使用启动 URL：${error.message}\n`)); child.unref();
  }
}
