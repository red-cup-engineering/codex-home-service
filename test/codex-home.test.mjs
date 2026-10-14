import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  BEGIN, END, mergeManagedBlock, withoutManagedBlock, shellRcLines, pluginHeader, pluginServerState, pluginLines,
  selectRetention, selectLegacy, renderTimerUnits, installedPaths, uncoveredPacks, classifyLogin,
  decideScratch, scratchActivity, checkoutState,
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
