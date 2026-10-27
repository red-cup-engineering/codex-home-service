import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { receiveWorkspaceGit, gitMaintenanceHoldState, applyGitMaintenanceHold } from '../src/git-maintenance-hold.mjs';
import { applyScopes } from '../src/codex-home.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codex-git-hold-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'xdg'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
  mkdirSync(env.HOME); mkdirSync(env.XDG_CONFIG_HOME);
  // Even tiny fixture commits must not start automatic maintenance.
  const git = (args, input) => execFileSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 1024 * 1024 }).trimEnd();
  const init = name => { const path = join(root, name); git(['init', '-q', path]); return path; };
  const config = (repo, key, value) => git(['-C', repo, 'config', '--local', key, value]);
  const object = repo => { const hash = git(['-C', repo, 'hash-object', '-w', '--stdin'], 'retained object\n'); return join(repo, '.git', 'objects', hash.slice(0, 2), hash.slice(2)); };
  return { root, env, git, init, config, object, close: () => rmSync(root, { recursive: true, force: true }) };
}

const snapshot = path => {
  const s = statSync(path, { bigint: true });
  return { bytes: readFileSync(path).toString('base64'), ino: String(s.ino), dev: String(s.dev), mtimeNs: String(s.mtimeNs), size: String(s.size) };
};

async function withEnvironment(environment, body) {
  const original = { ...process.env };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, environment);
  try { return await body(); }
  finally { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, original); }
}

async function workspace(path, selection) {
  const ws = { path, excludes: ['/generated/'], ...(selection === undefined ? {} : { gitMaintenance: selection }) };
  return applyScopes({ workspaces: [ws] }, 'workspace', { script: '/unused', parameters: '/unused' });
}

test('native workspace hold removes only selected registration and repeats with zero additional effects', async () => {
  const f = fixture();
  try {
    const target = f.init('target'), other = f.init('other');
    const targetObject = f.object(target), otherObject = f.object(other);
    f.git(['-C', target, 'maintenance', 'register']); f.git(['-C', other, 'maintenance', 'register']);
    f.config(target, 'maintenance.auto', 'true'); f.config(target, 'gc.auto', '17');
    f.config(target, 'maintenance.strategy', 'owner-strategy'); f.config(other, 'owner.setting', 'retained');
    f.git(['config', '--global', 'owner.setting', 'unrelated']);
    const beforeObjects = [snapshot(targetObject), snapshot(otherObject)], otherConfig = snapshot(join(other, '.git', 'config'));
    await withEnvironment(f.env, async () => {
      const first = await workspace(target, false);
      assert.deepEqual(first.failures, []); assert.equal(first.log.filter(x => x.startsWith('git ')).length, 3);
      assert.match(first.notes[0], /held.*running\/manual work not cancelled/);
      const identity = receiveWorkspaceGit(target), held = gitMaintenanceHoldState(identity);
      assert.equal(held.held, true); assert.equal(held.registered, false);
      assert.equal(f.git(['config', '--global', '--get-all', 'maintenance.repo']), other);
      assert.equal(f.git(['-C', target, 'config', '--local', 'maintenance.strategy']), 'owner-strategy');
      assert.equal(f.git(['config', '--global', 'owner.setting']), 'unrelated');
      assert.deepEqual(snapshot(join(other, '.git', 'config')), otherConfig);
      const paths = [join(f.env.HOME, '.gitconfig'), join(target, '.git', 'config'), join(target, '.git', 'info', 'exclude'), targetObject, otherObject];
      const afterFirst = paths.map(snapshot);
      const second = await workspace(target, false);
      assert.deepEqual(second.failures, []); assert.deepEqual(second.log, []);
      assert.deepEqual(paths.map(snapshot), afterFirst);
      assert.deepEqual(applyGitMaintenanceHold(identity).changed, []);
      const omitted = await workspace(target, undefined);
      assert.deepEqual(omitted.failures, []); assert.deepEqual(omitted.log, []);
      assert.deepEqual(paths.map(snapshot), afterFirst); assert.equal(gitMaintenanceHoldState(identity).held, true);
    });
    assert.deepEqual([snapshot(targetObject), snapshot(otherObject)], beforeObjects);
  } finally { f.close(); }
});

test('ambient Git routing and configuration injection cannot redirect the native hold or excludes', async () => {
  const f = fixture();
  try {
    const target = f.init('target'), victim = f.init('victim');
    f.git(['-C', target, 'maintenance', 'register']); f.git(['-C', victim, 'maintenance', 'register']);
    const victimConfig = snapshot(join(victim, '.git', 'config')), victimExclude = snapshot(join(victim, '.git', 'info', 'exclude'));
    const foreign = join(f.root, 'foreign.gitconfig'); writeFileSync(foreign, '[owner]\n setting = preserved\n');
    const foreignBefore = snapshot(foreign);
    const hostile = { ...f.env, GIT_DIR: join(victim, '.git'), GIT_WORK_TREE: victim, GIT_COMMON_DIR: join(victim, '.git'),
      GIT_OBJECT_DIRECTORY: join(victim, '.git', 'objects'), GIT_INDEX_FILE: join(victim, '.git', 'index'),
      GIT_CONFIG_GLOBAL: foreign, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: victim };
    await withEnvironment(hostile, async () => {
      assert.equal(receiveWorkspaceGit(target).path, target);
      const applied = await workspace(target, false); assert.deepEqual(applied.failures, []);
      assert.equal(gitMaintenanceHoldState(receiveWorkspaceGit(target)).held, true);
    });
    assert.equal(f.git(['config', '--global', '--get-all', 'maintenance.repo']), victim);
    assert.deepEqual(snapshot(join(victim, '.git', 'config')), victimConfig);
    assert.deepEqual(snapshot(join(victim, '.git', 'info', 'exclude')), victimExclude);
    assert.deepEqual(snapshot(foreign), foreignBefore);
  } finally { f.close(); }
});

