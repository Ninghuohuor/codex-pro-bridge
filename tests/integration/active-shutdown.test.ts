import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from '../../src/state/db.js';
import { BridgeService } from '../../src/runtime/service.js';

test('stopping an active send-intent worker preserves uncertainty and deduplication',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-active-stop-'));
  const file=path.join(root,'state.db');
  const child=spawn(process.execPath,[path.resolve('dist/tests/fixtures/active-shutdown-worker.js'),file,root],{stdio:['pipe','pipe','pipe']});
  let output='',errors='';
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{output+=chunk;});
  child.stderr.on('data',chunk=>{errors+=chunk;});
  try {
    const taskId=await new Promise<string>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('worker did not reach send intent')),5000);
      const read=()=>{const match=output.match(/READY (tsk_[a-f0-9-]+)/);if(match){clearTimeout(timer);resolve(match[1]!);}};
      child.stdout.on('data',read);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error(`worker exited before ready: ${errors}`));});
      read();
    });
    const exited=new Promise<number|null>(resolve=>child.once('exit',code=>resolve(code)));
    if(process.platform==='win32')child.stdin.write('STOP\n');
    else child.kill('SIGTERM');
    assert.equal(await Promise.race([exited,new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(new Error('worker did not stop')),5000))]),0,errors+output);
    assert.match(output,/STOPPED paused maybe_sent/);
    const store=new Store(file);
    try {
      assert.equal(store.task(taskId)?.status,'paused');
      assert.equal(store.task(taskId)?.delivery,'maybe_sent');
      assert.equal(store.task(taskId)?.pause_reason,'DELIVERY_UNKNOWN');
      const service=new BridgeService(store,null,'shutdown-project');
      const duplicate=service.ask({project_id:'shutdown-project',request_key:'same-request',question:'Review',mode:'review',session:{kind:'new'}});
      assert.equal(duplicate.task_id,taskId);
      assert.equal(duplicate.status,'paused');
    } finally {store.close();}
  } finally {
    if(child.exitCode===null)child.kill('SIGKILL');
    await rm(root,{recursive:true,force:true});
  }
});

test('forcibly killed send-intent worker recovers without creating a duplicate task',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-forced-stop-'));
  const file=path.join(root,'state.db');
  const child=spawn(process.execPath,[path.resolve('dist/tests/fixtures/active-shutdown-worker.js'),file,root],{stdio:['pipe','pipe','pipe']});
  let output='',errors='';
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{output+=chunk;});
  child.stderr.on('data',chunk=>{errors+=chunk;});
  try {
    const taskId=await new Promise<string>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(`worker did not reach send intent: ${errors}`)),5000);
      const read=()=>{const match=output.match(/READY (tsk_[a-f0-9-]+)/);if(match){clearTimeout(timer);resolve(match[1]!);}};
      child.stdout.on('data',read);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error(`worker exited before ready: ${errors}`));});
      read();
    });
    const exited=new Promise<void>(resolve=>child.once('close',()=>resolve()));
    assert.equal(child.kill('SIGKILL'),true);
    await Promise.race([exited,new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(new Error('worker did not exit')),5000))]);
    const store=new Store(file);
    try {
      const recovered=store.task(taskId);
      assert.equal(recovered?.status,'paused');
      assert.equal(recovered.delivery,'maybe_sent');
      assert.equal(recovered.pause_reason,'DELIVERY_UNKNOWN');
      const service=new BridgeService(store,null,'shutdown-project');
      const duplicate=service.ask({project_id:'shutdown-project',request_key:'same-request',question:'Review',mode:'review',session:{kind:'new'}});
      assert.equal(duplicate.task_id,taskId);
      assert.equal(duplicate.status,'paused');
      assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as {n:number}).n,1);
    } finally {store.close();}
  } finally {
    if(child.exitCode===null)child.kill('SIGKILL');
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
