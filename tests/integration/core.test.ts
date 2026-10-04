import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, readdir, copyFile, stat, rename, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/state/db.js';
import { rootIdentity } from '../../src/state/project.js';
import { readStableFile } from '../../src/security/paths.js';
import { invalidateLogin, rebindRoute } from '../../src/state/profile.js';
import { BridgeService } from '../../src/runtime/service.js';
import { AgentExecutor } from '../../src/runtime/agent.js';
import { projectlessRoot } from '../../src/state/paths.js';
import { BridgeError } from '../../src/security/errors.js';
import type { BrowserAdapter } from '../../src/browser/adapter.js';
import type { Task } from '../../src/types.js';

async function fixture(adapter:BrowserAdapter|null=null) {
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-test-'));
  await writeFile(path.join(root,'main.ts'),'export const answer = 42;\n');
  const store=new Store(':memory:');
  store.db.prepare('INSERT INTO projects(id,root,identity,created_at) VALUES(?,?,?,?)').run('prj_a',root,rootIdentity(root),Date.now());
  store.db.prepare("INSERT INTO profiles(id,route) VALUES('default','Pro')").run();
  const service=new BridgeService(store,adapter,'prj_a');
  return {root,store,service,cleanup:async()=>{
    const deadline=Date.now()+5000;
    while(BridgeService.isActive()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(BridgeService.isActive(),false,'fixture still has an active browser task');
    store.close();await rm(root,{recursive:true,force:true});
  }};
}
const ask=(key='key',packet?:string)=>({project_id:'prj_a',request_key:key,question:'Review this',mode:'review' as const,context_packet_id:packet,session:{kind:'new' as const}});
function code(fn:()=>unknown,expected:string) {assert.throws(fn,(e:unknown)=>e instanceof BridgeError&&e.code===expected);}

test('opted-in pure text queues exact single-send grants across projects without an hourly cap',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'cpb-auto-text-'));
  const priorData=process.env.CODEX_PRO_BRIDGE_DATA_DIR;
  process.env.CODEX_PRO_BRIDGE_DATA_DIR=data;
  const root=projectlessRoot(),ordinary=path.join(data,'ordinary');await Promise.all([mkdir(root),mkdir(ordinary)]);
  const store=new Store(':memory:');
  try {
    store.db.prepare('INSERT INTO projects(id,root,identity,created_at) VALUES(?,?,?,?)').run('prj_text',root,rootIdentity(root),Date.now());
    store.db.prepare('INSERT INTO projects(id,root,identity,created_at) VALUES(?,?,?,?)').run('prj_regular',ordinary,rootIdentity(ordinary),Date.now());
    store.db.prepare("INSERT INTO profiles(id,route) VALUES('default',NULL)").run();
    const agent=new AgentExecutor(store);agent.bindRoute('6 Pro','Test Pro');
    const service=new BridgeService(store,null,'prj_text');
    const submit=(key:string)=>service.ask({project_id:'prj_text',request_key:key,question:'Compare two product options',mode:'plan',auto_text_opt_in:true,session:{kind:'new'}});
    const first=submit('first');
    assert.equal(first.status,'queued');assert.equal('approval_required' in first&&first.approval_required,false);
    assert.equal(submit('second').status,'queued');
    const projectText=new BridgeService(store,null,'prj_regular').ask({project_id:'prj_regular',request_key:'project-text',question:'Compare two options',mode:'plan',auto_text_opt_in:true,session:{kind:'new'}});
    assert.equal(projectText.status,'queued');
    const fourth=submit('third');
    assert.equal(fourth.status,'queued');assert.equal('approval_required' in fourth&&fourth.approval_required,false);
    const regular=new BridgeService(store,null,'prj_regular').ask({project_id:'prj_regular',request_key:'regular',question:'Compare two options',mode:'plan',session:{kind:'new'}});
    assert.equal(regular.status,'awaiting_approval');
    const promoted=new BridgeService(store,null,'prj_regular').ask({project_id:'prj_regular',request_key:'regular',question:'Compare two options',mode:'plan',auto_text_opt_in:true,session:{kind:'new'}});
    assert.equal(promoted.task_id,regular.task_id);
    assert.equal(promoted.status,'queued');
    assert.equal('approval_required' in promoted&&promoted.approval_required,false);
    const grant=store.db.prepare("SELECT id,remaining,payload_sha256 FROM grants WHERE task_id=?").get(first.task_id) as {id:string;remaining:number;payload_sha256:string};
    assert.match(grant.id,/^gr_auto_/);assert.equal(grant.payload_sha256,first.payload_sha256);
    const claimed=await agent.claim('prj_text','6 Pro','Test Pro');
    assert.equal(claimed?.task_id,first.task_id);
    await agent.sendIntent(first.task_id,'prj_text',first.payload_sha256,'6 Pro','Test Pro');
    assert.equal((store.db.prepare('SELECT remaining FROM grants WHERE id=?').get(grant.id) as {remaining:number}).remaining,0);
  } finally {
    store.close();
    if(priorData===undefined)delete process.env.CODEX_PRO_BRIDGE_DATA_DIR;else process.env.CODEX_PRO_BRIDGE_DATA_DIR=priorData;
    await rm(data,{recursive:true,force:true});
  }
});

test('an unsent project text task can gain automatic authorization without changing its identity; file packets cannot',async()=>{
  const f=await fixture();try {
    const original=f.service.ask(ask('project-text'));
    assert.equal(original.status,'awaiting_approval');
    const promoted=f.service.ask({...ask('project-text'),auto_text_opt_in:true});
    assert.equal(promoted.task_id,original.task_id);
    assert.equal(promoted.status,'queued');
    assert.equal('approval_required' in promoted&&promoted.approval_required,false);
    const grant=f.store.db.prepare('SELECT payload_sha256,remaining FROM grants WHERE task_id=?').get(original.task_id) as {payload_sha256:string;remaining:number};
    assert.equal(grant.payload_sha256,original.payload_sha256);
    assert.equal(grant.remaining,1);
    const packet=await f.service.prepare({project_id:'prj_a',files:[{path:'main.ts'}],diff:'none'});
    const withFiles=f.service.ask({...ask('with-files',(packet as {packet_id:string}).packet_id),auto_text_opt_in:true});
    assert.equal(withFiles.status,'awaiting_approval');
  } finally {await f.cleanup();}
});

test('manual route reconfiguration rotates binding and revokes old grants even after returning to the same label',async()=>{
  const f=await fixture();try {
    const grant=f.service.authorizeSession('prj_a',[],60,3);
    const original=f.service.ask(ask()) as any;
    assert.equal(original.status,'queued');
    const configured=rebindRoute(f.store,'Other');
    assert.equal(configured.login_epoch,2);
    assert.equal(f.store.task(original.task_id)?.status,'paused');
    assert.equal(f.store.task(original.task_id)?.pause_reason,'ROUTE_UNAVAILABLE');
    assert.equal((f.store.db.prepare('SELECT remaining FROM grants WHERE id=?').get(grant.grant_id) as {remaining:number}).remaining,0);
    rebindRoute(f.store,'Pro');
    const after=f.service.ask(ask('after-route')) as any;
    assert.equal(after.status,'awaiting_approval');
    assert.equal((f.store.db.prepare("SELECT login_epoch FROM profiles WHERE id='default'").get() as {login_epoch:number}).login_epoch,3);
    assert.equal((f.service.ask(ask()) as any).task_id,original.task_id);
    code(()=>f.service.approve('prj_a',original.task_id,original.payload_sha256),'APPROVAL_EXPIRED');
  } finally {await f.cleanup();}
});

