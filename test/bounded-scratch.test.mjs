import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {checkoutState, observeScratch, apply} from '../src/codex-home.mjs';

const roots=[];
const fixture=()=>{const root=fs.mkdtempSync(path.join(tmpdir(),'bounded-scratch-'));roots.push(root);return root;};
test.after(()=>{for(const root of roots)fs.rmSync(root,{recursive:true,force:true});});
const git=(cwd,...args)=>execFileSync('git',['-c','user.email=test@example.invalid','-c','user.name=test',...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
function repository(){const root=fixture();git(root,'init','--initial-branch=main');fs.writeFileSync(path.join(root,'tracked'),'original');git(root,'add','tracked');git(root,'commit','-m','original');return root;}

test('delegated retirement holds live and unknown children before listing and scratch-only apply',async()=>{
 const root=fixture(),delegated=path.join(root,'runtimes');fs.mkdirSync(delegated);
 const old=new Date(Date.now()-30*86400000);
 for(const name of ['live-composition','unknown-operation']){
  const child=path.join(delegated,name);fs.mkdirSync(child);fs.writeFileSync(path.join(child,'product'),name);
  fs.utimesSync(path.join(child,'product'),old,old);fs.utimesSync(child,old,old);
 }
 const record={home:path.join(root,'home'),scratch:{idleDays:2,roots:[{path:delegated}]}};
 const incumbent=observeScratch(record);assert.equal(incumbent.length,2);assert.ok(incumbent.every(x=>x.expire));
 const owner='https://github.com/example/deployment-owner';record.scratch.roots[0].retirementOwner=owner;
 const held=observeScratch(record,Date.now(),{readRootEntries(){throw Error('delegated root must not be listed');}});
 assert.equal(held.length,1);assert.equal(held[0].expire,false);assert.equal(held[0].retirementOwner,owner);
 assert.deepEqual(await apply(record,'scratch',{}),[]);
 for(const name of ['live-composition','unknown-operation'])assert.equal(fs.readFileSync(path.join(delegated,name,'product'),'utf8'),name);
});

test('invalid delegated identity refuses before scratch effects and future timer installation',async()=>{
 for(const retirementOwner of ['',null,'http://example.test/owner','https://user:password@example.test/owner','https://example.test/','https://example.test/owner?grant=true']){
  const record={scratch:{idleDays:2,roots:[{path:'/not-read',retirementOwner}]}};
  assert.throws(()=>observeScratch(record),/canonical HTTPS scratch retirement owner required/);
  await assert.rejects(apply(record,'timer',{}),/canonical HTTPS scratch retirement owner required/);
 }
});

test('protected and ancestor-crossing checkouts refuse before native Git status',()=>{
 const root=repository(),elsewhere=fixture(),protectedChild=path.join(root,'protected');fs.mkdirSync(protectedChild);
 assert.equal(checkoutState(root,elsewhere).ok,false);
 assert.match(checkoutState(root,root,{protectedRoots:[protectedChild]}).reason,/scope/);
 assert.match(checkoutState(root,root,{protectedRoots:[root]}).reason,/scope/);
 git(root,'config','core.worktree',elsewhere);
 assert.match(checkoutState(root).reason,/native checkout scope differs/);
});

test('native read-only status does not run a monitor or modify its index',()=>{
 const root=repository(),marker=path.join(root,'monitor-ran'),monitor=path.join(root,'.git','monitor');
 fs.writeFileSync(monitor,'#!/bin/sh\nprintf touched > '+JSON.stringify(marker)+'\n',{mode:0o700});git(root,'config','core.fsmonitor',monitor);
 const index=path.join(root,'.git','index'),before=fs.readFileSync(index),mtime=fs.statSync(index).mtimeMs;
 assert.equal(checkoutState(root).reason,'commits on no remote');
 assert.equal(fs.existsSync(marker),false);assert.deepEqual(fs.readFileSync(index),before);assert.equal(fs.statSync(index).mtimeMs,mtime);
 git(root,'config','filter.unreceived.clean','unreceived-filter-command');
 assert.match(checkoutState(root).reason,/filters are unreceived/);
});

test('submodule index and exhausted aggregate budget hold instead of recursively probing',()=>{
 const root=repository(),head=git(root,'rev-parse','HEAD').trim();
 git(root,'update-index','--add','--cacheinfo','160000,'+head+',nested');
 assert.match(checkoutState(root).reason,/submodule checkout proof is unknown/);
 assert.match(checkoutState(root,root,{budget:{deadline:performance.now()-1}}).reason,/read budget/);
});

test('native child deadline and output exhaustion reap only their own fixture process',()=>{
 const originalPath=process.env.PATH;
 const realGit=originalPath.split(path.delimiter).map(dir=>path.join(dir,'git')).find(file=>fs.existsSync(file));
 for(const mode of ['deadline','output']){
  const root=repository(),bin=path.join(root,'.git','fixture-bin'),pidFile=path.join(root,'.git','probe.pid');fs.mkdirSync(bin);
  const wrapper=`#!${process.execPath}\nimport fs from 'node:fs';import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);
if(args.includes('status')){fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));${mode==='output'?"process.stdout.write('x'.repeat(1024*1024));":''}setInterval(()=>{},1000);}
else{const result=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(result.status??1);}\n`;
  fs.writeFileSync(path.join(bin,'git'),wrapper,{mode:0o700});process.env.PATH=bin+path.delimiter+originalPath;
  try{
   const started=performance.now(),result=checkoutState(root);
   assert.equal(result.ok,false);assert.match(result.reason,/unknown or exceeded its read budget/);assert.ok(performance.now()-started<5000);
   const pid=Number(fs.readFileSync(pidFile,'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  }finally{process.env.PATH=originalPath;}
 }
});
