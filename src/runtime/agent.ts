import { createHash } from 'node:crypto';
import { Store, queueBlockingDeliverySql } from '../state/db.js';
import { isHighReasoningRoute, rebindRoute } from '../state/profile.js';
import { computeRevision } from '../context/prepare.js';
import { currentBranch, rootIdentity } from '../state/project.js';
import { conversationUrl } from '../browser/url.js';
import { fail } from '../security/errors.js';
import type { Task } from '../types.js';

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const marker=(id:string)=>`[CPB request: ${id}]`;

/** The Codex agent owns the visible browser; this class owns the durable send ledger. */
export class AgentExecutor {
  constructor(private readonly store:Store) {}

  bindRoute(route:string,accountLabel:string,accountSwitchAuthorized=false) {
    if(this.store.db.prepare("SELECT 1 FROM tasks WHERE status='running' LIMIT 1").get()) fail('PROFILE_BUSY','当前仍有网页任务。');
    if(!isHighReasoningRoute(route)||route.length>200||accountLabel.trim().length<2||accountLabel.length>200)
      fail('ROUTE_UNVERIFIABLE','必须从已登录页面核对高推理档位和账户标识。');
    const accountHash=digest(accountLabel.trim());
    const saved=this.store.db.prepare("SELECT route FROM profiles WHERE id='agent-account'").get() as {route:string}|undefined;
    if(saved&&saved.route!==accountHash&&!accountSwitchAuthorized)
      fail('ACCOUNT_MISMATCH','当前网页登录账号与此前绑定的账号不同，已停止创建和发送任务。','请登录原账号；若明确要改用当前账号，先授权切换账号。');
    const bound=rebindRoute(this.store,route);
    this.store.db.prepare("INSERT INTO profiles(id,route,login_epoch,verified_at) VALUES('agent-account',?,1,?) ON CONFLICT(id) DO UPDATE SET route=excluded.route,verified_at=excluded.verified_at").run(accountHash,Date.now());
    return {...bound,account_bound:true};
  }

  private checkProfile(route:string,accountLabel:string) {
    const profile=this.store.db.prepare("SELECT route,login_epoch FROM profiles WHERE id='default'").get() as {route:string|null;login_epoch:number}|undefined;
    const account=this.store.db.prepare("SELECT route FROM profiles WHERE id='agent-account'").get() as {route:string}|undefined;
    if(!profile?.route||profile.route!==route||!account?.route||account.route!==digest(accountLabel.trim()))
      fail('ROUTE_UNAVAILABLE','页面账户或推理档位与已配置绑定不一致。');
    return profile;
  }

  private checkWorkspace(task:Task) {
    const project=this.store.project(task.project_id);
    const session=this.store.db.prepare('SELECT epoch,login_epoch,route,conversation_url FROM sessions WHERE id=?').get(task.session_id) as {epoch:number;login_epoch:number;route:string;conversation_url:string|null}|undefined;
    const profile=this.store.db.prepare("SELECT route,login_epoch FROM profiles WHERE id='default'").get() as {route:string|null;login_epoch:number}|undefined;
    if(!project||!session||!profile||session.epoch!==project.epoch||session.login_epoch!==profile.login_epoch||session.route!==profile.route||rootIdentity(project.root)!==project.identity||currentBranch(project.root)!==project.branch)
      fail('WORKSPACE_CHANGED','任务所属项目、网页选项或登录状态已变化。');
    return {project,session,profile};
  }

  private async checkPacket(task:Task,root:string) {
    if(!task.packet_id)return;
    const packet=this.store.packet(task.packet_id);
    if(!packet||await computeRevision(root,packet.manifest,packet.diff_mode)!==packet.revision)
      fail('CONTEXT_STALE','发送前上下文快照已变化。');
  }

  async claim(projectId:string,route:string,accountLabel:string) {
    this.checkProfile(route,accountLabel);
    const running=this.store.db.prepare("SELECT id,updated_at FROM tasks WHERE status='running' LIMIT 1").get() as {id:string;updated_at:number}|undefined;
    if(running) {
      if(Date.now()-running.updated_at>35*60_000) {
        this.store.db.prepare("UPDATE tasks SET status='paused',phase='reconcile',pause_reason='AGENT_INTERRUPTED',updated_at=? WHERE id=?").run(Date.now(),running.id);
        this.store.event(running.id,'paused','AGENT_INTERRUPTED');
      }
      return null;
    }
    if(this.store.db.prepare(`SELECT id FROM tasks WHERE ${queueBlockingDeliverySql} LIMIT 1`).get())return null;
    const next=this.store.db.prepare("SELECT id,project_id FROM tasks WHERE status='queued' ORDER BY created_at,id LIMIT 1").get() as {id:string;project_id:string}|undefined;
    if(!next||next.project_id!==projectId)return null;
    const task=this.store.task(next.id)!;
    let session:{conversation_url:string|null};
    try {
      const checked=this.checkWorkspace(task);
      await this.checkPacket(task,checked.project.root);
      if(task.payload===null)fail('RESULT_EXPIRED','待发送正文已过期。');
      session=checked.session;
    } catch(error) {
      const reason=error instanceof Error&&'code' in error?String(error.code):'RUNTIME_INTERRUPTED';
      this.store.db.prepare("UPDATE tasks SET status='paused',pause_reason=?,updated_at=? WHERE id=? AND status='queued'").run(reason,Date.now(),task.id);
      this.store.event(task.id,'paused',reason);
      throw error;
    }
    const changed=this.store.db.prepare("UPDATE tasks SET status='running',phase='compose',updated_at=? WHERE id=? AND status='queued'").run(Date.now(),task.id);
    if(changed.changes!==1)fail('PROFILE_BUSY','任务已由其他执行者领取。');
    this.store.event(task.id,'running','AGENT_CLAIMED');
    return {task_id:task.id,project_id:task.project_id,session_id:task.session_id,payload:task.payload,payload_sha256:task.payload_sha256,marker:marker(task.id),route,target_url:session.conversation_url??'https://chatgpt.com/'};
  }

