import { randomUUID, createHash } from 'node:crypto';
import { Store, queueBlockingDeliverySql } from '../state/db.js';
import { currentBranch, rootIdentity } from '../state/project.js';
import { computeRevision, prepareContext, type PrepareInput } from '../context/prepare.js';
import { scanText } from '../security/scan.js';
import { checkRelativePath } from '../security/paths.js';
import { fail } from '../security/errors.js';
import type { BrowserAdapter } from '../browser/adapter.js';
import { conversationUrl } from '../browser/url.js';
import { LIVE_WEB_ENABLED } from '../browser/chatgpt.js';
import type { Mode, Task } from '../types.js';
import { isProjectlessRoot } from '../state/paths.js';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function boundedAnswer(value:string):string {
  const bytes=Buffer.from(value,'utf8');
  const limit=2*1024*1024;
  if(bytes.length<=limit)return value;
  let end=limit;
  while(end>0&&(bytes[end]!&0xc0)===0x80)end--;
  return bytes.subarray(0,end).toString('utf8');
}
export interface AskInput {project_id:string;request_key:string;question:string;mode:Mode;context_packet_id?:string;auto_text_opt_in?:boolean;session:{kind:'new'}|{kind:'continue';session_id:string}}
export class BridgeService {
  private static active=false;
  private static stopping=false;
  private static activeTaskId:string|null=null;
  private static abort?:AbortController;
  static isActive() {return BridgeService.active;}
  static requestRuntimeStop() {BridgeService.stopping=true;BridgeService.abort?.abort();}
  constructor(readonly store:Store, readonly adapter:BrowserAdapter|null, readonly boundProject:string) {}
  private project(id:string,refreshBranch=false) {
    if(id!==this.boundProject) fail('PROJECT_MISMATCH','MCP 入口只允许访问绑定项目。');
    return this.workspace(id,refreshBranch);
  }
  private workspace(id:string,refreshBranch=false) {
    let p=this.store.project(id); if(!p) fail('WORKSPACE_UNBOUND','项目未注册。');
    if(refreshBranch) {
      const identity=rootIdentity(p.root);
      const branch=currentBranch(p.root);
      if(identity!==p.identity||p.branch!==null&&branch!==p.branch) {
        this.store.transaction(()=>{
          this.store.db.prepare('UPDATE projects SET epoch=epoch+1,identity=?,branch=? WHERE id=?').run(identity,branch,id);
          this.store.db.prepare("UPDATE tasks SET status='paused',pause_reason='WORKSPACE_CHANGED',updated_at=? WHERE project_id=? AND status IN ('awaiting_approval','queued')").run(Date.now(),id);
        });
        p=this.store.project(id)!;
      } else if(p.branch===null&&branch!==null) {
        this.store.db.prepare('UPDATE projects SET branch=? WHERE id=?').run(branch,id);p=this.store.project(id)!;
      }
    }
    return p;
  }
  async status(project_id:string,live=false) {
    this.project(project_id);
    const profile=this.store.db.prepare("SELECT route,verified_at,login_epoch FROM profiles WHERE id='default'").get() as {route:string|null;verified_at:number|null;login_epoch:number}|undefined;
    const agentMode=process.env.CODEX_PRO_BRIDGE_BROWSER==='agent';
    const base={project_id,version:'0.1.0-alpha.1',route:profile?.route??null,observed_at:profile?.verified_at??null,stale:!profile?.verified_at||Date.now()-profile.verified_at>300000,live:false,browser_mode:agentMode?'agent':'playwright',web_automation_enabled:agentMode||LIVE_WEB_ENABLED,limitations:['backend_model_unverified',agentMode?'agent_browser_requires_codex':LIVE_WEB_ENABLED?'web_ui_experimental':'real_web_not_validated']};
    if(!live) return base;
    if(BridgeService.active) return {...base,error:'BUSY'};
    if(!this.adapter) return {...base,error:agentMode?'AGENT_OBSERVATION_REQUIRED':'BROWSER_NOT_CONFIGURED'};
    const ready=await this.adapter.inspectReady();
    return {...base,...ready,stale:false,live:true};
  }
  async prepare(input:PrepareInput) { const project=this.project(input.project_id,true); if(isProjectlessRoot(project.root))fail('CONTEXT_BLOCKED','无项目对话只支持纯文字问题。'); return prepareContext(this.store,input); }
  ask(input:AskInput) {
    const project=this.project(input.project_id,true);
    if(isProjectlessRoot(project.root)&&input.context_packet_id)fail('CONTEXT_BLOCKED','无项目对话只支持纯文字问题。');
    scanText(input.question);
    if(Buffer.byteLength(input.question)>8192) fail('CONTEXT_TOO_LARGE','问题超过 8 KiB。');
    const inputFingerprint=`v2:${sha(JSON.stringify({question:input.question,mode:input.mode,context_packet_id:input.context_packet_id??null,session_kind:input.session.kind,session_id:input.session.kind==='continue'?input.session.session_id:null}))}`;
    const old=this.store.findTask(project.id,input.request_key);
    if(old?.request_sha256.startsWith('v2:')) {
      if(old.request_sha256!==inputFingerprint) fail('IDEMPOTENCY_CONFLICT','相同 request_key 对应不同内容。');
      if(input.auto_text_opt_in===true&&old.status==='awaiting_approval'&&old.delivery==='not_sent'&&!old.packet_id&&!old.cancel_requested&&old.payload&&Date.now()-old.created_at<86400000) {
        const profile=this.store.db.prepare("SELECT route,login_epoch FROM profiles WHERE id='default'").get() as {route:string|null;login_epoch:number}|undefined;
        const session=this.store.db.prepare('SELECT epoch,login_epoch,route FROM sessions WHERE id=?').get(old.session_id) as {epoch:number;login_epoch:number;route:string}|undefined;
        if(profile?.route&&session?.epoch===project.epoch&&session.login_epoch===profile.login_epoch&&session.route===profile.route) {
          scanText(old.payload);
          const now=Date.now();
          const promoted=this.store.transaction(()=>{
            this.store.db.prepare('INSERT INTO grants(id,project_id,task_id,payload_sha256,route,login_epoch,paths,remaining,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(`gr_auto_${randomUUID()}`,project.id,old.id,old.payload_sha256,profile.route,profile.login_epoch,'[]',1,now+60*60000);
            this.store.db.prepare("UPDATE tasks SET status='queued',updated_at=? WHERE id=? AND status='awaiting_approval'").run(now,old.id);
            this.store.event(old.id,'queued','AUTO_TEXT_PROMOTED');
            return true;
          });
          if(promoted){this.kick();return {...this.taskSummary(this.store.task(old.id)!),approval_required:false,next_action:'已进入本地队列。'};}
        }
      }
      return this.taskSummary(old);
    }
    const packet=input.context_packet_id?this.store.packet(input.context_packet_id):undefined;
    if(input.context_packet_id && (!packet || packet.project_id!==project.id||packet.expires_at<Date.now())) fail('CONTEXT_BLOCKED','上下文包无效或已过期。');
    const profile=this.store.db.prepare("SELECT * FROM profiles WHERE id='default'").get() as {route:string|null;login_epoch:number}|undefined;
    if(!profile?.route) fail('ROUTE_UNAVAILABLE','尚未配置并验证网页选项。');
    const session=input.session.kind==='continue' ? this.store.db.prepare('SELECT * FROM sessions WHERE id=?').get(input.session.session_id) as {id:string;project_id:string;epoch:number;profile_id:string;login_epoch:number;route:string;state:string}|undefined : undefined;
    if(input.session.kind==='continue' && (!session||session.project_id!==project.id||session.epoch!==project.epoch||session.login_epoch!==profile.login_epoch||session.route!==profile.route||session.state!=='ready')) fail('PROJECT_MISMATCH','会话不可用于当前项目和账户。');
    const sessionId=session?.id??`ses_${randomUUID()}`;
    const keyMaterial=JSON.stringify({question:input.question,mode:input.mode,packet_sha256:packet?.sha256??null,route:profile.route,session:input.session.kind==='new'?'new':sessionId});
    const requestHash=sha(keyMaterial);
    if(old) { if(old.request_sha256!==requestHash) fail('IDEMPOTENCY_CONFLICT','相同 request_key 对应不同内容。'); return this.taskSummary(old); }
    if(session) { const busy=this.store.db.prepare("SELECT id FROM tasks WHERE session_id=? AND status IN ('awaiting_approval','queued','running','paused')").get(session.id); if(busy) fail('PROFILE_BUSY','该对话尚有未结束任务。'); }
    const waiting=(this.store.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('awaiting_approval','queued')").get() as {n:number}).n;
    if(waiting>=5) fail('QUEUE_FULL','等待队列已满。');
    const taskId=`tsk_${randomUUID()}`;
    const payload=`[CPB request: ${taskId}]\nMode: ${input.mode}\nQuestion:\n${input.question}${packet?`\n\nContext:\n${packet.content}`:''}`;
    const payloadHash=sha(payload);
    scanText(payload);
    if(Buffer.byteLength(payload)>128*1024) fail('CONTEXT_TOO_LARGE','完整外发消息超过 128 KiB。');
    const now=Date.now();
    const permittedPaths=packet?.manifest.map(x=>x.path)??[];
    const grants=this.store.db.prepare('SELECT paths FROM grants WHERE project_id=? AND task_id IS NULL AND route=? AND login_epoch=? AND remaining>0 AND expires_at>?').all(project.id,profile.route,profile.login_epoch,now) as {paths:string}[];
    const sessionCovered=grants.some(g=>permittedPaths.every(p=>(JSON.parse(g.paths) as string[]).includes(p)));
    const autoTextCandidate=input.auto_text_opt_in===true&&!packet;
    const autoTextCovered=!sessionCovered&&autoTextCandidate;
    const covered=sessionCovered||autoTextCovered;
    const task:Task={id:taskId,project_id:project.id,request_key:input.request_key,request_sha256:inputFingerprint,payload_sha256:payloadHash,payload,packet_id:packet?.id??null,session_id:sessionId,mode:input.mode,status:covered?'queued':'awaiting_approval',phase:'preflight',delivery:'not_sent',pause_reason:null,cancel_requested:false,created_at:now,updated_at:now};
    this.store.transaction(()=>{
      if(!session) this.store.db.prepare('INSERT INTO sessions(id,project_id,epoch,profile_id,login_epoch,route,state) VALUES(?,?,?,?,?,?,?)').run(sessionId,project.id,project.epoch,'default',profile.login_epoch,profile.route,'reserved');
      this.store.db.prepare('INSERT INTO tasks(id,project_id,request_key,request_sha256,payload_sha256,payload,packet_id,session_id,mode,status,phase,delivery,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(task.id,task.project_id,task.request_key,task.request_sha256,task.payload_sha256,task.payload,task.packet_id,task.session_id,task.mode,task.status,task.phase,task.delivery,now,now);
      if(autoTextCovered) this.store.db.prepare('INSERT INTO grants(id,project_id,task_id,payload_sha256,route,login_epoch,paths,remaining,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(`gr_auto_${randomUUID()}`,project.id,task.id,payloadHash,profile.route,profile.login_epoch,'[]',1,now+60*60000);
      this.store.event(taskId,task.status);
    });
    if(covered)this.kick();
    return {...this.taskSummary(task),approval_required:!covered,next_action:covered?'已进入本地队列。':'请用户通过本地 CLI 查看完整外发内容并批准。'};
  }
  taskSummary(task:Task) { return {task_id:task.id,status:task.status,phase:task.phase,delivery:task.delivery,session_id:task.session_id,payload_sha256:task.payload_sha256,pause_reason:task.pause_reason,next_poll_after_ms:10000}; }
  listTasks(project_id:string) {
    this.project(project_id);
    return this.store.db.prepare('SELECT id AS task_id,status,phase,delivery,pause_reason,updated_at FROM tasks WHERE project_id=? ORDER BY created_at DESC LIMIT 50').all(project_id);
  }
  async getTask(project_id:string,task_id:string,cursor?:string) {
    this.project(project_id);
    const task=this.store.task(task_id); if(!task||task.project_id!==project_id) fail('PROJECT_MISMATCH','任务不存在于绑定项目。');
    const row=this.store.db.prepare('SELECT * FROM results WHERE task_id=?').get(task_id) as {text:string|null;sha256:string;completeness:string;association_verified:number;route_before:string;route_after:string;completion_verified:number;warnings:string}|undefined;
    if(!row) return this.taskSummary(task);
    if(row.text===null) return {...this.taskSummary(task),error:'RESULT_EXPIRED'};
    const answerText=row.text;
    let offset=0;
    if(cursor!==undefined&&(typeof cursor!=='string'||cursor.length>1024))fail('INVALID_CURSOR','分页位置无效。');
    if(cursor) {
      try {
        const parsed=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')) as {task:string;hash:string;project:string;offset:number};
        if(parsed.task!==task_id||parsed.project!==project_id||parsed.hash!==row.sha256) fail('INVALID_CURSOR','分页位置与任务不匹配。');
        offset=parsed.offset;
      } catch {fail('INVALID_CURSOR','分页位置无效。');}
    }
    if(!Number.isSafeInteger(offset)||offset<0||offset>answerText.length) fail('INVALID_CURSOR','分页位置无效。');
    if(offset>0&&offset<answerText.length) {
      const current=answerText.charCodeAt(offset),previous=answerText.charCodeAt(offset-1);
      if(current>=0xdc00&&current<=0xdfff&&previous>=0xd800&&previous<=0xdbff)fail('INVALID_CURSOR','分页位置拆分了一个 Unicode 字符。');
    }
    const offsets=[offset];let bytes=0;
    for(const char of answerText.slice(offset)) {const size=Buffer.byteLength(char);if(bytes+size>12288)break;bytes+=size;offsets.push(offsets.at(-1)!+char.length);}
    const session=this.store.db.prepare('SELECT route FROM sessions WHERE id=?').get(task.session_id) as {route:string}|undefined;
    const requested=session?.route??null;
    const page=(end:number)=>({...this.taskSummary(task),route:{requested_display:requested,selected_before:row.route_before,selected_after:row.route_after,ui_selection_verified:requested!==null&&row.route_before===requested&&row.route_after===requested,backend_model_verified:false},answer:{completeness:row.completeness,association_verified:!!row.association_verified,format:'markdown' as const,text:answerText.slice(offset,end),next_cursor:end<answerText.length?Buffer.from(JSON.stringify({task:task_id,project:project_id,hash:row.sha256,offset:end})).toString('base64url'):null,response_sha256:row.sha256},warnings:JSON.parse(row.warnings)});
    const serializedBytes=(end:number)=>{const result=page(end);return Buffer.byteLength(JSON.stringify({content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result}));};
    let low=0,high=offsets.length-1,best=-1;
    while(low<=high) {const mid=Math.floor((low+high)/2);if(serializedBytes(offsets[mid]!)<=30*1024){best=mid;low=mid+1;}else high=mid-1;}
    if(best<0||best===0&&offsets.length>1) fail('RESPONSE_UNVERIFIABLE','结果分页元数据超出返回上限。');
    return page(offsets[best]!);
  }
  async cancel(project_id:string,task_id:string) {
    this.project(project_id);const task=this.store.task(task_id);
    if(!task||task.project_id!==project_id) fail('PROJECT_MISMATCH','任务不存在于绑定项目。');
    if(task.status==='completed') return {task_id, status:'already_completed',upstream_stop:'not_needed'};
    if(task.status==='failed') return {task_id, status:'already_failed',upstream_stop:'not_needed'};
    if(task.status==='cancelled') return {task_id, status:'cancelled',upstream_stop:'not_needed'};
    if(task.delivery==='not_sent') {
      this.store.db.prepare("UPDATE tasks SET status='cancelled',cancel_requested=1,updated_at=? WHERE id=?").run(Date.now(),task_id);
      if(BridgeService.activeTaskId===task_id) BridgeService.abort?.abort();
      this.store.event(task_id,'cancelled');
      return {task_id,status:'cancelled',upstream_stop:'not_needed'};
    }
    this.store.db.prepare('UPDATE tasks SET cancel_requested=1,updated_at=? WHERE id=?').run(Date.now(),task_id);
    if(BridgeService.activeTaskId===task_id) BridgeService.abort?.abort();
    const bound=this.store.db.prepare('SELECT conversation_url FROM sessions WHERE id=?').get(task.session_id) as {conversation_url:string|null}|undefined;
    task.conversation_url=bound?.conversation_url??null;
    const confirmed=BridgeService.activeTaskId===task_id&&this.adapter?await this.adapter.requestStop(task):false;
    this.store.db.prepare("UPDATE tasks SET status='paused',pause_reason='CANCEL_UNCONFIRMED',updated_at=? WHERE id=?").run(Date.now(),task_id);
    return {task_id,status:'paused',upstream_stop:confirmed?'confirmed':'unconfirmed'};
  }
  async resume(project_id:string,task_id:string) {
    this.project(project_id);
    const task=this.store.task(task_id);
    if(!task||task.project_id!==project_id) fail('PROJECT_MISMATCH','任务不存在于绑定项目。');
    if(task.status!=='paused') return this.taskSummary(task);
    if(task.delivery==='not_sent') {
      if(task.pause_reason==='CONTEXT_STALE'||task.pause_reason==='WORKSPACE_CHANGED') fail('CONTEXT_STALE','旧工作区或快照已变化，请准备新上下文并创建新请求。');
      this.store.db.prepare("UPDATE tasks SET status='queued',phase='preflight',pause_reason=NULL,updated_at=? WHERE id=?").run(Date.now(),task_id);
      this.store.event(task_id,'queued','EXPLICIT_RESUME');this.kick();
      return this.taskSummary(this.store.task(task_id)!);
    }
    if(BridgeService.active) fail('PROFILE_BUSY','浏览器仍有活动任务。');
    if(!this.adapter) fail('RUNTIME_UNAVAILABLE','浏览器适配器不可用。');
    const session=this.store.db.prepare('SELECT conversation_url,route,epoch,login_epoch FROM sessions WHERE id=?').get(task.session_id) as {conversation_url:string|null;route:string;epoch:number;login_epoch:number}|undefined;
    const project=this.project(project_id,true);
    const profile=this.store.db.prepare("SELECT route,login_epoch FROM profiles WHERE id='default'").get() as {route:string|null;login_epoch:number}|undefined;
    if(!session||session.epoch!==project.epoch||session.route!==profile?.route||session.login_epoch!==profile.login_epoch) fail('PROJECT_MISMATCH','原对话绑定的工作区、账户或网页选项已变化，请人工核对。');
    if(!session?.conversation_url) return {...this.taskSummary(task),next_action:'原对话地址未确认；请人工核对，程序不会重复发送。'};
    task.conversation_url=session.conversation_url;
    BridgeService.active=true;BridgeService.activeTaskId=task.id;BridgeService.abort=new AbortController();
    try {
      const result=await this.adapter.reconcile(task,session.route,BridgeService.abort.signal);
      if(!result) return {...this.taskSummary(task),next_action:'尚未确认原请求的完整回答，保持暂停。'};
      if(conversationUrl(result.conversation_url)!==session.conversation_url) fail('RESPONSE_UNVERIFIABLE','核对结果不属于绑定的对话。');
      if(!result.association_verified||!result.completion_verified||result.route_before!==session.route||result.route_after!==session.route) fail('RESPONSE_UNVERIFIABLE','原回答关联或页面选项无法验证。');
      const text=boundedAnswer(result.text);
      const contentComplete=result.content_complete!==false&&text===result.text;
      const warnings=text===result.text?result.warnings:[...result.warnings,'RESPONSE_TRUNCATED'];
      this.store.transaction(()=>{
        this.store.db.prepare('INSERT OR REPLACE INTO results VALUES(?,?,?,?,?,?,?,?,?,?)').run(task.id,text,sha(text),contentComplete?'complete':'partial',1,result.route_before,result.route_after,1,JSON.stringify(warnings),Date.now());
        this.store.db.prepare("UPDATE tasks SET status=?,phase='capture',delivery='confirmed_sent',pause_reason=?,updated_at=? WHERE id=?").run(contentComplete?'completed':'paused',contentComplete?null:'RESPONSE_PARTIAL',Date.now(),task.id);
        this.store.db.prepare("UPDATE sessions SET state='ready' WHERE id=?").run(task.session_id);
        this.store.event(task.id,contentComplete?'completed':'paused',contentComplete?'RECONCILED':'RESPONSE_PARTIAL');
      });
      return this.taskSummary(this.store.task(task.id)!);
    } finally {BridgeService.active=false;BridgeService.activeTaskId=null;BridgeService.abort=undefined;this.kick();}
  }
  bindConversationCandidate(project_id:string,task_id:string,url:string) {
    const project=this.project(project_id,true);
    const task=this.store.task(task_id);
    if(!task||task.project_id!==project_id) fail('PROJECT_MISMATCH','任务不存在于绑定项目。');
    if(task.status!=='paused'||task.delivery==='not_sent') fail('INVALID_INPUT','仅能为已发送或可能已发送的暂停任务指定待核对对话。');
    const session=this.store.db.prepare('SELECT project_id,epoch,login_epoch,route,conversation_url,state FROM sessions WHERE id=?').get(task.session_id) as {project_id:string;epoch:number;login_epoch:number;route:string;conversation_url:string|null;state:string}|undefined;
    const profile=this.store.db.prepare("SELECT route,login_epoch FROM profiles WHERE id='default'").get() as {route:string|null;login_epoch:number}|undefined;
    if(!session||session.project_id!==project_id||session.epoch!==project.epoch||session.route!==profile?.route||session.login_epoch!==profile.login_epoch) fail('PROJECT_MISMATCH','原对话绑定的工作区、账户或网页选项已变化。');
    const candidate=conversationUrl(url);
    if(session.conversation_url&&session.state!=='candidate') fail('PROJECT_MISMATCH','原对话地址已由运行器确认，不允许替换。');
    this.store.db.prepare("UPDATE sessions SET conversation_url=?,state='candidate' WHERE id=?").run(candidate,task.session_id);
    return {task_id,session_id:task.session_id,candidate_url:candidate,verified:false,next_action:'请运行 tasks resume 核对原请求标记与回答；不会重新发送。'};
  }
  abandon(project_id:string,task_id:string) {
    this.project(project_id);
    const task=this.store.task(task_id);
    if(!task||task.project_id!==project_id) fail('PROJECT_MISMATCH','任务不存在于绑定项目。');
    if(BridgeService.activeTaskId===task_id) fail('PROFILE_BUSY','任务仍在执行，请先等待其暂停。');
    if(!['paused','failed'].includes(task.status)||task.delivery==='not_sent') fail('INVALID_INPUT','仅能放弃已发送或可能已发送的暂停任务。');
    if(task.pause_reason==='USER_ABANDONED') return this.taskSummary(task);
    this.store.transaction(()=>{
      this.store.db.prepare("UPDATE tasks SET status='failed',pause_reason='USER_ABANDONED',cancel_requested=1,updated_at=? WHERE id=?").run(Date.now(),task_id);
      this.store.event(task_id,'failed','USER_ABANDONED');
    });
    this.kick();
    return this.taskSummary(this.store.task(task_id)!);
  }
  approve(project_id:string,task_id:string,expectedHash:string) {
    this.project(project_id,true);
    const task=this.store.task(task_id); if(!task) fail('TASK_NOT_FOUND','任务不存在。');
    if(task.project_id!==project_id) fail('PROJECT_MISMATCH','任务不存在于绑定项目。');
    if(task.status!=='awaiting_approval') fail('APPROVAL_EXPIRED','任务已不再等待批准。');
    if(task.payload_sha256!==expectedHash) fail('APPROVAL_EXPIRED','外发内容已变化。');
    if(Date.now()-task.created_at>86400000) fail('APPROVAL_EXPIRED','批准窗口已过期。');
    const profile=this.store.db.prepare("SELECT route,login_epoch FROM profiles WHERE id='default'").get() as {route:string;login_epoch:number}|undefined;
    if(!profile?.route) fail('ROUTE_UNAVAILABLE','网页选项已失效。');
    this.store.transaction(()=>{
      this.store.db.prepare('INSERT INTO grants(id,project_id,task_id,payload_sha256,route,login_epoch,paths,remaining,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(`gr_${randomUUID()}`,task.project_id,task.id,expectedHash,profile.route,profile.login_epoch,'[]',1,Date.now()+86400000);
      this.store.db.prepare("UPDATE tasks SET status='queued',updated_at=? WHERE id=?").run(Date.now(),task_id);this.store.event(task_id,'queued');
    });this.kick();
  }
  authorizeSession(project_id:string,paths:string[],minutes:number,maxSends:number) {
    this.project(project_id);
    if(!Number.isInteger(minutes)||minutes<1||minutes>60||!Number.isInteger(maxSends)||maxSends<1||maxSends>3) fail('INVALID_INPUT','授权期限或次数超出范围。');
    if(!Array.isArray(paths)||paths.length>20) fail('INVALID_INPUT','授权路径数量无效。');
    paths=paths.map(checkRelativePath);
    const profile=this.store.db.prepare("SELECT route,login_epoch FROM profiles WHERE id='default'").get() as {route:string;login_epoch:number}|undefined;
    if(!profile?.route) fail('ROUTE_UNAVAILABLE','先配置可见网页选项。');
    const id=`gr_${randomUUID()}`;
    this.store.db.prepare('INSERT INTO grants(id,project_id,route,login_epoch,paths,remaining,expires_at) VALUES(?,?,?,?,?,?,?)').run(id,project_id,profile.route,profile.login_epoch,JSON.stringify(paths),maxSends,Date.now()+minutes*60000);
    return {grant_id:id,project_id,route:profile.route,paths,remaining:maxSends,expires_at:Date.now()+minutes*60000};
  }
  revokeGrant(project_id:string,grant_id:string) {
    this.project(project_id);
    const grant=this.store.db.prepare('SELECT id,project_id FROM grants WHERE id=?').get(grant_id) as {id:string;project_id:string}|undefined;
    if(!grant||grant.project_id!==project_id) fail('PROJECT_MISMATCH','授权不存在于绑定项目。');
    this.store.db.prepare('UPDATE grants SET remaining=0 WHERE id=?').run(grant_id);
    return {grant_id,project_id,revoked:true};
  }
  kick() { if(!BridgeService.active&&!BridgeService.stopping) void this.runNext(); }
  private async runNext() {
    if(BridgeService.active||BridgeService.stopping||!this.adapter) return;
    const unresolved=this.store.db.prepare(`SELECT id FROM tasks WHERE ${queueBlockingDeliverySql} LIMIT 1`).get();
    if(unresolved)return;
    const row=this.store.db.prepare("SELECT id FROM tasks WHERE status='queued' ORDER BY created_at LIMIT 1").get() as {id:string}|undefined;
    if(!row) return; BridgeService.active=true;BridgeService.activeTaskId=row.id;BridgeService.abort=new AbortController();
    try {
      const task=this.store.task(row.id)!;
      const boundSession=this.store.db.prepare('SELECT conversation_url FROM sessions WHERE id=?').get(task.session_id) as {conversation_url:string|null}|undefined;
      task.conversation_url=boundSession?.conversation_url??null;
      const packet=task.packet_id?this.store.packet(task.packet_id):undefined;
      const project=this.workspace(task.project_id,true);
      if(!project) fail('WORKSPACE_UNBOUND','任务所属项目已停用。');
      const session=this.store.db.prepare('SELECT epoch,login_epoch,route FROM sessions WHERE id=?').get(task.session_id) as {epoch:number;login_epoch:number;route:string}|undefined;
      if(!session||session.epoch!==project.epoch) fail('WORKSPACE_CHANGED','任务所属工作区已变化。');
      if(task.packet_id&&!packet) fail('CONTEXT_STALE','上下文快照已过期。');
      if(packet && (await computeRevision(project.root,packet.manifest,packet.diff_mode))!==packet.revision) fail('CONTEXT_STALE','所选文件、差异或分支已变化。');
      const profile=this.store.db.prepare("SELECT route,login_epoch FROM profiles WHERE id='default'").get() as {route:string;login_epoch:number}|undefined;
      if(!profile?.route) fail('ROUTE_UNAVAILABLE','网页选项未配置。');
      if(session.route!==profile.route||session.login_epoch!==profile.login_epoch) fail('ROUTE_UNAVAILABLE','任务绑定的网页选项或登录状态已变化。');
      this.store.db.prepare("UPDATE tasks SET status='running',phase='compose',updated_at=? WHERE id=?").run(Date.now(),task.id);
      const result=await this.adapter.execute(task,profile.route,async()=>{
        if(task.packet_id) {
          const currentPacket=this.store.packet(task.packet_id);
          if(!currentPacket||(await computeRevision(project.root,currentPacket.manifest,currentPacket.diff_mode))!==currentPacket.revision) fail('CONTEXT_STALE','发送前上下文快照已变化。');
        }
        this.store.transaction(()=>{
          const current=this.store.db.prepare("SELECT route,login_epoch FROM profiles WHERE id='default'").get() as {route:string;login_epoch:number}|undefined;
          if(!current||current.route!==profile.route||current.login_epoch!==session.login_epoch) fail('ROUTE_UNAVAILABLE','网页选项或登录状态已变化。');
          const currentProject=this.store.project(task.project_id);
          if(!currentProject||currentProject.epoch!==session.epoch||rootIdentity(currentProject.root)!==currentProject.identity||currentBranch(currentProject.root)!==project.branch) fail('WORKSPACE_CHANGED','发送前工作区已变化。');
          const latest=this.store.task(task.id);
          if(!latest||latest.cancel_requested||latest.status!=='running') fail('CANCEL_UNCONFIRMED','任务已请求取消，未执行网页发送。');
          const packet=task.packet_id?this.store.packet(task.packet_id):undefined;
          const allowed=packet?.manifest.map(x=>x.path)??[];
          const possible=this.store.db.prepare('SELECT id,task_id,payload_sha256,paths FROM grants WHERE project_id=? AND route=? AND login_epoch=? AND remaining>0 AND expires_at>? ORDER BY CASE WHEN task_id=? THEN 0 ELSE 1 END').all(task.project_id,current.route,current.login_epoch,Date.now(),task.id) as {id:string;task_id:string|null;payload_sha256:string|null;paths:string|null}[];
          const grant=possible.find(g=>g.task_id===task.id?g.payload_sha256===task.payload_sha256:g.task_id===null&&allowed.every(p=>(JSON.parse(g.paths??'[]') as string[]).includes(p)));
          if(!grant) fail('APPROVAL_EXPIRED','发送授权已失效。');
          this.store.db.prepare('UPDATE grants SET remaining=remaining-1 WHERE id=?').run(grant.id);
          this.store.db.prepare("UPDATE tasks SET phase='submit',delivery='maybe_sent',updated_at=? WHERE id=?").run(Date.now(),task.id);this.store.event(task.id,'running','SEND_INTENT');
        });
      },(confirmedConversationUrl)=>{
        this.store.transaction(()=>{
          this.store.db.prepare("UPDATE tasks SET phase='wait',delivery='confirmed_sent',updated_at=? WHERE id=?").run(Date.now(),task.id);
          if(confirmedConversationUrl)this.store.db.prepare('UPDATE sessions SET conversation_url=? WHERE id=?').run(conversationUrl(confirmedConversationUrl),task.session_id);
          this.store.event(task.id,'running','USER_MESSAGE_CONFIRMED');
        });
      },BridgeService.abort.signal);
      if(this.store.task(task.id)?.delivery!=='confirmed_sent') fail('DELIVERY_UNKNOWN','未确认本次用户消息，不能把回答标为完成。');
      const resultUrl=conversationUrl(result.conversation_url);
      const confirmedUrl=this.store.db.prepare('SELECT conversation_url FROM sessions WHERE id=?').get(task.session_id) as {conversation_url:string|null}|undefined;
      if(confirmedUrl?.conversation_url&&confirmedUrl.conversation_url!==resultUrl) fail('RESPONSE_UNVERIFIABLE','回答所属对话与提交确认不一致。');
      const text=boundedAnswer(result.text);
      const warnings=text===result.text?result.warnings:[...result.warnings,'RESPONSE_TRUNCATED'];
      const routeOk=result.route_before===profile.route&&result.route_after===profile.route;
      const verified=result.association_verified&&result.completion_verified&&routeOk;
      const completeness=text===result.text&&result.completion_verified&&result.content_complete!==false?'complete':'partial';
      const pauseReason=!routeOk?'ROUTE_CHANGED_AFTER_SEND':!result.association_verified?'RESPONSE_UNVERIFIABLE':completeness==='partial'?'RESPONSE_PARTIAL':null;
      this.store.transaction(()=>{
        this.store.db.prepare('INSERT INTO results VALUES(?,?,?,?,?,?,?,?,?,?)').run(task.id,text,sha(text),completeness,result.association_verified?1:0,result.route_before,result.route_after,result.completion_verified?1:0,JSON.stringify(warnings),Date.now());
        this.store.db.prepare("UPDATE tasks SET status=?,phase='capture',delivery='confirmed_sent',pause_reason=?,updated_at=? WHERE id=?").run(verified&&completeness==='complete'?'completed':'paused',pauseReason,Date.now(),task.id);
        this.store.db.prepare("UPDATE sessions SET conversation_url=?,state='ready' WHERE id=?").run(resultUrl,task.session_id);
        this.store.event(task.id,verified&&completeness==='complete'?'completed':'paused',pauseReason);
      });
    } catch(e) {
      const code=e instanceof Error && 'code' in e ? String(e.code) : 'RUNTIME_INTERRUPTED';
      const task=this.store.task(row.id)!;
      if(task.status==='cancelled') return;
      const reason=code==='OBSERVATION_TIMEOUT'?'OBSERVATION_TIMEOUT':task.delivery==='maybe_sent'?'DELIVERY_UNKNOWN':code;
      this.store.db.prepare("UPDATE tasks SET status='paused',phase='reconcile',pause_reason=?,updated_at=? WHERE id=?").run(reason,Date.now(),row.id);
      this.store.event(row.id,'paused',reason);
    } finally {BridgeService.active=false;BridgeService.activeTaskId=null;BridgeService.abort=undefined;this.kick();}
  }
}
