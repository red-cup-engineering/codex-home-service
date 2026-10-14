import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BEGIN, END, mergeManagedBlock, withoutManagedBlock, shellRcLines, pluginHeader, pluginServerState, pluginLines,
  selectRetention, selectLegacy, renderTimerUnits, installedPaths, uncoveredPacks, classifyLogin,
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
