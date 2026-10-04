import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderVisibleMarkdown } from '../../src/browser/markdown.js';

test('visible answer preserves code fences, links, and tables',()=>{
  const result=renderVisibleMarkdown('<h2>分析</h2><p>看<a href="https://example.com">来源</a></p><pre><code class="language-ts">const n = 1;\n</code></pre><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>中</td><td>文</td></tr></tbody></table>');
  assert.match(result,/## 分析/);assert.match(result,/\[来源\]\(https:\/\/example\.com\)/);
  assert.match(result,/```ts\nconst n = 1;\n```/);assert.match(result,/\| A \| B \|/);
});
