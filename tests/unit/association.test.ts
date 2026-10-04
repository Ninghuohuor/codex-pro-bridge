import { test } from 'node:test';
import assert from 'node:assert/strict';
import { associatedReply, completeReply } from '../../src/browser/association.js';

test('old assistant answer never becomes the new task answer',()=>{
  const old=[{role:'user',text:'old question'},{role:'assistant',text:'old answer'}];
  assert.equal(associatedReply(old,'[CPB request: t]',old.length),null);
  assert.equal(associatedReply([...old,{role:'user',text:'[CPB request: t] new question'}],'[CPB request: t]',old.length),null);
  assert.equal(associatedReply([...old,{role:'user',text:'[CPB request: t] new question'},{role:'assistant',text:'new answer'}],'[CPB request: t]',old.length),'new answer');
});

test('manual extra message and multiple replies are rejected',()=>{
  const marker='[CPB request: t]';
  assert.throws(()=>associatedReply([{role:'user',text:marker},{role:'user',text:'human'},{role:'assistant',text:'answer'}],marker,0),{code:'USER_INTERFERENCE'});
  assert.throws(()=>associatedReply([{role:'user',text:marker},{role:'assistant',text:'one'},{role:'assistant',text:'two'}],marker,0),{code:'RESPONSE_UNVERIFIABLE'});
});

test('stable text alone cannot prove completion',()=>{
  assert.equal(completeReply('answer',3,false,false),false);
  assert.equal(completeReply('answer',3,true,true),false);
  assert.equal(completeReply('',3,false,true),false);
  assert.equal(completeReply('answer',2,false,true),true);
});
