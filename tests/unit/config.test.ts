import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeOwnConfig } from '../../src/cli/uninstall.js';
import { parse as parseToml } from '@iarna/toml';
import { checkedConfigPath, writeConfigAtomically } from '../../src/cli/config-files.js';
import { finalizeSetup, isTrackedConfig } from '../../src/cli/setup.js';
import { mkdtemp, mkdir, writeFile, readFile, symlink, unlink, readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run=promisify(execFile);

test('setup detects a tracked project config without changing its Git state',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-tracked-config-'));
  try {
    assert.equal(await isTrackedConfig(root),false);
    await run('git',['init','-b','main',root]);
    await mkdir(path.join(root,'.codex'));
    await writeFile(path.join(root,'.codex','config.toml'),'model = "gpt-6-sol"\n');
    assert.equal(await isTrackedConfig(root),false);
    await run('git',['-C',root,'add','.codex/config.toml']);
    assert.equal(await isTrackedConfig(root),true);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('uninstall removes only the matching MCP stanza',()=>{
  const prior='model = "gpt-6-sol"\n\n[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.codex-pro-bridge]\ncommand = "node"\nargs = ["cli.js", "serve", "--project", "prj_one"]\n\n[features]\nfoo = true\n';
  const next=removeOwnConfig(prior,'prj_one');
  const parsed=parseToml(next) as any;
  assert.equal(parsed.model,'gpt-6-sol');assert.equal(parsed.mcp_servers.other.command,'other');assert.equal(parsed.features.foo,true);
  assert.equal(parsed.mcp_servers['codex-pro-bridge'],undefined);
  assert.throws(()=>removeOwnConfig(prior,'prj_other'),{code:'CONFIG_CONFLICT'});
});

test('setup registers before writing config and rolls back a failed write',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-setup-order-'));
  const config=path.join(root,'.codex','config.toml');
  try {
    const calls:string[]=[];
    const runtime=async(_project:string,op:string)=>{calls.push(op);if(op==='register_project'&&calls.length===1)throw new Error('runtime unavailable');return {};};
    await assert.rejects(finalizeSetup(root,'prj_test',false,config,'','new config',runtime),/runtime unavailable/);
    assert.deepEqual(calls,['register_project']);
    await assert.rejects(readFile(config),{code:'ENOENT'});

    await mkdir(path.dirname(config));
    await writeFile(config,'changed after confirmation');
    const rollbackCalls:string[]=[];
    const recordingRuntime=async(_project:string,op:string)=>{rollbackCalls.push(op);return {};};
    await assert.rejects(finalizeSetup(root,'prj_test',false,config,'stale','new config',recordingRuntime),{code:'CONFIG_CONFLICT'});
    assert.deepEqual(rollbackCalls,['register_project','deactivate_project']);
    assert.equal(await readFile(config,'utf8'),'changed after confirmation');

    const activeCalls:string[]=[];
    await assert.rejects(finalizeSetup(root,'prj_test',true,config,'stale','new config',async(_project,op)=>{activeCalls.push(op);return {};}),{code:'CONFIG_CONFLICT'});
    assert.deepEqual(activeCalls,['register_project']);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('project config writes reject links and changes after confirmation, with private backups',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-config-'));
  const outside=await mkdtemp(path.join(os.tmpdir(),'cpb-config-outside-'));
  const data=await mkdtemp(path.join(os.tmpdir(),'cpb-config-data-'));
  const previousData=process.env.CODEX_PRO_BRIDGE_DATA_DIR;
  process.env.CODEX_PRO_BRIDGE_DATA_DIR=data;
  const directory=path.join(root,'.codex'),config=path.join(directory,'config.toml');
  try {
    await symlink(outside,directory);
    await assert.rejects(checkedConfigPath(root),{code:'CONFIG_CONFLICT'});
    await unlink(directory);
    await mkdir(directory);
    const external=path.join(outside,'external.toml');
    await writeFile(external,'model = "other"\n');
    await symlink(external,config);
    await assert.rejects(checkedConfigPath(root),{code:'CONFIG_CONFLICT'});
    await unlink(config);
    const prior='model = "gpt-6-sol"\n';
    await writeFile(config,prior,{mode:0o644});
    assert.equal(await checkedConfigPath(root),config);
    const next='model = "gpt-6-sol"\n[features]\nfoo = true\n';
    await writeConfigAtomically(config,prior,next);
    assert.equal(await readFile(config,'utf8'),next);
    assert.equal((await readdir(directory)).filter(name=>name.includes('cpb-backup')).length,0);
    const backupDir=path.join(data,'config-backups');
    const backups=(await readdir(backupDir)).filter(name=>name.endsWith('.toml'));
    assert.equal(backups.length,1);
    assert.equal(await readFile(path.join(backupDir,backups[0]!),'utf8'),prior);
    if(process.platform!=='win32') {
      assert.equal((await stat(config)).mode&0o777,0o600);
      assert.equal((await stat(path.join(backupDir,backups[0]!))).mode&0o777,0o600);
    }
    await assert.rejects(writeConfigAtomically(config,prior,'overwritten'),{code:'CONFIG_CONFLICT'});
    assert.equal(await readFile(config,'utf8'),next);
  } finally {
    if(previousData===undefined)delete process.env.CODEX_PRO_BRIDGE_DATA_DIR;
    else process.env.CODEX_PRO_BRIDGE_DATA_DIR=previousData;
    await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});await rm(data,{recursive:true,force:true});
  }
});
