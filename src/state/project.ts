import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { fail } from '../security/errors.js';

export function rootIdentity(root:string):string {
  try {
    const stat=statSync(root,{bigint:true});
    if(!stat.isDirectory())fail('WORKSPACE_CHANGED','项目目录已不再是目录。');
    return `fs:${stat.dev}:${stat.ino}`;
  } catch {fail('WORKSPACE_CHANGED','项目目录无法核对，请重新注册项目。');}
}
export function currentBranch(root:string):string|null {
  try {return execFileSync('git',['-C',root,'symbolic-ref','--short','HEAD'],{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_CONFIG_NOSYSTEM:'1'}}).trim()||null;}
  catch {return null;}
}
