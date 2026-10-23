import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readThreads, scratchActivity, reconcileHarnessResources, observe, renderTimerUnits } from '../src/codex-home.mjs';
import { fileURLToPath } from 'node:url';

function fixture(t) { const p=fs.mkdtempSync(join(tmpdir(),'health-read-')); t.after(()=>{const scratch=join(p,'scratch');if(fs.existsSync(scratch))fs.chmodSync(scratch,0o700);fs.rmSync(p,{recursive:true,force:true})}); return p; }
test('thread metadata uses the native provider and resolves omitted paths from the existing finite listing',async()=>{
 const calls=[];
 const rows=await readThreads('/native/home',{binary:'/native/codex',files:[{path:'/native/home/sessions/rollout-id-1.jsonl'}],connect:async(options,operation)=>{assert.equal(options.binary,'/native/codex');return operation(async(method,params)=>{calls.push({method,params});return {data:params.archived?[]:[{id:'id-1',path:null}],nextCursor:null};});}});
 assert.deepEqual(rows,[{id:'id-1',rollout_path:'/native/home/sessions/rollout-id-1.jsonl',archived:0}]);
 assert.equal(calls.length,2);assert.ok(calls.every(c=>c.method==='thread/list'&&c.params.useStateDbOnly===true));
});

test('activity deadline refuses before touching an unknown entry',()=>{
 assert.equal(scratchActivity('/missing/entry',0,{budget:{deadline:0,remaining:0}}).complete,false);
});

test('health observes declared scratch policy without opening its unreadable root', async t => {
 const root=fixture(t);
 const scratch=join(root,'scratch');fs.mkdirSync(scratch);fs.chmodSync(scratch,0);t.after(()=>{if(fs.existsSync(scratch))fs.chmodSync(scratch,0o700)});
 const profile=join(root,'profile');fs.writeFileSync(profile,'');
 const record={home:root,windowsProfileCodexDir:root,shellRc:profile,installDir:join(root,'install'),node:process.execPath,retention:{idleDays:2,searchedSoftLimitBytes:100,onCalendar:'hourly',onBootDelay:'15min'},scratch:{idleDays:2,roots:[{path:scratch}]}};
 const script=fileURLToPath(new URL('../scripts/codex-home.mjs',import.meta.url));
 const parameters=join(root,'record.json');fs.writeFileSync(parameters,JSON.stringify(record));
 const items=await observe(record,{script,parameters});
 assert.match(items.find(i=>i.id.includes('CH-16')).detail,/not inspected by health plan/);
});

test('record-owned harness apply selects the common controller and dry-run creates no provider files',async t=>{
 const root=fixture(t),source=fileURLToPath(new URL('../../../../../src/host-resource-hook.mjs',import.meta.url));
 const record={harnessResources:{source,workspaces:[{path:root,providers:['claude','codex']}]}};
 const planned=await reconcileHarnessResources(record,{dryRun:true});assert.equal(planned[0].written.length,3);assert.equal(fs.existsSync(join(root,'.claude')),false);
 const changed=await reconcileHarnessResources(record);assert.equal(changed[0].activeSessionGuarded,false);assert.equal(changed[0].codexTrustRequired,true);
 assert.deepEqual((await reconcileHarnessResources(record,{dryRun:true}))[0].written,[]);
});


test('the existing timer reconciles selected provider registrations without changing cadence',()=>{
 const record={node:'/node',retention:{onCalendar:'hourly',onBootDelay:'15min'},scratch:{roots:[]},harnessResources:{source:'/owner'}};
 const units=renderTimerUnits(record,'/installed/service','/record');
 assert.match(units.service,/--scope=retention,scratch,harness /);assert.match(units.timer,/OnCalendar=hourly/);
});