  async sendIntent(taskId:string,projectId:string,payloadHash:string,route:string,accountLabel:string) {
    this.checkProfile(route,accountLabel);
    const task=this.store.task(taskId);
    if(!task||task.project_id!==projectId||task.status!=='running'||task.phase!=='compose'||task.delivery!=='not_sent'||task.cancel_requested||task.payload_sha256!==payloadHash)
      fail('APPROVAL_EXPIRED','任务或批准快照已变化。');
    const {project,session,profile}=this.checkWorkspace(task);
    await this.checkPacket(task,project.root);
    this.store.transaction(()=>{
      const packet=task.packet_id?this.store.packet(task.packet_id):undefined;
      const allowed=packet?.manifest.map(x=>x.path)??[];
      const possible=this.store.db.prepare('SELECT id,task_id,payload_sha256,paths FROM grants WHERE project_id=? AND route=? AND login_epoch=? AND remaining>0 AND expires_at>? ORDER BY CASE WHEN task_id=? THEN 0 ELSE 1 END').all(task.project_id,profile.route,session.login_epoch,Date.now(),task.id) as {id:string;task_id:string|null;payload_sha256:string|null;paths:string|null}[];
      const grant=possible.find(g=>g.task_id===task.id?g.payload_sha256===task.payload_sha256:g.task_id===null&&allowed.every(p=>(JSON.parse(g.paths??'[]') as string[]).includes(p)));
      if(!grant)fail('APPROVAL_EXPIRED','发送授权已失效。');
      this.store.db.prepare('UPDATE grants SET remaining=remaining-1 WHERE id=?').run(grant.id);
      this.store.db.prepare("UPDATE tasks SET phase='submit',delivery='maybe_sent',updated_at=? WHERE id=?").run(Date.now(),task.id);
      this.store.event(task.id,'running','SEND_INTENT');
    });
    return {task_id:task.id,delivery:'maybe_sent',marker:marker(task.id)};
  }

  confirmSent(taskId:string,projectId:string,url:string,observedUserText:string,route:string,accountLabel:string) {
    this.checkProfile(route,accountLabel);
    const task=this.store.task(taskId);
    if(!task||task.project_id!==projectId||!['running','paused'].includes(task.status)||task.delivery!=='maybe_sent'||task.status==='running'&&task.phase!=='submit')fail('DELIVERY_UNKNOWN','任务不在等待发送确认的状态。');
    const {session}=this.checkWorkspace(task);
    if(!observedUserText.includes(marker(task.id))||observedUserText.length>256*1024)fail('DELIVERY_UNKNOWN','页面未显示本次请求标记。');
    const confirmed=conversationUrl(url);
    if(session.conversation_url&&session.conversation_url!==confirmed)fail('DELIVERY_UNKNOWN','发送后对话地址发生变化。');
    this.store.transaction(()=>{
      this.store.db.prepare("UPDATE tasks SET status='running',phase='wait',delivery='confirmed_sent',pause_reason=NULL,updated_at=? WHERE id=?").run(Date.now(),task.id);
      this.store.db.prepare('UPDATE sessions SET conversation_url=? WHERE id=?').run(confirmed,task.session_id);
      this.store.event(task.id,'running','USER_MESSAGE_CONFIRMED');
    });
    return {task_id:task.id,delivery:'confirmed_sent',conversation_url:confirmed};
  }