test('opening login invalidates saved route, grants and unsent tasks',async()=>{
  const f=await fixture();try {
    const grant=f.service.authorizeSession('prj_a',[],60,2);
    const queued=f.service.ask(ask('before-login')) as any;
    invalidateLogin(f.store);
    assert.equal(f.store.task(queued.task_id)?.status,'paused');
    assert.equal(f.store.task(queued.task_id)?.pause_reason,'LOGIN_REQUIRED');
    assert.equal((f.store.db.prepare('SELECT remaining FROM grants WHERE id=?').get(grant.grant_id) as {remaining:number}).remaining,0);
    const profile=f.store.db.prepare("SELECT route,login_epoch,verified_at FROM profiles WHERE id='default'").get() as {route:string|null;login_epoch:number;verified_at:number|null};
    assert.equal(profile.route,null);
    assert.equal(profile.login_epoch,2);
    assert.equal(profile.verified_at,null);
    code(()=>f.service.ask(ask('after-login')),'ROUTE_UNAVAILABLE');
  } finally {await f.cleanup();}
});

test('context snapshot, project boundary and secret blocking',async()=>{
  const f=await fixture();try {
    const p=await f.service.prepare({project_id:'prj_a',files:[{path:'main.ts'}],diff:'none'});
    assert.equal((p as any).scan_status,'passed_with_limitations');
    await assert.rejects(f.service.prepare({project_id:'prj_b',files:[{path:'main.ts'}],diff:'none'}),{code:'PROJECT_MISMATCH'});
    await assert.rejects(f.service.prepare({project_id:'prj_a',files:[{path:'../outside'}],diff:'none'}),{code:'CONTEXT_BLOCKED'});
    await assert.rejects(f.service.prepare({project_id:'prj_a',files:[],diff:'both'}),{code:'CONTEXT_BLOCKED'});
    await symlink(path.join(f.root,'main.ts'),path.join(f.root,'link.ts'));
    await assert.rejects(f.service.prepare({project_id:'prj_a',files:[{path:'link.ts'}],diff:'none'}),{code:'CONTEXT_BLOCKED'});
    await writeFile(path.join(f.root,'leak.ts'),'const key = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";');
    await assert.rejects(f.service.prepare({project_id:'prj_a',files:[{path:'leak.ts'}],diff:'none'}),{code:'CONTEXT_BLOCKED'});
    await assert.rejects(f.service.prepare({project_id:'prj_a',files:[],diff:'none',notes:'sk-proj-abcdefghijklmnopqrstuvwxyz123456'}),{code:'CONTEXT_BLOCKED'});
    code(()=>f.service.ask({...ask(),question:'sk-proj-abcdefghijklmnopqrstuvwxyz123456'}),'CONTEXT_BLOCKED');
  } finally {await f.cleanup();}
});

test('verified file reader rejects links and files beyond the snapshot limit',async()=>{
  const f=await fixture();try {
    const canonicalRoot=await realpath(f.root);
    const large=path.join(f.root,'large.txt');
    await writeFile(large,Buffer.alloc(2*1024*1024+1,0x41));
    await assert.rejects(readStableFile(path.join(canonicalRoot,'large.txt')),{code:'CONTEXT_TOO_LARGE'});
    await assert.rejects(f.service.prepare({project_id:'prj_a',files:[{path:'large.txt',start_line:1,end_line:1}],diff:'none'}),{code:'CONTEXT_TOO_LARGE'});
    const linked=path.join(f.root,'linked.txt');
    await symlink(path.join(f.root,'main.ts'),linked);
    await assert.rejects(readStableFile(path.join(canonicalRoot,'linked.txt')),{code:'CONTEXT_BLOCKED'});
    const otherDirectory=await mkdtemp(path.join(os.tmpdir(),'cpb-reader-outside-'));
    try {
      await writeFile(path.join(otherDirectory,'outside.txt'),'outside content');
      await symlink(otherDirectory,path.join(f.root,'linked-directory'));
      await assert.rejects(readStableFile(path.join(canonicalRoot,'linked-directory','outside.txt')),{code:'CONTEXT_STALE'});
    } finally {await rm(otherDirectory,{recursive:true,force:true});}
  } finally {await f.cleanup();}
});

