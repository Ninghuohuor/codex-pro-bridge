import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { inspectAssociatedReply } from '../../src/browser/observe.js';
import { completeReply } from '../../src/browser/association.js';
import { ChatGptAdapter, assertNoPendingAttachments, assertPageLocation, assertUnchangedTurns, hasVisibleSubmittedMarker, isBoundStopTarget, readVisibleRoute, waitForSubmittedConversation } from '../../src/browser/chatgpt.js';

const marker='[CPB request: fixture-task]';
const turn=(role:string,content:string)=>`<article data-message-author-role="${role}">${content}</article>`;
const user=(content:string)=>turn('user',content);
const assistant=(content:string,copy=true)=>turn('assistant',`<div class="markdown">${content}</div>${copy?'<button data-testid="copy-turn-action-button">Copy</button>':''}`);

test('synthetic browser page associates only the marked complete reply',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();
    const old=user('old question')+assistant('<p>old answer</p>');
    await page.setContent(old+user(marker+' new question')+assistant('<p>new answer</p><p hidden>hidden secret</p><p style="display:none">hidden token</p><pre><code>const n = 1;</code></pre>'));
    const observed=await inspectAssociatedReply(page,marker,2);
    assert.ok(observed);
    assert.match(observed.text,/new answer/);
    assert.match(observed.text,/const n = 1/);
    assert.doesNotMatch(observed.text,/old answer/);
    assert.doesNotMatch(observed.text,/hidden secret|hidden token/);
    assert.equal(observed.completion_visible,true);
    assert.equal(observed.content_complete,true);
    assert.equal(observed.stop_visible,false);
    assert.equal(completeReply(observed.text,2,observed.stop_visible,observed.completion_visible),true);
    await assert.doesNotReject(assertUnchangedTurns(page,4));
    await page.setContent(old+user(marker+' new question')+assistant('<p>new answer</p>')+user('manual message'));
    await assert.rejects(assertUnchangedTurns(page,4),{code:'USER_INTERFERENCE'});

    await page.setContent(old+user('unrelated')+assistant('<p>unrelated answer</p>'));
    assert.equal(await inspectAssociatedReply(page,marker,2),null);

    await page.setContent(old+user(`unrelated <span hidden>${marker}</span>`)+assistant('<p>unrelated answer</p>'));
    assert.equal(await inspectAssociatedReply(page,marker,2),null);
    assert.equal(await hasVisibleSubmittedMarker(page,2,marker),false);
    await page.setContent(old+user(marker)+assistant('<p>answer</p>'));
    assert.equal(await hasVisibleSubmittedMarker(page,2,marker),true);

    await page.setContent(old+user(marker)+'<div data-conversation-screenshot-content>'+turn('assistant','<div class="markdown"><p>real page shape</p></div>')+'<div aria-label="回复操作"><button data-testid="copy-turn-action-button">Copy</button></div></div>');
    const externalCopy=await inspectAssociatedReply(page,marker,2);
    assert.equal(externalCopy?.text,'real page shape');
    assert.equal(externalCopy?.completion_visible,true);

    await page.setContent(old+user(marker)+assistant('<p>answer</p>',false));
    const noCopy=await inspectAssociatedReply(page,marker,2);
    assert.ok(noCopy);
    assert.equal(completeReply(noCopy.text,2,noCopy.stop_visible,noCopy.completion_visible),false);

    await page.setContent(old+user(marker)+assistant('<p>answer</p>')+'<button data-testid="stop-button">Stop</button>');
    const generating=await inspectAssociatedReply(page,marker,2);
    assert.ok(generating);
    assert.equal(completeReply(generating.text,2,generating.stop_visible,generating.completion_visible),false);

    await page.setContent(old+user(marker)+user('manual interruption')+assistant('<p>answer</p>'));
    await assert.rejects(inspectAssociatedReply(page,marker,2),{code:'USER_INTERFERENCE'});

    await page.setContent(old+user(marker)+assistant('<p>one</p>')+assistant('<p>two</p>'));
    await assert.rejects(inspectAssociatedReply(page,marker,2),{code:'RESPONSE_UNVERIFIABLE'});

    await page.setContent(old+user(marker)+assistant('<p> </p>'));
    await assert.rejects(inspectAssociatedReply(page,marker,2),{code:'RESPONSE_UNVERIFIABLE'});

    await page.setContent(old+user(marker)+assistant('<p>partial</p><div role="alert">Interrupted</div>'));
    await assert.rejects(inspectAssociatedReply(page,marker,2),{code:'RESPONSE_UNVERIFIABLE'});

    await page.setContent(old+user(marker)+assistant('<p>text captured</p><svg width="12" height="12"><circle cx="6" cy="6" r="4" /></svg>'));
    assert.equal((await inspectAssociatedReply(page,marker,2))?.content_complete,false);
    await page.setContent(old+user(marker)+assistant('<p>text captured</p><img hidden alt="unseen" src="about:blank">'));
    assert.equal((await inspectAssociatedReply(page,marker,2))?.content_complete,true);

    await page.setContent(old+user(marker)+turn('assistant','<div class="markdown">one</div><div class="markdown">two</div><button data-testid="copy-turn-action-button">Copy</button>'));
    await assert.rejects(inspectAssociatedReply(page,marker,2),{code:'UI_UNSUPPORTED'});

    await page.setContent('<input type="file">');
    await page.locator('input[type="file"]').setInputFiles({name:'unapproved.txt',mimeType:'text/plain',buffer:Buffer.from('not approved')});
    await assert.rejects(assertNoPendingAttachments(page),{code:'USER_INTERFERENCE'});
    await page.setContent('<button aria-label="Remove attachment">Remove</button>');
    await assert.rejects(assertNoPendingAttachments(page),{code:'USER_INTERFERENCE'});
    await page.setContent('<button aria-label="Add attachment">Add</button>');
    await assert.doesNotReject(assertNoPendingAttachments(page));

    await page.setContent('<button class="__composer-pill">6<br>Pro</button>');
    assert.equal(await readVisibleRoute(page),'6 Pro');
    await page.setContent('<button class="__composer-pill">6 Pro</button><button data-testid="model-switcher-dropdown-button">Other</button>');
    await assert.rejects(readVisibleRoute(page),{code:'ROUTE_UNVERIFIABLE'});

    await page.route('https://chatgpt.com/c/**',route=>route.fulfill({status:200,contentType:'text/html',body:user(marker)}));
    await page.goto('https://chatgpt.com/c/WEB:provisional');
    const canonical='https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc';
    const transition=page.waitForTimeout(300).then(()=>page.goto(canonical));
    assert.equal(await waitForSubmittedConversation(page,0,marker,100,1500),canonical);
    await transition;

    await page.goto('https://chatgpt.com/c/WEB:provisional');
    await assert.rejects(waitForSubmittedConversation(page,0,marker,100,200),{code:'OBSERVATION_TIMEOUT'});

    await page.route('https://chatgpt.com/**',route=>route.fulfill({status:200,contentType:'text/html',body:'<html></html>'}));
    await page.goto('https://chatgpt.com/c/fixture');
    const task={id:'fixture-task',conversation_url:'https://chatgpt.com/c/fixture'};
    await page.setContent(user(marker)+'<button data-testid="stop-button">Stop</button>');
    assert.equal(await isBoundStopTarget(page,task),true);
    assert.equal(await isBoundStopTarget(page,{...task,conversation_url:'https://chatgpt.com/c/other'}),false);
    await page.setContent(user(marker)+user('another message')+'<button data-testid="stop-button">Stop</button>');
    assert.equal(await isBoundStopTarget(page,task),false);
    await page.setContent(user(marker)+user(marker)+'<button data-testid="stop-button">Stop</button>');
    assert.equal(await isBoundStopTarget(page,task),false);
    await page.setContent(user('other request')+'<button data-testid="stop-button">Stop</button>');
    assert.equal(await isBoundStopTarget(page,task),false);
    await page.setContent(user(`other request <span style="display:none">${marker}</span>`)+'<button data-testid="stop-button">Stop</button>');
    assert.equal(await isBoundStopTarget(page,task),false);
    assert.doesNotThrow(()=>assertPageLocation(page,task.conversation_url));
    await page.goto('https://chatgpt.com/c/other');
    assert.throws(()=>assertPageLocation(page,task.conversation_url),{code:'USER_INTERFERENCE'});
    await page.close();
    assert.throws(()=>assertPageLocation(page,'https://chatgpt.com/c/other'),{code:'USER_INTERFERENCE'});
  } finally {
    await browser.close();
  }
});

