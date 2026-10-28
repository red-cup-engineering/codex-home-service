import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyScopes } from '../src/codex-home.mjs';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 28, 12);
const context = { script: '/unused', parameters: '/unused' };

function fixture(t, idleDays = 2) {
  const root = mkdtempSync(join(tmpdir(), 'retention-fastpath-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), sessions = join(home, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const record = { home, codexBinaryGlob: join(root, 'missing', '*', 'codex'),
    retention: { idleDays, legacyDir: join(root, 'legacy') } };
  const file = (name, age) => {
    const path = join(sessions, name);
    writeFileSync(path, '{}\n');
    utimesSync(path, new Date(NOW - age), new Date(NOW - age));
    return path;
  };
  return { root, record, file };
}

test('empty and recent retention observations need no Codex binary, including both exact age boundaries', async t => {
  t.mock.method(Date, 'now', () => NOW);
  for (const idleDays of [2, 0.25]) {
    const f = fixture(t, idleDays);
    for (const state of ['empty', 'recent']) {
      const path = state === 'recent' ? f.file('recent.jsonl', Math.min(idleDays, 1) * DAY) : null;
      const result = await applyScopes(f.record, 'retention', context);
      assert.deepEqual(result.failures, []);
      assert.deepEqual(result.log, []);
      assert.deepEqual(result.notes, ['retention: no session file is old enough for archive or legacy selection; native thread provider not started']);
      if (path) assert.equal(readFileSync(path, 'utf8'), '{}\n');
      assert.equal(existsSync(f.record.retention.legacyDir), false);
    }
  }
});

test('any old archive or legacy candidate still requires the original provider before effects', async t => {
  t.mock.method(Date, 'now', () => NOW);
  for (const [idleDays, age] of [[2, 3 * DAY], [7, 1.5 * DAY], [0.25, 0.5 * DAY]]) {
    const f = fixture(t, idleDays), candidate = f.file('candidate.jsonl', age);
    f.file('recent.jsonl', 0);
    const result = await applyScopes(f.record, 'retention', context);
    assert.deepEqual(result.failures.map(failure => failure.scope), ['retention']);
    assert.match(result.failures[0].error.message, /exact native Codex binary and home required/);
    assert.equal(result.notes.length, 0);
    assert.equal(readFileSync(candidate, 'utf8'), '{}\n');
    assert.equal(existsSync(f.record.retention.legacyDir), false);
  }
});

test('old candidates retain native archive authority and referenced legacy protection', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const f = fixture(t), active = f.file('active.jsonl', 3 * DAY), archived = f.file('archived.jsonl', 3 * DAY);
  const fresh = f.file('fresh.jsonl', DAY / 2), orphan = f.file('orphan.jsonl', 1.5 * DAY), recentOrphan = f.file('recent-orphan.jsonl', DAY / 2);
  const binary = join(f.root, 'bin', 'selected', 'codex'), calls = join(f.root, 'calls.jsonl'), retired = join(f.root, 'native-archived.jsonl');
  mkdirSync(join(f.root, 'bin', 'selected'), { recursive: true });
  writeFileSync(binary, `#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(m)+'\\n');if(m.id===undefined)return;
 let result={};
 if(m.method==='thread/list')result={data:m.params.archived?[{id:'archived',path:${JSON.stringify(archived)}}]:[{id:'active',path:${JSON.stringify(active)}},{id:'fresh',path:${JSON.stringify(fresh)}}],nextCursor:null};
 if(m.method==='thread/archive'){if(m.params.threadId!=='active')throw Error('unexpected archive');fs.renameSync(${JSON.stringify(active)},${JSON.stringify(retired)});}
 process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
});
`, { mode: 0o700 });
  f.record.codexBinaryGlob = join(f.root, 'bin', '*', 'codex');
  const result = await applyScopes(f.record, 'retention', context);
  assert.deepEqual(result.failures, []);
  const requests = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(requests.filter(r => r.method === 'thread/archive').map(r => r.params.threadId), ['active']);
  const lists = requests.filter(r => r.method === 'thread/list');
  assert.deepEqual(lists.map(r => r.params.archived), [false, true]);
  assert.ok(lists.every(r => r.params.useStateDbOnly === true));
  assert.equal(existsSync(active), false);
  assert.equal(existsSync(retired), true);
  assert.equal(existsSync(orphan), false);
  assert.equal(readFileSync(join(f.record.retention.legacyDir, 'orphan.jsonl'), 'utf8'), '{}\n');
  for (const path of [archived, fresh, recentOrphan]) assert.equal(readFileSync(path, 'utf8'), '{}\n');
  assert.equal(result.notes.length, 0);
});
