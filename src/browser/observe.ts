import type { Page } from 'playwright-core';
import { associatedReply } from './association.js';
import { renderVisibleMarkdown } from './markdown.js';
import { fail } from '../security/errors.js';

export interface ObservedReply {text:string;stop_visible:boolean;completion_visible:boolean;content_complete:boolean}

export async function inspectAssociatedReply(page:Page,marker:string,baseline:number):Promise<ObservedReply|null> {
  const turns=page.locator('[data-message-author-role]');
  const nodes=await turns.evaluateAll(elements=>elements.map(element=>({
    role:element.getAttribute('data-message-author-role'),
    text:element.getClientRects().length&&getComputedStyle(element).visibility!=='hidden'?(element as HTMLElement).innerText:'',
  })));
  const associated=associatedReply(nodes,marker,baseline);
  if(associated===null)return null;
  const userIndex=nodes.findIndex((node,index)=>index>=baseline&&node.role==='user'&&node.text.includes(marker));
  const assistantIndex=nodes.findIndex((node,index)=>index>userIndex&&node.role==='assistant');
  if(userIndex<0||assistantIndex<0)return null;
  const answer=turns.nth(assistantIndex);
  const errors=answer.locator('[role="alert"], [data-testid*="error"], [data-testid*="interrupted"]');
  for(let index=0;index<await errors.count();index++) {
    if(await errors.nth(index).isVisible())fail('RESPONSE_UNVERIFIABLE','本次回答显示错误或中断提示。');
  }
  const turn=answer.locator('xpath=ancestor::*[@data-conversation-screenshot-content][1]');
  const turnCount=await turn.count();
  if(turnCount>1||turnCount===1&&await turn.locator('[data-message-author-role="assistant"]').count()!==1)
    fail('UI_UNSUPPORTED','无法唯一定位本次回答所在轮次。');
  const copy=(turnCount===1?turn:answer).locator('button[data-testid="copy-turn-action-button"]');
  const copyCount=await copy.count();
  if(copyCount>1) fail('UI_UNSUPPORTED','回答完成控件不唯一。');
  const completion_visible=copyCount===1&&await copy.isVisible();
  const body=answer.locator('.markdown');
  const bodyCount=await body.count();
  if(bodyCount>1||bodyCount===0&&completion_visible) fail('UI_UNSUPPORTED','无法唯一定位本次回答正文。');
  if(bodyCount===0)return null;
  const unsupported=body.locator('img, canvas, video, audio, svg, iframe, object, embed, a[download]');
  let content_complete=true;
  for(let index=0;index<await unsupported.count();index++) {
    if(await unsupported.nth(index).isVisible()){content_complete=false;break;}
  }
  const visibleHtml=await body.evaluate(root=>{
    if(!root.getClientRects().length||getComputedStyle(root).visibility==='hidden')return null;
    const copy=root.cloneNode(true) as Element;
    const originals=Array.from(root.querySelectorAll('*'));
    const clones=Array.from(copy.querySelectorAll('*'));
    for(let index=originals.length-1;index>=0;index--) {
      const element=originals[index]!;
      const style=getComputedStyle(element);
      if(element.hasAttribute('hidden')||element.getAttribute('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||!element.getClientRects().length)clones[index]?.remove();
    }
    return copy.innerHTML;
  });
  if(visibleHtml===null)fail('UI_UNSUPPORTED','本次回答正文不可见。');
  const stop=page.locator('button[data-testid="stop-button"]');
  if(await stop.count()>1) fail('UI_UNSUPPORTED','生成状态控件不唯一。');
  return {text:renderVisibleMarkdown(visibleHtml),stop_visible:await stop.isVisible().catch(()=>false),completion_visible,content_complete};
}
