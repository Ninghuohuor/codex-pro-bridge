import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cli=path.resolve('dist/src/cli/index.js');
const client=new Client({name:'abrupt-host',version:'1'});
const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>typeof entry[1]==='string'));
const transport=new StdioClientTransport({command:process.execPath,args:[cli,'serve','--project','project-a'],env});
await client.connect(transport,{timeout:20000});
const result=await client.callTool({name:'codex_pro_ask',arguments:{project_id:'project-a',request_key:'parent-exit',question:'Review',mode:'review',session:{kind:'new'}}},undefined,{timeout:20000});
if(result.isError)throw new Error('task creation failed');
process.stdout.write(JSON.stringify({task_id:(result.structuredContent as {task_id:string}).task_id}));
process.exit(0);
