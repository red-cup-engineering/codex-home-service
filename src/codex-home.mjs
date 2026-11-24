// Codex home service: keeps a Codex home's placement, login link, searched data, workspace scans and plugin
// servers and agent scratch bounded, from one parameter record (specifications/requirements.md).
// Node built-ins only.
import {
  readFileSync, writeFileSync, existsSync, lstatSync, statSync, readdirSync, mkdirSync, renameSync,
  rmSync, rmdirSync, opendirSync, realpathSync, readlinkSync, symlinkSync,
  openSync, closeSync, fsyncSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { listProviderThreads, withThreadProvider } from './thread-provider.mjs';
import { receiveWorkspaceGit, recheckWorkspaceGit, gitMaintenanceHoldState, applyGitMaintenanceHold, runWorkspaceGit } from './git-maintenance-hold.mjs';

export const BEGIN = '# BEGIN codex-home-service (managed: change the parameter record, not this block)';
export const END = '# END codex-home-service';
const DAY_MS = 86_400_000;

// ---------- pure ----------

/** Replace the managed block in `text` with `lines`, or append it. Returns { text, changed }. */
export function mergeManagedBlock(text, lines) {
  const block = [BEGIN, ...lines, END].join('\n');
  const all = text.split('\n');
  const start = all.findIndex((l) => l.startsWith('# BEGIN codex-home-service'));
  const end = start < 0 ? -1 : all.findIndex((l, i) => i > start && l.trim() === END);
  let next;
  if (start >= 0 && end > start) {
    next = [...all.slice(0, start), block, ...all.slice(end + 1)].join('\n');
  } else {
    const base = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
    next = `${base}${base.length ? '\n' : ''}${block}\n`;
  }
  return { text: next, changed: next !== text };
}

/** `text` with its managed block removed (to see what the owner wrote outside it). */
export function withoutManagedBlock(text) {
  const all = text.split('\n');
  const start = all.findIndex((l) => l.startsWith('# BEGIN codex-home-service'));
  const end = start < 0 ? -1 : all.findIndex((l, i) => i > start && l.trim() === END);
  return start >= 0 && end > start ? [...all.slice(0, start), ...all.slice(end + 1)].join('\n') : text;
}

/** CH-30: absolute directories with no characters a shell would read as syntax; refused otherwise. */
export function shellPathDirectories(record) {
  const dirs = record.shellPath ?? [];
  if (!Array.isArray(dirs) || !dirs.every((d) => typeof d === 'string' && /^\/[A-Za-z0-9_@%+=,.\/-]*$/u.test(d) && !d.includes('//') && d !== '/')) {
    throw new Error('shellPath must be a list of absolute directories made of letters, digits and _@%+=,./-');
  }
  return [...new Set(dirs)];
}

/**
 * CH-31: variables the record exports in login shells, each `NAME: value`. A value is plain text or `${NAME}`
 * references to variables already set (the credentials directory, say), so a tool's configuration can be named
 * as a file credential custody renders rather than a file in a home directory. Names the block already owns
 * (CODEX_HOME, PATH) and anything a shell would read as syntax are refused.
 */
export function shellEnvironmentExports(record) {
  const entries = Object.entries(record.shellEnvironment ?? {});
  const plain = /^(?:[A-Za-z0-9_@%+=,.\/:-]|\$\{[A-Z][A-Z0-9_]*\})+$/u;
  if (!entries.every(([name, value]) => /^[A-Z][A-Z0-9_]*$/u.test(name) && !['CODEX_HOME', 'PATH'].includes(name) && typeof value === 'string' && plain.test(value))) {
    throw new Error('shellEnvironment must map UPPER_CASE names (not CODEX_HOME or PATH) to values made of letters, digits, _@%+=,./:- and ${NAME} references');
  }
  return entries.map(([name, value]) => `export ${name}="${value}"`);
}

export function shellRcLines(record) {
  const dirs = shellPathDirectories(record);
  const exported = shellEnvironmentExports(record);
  return [
    '# The Codex home lives on the Linux filesystem only; a home on /mnt/* (the Windows bridge) made every',
    '# Codex start take minutes (observed-2026-10-14 in the record). Kept last so nothing above overrides it.',
    `export CODEX_HOME="${record.home}"`,
    ...(exported.length === 0 ? [] : ['# Variables of the record\'s shellEnvironment.', ...exported]),
    ...(dirs.length === 0 ? [] : [
      '# Directories of the record\'s shellPath, ahead of the system ones (each added once, however many shells nest).',
      ...dirs.toReversed().map((d) => `case ":$PATH:" in *":${d}:"*) ;; *) PATH="${d}:$PATH" ;; esac`),
      'export PATH',
    ]),
  ];
}

export function pluginHeader(plugin, server) {
  return `[plugins."${plugin}".mcp_servers.${/^[A-Za-z0-9_-]+$/.test(server) ? server : `"${server}"`}]`;
}

/** 'disabled' | 'enabled' | 'absent' for one plugin MCP server in a config.toml text. */
export function pluginServerState(text, plugin, server) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim() === pluginHeader(plugin, server));
  if (i < 0) return 'absent';
  for (let j = i + 1; j < lines.length && !lines[j].trim().startsWith('['); j++) {
    if (/^\s*enabled\s*=\s*false\s*(#.*)?$/.test(lines[j])) return 'disabled';
  }
  return 'enabled';
}

/** The plugin block: one table per disabled server not already declared outside the block. */
export function pluginLines(record, configText) {
  const outside = withoutManagedBlock(configText);
  const out = [];
  for (const { plugin, server } of record.disabledPluginMcpServers ?? []) {
    if (pluginServerState(outside, plugin, server) !== 'absent') continue;
    out.push(pluginHeader(plugin, server), 'enabled = false');
  }
  return out;
}

/** Thread ids to archive: unarchived, rollout present in the searched folder, idle longer than idleDays. */
export function selectRetention(threads, filesByPath, nowMs, idleDays) {
  return threads
    .filter((t) => !t.archived && filesByPath.has(t.rollout_path))
    .filter((t) => nowMs - filesByPath.get(t.rollout_path).mtimeMs > idleDays * DAY_MS)
    .map((t) => ({ id: t.id, bytes: filesByPath.get(t.rollout_path).size }));
}

/** Files in the searched folder that no thread references and that have been idle for a day. */
export function selectLegacy(files, referenced, nowMs) {
  return files.filter((f) => !referenced.has(f.path) && nowMs - f.mtimeMs > DAY_MS);
}

function canSkipThreadProvider(files, nowMs, idleDays) {
  return files.every((file) => nowMs - file.mtimeMs <= Math.min(idleDays * DAY_MS, DAY_MS));
}

export function renderTimerUnits(record, script, parameters) {
  const r = record.retention;
  const scopes = ['retention', ...(record.scratch ? ['scratch'] : []), ...(record.harnessResources ? ['harness'] : [])].join(',');
  return {
    service: [
      '[Unit]',
      `Description=Codex home retention (codex-home-service): archive idle threads, move legacy logs${record.scratch ? ', expire idle agent scratch' : ''}`,
      '',
      '[Service]',
      'Type=oneshot',
      'SuccessExitStatus=2',              // apply exits 2 when drift remains: it ran
      `ExecStart=${record.node} ${script} apply --scope=${scopes} --parameters=${parameters}`,
      'Nice=19',
      'IOSchedulingClass=idle',
      '',
    ].join('\n'),
    timer: [
      '[Unit]',
      'Description=Run Codex home retention',
      '',
      '[Timer]',
      `OnCalendar=${r.onCalendar}`,
      `OnBootSec=${r.onBootDelay}`,
      'Persistent=true',
      '',
      '[Install]',
      'WantedBy=timers.target',
      '',
    ].join('\n'),
  };
}

// ---------- host observation ----------

export function loadRecord(path) {
  const record = JSON.parse(readFileSync(path, 'utf8'));
  if (record.schema !== 'codex-home-parameters@1') throw new Error(`${path}: schema is not codex-home-parameters@1`);
  return record;
}

function readText(p) { return existsSync(p) ? readFileSync(p, 'utf8') : ''; }
function lstatOrNull(p) { try { return lstatSync(p); } catch { return null; } }

/** CH-22: the environment `systemctl --user` needs to find the manager that runs the timer; a wsl.exe shell has none. */
function userManagerEnv(env = process.env) {
  return env.XDG_RUNTIME_DIR ? env : { ...env, XDG_RUNTIME_DIR: `/run/user/${process.getuid()}` };
}
function systemctlUser(...args) {
  return execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', env: userManagerEnv(), stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** Every file in the searched folder (the folder Codex's search reads anyway; nothing else is walked). */
export function sessionFiles(home) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { const s = statSync(p); out.push({ path: p, size: s.size, mtimeMs: s.mtimeMs }); }
    }
  };
  if (existsSync(join(home, 'sessions'))) walk(join(home, 'sessions'));
  return out;
}

