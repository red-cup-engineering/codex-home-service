#!/usr/bin/env node
// codex-home plan  --parameters=<codex-home.json>
// codex-home apply --parameters=<codex-home.json> [--scope=all|placement|retention|scratch|workspace|config|timer|harness[,...]]
// Exit: 0 converged, 2 drift remains, 1 when any apply scope failed (the other scopes still ran), 64 usage.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadRecord, observe, applyScopes } from '../src/codex-home.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
if (!['plan', 'apply'].includes(cmd) || !opt.parameters) {
  console.error('usage: codex-home plan|apply --parameters=<codex-home.json> [--scope=all|placement|retention|scratch|workspace|config|timer|harness[,...]]');
  process.exit(64);
}
const parameters = resolve(opt.parameters);
const script = fileURLToPath(import.meta.url);
const record = loadRecord(parameters);
const ctx = { script, parameters };

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
