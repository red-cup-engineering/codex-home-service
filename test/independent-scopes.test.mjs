import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { apply, applyScopes, ApplyFailed } from '../src/codex-home.mjs';

const roots = [];
const fixture = () => { const root = fs.mkdtempSync(join(tmpdir(), 'independent-scopes-')); roots.push(root); return root; };
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
const script = fileURLToPath(new URL('../scripts/codex-home.mjs', import.meta.url));
const old = new Date(0);
const idleEntry = (dir, name) => { const p = join(dir, name); fs.mkdirSync(p, { recursive: true }); fs.utimesSync(p, old, old); return p; };

// A record whose retention scope must fail (no Codex binary to ask) and whose scratch scope has work to do.
function failingRetention(root) {
  const scratch = join(root, 'scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const sessions = join(root, 'home', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const rollout = join(sessions, 'old-rollout.jsonl');
  fs.writeFileSync(rollout, '{}\n');
  fs.utimesSync(rollout, old, old);
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
  const root = fixture(), base = failingRetention(root), record = { ...base, scratch: { ...base.scratch, idleDays: 0 } };
  const entry = idleEntry(record.scratch.roots[0].path, 'idle-task');
  const { failures, log } = await applyScopes(record, 'scratch,retention', { script, parameters: '/unused' });
  assert.deepEqual(failures.map((f) => f.scope), ['retention', 'scratch']);
  assert.match(failures[1].error.message, /finite bounded scratch cutoff required/);
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
  fs.writeFileSync(join(source, 'src/git-maintenance-hold.mjs'), '// native Git hold\n');
  fs.writeFileSync(entry, '// cli\n');
  const base = failingRetention(root), record = { ...base, scratch: { ...base.scratch, idleDays: 0 } };
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
