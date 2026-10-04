import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../src/state/db.js';
import { rootIdentity } from '../../src/state/project.js';
import { BridgeService } from '../../src/runtime/service.js';
import { AgentExecutor } from '../../src/runtime/agent.js';

test('agent browser ledger keeps exact approvals, conversation binding and continuation',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-agent-'));
  const store=new Store(':memory:');
  try {
    await writeFile(path.join(root,'sample.ts'),'export const answer = 42;\n');
    store.db.prepare('INSERT INTO projects(id,root,identity,created_at) VALUES(?,?,?,?)').run('project',root,rootIdentity(root),Date.now());
    store.db.prepare("INSERT INTO profiles(id,route) VALUES('default',NULL)").run();
    const service=new BridgeService(store,null,'project'),agent=new AgentExecutor(store);
    assert.equal(agent.bindRoute('6 Pro','Test Person Pro').account_bound,true);
    service.authorizeSession('project',[],60,2);
    const first=service.ask({project_id:'project',request_key:'first',question:'First question',mode:'ask',session:{kind:'new'}});
    assert.equal(first.status,'queued');
    await assert.rejects(agent.claim('project','6 Pro','Another Person Pro'),{code:'ROUTE_UNAVAILABLE'});
    const claim=await agent.claim('project','6 Pro','Test Person Pro');
    assert.ok(claim);
    assert.match(claim.payload,/First question/);
    assert.equal(claim.target_url,'https://chatgpt.com/');
    assert.equal(await agent.claim('project','6 Pro','Test Person Pro'),null);
    await assert.rejects(agent.sendIntent(first.task_id,'project','wrong hash','6 Pro','Test Person Pro'),{code:'APPROVAL_EXPIRED'});
    await agent.sendIntent(first.task_id,'project',first.payload_sha256,'6 Pro','Test Person Pro');
    assert.equal(store.task(first.task_id)?.delivery,'maybe_sent');
    const url='https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc';
    assert.throws(()=>agent.confirmSent(first.task_id,'project',url,'unrelated message','6 Pro','Test Person Pro'),{code:'DELIVERY_UNKNOWN'});
    agent.confirmSent(first.task_id,'project',url,claim.marker+' First question','6 Pro','Test Person Pro');
    assert.throws(()=>agent.complete(first.task_id,'project',{url:'https://chatgpt.com/c/other',text:'Answer',route:'6 Pro',account_label:'Test Person Pro',association_verified:true,completion_verified:true,content_complete:true,warnings:[]}),{code:'RESPONSE_UNVERIFIABLE'});
    agent.complete(first.task_id,'project',{url,text:'Answer one',route:'6 Pro',account_label:'Test Person Pro',association_verified:true,completion_verified:true,content_complete:true,warnings:[]});
    assert.equal((await service.getTask('project',first.task_id) as any).answer.text,'Answer one');
    const second=service.ask({project_id:'project',request_key:'second',question:'Follow up',mode:'review',session:{kind:'continue',session_id:first.session_id}});
    const follow=await agent.claim('project','6 Pro','Test Person Pro');
    assert.equal(follow?.task_id,second.task_id);
    assert.equal(follow?.target_url,url);
    await agent.sendIntent(second.task_id,'project',second.payload_sha256,'6 Pro','Test Person Pro');
    agent.confirmSent(second.task_id,'project',url,follow!.marker+' Follow up','6 Pro','Test Person Pro');
    agent.complete(second.task_id,'project',{url,text:'Answer two',route:'6 Pro',account_label:'Test Person Pro',association_verified:true,completion_verified:true,content_complete:true,warnings:[]});
    assert.equal((await service.getTask('project',second.task_id) as any).answer.text,'Answer two');
    assert.equal(service.ask({project_id:'project',request_key:'second',question:'Follow up',mode:'review',session:{kind:'continue',session_id:first.session_id}}).task_id,second.task_id);
  } finally {store.close();await rm(root,{recursive:true,force:true});}
});

