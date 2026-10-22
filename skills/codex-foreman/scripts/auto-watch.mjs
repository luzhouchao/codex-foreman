import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const viewer = fileURLToPath(new URL('./watch-window.mjs', import.meta.url));
const quotePS = (text) => "'" + text.replaceAll("'", "''") + "'";
const encoded = (text) => Buffer.from(text, 'utf16le').toString('base64');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function powerShellExecutable(env = process.env, exists = fs.existsSync) {
  const candidates = [
    env.ProgramFiles && path.join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'),
    ...(env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir.replace(/^"|"$/g, ''), 'pwsh.exe')),
  ];
  return candidates.find((file) => file && exists(file)) || 'powershell.exe';
}

export function windowsLaunchScript(payload, shell = powerShellExecutable()) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64');
  const command = `$Host.UI.RawUI.WindowTitle = 'Codex Foreman'; & ${quotePS(process.execPath)} ${quotePS(viewer)} ${quotePS(data)}`;
  // The parent launcher is hidden; only the requested interactive viewer is visible.
  const keepOpen = payload.autoClose ? '' : "'-NoExit',";
  return `Start-Process -FilePath ${quotePS(shell)} -WindowStyle Normal -ArgumentList @('-NoLogo','-NoProfile',${keepOpen}'-EncodedCommand','${encoded(command)}') -ErrorAction Stop | Out-Null`;
}

function launchWindows(payload) {
  const shell = powerShellExecutable();
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(windowsLaunchScript(payload, shell))], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr.trim() || '无法启动实时窗口');
}

export function openAutoWatch(ctx, meta, { platform = process.platform, launch = launchWindows } = {}) {
  if (ctx.cfg.dispatch.watch !== 'auto') return { status: 'off' };
  if (platform !== 'win32') return { status: 'manual', reason: '当前自动窗口支持 Windows；可手动运行 watch' };
  const root = path.dirname(ctx.dir);
  const key = JSON.stringify([meta.host_session, meta.group ? ['group', meta.group] : ['run', meta.id]]);
  const lease = path.join(root, `.viewer-${createHash('sha256').update(key).digest('hex').slice(0, 24)}.json`);
  const token = randomUUID();
  try {
    // Atomic creation deduplicates concurrent participants in the same discussion.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.writeFileSync(lease, JSON.stringify({ token, pid: process.pid, pending: true, created: Date.now() }), { flag: 'wx' });
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let previous;
        try { previous = JSON.parse(fs.readFileSync(lease, 'utf8')); } catch {
          // A concurrent writer may not have finished; recover old truncated leases.
          if (Date.now() - fs.statSync(lease).mtimeMs < 15000) return { status: 'shared' };
          previous = {};
        }
        if (alive(previous.pid) && (!previous.pending || Date.now() - previous.created < 15000)) return { status: 'shared' };
        if (attempt > 0) return { status: 'shared' };
        fs.rmSync(lease, { force: true });
      }
    }
    const kind = meta.kind || meta.mode;
    launch({ lease, token, run: meta.id, group: meta.group, kind, autoClose: kind === 'discuss' || kind === 'exec', root, session: meta.host_session, ready: path.join(ctx.dir, 'viewer-ready.json') });
    return { status: 'requested', lease };
  } catch (error) {
    try { if (JSON.parse(fs.readFileSync(lease)).token === token) fs.rmSync(lease); } catch { /* best effort */ }
    return { status: 'failed', reason: error.message };
  }
}
