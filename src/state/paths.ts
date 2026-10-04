import path from 'node:path';
import os from 'node:os';
import { mkdir, chmod, lstat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { protectWindowsDirectory } from '../security/windows-acl.js';
export function dataDir(): string {
  if(process.env.CODEX_PRO_BRIDGE_DATA_DIR) return path.resolve(process.env.CODEX_PRO_BRIDGE_DATA_DIR);
  if(process.platform==='win32') return path.join(process.env.LOCALAPPDATA ?? os.homedir(),'CodexProBridge');
  if(process.platform==='darwin') return path.join(os.homedir(),'Library','Application Support','CodexProBridge');
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(),'.local','share'),'codex-pro-bridge');
}
export function projectlessRoot(): string { return path.join(dataDir(),'projectless'); }
export function isProjectlessRoot(root:string):boolean {
  try { return realpathSync(root)===realpathSync(projectlessRoot()); }
  catch { return false; }
}
export async function ensurePrivateDir(dir=dataDir()) {
  await mkdir(dir,{recursive:true,mode:0o700});
  if((await lstat(dir)).isSymbolicLink())throw new Error('PRIVATE_DIR_LINK');
  if(process.platform==='win32')await protectWindowsDirectory(dir);
  else await chmod(dir,0o700);
}
