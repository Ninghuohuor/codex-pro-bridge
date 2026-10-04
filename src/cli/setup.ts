import { randomUUID } from 'node:crypto';
import { realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as parseToml } from '@iarna/toml';
import { ensurePrivateDir } from '../state/paths.js';
import { fail } from '../security/errors.js';
import { callRuntime } from '../runtime/ipc.js';
import { environmentCheck } from './environment.js';
import { checkedConfigPath, writeConfigAtomically } from './config-files.js';

const execFileAsync=promisify(execFile);
export async function isTrackedConfig(root:string):Promise<boolean> {
  try {
    await execFileAsync('git',['-C',root,'ls-files','--error-unmatch','--cached','--','.codex/config.toml'],{timeout:5000,maxBuffer:4096});
    return true;
  } catch {return false;}
}

export async function finalizeSetup(root:string,projectId:string,wasActive:boolean,config:string,prior:string,next:string,runtimeCall:typeof callRuntime=callRuntime) {
  await runtimeCall('','register_project',{root,id:projectId});
  try {
    await checkedConfigPath(root,true);
    await writeConfigAtomically(config,prior,next);
  } catch(error) {
    if(!wasActive) {
      try {await runtimeCall('','deactivate_project',{root});}
      catch {fail('RUNTIME_UNAVAILABLE','配置写入失败，项目注册也未能撤销；请运行 doctor 检查。');}
    }
    throw error;
  }
}

export async function setup(rootArg:string) {
  const root=await realpath(rootArg);
  const environment=await environmentCheck();
  if(!environment.node_supported) fail('RUNTIME_UNAVAILABLE','需要 Node.js 24.16.0 或更新的受支持版本。');
  await ensurePrivateDir();
  const existing=await callRuntime('','project_for_root',{root}) as {id:string;active:number}|null;
  const projectId=existing?.id??`prj_${randomUUID()}`;
  const config=await checkedConfigPath(root);
  const prior=await readFile(config,'utf8').catch(()=>'' );
  if(prior) {try{parseToml(prior);}catch{fail('CONFIG_CONFLICT','现有 Codex 配置无法解析，已停止。');}}
  if(/\[mcp_servers\.codex-pro-bridge\]/.test(prior)) fail('CONFIG_CONFLICT','已有同名 MCP 配置，请人工核对。');
  const exe=path.resolve(process.argv[1]!);
  const agentEnv=process.env.CODEX_PRO_BRIDGE_BROWSER==='agent'?'env = { CODEX_PRO_BRIDGE_BROWSER = "agent" }\n':'';
  const block=`\n[mcp_servers.codex-pro-bridge]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(exe)}, "serve", "--project", ${JSON.stringify(projectId)}]\n${agentEnv}`;
  const next=prior.trimEnd()+block;
  try{parseToml(next);}catch{fail('CONFIG_CONFLICT','生成配置无法解析。');}
  process.stdout.write(`项目：${root}\n环境：${JSON.stringify(environment)}\n将新增配置：${block}\n`);
  process.stdout.write('项目配置包含本机绝对路径，请勿将个人机器配置提交到 Git。\n');
  if(await isTrackedConfig(root))process.stdout.write('注意：.codex/config.toml 已被 Git 跟踪；本操作只修改文件内容，不更改跟踪状态。\n');
  const rl=createInterface({input:process.stdin,output:process.stdout});
  const answer=await rl.question('输入 yes 写入项目配置：');rl.close();
  if(answer.trim()!=='yes') return {applied:false};
  await finalizeSetup(root,projectId,existing?.active===1,config,prior,next);
  return {applied:true,project_id:projectId,config,installation_ready:true,web_login_verified:false,route_verified:false};
}