test('agent browser account change and uncertain send never auto-resend',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-agent-'));
  const store=new Store(':memory:');
  try {
    store.db.prepare('INSERT INTO projects(id,root,identity,created_at) VALUES(?,?,?,?)').run('project',root,rootIdentity(root),Date.now());
    store.db.prepare("INSERT INTO profiles(id,route) VALUES('default',NULL)").run();
    const service=new BridgeService(store,null,'project'),agent=new AgentExecutor(store);
    agent.bindRoute('6 Pro','First Account Pro');
    service.authorizeSession('project',[],60,1);
    const task=service.ask({project_id:'project',request_key:'uncertain',question:'Question',mode:'ask',session:{kind:'new'}});
    await agent.claim('project','6 Pro','First Account Pro');
    await assert.rejects(agent.sendIntent(task.task_id,'project',task.payload_sha256,'6 Pro','Different Account Pro'),{code:'ROUTE_UNAVAILABLE'});
    await agent.sendIntent(task.task_id,'project',task.payload_sha256,'6 Pro','First Account Pro');
    agent.pause(task.task_id,'project','CAPTCHA_REQUIRED');
    assert.equal(store.task(task.task_id)?.delivery,'maybe_sent');
    assert.equal(await agent.claim('project','6 Pro','First Account Pro'),null);
    assert.equal(service.ask({project_id:'project',request_key:'uncertain',question:'Question',mode:'ask',session:{kind:'new'}}).task_id,task.task_id);
    const recoveredUrl='https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    agent.confirmSent(task.task_id,'project',recoveredUrl,`[CPB request: ${task.task_id}] Question`,'6 Pro','First Account Pro');
    assert.equal(store.task(task.task_id)?.delivery,'confirmed_sent');
    agent.pause(task.task_id,'project','AGENT_INTERRUPTED');
    agent.complete(task.task_id,'project',{url:recoveredUrl,text:'Recovered answer',route:'6 Pro',account_label:'First Account Pro',association_verified:true,completion_verified:true,content_complete:true,warnings:[]});
    assert.equal(store.task(task.task_id)?.status,'completed');
  } finally {store.close();await rm(root,{recursive:true,force:true});}
});

test('different visible account is blocked before rebinding unless explicitly authorized',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-agent-account-'));
  const store=new Store(':memory:');
  try {
    store.db.prepare('INSERT INTO projects(id,root,identity,created_at) VALUES(?,?,?,?)').run('project',root,rootIdentity(root),Date.now());
    store.db.prepare("INSERT INTO profiles(id,route) VALUES('default',NULL)").run();
    const service=new BridgeService(store,null,'project'),agent=new AgentExecutor(store);
    assert.throws(()=>agent.bindRoute('6 Pro',''),{code:'ROUTE_UNVERIFIABLE'});
    agent.bindRoute('6 Pro','First Account Pro');
    const pending=service.ask({project_id:'project',request_key:'first-account',question:'Question',mode:'ask',auto_text_opt_in:true,session:{kind:'new'}});
    assert.equal(pending.status,'queued');
    const oldGrant=store.db.prepare('SELECT remaining FROM grants WHERE task_id=?').get(pending.task_id) as {remaining:number};
    assert.equal(oldGrant.remaining,1);
    const priorEpoch=(store.db.prepare("SELECT login_epoch FROM profiles WHERE id='default'").get() as {login_epoch:number}).login_epoch;
    assert.throws(()=>agent.bindRoute('High','Other Account Plus'),{code:'ACCOUNT_MISMATCH'});
    assert.equal(store.task(pending.task_id)?.status,'queued');
    assert.equal((store.db.prepare("SELECT login_epoch FROM profiles WHERE id='default'").get() as {login_epoch:number}).login_epoch,priorEpoch);
    assert.equal((store.db.prepare('SELECT remaining FROM grants WHERE task_id=?').get(pending.task_id) as {remaining:number}).remaining,1);
    agent.bindRoute('High','Other Account Plus',true);
    assert.equal(store.task(pending.task_id)?.status,'paused');
    assert.equal(store.task(pending.task_id)?.pause_reason,'ROUTE_UNAVAILABLE');
    assert.equal((store.db.prepare('SELECT remaining FROM grants WHERE task_id=?').get(pending.task_id) as {remaining:number}).remaining,0);
    const next=service.ask({project_id:'project',request_key:'other-account',question:'New question',mode:'ask',auto_text_opt_in:true,session:{kind:'new'}});
    assert.equal(next.status,'queued');
    assert.equal((await agent.claim('project','High','Other Account Plus'))?.task_id,next.task_id);
  } finally {store.close();await rm(root,{recursive:true,force:true});}
});

