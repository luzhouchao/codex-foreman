// A window exits itself only after its verified Codex owner has exited. No PID is ever killed here.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
const normalized = value => String(value || '').replace(/\\/g, '/').toLowerCase();
const digest = owner => createHash('sha256').update(JSON.stringify([owner.platform, owner.kind, owner.pid, owner.started_at, normalized(owner.executable)])).digest('hex');
const recentlyVerified = new Map();
function knownExecutable(owner) {
  const exe = normalized(owner.executable);
  const programFiles = normalized(process.env.ProgramFiles || 'C:/Program Files').replace(/\/$/, '');
  const local = normalized(process.env.LOCALAPPDATA || '').replace(/\/$/, '');
  if (owner.kind === 'codex-desktop') return exe.startsWith(`${programFiles}/windowsapps/openai.codex_`) && /^openai\.codex_[^/]+\/app\/(?:chatgpt|codex)\.exe$/i.test(exe.slice(`${programFiles}/windowsapps/`.length));
  return owner.kind === 'codex-host' && local && exe.startsWith(`${local}/openai/codex/`) && /\/cli-[^/]+\/codex\.exe$/.test(exe);
}
function valid(owner) {
  return owner && typeof owner === 'object' && !Array.isArray(owner) && owner.schema_version === 1 && owner.platform === 'win32'
    && ['codex-desktop', 'codex-host'].includes(owner.kind) && Number.isSafeInteger(owner.pid) && owner.pid > 0
    && typeof owner.started_at === 'string' && Number.isFinite(Date.parse(owner.started_at))
    && typeof owner.executable === 'string' && path.win32.isAbsolute(owner.executable) && knownExecutable(owner) && owner.owner_id === digest(owner);
}
export function readOwnerFromEnv(env = process.env) {
  const raw = env.CODEX_FOREMAN_OWNER_JSON;
  if (typeof raw !== 'string' || raw.length > 4096) return null;
  try { const value = JSON.parse(raw); return valid(value) ? value : null; } catch { return null; }
}
async function query(pid, ancestors = false) {
  if (process.platform !== 'win32') return null;
  const script = `$ErrorActionPreference='Stop';$ownerQueryPid=${pid};$ownerRows=@();try{for($ownerStep=0;$ownerStep -lt ${ancestors ? 24 : 1};$ownerStep++){if($ownerQueryPid -le 0){break};$ownerProc=Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = '+$ownerQueryPid);if(-not $ownerProc){if($ownerStep -eq 0){@{state='absent'}|ConvertTo-Json -Compress;exit};break};$ownerRows+=@{pid=[int]$ownerProc.ProcessId;parent_pid=[int]$ownerProc.ParentProcessId;started_at=$ownerProc.CreationDate.ToUniversalTime().ToString('o');executable=[string]$ownerProc.ExecutablePath;backend=[bool]($ownerProc.CommandLine -match '(?:^|\\s)app-server(?:\\s|$)')};if([int]$ownerProc.ParentProcessId -eq $ownerQueryPid){break};$ownerQueryPid=[int]$ownerProc.ParentProcessId};@{state='found';processes=@($ownerRows)}|ConvertTo-Json -Depth 5 -Compress}catch{@{state='unknown'}|ConvertTo-Json -Compress}`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { windowsHide: true, timeout: 2500, maxBuffer: 65536 }, (error, stdout) => {
      if (error) return resolve(null);
      try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim())); } catch { resolve(null); }
    });
  });
}
export async function discoverCodexOwner() {
  // An inherited marker is still verified against the OS; it cannot replace process identity.
  const inherited = readOwnerFromEnv();
  if (inherited && await ownerStatus(inherited) === 'alive') return inherited;
  const result = await query(process.pid, true);
  if (result?.state !== 'found') return null;
  const candidates = [];
  for (const row of result.processes || []) for (const kind of ['codex-desktop', 'codex-host']) {
    const owner = { schema_version: 1, platform: 'win32', kind, pid: row.pid, started_at: row.started_at, executable: row.executable };
    if (knownExecutable(owner) && (kind !== 'codex-host' || row.backend)) { owner.owner_id = digest(owner); if (valid(owner)) candidates.push(owner); }
  }
  const owner = candidates.find(owner => owner.kind === 'codex-desktop') || candidates[0] || null;
  if (owner) recentlyVerified.set(owner.owner_id, Date.now());
  return owner;
}
export async function ownerStatus(owner) {
  if (!valid(owner) || process.platform !== 'win32') return 'unknown';
  if (Date.now() - (recentlyVerified.get(owner.owner_id) || 0) < 500) return 'alive';
  const result = await query(owner.pid);
  if (result?.state === 'absent') return 'exited';
  if (result?.state !== 'found') return 'unknown';
  const current = result.processes?.[0];
  if (!current?.started_at || !current.executable) return 'unknown';
  if (current.started_at !== owner.started_at || normalized(current.executable) !== normalized(owner.executable)) return 'exited';
  if (owner.kind === 'codex-host' && !current.backend) return 'unknown';
  recentlyVerified.set(owner.owner_id, Date.now());
  return 'alive';
}
