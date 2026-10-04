import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Store } from '../../src/state/db.js';
import { rootIdentity } from '../../src/state/project.js';
import { BridgeService } from '../../src/runtime/service.js';

test('runtime exits only after pending work and client leases are gone',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-idle-'));
  const data=path.join(root,'data'),project=path.join(root,'project');
  await mkdir(data);await mkdir(project);
  const store=new Store(path.join(data,'bridge.db'));
  store.db.prepare('INSERT INTO projects(id,root,identity,created_at) VALUES(?,?,?,?)').run('idle-project',project,rootIdentity(project),Date.now());
  store.db.prepare("INSERT INTO profiles(id,route) VALUES('default','Pro')").run();
  const service=new BridgeService(store,null,'idle-project');
  const task=service.ask({project_id:'idle-project',request_key:'pending',question:'Review',mode:'review',session:{kind:'new'}});
  store.close();
  const moduleUrl=pathToFileURL(path.resolve('dist/src/runtime/ipc.js')).href;
  const script=`import {startRuntime} from ${JSON.stringify(moduleUrl)}; await startRuntime(200);`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,CODEX_PRO_BRIDGE_DATA_DIR:data},stdio:['ignore','ignore','pipe']});
  let errors='';child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{errors+=chunk;});
  try {
    let endpoint:{port:number;token:string}|undefined;
    for(let attempt=0;attempt<300;attempt++) {
      try {endpoint=JSON.parse(await readFile(path.join(data,'runtime.json'),'utf8')) as {port:number;token:string};break;}
      catch {await new Promise(resolve=>setTimeout(resolve,50));}
    }
    assert.ok(endpoint,errors);
    const rpc=async(op:string,args:Record<string,unknown>)=>{
      const response=await fetch(`http://127.0.0.1:${endpoint!.port}/rpc`,{method:'POST',headers:{authorization:`Bearer ${endpoint!.token}`,'content-type':'application/json'},body:JSON.stringify({project_id:'idle-project',op,args})});
      assert.equal(response.status,200,await response.text());
    };
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.equal(child.exitCode,null,'pending task must keep runtime alive');
    const clientId=randomUUID();
    await rpc('client_attach',{id:clientId});
    await rpc('cancel',{task_id:task.task_id});
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.equal(child.exitCode,null,'connected client must keep runtime alive');
    await rpc('client_detach',{id:clientId});
    const code=await Promise.race([
      new Promise<number|null>(resolve=>child.once('exit',exitCode=>resolve(exitCode))),
      new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(new Error(`runtime did not exit: ${errors}`)),10000))
    ]);
    assert.equal(code,0,errors);
    await assert.rejects(readFile(path.join(data,'runtime.json')),{code:'ENOENT'});
  } finally {
    if(child.exitCode===null)child.kill('SIGKILL');
    await rm(root,{recursive:true,force:true});
  }
});
