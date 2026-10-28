import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readThreads, reconcileHarnessResources, observe, renderTimerUnits } from '../src/codex-home.mjs';
import { fileURLToPath } from 'node:url';

function fixture(t) { const p=fs.mkdtempSync(join(tmpdir(),'health-read-')); t.after(()=>{const scratch=join(p,'scratch');if(fs.existsSync(scratch))fs.chmodSync(scratch,0o700);fs.rmSync(p,{recursive:true,force:true})}); return p; }
test('thread metadata uses the native provider and resolves omitted paths from the existing finite listing',async()=>{
 const calls=[];
 const rows=await readThreads('/native/home',{binary:'/native/codex',files:[{path:'/native/home/sessions/rollout-id-1.jsonl'}],connect:async(options,operation)=>{assert.equal(options.binary,'/native/codex');return operation(async(method,params)=>{calls.push({method,params});return {data:params.archived?[]:[{id:'id-1',path:null}],nextCursor:null};});}});
 assert.deepEqual(rows,[{id:'id-1',rollout_path:'/native/home/sessions/rollout-id-1.jsonl',archived:0}]);
 assert.equal(calls.length,2);assert.ok(calls.every(c=>c.method==='thread/list'&&c.params.useStateDbOnly===true));
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


test('the owning record selects containment installation and keeps dry-run free of effects',async t=>{
 const root=fixture(t),source=fileURLToPath(new URL('../../../../../src/host-resource-hook.mjs',import.meta.url));
 const installer=join(root,'selected-installer.mjs'),effect=join(root,'native-containment-received');
 fs.writeFileSync(installer,`import{writeFileSync}from'node:fs';export function installContainment({dryRun}){if(!dryRun)writeFileSync(${JSON.stringify(effect)},'received');return{changed:dryRun,workUnit:${JSON.stringify(join(root,'agent-work.slice'))},reloaded:!dryRun}}`);
 const record={harnessResources:{source,containmentInstaller:installer,workspaces:[{path:root,providers:['claude','codex']}]}};
 const planned=await reconcileHarnessResources(record,{dryRun:true});
 assert.equal(planned[0].containment.changed,true);assert.equal(fs.existsSync(effect),false);
 const applied=await reconcileHarnessResources(record);
 assert.equal(applied[0].containment.reloaded,true);assert.equal(fs.readFileSync(effect,'utf8'),'received');
 assert.equal(applied[0].activeSessionGuarded,false);assert.equal(applied[0].codexTrustRequired,true);
});

test('the existing timer reconciles selected provider registrations without changing cadence',()=>{
 const record={node:'/node',retention:{onCalendar:'hourly',onBootDelay:'15min'},scratch:{roots:[]},harnessResources:{source:'/owner'}};
 const units=renderTimerUnits(record,'/installed/service','/record');
 assert.match(units.service,/--scope=retention,scratch,harness /);assert.match(units.timer,/OnCalendar=hourly/);
});

test('the original context installer reaches both providers through record-owned reconciliation', async t => {
 const root=fixture(t),source=fileURLToPath(new URL('../../../../../src/host-resource-hook.mjs',import.meta.url));
 const houseContextInstaller=fileURLToPath(new URL('../../../../../scripts/install-house-context-hook.mjs',import.meta.url));
 const record={node:process.execPath,harnessResources:{source,houseContextInstaller,workspaces:[{path:root,providers:['claude','codex']}]}};
 const planned=await reconcileHarnessResources(record,{dryRun:true});
 assert.equal(planned[0].context.length,2);assert.ok(planned[0].context.every(c=>c.changed));
 assert.equal(fs.existsSync(join(root,'.codex')),false);assert.equal(fs.existsSync(join(root,'.claude')),false);
 await reconcileHarnessResources(record);
 for(const file of ['.codex/hooks.json','.claude/settings.local.json']){
  const context=JSON.parse(fs.readFileSync(join(root,file),'utf8'));
  assert.ok(context.hooks.PreToolUse.length>0);
  for(const event of ['SessionStart','SubagentStart','UserPromptSubmit'])assert.ok(context.hooks[event].some(group=>group.hooks.some(h=>h.command.includes('house-context-hook.mjs'))));
 }
 assert.ok((await reconcileHarnessResources(record,{dryRun:true}))[0].context.every(c=>!c.changed));
 assert.equal((await reconcileHarnessResources(record,{dryRun:true}))[0].activeSessionGuarded,false);
 const refused=fixture(t);
 await assert.rejects(reconcileHarnessResources({harnessResources:{source,houseContextInstaller:'relative.mjs',workspaces:[{path:refused,providers:['codex']}]}}),/absolute owning source/);
 assert.equal(fs.existsSync(join(refused,'.codex')),false);
});
