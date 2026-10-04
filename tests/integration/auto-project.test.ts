import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('global MCP binds each conversation to one current project without per-project config',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'cpb-auto-project-'));
  const data=path.join(temp,'data'),first=path.join(temp,'first'),second=path.join(temp,'second');
  await Promise.all([mkdir(data),mkdir(first),mkdir(second)]);
  const cli=path.resolve('dist/src/cli/index.js');
  const env={...process.env,CODEX_PRO_BRIDGE_DATA_DIR:data,CODEX_PRO_BRIDGE_BROWSER:'agent'};
  const clients:Client[]=[];
  const connect=async()=>{
    const client=new Client({name:'cpb-global-test',version:'1'});
    await client.connect(new StdioClientTransport({command:process.execPath,args:[cli,'serve','--auto'],env}));
    clients.push(client);return client;
  };
  try {
    const a=await connect();
    const names=(await a.listTools()).tools.map(tool=>tool.name).sort();
    assert.deepEqual(names,['codex_pro_ask','codex_pro_bind_project','codex_pro_cancel','codex_pro_get_task','codex_pro_prepare_context','codex_pro_record_answer','codex_pro_status']);
    const unbound=await a.callTool({name:'codex_pro_status',arguments:{project_id:'unbound',live:false}});
    assert.equal(unbound.isError,true);
    const broad=await a.callTool({name:'codex_pro_bind_project',arguments:{root:os.homedir()}});
    assert.equal(broad.isError,true);
    const bound=await a.callTool({name:'codex_pro_bind_project',arguments:{root:first}});
    assert.equal(bound.isError,undefined);
    const firstId=(bound.structuredContent as {project_id:string}).project_id;
    const status=await a.callTool({name:'codex_pro_status',arguments:{project_id:firstId,live:false}});
    assert.equal((status.structuredContent as {project_id:string}).project_id,firstId);
    assert.equal((await a.callTool({name:'codex_pro_bind_project',arguments:{root:second}})).isError,true);
    const b=await connect();
    const other=await b.callTool({name:'codex_pro_bind_project',arguments:{root:second}});
    const secondId=(other.structuredContent as {project_id:string}).project_id;
    assert.notEqual(secondId,firstId);
    assert.equal((await b.callTool({name:'codex_pro_status',arguments:{project_id:firstId,live:false}})).isError,true);
    const again=await b.callTool({name:'codex_pro_bind_project',arguments:{root:second}});
    assert.equal((again.structuredContent as {project_id:string}).project_id,secondId);
    const c=await connect();
    const textOnly=await c.callTool({name:'codex_pro_bind_project',arguments:{}});
    assert.equal(textOnly.isError,undefined);
    const textOnlyId=(textOnly.structuredContent as {project_id:string}).project_id;
    assert.notEqual(textOnlyId,firstId);
    assert.notEqual(textOnlyId,secondId);
    assert.equal((await c.callTool({name:'codex_pro_status',arguments:{project_id:textOnlyId,live:false}})).isError,undefined);
    assert.equal((await c.callTool({name:'codex_pro_prepare_context',arguments:{project_id:textOnlyId,files:[],diff:'none'}})).isError,true);
    assert.equal((await c.callTool({name:'codex_pro_ask',arguments:{project_id:textOnlyId,request_key:'packet-blocked',question:'Hello',mode:'ask',context_packet_id:'pkt_fake',session:{kind:'new'}}})).isError,true);
    assert.equal((await c.callTool({name:'codex_pro_bind_project',arguments:{root:first}})).isError,true);
    const d=await connect();
    const textAgain=await d.callTool({name:'codex_pro_bind_project',arguments:{}});
    assert.equal((textAgain.structuredContent as {project_id:string}).project_id,textOnlyId);
    const route=spawnSync(process.execPath,[cli,'agent','bind-route'],{env,input:JSON.stringify({route:'6 Pro',account_label:'Test Pro'}),encoding:'utf8'});
    assert.equal(route.status,0,route.stderr);
    const otherAccount=spawnSync(process.execPath,[cli,'agent','bind-route'],{env,input:JSON.stringify({route:'High',account_label:'Other Account'}),encoding:'utf8'});
    assert.equal(otherAccount.status,1);
    assert.equal((JSON.parse(otherAccount.stderr) as {code:string}).code,'ACCOUNT_MISMATCH');
    const question=await c.callTool({name:'codex_pro_ask',arguments:{project_id:textOnlyId,request_key:'text-only-question',question:'What is 2 + 2?',mode:'ask',session:{kind:'new'}}});
    assert.equal((question.structuredContent as {status:string}).status,'awaiting_approval');
    const allowedSwitch=spawnSync(process.execPath,[cli,'agent','bind-route'],{env,input:JSON.stringify({route:'High',account_label:'Other Account',account_switch_authorized:true}),encoding:'utf8'});
    assert.equal(allowedSwitch.status,0,allowedSwitch.stderr);
    const paused=await c.callTool({name:'codex_pro_get_task',arguments:{project_id:textOnlyId,task_id:(question.structuredContent as {task_id:string}).task_id,wait_ms:0}});
    assert.equal((paused.structuredContent as {status:string}).status,'paused');
  } finally {
    for(const client of clients)await client.close().catch(()=>{});
    await promisify(execFile)(process.execPath,[cli,'shutdown'],{env,timeout:5000}).catch(()=>{});
    await rm(temp,{recursive:true,force:true});
  }
});

