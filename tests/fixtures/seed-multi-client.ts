import path from 'node:path';
import { Store } from '../../src/state/db.js';
import { rootIdentity } from '../../src/state/project.js';

const [data,projectA,projectB]=process.argv.slice(2);
if(!data||!projectA||!projectB)throw new Error('fixture needs data and two project roots');
const store=new Store(path.join(data,'bridge.db'));
try {
  const now=Date.now();
  store.db.prepare('INSERT INTO projects(id,root,identity,created_at) VALUES(?,?,?,?)').run('project-a',projectA,rootIdentity(projectA),now);
  store.db.prepare('INSERT INTO projects(id,root,identity,created_at) VALUES(?,?,?,?)').run('project-b',projectB,rootIdentity(projectB),now);
  store.db.prepare("INSERT INTO profiles(id,route) VALUES('default','Pro')").run();
  store.db.prepare("INSERT INTO sessions(id,project_id,epoch,profile_id,login_epoch,route,state) VALUES('shared-session','project-a',1,'default',1,'Pro','ready')").run();
  store.db.prepare("INSERT INTO tasks(id,project_id,request_key,request_sha256,payload_sha256,payload,session_id,mode,status,phase,delivery,created_at,updated_at) VALUES('prior','project-a','prior','h','h',NULL,'shared-session','ask','completed','capture','confirmed_sent',?,?)").run(now,now);
} finally {store.close();}