/** Provider metadata is authoritative; its private storage never crosses this boundary. */
export async function readThreads(home, { binary, files = sessionFiles(home), connect = withThreadProvider } = {}) {
  const rows = await connect({ binary, home }, listProviderThreads);
  return rows.map(row => {
    if (row.rollout_path !== null) return row;
    const matches = files.filter(file => file.path.endsWith(`-${row.id}.jsonl`));
    if (matches.length > 1) throw new Error('ambiguous rollout for native thread');
    return { ...row, rollout_path: matches[0]?.path ?? null };
  });
}

export function codexBinary(glob) {
  const [prefix, suffix] = glob.split('*');
  if (suffix === undefined || !existsSync(prefix)) return null;
  return readdirSync(prefix).map((d) => join(prefix, d, suffix.replace(/^\//, '')))
    .filter((p) => existsSync(p)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

// CH-15: agent git commands search every pack the multi-pack index does not cover.
export function uncoveredPacks(packs, midxMtimeMs) {
  return midxMtimeMs == null ? packs.length : packs.filter((p) => p.mtimeMs > midxMtimeMs).length;
}
function gitMaintenanceState(repo, commonDir = join(repo, '.git')) {
  const packDir = join(commonDir, 'objects', 'pack');
  const packs = existsSync(packDir) ? readdirSync(packDir).filter((n) => n.endsWith('.pack')).map((n) => ({ mtimeMs: statSync(join(packDir, n)).mtimeMs })) : [];
  const midx = lstatOrNull(join(packDir, 'multi-pack-index'));
  const timers = ['hourly', 'daily', 'weekly'].map((s) => {
    try { return `${s}:${systemctlUser('is-enabled', `git-maintenance@${s}.timer`)}`; }
    catch { return `${s}:disabled`; }
  });
  return { packs: packs.length, uncoveredPacks: uncoveredPacks(packs, midx?.mtimeMs ?? null), timers, timersEnabled: timers.every((t) => t.endsWith(':enabled')) };
}

// CH-2: one login. The desktop app writes auth.json in the Windows profile's Codex folder at sign-in and cannot
// write through a link into the Linux filesystem, so the real file lives there and the home links to it.
export function classifyLogin(home, win, winPath) {
  if (!win || win.isSymbolicLink()) return { ok: false, detail: `${winPath} must be the real file (the app cannot store a sign-in through a link)`, action: home && !home.isSymbolicLink() ? 'move-home-to-windows' : 'manual' };
  if (!home) return { ok: false, detail: 'home has no auth.json', action: 'link-home' };
  if (home.isSymbolicLink()) return { ok: true, detail: `home links to ${winPath}` };
  return { ok: false, detail: 'two separate credential files', action: 'link-home-if-identical' };
}
function loginState(record) {
  const homeAuth = join(record.home, 'auth.json'), winAuth = join(record.windowsProfileCodexDir, 'auth.json');
  const c = classifyLogin(lstatOrNull(homeAuth), lstatOrNull(winAuth), winAuth);
  if (c.ok && readlinkOrNull(homeAuth) !== winAuth) return { ok: false, detail: `home links to ${readlinkOrNull(homeAuth)}, not ${winAuth}`, action: 'relink-home', homeAuth, winAuth };
  return { ...c, homeAuth, winAuth };
}
function readlinkOrNull(p) { try { return readlinkSync(p); } catch { return null; } }

/**
 * CH-1: what a login shell resolves when it starts the way the desktop app starts the app-server, with the
 * Windows profile's Codex folder already in CODEX_HOME (forwarded through WSLENV; measured 2026-10-18).
 */
export function loginShellCodexHome(forwarded, env = process.env) {
  return execFileSync('bash', ['-lc', 'printf %s "${CODEX_HOME:-$HOME/.codex}"'], { encoding: 'utf8', env: { ...env, CODEX_HOME: forwarded }, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** CH-17: the CODEX_HOME each running Codex app-server started with ({pid, home}), read from `proc`. */
export function runningAppServerHomes(proc = '/proc', defaultHome = join(homedir(), '.codex')) {
  const out = [];
  for (const pid of readdirSync(proc).filter((d) => /^\d+$/.test(d))) {
    let argv, env;
    try { argv = readFileSync(join(proc, pid, 'cmdline'), 'utf8').split('\0'); env = readFileSync(join(proc, pid, 'environ'), 'utf8').split('\0'); } catch { continue; }
    if (!/(^|\/)codex$/.test(argv[0] ?? '') || !argv.includes('app-server')) continue;
    out.push({ pid: Number(pid), home: env.find((e) => e.startsWith('CODEX_HOME='))?.slice('CODEX_HOME='.length) || defaultHome });
  }
  return out;
}

const timerDir = () => join(homedir(), '.config', 'systemd', 'user');

// CH-14: the schedule runs an installed copy, so a checkout change (clean, submodule update) cannot remove it.
const INSTALLED = ['package.json', 'src/git-maintenance-hold.mjs', 'src/codex-home.mjs', 'src/thread-provider.mjs', 'scripts/codex-home.mjs'];
export function installedPaths(record) {
  return { script: join(record.installDir, 'scripts', 'codex-home.mjs'), parameters: join(record.installDir, 'codex-home.json') };
}

/** CH-36: an enabled timer is not evidence that its scheduled work succeeded. */
export function retentionExecutionState(text) {
  const unknown = { current: false, state: 'unobserved', detail: 'scheduled service result unavailable or incomplete' };
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16384) return unknown;
  const fields = new Map();
  const names = ['LoadState', 'ActiveState', 'SubState', 'Result', 'ExecMainStatus', 'ExecMainExitTimestampMonotonic', 'MainPID'];
  for (const line of text.trim().split('\n')) {
    const at = line.indexOf('=');
    if (at < 1) return unknown;
    const key = line.slice(0, at), value = line.slice(at + 1);
    if (!names.includes(key) || fields.has(key) || value.length > 256) return unknown;
    fields.set(key, value);
  }
  if (fields.size !== names.length || fields.get('LoadState') !== 'loaded'
      || !['ExecMainStatus', 'ExecMainExitTimestampMonotonic', 'MainPID'].every(key => /^\d{1,20}$/u.test(fields.get(key)))) return unknown;
  const active = fields.get('ActiveState'), sub = fields.get('SubState'), result = fields.get('Result');
  if (active === 'failed' || result !== 'success') return {
    current: false, state: 'failed', detail: `scheduled service ${active}/${sub}, result ${result}, exit ${fields.get('ExecMainStatus')}`,
  };
  if (['active', 'activating'].includes(active) && BigInt(fields.get('MainPID')) > 0n) return {
    current: true, state: 'running', detail: `scheduled service ${active}/${sub}; current execution has not settled`,
  };
  if (active === 'inactive' && sub === 'dead' && fields.get('MainPID') === '0'
      && ['0', '2'].includes(fields.get('ExecMainStatus')) && BigInt(fields.get('ExecMainExitTimestampMonotonic')) > 0n) return {
    current: true, state: 'completed', detail: `last scheduled execution succeeded (exit ${fields.get('ExecMainStatus')}); remaining plan drift is separate`,
  };
  return unknown;
}

function readRetentionExecution() {
  try {
    return retentionExecutionState(execFileSync('systemctl', ['--user', 'show', 'codex-home-retention.service',
      '--property=LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainExitTimestampMonotonic,MainPID', '--no-pager'],
    { encoding: 'utf8', env: userManagerEnv(), timeout: 5000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { return retentionExecutionState(null); }
}
function installPlan(record, { script, parameters }) {
  const root = dirname(dirname(script));
  return [
    ...INSTALLED.map((f) => ({ from: join(root, f), to: join(record.installDir, f) })),
    { from: parameters, to: installedPaths(record).parameters },
  ];
}
const MB = (b) => `${(b / 1e6).toFixed(0)} MB`;

// ---------- CH-16 agent scratch ----------
/** Newest mtime among a scratch entry and its immediate children: two levels of lstat, never a tree walk. */
export function scratchNewestMs(path) {
  let newest = lstatSync(path).mtimeMs;
  let names = [];
  try { names = readdirSync(path); } catch { /* a file, or unreadable: the entry's own mtime stands */ }
  for (const name of names) newest = Math.max(newest, lstatOrNull(join(path, name))?.mtimeMs ?? 0);
  return newest;
}

function openPaths() {
  const out = [];
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try { out.push(readlinkSync(`/proc/${pid}/cwd`)); } catch { /* gone or not ours */ }
    let fds = [];
    try { fds = readdirSync(`/proc/${pid}/fd`); } catch { /* gone or not ours */ }
    for (const fd of fds) { try { out.push(readlinkSync(`/proc/${pid}/fd/${fd}`)); } catch { /* closed */ } }
  }
  return out;
}
const mountPoints = () => readText('/proc/self/mountinfo').split('\n').map((l) => l.split(' ')[4]).filter(Boolean);
const under = (paths, p) => paths.some((x) => x === p || x.startsWith(`${p}/`));

/** The scratch idle limit: the record's days. */
export function scratchLimit(record) {
  const days = record.scratch.idleDays;
  if (!Number.isFinite(days) || days <= 0) throw new Error('finite bounded scratch cutoff required');
  return { ms: days * DAY_MS, text: `${days} d` };
}

/** Every top-level entry under each scratch root, measured and decided (CH-16). */
export function scratchRetirementOwners(record) {
  return (record.scratch?.roots ?? []).map(root => {
    if (!Object.hasOwn(root, 'retirementOwner')) return null;
    const value = root.retirementOwner;
    let url;
    try { url = new URL(value); } catch { throw new TypeError('canonical HTTPS scratch retirement owner required'); }
    if (typeof value !== 'string' || value.length > 2048 || url.href !== value || url.protocol !== 'https:'
        || url.username || url.password || url.search || url.hash || url.pathname === '/')
      throw new TypeError('canonical HTTPS scratch retirement owner required');
    return value;
  });
}

/** Receive emptiness without a recursive source/checkout census. */
function emptyScratchDirectory(path) {
  try {
    const s = lstatSync(path);
    if (!s.isDirectory() || s.uid !== process.getuid() || realpathSync(path) !== path) return null;
    const dir = opendirSync(path);
    try { if (dir.readSync() !== null) return null; } finally { dir.closeSync(); }
    return { dev: s.dev, ino: s.ino };
  } catch { return null; }
}

/** Every top-level entry under each scratch root, with its fate (CH-16): older than `idleMs`, and not kept, mounted or some process's cwd or open file. */
export function observeScratch(record, now = Date.now(), { idleMs = record.scratch?.idleDays * DAY_MS, readRootEntries = readdirSync } = {}) {
  const s = record.scratch;
  if (!s) return [];
  const owners = scratchRetirementOwners(record);
  const cutoffMs = now - idleMs;
  const active = owners.some(owner => !owner);
  const open = active ? openPaths() : [], mounts = active ? mountPoints() : [];
  const admits = (root, name) => !root.match || new RegExp(root.match).test(name);
  return s.roots.flatMap((root, index) => {
    if (owners[index]) return [{ root: root.path, name: '', path: root.path, expire: false, retirementOwner: owners[index], reason: 'retirement delegated to ' + owners[index] }];
    return (existsSync(root.path) ? readRootEntries(root.path) : []).filter((name) => admits(root, name)).map((name) => {
      const path = join(root.path, name), e = { root: root.path, name, path };
      if ((root.keep ?? []).includes(name)) return { ...e, expire: false, reason: 'kept by the record' };
      if (under(mounts, path)) return { ...e, expire: false, reason: 'a filesystem is mounted inside' };
      if (under(open, path)) return { ...e, expire: false, reason: 'open in a running process' };
      const emptyIdentity = emptyScratchDirectory(path);
      if (!emptyIdentity) return { ...e, expire: false, reason: 'contents or custody retained for original-owner recovery/reuse/publication' };
      e.emptyIdentity = emptyIdentity;
      let newestMs;
      try { newestMs = scratchNewestMs(path); } catch { return { ...e, expire: false, reason: 'gone' }; }
      return newestMs > cutoffMs ? { ...e, expire: false, reason: 'active' } : { ...e, expire: true, reason: `unchanged since ${new Date(newestMs).toISOString().slice(0, 10)}` };
    });
  });
}

export async function observe(record, { script, parameters }) {
  scratchRetirementOwners(record);
  const items = [];
  const add = (id, ok, detail) => items.push({ id, status: ok ? 'current' : 'drift', detail });
  const now = Date.now();
  if (record.harnessResources) {
    try {
      const results = await reconcileHarnessResources(record, { dryRun: true });
      for (const result of results) add(`CH-26 harness ${result.workspace}`, result.written.length === 0,
        `${result.written.length ? `drift: ${result.written.join(', ')}` : 'source references current'}; active session enforcement unverified${result.codexTrustRequired ? '; Codex trust remains provider-owned' : ''}`);
      for (const result of results) for (const context of result.context ?? []) add(`CH-CONTEXT ${context.provider} ${result.workspace}`, !context.changed,
        `${context.changed ? 'context source registration drift' : 'context source references current'}; running-session uptake unverified${context.provider === 'codex' ? '; Codex trust remains provider-owned' : ''}`);
      const containment = results.find(result => result.containment)?.containment;
      if (containment) add('CH-27 harness containment', !containment.changed,
        `shared work-slice declaration ${containment.workUnit}; active provider enforcement remains unverified`);
    } catch (error) { add('CH-26 harness resources', false, error.message); }
  }

  const resolved = loginShellCodexHome(record.windowsProfileCodexDir);
  add('CH-1 home', resolved === record.home && !resolved.startsWith('/mnt/'), `login shell started with the app's CODEX_HOME resolves ${resolved}`);
  const rc = readText(record.shellRc);
  add('CH-1 shell block', mergeManagedBlock(rc, shellRcLines(record)).changed === false, record.shellRc);
  if (record.loginProfile) add('CH-1 login profile block', mergeManagedBlock(readText(record.loginProfile), shellRcLines(record)).changed === false, record.loginProfile);
  const servers = runningAppServerHomes(), astray = servers.filter((s) => s.home !== record.home);
  add('CH-17 running app-server', astray.length === 0, !servers.length ? 'none running' : astray.length ? `${astray.map((s) => `pid ${s.pid} on ${s.home}`).join('; ')}: restart the Codex app` : `${servers.length} on ${record.home}`);

  const login = loginState(record);
  add('CH-2 one login', login.ok, login.detail);
  const prof = lstatOrNull(record.windowsProfileCodexDir);
  add('CH-3 profile folder', !!prof && prof.isDirectory() && !prof.isSymbolicLink(), prof ? (prof.isSymbolicLink() ? 'a link: the app refuses it' : 'real directory') : 'absent');

  const files = sessionFiles(record.home);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const total = files.reduce((s, f) => s + f.size, 0);
  add('CH-4 searched size', total <= record.retention.searchedSoftLimitBytes, `${MB(total)} in ${files.length} files (limit ${MB(record.retention.searchedSoftLimitBytes)})`);
  try {
    const threads = canSkipThreadProvider(files, now, record.retention.idleDays) ? []
      : await readThreads(record.home, { binary: codexBinary(record.codexBinaryGlob), files });
    const toArchive = selectRetention(threads, byPath, now, record.retention.idleDays);
    add('CH-4 retention', toArchive.length === 0, `${toArchive.length} threads idle > ${record.retention.idleDays} d, ${MB(toArchive.reduce((s, t) => s + t.bytes, 0))}`);
    const legacy = selectLegacy(files, new Set(threads.map((t) => t.rollout_path)), now);
    add('CH-5 legacy', legacy.length === 0, `${legacy.length} unreferenced files, ${MB(legacy.reduce((s, f) => s + f.size, 0))}`);
  } catch (error) { add('CH-4 thread query', false, `unknown; no copy or retry: ${error.message}`); }

  for (const ws of record.workspaces ?? []) {
    let identity;
    try {
      identity = receiveWorkspaceGit(ws.path);
      const ex = readText(join(identity.commonDir, 'info', 'exclude'));
      add(`CH-6 workspace ${ws.path}`, mergeManagedBlock(ex, ws.excludes).changed === false, `exclude block ${ws.excludes.join(' ')}`);
    } catch (error) {
      add(`CH-6 workspace ${ws.path}`, false, `native Git identity unknown: ${error.message}`);
      if (ws.gitMaintenance === false) add(`CH-15 git maintenance ${ws.path}`, false, 'hold not received; native workspace observation refused');
      continue;
    }
    try {
      if (ws.gitMaintenance === false) {
        const held = gitMaintenanceHoldState(identity);
        add(`CH-15 git maintenance ${ws.path}`, held.held,
          `selected registration ${held.registered ? 'present' : 'absent'}; local auto=${held.localAuto ?? 'unset'} gc=${held.localGc ?? 'unset'}; effective auto=${held.effectiveAuto ?? 'unset'} gc=${held.effectiveGc ?? 'unset'}; ${held.held ? 'held' : 'hold not received'}; running/manual work not cancelled`);
      } else if (ws.gitMaintenance === true) {
        const m = gitMaintenanceState(ws.path, identity.commonDir);
        add(`CH-15 git maintenance ${ws.path}`, m.timersEnabled && m.uncoveredPacks <= (ws.maxUncoveredPacks ?? 10),
          `timers ${m.timers.join(' ')}; ${m.uncoveredPacks} of ${m.packs} packs newer than the multi-pack index`);
      }
    } catch (error) {
      add(`CH-15 git maintenance ${ws.path}`, false, `native maintenance state unknown; hold not received: ${error.message}`);
    }
  }

  if (record.scratch) {
    let limit;
    try { limit = scratchLimit(record); }
    catch (error) { add('CH-16 scratch admission', false, error.message); return items; }
    for (const root of record.scratch.roots) {
      items.push({ id: `CH-16 scratch policy ${root.path}`, status: 'current', detail: root.retirementOwner
        ? `retirement delegated to ${root.retirementOwner}; no listing`
        : `not inspected by health plan; age > ${limit.text} selects empty-directory candidates only; contents remain for original-owner recovery` });
    }
  }

  const config = readText(join(record.home, 'config.toml'));
  for (const { plugin, server } of record.disabledPluginMcpServers ?? []) {
    const state = pluginServerState(config, plugin, server);
    add(`CH-8 ${plugin}/${server}`, state === 'disabled', state);
  }

  const inst = installedPaths(record);
  const units = renderTimerUnits(record, inst.script, inst.parameters);
  const svc = readText(join(timerDir(), 'codex-home-retention.service'));
  const tmr = readText(join(timerDir(), 'codex-home-retention.timer'));
  let enabled = '';
  try { enabled = systemctlUser('is-enabled', 'codex-home-retention.timer'); } catch { enabled = 'disabled'; }
  const unitsOk = svc === units.service && tmr === units.timer;
  add('CH-7 retention timer', unitsOk && enabled === 'enabled', `units ${unitsOk ? 'current' : 'differ'}, ${enabled}`);
  const execution = readRetentionExecution();
  add('CH-36 retention execution', execution.current, execution.detail);
  const copies = installPlan(record, { script, parameters });
  add('CH-14 installed copy', copies.every((c) => readText(c.from) === readText(c.to)), record.installDir);
  return items;
}

// ---------- host change ----------

/** The record selects the shared owning controller; no executable copy or provider trust is fabricated. */
export async function reconcileHarnessResources(record, { dryRun = false } = {}) {
  const selected = record.harnessResources;
  if (!selected) return [];
  if (typeof selected.source !== 'string' || !selected.source.startsWith('/') || !Array.isArray(selected.workspaces)) throw new Error('harnessResources needs an absolute owning source and workspaces');
  for (const workspace of selected.workspaces) {
    if (typeof workspace.path !== 'string' || !workspace.path.startsWith('/') || !workspace.providers?.length || workspace.providers.some(p => !['claude', 'codex'].includes(p))) throw new Error('invalid harness resource workspace');
  }
  let contextInstaller;
  if (selected.houseContextInstaller !== undefined) {
    if (typeof selected.houseContextInstaller !== 'string' || !selected.houseContextInstaller.startsWith('/')) throw new Error('harnessResources houseContextInstaller needs its absolute owning source');
    contextInstaller = (await import(pathToFileURL(selected.houseContextInstaller).href)).installHouseContextHook;
    if (typeof contextInstaller !== 'function') throw new Error('selected context installer lacks its native install operation');
  }
  const { writeHostResourceControl } = await import(pathToFileURL(selected.source).href);
  const results = selected.workspaces.map(workspace => ({ workspace: workspace.path,
    ...writeHostResourceControl({ node: workspace.path, providers: workspace.providers, retiredSources: selected.retiredSources ?? [], dryRun }),
    ...(contextInstaller === undefined ? {} : { context: workspace.providers.map(provider => ({ provider,
      ...contextInstaller({ settings: join(workspace.path, provider === 'codex' ? '.codex/hooks.json' : '.claude/settings.local.json'), trees: [workspace.path], node: record.node ?? process.execPath, dryRun }) })) }),
  }));
  if (selected.containmentInstaller && results.length) {
    if (typeof selected.containmentInstaller !== 'string' || !selected.containmentInstaller.startsWith('/')) throw new Error('harnessResources containmentInstaller needs its absolute owning source');
    const { installContainment } = await import(pathToFileURL(selected.containmentInstaller).href);
    if (typeof installContainment !== 'function') throw new Error('selected harness installer lacks its native containment operation');
    results[0].containment = installContainment({ dryRun });
  }
  return results;
}

function writeInstalled(path, text, log) {
  if (readText(path) === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  const staged = path + '.install-' + process.pid;
  const fd = openSync(staged, 'wx', 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(staged, path);
  const dir = openSync(dirname(path), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
  log.push('installed ' + path);
  return true;
}
function writeIfChanged(path, text, log, label) {
  if (readText(path) === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  log.push(`wrote ${label ?? path}`);
  return true;
}

/** Remove the entries `observeScratch` decided to expire. Returns the count removed. */
function removeExpired(observed, log) {
  let removed = 0;
  for (const x of observed.filter((e) => e.expire)) {
    try {
      const current = emptyScratchDirectory(x.path);
      if (!current || !x.emptyIdentity || current.dev !== x.emptyIdentity.dev || current.ino !== x.emptyIdentity.ino) {
        x.expire = false; x.reason = 'changed or nonempty directory retained'; continue;
      }
      rmdirSync(x.path); // Native ENOTEMPTY protects a child created after receiving.
      removed++;
      log.push(`expired ${x.path} (${x.reason})`);
    } catch (err) { x.expire = false; x.reason = 'native directory retirement refused; contents retained'; log.push(`could not remove ${x.path}: ${err.code ?? err.message}`); }
  }
  return removed;
}

const processGone = (pid, proc) => !existsSync(join(proc, String(pid)));

/**
 * CH-35: an event, not a clock, retires one session's scratch: the entry named `session` in each root not delegated
 * to a retirement owner, with no idle wait, through the same guards as the scratch scope (kept, mounted, open). With `afterPid` it first waits, up to `waitMs`, for that process
 * (the ending session itself) to exit, because a session's own process still holds its folder when SessionEnd fires.
 * Returns { removed, held: [{ path, reason }], log }.
 */
export async function retireSession(record, { session, afterPid = null, waitMs = 600_000, processRoot = '/proc', pollMs = 200 }) {
  scratchRetirementOwners(record);
  if (typeof session !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(session)) throw new TypeError('a session id of letters, digits and ._- is required');
  const roots = (record.scratch?.roots ?? []).filter((r) => !r.retirementOwner);
  const log = [], held = [];
  const deadline = performance.now() + waitMs;
  while (afterPid && !processGone(afterPid, processRoot)) {
    if (performance.now() >= deadline) return { removed: 0, held: [{ path: session, reason: `session process ${afterPid} still running` }], log };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  let removed = 0;
  for (const root of roots) {
    if (!existsSync(join(root.path, session))) continue;
    const observed = observeScratch({ ...record, scratch: { ...record.scratch, roots: [root] } }, Date.now(), { idleMs: 0, readRootEntries: () => [session] });
    removed += removeExpired(observed, log);
    for (const x of observed.filter((e) => !e.expire)) held.push({ path: x.path, reason: x.reason });
  }
  return { removed, held, log };
}

/** Scopes in the order `apply` runs them; each is independent of the others (CH-32). */
export const APPLY_SCOPES = Object.freeze(['harness', 'placement', 'retention', 'scratch', 'workspace', 'config', 'timer']);

/** A scope's failure, kept with what the other scopes did. */
export class ApplyFailed extends Error {
  constructor(log, failures) {
    super(`apply failed in ${failures.map((f) => f.scope).join(', ')}: ${failures.map((f) => f.error.message).join('; ')}`);
    this.name = 'ApplyFailed';
    this.log = log;
    this.failures = failures;
  }
}

/**
 * CH-32: refuse the record before any effect (legacy maintenance selectors, malformed retirement owners: CH-23, CH-25), then run each selected scope on its own. One scope's failure is reported
 * and the others still run. Returns { log: what changed, notes: what was seen and left, failures: [{ scope, error }] }.
 */
export async function applyScopes(record, scope, { script, parameters }, ports = {}) {
  scratchRetirementOwners(record);
  const log = [];
  const notes = [];
  const failures = [];
  const scopes = String(scope).split(',');
  const want = (s) => scopes.includes('all') || scopes.includes(s);

  const steps = {
    async harness() {
      for (const result of await reconcileHarnessResources(record)) {
        for (const file of result.written) log.push(`harness source reference ${join(result.workspace, file)}`);
        for (const context of result.context ?? []) if (context.changed) log.push(`harness context source reference ${context.settings}`);
        if (result.containment?.changed) log.push(`harness containment reconciled ${result.containment.workUnit}`);
      }
    },

    async placement() {
      const rc = readText(record.shellRc);
      writeIfChanged(record.shellRc, mergeManagedBlock(rc, shellRcLines(record)).text, log, `${record.shellRc} (managed block)`);
      if (record.loginProfile) writeIfChanged(record.loginProfile, mergeManagedBlock(readText(record.loginProfile), shellRcLines(record)).text, log, `${record.loginProfile} (managed block)`);
      for (const s of runningAppServerHomes().filter((s) => s.home !== record.home)) log.push(`WINDOWS restart the Codex app: its app-server (pid ${s.pid}) still runs on ${s.home}`);
      const l = loginState(record);
      if (!l.ok) {
        const same = () => existsSync(l.homeAuth) && existsSync(l.winAuth) && readFileSync(l.homeAuth).equals(readFileSync(l.winAuth));
        if (l.action === 'move-home-to-windows') {
          const bytes = readFileSync(l.homeAuth);
          if (lstatOrNull(l.winAuth)) rmSync(l.winAuth);            // a link: removes the link only
          writeFileSync(l.winAuth, bytes); rmSync(l.homeAuth); symlinkSync(l.winAuth, l.homeAuth);
          log.push(`moved the login to ${l.winAuth} and linked the home to it`);
        } else if (l.action === 'link-home' || l.action === 'relink-home' || (l.action === 'link-home-if-identical' && same())) {
          if (lstatOrNull(l.homeAuth)) rmSync(l.homeAuth);
          symlinkSync(l.winAuth, l.homeAuth);
          log.push(`linked ${l.homeAuth} -> ${l.winAuth}`);
        } else {
          log.push(`left as is: ${l.detail}; the two credential files differ, so the owner chooses which sign-in to keep`);
        }
      }
    },

    async retention() {
      const now = Date.now();
      const files = sessionFiles(record.home);
      if (canSkipThreadProvider(files, now, record.retention.idleDays)) {
        notes.push('retention: no session file is old enough for archive or legacy selection; native thread provider not started');
        return;
      }
      const byPath = new Map(files.map((f) => [f.path, f]));
      const bin = codexBinary(record.codexBinaryGlob);
      await withThreadProvider({ binary: bin, home: record.home }, async request => {
      const threads = await readThreads(record.home, { binary: bin, files, connect: (_options, operation) => operation(request) });
      const toArchive = selectRetention(threads, byPath, now, record.retention.idleDays);
      if (toArchive.length && !bin) log.push(`cannot archive: no Codex binary matches ${record.codexBinaryGlob}`);
      for (const t of bin ? toArchive : []) {
        try {
          await request('thread/archive', { threadId: t.id });
          log.push(`archived ${t.id} (${MB(t.bytes)})`);
        } catch {
          // A sub-agent thread is archived with its parent; its own archive then fails. Done if its log left.
          const path = threads.find((x) => x.id === t.id)?.rollout_path;
          log.push(existsSync(path) ? `archive failed ${t.id}` : `archived with parent ${t.id}`);
        }
      }
      const referenced = new Set(threads.map((t) => t.rollout_path));
      for (const f of selectLegacy(sessionFiles(record.home), referenced, now)) {
        const dest = join(record.retention.legacyDir, relative(join(record.home, 'sessions'), f.path));
        mkdirSync(dirname(dest), { recursive: true });
        renameSync(f.path, dest);
        log.push(`moved legacy ${relative(record.home, f.path)}`);
      }
      });
    },

    async scratch() {
      if (!record.scratch) return;
      const observed = observeScratch(record, Date.now(), { idleMs: scratchLimit(record).ms });
      const removed = removeExpired(observed, log);
      const kept = new Map();
      for (const x of observed.filter((e) => !e.expire)) {
        kept.set(x.reason, (kept.get(x.reason) ?? 0) + 1);
      }
      notes.push(`scratch: ${removed} expired, ${[...kept.values()].reduce((a, b) => a + b, 0)} kept of ${observed.length} entries${kept.size ? ` (${[...kept].map(([why, n]) => `${n} ${why}`).join('; ')})` : ''}`);
    },

    async workspace() {
      for (const ws of record.workspaces ?? []) {
        const identity = receiveWorkspaceGit(ws.path);
        if (ws.gitMaintenance === false) {
          const held = applyGitMaintenanceHold(identity);
          for (const changed of held.changed) log.push(`git ${changed} ${identity.path}`);
          notes.push(`git maintenance held ${identity.path}: selected registration absent, local/effective auto=false gc=0; running/manual work not cancelled`);
        }
        recheckWorkspaceGit(identity);
        const p = join(identity.commonDir, 'info', 'exclude');
        writeIfChanged(p, mergeManagedBlock(readText(p), ws.excludes).text, log);
        if (ws.gitMaintenance === true) {
          const m = gitMaintenanceState(ws.path, identity.commonDir);
          if (!m.timersEnabled) { runWorkspaceGit(identity, ['maintenance', 'start'], userManagerEnv()); log.push(`git maintenance start ${ws.path}`); }
          if (m.uncoveredPacks > (ws.maxUncoveredPacks ?? 10)) { runWorkspaceGit(identity, ['multi-pack-index', 'write']); log.push(`multi-pack-index write ${ws.path} (${m.uncoveredPacks} packs were uncovered)`); }
        }
      }
    },

    async config() {
      const p = join(record.home, 'config.toml');
      const text = readText(p);
      const lines = pluginLines(record, text);
      const merged = lines.length ? mergeManagedBlock(text, lines).text : text;
      writeIfChanged(p, merged, log, `${p} (managed block)`);
      for (const { plugin, server } of record.disabledPluginMcpServers ?? []) {
        if (pluginServerState(merged, plugin, server) === 'enabled') log.push(`left as is: ${pluginHeader(plugin, server)} is set outside the managed block with enabled not false`);
      }
    },

    async timer() {
      const directory = ports.timerDirectory?.() ?? timerDir();
      const control = ports.systemctlUser ?? systemctlUser;
      for (const c of installPlan(record, { script, parameters })) writeInstalled(c.to, readText(c.from), log);
      const inst = installedPaths(record);
      const units = renderTimerUnits(record, inst.script, inst.parameters);
      const a = writeIfChanged(join(directory, 'codex-home-retention.service'), units.service, log);
      const b = writeIfChanged(join(directory, 'codex-home-retention.timer'), units.timer, log);
      if (a || b) control('daemon-reload');
      control('enable', '--now', 'codex-home-retention.timer');
    },
  };

  for (const name of APPLY_SCOPES) {
    if (!want(name)) continue;
    try { await steps[name](); }
    catch (error) {
      failures.push({ scope: name, error });
      log.push(`FAILED ${name}: ${error.message}`);
    }
  }
  return { log, notes, failures };
}

/** `applyScopes` for callers that want the log or an exception: the log when every scope succeeded, else ApplyFailed. */
export async function apply(record, scope, context, ports = {}) {
  const { log, failures } = await applyScopes(record, scope, context, ports);
  if (failures.length) throw new ApplyFailed(log, failures);
  return log;
}
