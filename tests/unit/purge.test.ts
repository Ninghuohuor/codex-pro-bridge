import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { purgeLocalData } from '../../src/cli/purge.js';

test('purge removes only owned data and refuses a busy runtime',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-purge-'));
  const data=path.join(root,'data'),outside=path.join(root,'outside.txt');
  await mkdir(data);await writeFile(outside,'preserve me');
  const owner=new DatabaseSync(path.join(data,'runtime-owner.db'));
  let ownerOpen=true;
  owner.exec('BEGIN EXCLUSIVE');
  try {
    await writeFile(path.join(data,'bridge.db'),'sensitive task body');
    await writeFile(path.join(data,'bridge.db.pre-v4-12345678-abcd.sqlite'),'legacy body');
    await writeFile(path.join(data,'runtime.json'),'secret token');
    await writeFile(path.join(data,'unrelated.txt'),'keep this');
    await symlink(outside,path.join(data,'browser-profile'));
    await assert.rejects(purgeLocalData(data),{code:'PROFILE_BUSY'});
    assert.equal(await readFile(path.join(data,'bridge.db'),'utf8'),'sensitive task body');
    owner.exec('ROLLBACK');owner.close();ownerOpen=false;
    const cli=path.resolve('dist/src/cli/index.js');
    await assert.rejects(promisify(execFile)(process.execPath,[cli,'purge'],{env:{...process.env,CODEX_PRO_BRIDGE_DATA_DIR:data}}),/APPROVAL_REQUIRED/);
    const result=await purgeLocalData(data);
    assert.deepEqual(result.removed.sort(),['bridge.db','bridge.db.pre-v4-12345678-abcd.sqlite','browser-profile','runtime.json'].sort());
    assert.equal(await readFile(path.join(data,'unrelated.txt'),'utf8'),'keep this');
    assert.equal(await readFile(outside,'utf8'),'preserve me');
    await assert.rejects(readFile(path.join(data,'bridge.db')),{code:'ENOENT'});
    assert.equal((await purgeLocalData(data)).removed.length,0);
  } finally {
    if(ownerOpen){if(owner.isTransaction)owner.exec('ROLLBACK');owner.close();}
    await rm(root,{recursive:true,force:true});
  }
});