test('explicit deleted files are accepted only through their Git diff',async()=>{
  const f=await fixture();try {
    execFileSync('git',['init','-b','main',f.root]);
    await writeFile(path.join(f.root,'removed.ts'),'export const gone = true;\n');
    execFileSync('git',['-C',f.root,'add','removed.ts']);
    execFileSync('git',['-C',f.root,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','fixture']);
    await rm(path.join(f.root,'removed.ts'));
    const unstaged=await f.service.prepare({project_id:'prj_a',files:[{path:'removed.ts'}],diff:'unstaged'}) as any;
    assert.deepEqual(unstaged.manifest,[{path:'removed.ts'}]);
    assert.match(f.store.packet(unstaged.packet_id)!.content,/deleted file mode/);
    await assert.rejects(f.service.prepare({project_id:'prj_a',files:[{path:'removed.ts'}],diff:'none'}),{code:'CONTEXT_BLOCKED'});
    await assert.rejects(f.service.prepare({project_id:'prj_a',files:[{path:'missing.ts'}],diff:'unstaged'}),{code:'CONTEXT_BLOCKED'});
    execFileSync('git',['-C',f.root,'add','-u']);
    const staged=await f.service.prepare({project_id:'prj_a',files:[{path:'removed.ts'}],diff:'staged'}) as any;
    assert.match(f.store.packet(staged.packet_id)!.content,/deleted file mode/);
    await assert.rejects(f.service.prepare({project_id:'prj_a',files:[{path:'removed.ts',start_line:1,end_line:1}],diff:'staged'}),{code:'CONTEXT_BLOCKED'});
  } finally {await f.cleanup();}
});

test('deleted source secrets are blocked by diff scanning',async()=>{
  const f=await fixture();try {
    execFileSync('git',['init','-b','main',f.root]);
    await writeFile(path.join(f.root,'removed.ts'),'const token = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";\n');
    execFileSync('git',['-C',f.root,'add','removed.ts']);
    execFileSync('git',['-C',f.root,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','fixture']);
    await rm(path.join(f.root,'removed.ts'));
    await assert.rejects(f.service.prepare({project_id:'prj_a',files:[{path:'removed.ts'}],diff:'unstaged'}),{code:'CONTEXT_BLOCKED'});
  } finally {await f.cleanup();}
});

test('deduplication, approval, cancellation, and expired result do not resend',async()=>{
  const f=await fixture();try {
    const first=f.service.ask(ask()) as any;
    assert.equal(first.status,'awaiting_approval');
    const stored=f.store.task(first.task_id)!;
    assert.equal(first.payload_sha256,createHash('sha256').update(stored.payload!).digest('hex'));
    assert.equal((f.service.ask(ask()) as any).task_id,first.task_id);
    code(()=>f.service.ask({...ask(),question:'Different'}),'IDEMPOTENCY_CONFLICT');
    code(()=>f.service.approve("prj_a",first.task_id,'wrong'),'APPROVAL_EXPIRED');
    assert.deepEqual(await f.service.cancel('prj_a',first.task_id),{task_id:first.task_id,status:'cancelled',upstream_stop:'not_needed'});
    assert.equal((f.service.ask(ask()) as any).status,'cancelled');
    assert.equal((await f.service.getTask('prj_a',first.task_id) as any).delivery,'not_sent');
  } finally {await f.cleanup();}
});

test('send intent survives uncertain failure; duplicate request never executes again',async()=>{
  let calls=0;
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async(_task:Task,_route,beforeSubmit)=>{calls++;await beforeSubmit();throw new Error('network lost');},reconcile:async()=>null,requestStop:async()=>false};
  const f=await fixture(adapter);try {
    const t=f.service.ask(ask()) as any;f.service.approve("prj_a",t.task_id,t.payload_sha256);
    await new Promise(r=>setTimeout(r,30));
    const state=await f.service.getTask('prj_a',t.task_id) as any;
    assert.equal(state.status,'paused');assert.equal(state.delivery,'maybe_sent');assert.equal(state.pause_reason,'DELIVERY_UNKNOWN');
    assert.equal((f.service.ask(ask()) as any).task_id,t.task_id);
    const resumed=await f.service.resume('prj_a',t.task_id) as any;
    assert.equal(resumed.delivery,'maybe_sent');
    assert.equal(resumed.status,'paused');
    assert.equal(calls,1);
  } finally {await f.cleanup();}
});

test('a returned answer without confirmed user message cannot complete the task',async()=>{
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async(_task,_route,beforeSubmit)=>{
    await beforeSubmit();
    return {text:'unbound answer',conversation_url:'https://chatgpt.com/c/test',route_before:'Pro',route_after:'Pro',association_verified:true,completion_verified:true,warnings:[]};
  },reconcile:async()=>null,requestStop:async()=>false};
  const f=await fixture(adapter);try {
    const t=f.service.ask(ask()) as any;f.service.approve('prj_a',t.task_id,t.payload_sha256);
    await new Promise(r=>setTimeout(r,30));
    const state=await f.service.getTask('prj_a',t.task_id) as any;
    assert.equal(state.status,'paused');assert.equal(state.delivery,'maybe_sent');
    assert.equal(state.pause_reason,'DELIVERY_UNKNOWN');assert.equal(state.answer,undefined);
  } finally {await f.cleanup();}
});

test('completed response stays within the serialized tool limit without changing bytes',async()=>{
  const response='中文🙂\n```ts\nconst x=1;\n```\n'.repeat(1500)+'界'.repeat(13000)+'🙂'.repeat(3000)+'\\\u0001'.repeat(10000);
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async(task,_route,beforeSubmit,confirmed)=>{await beforeSubmit();confirmed('https://chatgpt.com/c/test');return {text:response,conversation_url:'https://chatgpt.com/c/test',route_before:'Pro',route_after:'Pro',association_verified:true,completion_verified:true,warnings:[]};},reconcile:async()=>null,requestStop:async()=>true};
  const f=await fixture(adapter);try {
    const t=f.service.ask(ask()) as any;f.service.approve("prj_a",t.task_id,t.payload_sha256);await new Promise(r=>setTimeout(r,30));
    let cursor: string|undefined;let output='';let pages=0;
    do {const page=await f.service.getTask('prj_a',t.task_id,cursor) as any;assert.equal(page.status,'completed');assert.ok(Buffer.byteLength(page.answer.text,'utf8')<=12288);assert.ok(Buffer.byteLength(JSON.stringify({content:[{type:'text',text:JSON.stringify(page)}],structuredContent:page}))<=30*1024);output+=page.answer.text;cursor=page.answer.next_cursor??undefined;pages++;if(pages>100)throw new Error('pagination loop');}while(cursor);
    assert.equal(output,response);assert.ok(pages>1);
    await assert.rejects(f.service.getTask('prj_a',t.task_id,Buffer.from(JSON.stringify({task:'other',hash:'x',project:'prj_a',offset:1})).toString('base64url')),{code:'INVALID_CURSOR'});
    const hash=createHash('sha256').update(response).digest('hex');
    const splitEmoji=Buffer.from(JSON.stringify({task:t.task_id,hash,project:'prj_a',offset:3})).toString('base64url');
    await assert.rejects(f.service.getTask('prj_a',t.task_id,splitEmoji),{code:'INVALID_CURSOR'});
    await assert.rejects(f.service.getTask('prj_a',t.task_id,123 as unknown as string),{code:'INVALID_CURSOR'});
  } finally {await f.cleanup();}
});

test('oversized reply keeps a genuine replacement character at the truncation boundary',async()=>{
  const limit=2*1024*1024;
  const expected='a'.repeat(limit-3)+'\uFFFD';
  const answer={text:expected+'🙂tail',conversation_url:'https://chatgpt.com/c/large',route_before:'Pro',route_after:'Pro',association_verified:true,completion_verified:true,warnings:[]};
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async(_task,_route,beforeSubmit,confirmed)=>{await beforeSubmit();confirmed(answer.conversation_url);return answer;},reconcile:async()=>answer,requestStop:async()=>false};
  const f=await fixture(adapter);try {
    const task=f.service.ask(ask()) as any;f.service.approve('prj_a',task.task_id,task.payload_sha256);
    const resultQuery=f.store.db.prepare('SELECT text,completeness,warnings FROM results WHERE task_id=?');
    let stored:{text:string;completeness:string;warnings:string}|undefined;
    for(let attempt=0;attempt<100;attempt++) {
      stored=resultQuery.get(task.task_id) as typeof stored;
      if(stored)break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(stored?.text,expected);
    assert.equal(stored?.completeness,'partial');
    assert.deepEqual(JSON.parse(stored!.warnings),['RESPONSE_TRUNCATED']);
    assert.equal(f.store.task(task.task_id)?.status,'paused');
    assert.equal(f.store.task(task.task_id)?.pause_reason,'RESPONSE_PARTIAL');
    assert.equal((await f.service.resume('prj_a',task.task_id) as any).status,'paused');
    stored=resultQuery.get(task.task_id) as typeof stored;
    assert.equal(stored?.text,expected);
    assert.equal(stored?.completeness,'partial');
    assert.deepEqual(JSON.parse(stored!.warnings),['RESPONSE_TRUNCATED']);
  } finally {await f.cleanup();}
});

test('session grant has a bounded send budget and reserves only at send intent',async()=>{
  let sends=0;
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async(_task,_route,beforeSubmit,confirmed)=>{await beforeSubmit();sends++;confirmed('https://chatgpt.com/c/test');return {text:'ok',conversation_url:'https://chatgpt.com/c/test',route_before:'Pro',route_after:'Pro',association_verified:true,completion_verified:true,warnings:[]};},reconcile:async()=>null,requestStop:async()=>true};
  const f=await fixture(adapter);try {
    const grant=f.service.authorizeSession('prj_a',[],1,1) as any;
    const first=f.service.ask(ask('one')) as any;
    assert.equal(first.approval_required,false);
    await new Promise(r=>setTimeout(r,30));
    assert.equal((await f.service.getTask('prj_a',first.task_id) as any).status,'completed');
    assert.equal((f.service.ask(ask('two')) as any).approval_required,true);
    assert.equal((f.store.db.prepare('SELECT remaining FROM grants WHERE id=?').get(grant.grant_id) as any).remaining,0);
    assert.equal(sends,1);
    f.store.cleanup(Date.now()+8*86400000);
    assert.equal((await f.service.getTask('prj_a',first.task_id) as any).error,'RESULT_EXPIRED');
    assert.equal((f.service.ask(ask('one')) as any).task_id,first.task_id);
    assert.equal(sends,1);
  } finally {await f.cleanup();}
});

