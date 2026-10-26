import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { apply, applyScopes, ApplyFailed, decideScratch, observeScratch, runningSessionIds } from '../src/codex-home.mjs';

const roots = [];
const fixture = () => { const root = fs.mkdtempSync(join(tmpdir(), 'independent-scopes-')); roots.push(root); return root; };
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
const script = fileURLToPath(new URL('../scripts/codex-home.mjs', import.meta.url));
const old = new Date(0);
const idleEntry = (dir, name) => { const p = join(dir, name); fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(join(p, 'f'), name); fs.utimesSync(join(p, 'f'), old, old); fs.utimesSync(p, old, old); return p; };

// A record whose retention scope must fail (no Codex binary to ask) and whose scratch scope has work to do.
function failingRetention(root) {
  const scratch = join(root, 'scratch');
  fs.mkdirSync(scratch, { recursive: true });
  return {
    schema: 'codex-home-parameters@1', home: join(root, 'home'), windowsProfileCodexDir: root, shellRc: join(root, 'profile'),
    installDir: join(root, 'install'), node: process.execPath, codexBinaryGlob: join(root, 'no-binary', '*', 'codex'),
    retention: { idleDays: 2, legacyDir: join(root, 'legacy'), searchedSoftLimitBytes: 1e9, onCalendar: 'hourly', onBootDelay: '15min' },
    scratch: { idleDays: 2, roots: [{ path: scratch }] },
  };
}

test('a failing scope is reported and the scopes after it still run (CH-32)', async () => {
  const root = fixture(), record = failingRetention(root), entry = idleEntry(record.scratch.roots[0].path, 'idle-task');
  const { log, notes, failures } = await applyScopes(record, 'retention,scratch', { script, parameters: '/unused' });
  assert.deepEqual(failures.map((f) => f.scope), ['retention']);
  assert.match(failures[0].error.message, /exact native Codex binary and home required/);
  assert.ok(log.some((l) => l.startsWith('FAILED retention: ')));
  assert.ok(log.includes(`expired ${entry} (unchanged since 1970-01-01)`));
  assert.equal(fs.existsSync(entry), false);
  assert.match(notes[0], /^scratch: 1 expired, 0 kept of 1 entries/);
});

test('scopes run in the listed order whichever way the caller names them, and each failure is its own', async () => {
  const root = fixture(), record = { ...failingRetention(root), headroom: { vmVolume: join(root, 'no-vm'), hostVolume: join(root, 'no-host'), floorBytes: 1, idleHours: 1 } };
  const entry = idleEntry(record.scratch.roots[0].path, 'idle-task');
  const { failures, log } = await applyScopes(record, 'scratch,retention', { script, parameters: '/unused' });
  assert.deepEqual(failures.map((f) => f.scope), ['retention', 'scratch']);
  assert.match(failures[1].error.message, /unknown pressure: scratch retirement held/);
  assert.equal(fs.existsSync(entry), true);                                   // held, not removed
  assert.deepEqual(log.filter((l) => l.startsWith('FAILED')).map((l) => l.split(':')[0]), ['FAILED retention', 'FAILED scratch']);
});

test('an unrelated later scope is installed although scratch failed (CH-32)', async () => {
  const root = fixture(), source = join(root, 'source'), units = join(root, 'units');
  for (const d of ['src', 'scripts']) fs.mkdirSync(join(source, d), { recursive: true });
  const entry = join(source, 'scripts/codex-home.mjs'), parameters = join(root, 'record.json');
  fs.writeFileSync(join(source, 'package.json'), '{"name":"fixture"}\n');
  fs.writeFileSync(join(source, 'src/codex-home.mjs'), '// src\n');
  fs.writeFileSync(join(source, 'src/thread-provider.mjs'), '// provider\n');
  fs.writeFileSync(entry, '// cli\n');
  const record = { ...failingRetention(root), headroom: { vmVolume: join(root, 'no-vm'), hostVolume: join(root, 'no-host'), floorBytes: 1, idleHours: 1 } };
  fs.writeFileSync(parameters, JSON.stringify(record));
  const calls = [];
  const ports = { timerDirectory: () => units, systemctlUser: (...args) => calls.push(args) };
  const { failures } = await applyScopes(record, 'scratch,timer', { script: entry, parameters }, ports);
  assert.deepEqual(failures.map((f) => f.scope), ['scratch']);
  assert.match(fs.readFileSync(join(units, 'codex-home-retention.timer'), 'utf8'), /OnCalendar=hourly/);
  assert.equal(fs.readFileSync(join(record.installDir, 'src/codex-home.mjs'), 'utf8'), '// src\n');
  assert.deepEqual(calls, [['daemon-reload'], ['enable', '--now', 'codex-home-retention.timer']]);
});