test('ancestor discovery and forged Git metadata refuse before any workspace write', async () => {
  const f = fixture();
  try {
    const parent = f.init('parent'), nested = join(parent, 'nested'), forged = join(f.root, 'forged');
    mkdirSync(nested); mkdirSync(forged); writeFileSync(join(forged, '.git'), 'gitdir: ' + join(parent, '.git') + '\n');
    f.git(['-C', parent, 'maintenance', 'register']);
    const paths = [join(f.env.HOME, '.gitconfig'), join(parent, '.git', 'config'), join(parent, '.git', 'info', 'exclude'), join(forged, '.git')];
    const before = paths.map(snapshot);
    await withEnvironment(f.env, async () => {
      for (const path of [nested, forged]) {
        const result = await workspace(path, false);
        assert.equal(result.failures.length, 1); assert.equal(result.failures[0].scope, 'workspace');
        assert.equal(result.log.some(x => x.startsWith('git ')), false);
        assert.equal(existsSync(join(path, '.git', 'info', 'exclude')), false);
      }
    });
    assert.deepEqual(paths.map(snapshot), before);
  } finally { f.close(); }
});

test('actual linked worktree holds its selected registration while preserving main registration and shared objects', async () => {
  const f = fixture();
  try {
    const main = f.init('main'), linked = join(f.root, 'linked');
    f.git(['-C', main, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
    f.git(['-C', main, 'worktree', 'add', '-q', '--detach', linked, 'HEAD']);
    f.git(['-C', main, 'maintenance', 'register']); f.git(['-C', linked, 'maintenance', 'register']);
    const obj = f.object(main), before = snapshot(obj);
    await withEnvironment(f.env, async () => {
      const identity = receiveWorkspaceGit(linked); assert.notEqual(identity.gitDir, identity.commonDir);
      const result = await workspace(linked, false); assert.deepEqual(result.failures, []);
      assert.equal(gitMaintenanceHoldState(identity).held, true);
      assert.equal(existsSync(join(identity.commonDir, 'info', 'exclude')), true);
    });
    assert.equal(f.git(['config', '--global', '--get-all', 'maintenance.repo']), main);
    assert.deepEqual(snapshot(obj), before);
  } finally { f.close(); }
});

test('actual absorbed submodule preserves native paths including a trailing space and parent configuration', async () => {
  for (const suffix of ['', ' ']) {
    const f = fixture();
    try {
      const name = 'child' + suffix, parent = f.init('parent'), child = join(parent, name);
      f.git(['init', '-q', child]);
      f.git(['-C', child, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
      f.git(['-C', parent, 'config', '--file', '.gitmodules', 'submodule.' + name + '.path', name]);
      f.git(['-C', parent, 'config', '--file', '.gitmodules', 'submodule.' + name + '.url', './unused-local-source']);
      f.git(['-C', parent, '-c', 'advice.addEmbeddedRepo=false', 'add', '.gitmodules', name]);
      f.git(['-C', parent, 'submodule', 'absorbgitdirs', name]);
      f.git(['-C', child, 'maintenance', 'register']);
      const parentBefore = snapshot(join(parent, '.git', 'config'));
      await withEnvironment(f.env, async () => {
        const identity = receiveWorkspaceGit(child);
        assert.equal(identity.gitDir.endsWith('/modules/' + name), true);
        assert.equal(identity.path, child);
        const result = await workspace(child, false); assert.deepEqual(result.failures, []);
        assert.equal(gitMaintenanceHoldState(identity).held, true);
        assert.deepEqual((await workspace(child, false)).log, []);
      });
      assert.deepEqual(snapshot(join(parent, '.git', 'config')), parentBefore);
    } finally { f.close(); }
  }
});

test('changed native metadata identity is refused before registration or local-config effects', () => {
  const f = fixture();
  try {
    const target = f.init('target'), replacement = f.init('replacement');
    f.git(['-C', target, 'maintenance', 'register']);
    const identity = receiveWorkspaceGit(target, f.env);
    renameSync(join(target, '.git'), join(target, '.git-prior'));
    renameSync(join(replacement, '.git'), join(target, '.git'));
    const paths = [join(f.env.HOME, '.gitconfig'), join(target, '.git', 'config')], before = paths.map(snapshot);
    assert.throws(() => applyGitMaintenanceHold(identity, f.env), /identity changed/);
    assert.deepEqual(paths.map(snapshot), before);
  } finally { f.close(); }
});

test('effective worktree override prevents a false held result', () => {
  const f = fixture();
  try {
    const target = f.init('target'); f.config(target, 'extensions.worktreeConfig', 'true');
    f.config(target, 'maintenance.auto', 'false'); f.config(target, 'gc.auto', '0');
    f.git(['-C', target, 'config', '--worktree', 'maintenance.auto', 'true']);
    const identity = receiveWorkspaceGit(target, f.env);
    assert.equal(gitMaintenanceHoldState(identity, f.env).held, false);
    assert.throws(() => applyGitMaintenanceHold(identity, f.env), /hold not received/);
    assert.equal(f.git(['-C', target, 'config', '--worktree', 'maintenance.auto']), 'true');
  } finally { f.close(); }
});