test('expired context and result retain same-key tombstone without another send',async()=>{
  let sends=0;
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async(_task,_route,beforeSubmit,confirmed)=>{await beforeSubmit();confirmed('https://chatgpt.com/c/expired');sends++;return {text:'original answer',conversation_url:'https://chatgpt.com/c/expired',route_before:'Pro',route_after:'Pro',association_verified:true,completion_verified:true,warnings:[]};},reconcile:async()=>null,requestStop:async()=>false};
  const f=await fixture(adapter);try {
    const packet=await f.service.prepare({project_id:'prj_a',files:[{path:'main.ts'}],diff:'none'}) as any;
    const original=f.service.ask(ask('with-context',packet.packet_id)) as any;
    f.service.approve('prj_a',original.task_id,original.payload_sha256);
    const deadline=Date.now()+3000;
    while((await f.service.getTask('prj_a',original.task_id) as any).status!=='completed'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal((await f.service.getTask('prj_a',original.task_id) as any).status,'completed');
    f.store.cleanup(Date.now()+8*86400000);
    assert.equal(f.store.packet(packet.packet_id),undefined);
    f.store.db.prepare("UPDATE profiles SET route='Other',login_epoch=login_epoch+1 WHERE id='default'").run();
    const repeated=f.service.ask(ask('with-context',packet.packet_id)) as any;
    assert.equal(repeated.task_id,original.task_id);
    assert.equal((await f.service.getTask('prj_a',original.task_id) as any).error,'RESULT_EXPIRED');
    code(()=>f.service.ask({...ask('with-context',packet.packet_id),question:'Changed'}),'IDEMPOTENCY_CONFLICT');
    assert.equal(sends,1);
  } finally {await f.cleanup();}
});

test('revoking a session grant during compose prevents the web send',async()=>{
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve});
  const waiting=new Promise<void>(resolve=>{release=resolve});
  let sends=0;
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async(_task,_route,beforeSubmit)=>{
    entered();await waiting;await beforeSubmit();sends++;throw new Error('should not send');
  },reconcile:async()=>null,requestStop:async()=>false};
  const f=await fixture(adapter);try {
    const grant=f.service.authorizeSession('prj_a',[],1,1) as any;
    const task=f.service.ask(ask()) as any;
    await started;
    assert.deepEqual(f.service.revokeGrant('prj_a',grant.grant_id),{grant_id:grant.grant_id,project_id:'prj_a',revoked:true});
    release();await new Promise(resolve=>setTimeout(resolve,30));
    const state=await f.service.getTask('prj_a',task.task_id) as any;
    assert.equal(state.status,'paused');assert.equal(state.delivery,'not_sent');assert.equal(state.pause_reason,'APPROVAL_EXPIRED');assert.equal(sends,0);
  } finally {release();await f.cleanup();}
});

test('restart changes uncertain running task to paused, never queued',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-restart-'));
  const file=path.join(root,'state.db');
  try {
    let store=new Store(file);
    store.db.prepare('INSERT INTO projects(id,root,identity,created_at) VALUES(?,?,?,?)').run('p',root,rootIdentity(root),Date.now());
    store.db.prepare("INSERT INTO sessions(id,project_id,epoch,profile_id,login_epoch,route) VALUES('s','p',1,'default',1,'Pro')").run();
    store.db.prepare("INSERT INTO tasks(id,project_id,request_key,request_sha256,payload_sha256,payload,session_id,mode,status,phase,delivery,created_at,updated_at) VALUES('t','p','k','h','h','payload','s','ask','running','submit','maybe_sent',1,1)").run();
    store.close();store=new Store(file);
    const task=store.task('t')!;
    assert.equal(task.status,'paused');assert.equal(task.delivery,'maybe_sent');assert.equal(task.pause_reason,'DELIVERY_UNKNOWN');
    store.close();
  } finally {await rm(root,{recursive:true,force:true});}
});

test('abrupt worker exit preserves pre-submit and post-submit ledger states',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-crash-'));
  const file=path.join(root,'state.db');
  try {
    let store=new Store(file);
    store.db.prepare('INSERT INTO projects(id,root,identity,created_at) VALUES(?,?,?,?)').run('p',root,rootIdentity(root),Date.now());
    for(const [id,delivery] of [['before','not_sent'],['intent','maybe_sent'],['observed','confirmed_sent']] as const) {
      store.db.prepare('INSERT INTO sessions(id,project_id,epoch,profile_id,login_epoch,route) VALUES(?,?,1,?,1,?)').run(`s_${id}`,'p','default','Pro');
      store.db.prepare("INSERT INTO tasks(id,project_id,request_key,request_sha256,payload_sha256,payload,session_id,mode,status,phase,delivery,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'ask','queued','preflight',?,1,1)").run(id,'p',id,'h','h','payload',`s_${id}`,delivery);
    }
    store.close();
    const script=`const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');db.prepare("UPDATE tasks SET status='running',phase=CASE WHEN delivery='not_sent' THEN 'compose' ELSE 'wait' END").run();db.exec('COMMIT');process.stdout.write('READY\\n');setInterval(()=>{},1000);`;
    const child=spawn(process.execPath,['-e',script,file],{stdio:['ignore','pipe','pipe']});
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('worker did not reach durable state'));},5000);
      child.stdout.once('data',chunk=>{clearTimeout(timer);assert.match(String(chunk),/READY/);resolve();});
      child.once('error',reject);
      child.once('exit',()=>reject(new Error('worker exited before ready')));
    });
    const stopped=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
    child.kill('SIGKILL');await stopped;
    store=new Store(file);
    assert.deepEqual(['before','intent','observed'].map(id=>store.task(id)?.status),['paused','paused','paused']);
    assert.equal(store.task('before')?.delivery,'not_sent');
    assert.equal(store.task('before')?.pause_reason,'RUNTIME_INTERRUPTED');
    assert.equal(store.task('intent')?.delivery,'maybe_sent');
    assert.equal(store.task('intent')?.pause_reason,'DELIVERY_UNKNOWN');
    assert.equal(store.task('observed')?.delivery,'confirmed_sent');
    assert.equal(store.task('observed')?.pause_reason,'RUNTIME_INTERRUPTED');
    store.close();
  } finally {await rm(root,{recursive:true,force:true});}
});

