import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  BEGIN, END, mergeManagedBlock, withoutManagedBlock, shellRcLines, pluginHeader, pluginServerState, pluginLines,
  selectRetention, selectLegacy, renderTimerUnits, installedPaths, uncoveredPacks, classifyLogin,
  decideScratch, scratchActivity, checkoutState, loginShellCodexHome, runningAppServerHomes,
  judgeHeadroom, scratchLimit, observeScratch, refuseAutomaticCollection, apply,
} from '../src/codex-home.mjs';

const record = {
  home: '/h/.codex', node: '/n/node',
  retention: { idleDays: 2, onCalendar: 'daily', onBootDelay: '15min' },
  disabledPluginMcpServers: [{ plugin: 'p@m', server: 'srv' }],
};
const DAY = 86_400_000;

test('managed block is appended once and is idempotent (CH-10)', () => {
  const a = mergeManagedBlock('owner line\n', ['x']);
  assert.equal(a.changed, true);
  assert.equal(a.text, `owner line\n\n${BEGIN}\nx\n${END}\n`);
  assert.equal(mergeManagedBlock(a.text, ['x']).changed, false);
});

test('managed block is replaced in place and owner lines survive', () => {
  const a = mergeManagedBlock('top\n', ['old']).text + 'bottom\n';
  const b = mergeManagedBlock(a, ['new']);
  assert.match(b.text, /^top\n/);
  assert.match(b.text, /bottom\n$/);
  assert.ok(b.text.includes(`${BEGIN}\nnew\n${END}`) && !b.text.includes('old'));
  assert.equal(withoutManagedBlock(b.text).includes('new'), false);
});

test('shell block exports the record home (CH-1)', () => {
  assert.ok(shellRcLines(record).includes('export CODEX_HOME="/h/.codex"'));
});

