import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { callRuntime } from '../runtime/ipc.js';
import { fail, safeError } from '../security/errors.js';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { ensurePrivateDir, isProjectlessRoot, projectlessRoot } from '../state/paths.js';

export async function serve(projectId:string|null) {
  const server=new McpServer({name:'codex-pro-bridge',version:'0.1.0-alpha.1'},{instructions:'复杂任务可按当前网页账户实际可用的最高高推理档位协作；基础问题由 Codex 直接回答。页面显示 High 就标注 High，显示 6 Pro 才标注 6 Pro，不推断后台模型。有项目时绑定真实根目录；无项目纯文字对话省略 root。外发前须有本地单次批准或对应范围的有限授权。Agent 模式使用 Codex Computer Use 操作已登录的 Chrome，按 Skill 执行发送账本；暂停或提交未知时不得换 request_key 重发。'});
  let boundProjectId=projectId;
  let boundProjectless=false;
  const clientId=randomUUID();
  if(!projectId) server.registerTool('codex_pro_bind_project',{description:'有项目时传当前 Codex 项目的真实根目录；无项目的纯文字对话省略 root。此调用不会向网页发送内容。',inputSchema:{root:z.string().min(1).optional()},outputSchema:{project_id:z.string(),root:z.string(),active:z.boolean()},annotations:{readOnlyHint:false,destructiveHint:false}},async({root:requestedRoot})=>{
    try {
      const projectless=requestedRoot===undefined;
      if(projectless) await ensurePrivateDir(projectlessRoot());
      const root=await realpath(projectless?projectlessRoot():requestedRoot);
      if(!projectless&&(!(await stat(root)).isDirectory()||root===path.parse(root).root||root===homedir()||root===path.dirname(homedir())||isProjectlessRoot(root))) fail('INVALID_INPUT','项目根目录过宽或不是文件夹。');
      if(boundProjectId) {
        if(boundProjectless!==projectless) fail('PROJECT_MISMATCH','此 MCP 连接已绑定另一类任务。');
        const existing=await callRuntime('','project_for_root',{root}) as {id:string}|null;
        if(existing?.id!==boundProjectId) fail('PROJECT_MISMATCH','此 MCP 连接已绑定另一个项目。');
        const result={project_id:boundProjectId,root,active:true};
        return {content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result};
      }
      const existing=await callRuntime('','project_for_root',{root}) as {id:string}|null;
      const id=existing?.id??`prj_${randomUUID()}`;
      await callRuntime('','register_project',{root,id});
      await callRuntime(id,'client_attach',{id:clientId});
      boundProjectId=id;
      boundProjectless=projectless;
      const result={project_id:id,root,active:true};
      return {content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result};
    } catch(e) {const error=safeError(e);return {isError:true,content:[{type:'text' as const,text:JSON.stringify(error)}]};}
  });
  const response=async(op:string,args:Record<string,unknown>)=>{
    try {
      if(!boundProjectId) fail('WORKSPACE_UNBOUND','请先绑定当前项目；无项目的纯文字对话可省略 root。');
      if(args.project_id&&args.project_id!==boundProjectId) fail('PROJECT_MISMATCH','工具调用的项目与当前任务绑定不一致。');
      if(boundProjectless&&(op==='prepare'||op==='ask'&&args.context_packet_id)) fail('CONTEXT_BLOCKED','无项目对话只支持纯文字问题。');
      const runtimeArgs=op==='ask'?{...args,auto_text_opt_in:process.env.CODEX_PRO_BRIDGE_AUTO_TEXT==='1'}:args;
      const result=await callRuntime(boundProjectId,op,runtimeArgs);return {content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result};
    }
    catch(e){const error=safeError(e);return {isError:true,content:[{type:'text' as const,text:JSON.stringify(error)}],...(projectId?{structuredContent:error}:{})};}
  };
  const project=projectId?z.literal(projectId):z.string().min(1);
  const taskStatus=z.enum(['awaiting_approval','queued','running','paused','completed','failed','cancelled']);
  const delivery=z.enum(['not_sent','maybe_sent','confirmed_sent']);
  const summary=z.object({task_id:z.string(),status:taskStatus,phase:z.string(),delivery,session_id:z.string(),payload_sha256:z.string(),pause_reason:z.string().nullable(),next_poll_after_ms:z.number()});
  const taskOutput=summary.extend({approval_required:z.boolean().optional(),next_action:z.string().optional(),error:z.string().optional(),warnings:z.array(z.string()).optional(),route:z.object({requested_display:z.string().nullable(),selected_before:z.string(),selected_after:z.string(),ui_selection_verified:z.boolean(),backend_model_verified:z.boolean()}).optional(),answer:z.object({completeness:z.enum(['partial','complete']),association_verified:z.boolean(),format:z.literal('markdown'),text:z.string(),next_cursor:z.string().nullable(),response_sha256:z.string()}).optional()});
  server.registerTool('codex_pro_status',{description:'读取绑定项目和网页状态。Agent 模式下 live 要求 Codex 另行观察现有 Chrome，不会自行读取浏览器或发送问题。',inputSchema:{project_id:project,live:z.boolean().default(false)},outputSchema:{project_id:project,version:z.string(),stale:z.boolean(),live:z.boolean(),browser_mode:z.enum(['agent','playwright']).optional(),web_automation_enabled:z.boolean(),limitations:z.array(z.string()),route:z.string().nullable(),observed_at:z.number().nullable(),logged_in:z.boolean().optional(),error:z.string().optional()},annotations:{readOnlyHint:true}},({project_id,live})=>response('status',{project_id,live}));
  server.registerTool('codex_pro_prepare_context',{description:'在绑定项目内准备明确文件片段与 Git 差异，生成不可变快照。',inputSchema:{project_id:project,files:z.array(z.object({path:z.string(),start_line:z.number().int().optional(),end_line:z.number().int().optional()})).max(20),diff:z.enum(['none','staged','unstaged','both']),notes:z.string().optional()},outputSchema:{packet_id:z.string(),packet_sha256:z.string(),manifest:z.array(z.object({path:z.string(),start_line:z.number().optional(),end_line:z.number().optional()})),total_bytes:z.number(),scan_status:z.string(),snapshot_revision:z.string(),preview:z.string(),preview_truncated:z.boolean()},annotations:{readOnlyHint:false,destructiveHint:false}},({project_id,files,diff,notes})=>response('prepare',{project_id,files,diff,notes}));
  server.registerTool('codex_pro_ask',{description:'冻结外发消息并创建任务；实际发送须本地授权。',inputSchema:{project_id:project,request_key:z.string().min(1).max(128),question:z.string().min(1),mode:z.enum(['ask','plan','review','debug']),context_packet_id:z.string().optional(),session:z.union([z.object({kind:z.literal('new')}),z.object({kind:z.literal('continue'),session_id:z.string()})])},outputSchema:taskOutput,annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}},(args)=>response('ask',args));
  server.registerTool('codex_pro_get_task',{description:'只读取本地任务状态与回答分页，不触发网页发送。',inputSchema:{project_id:project,task_id:z.string(),wait_ms:z.number().int().min(0).max(20000).default(0),cursor:z.string().optional()},outputSchema:taskOutput,annotations:{readOnlyHint:true}},({project_id,task_id,cursor,wait_ms})=>response('get_task',{project_id,task_id,cursor,wait_ms}));
  server.registerTool('codex_pro_record_answer',{description:'仅在 Computer Use 已核对本次网页回答、正式对话地址和完成状态后，将完整正文直接写入本地任务。不会向网页发送消息。',inputSchema:{project_id:project,task_id:z.string(),url:z.string().url(),text:z.string().min(1),route:z.string().min(1),account_label:z.string().min(1),association_verified:z.literal(true),completion_verified:z.literal(true),content_complete:z.boolean(),warnings:z.array(z.string()).max(20).optional()},outputSchema:{task_id:z.string(),status:z.enum(['completed','paused']),delivery:z.literal('confirmed_sent')},annotations:{readOnlyHint:false,destructiveHint:false}},(args)=>response('agent_complete',args));
  server.registerTool('codex_pro_cancel',{description:'取消未发送任务，或尽力停止已发送任务；不会撤回已发送内容。',inputSchema:{project_id:project,task_id:z.string()},outputSchema:{task_id:z.string(),status:z.string(),upstream_stop:z.enum(['not_needed','confirmed','unconfirmed'])},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}},({project_id,task_id})=>response('cancel',{project_id,task_id}));
  if(projectId)await callRuntime(projectId,'client_attach',{id:clientId});
  const heartbeat=setInterval(()=>{if(boundProjectId)void callRuntime(boundProjectId,'client_heartbeat',{id:clientId}).catch(()=>{});},60_000);heartbeat.unref();
  const transport=new StdioServerTransport();
  transport.onclose=()=>{clearInterval(heartbeat);if(boundProjectId)void callRuntime(boundProjectId,'client_detach',{id:clientId},false).catch(()=>{});};
  try {await server.connect(transport);}
  catch(error) {clearInterval(heartbeat);if(boundProjectId)await callRuntime(boundProjectId,'client_detach',{id:clientId},false).catch(()=>{});throw error;}
}