test('legacy database upgrade preserves task identity and delivery state',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-upgrade-'));
  const file=path.join(root,'state.db');
  try {
    let store=new Store(file);
    store.db.prepare('INSERT INTO projects(id,root,identity,created_at) VALUES(?,?,?,?)').run('p',root,rootIdentity(root),Date.now());
    store.db.prepare("INSERT INTO sessions(id,project_id,epoch,profile_id,login_epoch,route) VALUES('s','p',1,'default',1,'Pro')").run();
    store.db.prepare("INSERT INTO tasks(id,project_id,request_key,request_sha256,payload_sha256,payload,session_id,mode,status,phase,delivery,created_at,updated_at) VALUES('t','p','k','request-hash','payload-hash','payload','s','ask','paused','reconcile','maybe_sent',1,1)").run();
    store.close();
    const legacy=new DatabaseSync(file);
    legacy.exec('ALTER TABLE tasks DROP COLUMN request_sha256; PRAGMA user_version=4;');
    legacy.close();
    store=new Store(file);
    const task=store.task('t')!;
    assert.equal(task.request_sha256,'payload-hash');
    assert.equal(task.delivery,'maybe_sent');
    assert.equal(task.status,'paused');
    assert.equal((store.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,5);
    assert.equal((store.db.prepare('PRAGMA integrity_check').get() as {integrity_check:string}).integrity_check,'ok');
    store.close();
    const backups=(await readdir(root)).filter(name=>name.startsWith('state.db.pre-v4-')&&name.endsWith('.sqlite'));
    assert.equal(backups.length,1);
    const backupPath=path.join(root,backups[0]!);
    if(process.platform!=='win32')assert.equal((await stat(backupPath)).mode&0o777,0o600);
    const backup=new DatabaseSync(backupPath,{readOnly:true});
    assert.equal((backup.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,4);
    assert.equal((backup.prepare('SELECT delivery FROM tasks WHERE id=?').get('t') as {delivery:string}).delivery,'maybe_sent');
    backup.close();
    const restored=path.join(root,'restored.db');
    await copyFile(backupPath,restored);
    const recovered=new Store(restored);
    assert.equal(recovered.task('t')?.delivery,'maybe_sent');
    assert.equal((recovered.db.prepare('PRAGMA integrity_check').get() as {integrity_check:string}).integrity_check,'ok');
    recovered.close();
    const cleanupStore=new Store(file);
    cleanupStore.cleanup(Date.now()+8*86400000);
    cleanupStore.close();
    await assert.rejects(readFile(backupPath),{code:'ENOENT'});
  } finally {await rm(root,{recursive:true,force:true});}
});

test('changed route retains answer but does not report verified completion',async()=>{
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async(_task,_route,beforeSubmit,confirmed)=>{await beforeSubmit();confirmed('https://chatgpt.com/c/test');return {text:'answer to inspect',conversation_url:'https://chatgpt.com/c/test',route_before:'Pro',route_after:'Other',association_verified:true,completion_verified:true,warnings:[]};},reconcile:async()=>null,requestStop:async()=>false};
  const f=await fixture(adapter);try {
    const t=f.service.ask(ask()) as any;f.service.approve("prj_a",t.task_id,t.payload_sha256);await new Promise(r=>setTimeout(r,30));
    const result=await f.service.getTask('prj_a',t.task_id) as any;
    assert.equal(result.status,'paused');assert.equal(result.pause_reason,'ROUTE_CHANGED_AFTER_SEND');
    assert.equal(result.answer.text,'answer to inspect');assert.equal(result.route.ui_selection_verified,false);
  } finally {await f.cleanup();}
});

test('visible non-text reply content remains partial after capture and reconciliation',async()=>{
  const partial={text:'captured text only',conversation_url:'https://chatgpt.com/c/partial',route_before:'Pro',route_after:'Pro',association_verified:true,completion_verified:true,content_complete:false,warnings:['NON_TEXT_CONTENT_NOT_CAPTURED']};
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async(_task,_route,beforeSubmit,confirmed)=>{await beforeSubmit();confirmed(partial.conversation_url);return partial;},reconcile:async()=>partial,requestStop:async()=>false};
  const f=await fixture(adapter);try {
    const task=f.service.ask(ask('partial-media')) as any;
    f.service.approve('prj_a',task.task_id,task.payload_sha256);
    await new Promise(resolve=>setTimeout(resolve,30));
    let result=await f.service.getTask('prj_a',task.task_id) as any;
    assert.equal(result.status,'paused');
    assert.equal(result.pause_reason,'RESPONSE_PARTIAL');
    assert.equal(result.answer.completeness,'partial');
    assert.equal(result.answer.text,partial.text);
    assert.deepEqual(result.warnings,partial.warnings);
    assert.equal((await f.service.resume('prj_a',task.task_id) as any).status,'paused');
    result=await f.service.getTask('prj_a',task.task_id) as any;
    assert.equal(result.answer.completeness,'partial');
    assert.deepEqual(result.warnings,partial.warnings);
  } finally {await f.cleanup();}
});

test('modified selected file pauses before send',async()=>{
  let calls=0;
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async()=>{calls++;throw new Error('should not send');},reconcile:async()=>null,requestStop:async()=>false};
  const f=await fixture(adapter);try {
    const p=await f.service.prepare({project_id:'prj_a',files:[{path:'main.ts'}],diff:'none'}) as any;
    const t=f.service.ask(ask('stale',p.packet_id)) as any;
    await writeFile(path.join(f.root,'main.ts'),'export const answer=43;\n');
    f.service.approve("prj_a",t.task_id,t.payload_sha256);
    let state=await f.service.getTask('prj_a',t.task_id) as any;
    for(let i=0;i<250&&state.status==='queued';i++) {
      await new Promise(r=>setTimeout(r,20));
      state=await f.service.getTask('prj_a',t.task_id) as any;
    }
    assert.equal(state.status,'paused');assert.equal(state.delivery,'not_sent');assert.equal(state.pause_reason,'CONTEXT_STALE');assert.equal(calls,0);
  } finally {await f.cleanup();}
});

test('raw byte changes invalidate a snapshot even when UTF-8 replacement text looks equal',async()=>{
  let calls=0;
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async()=>{calls++;throw new Error('should not send');},reconcile:async()=>null,requestStop:async()=>false};
  const f=await fixture(adapter);try {
    await writeFile(path.join(f.root,'main.ts'),'const marker = "�";\n');
    const packet=await f.service.prepare({project_id:'prj_a',files:[{path:'main.ts'}],diff:'none'}) as any;
    await writeFile(path.join(f.root,'main.ts'),Buffer.concat([Buffer.from('const marker = "'),Buffer.from([0xff]),Buffer.from('";\n')]));
    const task=f.service.ask(ask('byte-change',packet.packet_id)) as any;
    f.service.approve('prj_a',task.task_id,task.payload_sha256);
    let state=await f.service.getTask('prj_a',task.task_id) as any;
    for(let i=0;i<100&&state.status==='queued';i++) {
      await new Promise(r=>setTimeout(r,20));
      state=await f.service.getTask('prj_a',task.task_id) as any;
    }
    assert.equal(state.status,'paused');assert.equal(state.delivery,'not_sent');assert.equal(state.pause_reason,'CONTEXT_STALE');assert.equal(calls,0);
  } finally {await f.cleanup();}
});

test('branch switch invalidates continuation and increments workspace epoch',async()=>{
  const f=await fixture();try {
    execFileSync('git',['init','-b','main',f.root]);
    f.store.db.prepare("UPDATE projects SET branch='main' WHERE id='prj_a'").run();
    f.store.db.prepare("INSERT INTO sessions(id,project_id,epoch,profile_id,login_epoch,route,state) VALUES('ses_old','prj_a',1,'default',1,'Pro','ready')").run();
    execFileSync('git',['-C',f.root,'branch','-m','next']);
    code(()=>f.service.ask({...ask(),session:{kind:'continue',session_id:'ses_old'}}),'PROJECT_MISMATCH');
    assert.equal(f.store.project('prj_a')?.epoch,2);
  } finally {await f.cleanup();}
});