  complete(taskId:string,projectId:string,input:{url:string;text:string;route:string;account_label:string;association_verified:boolean;completion_verified:boolean;content_complete:boolean;warnings?:string[]}) {
    this.checkProfile(input.route,input.account_label);
    const task=this.store.task(taskId);
    if(!task||task.project_id!==projectId||!['running','paused'].includes(task.status)||task.delivery!=='confirmed_sent'||task.status==='running'&&task.phase!=='wait')fail('RESPONSE_UNVERIFIABLE','任务不在等待回答的状态。');
    const {session}=this.checkWorkspace(task);
    if(conversationUrl(input.url)!==session.conversation_url||!input.association_verified||!input.completion_verified||!input.text.trim()||Buffer.byteLength(input.text)>2*1024*1024)
      fail('RESPONSE_UNVERIFIABLE','回答地址、关联、完成状态或正文无法核对。');
    const warnings=input.warnings??[];
    if(!Array.isArray(warnings)||warnings.some(x=>typeof x!=='string'||x.length>100)||warnings.length>20)
      fail('INVALID_INPUT','回答警告无效。');
    const complete=input.content_complete;
    this.store.transaction(()=>{
      this.store.db.prepare('INSERT INTO results VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET text=excluded.text,sha256=excluded.sha256,completeness=excluded.completeness,association_verified=excluded.association_verified,route_before=excluded.route_before,route_after=excluded.route_after,completion_verified=excluded.completion_verified,warnings=excluded.warnings,completed_at=excluded.completed_at').run(task.id,input.text,digest(input.text),complete?'complete':'partial',1,input.route,input.route,1,JSON.stringify(warnings),Date.now());
      this.store.db.prepare("UPDATE tasks SET status=?,phase='capture',pause_reason=?,updated_at=? WHERE id=?").run(complete?'completed':'paused',complete?null:'RESPONSE_PARTIAL',Date.now(),task.id);
      this.store.db.prepare("UPDATE sessions SET state='ready' WHERE id=?").run(task.session_id);
      this.store.event(task.id,complete?'completed':'paused',complete?null:'RESPONSE_PARTIAL');
    });
    return {task_id:task.id,status:complete?'completed':'paused',delivery:'confirmed_sent'};
  }

  pause(taskId:string,projectId:string,reason:string,observedUserText?:string) {
    const task=this.store.task(taskId);
    if(!task||task.project_id!==projectId||!['running','paused'].includes(task.status))fail('INVALID_INPUT','任务当前无法暂停。');
    if(reason==='OBSERVATION_TIMEOUT') {
      const intent=this.store.db.prepare("SELECT at FROM events WHERE task_id=? AND reason='SEND_INTENT' ORDER BY at DESC LIMIT 1").get(taskId) as {at:number}|undefined;
      if(!intent||Date.now()-intent.at<10*60_000||!['maybe_sent','confirmed_sent'].includes(task.delivery)||typeof observedUserText!=='string'||observedUserText.length>256*1024||!observedUserText.includes(marker(task.id)))
        fail('INVALID_INPUT','仅能在已发送问题仍可见且观察满 10 分钟后结束等待。');
    } else if(!['USER_INTERFERENCE','UI_UNSUPPORTED','RESPONSE_UNVERIFIABLE','CAPTCHA_REQUIRED','AGENT_INTERRUPTED'].includes(reason))fail('INVALID_INPUT','暂停原因无效。');
    this.store.db.prepare("UPDATE tasks SET status='paused',phase='reconcile',pause_reason=?,updated_at=? WHERE id=?").run(reason,Date.now(),taskId);
    this.store.event(taskId,'paused',reason);
    return {task_id:taskId,status:'paused',delivery:task.delivery};
  }

  markPrematureSend(taskId:string,projectId:string,observedUserText:string) {
    const task=this.store.task(taskId);
    if(!task||task.project_id!==projectId||!['running','paused'].includes(task.status)||task.delivery!=='not_sent'||!['compose','reconcile'].includes(task.phase))
      fail('DELIVERY_UNKNOWN','任务当前无法登记意外发送。');
    if(observedUserText.length>256*1024||!observedUserText.includes(marker(task.id)))
      fail('DELIVERY_UNKNOWN','页面未显示本次请求标记。');
    this.store.transaction(()=>{
      const grant=this.store.db.prepare('SELECT id FROM grants WHERE project_id=? AND task_id=? AND payload_sha256=? AND remaining>0 ORDER BY expires_at DESC LIMIT 1').get(task.project_id,task.id,task.payload_sha256) as {id:string}|undefined;
      if(grant)this.store.db.prepare('UPDATE grants SET remaining=remaining-1 WHERE id=?').run(grant.id);
      this.store.db.prepare("UPDATE tasks SET status='paused',phase='reconcile',delivery='maybe_sent',pause_reason='DELIVERY_UNKNOWN',updated_at=? WHERE id=?").run(Date.now(),task.id);
      this.store.event(task.id,'paused','PREMATURE_WEB_SEND');
    });
    return {task_id:task.id,status:'paused',delivery:'maybe_sent'};
  }

  heartbeat(taskId:string,projectId:string) {
    const task=this.store.task(taskId);
    if(!task||task.project_id!==projectId||task.status!=='running')fail('INVALID_INPUT','任务已不再执行。');
    this.store.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(Date.now(),taskId);
    return {task_id:taskId,status:'running'};
  }
}
