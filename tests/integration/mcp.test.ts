import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../../src/state/db.js';
import { rootIdentity } from '../../src/state/project.js';
import { execFile, spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

test('real stdio MCP initializes, lists the project tools, and returns structured task handles',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-mcp-'));
  const data=path.join(root,'data');await mkdir(data);
  const projectDir=path.join(root,'project');await mkdir(projectDir);const project=await realpath(projectDir);await writeFile(path.join(project,'safe.txt'),'safe context\n');
  await writeFile(path.join(data,'runtime.lock'),JSON.stringify({pid:999999,nonce:'stale-owner'}));
  const store=new Store(path.join(data,'bridge.db'));
  store.db.prepare('INSERT INTO projects(id,root,identity,created_at) VALUES(?,?,?,?)').run('prj_mcp',project,rootIdentity(project),Date.now());
  store.db.prepare("INSERT INTO profiles(id,route) VALUES('default','Pro')").run();store.close();
  const cli=path.resolve('dist/src/cli/index.js');
  const client=new Client({name:'cpb-test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[cli,'serve','--project','prj_mcp'],env:{...process.env,CODEX_PRO_BRIDGE_DATA_DIR:data}});
  let runtimePid:number|undefined;
  let rawMcp:ReturnType<typeof spawn>|undefined;
  try {
    await client.connect(transport);
    const list=await client.listTools();
    assert.deepEqual(list.tools.map(t=>t.name).sort(),['codex_pro_ask','codex_pro_cancel','codex_pro_get_task','codex_pro_prepare_context','codex_pro_record_answer','codex_pro_status']);
    assert.ok(list.tools.every(tool=>tool.inputSchema&&tool.outputSchema));
    const status=await client.callTool({name:'codex_pro_status',arguments:{project_id:'prj_mcp',live:false}});
    assert.equal((status.structuredContent as any).project_id,'prj_mcp');
    const prepared=await client.callTool({name:'codex_pro_prepare_context',arguments:{project_id:'prj_mcp',files:[{path:'safe.txt'}],diff:'none'}});
    const packet=(prepared.structuredContent as any).packet_id;
    assert.ok(packet.startsWith('pkt_'));
    const asked=await client.callTool({name:'codex_pro_ask',arguments:{project_id:'prj_mcp',request_key:'request-1',question:'Review',mode:'review',context_packet_id:packet,session:{kind:'new'}}});
    const task=(asked.structuredContent as any).task_id;
    assert.equal((asked.structuredContent as any).status,'awaiting_approval');
    await assert.rejects(promisify(execFile)(process.execPath,[cli,'sessions','reconcile',task],{env:{...process.env,CODEX_PRO_BRIDGE_DATA_DIR:data},timeout:3000}),/APPROVAL_REQUIRED/);
    const result=await client.callTool({name:'codex_pro_get_task',arguments:{project_id:'prj_mcp',task_id:task,wait_ms:0}});
    assert.equal((result.structuredContent as any).delivery,'not_sent');
    const cancelled=await client.callTool({name:'codex_pro_cancel',arguments:{project_id:'prj_mcp',task_id:task}});
    assert.equal((cancelled.structuredContent as any).upstream_stop,'not_needed');
    const listed=await promisify(execFile)(process.execPath,[cli,'tasks','list','--project','prj_mcp'],{env:{...process.env,CODEX_PRO_BRIDGE_DATA_DIR:data}});
    assert.equal((JSON.parse(listed.stdout) as {task_id:string}[])[0]?.task_id,task);
    const shown=await promisify(execFile)(process.execPath,[cli,'tasks','show',task],{env:{...process.env,CODEX_PRO_BRIDGE_DATA_DIR:data}});
    assert.equal((JSON.parse(shown.stdout) as {status:string}).status,'cancelled');
    const cliCancelled=await promisify(execFile)(process.execPath,[cli,'tasks','cancel',task],{env:{...process.env,CODEX_PRO_BRIDGE_DATA_DIR:data}});
    assert.equal((JSON.parse(cliCancelled.stdout) as {status:string}).status,'cancelled');
    const endpoint=JSON.parse(await readFile(path.join(data,'runtime.json'),'utf8'));runtimePid=endpoint.pid;
    assert.notEqual(endpoint.nonce,'stale-owner');
    rawMcp=spawn(process.execPath,[cli,'serve','--project','prj_mcp'],{env:{...process.env,CODEX_PRO_BRIDGE_DATA_DIR:data}});
    const rawInput=rawMcp.stdin,rawOutput=rawMcp.stdout;
    assert.ok(rawInput&&rawOutput);
    let rawStdout='';rawOutput.setEncoding('utf8');rawOutput.on('data',chunk=>{rawStdout+=chunk;});
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(rawStdout,'');
    rawInput.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:LATEST_PROTOCOL_VERSION,capabilities:{},clientInfo:{name:'raw-test',version:'1.0.0'}}})+'\n');
    for(let attempt=0;attempt<40&&!rawStdout.includes('\n');attempt++)await new Promise(resolve=>setTimeout(resolve,50));
    const rawLines=rawStdout.trim().split('\n');
    assert.ok(rawLines.length>0&&rawLines[0]);
    const rawResponses=rawLines.map(line=>JSON.parse(line) as {jsonrpc:string;id?:number;result?:unknown});
    assert.ok(rawResponses.every(line=>line.jsonrpc==='2.0'));
    assert.ok(rawResponses.some(line=>line.id===1&&line.result));
    rawInput.end();
    for(let attempt=0;attempt<40&&rawMcp.exitCode===null&&rawMcp.signalCode===null;attempt++)await new Promise(resolve=>setTimeout(resolve,50));
    assert.notEqual(rawMcp.exitCode,null,'stdio server did not exit when the client disconnected');
    rawMcp=undefined;
    await assert.rejects(promisify(execFile)(process.execPath,[cli,'doctor','--live'],{cwd:project,env:{...process.env,CODEX_PRO_BRIDGE_DATA_DIR:data},timeout:3000}),/WEB_AUTOMATION_DISABLED/);
    await assert.rejects(promisify(execFile)(process.execPath,[cli,'doctor','--live','--project','prj_mcp'],{cwd:project,env:{...process.env,CODEX_PRO_BRIDGE_DATA_DIR:data},timeout:3000}),/WEB_AUTOMATION_DISABLED/);
    const base=`http://127.0.0.1:${endpoint.port}/rpc`;
    const payload=JSON.stringify({project_id:'prj_mcp',op:'status',args:{live:false}});
    const noToken=await fetch(base,{method:'POST',headers:{'content-type':'application/json'},body:payload});
    assert.equal(noToken.status,401);
    const wrongToken=await fetch(base,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer wrong-token'},body:payload});
    assert.equal(wrongToken.status,401);
    const wrongHost=await new Promise<number>((resolve,reject)=>{
      const req=httpRequest(base,{method:'POST',headers:{host:'other.example','content-type':'application/json',authorization:`Bearer ${endpoint.token}`}},res=>{
        res.resume();res.on('end',()=>resolve(res.statusCode??0));res.on('error',reject);
      });
      req.on('error',reject);req.end(payload);
    });
    assert.equal(wrongHost,403);
    const origin=await fetch(base,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${endpoint.token}`,origin:'https://example.com'},body:payload});
    assert.equal(origin.status,403);
    const wrongType=await fetch(base,{method:'POST',headers:{'content-type':'text/plain',authorization:`Bearer ${endpoint.token}`},body:payload});
    assert.equal(wrongType.status,403);
    const unicodeQuestion='请检查中文🙂是否完整';
    const unicodeBody=Buffer.from(JSON.stringify({project_id:'prj_mcp',op:'ask',args:{request_key:'split-unicode',question:unicodeQuestion,mode:'review',session:{kind:'new'}}}));
    const split=unicodeBody.indexOf(Buffer.from('🙂'))+1;
    assert.ok(split>1);
    const splitResponse=await new Promise<{status:number;body:any}>((resolve,reject)=>{
      const req=httpRequest(base,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${endpoint.token}`}},res=>{
        const parts:Buffer[]=[];
        res.on('data',(part:Buffer)=>parts.push(part));
        res.on('end',()=>resolve({status:res.statusCode??0,body:JSON.parse(Buffer.concat(parts).toString('utf8'))}));
        res.on('error',reject);
      });
      req.on('error',reject);
      req.write(unicodeBody.subarray(0,split));
      setTimeout(()=>req.end(unicodeBody.subarray(split)),20);
    });
    assert.equal(splitResponse.status,200);
    const preview=await fetch(base,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${endpoint.token}`},body:JSON.stringify({project_id:'prj_mcp',op:'preview',args:{task_id:splitResponse.body.result.task_id}})});
    assert.equal(preview.status,200);
    assert.match((await preview.json() as any).result.payload,/请检查中文🙂是否完整/);
    const invalidUtf8=await new Promise<{status:number;body:any}>((resolve,reject)=>{
      const req=httpRequest(base,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${endpoint.token}`}},res=>{
        const parts:Buffer[]=[];
        res.on('data',(part:Buffer)=>parts.push(part));
        res.on('end',()=>resolve({status:res.statusCode??0,body:JSON.parse(Buffer.concat(parts).toString('utf8'))}));
        res.on('error',reject);
      });
      req.on('error',reject);
      req.end(Buffer.from([0xff]));
    });
    assert.equal(invalidUtf8.status,400);
    assert.equal(invalidUtf8.body.error.code,'INVALID_INPUT');
    const oversized=await fetch(base,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${endpoint.token}`},body:'a'.repeat(256*1024+1)});
    assert.equal(oversized.status,413);
    await assert.rejects(promisify(execFile)(process.execPath,[cli,'runtime'],{env:{...process.env,CODEX_PRO_BRIDGE_DATA_DIR:data},timeout:3000}),/RUNTIME_UNAVAILABLE/);
    const stopped=await promisify(execFile)(process.execPath,[cli,'shutdown'],{env:{...process.env,CODEX_PRO_BRIDGE_DATA_DIR:data},timeout:5000});
    assert.equal((JSON.parse(stopped.stdout) as {stopping:boolean}).stopping,true);
    let removed=false;
    for(let attempt=0;attempt<30;attempt++) {
      try {await readFile(path.join(data,'runtime.json'));await new Promise(resolve=>setTimeout(resolve,50));}
      catch {removed=true;break;}
    }
    assert.equal(removed,true);
    runtimePid=undefined;
  } finally {
    rawMcp?.kill('SIGTERM');
    await client.close().catch(()=>{});
    if(runtimePid)try{process.kill(runtimePid,'SIGTERM');}catch{}
    await new Promise(r=>setTimeout(r,100));
    await rm(root,{recursive:true,force:true});
  }
});

test('simultaneous startup elects exactly one runtime owner',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-race-'));
  const cli=path.resolve('dist/src/cli/index.js');
  const env={...process.env,CODEX_PRO_BRIDGE_DATA_DIR:root};
  const children=[spawn(process.execPath,[cli,'runtime'],{env,stdio:'ignore'}),spawn(process.execPath,[cli,'runtime'],{env,stdio:'ignore'})];
  try {
    let endpoint:{pid:number}|undefined;
    for(let attempt=0;attempt<150;attempt++) {
      try {endpoint=JSON.parse(await readFile(path.join(root,'runtime.json'),'utf8')) as {pid:number};break;}
      catch {await new Promise(resolve=>setTimeout(resolve,100));}
    }
    assert.ok(endpoint,'one runtime must publish its endpoint');
    const deadline=Date.now()+6000;
    while(Date.now()<deadline&&children.every(child=>child.exitCode===null&&child.signalCode===null))await new Promise(resolve=>setTimeout(resolve,100));
    const running=children.filter(child=>child.exitCode===null&&child.signalCode===null);
    assert.equal(running.length,1);
    assert.equal(running[0]?.pid,endpoint.pid);
    assert.equal(children.filter(child=>child.exitCode!==null).length,1);
  } finally {
    const alive=children.filter(child=>child.exitCode===null&&child.signalCode===null);
    const stopped=alive.map(child=>new Promise<void>(resolve=>child.once('exit',()=>resolve())));
    for(const child of alive)child.kill('SIGTERM');
    await Promise.all(stopped);
    await rm(root,{recursive:true,force:true});
  }
});
