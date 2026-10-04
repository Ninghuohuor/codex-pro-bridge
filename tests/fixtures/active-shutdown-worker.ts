import { Store } from '../../src/state/db.js';
import { rootIdentity } from '../../src/state/project.js';
import { BridgeService } from '../../src/runtime/service.js';
import { BridgeError } from '../../src/security/errors.js';
import type { BrowserAdapter } from '../../src/browser/adapter.js';

const [file,root]=process.argv.slice(2);
if(!file||!root)throw new Error('fixture needs database and project root');
const store=new Store(file);
store.db.prepare('INSERT INTO projects(id,root,identity,created_at) VALUES(?,?,?,?)').run('shutdown-project',root,rootIdentity(root),Date.now());
store.db.prepare("INSERT INTO profiles(id,route) VALUES('default','Pro')").run();
let submitted!:()=>void;
const submittedPromise=new Promise<void>(resolve=>{submitted=resolve;});
const adapter:BrowserAdapter={
  inspectReady:async()=>({logged_in:true,route:'Pro',observed_at:Date.now()}),
  execute:async(_task,_route,beforeSubmit,_confirmedSubmit,signal)=>{
    await beforeSubmit();
    submitted();
    await new Promise<void>((_resolve,reject)=>{
      if(signal.aborted)return reject(new BridgeError('CANCEL_UNCONFIRMED','stopped'));
      signal.addEventListener('abort',()=>reject(new BridgeError('CANCEL_UNCONFIRMED','stopped')),{once:true});
    });
    throw new Error('unreachable');
  },
  reconcile:async()=>null,
  requestStop:async()=>false
};
const service=new BridgeService(store,adapter,'shutdown-project');
const task=service.ask({project_id:'shutdown-project',request_key:'same-request',question:'Review',mode:'review',session:{kind:'new'}});
service.approve('shutdown-project',task.task_id,task.payload_sha256);
await submittedPromise;
const keepAlive=setInterval(()=>{},1000);
let stopping=false;
const stop=async()=>{
  if(stopping)return;
  stopping=true;
  clearInterval(keepAlive);
  BridgeService.requestRuntimeStop();
  const deadline=Date.now()+3000;
  while(Date.now()<deadline&&store.task(task.task_id)?.status==='running')await new Promise(resolve=>setTimeout(resolve,10));
  const state=store.task(task.task_id);
  store.close();
  process.stdout.write(`STOPPED ${state?.status} ${state?.delivery}\n`);
  process.exit(state?.status==='paused'&&state.delivery==='maybe_sent'?0:1);
};
process.once('SIGTERM',()=>{void stop();});
process.stdin.once('data',()=>{void stop();});
process.stdin.resume();
process.stdout.write(`READY ${task.task_id}\n`);