test('adapter reuses its browser context after a tab closes and closes it on shutdown',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const context=await browser.newContext();
    await context.route('https://chatgpt.com/**',route=>route.fulfill({status:200,contentType:'text/html',body:'<html><body>fixture</body></html>'}));
    const page=await context.newPage();
    await page.goto('https://chatgpt.com/');
    const adapter=new ChatGptAdapter('/unused');
    Object.assign(adapter,{context,page});
    await page.close();
    assert.equal((await adapter.openLogin()).url,'https://chatgpt.com/');
    await adapter.close();
    await assert.rejects(context.newPage());
    await adapter.close();
  } finally {
    await browser.close();
  }
});

test('adapter ignores unrelated tabs when selecting a replacement ChatGPT tab',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const context=await browser.newContext();
    await context.route('https://chatgpt.com/**',route=>route.fulfill({status:200,contentType:'text/html',body:'<html><body>fixture</body></html>'}));
    await context.route('https://example.com/**',route=>route.fulfill({status:200,contentType:'text/html',body:'<html><body>unrelated</body></html>'}));
    const unrelated=await context.newPage();
    await unrelated.goto('https://example.com/');
    const chatgpt=await context.newPage();
    await chatgpt.goto('https://chatgpt.com/');
    const adapter=new ChatGptAdapter('/unused');
    Object.assign(adapter,{context});
    assert.equal((await adapter.openLogin()).url,'https://chatgpt.com/');
    assert.equal(unrelated.url(),'https://example.com/');
    await chatgpt.close();
    Object.assign(adapter,{page:null});
    assert.equal((await adapter.openLogin()).url,'https://chatgpt.com/');
    assert.equal(unrelated.url(),'https://example.com/');
    await adapter.close();
  } finally {
    await browser.close();
  }
});
