import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { checkoutState, observeScratch, scratchProofBudget, validateScratch } from '../src/codex-home.mjs';

const roots = [];
const fixture = () => { const root = fs.mkdtempSync(join(tmpdir(), 'scratch-proof-')); roots.push(root); return root; };
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const old = new Date(0);
const idle = (p) => fs.utimesSync(p, old, old);

test('the proof budget is bounded integers and defaults to the original limits (CH-34)', () => {
  assert.deepEqual(scratchProofBudget({ scratch: {} }), { entryReads: 1_000_000, entryDirs: 1_000_000, entryMs: 10_000, totalMs: 120_000, checkoutMs: 120_000 });
  assert.equal(scratchProofBudget({ scratch: { proofBudget: { entryReads: 5000 } } }).entryReads, 5000);
  for (const bad of [{ entryReads: 0 }, { entryReads: 1.5 }, { entryMs: 1e9 }, { totalMs: '30000' }, { bytes: 10 }, []])
    assert.throws(() => scratchProofBudget({ scratch: { proofBudget: bad } }), /proofBudget/);
  // A root widens only what one of its entries may spend; the run's own time and git budgets stay the record's.
  assert.equal(scratchProofBudget({ scratch: { proofBudget: { totalMs: 30000 } } }, { proofBudget: { entryDirs: 900 } }).entryDirs, 900);
  assert.throws(() => scratchProofBudget({ scratch: {} }, { proofBudget: { totalMs: 30000 } }), /scratch root proofBudget/);
  assert.throws(() => validateScratch({ scratch: { roots: [{ path: '/x', proofBudget: { entryReads: 0 } }] } }), /scratch root proofBudget/);
});

test('one entry too large to prove idle is held alone and never leaves the others unproven (CH-34)', () => {
  const root = fixture();
  const big = join(root, 'a-big'), small = join(root, 'z-small'), many = join(root, 'm-many-dirs');
  fs.mkdirSync(big); fs.mkdirSync(small); fs.mkdirSync(many);
  for (let i = 0; i < 1100; i++) fs.writeFileSync(join(big, `f${i}`), '');
  for (let i = 0; i < 300; i++) fs.mkdirSync(join(many, `d${i}`));
  fs.writeFileSync(join(small, 'f'), '');
  for (let i = 0; i < 1100; i++) idle(join(big, `f${i}`));
  for (let i = 0; i < 300; i++) idle(join(many, `d${i}`));
  idle(join(small, 'f'));
  for (const p of [big, small, many]) idle(p);
  const decide = (proofBudget) => Object.fromEntries(observeScratch({ scratch: { idleDays: 2, proofBudget: { totalMs: 20000 }, roots: [{ path: root, ...(proofBudget ? { proofBudget } : {}) }] } }, Date.now(), { readRootEntries: () => ['a-big', 'm-many-dirs', 'z-small'] })
    .map((e) => [e.name, e.expire ? 'expire' : e.reason]));
  assert.deepEqual(decide({ entryReads: 1024, entryDirs: 256, entryMs: 250 }), { 'a-big': 'too large to prove idle', 'm-many-dirs': 'too large to prove idle', 'z-small': 'expire' });
  assert.deepEqual(decide(), { 'a-big': 'expire', 'm-many-dirs': 'expire', 'z-small': 'expire' });
});

test('a blobless checkout is proven clean and pushed, or held, without fetching (CH-34)', () => {
  const root = fixture(), source = join(root, 'source'), entry = join(root, 'entry');
  fs.mkdirSync(source); fs.mkdirSync(entry);
  git(source, 'init', '--initial-branch=main'); git(source, 'config', 'uploadpack.allowFilter', 'true');
  fs.writeFileSync(join(source, 'tracked'), 'one'); git(source, 'add', 'tracked'); git(source, 'commit', '-m', 'one');
  git(entry, 'clone', '--filter=blob:none', `file://${source}`, 'clone');
  const clone = join(entry, 'clone');
  assert.equal(git(clone, 'config', '--get', 'remote.origin.promisor').trim(), 'true');
  assert.deepEqual(checkoutState(clone, entry).ok, true);
  assert.equal(checkoutState(clone, entry).reason, 'clean and pushed');
  fs.writeFileSync(join(clone, 'tracked'), 'changed');
  assert.equal(checkoutState(clone, entry).reason, 'uncommitted changes');
  git(clone, 'checkout', 'tracked'); fs.writeFileSync(join(clone, 'new'), 'x'); git(clone, 'add', 'new'); git(clone, 'commit', '-m', 'two');
  assert.equal(checkoutState(clone, entry).reason, 'commits on no remote');
});

test('a read that would need a missing object fails closed under refused transports (CH-34)', () => {
  const root = fixture(), source = join(root, 'source'), clone = join(root, 'clone');
  fs.mkdirSync(source);
  git(source, 'init', '--initial-branch=main'); git(source, 'config', 'uploadpack.allowFilter', 'true');
  fs.writeFileSync(join(source, 'tracked'), 'one'); git(source, 'add', 'tracked'); git(source, 'commit', '-m', 'one');
  fs.writeFileSync(join(source, 'tracked'), 'two'); git(source, 'commit', '-am', 'two');
  git(root, 'clone', '--filter=blob:none', `file://${source}`, 'clone');
  const older = git(clone, 'rev-parse', 'HEAD~1:tracked').trim();
  assert.throws(() => git(clone, '-c', 'protocol.allow=never', 'cat-file', '-p', older), /not allowed|could not fetch/);
});
