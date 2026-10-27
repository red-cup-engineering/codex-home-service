// CH-15: receive a native repository before changing its maintenance selection.
import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const environmentForGit = (environment) => ({
  ...Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
});

function git(path, args, environment, missing = false) {
  try {
    return execFileSync('git', ['-C', path, ...args], {
      env: environmentForGit(environment), encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    if (missing && error.status === 1 && !error.signal) return null;
    throw new Error(`native Git receiving failed (${args.slice(0, 2).join(' ')})`, { cause: error });
  }
}

function physical(path) {
  const s = lstatSync(path, { bigint: true });
  if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile())) throw new Error('workspace Git identity is not a real file or directory');
  return { dev: String(s.dev), ino: String(s.ino), kind: s.isDirectory() ? 'directory' : 'file',
    ...(s.isFile() ? { size: String(s.size), mtimeNs: String(s.mtimeNs) } : {}) };
}

/** Native worktree membership prevents a nested directory or forged .git pointer adopting its ancestor. */
export function receiveWorkspaceGit(path, environment = process.env) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\r\n\0]/u.test(path)) throw new Error('workspace must name an absolute native Git worktree');
  const selected = resolve(path);
  if (realpathSync(selected) !== selected || !lstatSync(selected).isDirectory()) throw new Error('workspace must be its exact real Git worktree');
  const marker = join(selected, '.git');
  const markerIdentity = physical(marker);
  const received = git(selected, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], environment).replace(/\n$/u, '').split('\n');
  if (received.length !== 3 || received.some(p => !isAbsolute(p) || /[\r\0]/u.test(p))) throw new Error('native Git identity was incomplete');
  const [top, gitDir, commonDir] = received.map(p => realpathSync(p));
  if (top !== selected) throw new Error('workspace is not the exact native Git worktree');
  const registered = git(selected, ['--git-dir', gitDir, 'worktree', 'list', '--porcelain', '-z'], environment)
    .split('\0').some(field => field.startsWith('worktree ') && resolve(field.slice(9)) === selected);
  if (!registered) {
    // Absorbed submodules can expose their metadata directory as the primary
    // worktree; their native local core.worktree binds the actual checkout.
    const explicit = git(selected, ['config', '--local', '--path', '--get', 'core.worktree'], environment, true)?.replace(/\n$/u, '');
    if (!explicit || realpathSync(resolve(gitDir, explicit)) !== selected) throw new Error('workspace has no native Git metadata linkage');
  }
  const identity = { path: selected, gitDir, commonDir,
    physical: { root: physical(selected), marker: markerIdentity, gitDir: physical(gitDir), commonDir: physical(commonDir) } };
  if (identity.physical.gitDir.kind !== 'directory' || identity.physical.commonDir.kind !== 'directory') throw new Error('native Git metadata must be directories');
  return identity;
}

export function recheckWorkspaceGit(identity, environment = process.env) {
  const current = receiveWorkspaceGit(identity.path, environment);
  if (!isDeepStrictEqual(current, identity)) throw new Error('workspace Git identity changed; no further effects admitted');
  return current;
}

export function runWorkspaceGit(identity, args, environment = process.env) {
  recheckWorkspaceGit(identity, environment);
  return git(identity.path, args, environment);
}

/** This is a selected-registration hold, not cancellation of running/manual Git commands. */
export function gitMaintenanceHoldState(identity, environment = process.env) {
  recheckWorkspaceGit(identity, environment);
  const registrations = git(identity.path, ['config', '--global', '--null', '--get-all', 'maintenance.repo'], environment, true);
  const registered = (registrations?.split('\0') ?? []).includes(identity.path);
  const localAuto = git(identity.path, ['config', '--local', '--bool', '--get', 'maintenance.auto'], environment, true)?.trim();
  const localGc = git(identity.path, ['config', '--local', '--int', '--get', 'gc.auto'], environment, true)?.trim();
  const effectiveAuto = git(identity.path, ['config', '--bool', '--get', 'maintenance.auto'], environment, true)?.trim();
  const effectiveGc = git(identity.path, ['config', '--int', '--get', 'gc.auto'], environment, true)?.trim();
  return { registered, localAuto, localGc, effectiveAuto, effectiveGc,
    held: !registered && localAuto === 'false' && localGc === '0' && effectiveAuto === 'false' && effectiveGc === '0' };
}

export function applyGitMaintenanceHold(identity, environment = process.env) {
  const before = gitMaintenanceHoldState(identity, environment), changed = [];
  const mutate = (args, description) => {
    recheckWorkspaceGit(identity, environment);
    git(identity.path, args, environment);
    changed.push(description);
  };
  if (before.registered) mutate(['maintenance', 'unregister', '--force'], 'maintenance unregister');
  if (before.localAuto !== 'false') mutate(['config', '--local', '--replace-all', 'maintenance.auto', 'false'], 'maintenance.auto=false');
  if (before.localGc !== '0') mutate(['config', '--local', '--replace-all', 'gc.auto', '0'], 'gc.auto=0');
  const after = gitMaintenanceHoldState(identity, environment);
  if (!after.held) throw new Error('Git maintenance hold not received; other configuration or registration remains');
  return { ...after, changed };
}
