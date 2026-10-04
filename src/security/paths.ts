import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fail } from './errors.js';

const forbidden = new Set(['.git','node_modules','dist','build','.next','.codex','.ssh','.aws','.config','profile','profiles']);
export function checkRelativePath(value: string): string {
  if (!value || value.includes('\0') || path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.includes('\\')) fail('CONTEXT_BLOCKED','仅允许项目内的相对文件路径。');
  const parts=value.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || forbidden.has(p.toLowerCase()))) fail('CONTEXT_BLOCKED','路径包含禁止的目录。');
  const leaf=parts.at(-1)!.toLowerCase();
  if (leaf.startsWith('.env') || /(?:\.pem|\.key|\.p12|\.pfx|id_rsa|id_ed25519|credentials|secrets?|auth\.json|cookies?)/i.test(leaf)) fail('CONTEXT_BLOCKED','文件路径可能包含敏感数据。');
  return parts.join('/');
}
export async function resolveProjectFile(root: string, relative: string): Promise<string>;
export async function resolveProjectFile(root: string, relative: string, allowDeleted: true): Promise<string|null>;
export async function resolveProjectFile(root: string, relative: string, allowDeleted=false): Promise<string|null> {
  const rel=checkRelativePath(relative);
  const canonicalRoot=await realpath(root);
  let current=canonicalRoot;
  let missing=false;
  for(const part of rel.split('/')) {
    current=path.join(current,part);
    if(missing)continue;
    const st=await lstat(current).catch((error:NodeJS.ErrnoException)=>{
      if(allowDeleted&&error.code==='ENOENT'){missing=true;return null;}
      fail('CONTEXT_BLOCKED','文件不存在或无法读取。');
    });
    if(!st)continue;
    if(st.isSymbolicLink()) fail('CONTEXT_BLOCKED','不允许符号链接。');
  }
  if(missing)return null;
  const resolved=await realpath(current);
  if(!resolved.startsWith(canonicalRoot+path.sep)) fail('CONTEXT_BLOCKED','文件超出项目边界。');
  const st=await lstat(resolved);
  if(!st.isFile()) fail('CONTEXT_BLOCKED','仅允许普通文件。');
  return resolved;
}

export async function readStableFile(filename:string,maxBytes=2*1024*1024):Promise<Buffer> {
  const before=await lstat(filename,{bigint:true}).catch(()=>fail('CONTEXT_STALE','检查后文件路径发生变化。'));
  if(!before.isFile()||before.isSymbolicLink())fail('CONTEXT_BLOCKED','只允许读取普通文件。');
  const canonical=await realpath(filename).catch(()=>fail('CONTEXT_STALE','检查后文件路径发生变化。'));
  if(canonical!==filename)fail('CONTEXT_STALE','文件路径不再指向原位置。');
  if(before.size>BigInt(maxBytes))fail('CONTEXT_TOO_LARGE','文件超过读取上限。');
  let handle;
  try {handle=await open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0));}
  catch {fail('CONTEXT_BLOCKED','文件无法安全打开。');}
  try {
    const opened=await handle.stat({bigint:true});
    if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino)fail('CONTEXT_STALE','检查后文件身份发生变化。');
    const buffer=Buffer.alloc(maxBytes+1);
    let used=0;
    while(used<buffer.length) {
      const {bytesRead}=await handle.read(buffer,used,buffer.length-used,null);
      if(bytesRead===0)break;
      used+=bytesRead;
    }
    if(used>maxBytes)fail('CONTEXT_TOO_LARGE','文件超过读取上限。');
    const after=await handle.stat({bigint:true});
    const atPath=await lstat(filename,{bigint:true}).catch(()=>fail('CONTEXT_STALE','读取过程中文件路径发生变化。'));
    const finalPath=await realpath(filename).catch(()=>fail('CONTEXT_STALE','读取过程中文件路径发生变化。'));
    if(finalPath!==filename||after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeNs!==before.mtimeNs||after.ctimeNs!==before.ctimeNs||atPath.dev!==before.dev||atPath.ino!==before.ino)fail('CONTEXT_STALE','读取过程中文件发生变化。');
    return buffer.subarray(0,used);
  } finally {await handle.close();}
}
