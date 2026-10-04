import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fail } from '../security/errors.js';
import { protectWindowsFile } from '../security/windows-acl.js';
import { dataDir, ensurePrivateDir } from '../state/paths.js';

async function writePrivateFile(file:string,contents:string) {
  await writeFile(file,'',{mode:0o600,flag:'wx'});
  try {
    await protectWindowsFile(file);
    const handle=await open(file,'r+');
    try {await handle.writeFile(contents);await handle.sync();}
    finally {await handle.close();}
  } catch(error) {
    await unlink(file).catch(()=>{});
    throw error;
  }
}

export async function checkedConfigPath(root:string,createDirectory=false):Promise<string> {
  const directory=path.join(root,'.codex');
  if(createDirectory)await mkdir(directory,{mode:0o700}).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='EEXIST')throw error;});
  const dir=await lstat(directory).catch((error:NodeJS.ErrnoException)=>{
    if(!createDirectory&&error.code==='ENOENT')return null;
    throw error;
  });
  if(dir&&(!dir.isDirectory()||dir.isSymbolicLink()))fail('CONFIG_CONFLICT','项目配置目录不是普通目录。');
  const config=path.join(directory,'config.toml');
  if(dir) {
    const entry=await lstat(config).catch((error:NodeJS.ErrnoException)=>{
      if(error.code==='ENOENT')return null;
      throw error;
    });
    if(entry&&(!entry.isFile()||entry.isSymbolicLink()))fail('CONFIG_CONFLICT','项目配置文件不是普通文件。');
  }
  return config;
}

export async function writeConfigAtomically(config:string,prior:string,next:string) {
  const current=await readFile(config,'utf8').catch((error:NodeJS.ErrnoException)=>{
    if(error.code==='ENOENT')return '';
    throw error;
  });
  if(current!==prior)fail('CONFIG_CONFLICT','确认后项目配置已变化，未覆盖。');
  if(prior) {
    await ensurePrivateDir();
    const backupDir=path.join(dataDir(),'config-backups');
    await ensurePrivateDir(backupDir);
    const identity=createHash('sha256').update(config).digest('hex').slice(0,16);
    const backup=path.join(backupDir,`${identity}-${randomUUID()}.toml`);
    await writePrivateFile(backup,prior);
  }
  const temp=`${config}.cpb-${randomUUID()}.tmp`;
  try {
    await writePrivateFile(temp,next);
    await rename(temp,config);
  } finally {await unlink(temp).catch(()=>{});}
}
