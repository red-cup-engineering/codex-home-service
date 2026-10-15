#!/usr/bin/env node
// codex-home plan  --parameters=<codex-home.json>
// codex-home apply --parameters=<codex-home.json> [--scope=all|placement|retention|scratch|workspace|config|timer[,...]]
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadRecord, observe, apply } from '../src/codex-home.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
if (!['plan', 'apply'].includes(cmd) || !opt.parameters) {
  console.error('usage: codex-home plan|apply --parameters=<codex-home.json> [--scope=all|placement|retention|scratch|workspace|config|timer[,...]]');
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

if (cmd === 'apply') {
  const log = await apply(record, opt.scope ?? 'all', ctx);
  for (const line of log) console.log(line);
  if (!log.length) console.log('nothing to change');
  console.log('---');
}
process.exit(print(await observe(record, ctx)) ? 2 : 0);
