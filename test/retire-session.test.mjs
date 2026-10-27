import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { retireSession } from '../src/codex-home.mjs';

const roots = [];
const fixture = () => { const r = fs.mkdtempSync(join(tmpdir(), 'retire-session-')); roots.push(r); return r; };
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
const script = fileURLToPath(new URL('../scripts/codex-home.mjs', import.meta.url));
const entry = (dir, name) => { const p = join(dir, name); fs.mkdirSync(join(p, 'scratchpad'), { recursive: true }); fs.writeFileSync(join(p, 'scratchpad', 'f'), name); return p; };
const recordFor = (scratch) => ({ home: fixture(), scratch: { idleDays: 2, roots: [{ path: scratch }] } });
const SID = 'aaaaaaaa-1111-4111-8111-111111111111';
const hold = ['-e', 'setTimeout(() => {}, 120000)', '--'];

test('an ended session is retired at once, however fresh its files, and only that session (CH-35)', async () => {
  const scratch = fixture(), mine = entry(scratch, SID), other = entry(scratch, 'bbbbbbbb-2222-4222-8222-222222222222');
  const result = await retireSession(recordFor(scratch), { session: SID });
  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(mine), false);
  assert.equal(fs.existsSync(other), true);
});

test('the session id is a name, never a path (CH-35)', async () => {
  const scratch = fixture(), mine = entry(scratch, SID);
  for (const session of ['../x', 'a/b', '', '.', undefined]) await assert.rejects(retireSession(recordFor(scratch), { session }), /session id/);
  assert.equal(fs.existsSync(mine), true);
});

test('a session folder that a running process has as its cwd is kept (CH-35)', async () => {
  const scratch = fixture(), mine = entry(scratch, SID);
  const child = spawn(process.execPath, [...hold], { cwd: mine, stdio: 'ignore' });
  try {
    await once(child, 'spawn');
    const held = await retireSession(recordFor(scratch), { session: SID });
    assert.equal(held.removed, 0);
    assert.equal(held.held[0].reason, 'open in a running process');
  } finally { child.kill('SIGKILL'); await once(child, 'exit'); }
});

test('with afterPid it waits for the ending session process to exit, then retires (CH-35)', async () => {
  const scratch = fixture(), mine = entry(scratch, SID);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 700)', '--', `--session-id=${SID}`], { stdio: 'ignore' });
  await once(child, 'spawn');
  const result = await retireSession(recordFor(scratch), { session: SID, afterPid: child.pid, waitMs: 20000, pollMs: 50 });
  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(mine), false);
  const stuck = spawn(process.execPath, [...hold, `--session-id=${SID}`], { stdio: 'ignore' });
  try {
    await once(stuck, 'spawn'); entry(scratch, SID);
    const gave = await retireSession(recordFor(scratch), { session: SID, afterPid: stuck.pid, waitMs: 300, pollMs: 50 });
    assert.equal(gave.removed, 0); assert.match(gave.held[0].reason, /still running/);
  } finally { stuck.kill('SIGKILL'); await once(stuck, 'exit'); }
});

test('the command retires one session and exits 0, held or not (CH-35)', () => {
  const scratch = fixture(), mine = entry(scratch, SID), parameters = join(fixture(), 'r.json');
  const record = { schema: 'codex-home-parameters@1', ...recordFor(scratch) };
  fs.writeFileSync(parameters, JSON.stringify(record));
  const run = spawnSync(process.execPath, [script, 'retire', `--parameters=${parameters}`, `--session=${SID}`], { encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0);
  assert.match(run.stdout, new RegExp(`expired ${mine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `));
  assert.equal(fs.existsSync(mine), false);
  const again = spawnSync(process.execPath, [script, 'retire', `--parameters=${parameters}`, `--session=${SID}`], { encoding: 'utf8', timeout: 60000 });
  assert.equal(again.status, 0); assert.match(again.stdout, /nothing to retire/);
});