test('replacing a project directory at the same path changes its workspace identity',async()=>{
  const f=await fixture();
  const displaced=`${f.root}-old`;
  try {
    const old=f.service.ask(ask('old-directory')) as any;
    const prior=f.store.project('prj_a')!;
    await rename(f.root,displaced);
    await mkdir(f.root);
    await writeFile(path.join(f.root,'main.ts'),'export const answer = 42;\n');
    const fresh=f.service.ask(ask('new-directory')) as any;
    const current=f.store.project('prj_a')!;
    assert.equal(current.epoch,prior.epoch+1);
    assert.notEqual(current.identity,prior.identity);
    assert.equal(f.store.task(old.task_id)?.status,'paused');
    assert.equal(f.store.task(old.task_id)?.pause_reason,'WORKSPACE_CHANGED');
    assert.equal(fresh.status,'awaiting_approval');
    assert.notEqual(fresh.session_id,old.session_id);
  } finally {await f.cleanup();await rm(displaced,{recursive:true,force:true});}
});

test('replacing the directory during compose blocks submission even when file bytes match',async()=>{
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve});
  const waiting=new Promise<void>(resolve=>{release=resolve});
  let sends=0;
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async(_task,_route,beforeSubmit)=>{
    entered();await waiting;await beforeSubmit();sends++;throw new Error('unexpected send');
  },reconcile:async()=>null,requestStop:async()=>false};
  const f=await fixture(adapter);
  const displaced=`${f.root}-old`;
  try {
    const packet=await f.service.prepare({project_id:'prj_a',files:[{path:'main.ts'}],diff:'none'}) as any;
    const task=f.service.ask(ask('replacement-during-compose',packet.packet_id)) as any;
    f.service.approve('prj_a',task.task_id,task.payload_sha256);
    await started;
    await rename(f.root,displaced);
    await mkdir(f.root);
    await writeFile(path.join(f.root,'main.ts'),'export const answer = 42;\n');
    release();
    const deadline=Date.now()+3000;
    while((await f.service.getTask('prj_a',task.task_id) as any).status==='running'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    const state=await f.service.getTask('prj_a',task.task_id) as any;
    assert.equal(state.status,'paused');
    assert.equal(state.delivery,'not_sent');
    assert.equal(state.pause_reason,'WORKSPACE_CHANGED');
    assert.equal(sends,0);
  } finally {release?.();await f.cleanup();await rm(displaced,{recursive:true,force:true});}
});

test('cancel during compose blocks send intent and leaves task cancelled',async()=>{
  let release!:()=>void;
  let entered!:()=>void;
  const waiting=new Promise<void>(resolve=>{release=resolve});
  const started=new Promise<void>(resolve=>{entered=resolve});
  let sends=0;
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async(_task,_route,beforeSubmit)=>{entered();await waiting;await beforeSubmit();sends++;throw new Error('unexpected send');},reconcile:async()=>null,requestStop:async()=>false};
  const f=await fixture(adapter);try {
    const t=f.service.ask(ask()) as any;f.service.approve("prj_a",t.task_id,t.payload_sha256);
    await started;
    const cancellation=await f.service.cancel('prj_a',t.task_id) as any;
    assert.equal(cancellation.status,'cancelled');assert.equal(cancellation.upstream_stop,'not_needed');
    release();await new Promise(r=>setTimeout(r,30));
    const final=await f.service.getTask('prj_a',t.task_id) as any;
    assert.equal(final.status,'cancelled');assert.equal(final.delivery,'not_sent');assert.equal(sends,0);
  } finally {await f.cleanup();}
});

test('cancel passes the confirmed conversation to the stop adapter',async()=>{
  const url='https://chatgpt.com/c/cancel-target';
  let entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  let stoppedUrl:string|null|undefined;
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async(_task,_route,beforeSubmit,confirmed,signal)=>{
    await beforeSubmit();confirmed(url);entered();
    await new Promise<void>((_resolve,reject)=>{
      if(signal.aborted)return reject(new BridgeError('CANCEL_UNCONFIRMED','stopped'));
      signal.addEventListener('abort',()=>reject(new BridgeError('CANCEL_UNCONFIRMED','stopped')),{once:true});
    });
    throw new Error('unexpected completion');
  },reconcile:async()=>null,requestStop:async(task)=>{stoppedUrl=task.conversation_url;return true;}};
  const f=await fixture(adapter);try {
    const task=f.service.ask(ask()) as any;f.service.approve('prj_a',task.task_id,task.payload_sha256);
    await started;
    const result=await f.service.cancel('prj_a',task.task_id) as any;
    assert.equal(stoppedUrl,url);
    assert.equal(result.upstream_stop,'confirmed');
    assert.equal(result.status,'paused');
  } finally {await f.cleanup();}
});

test('route change after approval pauses original task before browser action',async()=>{
  let calls=0;
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async()=>{calls++;throw new Error('must not execute');},reconcile:async()=>null,requestStop:async()=>false};
  const f=await fixture(adapter);try {
    const t=f.service.ask(ask()) as any;
    f.store.db.prepare("UPDATE profiles SET route='Other' WHERE id='default'").run();
    f.service.approve("prj_a",t.task_id,t.payload_sha256);await new Promise(r=>setTimeout(r,30));
    const final=await f.service.getTask('prj_a',t.task_id) as any;
    assert.equal(final.status,'paused');assert.equal(final.delivery,'not_sent');assert.equal(final.pause_reason,'ROUTE_UNAVAILABLE');assert.equal(calls,0);
  } finally {await f.cleanup();}
});

test('unknown delivery blocks queue until explicit abandonment without resending original',async()=>{
  let calls=0;
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async(_task,_route,beforeSubmit,confirmed)=>{
    calls++;await beforeSubmit();
    if(calls===1)throw new Error('lost after click');
    confirmed('https://chatgpt.com/c/second');
    return {text:'second answer',conversation_url:'https://chatgpt.com/c/second',route_before:'Pro',route_after:'Pro',association_verified:true,completion_verified:true,warnings:[]};
  },reconcile:async()=>null,requestStop:async()=>false};
  const f=await fixture(adapter);try {
    const first=f.service.ask(ask('first')) as any;f.service.approve("prj_a",first.task_id,first.payload_sha256);
    await new Promise(r=>setTimeout(r,30));
    assert.equal((await f.service.getTask('prj_a',first.task_id) as any).delivery,'maybe_sent');
    const second=f.service.ask(ask('second')) as any;f.service.approve("prj_a",second.task_id,second.payload_sha256);
    await new Promise(r=>setTimeout(r,30));
    assert.equal((await f.service.getTask('prj_a',second.task_id) as any).status,'queued');assert.equal(calls,1);
    const abandoned=f.service.abandon('prj_a',first.task_id);
    assert.equal(abandoned.status,'failed');assert.equal(abandoned.delivery,'maybe_sent');
    assert.equal((await f.service.cancel('prj_a',first.task_id) as any).status,'already_failed');
    assert.equal(f.store.task(first.task_id)?.pause_reason,'USER_ABANDONED');
    await new Promise(r=>setTimeout(r,30));
    assert.equal((await f.service.getTask('prj_a',second.task_id) as any).status,'completed');assert.equal(calls,2);
    assert.equal((f.service.ask(ask('first')) as any).task_id,first.task_id);
  } finally {await f.cleanup();}
});

