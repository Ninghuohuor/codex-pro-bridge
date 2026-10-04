import { access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

async function exists(file:string) {try{await access(file);return true;}catch{return false;}}
async function onPath(name:string) {
  for(const dir of (process.env.PATH??'').split(path.delimiter)) if(dir&&await exists(path.join(dir,name))) return true;
  return false;
}
export async function environmentCheck() {
  const [major,minor]=process.versions.node.split('.').map(Number);
  const node_supported=(major??0)>24||(major===24&&(minor??0)>=16);
  let chrome_found=false;
  if(process.platform==='darwin') chrome_found=await exists('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')||await exists(path.join(os.homedir(),'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  else if(process.platform==='win32') chrome_found=(await Promise.all([
    exists(path.join(process.env.PROGRAMFILES??'','Google','Chrome','Application','chrome.exe')),
    exists(path.join(process.env['PROGRAMFILES(X86)']??'','Google','Chrome','Application','chrome.exe')),
    exists(path.join(process.env.LOCALAPPDATA??'','Google','Chrome','Application','chrome.exe'))
  ])).some(Boolean);
  else chrome_found=await onPath('google-chrome')||await onPath('chromium');
  return {node:process.version,node_supported,platform:process.platform,chrome_found,codex_on_path:await onPath(process.platform==='win32'?'codex.exe':'codex')};
}