test('apply keeps returning the log, and throws ApplyFailed carrying the log and failures when a scope failed', async () => {
  const root = fixture(), record = failingRetention(root), entry = idleEntry(record.scratch.roots[0].path, 'idle-task');
  assert.deepEqual(await apply(record, 'config', { script, parameters: '/unused' }), []);
  await assert.rejects(apply(record, 'retention,scratch', { script, parameters: '/unused' }), (error) => {
    assert.ok(error instanceof ApplyFailed);
    assert.deepEqual(error.failures.map((f) => f.scope), ['retention']);
    assert.ok(error.log.some((l) => l.startsWith('expired ')));
    assert.match(error.message, /apply failed in retention/);
    return true;
  });
  assert.equal(fs.existsSync(entry), false);
});

test('a record that is refused outright still stops every scope before its effects', async () => {
  const root = fixture(), record = failingRetention(root), entry = idleEntry(record.scratch.roots[0].path, 'idle-task');
  record.scratch.roots[0].liveSessionFlags = ['not-a-long-option'];
  await assert.rejects(applyScopes(record, 'scratch,timer', { script, parameters: '/unused' }, { systemctlUser() { throw new Error('must not run'); } }), /liveSessionFlags must list long option names/);
  assert.equal(fs.existsSync(entry), true);
});

test('the command exits non-zero after a failed scope while the other scopes have done their work (CH-32)', () => {
  const root = fixture(), record = failingRetention(root), entry = idleEntry(record.scratch.roots[0].path, 'idle-task');
  const parameters = join(root, 'record.json');
  fs.writeFileSync(parameters, JSON.stringify(record));
  const run = spawnSync(process.execPath, [script, 'apply', '--scope=retention,scratch', `--parameters=${parameters}`], { encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /FAILED retention: /);
  assert.match(run.stdout, new RegExp(`expired ${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `));
  assert.match(run.stdout, /scratch: 1 expired, 0 kept of 1 entries/);
  assert.match(run.stderr, /scope retention failed: exact native Codex binary and home required/);
  assert.equal(fs.existsSync(entry), false);
});

test('an entry named by a running session is kept, and goes once that session has ended (CH-33)', async () => {
  const root = fixture(), scratch = join(root, 'scratch');
  const live = 'aaaaaaaa-1111-4111-8111-111111111111', resumed = 'bbbbbbbb-2222-4222-8222-222222222222', gone = 'cccccccc-3333-4333-8333-333333333333';
  for (const name of [live, resumed, gone]) idleEntry(scratch, name);
  const record = { home: join(root, 'home'), scratch: { idleDays: 2, roots: [{ path: scratch, liveSessionFlags: ['--session-id', '--resume='] }] } };
  const hold = ['-e', 'setTimeout(() => {}, 120000)', '--'];
  const children = [spawn(process.execPath, [...hold, `--session-id=${live}`], { stdio: 'ignore' }), spawn(process.execPath, [...hold, '--resume', resumed], { stdio: 'ignore' })];
  try {
    await Promise.all(children.map((c) => once(c, 'spawn')));
    assert.deepEqual([...runningSessionIds(['--session-id', '--resume'])].filter((id) => [live, resumed, gone].includes(id)).sort(), [live, resumed]);
    const seen = Object.fromEntries(observeScratch(record).map((e) => [e.name, e]));
    assert.deepEqual([seen[live].expire, seen[resumed].expire, seen[gone].expire], [false, false, true]);
    assert.equal(seen[live].reason, 'belongs to a running session');
    assert.equal(seen[resumed].reason, 'belongs to a running session');
  } finally {
    for (const c of children) c.kill('SIGKILL');
    await Promise.all(children.map((c) => (c.exitCode === null && c.signalCode === null ? once(c, 'exit') : null)));
  }
  assert.ok(observeScratch(record).every((e) => e.expire));
});

test('a running session outranks idleness but not the record: decideScratch order', () => {
  const idle = { declaredKeep: false, mount: false, inUse: false, activity: { complete: true, recent: false, newestMs: 0 }, checkouts: [] };
  assert.equal(decideScratch({ ...idle, liveSession: true }).reason, 'belongs to a running session');
  assert.equal(decideScratch({ ...idle, liveSession: true, declaredKeep: true }).reason, 'kept by the record');
  assert.equal(decideScratch({ ...idle, liveSession: false }).expire, true);
});