// Ubuntu's startup files as they stand on the host: ~/.profile sources ~/.bashrc, which returns early when not interactive.
const UBUNTU_BASHRC = 'case $- in\n    *i*) ;;\n      *) return;;\nesac\n';
const UBUNTU_PROFILE = 'if [ -n "$BASH_VERSION" ]; then\n    if [ -f "$HOME/.bashrc" ]; then\n\t. "$HOME/.bashrc"\n    fi\nfi\n';
const shellHome = (files) => {
  const h = mkdtempSync(join(tmpdir(), 'codex-home-shell-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(h, name), text);
  try { return loginShellCodexHome('/mnt/c/Users/u/.codex', { HOME: h, PATH: process.env.PATH }); } finally { rmSync(h, { recursive: true, force: true }); }
};

test('a block only in .bashrc loses to the home the app forwards; the login-profile block wins (CH-1, 2026-10-18)', () => {
  const block = (t) => mergeManagedBlock(t, shellRcLines(record)).text;
  assert.equal(shellHome({ '.bashrc': block(UBUNTU_BASHRC), '.profile': UBUNTU_PROFILE }), '/mnt/c/Users/u/.codex');
  assert.equal(shellHome({ '.bashrc': block(UBUNTU_BASHRC), '.profile': block(UBUNTU_PROFILE) }), '/h/.codex');
});

test('the running app-server is judged by its own environment (CH-17)', () => {
  const proc = mkdtempSync(join(tmpdir(), 'codex-home-proc-'));
  const ps = { 11: [['/mnt/c/u/.codex/bin/wsl/x/codex', '-c', 'f=1', 'app-server'], ['CODEX_HOME=/mnt/c/u/.codex', 'HOME=/h']],
    12: [['/mnt/c/u/.codex/bin/wsl/x/codex-code-mode-host'], ['CODEX_HOME=/mnt/c/u/.codex']],
    13: [['/usr/bin/codex', 'app-server'], ['HOME=/h']], 14: [['bash', '-lc', 'codex app-server'], []] };
  for (const [pid, [argv, env]] of Object.entries(ps)) {
    mkdirSync(join(proc, pid));
    writeFileSync(join(proc, pid, 'cmdline'), argv.join('\0') + '\0');
    writeFileSync(join(proc, pid, 'environ'), env.join('\0') + '\0');
  }
  mkdirSync(join(proc, 'self'));
  assert.deepEqual(runningAppServerHomes(proc, '/h/.codex'), [{ pid: 11, home: '/mnt/c/u/.codex' }, { pid: 13, home: '/h/.codex' }]);
  rmSync(proc, { recursive: true, force: true });
});

test('plugin server state reads enabled = false under its own table only (CH-8)', () => {
  const h = pluginHeader('p@m', 'srv');
  assert.equal(h, '[plugins."p@m".mcp_servers.srv]');
  assert.equal(pluginServerState('', 'p@m', 'srv'), 'absent');
  assert.equal(pluginServerState(`${h}\nenabled = false\n`, 'p@m', 'srv'), 'disabled');
  assert.equal(pluginServerState(`${h}\n[other]\nenabled = false\n`, 'p@m', 'srv'), 'enabled');
});

test('plugin block never redeclares a table the owner already wrote (no duplicate TOML tables)', () => {
  const h = pluginHeader('p@m', 'srv');
  assert.deepEqual(pluginLines(record, `${h}\nenabled = false\n`), []);
  assert.deepEqual(pluginLines(record, ''), [h, 'enabled = false']);
  const own = mergeManagedBlock('', [h, 'enabled = false']).text;
  assert.deepEqual(pluginLines(record, own), [h, 'enabled = false']);
});

test('retention selects only unarchived threads idle past the limit whose log is in the searched folder (CH-4)', () => {
  const now = 10 * DAY;
  const files = new Map([
    ['/s/a', { size: 5, mtimeMs: now - 3 * DAY }],
    ['/s/b', { size: 7, mtimeMs: now - 1 * DAY }],
    ['/s/c', { size: 9, mtimeMs: now - 9 * DAY }],
  ]);
  const threads = [
    { id: 'a', rollout_path: '/s/a', archived: 0 },
    { id: 'b', rollout_path: '/s/b', archived: 0 },
    { id: 'c', rollout_path: '/s/c', archived: 1 },
    { id: 'd', rollout_path: '/s/missing', archived: 0 },
  ];
  assert.deepEqual(selectRetention(threads, files, now, 2), [{ id: 'a', bytes: 5 }]);
});

test('legacy selects unreferenced files idle a day, never referenced or fresh ones (CH-5)', () => {
  const now = 10 * DAY;
  const files = [
    { path: '/s/ref', mtimeMs: now - 5 * DAY },
    { path: '/s/old', mtimeMs: now - 5 * DAY },
    { path: '/s/fresh', mtimeMs: now - 1000 },
  ];
  assert.deepEqual(selectLegacy(files, new Set(['/s/ref']), now).map((f) => f.path), ['/s/old']);
});

test('one login: the real file on Windows, the home a link to it (CH-2)', () => {
  const file = { isSymbolicLink: () => false }, link = { isSymbolicLink: () => true };
  assert.equal(classifyLogin(link, file, 'w').ok, true);
  assert.equal(classifyLogin(file, link, 'w').action, 'move-home-to-windows');   // today's first layout: reversed
  assert.equal(classifyLogin(file, null, 'w').action, 'move-home-to-windows');
  assert.equal(classifyLogin(file, file, 'w').action, 'link-home-if-identical');
  assert.equal(classifyLogin(null, file, 'w').action, 'link-home');
  assert.equal(classifyLogin(null, null, 'w').action, 'manual');
});

test('packs newer than the multi-pack index count as uncovered; no index means all (CH-15)', () => {
  const packs = [{ mtimeMs: 1 }, { mtimeMs: 5 }, { mtimeMs: 9 }];
  assert.equal(uncoveredPacks(packs, 4), 2);
  assert.equal(uncoveredPacks(packs, 10), 0);
  assert.equal(uncoveredPacks(packs, null), 3);
});

test('the schedule points at the installed copy, not the working tree (CH-14)', () => {
  const p = installedPaths({ installDir: '/inst' });
  assert.deepEqual(p, { script: '/inst/scripts/codex-home.mjs', parameters: '/inst/codex-home.json' });
  assert.match(renderTimerUnits(record, p.script, p.parameters).service, /ExecStart=\/n\/node \/inst\/scripts\/codex-home\.mjs apply --scope=retention --parameters=\/inst\/codex-home\.json/);
});

test('timer units come from the record (CH-7, CH-11)', () => {
  const u = renderTimerUnits(record, '/svc/scripts/codex-home.mjs', '/rec/codex-home.json');
  assert.match(u.service, /ExecStart=\/n\/node \/svc\/scripts\/codex-home\.mjs apply --scope=retention --parameters=\/rec\/codex-home\.json/);
  assert.match(u.timer, /OnCalendar=daily/);
  assert.match(u.timer, /OnBootSec=15min/);
});

test('the timer also expires scratch when the record declares scratch roots (CH-7, CH-16)', () => {
  const u = renderTimerUnits({ ...record, scratch: { idleDays: 7, roots: [] } }, '/i/s.mjs', '/i/r.json');
  assert.match(u.service, /apply --scope=retention,scratch --parameters=\/i\/r\.json/);
});

test('a scratch entry expires only when idle, unopened, unmounted, unkept, and its checkouts are clean and pushed (CH-16)', () => {
  const idle = { declaredKeep: false, mount: false, inUse: false, activity: { complete: true, recent: false, newestMs: 0 }, checkouts: [] };
  assert.equal(decideScratch(idle).expire, true);
  assert.equal(decideScratch({ ...idle, declaredKeep: true }).reason, 'kept by the record');
  assert.equal(decideScratch({ ...idle, mount: true }).expire, false);
  assert.equal(decideScratch({ ...idle, inUse: true }).reason, 'open in a running process');
  assert.equal(decideScratch({ ...idle, activity: { ...idle.activity, complete: false } }).reason, 'too large to prove idle');
  assert.equal(decideScratch({ ...idle, activity: { ...idle.activity, recent: true } }).reason, 'active');
  assert.equal(decideScratch({ ...idle, checkouts: [{ ok: true }, { ok: false, reason: 'commits on no remote', path: '/w' }] }).reason, 'commits on no remote in /w');
});

const tree = () => {
  const root = mkdtempSync(join(tmpdir(), 'scratch-'));
  mkdirSync(join(root, 'a', 'b', 'c', 'd'), { recursive: true });
  writeFileSync(join(root, 'a', 'b', 'c', 'd', 'f'), 'x');
  const old = new Date(Date.now() - 30 * DAY);
  for (const p of ['a/b/c/d/f', 'a/b/c/d', 'a/b/c', 'a/b', 'a', '.']) utimesSync(join(root, p), old, old);
  return root;
};

test('scratch activity sees a change deep in the tree, stops at its depth and directory limits (CH-9, CH-16)', () => {
  const root = tree();
  try {
    const cutoff = Date.now() - 7 * DAY;
    assert.deepEqual([scratchActivity(root, cutoff).recent, scratchActivity(root, cutoff).complete], [false, true]);
    writeFileSync(join(root, 'a', 'b', 'c', 'new'), 'y');            // a create moves c's mtime
    assert.equal(scratchActivity(root, cutoff).recent, true);
    assert.equal(scratchActivity(root, cutoff, { depth: 2 }).recent, false);
    assert.equal(scratchActivity(root, cutoff, { dirLimit: 1 }).complete, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a checkout holds its scratch entry until it is clean and every commit is on a remote (CH-16)', () => {
  const root = mkdtempSync(join(tmpdir(), 'scratch-git-'));
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...a], { cwd, stdio: 'ignore' });
  try {
    git(root, 'init', '--bare', 'remote.git');
    git(root, 'clone', 'remote.git', 'work');
    const w = join(root, 'work');
    writeFileSync(join(w, 'f'), '1'); git(w, 'add', 'f'); git(w, 'commit', '-m', '1'); git(w, 'push', 'origin', 'HEAD:main');
    git(w, 'fetch', 'origin');
    assert.equal(checkoutState(w).ok, true);
    writeFileSync(join(w, 'untracked'), 'x');
    assert.equal(checkoutState(w).reason, 'uncommitted changes');
    rmSync(join(w, 'untracked'));
    writeFileSync(join(w, 'f'), '2'); git(w, 'commit', '-am', '2');
    assert.equal(checkoutState(w).reason, 'commits on no remote');
    const orphan = join(root, 'orphan'); mkdirSync(orphan);
    writeFileSync(join(orphan, '.git'), 'gitdir: /nonexistent/worktrees/x\n');
    assert.equal(checkoutState(orphan).reason, 'git metadata already gone');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('headroom is low on either side; the logical gap retains only a maintenance referral (CH-18, CH-19)', () => {
  const h = { floorBytes: 100, compactAboveBytes: 50 };
  assert.deepEqual(judgeHeadroom({ vmFree: 500, vmUsed: 400, hostFree: 10, imageBytes: 540 }, h), { low: true, slack: 140, compact: true });
  assert.deepEqual(judgeHeadroom({ vmFree: 500, vmUsed: 400, hostFree: 200, imageBytes: 420 }, h), { low: false, slack: 20, compact: false });
  assert.equal(judgeHeadroom({ vmFree: 90, vmUsed: 400, hostFree: null, imageBytes: null }, h).low, null);
  const r = { scratch: { idleDays: 2 }, headroom: { idleHours: 6 } };
  assert.deepEqual(scratchLimit(r, { low: false }), { ms: 2 * DAY, text: '2 d' });
  assert.deepEqual(scratchLimit(r, { low: true }), { ms: 6 * 3_600_000, text: '6 h' });
  assert.deepEqual(scratchLimit(r, null), { ms: 2 * DAY, text: '2 d' });
});

test('a derived directory counts by its own mtime and is not entered (CH-20)', () => {
  const root = tree();
  try {
    const cutoff = Date.now() - 7 * DAY;
    writeFileSync(join(root, 'a', 'b', 'c', 'new'), 'y');                       // moves c's mtime only
    assert.equal(scratchActivity(root, cutoff, { opaque: new Set(['b']) }).recent, false);
    assert.equal(scratchActivity(root, cutoff, { opaque: new Set(['c']) }).recent, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a linked worktree counts as pushed when its commits are on a branch outside the entry (CH-21)', () => {
  const root = mkdtempSync(join(tmpdir(), 'scratch-wt-'));
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...a], { cwd, stdio: 'ignore' });
  try {
    git(root, 'init', 'repo');
    const repo = join(root, 'repo');
    writeFileSync(join(repo, 'f'), '1'); git(repo, 'add', 'f'); git(repo, 'commit', '-m', '1');
    const entry = join(root, 'scratch', 'task'); mkdirSync(entry, { recursive: true });
    const wt = join(entry, 'wt');
    git(repo, 'worktree', 'add', '-b', 'task', wt);
    writeFileSync(join(wt, 'g'), '2'); git(wt, 'add', 'g'); git(wt, 'commit', '-m', '2');
    assert.equal(checkoutState(wt, entry).ok, true);
    git(wt, 'checkout', '--detach'); writeFileSync(join(wt, 'h'), '3'); git(wt, 'add', 'h'); git(wt, 'commit', '-m', '3');
    assert.equal(checkoutState(wt, entry).reason, 'commits on no remote or branch');
    git(entry, 'clone', repo, 'clone');
    const clone = join(entry, 'clone');
    writeFileSync(join(clone, 'i'), '4'); git(clone, 'add', 'i'); git(clone, 'commit', '-m', '4');
    assert.equal(checkoutState(clone, entry).reason, 'commits on no remote');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a root\'s match limits which of its entries are scratch (CH-16)', () => {
  const root = mkdtempSync(join(tmpdir(), 'scratch-root-'));
  try {
    for (const n of ['561-task', 'pip']) { mkdirSync(join(root, n)); utimesSync(join(root, n), new Date(0), new Date(0)); }
    const es = observeScratch({ scratch: { idleDays: 2, roots: [{ path: root, match: '^561-' }] } });
    assert.deepEqual(es.map((e) => [e.name, e.expire]), [['561-task', true]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legacy automatic collection refuses before even retention effects', async () => {
  for (const field of ['guix', 'compactCommand']) for (const scope of ['retention,scratch', 'retention', 'scratch', 'timer', 'all']) {
    let controls = 0;
    await assert.rejects(() => apply({ headroom: { [field]: '/must-never-run' } }, scope, {}, { systemctlUser: () => { controls++; } }), /unqualified automatic maintenance selector refused before effects/);
    assert.equal(controls, 0);
  }
  assert.throws(() => scratchLimit({ scratch: { idleDays: 2 }, headroom: { idleHours: 6 } }, { low: null }), /retirement held/);
  assert.throws(() => scratchLimit({ scratch: { idleDays: 2 }, headroom: { idleHours: Infinity } }, { low: true }), /finite bounded/);
});
test('timer-only installation atomically copies exact selected files and keeps the existing hourly timer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-install-'));
  try {
    const source = join(root, 'source'), installed = join(root, 'installed'), units = join(root, 'units');
    for (const d of ['src', 'scripts']) mkdirSync(join(source, d), { recursive: true });
    const script = join(source, 'scripts/codex-home.mjs'), parameters = join(root, 'record.json');
    writeFileSync(join(source, 'package.json'), '{"name":"fixture"}\n');
    writeFileSync(join(source, 'src/codex-home.mjs'), '// exact-source\n');
    writeFileSync(script, '// exact-cli\n');
    const selected = { installDir: installed, node: '/native/node', retention: { onCalendar: 'hourly', onBootDelay: '15min' }, headroom: { maintenanceReferral: 'existing WSL owner', legacyMaintenance: { guix: '/inactive-provenance' } } };
    writeFileSync(parameters, JSON.stringify(selected));
    const calls = [];
    const ports = { timerDirectory: () => units, systemctlUser: (...args) => calls.push(args) };
    await apply(selected, 'timer', { script, parameters }, ports);
    assert.equal(readFileSync(join(installed, 'src/codex-home.mjs'), 'utf8'), '// exact-source\n');
    assert.equal(readFileSync(join(installed, 'codex-home.json'), 'utf8'), JSON.stringify(selected));
    assert.match(readFileSync(join(units, 'codex-home-retention.timer'), 'utf8'), /OnCalendar=hourly/);
    assert.deepEqual(calls, [['daemon-reload'], ['enable', '--now', 'codex-home-retention.timer']]);
    calls.length = 0;
    const second = await apply(selected, 'timer', { script, parameters }, ports);
    assert.deepEqual(second, []);
    assert.deepEqual(calls, [['enable', '--now', 'codex-home-retention.timer']]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
