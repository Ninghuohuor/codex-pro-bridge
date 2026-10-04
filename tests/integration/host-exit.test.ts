import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run=promisify(execFile);

test('detached runtime retains a pending task after its MCP host exits abruptly',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-host-exit-'));
  const data=path.join(root,'data'),projectA=path.join(root,'a'),projectB=path.join(root,'b');
  await Promise.all([mkdir(data),mkdir(projectA),mkdir(projectB)]);
  const env={...process.env,CODEX_PRO_BRIDGE_DATA_DIR:data};
  const cli=path.resolve('dist/src/cli/index.js');
  let runtimePid:number|undefined;
  try {
    await run(process.execPath,[path.resolve('dist/tests/fixtures/seed-multi-client.js'),data,projectA,projectB],{timeout:10000});
    const {stdout}=await run(process.execPath,[path.resolve('dist/tests/fixtures/abrupt-host-exit.js')],{env,timeout:30000});
    const {task_id}=JSON.parse(stdout) as {task_id:string};
    assert.ok(task_id);
    runtimePid=(JSON.parse(await readFile(path.join(data,'runtime.json'),'utf8')) as {pid:number}).pid;
    await new Promise(resolve=>setTimeout(resolve,250));
    assert.doesNotThrow(()=>process.kill(runtimePid!,0));
    const listed=await run(process.execPath,[cli,'tasks','list','--project','project-a'],{env,timeout:20000});
    assert.match(listed.stdout,RegExp(task_id));
    const endpoint=(JSON.parse(await readFile(path.join(data,'runtime.json'),'utf8')) as {pid:number}).pid;
    assert.equal(endpoint,runtimePid);
  } finally {
    if(runtimePid) {
      await run(process.execPath,[cli,'shutdown'],{env,timeout:20000}).catch(()=>{
        try {process.kill(runtimePid!,'SIGTERM');} catch {}
      });
    }
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
