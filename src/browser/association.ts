import { fail } from '../security/errors.js';
export interface VisibleTurn {role:string|null;text:string}
export function associatedReply(turns:VisibleTurn[],marker:string,baseline:number):string|null {
  const fresh=turns.slice(baseline);
  const user=fresh.findIndex(x=>x.role==='user'&&x.text.includes(marker));
  if(user<0)return null;
  if(fresh.slice(user+1).some(x=>x.role==='user')) fail('USER_INTERFERENCE','本次请求之后出现另一条用户消息。');
  const replies=fresh.slice(user+1).filter(x=>x.role==='assistant');
  if(replies.length>1) fail('RESPONSE_UNVERIFIABLE','本次回复关联不唯一。');
  return replies[0]?.text.trim()??null;
}
export function completeReply(text:string,stableObservations:number,stopVisible:boolean,completionControlVisible:boolean):boolean {
  return text.length>0&&stableObservations>=2&&!stopVisible&&completionControlVisible;
}
