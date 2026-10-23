// Codex owns its private storage. This boundary uses only its native metadata/archive protocol.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const THREAD_SOURCES = Object.freeze(['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown']);

/** One finite provider connection, no model turn, history load, storage fallback or retry. */
export async function withThreadProvider({ binary, home, timeoutMs = 5000, maximumBytes = 2 * 1024 * 1024 }, operation) {
  if (typeof binary !== 'string' || !binary.startsWith('/') || typeof home !== 'string' || !home.startsWith('/')) throw new Error('exact native Codex binary and home required');
  const child = spawn(binary, ['app-server', '--listen', 'stdio://'], { cwd: home, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const pending = new Map();
  let sequence = 0, bytes = 0, failed;
  const kill = () => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  const stop = error => { failed ??= error; for (const entry of pending.values()) entry.reject(error); pending.clear(); kill(); };
  const deadline = setTimeout(() => stop(new Error('native thread provider exceeded its deadline during ' + [...pending.values()].map(entry => entry.method).join(', '))), timeoutMs);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const closed = new Promise(resolve => child.once('close', resolve));
  child.on('error', error => stop(error));
  child.on('exit', () => { if (pending.size) stop(new Error('native thread provider exited before receiving its response')); });
  const account = chunk => { bytes += chunk.length; if (bytes > maximumBytes) stop(new Error('native thread provider exceeded its output budget')); };
  child.stdout.on('data', account); child.stderr.on('data', account);
  child.stdin.on('error', error => stop(error));
  const send = message => { if (failed) throw failed; child.stdin.write(JSON.stringify(message) + '\n'); };
  lines.on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.method) {
        if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'This metadata client admits no server-initiated action' } });
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(`native ${entry.method} refused (${message.error.code})`));
      else entry.resolve(message.result);
    } catch (error) { stop(error); }
  });
  const request = (method, params) => {
    if (!['initialize', 'thread/list', 'thread/archive'].includes(method)) return Promise.reject(new Error('unsupported native thread operation'));
    if (failed) return Promise.reject(failed);
    return new Promise((resolve, reject) => { const id = sequence++; pending.set(id, { method, resolve, reject }); try { send({ id, method, params }); } catch (error) { pending.delete(id); reject(error); } });
  };
  try {
    await request('initialize', { clientInfo: { name: 'codex-home-service', title: 'Codex home service', version: '1.0.0' } });
    send({ method: 'initialized', params: {} });
    return await operation(request);
  } finally {
    lines.close(); child.stdin.end();
    const reap = setTimeout(kill, 100);
    await closed; clearTimeout(reap); clearTimeout(deadline);
  }
}

/** Complete active and archived metadata, explicitly disabling Codex's log-scan repair path. */
export async function listProviderThreads(request, { maximumPages = 20 } = {}) {
  const rows = [], seen = new Set();
  let pages = 0;
  for (const archived of [false, true]) {
    let cursor = null;
    const cursors = new Set();
    do {
      if (++pages > maximumPages) throw new Error('native thread list exceeded its page budget');
      const result = await request('thread/list', { archived, cursor, limit: 100, modelProviders: [], sourceKinds: [...THREAD_SOURCES], useStateDbOnly: true });
      if (!Array.isArray(result?.data) || result.data.length > 100 || (result.nextCursor != null && typeof result.nextCursor !== 'string')) throw new Error('invalid native thread list');
      for (const thread of result.data) {
        if (typeof thread.id !== 'string' || !thread.id || seen.has(thread.id) || (thread.path != null && typeof thread.path !== 'string')) throw new Error('ambiguous native thread identity');
        seen.add(thread.id); rows.push({ id: thread.id, rollout_path: thread.path ?? null, archived: Number(archived) });
      }
      cursor = result.nextCursor ?? null;
      if (cursor !== null && cursors.has(cursor)) throw new Error('native thread list repeated a cursor');
      if (cursor !== null) cursors.add(cursor);
    } while (cursor !== null);
  }
  return rows;
}
