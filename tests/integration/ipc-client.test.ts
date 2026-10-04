import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('IPC client decodes a reply split inside a UTF-8 character',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'cpb-ipc-client-'));
  const expected='中文🙂 完整';
  const response=Buffer.from(JSON.stringify({result:{text:expected}}));
  const split=response.indexOf(Buffer.from('🙂'))+1;
  assert.ok(split>1);
  const server=createServer((req,res)=>{
    req.resume();
    req.on('end',()=>{
      res.writeHead(200,{'content-type':'application/json'});
      res.write(response.subarray(0,split));
      setTimeout(()=>res.end(response.subarray(split)),20);
    });
  });
  try {
    server.listen(0,'127.0.0.1');
    await new Promise<void>(resolve=>server.once('listening',resolve));
    const address=server.address();
    assert.ok(address&&typeof address!=='string');
    await writeFile(path.join(data,'runtime.json'),JSON.stringify({port:address.port,pid:process.pid,token:'test',nonce:'test'}));
    const moduleUrl=pathToFileURL(path.resolve('dist/src/runtime/ipc.js')).href;
    const script=`import {callRuntime} from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(await callRuntime('project','status',{},false)));`;
    const child=await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{env:{...process.env,CODEX_PRO_BRIDGE_DATA_DIR:data},timeout:5000});
    assert.equal((JSON.parse(child.stdout) as {text:string}).text,expected);
  } finally {
    server.close();
    await rm(data,{recursive:true,force:true});
  }
});
