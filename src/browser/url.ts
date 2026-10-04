import { fail } from '../security/errors.js';

export function conversationUrl(value:string):string {
  let parsed:URL;
  try {parsed=new URL(value);} catch {fail('PROJECT_MISMATCH','对话地址无效。');}
  if(parsed.protocol!=='https:'||parsed.hostname!=='chatgpt.com'||parsed.port||parsed.username||parsed.password||parsed.search||parsed.hash||!/^\/c\/[A-Za-z0-9-]+$/.test(parsed.pathname)) fail('PROJECT_MISMATCH','对话地址不是受支持的官方对话页面。');
  return parsed.href;
}
