#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { realpath } from 'node:fs/promises';
import { setup } from './setup.js';
import { uninstall } from './uninstall.js';
import { purgeLocalData } from './purge.js';
import { serve } from '../mcp/server.js';
import { startRuntime, callRuntime, stopAndWaitRuntime } from '../runtime/ipc.js';
import { BridgeError, safeError, fail } from '../security/errors.js';
import { environmentCheck } from './environment.js';

function flag(name:string) {const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:undefined;}
async function main() {
  const cmd=process.argv[2];
  if(cmd==='runtime') return startRuntime();
  if(cmd==='serve') {const id=flag('--project');if(!id&&!process.argv.includes('--auto'))fail('INVALID_INPUT','缺少 --project 或 --auto。');return serve(id??null);}
  if(cmd==='setup'||cmd==='project'&&process.argv[3]==='init') {const result=await setup(flag('--root')??process.cwd());process.stdout.write(JSON.stringify(result)+'\n');return;}
  if(cmd==='uninstall'||cmd==='project'&&process.argv[3]==='remove') {const result=await uninstall(flag('--root')??process.cwd());process.stdout.write(JSON.stringify(result)+'\n');return;}
  if(cmd==='purge') {
    process.stdout.write('将删除 Codex Pro Bridge 的本地任务数据库、升级备份和专用浏览器资料。网页聊天与项目配置不会因此删除；已发送内容无法撤回。\n');
    if(!process.stdin.isTTY)fail('APPROVAL_REQUIRED','清除本地数据需要交互终端确认。');
    const rl=createInterface({input:process.stdin,output:process.stdout});const answer=await rl.question('输入 purge 确认删除：');rl.close();
    if(answer.trim()!=='purge')return;
    try {await callRuntime('','runtime_state',{},false);await callRuntime('','shutdown',{confirm_active:true},false);}
    catch(e){if(!(e instanceof BridgeError&&e.code==='RUNTIME_UNAVAILABLE'))throw e;}
    for(let attempt=0;attempt<10;attempt++) {
      try {process.stdout.write(JSON.stringify(await purgeLocalData(),null,2)+'\n');return;}
      catch(e){if(!(e instanceof BridgeError&&e.code==='PROFILE_BUSY')||attempt===9)throw e;await new Promise(resolve=>setTimeout(resolve,200));}
    }
    return;
  }
  if(cmd==='project'&&process.argv[3]==='list') {process.stdout.write(JSON.stringify(await callRuntime('','project_list'),null,2)+'\n');return;}
  if(cmd==='doctor') {
    const local=await environmentCheck(),runtime=await callRuntime('','doctor');
    if(process.argv.includes('--live')) {
      const selected=flag('--project');
      const bound=selected?null:await callRuntime('','project_for_root',{root:await realpath(flag('--root')??process.cwd())}) as {id:string}|null;
      const project=selected??bound?.id;
      if(!project)fail('WORKSPACE_UNBOUND','当前目录未注册项目，请指定 --project。');
      const live=await callRuntime(project,'status',{live:true});
      process.stdout.write(JSON.stringify({...local,...runtime,live_status:live},null,2)+'\n');
    } else process.stdout.write(JSON.stringify({...local,...runtime},null,2)+'\n');
    return;
  }
  if(cmd==='shutdown') {
    let state:{active:boolean};
    try {state=await callRuntime('','runtime_state',{},false) as {active:boolean};}
    catch(e){if(e instanceof BridgeError&&e.code==='RUNTIME_UNAVAILABLE'){process.stdout.write('{"already_stopped":true}\n');return;}throw e;}
    if(state.active) {
      process.stdout.write('运行器仍有活动任务。停止可能中断网页等待；已发送内容不会撤回，下次启动将保留待核对状态。\n');
      if(!process.stdin.isTTY)fail('APPROVAL_REQUIRED','活动任务停止需要本地交互终端确认。');
      const rl=createInterface({input:process.stdin,output:process.stdout});const answer=await rl.question('输入 shutdown 确认停止：');rl.close();
      if(answer.trim()!=='shutdown')return;
    }
    process.stdout.write(JSON.stringify(await stopAndWaitRuntime(state.active))+'\n');return;
  }
  if(cmd==='login') {process.stdout.write(JSON.stringify(await callRuntime('','login'),null,2)+'\n');return;}
  if(cmd==='agent') {
    const action=process.argv[3];
    const ops:Record<string,string>={'bind-route':'agent_bind_route',claim:'agent_claim',intent:'agent_send_intent',sent:'agent_confirm_sent',complete:'agent_complete',pause:'agent_pause',uncertain:'agent_uncertain',heartbeat:'agent_heartbeat'};
    if(!action||!ops[action])fail('INVALID_INPUT','未知 Agent 浏览器操作。');
    const project=flag('--project')??'';
    if(action!=='bind-route'&&!project)fail('INVALID_INPUT','缺少 --project。');
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of process.stdin) {
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
      size+=bytes.length;if(size>240*1024)fail('INVALID_INPUT','Agent 请求超过大小上限。');
      chunks.push(bytes);
    }
    let raw:string;
    try {raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,size));}catch{fail('INVALID_INPUT','Agent 请求不是有效 UTF-8。');}
    let args:Record<string,unknown>;
    try {args=JSON.parse(raw) as Record<string,unknown>;}catch{fail('INVALID_INPUT','Agent 请求 JSON 无效。');}
    if(!args||typeof args!=='object'||Array.isArray(args))fail('INVALID_INPUT','Agent 请求格式无效。');
    process.stdout.write(JSON.stringify(await callRuntime(project,ops[action],args),null,2)+'\n');return;
  }
  if(cmd==='route'&&process.argv[3]==='configure') {
    const selected=await callRuntime('','route_inspect') as {selected_display:string};
    process.stdout.write(`专用浏览器当前可见选项：${selected.selected_display}\n`);
    if(!process.stdin.isTTY)fail('APPROVAL_REQUIRED','配置路线需要本地交互终端。');
    const rl=createInterface({input:process.stdin,output:process.stdout});const answer=await rl.question('输入 configure 记录该选项：');rl.close();
    if(answer.trim()==='configure')process.stdout.write(JSON.stringify(await callRuntime('','route_configure',selected))+'\n');
    return;
  }
  if(cmd==='authorize-session') {
    const project=flag('--project');if(!project)fail('INVALID_INPUT','缺少 --project。');
    const paths=(flag('--paths')??'').split(',').filter(Boolean);
    const minutes=Number(flag('--minutes')??60),max_sends=Number(flag('--max-sends')??3);
    process.stdout.write(`项目：${project}\n允许路径：${paths.join(', ')||'(纯文本问题，不含文件)'}\n期限：${minutes} 分钟；最多：${max_sends} 次网页发送。\n`);
    if(!process.stdin.isTTY)fail('APPROVAL_REQUIRED','限时授权需要本地交互终端。');
    const rl=createInterface({input:process.stdin,output:process.stdout});const answer=await rl.question('输入 authorize 创建授权：');rl.close();
    if(answer.trim()==='authorize')process.stdout.write(JSON.stringify(await callRuntime(project,'authorize_session',{paths,minutes,max_sends}))+'\n');
    return;
  }
  if(cmd==='revoke') {
    const project=flag('--project'),grant_id=process.argv[3];
    if(!project||!grant_id)fail('INVALID_INPUT','需要授权编号和 --project 项目编号。');
    process.stdout.write(JSON.stringify(await callRuntime(project,'revoke',{grant_id}),null,2)+'\n');return;
  }
  if(cmd==='sessions'&&process.argv[3]==='reconcile') {
    const taskId=process.argv[4];
    if(!taskId||process.argv[5])fail('INVALID_INPUT','需要任务编号；对话地址须在交互终端中粘贴。');
    const task=await callRuntime('','lookup_task',{task_id:taskId}) as {project_id:string}|null;
    if(!task)fail('TASK_NOT_FOUND','任务不存在。');
    if(!process.stdin.isTTY)fail('APPROVAL_REQUIRED','绑定候选对话需要本地交互终端确认。');
    const rl=createInterface({input:process.stdin,output:process.stdout});
    const url=(await rl.question('粘贴官方对话地址：')).trim();
    process.stdout.write(`项目：${task.project_id}\n任务：${taskId}\n待核对地址：${url}\n此步骤仅绑定候选地址；后续 tasks resume 才会核对页面，不会重新发送。\n`);
    const answer=await rl.question('输入 reconcile 继续：');rl.close();
    if(answer.trim()==='reconcile')process.stdout.write(JSON.stringify(await callRuntime(task.project_id,'bind_conversation',{task_id:taskId,url}),null,2)+'\n');
    return;
  }
  if(cmd==='tasks'&&process.argv[3]==='list') {
    const project=flag('--project');if(!project)fail('INVALID_INPUT','需要 --project 项目编号。');
    process.stdout.write(JSON.stringify(await callRuntime(project,'task_list'),null,2)+'\n');return;
  }
  const taskId=cmd==='tasks'&&['show','resume','cancel','abandon'].includes(process.argv[3]??'')?process.argv[4]:process.argv[3];
  if((cmd==='approve'||cmd==='tasks')&&taskId) {
    const task=await callRuntime('','lookup_task',{task_id:taskId}) as {project_id:string}|null;
    if(!task)fail('TASK_NOT_FOUND','任务不存在。');
    if(cmd==='approve') {
      const preview=await callRuntime(task.project_id,'preview',{task_id:taskId});
      process.stdout.write(`目标选项：${JSON.stringify(preview.route)}\nSHA-256: ${preview.payload_sha256}\n\n完整外发内容：\n${preview.payload}\n\n`);
      if(!process.stdin.isTTY) fail('APPROVAL_REQUIRED','批准需要在本地交互终端完成。');
      const rl=createInterface({input:process.stdin,output:process.stdout});const answer=await rl.question('输入 approve 批准本次精确内容：');rl.close();
      if(answer.trim()!=='approve') return;
      process.stdout.write(JSON.stringify(await callRuntime(task.project_id,'approve',{task_id:taskId,payload_sha256:preview.payload_sha256}))+'\n');return;
    }
    if(cmd==='tasks'&&process.argv[3]==='resume') {process.stdout.write(JSON.stringify(await callRuntime(task.project_id,'resume',{task_id:taskId}),null,2)+'\n');return;}
    if(cmd==='tasks'&&process.argv[3]==='cancel') {process.stdout.write(JSON.stringify(await callRuntime(task.project_id,'cancel',{task_id:taskId}),null,2)+'\n');return;}
    if(cmd==='tasks'&&process.argv[3]==='abandon') {
      const current=await callRuntime(task.project_id,'get_task',{task_id:taskId,wait_ms:0});
      process.stdout.write(`任务 ${taskId}：${current.status} / ${current.delivery}。放弃后仍保留真实的发送不确定性；此操作只停止本地核对并释放队列，不撤回网页内容。\n`);
      if(!process.stdin.isTTY)fail('APPROVAL_REQUIRED','放弃任务需要本地交互终端确认。');
      const rl=createInterface({input:process.stdin,output:process.stdout});const answer=await rl.question('输入 abandon 放弃原任务：');rl.close();
      if(answer.trim()==='abandon')process.stdout.write(JSON.stringify(await callRuntime(task.project_id,'abandon',{task_id:taskId}),null,2)+'\n');
      return;
    }
    process.stdout.write(JSON.stringify(await callRuntime(task.project_id,'get_task',{task_id:taskId}),null,2)+'\n');return;
  }
  process.stdout.write('用法：codex-pro-bridge setup [--root 路径] | uninstall [--root 路径] | purge | doctor [--live] [--project ID] | shutdown | login | route configure | project init/list/remove [--root 路径] | authorize-session --project ID [--paths a,b] [--minutes 60] [--max-sends 3] | revoke GRANT_ID --project ID | serve --project ID | approve TASK_ID | tasks list --project ID | tasks show TASK_ID | tasks resume TASK_ID | tasks cancel TASK_ID | tasks abandon TASK_ID | sessions reconcile TASK_ID | agent bind-route/claim/intent/sent/complete/pause/uncertain/heartbeat [--project ID] < JSON\n');
}
main().catch(e=>{process.stderr.write(JSON.stringify(safeError(e))+'\n');process.exitCode=1;});