test('two project clients share one browser execution slot',async()=>{
  let entered!:()=>void,release!:()=>void;
  const firstEntered=new Promise<void>(resolve=>{entered=resolve});
  const firstRelease=new Promise<void>(resolve=>{release=resolve});
  let active=0,maxActive=0;
  const order:string[]=[];
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async(task,_route,beforeSubmit,confirmed)=>{
    active++;maxActive=Math.max(maxActive,active);order.push(task.project_id);
    const url=task.project_id==='prj_a'?'https://chatgpt.com/c/alpha':'https://chatgpt.com/c/beta';
    if(task.project_id==='prj_a'){entered();await firstRelease;}
    await beforeSubmit();confirmed(url);
    active--;
    return {text:'done',conversation_url:url,route_before:'Pro',route_after:'Pro',association_verified:true,completion_verified:true,warnings:[]};
  },reconcile:async()=>null,requestStop:async()=>false};
  const f=await fixture(adapter);
  const secondRoot=await mkdtemp(path.join(os.tmpdir(),'cpb-second-'));
  try {
    f.store.db.prepare('INSERT INTO projects(id,root,identity,created_at) VALUES(?,?,?,?)').run('prj_b',secondRoot,rootIdentity(secondRoot),Date.now());
    const secondService=new BridgeService(f.store,adapter,'prj_b');
    const first=f.service.ask(ask('first')) as any;f.service.approve('prj_a',first.task_id,first.payload_sha256);
    await firstEntered;
    const second=secondService.ask({project_id:'prj_b',request_key:'second',question:'Review another project',mode:'review',session:{kind:'new'}}) as any;
    secondService.approve('prj_b',second.task_id,second.payload_sha256);
    assert.equal((await secondService.getTask('prj_b',second.task_id) as any).status,'queued');
    assert.deepEqual(order,['prj_a']);
    release();await new Promise(r=>setTimeout(r,30));
    assert.equal((await secondService.getTask('prj_b',second.task_id) as any).status,'completed');
    assert.equal(maxActive,1);assert.deepEqual(order,['prj_a','prj_b']);
  } finally {release();await f.cleanup();await rm(secondRoot,{recursive:true,force:true});}
});

test('approval is bound to the caller project',async()=>{
  const f=await fixture();try {
    const other=await mkdtemp(path.join(os.tmpdir(),'cpb-other-'));
    try {
      f.store.db.prepare('INSERT INTO projects(id,root,identity,created_at) VALUES(?,?,?,?)').run('prj_b',other,rootIdentity(other),Date.now());
      const task=f.service.ask(ask()) as any;
      const second=new BridgeService(f.store,null,'prj_b');
      code(()=>second.approve('prj_b',task.task_id,task.payload_sha256),'PROJECT_MISMATCH');
      assert.equal(f.store.task(task.task_id)?.status,'awaiting_approval');
    } finally {await rm(other,{recursive:true,force:true});}
  } finally {await f.cleanup();}
});

test('confirmed sent generation keeps global queue paused until explicit abandonment',async()=>{
  let calls=0;
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async(_task,_route,beforeSubmit,confirmed)=>{
    calls++;await beforeSubmit();confirmed(calls===1?'https://chatgpt.com/c/test':'https://chatgpt.com/c/second');
    if(calls===1)throw new Error('generation interrupted');
    return {text:'done',conversation_url:'https://chatgpt.com/c/second',route_before:'Pro',route_after:'Pro',association_verified:true,completion_verified:true,warnings:[]};
  },reconcile:async()=>null,requestStop:async()=>false};
  const f=await fixture(adapter);try {
    const first=f.service.ask(ask('first')) as any;f.service.approve('prj_a',first.task_id,first.payload_sha256);
    await new Promise(r=>setTimeout(r,30));
    assert.equal((await f.service.getTask('prj_a',first.task_id) as any).delivery,'confirmed_sent');
    f.store.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(Date.now()-31*86400000,first.task_id);
    f.store.cleanup();
    assert.equal(f.store.task(first.task_id)?.status,'failed');
    assert.equal(f.store.task(first.task_id)?.delivery,'confirmed_sent');
    assert.equal(f.store.task(first.task_id)?.payload,null);
    f.store.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(Date.now()-31*86400000,first.task_id);
    f.store.cleanup();
    assert.equal(f.store.task(first.task_id)?.delivery,'confirmed_sent');
    const second=f.service.ask(ask('second')) as any;f.service.approve('prj_a',second.task_id,second.payload_sha256);
    await new Promise(r=>setTimeout(r,30));
    assert.equal((await f.service.getTask('prj_a',second.task_id) as any).status,'queued');assert.equal(calls,1);
    f.service.abandon('prj_a',first.task_id);
    await new Promise(r=>setTimeout(r,30));
    assert.equal((await f.service.getTask('prj_a',second.task_id) as any).status,'completed');assert.equal(calls,2);
    f.store.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(Date.now()-31*86400000,first.task_id);
    f.store.cleanup();
    assert.equal(f.store.task(first.task_id),undefined);
  } finally {await f.cleanup();}
});

test('reconciliation refuses a changed account or route before opening the browser',async()=>{
  let reconciles=0;
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async(_task,_route,beforeSubmit,confirmed)=>{await beforeSubmit();confirmed('https://chatgpt.com/c/test');throw new Error('connection lost');},reconcile:async()=>{reconciles++;return null;},requestStop:async()=>false};
  const f=await fixture(adapter);try {
    const t=f.service.ask(ask()) as any;f.service.approve('prj_a',t.task_id,t.payload_sha256);
    await new Promise(r=>setTimeout(r,30));
    f.store.db.prepare("UPDATE profiles SET login_epoch=login_epoch+1 WHERE id='default'").run();
    await assert.rejects(f.service.resume('prj_a',t.task_id),{code:'PROJECT_MISMATCH'});
    assert.equal(reconciles,0);
    assert.equal((await f.service.getTask('prj_a',t.task_id) as any).status,'paused');
  } finally {await f.cleanup();}
});

test('successful reconciliation releases the global queue without resending the original',async()=>{
  let calls=0;
  const answer={text:'recovered',conversation_url:'https://chatgpt.com/c/test',route_before:'Pro',route_after:'Pro',association_verified:true,completion_verified:true,warnings:[]};
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async(_task,_route,beforeSubmit,confirmed)=>{
    calls++;await beforeSubmit();confirmed(calls===1?answer.conversation_url:'https://chatgpt.com/c/second');
    if(calls===1)throw new Error('connection lost');
    return {...answer,text:'second answer',conversation_url:'https://chatgpt.com/c/second'};
  },reconcile:async()=>answer,requestStop:async()=>false};
  const f=await fixture(adapter);try {
    const first=f.service.ask(ask('first')) as any;f.service.approve('prj_a',first.task_id,first.payload_sha256);
    await new Promise(r=>setTimeout(r,30));
    const second=f.service.ask(ask('second')) as any;f.service.approve('prj_a',second.task_id,second.payload_sha256);
    assert.equal((await f.service.getTask('prj_a',second.task_id) as any).status,'queued');
    const recovered=await f.service.resume('prj_a',first.task_id) as any;
    assert.equal(recovered.status,'completed');
    await new Promise(r=>setTimeout(r,30));
    assert.equal((await f.service.getTask('prj_a',second.task_id) as any).status,'completed');
    assert.equal(calls,2);
    const followup=f.service.ask({...ask('followup'),session:{kind:'continue',session_id:first.session_id}}) as any;
    assert.equal(followup.status,'awaiting_approval');assert.equal(followup.session_id,first.session_id);
  } finally {await f.cleanup();}
});

