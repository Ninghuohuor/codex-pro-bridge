import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ensurePrivateDir } from '../../src/state/paths.js';
import { writeConfigAtomically } from '../../src/cli/config-files.js';

const run=promisify(execFile);
const inspect=String.raw`
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$paths = @($env:CPB_ACL_TARGET, (Join-Path $env:CPB_ACL_TARGET 'existing.txt'), (Join-Path $env:CPB_ACL_TARGET 'new.txt'))
$result = foreach ($path in $paths) {
  $acl = (Get-Item -LiteralPath $path -Force).GetAccessControl()
  [PSCustomObject]@{ Protected = $acl.AreAccessRulesProtected; Principals = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }); Owner = $owner }
}
$result | ConvertTo-Json -Compress
`;

test('Windows private data ACL removes broad access and protects existing and new files',{skip:process.platform!=='win32'},async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-acl-'));
  const dir=path.join(root,'data');
  try {
    await mkdir(dir);
    await writeFile(path.join(dir,'existing.txt'),'private');
    await run('icacls.exe',[dir,'/grant','*S-1-1-0:(OI)(CI)R'],{timeout:10000});
    await ensurePrivateDir(dir);
    await writeFile(path.join(dir,'new.txt'),'private');
    const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(inspect,'utf16le').toString('base64')],{
      env:{...process.env,CPB_ACL_TARGET:dir},timeout:15000
    });
    const results=JSON.parse(stdout) as Array<{Protected:boolean;Principals:string[];Owner:string}>;
    assert.equal(results.length,3);
    for(const [index,item] of results.entries()) {
      if(index<2)assert.equal(item.Protected,true);
      assert.deepEqual([...new Set(item.Principals)],[item.Owner]);
    }
  } finally {await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});

test('Windows project config and its backup receive current-user ACL',{skip:process.platform!=='win32'},async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'cpb-config-acl-'));
  const dir=path.join(root,'.codex'),config=path.join(dir,'config.toml');
  const data=path.join(root,'private-data');
  const previousData=process.env.CODEX_PRO_BRIDGE_DATA_DIR;
  process.env.CODEX_PRO_BRIDGE_DATA_DIR=data;
  try {
    await mkdir(dir);
    await run('icacls.exe',[dir,'/grant','*S-1-1-0:(OI)(CI)R'],{timeout:10000});
    await writeFile(config,'before');
    await writeConfigAtomically(config,'before','after');
    const backupDir=path.join(data,'config-backups');
    const backup=(await readdir(backupDir)).find(name=>name.endsWith('.toml'));
    assert.ok(backup);
    assert.equal((await readdir(dir)).filter(name=>name.includes('cpb-backup')).length,0);
    for(const file of [config,path.join(backupDir,backup)]) {
      const script=String.raw`
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl = (Get-Item -LiteralPath $env:CPB_ACL_TARGET -Force).GetAccessControl()
[PSCustomObject]@{ Protected = $acl.AreAccessRulesProtected; Principals = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }); Owner = $owner } | ConvertTo-Json -Compress
`;
      const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{
        env:{...process.env,CPB_ACL_TARGET:file},timeout:15000
      });
      const result=JSON.parse(stdout) as {Protected:boolean;Principals:string[];Owner:string};
      assert.equal(result.Protected,true);
      assert.deepEqual([...new Set(result.Principals)],[result.Owner]);
    }
  } finally {
    if(previousData===undefined)delete process.env.CODEX_PRO_BRIDGE_DATA_DIR;
    else process.env.CODEX_PRO_BRIDGE_DATA_DIR=previousData;
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
