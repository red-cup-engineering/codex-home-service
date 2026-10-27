import { test } from 'node:test';
import assert from 'node:assert/strict';
import nativeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import {
  BEGIN, END, mergeManagedBlock, withoutManagedBlock, shellRcLines, pluginHeader, pluginServerState, pluginLines,
  selectRetention, selectLegacy, renderTimerUnits, installedPaths, uncoveredPacks, classifyLogin,
  loginShellCodexHome, runningAppServerHomes,
  observeScratch, apply,
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
  assert.ok(!shellRcLines(record).some((line) => line.includes('PATH')), 'no shellPath, no PATH line');
  assert.deepEqual(shellRcLines(record).filter((line) => line.startsWith('export ')), ['export CODEX_HOME="/h/.codex"'], 'no shellEnvironment, no other export');
});

test('shellPath puts the record\'s directories ahead of the system ones, once, in order (CH-30)', () => {
  const lines = shellRcLines({ ...record, shellPath: ['/a/shims', '/b/bin'] });
  assert.ok(lines.some((l) => l.includes('PATH="/a/shims:$PATH"')) && lines.some((l) => l.includes('PATH="/b/bin:$PATH"')));
  const script = ['PATH=/usr/bin:/bin', ...lines, 'echo "$PATH"', ...lines, 'echo "$PATH"'].join('\n');
  const out = execFileSync('sh', ['-c', script], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(out, ['/a/shims:/b/bin:/usr/bin:/bin', '/a/shims:/b/bin:/usr/bin:/bin'], 'sourced twice, still one entry each, first listed first');
  for (const bad of [['relative'], ['/a b'], ['/a;rm'], ['/a"'], ['/a$HOME'], ['/'], ['/a//b'], [1], 'x']) {
    assert.throws(() => shellRcLines({ ...record, shellPath: bad }), /shellPath must be/u, JSON.stringify(bad));
  }
});

test('shellEnvironment exports the record\'s variables, expanding references to variables already set (CH-31)', () => {
  const lines = shellRcLines({ ...record, shellEnvironment: { NPM_CONFIG_USERCONFIG: '${CREDENTIALS_DIRECTORY}/npm/npmrc', TOOL_MODE: 'quiet' } });
  assert.ok(lines.includes('export NPM_CONFIG_USERCONFIG="${CREDENTIALS_DIRECTORY}/npm/npmrc"') && lines.includes('export TOOL_MODE="quiet"'));
  const out = execFileSync('sh', ['-c', ['CREDENTIALS_DIRECTORY=/run/c', ...lines, 'echo "$NPM_CONFIG_USERCONFIG $TOOL_MODE"'].join('\n')], { encoding: 'utf8' }).trim();
  assert.equal(out, '/run/c/npm/npmrc quiet');
  for (const bad of [{ lower: 'x' }, { CODEX_HOME: '/x' }, { PATH: '/x' }, { A: '' }, { A: '$(id)' }, { A: '`id`' }, { A: 'a b' }, { A: '"; id; "' }, { A: '${lower}' }, { A: '$HOME' }, { A: 1 }]) {
    assert.throws(() => shellRcLines({ ...record, shellEnvironment: bad }), /shellEnvironment must map/u, JSON.stringify(bad));
  }
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

test('age retires only empty directories; nested and unpublished source survives (CH-16)', () => {
  const root = mkdtempSync(join(tmpdir(), 'scratch-age-'));
  const old = new Date(Date.now() - 30 * DAY), fresh = new Date();
  const mk = (name, ...children) => {
    const d = join(root, name); mkdirSync(d);
    for (const c of children) writeFileSync(join(d, c), 'x');
    for (const c of children) utimesSync(join(d, c), old, old);
    utimesSync(d, old, old); return d;
  };
  try {
    mk('idle', 'f'); mk('empty');
    mk('touched-child', 'f'); utimesSync(join(root, 'touched-child', 'f'), fresh, fresh);
    mk('kept', 'f');
    const deep = mk('deep-change'); mkdirSync(join(deep, 'a', 'b'), { recursive: true });
    for (const p of ['a/b', 'a']) utimesSync(join(deep, p), old, old);
    writeFileSync(join(deep, 'a', 'b', 'new'), 'y'); utimesSync(deep, old, old); utimesSync(join(deep, 'a'), old, old);
    const git = mk('unpushed-git', 'f'); execFileSync('git', ['init', '-q', git]); utimesSync(join(git, '.git'), old, old); utimesSync(git, old, old);
    const held = mk('cwd', 'f');
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: held, stdio: 'ignore' });
    try {
      const es = Object.fromEntries(observeScratch({ scratch: { idleDays: 2, roots: [{ path: root, keep: ['kept'] }] } }, Date.now(), { readRootEntries: () => readdirSync(root).sort() }).map((e) => [e.name, e]));
      assert.deepEqual(Object.fromEntries(Object.entries(es).map(([n, e]) => [n, e.expire])),
        { cwd: false, 'deep-change': false, empty: true, idle: false, kept: false, 'touched-child': false, 'unpushed-git': false });
      assert.equal(es.kept.reason, 'kept by the record');
      assert.equal(es.cwd.reason, 'open in a running process');
      assert.match(es['touched-child'].reason, /retained for original-owner/);
      assert.match(es['unpushed-git'].reason, /retained for original-owner/);
    } finally { sleeper.kill('SIGKILL'); }
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

test('timer-only installation atomically copies exact selected files and keeps the existing hourly timer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-install-'));
  try {
    const source = join(root, 'source'), installed = join(root, 'installed'), units = join(root, 'units');
    for (const d of ['src', 'scripts']) mkdirSync(join(source, d), { recursive: true });
    const script = join(source, 'scripts/codex-home.mjs'), parameters = join(root, 'record.json');
    writeFileSync(join(source, 'package.json'), '{"name":"fixture"}\n');
    writeFileSync(join(source, 'src/codex-home.mjs'), '// exact-source\n');
    writeFileSync(join(source, 'src/thread-provider.mjs'), '// exact-native-provider\n');
    writeFileSync(script, '// exact-cli\n');
    const selected = { installDir: installed, node: '/native/node', retention: { onCalendar: 'hourly', onBootDelay: '15min' } };
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

test('native generic cleanup preserves useful files/source and an arriving child', async () => {
  const root=mkdtempSync(join(tmpdir(),'scratch-safe-native-'));
  try {
    mkdirSync(join(root,'empty'));mkdirSync(join(root,'racing'));mkdirSync(join(root,'useful'));writeFileSync(join(root,'useful','unpublished.mjs'),'export const valuable=1;');writeFileSync(join(root,'unpublished.txt'),'useful');
    for(const name of readdirSync(root))utimesSync(join(root,name),new Date(0),new Date(0));
    const original=nativeFs.rmdirSync;
    nativeFs.rmdirSync=path=>{if(path===join(root,'racing'))writeFileSync(join(path,'arriving.mjs'),'preserve');return original(path);};syncBuiltinESMExports();
    try {await apply({...record,scratch:{idleDays:2,roots:[{path:root}]}},'scratch',{script:'/not-used',parameters:'/not-used'});}
    finally{nativeFs.rmdirSync=original;syncBuiltinESMExports();}
    assert.deepEqual(readdirSync(root).sort(),['racing','unpublished.txt','useful']);
    assert.equal(readFileSync(join(root,'racing','arriving.mjs'),'utf8'),'preserve');assert.equal(readFileSync(join(root,'useful','unpublished.mjs'),'utf8'),'export const valuable=1;');
  }finally{rmSync(root,{recursive:true,force:true});}
});