test('browser observation timeout preserves the original send and releases the next task',async()=>{
  const attempts:string[]=[];
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async(task,_route,beforeSubmit,confirmed)=>{
    attempts.push(task.id);await beforeSubmit();
    if(attempts.length===1)throw new BridgeError('OBSERVATION_TIMEOUT','Still thinking');
    confirmed('https://chatgpt.com/c/second');
    return {text:'Second answer',conversation_url:'https://chatgpt.com/c/second',route_before:'Pro',route_after:'Pro',association_verified:true,completion_verified:true,warnings:[]};
  },reconcile:async()=>null,requestStop:async()=>false};
  const f=await fixture(adapter);try {
    const first=f.service.ask(ask('stalled')) as any;f.service.approve('prj_a',first.task_id,first.payload_sha256);
    const second=f.service.ask(ask('next')) as any;f.service.approve('prj_a',second.task_id,second.payload_sha256);
    await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(f.store.task(first.task_id)?.pause_reason,'OBSERVATION_TIMEOUT');
    assert.equal(f.store.task(first.task_id)?.delivery,'maybe_sent');
    assert.equal(f.store.task(second.task_id)?.status,'completed');
    assert.deepEqual(attempts,[first.task_id,second.task_id]);
    assert.equal(f.service.ask(ask('stalled')).task_id,first.task_id);
  } finally {await f.cleanup();}
});

test('reconciliation rejects a reply from a different conversation',async()=>{
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async(_task,_route,beforeSubmit,confirmed)=>{await beforeSubmit();confirmed('https://chatgpt.com/c/original');throw new Error('connection lost');},reconcile:async()=>({text:'wrong conversation',conversation_url:'https://chatgpt.com/c/other',route_before:'Pro',route_after:'Pro',association_verified:true,completion_verified:true,warnings:[]}),requestStop:async()=>false};
  const f=await fixture(adapter);try {
    const task=f.service.ask(ask()) as any;f.service.approve('prj_a',task.task_id,task.payload_sha256);
    await new Promise(resolve=>setTimeout(resolve,30));
    code(()=>f.service.bindConversationCandidate('prj_a',task.task_id,'https://chatgpt.com/c/other'),'PROJECT_MISMATCH');
    await assert.rejects(f.service.resume('prj_a',task.task_id),{code:'RESPONSE_UNVERIFIABLE'});
    assert.equal((await f.service.getTask('prj_a',task.task_id) as any).status,'paused');
    assert.equal((f.store.db.prepare('SELECT state FROM sessions WHERE id=?').get(task.session_id) as {state:string}).state,'reserved');
  } finally {await f.cleanup();}
});

test('explicit candidate URL recovers an unknown first send without resending',async()=>{
  let sends=0,reconciles=0;
  const url='https://chatgpt.com/c/confirmed-first';
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async(_task,_route,beforeSubmit)=>{await beforeSubmit();sends++;throw new Error('lost before conversation URL');},reconcile:async(task)=>{reconciles++;assert.equal(task.conversation_url,url);return {text:'recovered answer',conversation_url:url,route_before:'Pro',route_after:'Pro',association_verified:true,completion_verified:true,warnings:[]};},requestStop:async()=>false};
  const f=await fixture(adapter);try {
    const task=f.service.ask(ask()) as any;f.service.approve('prj_a',task.task_id,task.payload_sha256);
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal((await f.service.getTask('prj_a',task.task_id) as any).delivery,'maybe_sent');
    for(const invalid of ['https://chatgpt.com.evil.test/c/one','http://chatgpt.com/c/one','https://chatgpt.com/c/one?source=other'])code(()=>f.service.bindConversationCandidate('prj_a',task.task_id,invalid),'PROJECT_MISMATCH');
    const bound=f.service.bindConversationCandidate('prj_a',task.task_id,url);
    assert.equal(bound.verified,false);
    assert.equal((f.store.db.prepare('SELECT state FROM sessions WHERE id=?').get(task.session_id) as {state:string}).state,'candidate');
    assert.equal((await f.service.resume('prj_a',task.task_id) as any).status,'completed');
    assert.equal(sends,1);assert.equal(reconciles,1);
    const followup=f.service.ask({...ask('next'),session:{kind:'continue',session_id:task.session_id}}) as any;
    assert.equal(followup.status,'awaiting_approval');
  } finally {await f.cleanup();}
});

test('initial capture rejects a conversation switch after send confirmation',async()=>{
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async(_task,_route,beforeSubmit,confirmed)=>{await beforeSubmit();confirmed('https://chatgpt.com/c/original');return {text:'other answer',conversation_url:'https://chatgpt.com/c/other',route_before:'Pro',route_after:'Pro',association_verified:true,completion_verified:true,warnings:[]};},reconcile:async()=>null,requestStop:async()=>false};
  const f=await fixture(adapter);try {
    const task=f.service.ask(ask()) as any;f.service.approve('prj_a',task.task_id,task.payload_sha256);
    await new Promise(resolve=>setTimeout(resolve,30));
    const state=await f.service.getTask('prj_a',task.task_id) as any;
    assert.equal(state.status,'paused');assert.equal(state.delivery,'confirmed_sent');assert.equal(state.pause_reason,'RESPONSE_UNVERIFIABLE');assert.equal(state.answer,undefined);
  } finally {await f.cleanup();}
});

test('expiry keeps an unknown delivery blocked until the user explicitly abandons it',async()=>{
  let calls=0;
  const adapter:BrowserAdapter={inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),execute:async(_task,_route,beforeSubmit)=>{calls++;await beforeSubmit();throw new Error('unknown delivery');},reconcile:async()=>null,requestStop:async()=>false};
  const f=await fixture(adapter);try {
    const first=f.service.ask(ask('first')) as any;f.service.approve('prj_a',first.task_id,first.payload_sha256);
    await new Promise(r=>setTimeout(r,30));
    f.store.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(Date.now()-25*3600000,first.task_id);
    f.store.cleanup();
    assert.equal(f.store.task(first.task_id)?.status,'failed');
    assert.equal(f.store.task(first.task_id)?.delivery,'maybe_sent');
    f.store.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(Date.now()-31*86400000,first.task_id);
    f.store.cleanup();
    assert.equal(f.store.task(first.task_id)?.delivery,'maybe_sent');
    assert.equal((f.service.ask(ask('first')) as any).task_id,first.task_id);
    const second=f.service.ask(ask('second')) as any;f.service.approve('prj_a',second.task_id,second.payload_sha256);
    await new Promise(r=>setTimeout(r,30));
    assert.equal((await f.service.getTask('prj_a',second.task_id) as any).status,'queued');assert.equal(calls,1);
  } finally {await f.cleanup();}
});
