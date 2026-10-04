import { Store } from './db.js';
import { fail } from '../security/errors.js';

/** Only routes suitable for the bridge's deep-analysis lane are accepted. */
export function isHighReasoningRoute(selected:string):boolean {
  const route=selected.trim();
  return /\b(?:pro|high)\b/i.test(route)||route.includes('高');
}

function pauseUnsent(store:Store,reason:string,now:number) {
  const pending=store.db.prepare("SELECT id FROM tasks WHERE status IN ('awaiting_approval','queued') AND delivery='not_sent'").all() as {id:string}[];
  for(const task of pending) {
    store.db.prepare('UPDATE tasks SET status=?,pause_reason=?,updated_at=? WHERE id=?').run('paused',reason,now,task.id);
    store.event(task.id,'paused',reason);
  }
}

export function invalidateLogin(store:Store) {
  const now=Date.now();
  return store.transaction(()=>{
    store.db.prepare("INSERT OR IGNORE INTO profiles(id,route) VALUES('default',NULL)").run();
    store.db.prepare("UPDATE profiles SET route=NULL,verified_at=NULL,login_epoch=login_epoch+1 WHERE id='default'").run();
    store.db.prepare('UPDATE grants SET remaining=0 WHERE remaining>0').run();
    pauseUnsent(store,'LOGIN_REQUIRED',now);
  });
}

export function rebindRoute(store:Store,selected:string) {
  const route=selected.trim();
  if(!route||route.length>200)fail('ROUTE_UNVERIFIABLE','页面选项标签无效。');
  const now=Date.now();
  return store.transaction(()=>{
    const current=store.db.prepare("SELECT login_epoch FROM profiles WHERE id='default'").get() as {login_epoch:number}|undefined;
    if(!current)fail('ROUTE_UNAVAILABLE','尚未建立专用浏览器配置。');
    const epoch=current.login_epoch+1;
    store.db.prepare("UPDATE profiles SET route=?,login_epoch=?,verified_at=? WHERE id='default'").run(route,epoch,now);
    store.db.prepare('UPDATE grants SET remaining=0 WHERE remaining>0').run();
    pauseUnsent(store,'ROUTE_UNAVAILABLE',now);
    return {selected_display:route,login_epoch:epoch,backend_model_verified:false};
  });
}
