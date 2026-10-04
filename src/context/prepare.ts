import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../state/db.js';
import { checkRelativePath, readStableFile, resolveProjectFile } from '../security/paths.js';
import { rootIdentity } from '../state/project.js';
import { scanText } from '../security/scan.js';
import { fail } from '../security/errors.js';
import type { DiffMode, FileSelection, Packet } from '../types.js';
const exec=promisify(execFile);
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
export interface PrepareInput { project_id:string; files:FileSelection[]; diff:DiffMode; notes?:string }
export async function computeRevision(root:string, files:FileSelection[], diffMode:DiffMode='none'):Promise<string> {
  const parts:string[]=[];
  for(const file of files) {
    const name=diffMode==='none'?await resolveProjectFile(root,file.path):await resolveProjectFile(root,file.path,true);
    if(name===null) {
      if(file.start_line!==undefined||file.end_line!==undefined||!await isDeletion(root,file.path,diffMode)) fail('CONTEXT_BLOCKED','缺失文件不是所选 Git 差异中的删除项。');
      parts.push(file.path+':deleted');continue;
    }
    const bytes=await readStableFile(name);
    parts.push(file.path+':'+hash(bytes));
  }
  try { const {stdout}=await exec('git',['-C',root,'symbolic-ref','--short','HEAD'],{timeout:3000}); parts.push('branch:'+stdout.trim()); } catch { parts.push('branch:none'); }
  if(diffMode!=='none') parts.push('diff:'+hash(await gitDiff(root,files.map(x=>x.path),diffMode)));
  return hash(parts.join('\n'));
}
async function isDeletion(root:string, relative:string, mode:DiffMode):Promise<boolean> {
  if(mode==='none')return false;
  for(const staged of (mode==='both'?[true,false]:[mode==='staged'])) {
    const args=['-C',root,'--literal-pathspecs','-c','diff.external=','diff','--no-ext-diff','--no-textconv','--no-renames','--diff-filter=D','--name-only','-z'];
    if(staged)args.push('--cached');
    args.push('--',relative);
    try {
      const {stdout}=await exec('git',args,{timeout:5000,maxBuffer:65536,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_PAGER:'cat'}});
      if(stdout.split('\0').includes(relative))return true;
    } catch {fail('CONTEXT_BLOCKED','无法核对删除文件的 Git 差异。');}
  }
  return false;
}
async function gitDiff(root:string, paths:string[], mode:DiffMode):Promise<string> {
  if(mode==='none') return '';
  const chunks:string[]=[];
  for(const staged of (mode==='both'?[true,false]:[mode==='staged'])) {
    const args=['-C',root,'--literal-pathspecs','-c','diff.external=','-c','diff.noprefix=false','diff','--no-ext-diff','--no-textconv','--no-renames'];
    if(staged) args.push('--cached');
    args.push('--',...paths);
    try { const {stdout}=await exec('git',args,{timeout:5000,maxBuffer:65536,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_PAGER:'cat'}}); if(stdout.includes('Binary files ')||stdout.includes('GIT binary patch')) fail('CONTEXT_BLOCKED','二进制差异不受支持。');chunks.push(`${staged?'staged':'unstaged'} diff:\n${stdout}`); }
    catch { fail('CONTEXT_BLOCKED','无法读取指定文件的 Git 差异。'); }
  }
  return chunks.join('\n');
}
export async function prepareContext(store:Store, input:PrepareInput):Promise<object> {
  const project=store.project(input.project_id);
  if(!project) fail('WORKSPACE_UNBOUND','项目未注册。');
  if(!['none','staged','unstaged','both'].includes(input.diff)) fail('INVALID_INPUT','diff 模式无效。');
  if(input.files.length>20) fail('CONTEXT_TOO_LARGE','最多选择 20 个文件片段。');
  if(input.diff!=='none'&&input.files.length===0) fail('CONTEXT_BLOCKED','Git 差异必须绑定明确文件。');
  scanText(input.notes??'');
  const revisionBefore=await computeRevision(project.root,input.files,input.diff);
  const manifest:FileSelection[]=[]; const pieces:string[]=[];
  for(const file of input.files) {
    const rel=checkRelativePath(file.path);
    const full=input.diff==='none'?await resolveProjectFile(project.root,rel):await resolveProjectFile(project.root,rel,true);
    if(full===null) {
      if(file.start_line!==undefined||file.end_line!==undefined||!await isDeletion(project.root,rel,input.diff)) fail('CONTEXT_BLOCKED','缺失文件不是所选 Git 差异中的删除项。');
      manifest.push({path:rel});continue;
    }
    const bytes=await readStableFile(full);
    if(bytes.length>32768 && file.start_line===undefined) fail('CONTEXT_TOO_LARGE','整文件超过 32 KiB，请选择行范围。');
    const raw=bytes.toString('utf8');
    if(Buffer.from(raw).compare(bytes)!==0 || raw.includes('\0')) fail('CONTEXT_BLOCKED','文件不是有效 UTF-8 文本。');
    const lines=raw.split('\n');
    if((file.start_line===undefined)!==(file.end_line===undefined)) fail('INVALID_INPUT','行范围需要同时指定起止。');
    const start=file.start_line??1,end=file.end_line??lines.length;
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start||end>lines.length) fail('INVALID_INPUT','行范围无效。');
    const selected=lines.slice(start-1,end).join('\n');
    if(Buffer.byteLength(selected)>32768) fail('CONTEXT_TOO_LARGE','文件片段超过 32 KiB。');
    scanText(selected);
    manifest.push({path:rel,...(file.start_line===undefined?{}:{start_line:start,end_line:end})});
    pieces.push(`### ${rel}:${start}-${end}\n${selected}`);
  }
  const diff=await gitDiff(project.root,manifest.map(x=>x.path),input.diff);
  scanText(diff);
  const content=[input.notes?`Notes:\n${input.notes}`:'',...pieces,diff].filter(Boolean).join('\n\n');
  if(Buffer.byteLength(content)>128*1024) fail('CONTEXT_TOO_LARGE','上下文超过 128 KiB。');
  const revision=await computeRevision(project.root,manifest,input.diff);
  if(revision!==revisionBefore) fail('CONTEXT_STALE','准备过程中选中文件或差异发生变化。');
  if(rootIdentity(project.root)!==project.identity)fail('WORKSPACE_CHANGED','准备过程中项目目录身份发生变化。');
  const packet:Packet={id:`pkt_${randomUUID()}`,project_id:input.project_id,sha256:hash(content),content,manifest,diff_mode:input.diff,revision,created_at:Date.now(),expires_at:Date.now()+86400000};
  store.db.prepare('INSERT INTO packets(id,project_id,sha256,content,manifest,diff_mode,revision,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(packet.id,packet.project_id,packet.sha256,packet.content,JSON.stringify(manifest),packet.diff_mode,revision,packet.created_at,packet.expires_at);
  return {packet_id:packet.id,packet_sha256:packet.sha256,manifest,total_bytes:Buffer.byteLength(content),scan_status:'passed_with_limitations',snapshot_revision:revision,preview:content.slice(0,1024),preview_truncated:content.length>1024};
}
