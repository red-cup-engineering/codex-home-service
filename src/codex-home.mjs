// Codex home service: keeps a Codex home's placement, login link, searched data, workspace scans and plugin
// servers bounded, from one parameter record (specifications/requirements.md, CH-1..CH-13). Node built-ins only.
import {
  readFileSync, writeFileSync, existsSync, lstatSync, statSync, readdirSync, mkdirSync, renameSync,
  copyFileSync, mkdtempSync, rmSync, readlinkSync, symlinkSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
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

export function renderTimerUnits(record, script, parameters) {
  const r = record.retention;
  return {
    service: [
      '[Unit]',
      'Description=Codex home retention (codex-home-service): archive idle threads, move legacy logs',
      '',
      '[Service]',
      'Type=oneshot',
      `ExecStart=${record.node} ${script} apply --scope=retention --parameters=${parameters}`,
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
    try { return `${s}:${execFileSync('systemctl', ['--user', 'is-enabled', `git-maintenance@${s}.timer`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()}`; }
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

function loginShellCodexHome() {
  return execFileSync('bash', ['-lc', 'printf %s "${CODEX_HOME:-$HOME/.codex}"'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
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

export async function observe(record, { script, parameters }) {
  const items = [];
  const add = (id, ok, detail) => items.push({ id, status: ok ? 'current' : 'drift', detail });
  const now = Date.now();

  const resolved = loginShellCodexHome();
  add('CH-1 home', resolved === record.home && !resolved.startsWith('/mnt/'), `login shell resolves ${resolved}`);
  const rc = readText(record.shellRc);
  add('CH-1 shell block', mergeManagedBlock(rc, shellRcLines(record)).changed === false, record.shellRc);

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
  try { enabled = execFileSync('systemctl', ['--user', 'is-enabled', 'codex-home-retention.timer'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { enabled = 'disabled'; }
  const unitsOk = svc === units.service && tmr === units.timer;
  add('CH-7 retention timer', unitsOk && enabled === 'enabled', `units ${unitsOk ? 'current' : 'differ'}, ${enabled}`);
  const copies = installPlan(record, { script, parameters });
  add('CH-14 installed copy', copies.every((c) => readText(c.from) === readText(c.to)), record.installDir);
  return items;
}

// ---------- host change ----------

function writeIfChanged(path, text, log, label) {
  if (readText(path) === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  log.push(`wrote ${label ?? path}`);
  return true;
}

export async function apply(record, scope, { script, parameters }) {
  const log = [];
  const want = (s) => scope === 'all' || scope === s;

  if (want('placement')) {
    const rc = readText(record.shellRc);
    writeIfChanged(record.shellRc, mergeManagedBlock(rc, shellRcLines(record)).text, log, `${record.shellRc} (managed block)`);
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

  if (want('workspace')) {
    for (const ws of record.workspaces ?? []) {
      const p = join(ws.path, '.git', 'info', 'exclude');
      writeIfChanged(p, mergeManagedBlock(readText(p), ws.excludes).text, log);
      if (ws.gitMaintenance) {
        const m = gitMaintenanceState(ws.path);
        if (!m.timersEnabled) { execFileSync('git', ['-C', ws.path, 'maintenance', 'start'], { stdio: 'ignore' }); log.push(`git maintenance start ${ws.path}`); }
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
    for (const c of installPlan(record, { script, parameters })) writeIfChanged(c.to, readText(c.from), log);
    const inst = installedPaths(record);
    const units = renderTimerUnits(record, inst.script, inst.parameters);
    const a = writeIfChanged(join(timerDir(), 'codex-home-retention.service'), units.service, log);
    const b = writeIfChanged(join(timerDir(), 'codex-home-retention.timer'), units.timer, log);
    if (a || b) execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    execFileSync('systemctl', ['--user', 'enable', '--now', 'codex-home-retention.timer'], { stdio: 'ignore' });
  }
  return log;
}
