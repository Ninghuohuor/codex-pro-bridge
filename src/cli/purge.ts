import path from 'node:path';
import { lstat, readdir, rm, unlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dataDir } from '../state/paths.js';
import { fail } from '../security/errors.js';

const ownedNames=new Set(['bridge.db','bridge.db-wal','bridge.db-shm','runtime.json','runtime.lock','browser-profile']);
const backupName=/^bridge\.db\.pre-v[1-4]-[0-9a-f-]+\.sqlite$/;

export async function purgeLocalData(dir=dataDir()) {
  const folder=await lstat(dir).catch((error:NodeJS.ErrnoException)=>{
    if(error.code==='ENOENT')return null;
    throw error;
  });
  if(!folder)return {removed:[],preserved_lock:true};
  if(!folder.isDirectory()||folder.isSymbolicLink()) fail('CONTEXT_BLOCKED','本地数据目录不是普通目录。');
  const ownershipPath=path.join(dir,'runtime-owner.db');
  const lock=await lstat(ownershipPath).catch((error:NodeJS.ErrnoException)=>{
    if(error.code==='ENOENT')return null;
    throw error;
  });
  if(!lock)return {removed:[],preserved_lock:true};
  if(!lock.isFile()||lock.isSymbolicLink()) fail('CONTEXT_BLOCKED','运行器所有权文件异常。');
  const ownership=new DatabaseSync(ownershipPath);
  try {
    try {ownership.exec('PRAGMA busy_timeout=1000; BEGIN EXCLUSIVE;');}
    catch {fail('PROFILE_BUSY','运行器仍在使用本地数据，无法清除。');}
    const removed:string[]=[];
    for(const name of await readdir(dir)) {
      if(!ownedNames.has(name)&&!backupName.test(name))continue;
      const target=path.join(dir,name);
      const entry=await lstat(target).catch((error:NodeJS.ErrnoException)=>{
        if(error.code==='ENOENT')return null;
        throw error;
      });
      if(!entry)continue;
      if(entry.isDirectory()&&!entry.isSymbolicLink())await rm(target,{recursive:true,force:true});
      else await unlink(target);
      removed.push(name);
    }
    return {removed,preserved_lock:true};
  } finally {
    if(ownership.isTransaction)ownership.exec('ROLLBACK');
    ownership.close();
  }
}
