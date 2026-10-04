import type { AdapterResult, Task } from '../types.js';
export interface BrowserAdapter {
  inspectReady():Promise<{logged_in:boolean; route:string|null; observed_at:number}>;
  execute(task:Task, route:string, beforeSubmit:()=>Promise<void>, confirmedSubmit:(conversationUrl:string|null)=>void, signal:AbortSignal):Promise<AdapterResult>;
  reconcile(task:Task, route:string, signal:AbortSignal):Promise<AdapterResult|null>;
  requestStop(task:Task):Promise<boolean>;
}
