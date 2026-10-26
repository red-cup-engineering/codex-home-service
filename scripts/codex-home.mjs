#!/usr/bin/env node
// codex-home plan  --parameters=<codex-home.json>
// codex-home apply --parameters=<codex-home.json> [--scope=all|placement|retention|scratch|workspace|config|timer|harness[,...]]
// codex-home retire --parameters=<codex-home.json> --session=<id> [--after-pid=<pid>] [--wait-seconds=<n>]   (an event: one ended session's scratch, CH-35)
// Exit: 0 converged, 2 drift remains, 1 when any apply scope failed (the other scopes still ran), 64 usage.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadRecord, observe, applyScopes, retireSession } from '../src/codex-home.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
if (!['plan', 'apply', 'retire'].includes(cmd) || !opt.parameters) {
  console.error('usage: codex-home plan|apply --parameters=<codex-home.json> [--scope=all|placement|retention|scratch|workspace|config|timer|harness[,...]]\n       codex-home retire --parameters=<codex-home.json> --session=<id> [--after-pid=<pid>] [--wait-seconds=<n>]');
  process.exit(64);
}
const parameters = resolve(opt.parameters);
const script = fileURLToPath(import.meta.url);
const record = loadRecord(parameters);
const ctx = { script, parameters };

if (cmd === 'retire') {
  try {
    const result = await retireSession(record, { session: opt.session, afterPid: opt['after-pid'] ? Number(opt['after-pid']) : null, waitMs: opt['wait-seconds'] ? Number(opt['wait-seconds']) * 1000 : undefined });
    for (const line of result.log) console.log(line);
    for (const h of result.held) console.log(`kept ${h.path} (${h.reason})`);
    if (!result.log.length && !result.held.length) console.log('nothing to retire');
    process.exit(0);
  } catch (error) { console.error(`retire failed: ${error.message}`); process.exit(1); }
}

const print = (items) => {
  for (const i of items) console.log(`${i.status.padEnd(8)} ${i.id.padEnd(48)} ${i.detail}`);
  return items.some((i) => i.status !== 'current');
};

let failed = false;
if (cmd === 'apply') {
  const { log, notes, failures } = await applyScopes(record, opt.scope ?? 'all', ctx);
  for (const line of log) console.log(line);
  for (const line of notes) console.log(line);
  if (!log.length) console.log('nothing to change');
  for (const { scope, error } of failures) console.error(`scope ${scope} failed: ${error.message}`);
  failed = failures.length > 0;
  console.log('---');
}
let drift;
try { drift = print(await observe(record, ctx)); }
catch (error) { console.error(`plan failed: ${error.message}`); drift = true; failed = true; }
process.exit(failed ? 1 : drift ? 2 : 0);
