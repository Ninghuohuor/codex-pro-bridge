import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { chmodSync, readdirSync, lstatSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dataDir } from './paths.js';
import type { Packet, Task } from '../types.js';
import { fail } from '../security/errors.js';

export const unresolvedDeliverySql="((delivery='maybe_sent' AND status NOT IN ('completed','cancelled')) OR (delivery='confirmed_sent' AND status IN ('running','paused','failed') AND phase IN ('wait','reconcile'))) AND COALESCE(pause_reason,'')!='USER_ABANDONED'";
export const queueBlockingDeliverySql=`(${unresolvedDeliverySql}) AND NOT (status='paused' AND pause_reason='OBSERVATION_TIMEOUT')`;

export class Store {
  readonly db: DatabaseSync;
  constructor(filename=path.join(dataDir(),'bridge.db')) {
    this.db=new DatabaseSync(filename);
    if(process.platform!=='win32' && filename!==':memory:') chmodSync(filename,0o600);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.migrate(); this.recoverInterrupted();
  }
  private migrate() {
    const version=(this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
    if(version>5) fail('DATABASE_VERSION','数据库版本高于当前程序。');
    const location=this.db.location();
    if(version>0&&version<5&&location) {
      const backupPath=`${location}.pre-v${version}-${randomUUID()}.sqlite`;
      this.db.prepare('VACUUM INTO ?').run(backupPath);
      if(process.platform!=='win32') chmodSync(backupPath,0o600);
    }
    if(version===0) this.transaction(()=>{
      this.db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, identity TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, branch TEXT, created_at INTEGER NOT NULL);
CREATE TABLE profiles(id TEXT PRIMARY KEY, route TEXT, login_epoch INTEGER NOT NULL DEFAULT 1, verified_at INTEGER);
CREATE TABLE sessions(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), epoch INTEGER NOT NULL, profile_id TEXT NOT NULL, login_epoch INTEGER NOT NULL, route TEXT NOT NULL, conversation_url TEXT, state TEXT NOT NULL DEFAULT 'reserved');
CREATE TABLE packets(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), sha256 TEXT NOT NULL, content TEXT NOT NULL, manifest TEXT NOT NULL, diff_mode TEXT NOT NULL DEFAULT 'none', revision TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE grants(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT, payload_sha256 TEXT, route TEXT NOT NULL, login_epoch INTEGER NOT NULL, paths TEXT, remaining INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), request_key TEXT NOT NULL, request_sha256 TEXT NOT NULL, payload_sha256 TEXT NOT NULL, payload TEXT, packet_id TEXT, session_id TEXT NOT NULL REFERENCES sessions(id), mode TEXT NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL, delivery TEXT NOT NULL, pause_reason TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(project_id,request_key));
CREATE TABLE results(task_id TEXT PRIMARY KEY REFERENCES tasks(id), text TEXT, sha256 TEXT, completeness TEXT NOT NULL, association_verified INTEGER NOT NULL, route_before TEXT, route_after TEXT, completion_verified INTEGER NOT NULL, warnings TEXT NOT NULL, completed_at INTEGER NOT NULL);
CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, at INTEGER NOT NULL);
PRAGMA user_version=5;`);
    });
    if(version===1) this.transaction(()=>this.db.exec("ALTER TABLE packets ADD COLUMN diff_mode TEXT NOT NULL DEFAULT 'none'; ALTER TABLE projects ADD COLUMN active INTEGER NOT NULL DEFAULT 1; ALTER TABLE projects ADD COLUMN branch TEXT; ALTER TABLE tasks ADD COLUMN request_sha256 TEXT; UPDATE tasks SET request_sha256=payload_sha256; PRAGMA user_version=5;"));
    if(version===2) this.transaction(()=>this.db.exec("ALTER TABLE projects ADD COLUMN active INTEGER NOT NULL DEFAULT 1; ALTER TABLE projects ADD COLUMN branch TEXT; ALTER TABLE tasks ADD COLUMN request_sha256 TEXT; UPDATE tasks SET request_sha256=payload_sha256; PRAGMA user_version=5;"));
    if(version===3) this.transaction(()=>this.db.exec("ALTER TABLE projects ADD COLUMN branch TEXT; ALTER TABLE tasks ADD COLUMN request_sha256 TEXT; UPDATE tasks SET request_sha256=payload_sha256; PRAGMA user_version=5;"));
    if(version===4) this.transaction(()=>this.db.exec("ALTER TABLE tasks ADD COLUMN request_sha256 TEXT; UPDATE tasks SET request_sha256=payload_sha256; PRAGMA user_version=5;"));
  }
  transaction<T>(fn:()=>T):T { this.db.exec('BEGIN IMMEDIATE'); try { const v=fn(); this.db.exec('COMMIT'); return v; } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
  recoverInterrupted() { this.db.prepare("UPDATE tasks SET status='paused',phase='reconcile',pause_reason=CASE WHEN delivery='maybe_sent' THEN 'DELIVERY_UNKNOWN' ELSE 'RUNTIME_INTERRUPTED' END,updated_at=? WHERE status='running'").run(Date.now()); }
  project(id:string) { return this.db.prepare('SELECT * FROM projects WHERE id=? AND active=1').get(id) as {id:string;root:string;identity:string;epoch:number;branch:string|null}|undefined; }
  packet(id:string) { const row=this.db.prepare('SELECT * FROM packets WHERE id=?').get(id) as {id:string;project_id:string;sha256:string;content:string;manifest:string;diff_mode:Packet['diff_mode'];revision:string;created_at:number;expires_at:number}|undefined; return row ? {...row,manifest:JSON.parse(row.manifest) as Packet['manifest']} : undefined; }
  task(id:string) { const row=this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as (Omit<Task,'cancel_requested'> & {cancel_requested:number})|undefined; return row ? {...row,cancel_requested:!!row.cancel_requested} : undefined; }
  findTask(project:string,key:string) { const row=this.db.prepare('SELECT id FROM tasks WHERE project_id=? AND request_key=?').get(project,key) as {id:string}|undefined; return row ? this.task(row.id) : undefined; }
  event(id:string,status:string,reason:string|null=null) { this.db.prepare('INSERT INTO events(task_id,status,reason,at) VALUES(?,?,?,?)').run(id,status,reason,Date.now()); }
  cleanup(now=Date.now()) {
    this.transaction(()=>{
      this.db.prepare("UPDATE tasks SET payload=NULL WHERE status IN ('completed','failed','cancelled') AND updated_at<?").run(now-7*86400000);
      this.db.prepare('UPDATE results SET text=NULL WHERE completed_at<?').run(now-7*86400000);
      this.db.prepare('DELETE FROM packets WHERE expires_at<?').run(now);
      this.db.prepare('DELETE FROM grants WHERE expires_at<?').run(now);
      this.db.prepare("UPDATE tasks SET status='failed',pause_reason='APPROVAL_EXPIRED',payload=NULL,updated_at=? WHERE status='awaiting_approval' AND created_at<?").run(now,now-86400000);
      this.db.prepare("UPDATE tasks SET status='failed',pause_reason=COALESCE(pause_reason,'PAUSE_EXPIRED'),payload=NULL,updated_at=? WHERE status='paused' AND updated_at<?").run(now,now-86400000);
      const expiredTerminal=`status IN ('completed','failed','cancelled') AND updated_at<? AND NOT (${unresolvedDeliverySql})`;
      this.db.prepare(`DELETE FROM events WHERE task_id IN (SELECT id FROM tasks WHERE ${expiredTerminal})`).run(now-30*86400000);
      this.db.prepare(`DELETE FROM results WHERE task_id IN (SELECT id FROM tasks WHERE ${expiredTerminal})`).run(now-30*86400000);
      this.db.prepare(`DELETE FROM tasks WHERE ${expiredTerminal}`).run(now-30*86400000);
      this.db.prepare('DELETE FROM sessions WHERE id NOT IN (SELECT session_id FROM tasks)').run();
    });
    const location=this.db.location();
    if(location) {
      const dir=path.dirname(location),base=path.basename(location);
      for(const name of readdirSync(dir)) {
        if(!name.startsWith(base)||!/^\.pre-v[1-4]-[0-9a-f-]+\.sqlite$/.test(name.slice(base.length)))continue;
        const backupPath=path.join(dir,name),entry=lstatSync(backupPath);
        if(entry.isFile()&&now-entry.mtimeMs>=7*86400000)unlinkSync(backupPath);
      }
    }
  }
  close() { this.db.close(); }
}
