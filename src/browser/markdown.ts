import TurndownService from 'turndown';
import gfm from 'turndown-plugin-gfm';
import { fail } from '../security/errors.js';
const converter=new TurndownService({headingStyle:'atx',codeBlockStyle:'fenced',bulletListMarker:'-',emDelimiter:'*'});
converter.use(gfm.gfm);
export function renderVisibleMarkdown(html:string):string {
  if(Buffer.byteLength(html)>4*1024*1024) fail('RESPONSE_UNVERIFIABLE','网页回答标记过大。');
  const markdown=converter.turndown(html).trim();
  if(!markdown) fail('RESPONSE_UNVERIFIABLE','网页回答正文为空。');
  return markdown;
}
