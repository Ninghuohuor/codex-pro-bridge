import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('independent MCP clients share deduplication, queue limits and project boundaries',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-clients-'));
  const data=path.join(root,'data'),projectA=path.join(root,'a'),projectB=path.join(root,'b');
  await Promise.all([mkdir(data),mkdir(projectA),mkdir(projectB)]);
  await promisify(execFile)(process.execPath,[path.resolve('dist/tests/fixtures/seed-multi-client.js'),data,projectA,projectB],{timeout:10000});
  const cli=path.resolve('dist/src/cli/index.js'),env={...process.env,CODEX_PRO_BRIDGE_DATA_DIR:data};
  const clients=[new Client({name:'a-one',version:'1'}),new Client({name:'a-two',version:'1'}),new Client({name:'b-one',version:'1'})];
  const transports=['project-a','project-a','project-b'].map(id=>new StdioClientTransport({command:process.execPath,args:[cli,'serve','--project',id],env}));
  const trace=(stage:string)=>{if(process.env.CPB_TEST_TRACE==='1')process.stderr.write(`multi-client: ${stage}\n`);};
  const call=(client:Client,name:string,args:Record<string,unknown>)=>client.callTool({name,arguments:args},undefined,{timeout:20000});
  let runtimePid:number|undefined;
  try {
    trace('connect');
    await Promise.all(clients.map((client,index)=>client.connect(transports[index]!,{timeout:20000})));
    trace('connected');
    const [a1,a2,b]=clients;
    const args=(project_id:string,request_key:string,question='Review')=>({project_id,request_key,question,mode:'review',session:{kind:'new'}});
    const [first,duplicate]=await Promise.all([
      call(a1!,'codex_pro_ask',args('project-a','shared')),
      call(a2!,'codex_pro_ask',args('project-a','shared'))
    ]);
    trace('deduplicated');
    const firstId=(first.structuredContent as {task_id:string}).task_id;
    assert.equal((duplicate.structuredContent as {task_id:string}).task_id,firstId);
    const conflict=await call(a2!,'codex_pro_ask',args('project-a','shared','Changed'));
    assert.equal(conflict.isError,true);
    assert.equal((conflict.structuredContent as {code:string}).code,'IDEMPOTENCY_CONFLICT');
    const other=await call(b!,'codex_pro_ask',args('project-b','shared'));
    const otherId=(other.structuredContent as {task_id:string}).task_id;
    assert.notEqual(otherId,firstId);
    const forbidden=await call(a1!,'codex_pro_get_task',{project_id:'project-a',task_id:otherId,wait_ms:0});
    assert.equal(forbidden.isError,true);
    assert.equal((forbidden.structuredContent as {code:string}).code,'PROJECT_MISMATCH');
    const poll=call(a1!,'codex_pro_get_task',{project_id:'project-a',task_id:firstId,wait_ms:2000});
    await new Promise(resolve=>setTimeout(resolve,100));
    await call(a2!,'codex_pro_cancel',{project_id:'project-a',task_id:firstId});
    trace('cancelled');
    assert.equal(((await poll).structuredContent as {status:string}).status,'cancelled');
    const continuation={project_id:'project-a',question:'Continue',mode:'review',session:{kind:'continue',session_id:'shared-session'}};
    const contenders=await Promise.all([
      call(a1!,'codex_pro_ask',{...continuation,request_key:'session-one'}),
      call(a2!,'codex_pro_ask',{...continuation,request_key:'session-two'})
    ]);
    assert.equal(contenders.filter(result=>result.isError).length,1);
    assert.equal((contenders.find(result=>result.isError)?.structuredContent as {code:string}).code,'PROFILE_BUSY');
    await a2!.close();
    trace('second-client-closed');
    for(let index=0;index<3;index++) {
      const queued=await call(a1!,'codex_pro_ask',args('project-a',`queued-${index}`));
      assert.equal((queued.structuredContent as {status:string}).status,'awaiting_approval');
    }
    const full=await call(b!,'codex_pro_ask',args('project-b','overflow'));
    assert.equal(full.isError,true);
    assert.equal((full.structuredContent as {code:string}).code,'QUEUE_FULL');
    runtimePid=(JSON.parse(await readFile(path.join(data,'runtime.json'),'utf8')) as {pid:number}).pid;
    trace(`runtime-pid: ${runtimePid}`);
    trace('complete');
  } finally {
    trace('close-clients');
    await Promise.all(clients.map(client=>client.close().catch(()=>{})));
    trace('clients-closed');
    const pid=runtimePid??await readFile(path.join(data,'runtime.json'),'utf8').then(value=>(JSON.parse(value) as {pid:number}).pid).catch(()=>undefined);
    trace(`shutdown-target-pid: ${pid??'absent'}; test-pid: ${process.pid}`);
    let shutdownFailure:unknown;
    if(pid) {
      try {
        trace('shutdown-runtime');
        const {stdout}=await promisify(execFile)(process.execPath,[cli,'shutdown'],{env,timeout:12000});
        assert.equal((JSON.parse(stdout) as {stopped?:boolean}).stopped,true);
        trace('runtime-stopped');
      } catch(error) {
        shutdownFailure=error;
        try {process.kill(pid,'SIGTERM');} catch {}
      }
    }
    try {
      await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});
      trace('cleanup-complete');
    } catch(error) {
      trace(`cleanup-failed: ${(error as NodeJS.ErrnoException).code??'unknown'}`);
      const endpoint=await readFile(path.join(data,'runtime.json'),'utf8').then(value=>(JSON.parse(value) as {pid:number}).pid).catch(()=>null);
      trace(`endpoint-pid-after-shutdown: ${endpoint??'absent'}`);
      if(process.platform==='win32') {
        try {
          const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_Process -Filter "Name = \'node.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'],{timeout:10000});
          const rows=JSON.parse(stdout) as {ProcessId:number;CommandLine:string}|Array<{ProcessId:number;CommandLine:string}>;
          const processes=(Array.isArray(rows)?rows:[rows]).map(row=>({pid:row.ProcessId,cli:row.CommandLine?.includes('index.js')??false,runtime:row.CommandLine?.includes('runtime')??false}));
          trace(`node-processes-after-shutdown: ${JSON.stringify(processes)}`);
        } catch(diagnosticError) {trace(`process-diagnostic-failed: ${String(diagnosticError)}`);}
      }
      throw error;
    }
    if(shutdownFailure)throw shutdownFailure;
  }
});
