import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { fail } from '../security/errors.js';
import type { BrowserAdapter } from './adapter.js';
import type { AdapterResult, Task } from '../types.js';
import { completeReply } from './association.js';
import { inspectAssociatedReply } from './observe.js';
import { conversationUrl } from './url.js';

const ORIGIN='https://chatgpt.com';
export const PRO_OBSERVATION_BUDGET_MS=10*60_000;
export const LIVE_WEB_ENABLED=process.env.CODEX_PRO_BRIDGE_LIVE_WEB==='1';
export async function readVisibleRoute(page:Page):Promise<string> {
  const button=page.locator('button[data-testid="model-switcher-dropdown-button"], button.__composer-pill');
  if(await button.count()!==1||!await button.isVisible()) fail('ROUTE_UNVERIFIABLE','无法识别页面当前选项。');
  const label=(await button.innerText()).replace(/\s+/g,' ').trim();
  if(!label) fail('ROUTE_UNVERIFIABLE','页面选项标签为空。');
  return label;
}
export function assertPageLocation(page:Pick<Page,'url'|'isClosed'>,expected:string):void {
  if(page.isClosed()||page.url()!==expected)fail('USER_INTERFERENCE','任务页面已切换。');
}
export async function assertUnchangedTurns(page:Page,baseline:number):Promise<void> {
  if(await page.locator('[data-message-author-role]').count()!==baseline)fail('USER_INTERFERENCE','填写期间对话中出现了新消息。');
}
export async function hasVisibleSubmittedMarker(page:Page,baseline:number,marker:string):Promise<boolean> {
  return page.locator('[data-message-author-role]').evaluateAll((elements,{baseline,marker})=>
    elements.length>baseline&&elements.slice(baseline).some(element=>
      element.getAttribute('data-message-author-role')==='user'&&
      element.getClientRects().length>0&&getComputedStyle(element).visibility!=='hidden'&&
      (element as HTMLElement).innerText.includes(marker)),{baseline,marker});
}
export async function waitForSubmittedConversation(page:Page,baseline:number,marker:string,markerTimeoutMs=30000,conversationTimeoutMs=PRO_OBSERVATION_BUDGET_MS):Promise<string> {
  const markerDeadline=Date.now()+markerTimeoutMs;
  const conversationDeadline=Date.now()+conversationTimeoutMs;
  let submitted=false;
  while(Date.now()<(submitted?conversationDeadline:Math.min(markerDeadline,conversationDeadline))) {
    try {
      if(await hasVisibleSubmittedMarker(page,baseline,marker)) {
        submitted=true;
        try {return conversationUrl(page.url());} catch { /* New chats briefly use a provisional WEB: URL. */ }
      }
    } catch { /* Navigation can replace the document while the first message is appearing. */ }
    if(page.isClosed())break;
    await page.waitForTimeout(250);
  }
  if(!submitted)fail('DELIVERY_UNKNOWN','发送后未确认本次用户消息。');
  fail(Date.now()>=conversationDeadline?'OBSERVATION_TIMEOUT':'DELIVERY_UNKNOWN','未取得对应对话地址。');
}
export async function assertNoPendingAttachments(page:Page):Promise<void> {
  const selected=await page.locator('input[type="file"]').evaluateAll(inputs=>
    inputs.some(input=>(input as HTMLInputElement).files?.length));
  if(selected)fail('USER_INTERFERENCE','页面已有未授权附件。');
  const remove=page.locator('button[aria-label*="Remove attachment" i], button[aria-label*="Remove file" i], button[aria-label*="移除附件"], button[aria-label*="删除附件"], button[data-testid*="remove-attachment" i], button[data-testid*="remove-file" i]');
  for(let index=0;index<await remove.count();index++) {
    if(await remove.nth(index).isVisible())fail('USER_INTERFERENCE','页面已有未授权附件。');
  }
}
export async function isBoundStopTarget(page:Page,task:Pick<Task,'id'|'conversation_url'>):Promise<boolean> {
  if(!task.conversation_url)return false;
  let expected:string;
  try {expected=conversationUrl(task.conversation_url);} catch {return false;}
  if(page.url()!==expected)return false;
  const marker=`[CPB request: ${task.id}]`;
  const turns=await page.locator('[data-message-author-role]').evaluateAll(elements=>elements.map(element=>({
    role:element.getAttribute('data-message-author-role'),
    text:element.getClientRects().length&&getComputedStyle(element).visibility!=='hidden'?(element as HTMLElement).innerText:'',
  })));
  const matching=turns.flatMap((turn,index)=>turn.role==='user'&&turn.text.includes(marker)?[index]:[]);
  return matching.length===1&&!turns.slice(matching[0]!+1).some(turn=>turn.role==='user');
}
export class ChatGptAdapter implements BrowserAdapter {
  private context:BrowserContext|null=null;
  private page:Page|null=null;
  constructor(private readonly profileDir:string) {}
  private async open():Promise<Page> {
    if(this.page&&!this.page.isClosed()) return this.page;
    try {
      if(!this.context) {
        await mkdir(this.profileDir,{recursive:true,mode:0o700});
        this.context=await chromium.launchPersistentContext(this.profileDir,{channel:'chrome',headless:false,acceptDownloads:false});
      }
      this.page=this.context.pages().find(page=>{
        if(page.isClosed())return false;
        try {return new URL(page.url()).origin===ORIGIN;} catch {return false;}
      })??await this.context.newPage();
      if(this.page.url()==='about:blank') await this.page.goto(ORIGIN);
      return this.page;
    } catch(error) {
      await this.close().catch(()=>{});
      throw error;
    }
  }
  async close():Promise<void> {
    const context=this.context;
    this.context=null;
    this.page=null;
    if(context)await context.close();
  }
  private assertOrigin(page:Page) {if(new URL(page.url()).origin!==ORIGIN) fail('UI_UNSUPPORTED','浏览器已离开 ChatGPT 官方页面。');}
  async openLogin() {const page=await this.open();return {url:page.url(),message:'请在专用浏览器中手动完成登录。'};}
  async inspectReady() {
    if(!LIVE_WEB_ENABLED) fail('WEB_AUTOMATION_DISABLED','设置 CODEX_PRO_BRIDGE_LIVE_WEB=1 后才能检查真实网页。');
    const page=await this.open();this.assertOrigin(page);
    const input=page.locator('#prompt-textarea');
    const profiles=page.locator('[data-testid="accounts-profile-button"]');
    let profileVisible=false;
    for(let index=0;index<await profiles.count();index++) {
      if(await profiles.nth(index).isVisible()) {profileVisible=true;break;}
    }
    const logged_in=await input.count()===1&&await input.isVisible()&&profileVisible;
    return {logged_in,route:null,observed_at:Date.now()};
  }
  async inspectSelectedRoute():Promise<string> {
    if(!LIVE_WEB_ENABLED) fail('WEB_AUTOMATION_DISABLED','设置 CODEX_PRO_BRIDGE_LIVE_WEB=1 后才能检查真实网页选项。');
    const page=await this.open();this.assertOrigin(page);
    return readVisibleRoute(page);
  }
  private async verifyRoute(page:Page,route:string):Promise<string> {
    this.assertOrigin(page);
    const selected=await this.inspectSelectedRoute();
    if(selected!==route) fail('ROUTE_UNVERIFIABLE','当前页面选项与用户配置不一致。');
    return route;
  }
  async execute(task:Task,route:string,beforeSubmit:()=>Promise<void>,confirmedSubmit:(url:string|null)=>void,signal:AbortSignal):Promise<AdapterResult> {
    if(!LIVE_WEB_ENABLED) fail('WEB_AUTOMATION_DISABLED','设置 CODEX_PRO_BRIDGE_LIVE_WEB=1 后才能执行真实网页发送。');
    let page=await this.open();this.assertOrigin(page);
    const desiredUrl=task.conversation_url?conversationUrl(task.conversation_url):`${ORIGIN}/`;
    if(page.url()!==desiredUrl||await page.locator('button[data-testid="stop-button"]').count()) {
      page=await this.context!.newPage();
      this.page=page;
      await page.goto(desiredUrl);
    }
    if(signal.aborted) fail('CANCEL_UNCONFIRMED','任务已请求取消。');
    if(task.payload===null) fail('RESULT_EXPIRED','待发送正文已过期。');
    const conversation=this.context!.pages().find(p=>p===page);if(!conversation) fail('USER_INTERFERENCE','原页面已丢失。');
    const composer=page.locator('#prompt-textarea');
    if(await composer.count()!==1||!await composer.isVisible()) fail('LOGIN_REQUIRED','请在专用浏览器登录。');
    if((await composer.innerText()).trim()) fail('USER_INTERFERENCE','页面已有未授权草稿。');
    await assertNoPendingAttachments(page);
    if(await page.locator('button[data-testid="stop-button"]').count()) fail('PROFILE_BUSY','页面正在生成其他回答。');
    if(task.conversation_url) {
      const url=conversationUrl(task.conversation_url);
      if(page.url()!==url)await page.goto(url);
    } else if(page.url()!==`${ORIGIN}/`) await page.goto(ORIGIN);
    this.assertOrigin(page);
    const targetUrl=task.conversation_url?conversationUrl(task.conversation_url):`${ORIGIN}/`;
    assertPageLocation(page,targetUrl);
    const routeBefore=await this.verifyRoute(page,route);
    const turns=page.locator('[data-message-author-role]');
    const baseline=await turns.count();
    if((await page.locator('#prompt-textarea').innerText()).trim()) fail('USER_INTERFERENCE','目标对话已有未授权草稿。');
    await assertNoPendingAttachments(page);
    await composer.fill(task.payload);
    if((await composer.innerText()).trim()!==task.payload.trim()) fail('USER_INTERFERENCE','页面草稿与批准快照不一致。');
    const send=page.locator('button[data-testid="send-button"], button#composer-submit-button:not([data-testid="stop-button"])');
    if(await send.count()!==1||!await send.isEnabled()) fail('UI_UNSUPPORTED','无法识别唯一的发送按钮。');
    await beforeSubmit();
    if(signal.aborted) fail('CANCEL_UNCONFIRMED','任务已请求取消，未执行网页发送。');
    assertPageLocation(page,targetUrl);
    await assertUnchangedTurns(page,baseline);
    if((await composer.innerText()).trim()!==task.payload.trim()) fail('USER_INTERFERENCE','发送前页面草稿已变化。');
    await assertNoPendingAttachments(page);
    if(await page.locator('button[data-testid="stop-button"]').count()) fail('PROFILE_BUSY','页面正在生成其他回答。');
    await this.verifyRoute(page,route);
    if(await send.count()!==1||!await send.isEnabled()) fail('UI_UNSUPPORTED','发送前按钮状态已变化。');
    assertPageLocation(page,targetUrl);
    await send.click();
    const deadline=Date.now()+PRO_OBSERVATION_BUDGET_MS;
    const marker=`[CPB request: ${task.id}]`;
    const verifiedUrl=await waitForSubmittedConversation(page,baseline,marker,30000,Math.max(1,deadline-Date.now()));
    if(task.conversation_url&&verifiedUrl!==targetUrl) fail('DELIVERY_UNKNOWN','发送后对话页面发生变化。');
    confirmedSubmit(verifiedUrl);
    let answer='';let stable=0;
    while(Date.now()<deadline) {
      if(signal.aborted) fail('CANCEL_UNCONFIRMED','已请求停止，但上游状态尚待核对。');
      this.assertOrigin(page);
      assertPageLocation(page,verifiedUrl);
      const observed=await inspectAssociatedReply(page,marker,baseline);
      if(observed) {
        stable=observed.text===answer?stable+1:0;answer=observed.text;
        if(completeReply(answer,stable,observed.stop_visible,observed.completion_visible)) {
          const routeAfter=await this.verifyRoute(page,route);
          assertPageLocation(page,verifiedUrl);
          return {text:answer,conversation_url:verifiedUrl,route_before:routeBefore,route_after:routeAfter,association_verified:true,completion_verified:true,content_complete:observed.content_complete,warnings:observed.content_complete?[]:['NON_TEXT_CONTENT_NOT_CAPTURED']};
        }
      }
      await page.waitForTimeout(1000);
    }
    fail('OBSERVATION_TIMEOUT','等待本次完整回复超时。');
  }
  async reconcile(task:Task,route:string,signal:AbortSignal):Promise<AdapterResult|null> {
    if(!LIVE_WEB_ENABLED) fail('WEB_AUTOMATION_DISABLED','设置 CODEX_PRO_BRIDGE_LIVE_WEB=1 后才能核对真实网页；不会重新发送。');
    if(!task.conversation_url)return null;
    const expected=conversationUrl(task.conversation_url);
    const page=await this.open();
    if(page.url()!==expected)await page.goto(expected);
    this.assertOrigin(page);
    if(page.url()!==expected)fail('USER_INTERFERENCE','目标对话发生跳转。');
    const routeBefore=await this.verifyRoute(page,route);
    assertPageLocation(page,expected);
    const marker=`[CPB request: ${task.id}]`;
    let previous='',stable=0;
    const deadline=Date.now()+10000;
    while(Date.now()<deadline) {
      if(signal.aborted)fail('CANCEL_UNCONFIRMED','核对已中断，原请求仍待人工确认。');
      this.assertOrigin(page);
      if(page.url()!==expected)fail('USER_INTERFERENCE','核对期间对话页面发生变化。');
      const observed=await inspectAssociatedReply(page,marker,0);
      if(observed) {
        stable=observed.text===previous?stable+1:0;previous=observed.text;
        if(completeReply(previous,stable,observed.stop_visible,observed.completion_visible)) {
          const routeAfter=await this.verifyRoute(page,route);
          assertPageLocation(page,expected);
          return {text:previous,conversation_url:expected,route_before:routeBefore,route_after:routeAfter,association_verified:true,completion_verified:true,content_complete:observed.content_complete,warnings:observed.content_complete?[]:['NON_TEXT_CONTENT_NOT_CAPTURED']};
        }
      }
      await page.waitForTimeout(500);
    }
    return null;
  }
  async requestStop(task:Task):Promise<boolean> {
    if(!LIVE_WEB_ENABLED)return false;
    const page=this.page;if(!page||page.isClosed())return false;
    if(!await isBoundStopTarget(page,task))return false;
    const stop=page.locator('button[data-testid="stop-button"]');
    if(await stop.count()!==1)return false;
    if(!await stop.isVisible())return false;
    if(!await isBoundStopTarget(page,task))return false;
    await stop.click();
    return await isBoundStopTarget(page,task)&&await stop.isHidden().catch(()=>false);
  }
}
