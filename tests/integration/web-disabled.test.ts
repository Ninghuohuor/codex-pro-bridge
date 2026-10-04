import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ChatGptAdapter } from '../../src/browser/chatgpt.js';
import type { Task } from '../../src/types.js';

test('offline build rejects automated live web reads and sends before opening a profile',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-web-disabled-'));
  const profile=path.join(root,'browser-profile');
  const adapter=new ChatGptAdapter(profile);
  try {
    await assert.rejects(adapter.inspectReady(),{code:'WEB_AUTOMATION_DISABLED'});
    await assert.rejects(adapter.inspectSelectedRoute(),{code:'WEB_AUTOMATION_DISABLED'});
    await assert.rejects(adapter.execute({} as Task,'Pro',async()=>{},()=>{},new AbortController().signal),{code:'WEB_AUTOMATION_DISABLED'});
    await assert.rejects(adapter.reconcile({} as Task,'Pro',new AbortController().signal),{code:'WEB_AUTOMATION_DISABLED'});
    await assert.rejects(stat(profile),{code:'ENOENT'});
  } finally {await rm(root,{recursive:true,force:true});}
});