test('Plus High is accepted as a distinct verified web route, while Instant is not used for deep analysis',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-agent-high-'));
  const store=new Store(':memory:');
  try {
    store.db.prepare('INSERT INTO projects(id,root,identity,created_at) VALUES(?,?,?,?)').run('project',root,rootIdentity(root),Date.now());
    store.db.prepare("INSERT INTO profiles(id,route) VALUES('default',NULL)").run();
    const service=new BridgeService(store,null,'project'),agent=new AgentExecutor(store);
    assert.throws(()=>agent.bindRoute('Instant','Plus Account'),{code:'ROUTE_UNVERIFIABLE'});
    agent.bindRoute('High','Plus Account');
    service.authorizeSession('project',[],60,1);
    const task=service.ask({project_id:'project',request_key:'plus-high',question:'Compare the plans',mode:'plan',session:{kind:'new'}});
    const claim=await agent.claim('project','High','Plus Account');
    assert.equal(claim?.task_id,task.task_id);
    await assert.rejects(agent.sendIntent(task.task_id,'project',task.payload_sha256,'6 Pro','Plus Account'),{code:'ROUTE_UNAVAILABLE'});
    await agent.sendIntent(task.task_id,'project',task.payload_sha256,'High','Plus Account');
    const url='https://chatgpt.com/c/22222222-2222-2222-2222-222222222222';
    agent.confirmSent(task.task_id,'project',url,claim!.marker+' Compare the plans','High','Plus Account');
    agent.complete(task.task_id,'project',{url,text:'High analysis',route:'High',account_label:'Plus Account',association_verified:true,completion_verified:true,content_complete:true,warnings:[]});
    const result=await service.getTask('project',task.task_id) as unknown as {status:string;route:{requested_display:string;selected_before:string;selected_after:string;ui_selection_verified:boolean;backend_model_verified:boolean}};
    assert.equal(result.status,'completed');
    assert.deepEqual(result.route,{requested_display:'High',selected_before:'High',selected_after:'High',ui_selection_verified:true,backend_model_verified:false});
  } finally {store.close();await rm(root,{recursive:true,force:true});}
});

test('a newly created task uses verified 极高 when Pro becomes unavailable before ask',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-agent-extreme-high-'));
  const store=new Store(':memory:');
  try {
    store.db.prepare('INSERT INTO projects(id,root,identity,created_at) VALUES(?,?,?,?)').run('project',root,rootIdentity(root),Date.now());
    store.db.prepare("INSERT INTO profiles(id,route) VALUES('default',NULL)").run();
    const service=new BridgeService(store,null,'project'),agent=new AgentExecutor(store);
    agent.bindRoute('6 Pro','Test Account Pro');
    agent.bindRoute('极高','Test Account Pro');
    const task=service.ask({project_id:'project',request_key:'extreme-high',question:'Compare the plans',mode:'plan',auto_text_opt_in:true,session:{kind:'new'}});
    assert.equal(task.status,'queued');
    const claim=await agent.claim('project','极高','Test Account Pro');
    assert.equal(claim?.task_id,task.task_id);
    await assert.rejects(agent.sendIntent(task.task_id,'project',task.payload_sha256,'6 Pro','Test Account Pro'),{code:'ROUTE_UNAVAILABLE'});
    await agent.sendIntent(task.task_id,'project',task.payload_sha256,'极高','Test Account Pro');
    const url='https://chatgpt.com/c/33333333-3333-3333-3333-333333333333';
    agent.confirmSent(task.task_id,'project',url,claim!.marker+' Compare the plans','极高','Test Account Pro');
    agent.complete(task.task_id,'project',{url,text:'Extreme high analysis',route:'极高',account_label:'Test Account Pro',association_verified:true,completion_verified:true,content_complete:true,warnings:[]});
    const result=await service.getTask('project',task.task_id) as unknown as {status:string;route:{requested_display:string;selected_before:string;selected_after:string}};
    assert.equal(result.status,'completed');
    assert.equal(result.route.requested_display,'极高');
    assert.equal(result.route.selected_before,'极高');
    assert.equal(result.route.selected_after,'极高');
  } finally {store.close();await rm(root,{recursive:true,force:true});}
});

