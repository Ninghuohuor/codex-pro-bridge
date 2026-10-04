import { createServer, request as httpRequest } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, unlink, chmod, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { dataDir, ensurePrivateDir } from '../state/paths.js';
import { Store, unresolvedDeliverySql } from '../state/db.js';
import { invalidateLogin, isHighReasoningRoute, rebindRoute } from '../state/profile.js';
import { currentBranch, rootIdentity } from '../state/project.js';
import { BridgeService } from './service.js';
import { AgentExecutor } from './agent.js';
import { BridgeError, safeError, fail } from '../security/errors.js';
import { ChatGptAdapter } from '../browser/chatgpt.js';

interface Endpoint {port:number;token:string;nonce:string;pid:number}
const stateFile=()=>path.join(dataDir(),'runtime.json');
const lockFile=()=>path.join(dataDir(),'runtime.lock');
const spawnFile=()=>path.join(dataDir(),'runtime-spawn.lock');
function alive(pid:number) { try { process.kill(pid,0);return true; } catch {return false;} }
async function readEndpoint():Promise<Endpoint|null> {try{return JSON.parse(await readFile(stateFile(),'utf8')) as Endpoint;}catch{return null;}}
function equalToken(a:string,b:string) { const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y); }
export async function startRuntime(idleMs=10*60_000) {
  if(!Number.isSafeInteger(idleMs)||idleMs<100)fail('INVALID_INPUT','空闲退出阈值无效。');
  const existing=await readEndpoint();
  if(existing&&alive(existing.pid))fail('RUNTIME_UNAVAILABLE','已有运行器正在运行。');
  await ensurePrivateDir();
  const ownership=new DatabaseSync(path.join(dataDir(),'runtime-owner.db'));
  try {ownership.exec('PRAGMA busy_timeout=1000; BEGIN EXCLUSIVE;');}
  catch {ownership.close();fail('RUNTIME_UNAVAILABLE','已有运行器正在运行。');}
  const nonce=randomUUID(),token=randomBytes(32).toString('hex');
  await writeFile(lockFile(),JSON.stringify({pid:process.pid,nonce}),{mode:0o600});
  if(process.platform!=='win32')await chmod(lockFile(),0o600);
  const store=new Store();store.cleanup();
  const agentMode=process.env.CODEX_PRO_BRIDGE_BROWSER==='agent';
  const adapter=agentMode?null:new ChatGptAdapter(path.join(dataDir(),'browser-profile'));
  const agent=agentMode?new AgentExecutor(store):null;
  let busy=false;
  let lastActivity=Date.now(),idleStopping=false;
  const clientLeases=new Map<string,number>();
  const server=createServer(async(req,res)=>{
    const reject=(status:number,body:object)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
    if(req.method!=='POST'||req.url!=='/rpc'||req.headers.host!==`127.0.0.1:${(server.address() as {port:number}).port}`||req.headers.origin||req.headers['content-type']!=='application/json') return reject(403,{error:{code:'IPC_UNAUTHORIZED',safe_message:'请求来源不受信任。'}});
    if(!equalToken(req.headers.authorization?.replace(/^Bearer /,'')??'',token)) return reject(401,{error:{code:'IPC_UNAUTHORIZED',safe_message:'本机鉴权失败。'}});
    lastActivity=Date.now();
    try {
      const chunks:Buffer[]=[];let size=0;
      for await(const value of req) {
        const chunk=Buffer.isBuffer(value)?value:Buffer.from(value);
        size+=chunk.length;
        if(size>256*1024)return reject(413,{error:{code:'INVALID_INPUT',safe_message:'请求过大。'}});
        chunks.push(chunk);
      }
      let body:string;
      try {body=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size));}
      catch {fail('INVALID_INPUT','请求不是有效 UTF-8。');}
      let rpc:{project_id:string;op:string;args?:Record<string,unknown>};
      try {rpc=JSON.parse(body) as typeof rpc;}
      catch {fail('INVALID_INPUT','请求 JSON 无效。');}
      if(typeof rpc.project_id!=='string'||typeof rpc.op!=='string') fail('INVALID_INPUT','请求格式无效。');
      const service=new BridgeService(store,adapter,rpc.project_id);
      const a=rpc.args??{};
      let result:unknown;
      switch(rpc.op) {
        case 'project_for_root': result=store.db.prepare('SELECT id,root,epoch,active FROM projects WHERE root=?').get(String(a.root))??null;break;
        case 'project_list':result=store.db.prepare('SELECT id,root,epoch,active FROM projects ORDER BY created_at').all();break;
        case 'register_project': {
          const root=String(a.root),id=String(a.id);
          const prior=store.db.prepare('SELECT id FROM projects WHERE root=?').get(root) as {id:string}|undefined;
          if(prior&&prior.id!==id) fail('PROJECT_MISMATCH','目录已绑定其他项目。');
          if(!prior)store.db.prepare('INSERT INTO projects(id,root,identity,branch,created_at) VALUES(?,?,?,?,?)').run(id,root,rootIdentity(root),currentBranch(root),Date.now());
          else store.db.prepare('UPDATE projects SET active=1 WHERE id=?').run(id);
          store.db.prepare("INSERT OR IGNORE INTO profiles(id,route) VALUES('default',NULL)").run();
          result={project_id:id};break;
        }
        case 'deactivate_project': {
          const project=store.db.prepare('SELECT id FROM projects WHERE root=?').get(String(a.root)) as {id:string}|undefined;
          if(!project)fail('WORKSPACE_UNBOUND','项目未注册。');
          const pending=store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id=? AND status IN ('awaiting_approval','queued','running','paused')").get(project.id) as {n:number};
          if(pending.n)fail('PROFILE_BUSY','项目仍有未结束任务，请先处理。');
          store.db.prepare('UPDATE projects SET active=0 WHERE id=?').run(project.id);
          result={project_id:project.id,active:false};break;
        }
        case 'lookup_task': {const t=store.task(String(a.task_id));result=t?{project_id:t.project_id}:null;break;}
        case 'doctor':result={node:process.version,platform:process.platform,database:store.db.prepare('PRAGMA integrity_check').get(),projects:store.db.prepare('SELECT COUNT(*) AS count FROM projects').get(),browser_mode:agentMode?'agent':'playwright',web_automation_enabled:agentMode||process.env.CODEX_PRO_BRIDGE_LIVE_WEB==='1',live_validated:false};break;
        case 'runtime_state':result={active:BridgeService.isActive(),pid:process.pid};break;
        case 'client_attach':
        case 'client_heartbeat': {
          if(!store.project(rpc.project_id))fail('WORKSPACE_UNBOUND','客户端项目未注册。');
          const id=String(a.id);
          if(!/^[0-9a-f-]{36}$/.test(id))fail('INVALID_INPUT','客户端编号无效。');
          clientLeases.set(id,Date.now()+2*60_000);result={attached:true};break;
        }
        case 'client_detach':clientLeases.delete(String(a.id));result={detached:true};break;
        case 'shutdown': {
          const active=BridgeService.isActive();
          if(active&&a.confirm_active!==true) fail('PROFILE_BUSY','运行器仍有活动任务，需本地确认后停止。');
          result={stopping:true,active_task_interrupted:active};break;
        }
        case 'login':if(BridgeService.isActive())fail('PROFILE_BUSY','活动任务期间不能切换登录页面。');if(!adapter)fail('RUNTIME_UNAVAILABLE','Agent 模式使用现有 Chrome 会话。');invalidateLogin(store);result=await adapter.openLogin();break;
        case 'route_inspect':if(BridgeService.isActive())fail('PROFILE_BUSY','活动任务期间不能查看其他页面选项。');if(!adapter)fail('RUNTIME_UNAVAILABLE','Agent 模式使用现有 Chrome 会话。');result={selected_display:await adapter.inspectSelectedRoute()};break;
        case 'route_configure': {
          if(BridgeService.isActive())fail('PROFILE_BUSY','活动任务期间不能重新配置页面选项。');
          if(!adapter)fail('RUNTIME_UNAVAILABLE','Agent 模式由 Codex 核对并绑定网页选项。');
          const selected=await adapter.inspectSelectedRoute();
          if(BridgeService.isActive())fail('PROFILE_BUSY','活动任务期间不能重新配置页面选项。');
          if(selected!==String(a.selected_display)||!isHighReasoningRoute(selected)) fail('ROUTE_UNVERIFIABLE','页面当前选项与指定的高推理档位不一致。');
          result=rebindRoute(store,selected);break;
        }
        case 'agent_bind_route':if(!agent)fail('RUNTIME_UNAVAILABLE','运行器未启用 Agent 浏览器模式。');result=agent.bindRoute(String(a.route),String(a.account_label),a.account_switch_authorized===true);break;
        case 'agent_claim':if(!agent)fail('RUNTIME_UNAVAILABLE','运行器未启用 Agent 浏览器模式。');result=await agent.claim(rpc.project_id,String(a.route),String(a.account_label));break;
        case 'agent_send_intent':if(!agent)fail('RUNTIME_UNAVAILABLE','运行器未启用 Agent 浏览器模式。');result=await agent.sendIntent(String(a.task_id),rpc.project_id,String(a.payload_sha256),String(a.route),String(a.account_label));break;
        case 'agent_confirm_sent':if(!agent)fail('RUNTIME_UNAVAILABLE','运行器未启用 Agent 浏览器模式。');result=agent.confirmSent(String(a.task_id),rpc.project_id,String(a.url),String(a.observed_user_text),String(a.route),String(a.account_label));break;
        case 'agent_complete':if(!agent)fail('RUNTIME_UNAVAILABLE','运行器未启用 Agent 浏览器模式。');result=agent.complete(String(a.task_id),rpc.project_id,{url:String(a.url),text:String(a.text),route:String(a.route),account_label:String(a.account_label),association_verified:a.association_verified===true,completion_verified:a.completion_verified===true,content_complete:a.content_complete===true,warnings:a.warnings as string[]});break;
        case 'agent_pause':if(!agent)fail('RUNTIME_UNAVAILABLE','运行器未启用 Agent 浏览器模式。');result=agent.pause(String(a.task_id),rpc.project_id,String(a.reason),a.observed_user_text as string|undefined);break;
        case 'agent_uncertain':if(!agent)fail('RUNTIME_UNAVAILABLE','运行器未启用 Agent 浏览器模式。');result=agent.markPrematureSend(String(a.task_id),rpc.project_id,String(a.observed_user_text));break;
        case 'agent_heartbeat':if(!agent)fail('RUNTIME_UNAVAILABLE','运行器未启用 Agent 浏览器模式。');result=agent.heartbeat(String(a.task_id),rpc.project_id);break;
        case 'status':result=await service.status(rpc.project_id,Boolean(a.live));break;
        case 'prepare':result=await service.prepare({...a,project_id:rpc.project_id} as Parameters<typeof service.prepare>[0]);break;
        case 'ask':result=service.ask({...a,project_id:rpc.project_id} as Parameters<typeof service.ask>[0]);break;
        case 'get_task': {
          const id=String(a.task_id),wait=Number(a.wait_ms??0);
          if(!Number.isInteger(wait)||wait<0||wait>20000) fail('INVALID_INPUT','wait_ms 超出范围。');
          await service.getTask(rpc.project_id,id,a.cursor as string|undefined);
          const taskState=()=>{const task=store.task(id);return task?JSON.stringify([task.status,task.phase,task.delivery,task.pause_reason,task.cancel_requested,task.updated_at]):null;};
          const initial=taskState();
          if(wait>0&&initial) {
            const until=Date.now()+wait;
            while(Date.now()<until&&taskState()===initial) await new Promise(r=>setTimeout(r,Math.min(250,until-Date.now())));
          }
          result=await service.getTask(rpc.project_id,id,a.cursor as string|undefined);break;
        }
        case 'task_list':result=service.listTasks(rpc.project_id);break;
        case 'cancel':result=await service.cancel(rpc.project_id,String(a.task_id));break;
        case 'resume':result=await service.resume(rpc.project_id,String(a.task_id));break;
        case 'bind_conversation':result=service.bindConversationCandidate(rpc.project_id,String(a.task_id),String(a.url));break;
        case 'abandon':result=service.abandon(rpc.project_id,String(a.task_id));break;
        case 'approve':service.approve(rpc.project_id,String(a.task_id),String(a.payload_sha256));result={approved:true};break;
        case 'authorize_session':result=service.authorizeSession(rpc.project_id,a.paths as string[],Number(a.minutes),Number(a.max_sends));break;
        case 'revoke':result=service.revokeGrant(rpc.project_id,String(a.grant_id));break;
        case 'preview': {const t=store.task(String(a.task_id));if(!t||t.project_id!==rpc.project_id) fail('PROJECT_MISMATCH','任务不存在于此项目。');result={task_id:t.id,payload_sha256:t.payload_sha256,payload:t.payload,route:store.db.prepare("SELECT route FROM profiles WHERE id='default'").get()};break;}
        default:fail('INVALID_INPUT','未知操作。');
      }
      reject(200,{result});
      if(rpc.op==='approve'&&!busy) {busy=true;setImmediate(()=>{service.kick();busy=false;});}
      if(rpc.op==='shutdown') setTimeout(()=>{void stopRuntime().catch(()=>process.exit(1));},25);
    } catch(e) {reject(400,{error:safeError(e)});}
  });
  server.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const endpoint:Endpoint={port:(server.address() as {port:number}).port,token,nonce,pid:process.pid};
  await writeFile(stateFile(),JSON.stringify(endpoint),{mode:0o600});
  const queued=store.db.prepare("SELECT project_id FROM tasks WHERE status='queued' ORDER BY created_at LIMIT 1").get() as {project_id:string}|undefined;
  if(queued)new BridgeService(store,adapter,queued.project_id).kick();
  const shutdown=async()=>{
    clearInterval(timer);clearInterval(idleTimer);
    server.close();
    await adapter?.close().catch(()=>{});
    store.close();
    const current=await readEndpoint();if(current?.nonce===nonce)await unlink(stateFile()).catch(()=>{});
    const lock=await readFile(lockFile(),'utf8').then(value=>JSON.parse(value) as {nonce:string}).catch(()=>null);
    if(lock?.nonce===nonce)await unlink(lockFile()).catch(()=>{});
    ownership.exec('ROLLBACK');ownership.close();
  };
  const stopRuntime=async()=>{
    BridgeService.requestRuntimeStop();
    const deadline=Date.now()+2000;
    while(BridgeService.isActive()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
    if(BridgeService.isActive())process.exit(0);
    await shutdown();process.exit(0);
  };
  process.once('SIGINT',()=>{void stopRuntime().catch(()=>process.exit(1));});
  process.once('SIGTERM',()=>{void stopRuntime().catch(()=>process.exit(1));});
  const timer=setInterval(()=>store.cleanup(),3600000);timer.unref();
  const idleTimer=setInterval(()=>{
    if(idleStopping)return;
    const now=Date.now();
    for(const [id,expiresAt] of clientLeases)if(expiresAt<=now)clientLeases.delete(id);
    const pending=store.db.prepare(`SELECT 1 FROM tasks WHERE status IN ('awaiting_approval','queued','running','paused') OR (${unresolvedDeliverySql}) LIMIT 1`).get();
    if(BridgeService.isActive()||pending||clientLeases.size>0){lastActivity=now;return;}
    if(now-lastActivity>=idleMs){idleStopping=true;void stopRuntime().catch(()=>process.exit(1));}
  },Math.max(50,Math.min(60_000,Math.floor(idleMs/2))));idleTimer.unref();
}
export async function callRuntime(project_id:string,op:string,args:Record<string,unknown>={},allowSpawn=true):Promise<any> {
  let endpoint=await readEndpoint();
  if(!endpoint||!alive(endpoint.pid)) {
    if(!allowSpawn) fail('RUNTIME_UNAVAILABLE','运行器未启动。');
    await ensurePrivateDir();
    const deadline=Date.now()+10000;
    while(Date.now()<deadline) {
      endpoint=await readEndpoint();
      if(endpoint&&alive(endpoint.pid))break;
      const nonce=randomUUID();
      try {
        await writeFile(spawnFile(),JSON.stringify({pid:process.pid,nonce}),{flag:'wx',mode:0o600});
        try {
          endpoint=await readEndpoint();
          if(!endpoint||!alive(endpoint.pid)) {
            const child=spawn(process.execPath,[process.argv[1]!, 'runtime'],{detached:true,stdio:'ignore',env:process.env});child.unref();
            for(let i=0;i<60;i++) {
              await new Promise(r=>setTimeout(r,100));
              endpoint=await readEndpoint();
              if(endpoint&&alive(endpoint.pid))break;
            }
          }
        } finally {
          const claim=await readFile(spawnFile(),'utf8').then(value=>JSON.parse(value) as {nonce:string}).catch(()=>null);
          if(claim?.nonce===nonce)await unlink(spawnFile()).catch(()=>{});
        }
        break;
      } catch(error) {
        if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
        const claim=await readFile(spawnFile(),'utf8').then(value=>JSON.parse(value) as {pid:number}).catch(()=>null);
        const age=await stat(spawnFile()).then(info=>Date.now()-info.mtimeMs).catch(()=>0);
        if(age>10000&&(!claim||!alive(claim.pid)))await unlink(spawnFile()).catch(()=>{});
        await new Promise(r=>setTimeout(r,100));
      }
    }
    if(!endpoint||!alive(endpoint.pid)) fail('RUNTIME_UNAVAILABLE','无法启动本地运行器。');
  }
  const body=JSON.stringify({project_id,op,args});
  return await new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port:endpoint!.port,path:'/rpc',method:'POST',headers:{host:`127.0.0.1:${endpoint!.port}`,authorization:`Bearer ${endpoint!.token}`,'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
      const chunks:Buffer[]=[];
      res.on('data',(chunk:Buffer)=>chunks.push(chunk));
      res.on('error',reject);
      res.on('end',()=>{try{const out=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));const parsed=JSON.parse(out);if(parsed.error)reject(new BridgeError(parsed.error.code,parsed.error.safe_message,parsed.error.next_action));else resolve(parsed.result);}catch(e){reject(e);}});
    });req.on('error',()=>reject(new Error('RUNTIME_UNAVAILABLE')));req.end(body);
  });
}

export async function stopAndWaitRuntime(confirmActive:boolean) {
  const target=await readEndpoint();
  if(!target||!alive(target.pid)) fail('RUNTIME_UNAVAILABLE','运行器未启动。');
  const result=await callRuntime('','shutdown',{confirm_active:confirmActive},false);
  const deadline=Date.now()+10000;
  while(Date.now()<deadline) {
    if(!alive(target.pid))return {...result,stopped:true};
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  fail('RUNTIME_UNAVAILABLE','运行器停止超时，请运行 doctor 核对。');
}