test('global MCP auto-text opt-in queues a projectless question without a manual approval',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'cpb-auto-text-mcp-'));
  const data=path.join(temp,'data');await mkdir(data);
  const cli=path.resolve('dist/src/cli/index.js');
  const env={...process.env,CODEX_PRO_BRIDGE_DATA_DIR:data,CODEX_PRO_BRIDGE_BROWSER:'agent',CODEX_PRO_BRIDGE_AUTO_TEXT:'1'};
  const {CODEX_PRO_BRIDGE_AUTO_TEXT:_autoText,...runtimeEnv}=env;
  const client=new Client({name:'cpb-auto-text-test',version:'1'});
  try {
    await promisify(execFile)(process.execPath,[cli,'doctor'],{env:runtimeEnv,timeout:20000});
    await client.connect(new StdioClientTransport({command:process.execPath,args:[cli,'serve','--auto'],env}));
    const bound=await client.callTool({name:'codex_pro_bind_project',arguments:{}});
    const id=(bound.structuredContent as {project_id:string}).project_id;
    const route=spawnSync(process.execPath,[cli,'agent','bind-route'],{env,input:JSON.stringify({route:'6 Pro',account_label:'Test Pro'}),encoding:'utf8'});
    assert.equal(route.status,0,route.stderr);
    const question=await client.callTool({name:'codex_pro_ask',arguments:{project_id:id,request_key:'text-auto',question:'Compare two options',mode:'plan',session:{kind:'new'}}});
    assert.equal(question.isError,undefined);
    assert.equal((question.structuredContent as {status:string;approval_required:boolean}).status,'queued');
    assert.equal((question.structuredContent as {status:string;approval_required:boolean}).approval_required,false);
    const task=(question.structuredContent as {task_id:string;payload_sha256:string}).task_id;
    const claimed=spawnSync(process.execPath,[cli,'agent','claim','--project',id],{env,input:JSON.stringify({route:'6 Pro',account_label:'Test Pro'}),encoding:'utf8'});
    assert.equal(claimed.status,0,claimed.stderr);
    const claim=JSON.parse(claimed.stdout) as {task_id:string;payload_sha256:string;marker:string};
    assert.equal(claim.task_id,task);
    const intent=spawnSync(process.execPath,[cli,'agent','intent','--project',id],{env,input:JSON.stringify({task_id:task,payload_sha256:claim.payload_sha256,route:'6 Pro',account_label:'Test Pro'}),encoding:'utf8'});
    assert.equal(intent.status,0,intent.stderr);
    const url='https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc';
    const sent=spawnSync(process.execPath,[cli,'agent','sent','--project',id],{env,input:JSON.stringify({task_id:task,url,observed_user_text:claim.marker+' Compare two options',route:'6 Pro',account_label:'Test Pro'}),encoding:'utf8'});
    assert.equal(sent.status,0,sent.stderr);
    const longAnswer='这是一段较长的中文回答。\n'.repeat(500);
    const recordArgs={project_id:id,task_id:task,url,text:longAnswer,route:'6 Pro',account_label:'Test Pro',association_verified:true,completion_verified:true,content_complete:true,warnings:[]};
    const wrongProject=await client.callTool({name:'codex_pro_record_answer',arguments:{...recordArgs,project_id:'another-project'}});
    assert.equal(wrongProject.isError,true);
    const recorded=await client.callTool({name:'codex_pro_record_answer',arguments:recordArgs});
    assert.equal(recorded.isError,undefined);
    assert.equal((recorded.structuredContent as {status:string}).status,'completed');
    let storedAnswer='',cursor:string|null=null;
    do {
      const stored=await client.callTool({name:'codex_pro_get_task',arguments:{project_id:id,task_id:task,wait_ms:0,...(cursor?{cursor}:{})}});
      const answer=(stored.structuredContent as {answer:{text:string;next_cursor:string|null}}).answer;
      storedAnswer+=answer.text;cursor=answer.next_cursor;
    } while(cursor);
    assert.equal(storedAnswer,longAnswer);
  } finally {
    await client.close().catch(()=>{});
    await promisify(execFile)(process.execPath,[cli,'shutdown'],{env,timeout:5000}).catch(()=>{});
    await rm(temp,{recursive:true,force:true});
  }
});