test('observed Pro timeout preserves the old send and lets a new question use the queue',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-agent-'));
  const store=new Store(':memory:');
  try {
    store.db.prepare('INSERT INTO projects(id,root,identity,created_at) VALUES(?,?,?,?)').run('project',root,rootIdentity(root),Date.now());
    store.db.prepare("INSERT INTO profiles(id,route) VALUES('default',NULL)").run();
    const service=new BridgeService(store,null,'project'),agent=new AgentExecutor(store);
    agent.bindRoute('6 Pro','Test Person Pro');
    service.authorizeSession('project',[],60,2);
    const first=service.ask({project_id:'project',request_key:'stalled',question:'Question one',mode:'ask',session:{kind:'new'}});
    const second=service.ask({project_id:'project',request_key:'next',question:'Question two',mode:'ask',session:{kind:'new'}});
    const claim=await agent.claim('project','6 Pro','Test Person Pro');
    assert.equal(claim?.task_id,first.task_id);
    await agent.sendIntent(first.task_id,'project',first.payload_sha256,'6 Pro','Test Person Pro');
    assert.throws(()=>agent.pause(first.task_id,'project','OBSERVATION_TIMEOUT',claim!.marker),{code:'INVALID_INPUT'});
    store.db.prepare("UPDATE events SET at=? WHERE task_id=? AND reason='SEND_INTENT'").run(Date.now()-11*60_000,first.task_id);
    assert.throws(()=>agent.pause(first.task_id,'project','OBSERVATION_TIMEOUT','other message'),{code:'INVALID_INPUT'});
    assert.equal(await agent.claim('project','6 Pro','Test Person Pro'),null);
    agent.pause(first.task_id,'project','OBSERVATION_TIMEOUT',claim!.marker+' Question one');
    assert.equal(store.task(first.task_id)?.status,'paused');
    assert.equal(store.task(first.task_id)?.delivery,'maybe_sent');
    assert.equal(service.ask({project_id:'project',request_key:'stalled',question:'Question one',mode:'ask',session:{kind:'new'}}).task_id,first.task_id);
    assert.equal((await agent.claim('project','6 Pro','Test Person Pro'))?.task_id,second.task_id);
    assert.equal(store.task(first.task_id)?.pause_reason,'OBSERVATION_TIMEOUT');
  } finally {store.close();await rm(root,{recursive:true,force:true});}
});

test('agent browser rejects a changed context snapshot before compose',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-agent-'));
  const store=new Store(':memory:');
  try {
    const source=path.join(root,'sample.ts');
    await writeFile(source,'export const value = 1;\n');
    store.db.prepare('INSERT INTO projects(id,root,identity,created_at) VALUES(?,?,?,?)').run('project',root,rootIdentity(root),Date.now());
    store.db.prepare("INSERT INTO profiles(id,route) VALUES('default',NULL)").run();
    const service=new BridgeService(store,null,'project'),agent=new AgentExecutor(store);
    agent.bindRoute('6 Pro','Test Person Pro');
    service.authorizeSession('project',['sample.ts'],60,1);
    const packet=await service.prepare({project_id:'project',files:[{path:'sample.ts'}],diff:'none'});
    const task=service.ask({project_id:'project',request_key:'changed',question:'Review',mode:'review',context_packet_id:(packet as {packet_id:string}).packet_id,session:{kind:'new'}});
    await writeFile(source,'export const value = 2;\n');
    await assert.rejects(agent.claim('project','6 Pro','Test Person Pro'),{code:'CONTEXT_STALE'});
    assert.equal(store.task(task.task_id)?.status,'paused');
    assert.equal(store.task(task.task_id)?.delivery,'not_sent');
  } finally {store.close();await rm(root,{recursive:true,force:true});}
});

test('premature partial web send blocks the queue even before send intent',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-agent-'));
  const store=new Store(':memory:');
  try {
    store.db.prepare('INSERT INTO projects(id,root,identity,created_at) VALUES(?,?,?,?)').run('project',root,rootIdentity(root),Date.now());
    store.db.prepare("INSERT INTO profiles(id,route) VALUES('default',NULL)").run();
    const service=new BridgeService(store,null,'project'),agent=new AgentExecutor(store);
    agent.bindRoute('6 Pro','Test Person Pro');
    service.authorizeSession('project',[],60,2);
    const first=service.ask({project_id:'project',request_key:'first',question:'Question one',mode:'ask',session:{kind:'new'}});
    const second=service.ask({project_id:'project',request_key:'second',question:'Question two',mode:'ask',session:{kind:'new'}});
    const claim=await agent.claim('project','6 Pro','Test Person Pro');
    assert.ok(claim);
    agent.pause(first.task_id,'project','USER_INTERFERENCE');
    assert.throws(()=>agent.markPrematureSend(first.task_id,'project','unrelated message'),{code:'DELIVERY_UNKNOWN'});
    assert.deepEqual(agent.markPrematureSend(first.task_id,'project',claim.marker),{task_id:first.task_id,status:'paused',delivery:'maybe_sent'});
    assert.equal(store.task(first.task_id)?.pause_reason,'DELIVERY_UNKNOWN');
    assert.equal(await agent.claim('project','6 Pro','Test Person Pro'),null);
    assert.equal(store.task(second.task_id)?.status,'queued');
    assert.throws(()=>agent.markPrematureSend(first.task_id,'project',claim.marker),{code:'DELIVERY_UNKNOWN'});
  } finally {store.close();await rm(root,{recursive:true,force:true});}
});
