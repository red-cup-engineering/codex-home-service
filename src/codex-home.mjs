// Codex home service: keeps a Codex home's placement, login link, searched data, workspace scans and plugin
// servers and agent scratch bounded, from one parameter record (specifications/requirements.md, CH-1..CH-22).
// Node built-ins only.
import {
  readFileSync, writeFileSync, existsSync, lstatSync, statSync, readdirSync, mkdirSync, renameSync,
  copyFileSync, mkdtempSync, rmSync, readlinkSync, symlinkSync, statfsSync,
  openSync, closeSync, fsyncSync,
} from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

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

export function shellRcLines(record) {
  return [
    '# The Codex home lives on the Linux filesystem only; a home on /mnt/* (the Windows bridge) made every',
    '# Codex start take minutes (observed-2026-10-14 in the record). Kept last so nothing above overrides it.',
    `export CODEX_HOME="${record.home}"`,
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

/** CH-16: one scratch entry's fate from what the host observers measured. Returns { expire, reason }. */
export function decideScratch(e) {
  if (e.declaredKeep) return { expire: false, reason: 'kept by the record' };
  if (e.mount) return { expire: false, reason: 'a filesystem is mounted inside' };
  if (e.inUse) return { expire: false, reason: 'open in a running process' };
  if (!e.activity.complete) return { expire: false, reason: 'too large to prove idle' };
  if (e.activity.recent) return { expire: false, reason: 'active' };
  const held = e.checkouts.find((c) => !c.ok);
  if (held) return { expire: false, reason: `${held.reason} in ${held.path}` };
  return { expire: true, reason: `unchanged since ${new Date(e.activity.newestMs).toISOString().slice(0, 10)}` };
}

export function renderTimerUnits(record, script, parameters) {
  const r = record.retention;
  const scopes = record.scratch ? 'retention,scratch' : 'retention';
  return {
    service: [
      '[Unit]',
      `Description=Codex home retention (codex-home-service): archive idle threads, move legacy logs${record.scratch ? ', expire idle agent scratch' : ''}`,
      '',
      '[Service]',
      'Type=oneshot',
      'SuccessExitStatus=2',              // apply exits 2 when drift remains (CH-18 low, CH-19 compaction due): it ran
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

/** Threads from a copy of the newest state_N.sqlite (no lock on the live database). */
export async function readThreads(home) {
  const dir = join(home, 'sqlite');
  const db = readdirSync(dir).map((n) => /^state_(\d+)\.sqlite$/.exec(n)).filter(Boolean)
    .sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0];
  if (!db) throw new Error(`no state_N.sqlite in ${dir}`);
  const tmp = mkdtempSync(join(tmpdir(), 'codex-home-'));
  try {
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(join(dir, db + suffix))) copyFileSync(join(dir, db + suffix), join(tmp, db + suffix));
    const { DatabaseSync } = await import('node:sqlite');
    const conn = new DatabaseSync(join(tmp, db));
    const rows = conn.prepare('select id, rollout_path, archived from threads').all();
    conn.close();
    return rows;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
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
function gitMaintenanceState(repo) {
  const packDir = join(repo, '.git', 'objects', 'pack');
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
const INSTALLED = ['package.json', 'src/codex-home.mjs', 'scripts/codex-home.mjs'];
export function installedPaths(record) {
  return { script: join(record.installDir, 'scripts', 'codex-home.mjs'), parameters: join(record.installDir, 'codex-home.json') };
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
const SCRATCH_DEPTH = 8;
const SCRATCH_DIR_LIMIT = 100_000;

/** The git directory a `.git` entry names: itself, or the target of a `gitdir:` file (null when that is gone). */
function gitDirOf(dotGit) {
  const st = lstatOrNull(dotGit);
  if (!st?.isFile()) return st ? dotGit : null;
  const m = /^gitdir: (.+)$/m.exec(readText(dotGit));
  const dir = m ? resolve(dirname(dotGit), m[1].trim()) : null;
  return dir && existsSync(dir) ? dir : null;
}

/**
 * Newest change in a scratch entry: directory mtimes (they move on every create, delete and rename), the entry's
 * own files, and each checkout's index and HEAD log (they move on every stage, commit and checkout), to
 * SCRATCH_DEPTH levels, without entering the directories named in `opaque` (CH-20). Stops at the first change after
 * `cutoffMs`, so an active entry costs a few reads (CH-9).
 */
export function scratchActivity(path, cutoffMs, { depth = SCRATCH_DEPTH, dirLimit = SCRATCH_DIR_LIMIT, opaque = new Set() } = {}) {
  const st = lstatSync(path);
  let newest = st.mtimeMs, seen = 0;
  const repos = [];
  const done = (complete) => ({ newestMs: newest, recent: newest > cutoffMs, complete, repos });
  if (!st.isDirectory()) return done(true);
  const queue = [[path, 0]];
  for (let i = 0; i < queue.length; i++) {
    if (newest > cutoffMs) return done(true);
    const [dir, level] = queue[i];
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.name === '.git') {
        repos.push(dir);
        const g = gitDirOf(p);
        if (g) for (const f of ['index', 'HEAD', join('logs', 'HEAD')]) newest = Math.max(newest, lstatOrNull(join(g, f))?.mtimeMs ?? 0);
      } else if (e.isDirectory()) {
        newest = Math.max(newest, lstatOrNull(p)?.mtimeMs ?? 0);
        if (++seen > dirLimit) return done(false);
        if (level + 1 < depth && !opaque.has(e.name)) queue.push([p, level + 1]);
      } else if (level === 0) {
        newest = Math.max(newest, lstatOrNull(p)?.mtimeMs ?? 0);
      }
    }
  }
  return done(true);
}

/**
 * A git checkout in scratch may go only when clean and with every commit on a remote (CH-16), or, for a linked
 * worktree whose repository lies outside the scratch `entry`, on a branch that removing the entry leaves (CH-21).
 */
export function checkoutState(root, entry = root) {
  const dotGit = join(root, '.git');
  const gitdir = gitDirOf(dotGit);
  if (!gitdir) return { path: root, ok: true, reason: 'git metadata already gone', common: null };
  const common = existsSync(join(gitdir, 'commondir')) ? resolve(gitdir, readText(join(gitdir, 'commondir')).trim()) : gitdir;
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    if (git('status', '--porcelain', '--untracked-files=normal')) return { path: root, ok: false, reason: 'uncommitted changes', common };
    const outside = !`${common}/`.startsWith(`${resolve(entry)}/`);
    if (git('rev-list', '-n', '1', 'HEAD', '--not', '--remotes', ...(outside ? ['--branches'] : []))) {
      return { path: root, ok: false, reason: outside ? 'commits on no remote or branch' : 'commits on no remote', common };
    }
  } catch { return { path: root, ok: false, reason: 'unreadable checkout', common }; }
  return { path: root, ok: true, reason: 'clean and pushed', common };
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

// ---------- CH-18/CH-19 headroom ----------
export const maintenanceReferral = record => record.headroom?.maintenanceReferral || 'Existing WSL host maintenance owner: exact-disk checkpoint, authority and physical reopening required; no maintenance is admitted here.';
export function refuseAutomaticCollection(record) {
  if (record.headroom?.guix || record.headroom?.compactCommand) throw new Error('unqualified automatic maintenance selector refused before effects; ' + maintenanceReferral(record));
}
const GB = (b) => `${(b / 1e9).toFixed(1)} GB`;

/** Low when either side is under the floor. Legacy `slack`/`compact` fields
 * describe an apparent logical gap/referral, never allocation or reclaim. */
export function judgeHeadroom({ vmFree, vmUsed, hostFree, imageBytes }, h) {
  if (!Number.isFinite(h.floorBytes) || h.floorBytes <= 0) throw new Error('finite positive housekeeping floor required');
  const slack = imageBytes == null ? null : Math.max(0, imageBytes - vmUsed);
  return { low: Number.isFinite(vmFree) && Number.isFinite(hostFree) ? Math.min(vmFree, hostFree) < h.floorBytes : null, slack, compact: slack != null && slack > (h.compactAboveBytes ?? Infinity) };
}

/** Two statfs calls and one stat (CH-9). Null when the record declares no headroom. */
export function observeHeadroom(record) {
  const h = record.headroom;
  if (!h) return null;
  const space = (p) => { try { const s = statfsSync(p); return { free: s.bavail * s.bsize, used: (s.blocks - s.bfree) * s.bsize }; } catch { return null; } };
  const vm = space(h.vmVolume), host = space(h.hostVolume);
  const m = { vmFree: vm?.free ?? null, vmUsed: vm?.used ?? null, hostFree: host?.free ?? null, imageBytes: lstatOrNull(h.diskImage)?.size ?? null };
  return { ...m, ...judgeHeadroom(m, h) };
}

/** The scratch idle limit in force: the record's days, or CH-18's hours while headroom is low. */
export function scratchLimit(record, headroom) {
  if (headroom && headroom.low === null) throw new Error('unknown pressure: scratch retirement held; ' + maintenanceReferral(record));
  const days = record.scratch.idleDays, hours = record.headroom?.idleHours;
  if (!Number.isFinite(days) || days <= 0 || (headroom?.low && (!Number.isFinite(hours) || hours <= 0 || hours > days * 24))) throw new Error('finite bounded scratch cutoff required');
  return headroom?.low
    ? { ms: record.headroom.idleHours * 3_600_000, text: `${record.headroom.idleHours} h` }
    : { ms: record.scratch.idleDays * DAY_MS, text: `${record.scratch.idleDays} d` };
}

/** Every top-level entry under each scratch root, measured and decided (CH-16). */
export function observeScratch(record, now = Date.now(), { idleMs = record.scratch?.idleDays * DAY_MS } = {}) {
  const s = record.scratch;
  if (!s) return [];
  const cutoffMs = now - idleMs;
  const open = openPaths(), mounts = mountPoints(), opaque = new Set(s.opaqueDirs ?? []);
  const admits = (root, name) => !root.match || new RegExp(root.match).test(name);
  return s.roots.flatMap((root) => (existsSync(root.path) ? readdirSync(root.path) : []).filter((name) => admits(root, name)).map((name) => {
    const path = join(root.path, name);
    const e = { root: root.path, name, path, declaredKeep: (root.keep ?? []).includes(name), mount: under(mounts, path), inUse: under(open, path) };
    let activity = { newestMs: 0, recent: false, complete: true, repos: [] }, checkouts = [];
    if (!e.declaredKeep && !e.mount && !e.inUse) {
      activity = scratchActivity(path, cutoffMs, { opaque });
      if (activity.complete && !activity.recent) checkouts = activity.repos.map((repo) => checkoutState(repo, path));
    }
    const full = { ...e, activity, checkouts };
    return { ...full, ...decideScratch(full) };
  }));
}

export async function observe(record, { script, parameters }) {
  const items = [];
  const add = (id, ok, detail) => items.push({ id, status: ok ? 'current' : 'drift', detail });
  const now = Date.now();

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
  const threads = await readThreads(record.home);
  const toArchive = selectRetention(threads, byPath, now, record.retention.idleDays);
  add('CH-4 retention', toArchive.length === 0, `${toArchive.length} threads idle > ${record.retention.idleDays} d, ${MB(toArchive.reduce((s, t) => s + t.bytes, 0))}`);
  const legacy = selectLegacy(files, new Set(threads.map((t) => t.rollout_path)), now);
  add('CH-5 legacy', legacy.length === 0, `${legacy.length} unreferenced files, ${MB(legacy.reduce((s, f) => s + f.size, 0))}`);

  for (const ws of record.workspaces ?? []) {
    const ex = readText(join(ws.path, '.git', 'info', 'exclude'));
    add(`CH-6 workspace ${ws.path}`, mergeManagedBlock(ex, ws.excludes).changed === false, `exclude block ${ws.excludes.join(' ')}`);
    if (ws.gitMaintenance) {
      const m = gitMaintenanceState(ws.path);
      add(`CH-15 git maintenance ${ws.path}`, m.timersEnabled && m.uncoveredPacks <= (ws.maxUncoveredPacks ?? 10),
        `timers ${m.timers.join(' ')}; ${m.uncoveredPacks} of ${m.packs} packs newer than the multi-pack index`);
    }
  }

  const headroom = observeHeadroom(record);
  if (headroom) {
    const h = record.headroom;
    add('CH-18 headroom', headroom.low === false,
      `VM ${GB(headroom.vmFree)} free, host ${headroom.hostFree == null ? 'unread' : `${GB(headroom.hostFree)} free`} (floor ${GB(h.floorBytes)})`);
    add('CH-19 disk image', !headroom.compact, headroom.slack == null ? `${h.diskImage} unread; HELD maintenance: ${maintenanceReferral(record)}`
      : `${GB(headroom.imageBytes)} image logical length, ${GB(headroom.slack)} apparent gap beyond ${GB(headroom.vmUsed)} guest used; Windows allocation/reclaim unknown (original WSL host plan)${headroom.compact ? `; HELD maintenance: ${maintenanceReferral(record)}` : ''}`);
  }
  if (record.scratch) {
    let limit;
    try { limit = scratchLimit(record, headroom); }
    catch (error) { add('CH-18 scratch admission', false, error.message); return items; }
    const entries = observeScratch(record, now, { idleMs: limit.ms });
    for (const root of record.scratch.roots) {
      const mine = entries.filter((x) => x.root === root.path);
      const expired = mine.filter((x) => x.expire);
      const kept = Object.entries(mine.filter((x) => !x.expire).reduce((m, x) => {
        const k = x.reason.replace(/ in \/.*$/, '');
        m[k] = (m[k] ?? 0) + 1;
        return m;
      }, {})).map(([k, n]) => `${n} ${k}`).join(', ');
      const names = expired.slice(0, 6).map((x) => x.name).join(', ') + (expired.length > 6 ? ', ...' : '');
      add(`CH-16 scratch ${root.path}`, expired.length === 0,
        `${expired.length} unchanged > ${limit.text}${expired.length ? ` (${names})` : ''}; kept: ${kept || 'none'}`);
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
  const copies = installPlan(record, { script, parameters });
  add('CH-14 installed copy', copies.every((c) => readText(c.from) === readText(c.to)), record.installDir);
  return items;
}

// ---------- host change ----------

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

export async function apply(record, scope, { script, parameters }, ports = {}) {
  const log = [];
  const scopes = String(scope).split(',');
  const want = (s) => scopes.includes('all') || scopes.includes(s);
  // Reject active legacy maintenance selectors before cleanup OR installing
  // them as the future timer's record. Timer installation executes no cleanup.
  if (want('scratch') || want('retention') || want('timer')) refuseAutomaticCollection(record);
  if (want('scratch')) {
    scratchLimit(record, observeHeadroom(record));
  }

  if (want('placement')) {
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
  }

  if (want('retention')) {
    const now = Date.now();
    const files = sessionFiles(record.home);
    const byPath = new Map(files.map((f) => [f.path, f]));
    const threads = await readThreads(record.home);
    const bin = codexBinary(record.codexBinaryGlob);
    const toArchive = selectRetention(threads, byPath, now, record.retention.idleDays);
    if (toArchive.length && !bin) log.push(`cannot archive: no Codex binary matches ${record.codexBinaryGlob}`);
    for (const t of bin ? toArchive : []) {
      try {
        execFileSync(bin, ['archive', t.id], { env: { ...process.env, CODEX_HOME: record.home, CODEX_SQLITE_HOME: join(record.home, 'sqlite') }, stdio: 'ignore' });
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
  }

  if (want('scratch') && record.scratch) {
    const headroom = observeHeadroom(record);
    const commons = new Set();
    for (const x of observeScratch(record, Date.now(), { idleMs: scratchLimit(record, headroom).ms }).filter((e) => e.expire)) {
      try {
        rmSync(x.path, { recursive: true, force: true });
        log.push(`expired ${x.path} (${x.reason})`);
      } catch (err) { log.push(`could not remove ${x.path}: ${err.code ?? err.message}`); }
      for (const c of x.checkouts) if (c.common) commons.add(c.common);
    }
    // Removed worktrees leave registrations behind in their repository; git's own prune drops them.
    for (const c of commons) {
      if (!existsSync(c)) continue;
      try { execFileSync('git', ['--git-dir', c, 'worktree', 'prune'], { stdio: 'ignore' }); log.push(`git worktree prune ${c}`); } catch { log.push(`git worktree prune failed for ${c}`); }
    }
    if (headroom?.low || headroom?.compact) log.push('HELD maintenance: ' + maintenanceReferral(record));
  }

  if (want('workspace')) {
    for (const ws of record.workspaces ?? []) {
      const p = join(ws.path, '.git', 'info', 'exclude');
      writeIfChanged(p, mergeManagedBlock(readText(p), ws.excludes).text, log);
      if (ws.gitMaintenance) {
        const m = gitMaintenanceState(ws.path);
        if (!m.timersEnabled) { execFileSync('git', ['-C', ws.path, 'maintenance', 'start'], { stdio: 'ignore', env: userManagerEnv() }); log.push(`git maintenance start ${ws.path}`); }
        if (m.uncoveredPacks > (ws.maxUncoveredPacks ?? 10)) { execFileSync('git', ['-C', ws.path, 'multi-pack-index', 'write'], { stdio: 'ignore' }); log.push(`multi-pack-index write ${ws.path} (${m.uncoveredPacks} packs were uncovered)`); }
      }
    }
  }

  if (want('config')) {
    const p = join(record.home, 'config.toml');
    const text = readText(p);
    const lines = pluginLines(record, text);
    const merged = lines.length ? mergeManagedBlock(text, lines).text : text;
    writeIfChanged(p, merged, log, `${p} (managed block)`);
    for (const { plugin, server } of record.disabledPluginMcpServers ?? []) {
      if (pluginServerState(merged, plugin, server) === 'enabled') log.push(`left as is: ${pluginHeader(plugin, server)} is set outside the managed block with enabled not false`);
    }
  }

  if (want('timer')) {
    const directory = ports.timerDirectory?.() ?? timerDir();
    const control = ports.systemctlUser ?? systemctlUser;
    for (const c of installPlan(record, { script, parameters })) writeInstalled(c.to, readText(c.from), log);
    const inst = installedPaths(record);
    const units = renderTimerUnits(record, inst.script, inst.parameters);
    const a = writeIfChanged(join(directory, 'codex-home-retention.service'), units.service, log);
    const b = writeIfChanged(join(directory, 'codex-home-retention.timer'), units.timer, log);
    if (a || b) control('daemon-reload');
    control('enable', '--now', 'codex-home-retention.timer');
  }
  return log;
}
