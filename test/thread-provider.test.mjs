import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {withThreadProvider,listProviderThreads,THREAD_SOURCES} from '../src/thread-provider.mjs';

test('native pagination includes every source and refuses repeated or oversized pages',async()=>{
 const calls=[];const rows=await listProviderThreads(async(method,p)=>{calls.push(p);return p.archived?{data:[],nextCursor:null}:p.cursor?{data:[{id:'two',path:'/two'}],nextCursor:null}:{data:[{id:'one',path:'/one'}],nextCursor:'next'};});
 assert.equal(rows.length,2);assert.equal(calls.length,3);assert.ok(calls.every(p=>p.useStateDbOnly&&p.sourceKinds.length===THREAD_SOURCES.length));
 await assert.rejects(()=>listProviderThreads(async()=>({data:[],nextCursor:'again'})),/repeated/);
 await assert.rejects(()=>listProviderThreads(async()=>({data:Array.from({length:101},(_,i)=>({id:String(i)}))})),/invalid/);
 await assert.rejects(()=>listProviderThreads(async()=>({data:[],nextCursor:'more'}),{maximumPages:1}),/page budget/);
});

function provider(t,{stall=false,overflow=false}={}){
 const root=mkdtempSync(join(tmpdir(),'native-thread-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const binary=join(root,'provider.mjs');
 writeFileSync(binary,`#!${process.execPath}\nimport fs from 'node:fs';import readline from 'node:readline';fs.writeFileSync(${JSON.stringify(join(root,'pid'))},String(process.pid));const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{const m=JSON.parse(line);if(${stall})return;if(${overflow}){process.stdout.write('x'.repeat(4096));return;}if(m.id===undefined)return;if(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');else if(m.method==='thread/list')process.stdout.write(JSON.stringify({id:m.id,result:{data:m.params.archived?[]:[{id:'one',path:'/one'}],nextCursor:null}})+'\\n');else process.stdout.write(JSON.stringify({id:m.id,error:{code:-32601}})+'\\n');});\n`,{mode:0o700});
 return {root,binary,home:root};
}

test('one actual child handshake/list connection is reaped without starting a conversation',async t=>{
 const p=provider(t);const rows=await withThreadProvider(p,listProviderThreads);assert.equal(rows[0].id,'one');const pid=Number(readFileSync(join(p.root,'pid')));assert.throws(()=>process.kill(pid,0));
});

test('an unresponsive or overflowing child is killed, without a storage fallback',async t=>{
 for(const options of [{stall:true},{overflow:true}]){const p=provider(t,options);await assert.rejects(()=>withThreadProvider({...p,timeoutMs:500,maximumBytes:1024},listProviderThreads),/deadline|output budget/);const pid=Number(readFileSync(join(p.root,'pid')));assert.throws(()=>process.kill(pid,0));}
});
