import { realpath, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { parse as parseToml } from '@iarna/toml';
import { callRuntime } from '../runtime/ipc.js';
import { fail } from '../security/errors.js';
import { checkedConfigPath, writeConfigAtomically } from './config-files.js';

export function removeOwnConfig(prior:string,projectId:string) {
  const parsed=parseToml(prior) as Record<string,any>;
  const block=parsed.mcp_servers?.['codex-pro-bridge'];
  if(!block||!Array.isArray(block.args)||!block.args.includes('serve')||!block.args.includes(projectId)) fail('CONFIG_CONFLICT','现有配置不匹配本项目注册，未修改。');
  const lines=prior.split('\n');
  const start=lines.findIndex(x=>x.trim()==='[mcp_servers.codex-pro-bridge]');
  if(start<0) fail('CONFIG_CONFLICT','找不到本产品的独立配置段。');
  let end=start+1;
  while(end<lines.length&&!/^\s*\[/.test(lines[end]!))end++;
  const next=[...lines.slice(0,start),...lines.slice(end)].join('\n').replace(/\n{3,}/g,'\n\n');
  parseToml(next);
  return next;
}
export async function uninstall(rootArg:string) {
  const root=await realpath(rootArg);
  const existing=await callRuntime('','project_for_root',{root}) as {id:string}|null;
  if(!existing)fail('WORKSPACE_UNBOUND','项目未注册。');
  const config=await checkedConfigPath(root);
  const prior=await readFile(config,'utf8').catch(()=>fail('CONFIG_CONFLICT','项目配置不存在。'));
  const next=removeOwnConfig(prior,existing.id);
  process.stdout.write(`将移除 ${config} 中 Codex Pro Bridge 的 MCP 配置，并停用项目 ${existing.id}。本地任务记录和专用浏览器资料不会在此步骤删除。\n`);
  if(!process.stdin.isTTY)fail('APPROVAL_REQUIRED','卸载需要本地交互终端确认。');
  const rl=createInterface({input:process.stdin,output:process.stdout});const answer=await rl.question('输入 uninstall 继续：');rl.close();
  if(answer.trim()!=='uninstall')return {applied:false};
  await callRuntime('','deactivate_project',{root});
  try {
    await checkedConfigPath(root);
    await writeConfigAtomically(config,prior,next);
  } catch(e) {await callRuntime('','register_project',{root,id:existing.id});throw e;}
  return {applied:true,project_id:existing.id,config};
}
