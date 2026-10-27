import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {observeScratch, apply} from '../src/codex-home.mjs';

const roots=[];
const fixture=()=>{const root=fs.mkdtempSync(path.join(tmpdir(),'bounded-scratch-'));roots.push(root);return root;};
test.after(()=>{for(const root of roots)fs.rmSync(root,{recursive:true,force:true});});

test('delegated retirement holds live and unknown children before listing and scratch-only apply',async()=>{
 const root=fixture(),delegated=path.join(root,'runtimes');fs.mkdirSync(delegated);
 const old=new Date(Date.now()-30*86400000);
 for(const name of ['live-composition','unknown-operation']){
  const child=path.join(delegated,name);fs.mkdirSync(child);fs.writeFileSync(path.join(child,'product'),name);
  fs.utimesSync(path.join(child,'product'),old,old);fs.utimesSync(child,old,old);
 }
 const record={home:path.join(root,'home'),scratch:{idleDays:2,roots:[{path:delegated}]}};
 const incumbent=observeScratch(record);assert.equal(incumbent.length,2);assert.ok(incumbent.every(x=>!x.expire));assert.ok(incumbent.every(x=>x.reason.includes('original-owner')));
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
