import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run=promisify(execFile);
const script=String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:CPB_ACL_TARGET
if ([string]::IsNullOrWhiteSpace($target)) { throw 'Missing ACL target' }
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
function Protect-Path([string]$path) {
  $item = Get-Item -LiteralPath $path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point in private data' }
  $acl = $item.GetAccessControl()
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { $acl.PurgeAccessRules($rule.IdentityReference) }
  $inherit = if ($item.PSIsContainer) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($owner, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
  $acl.SetOwner($owner)
  $acl.AddAccessRule($rule)
  $item.SetAccessControl($acl)
  $check = $item.GetAccessControl()
  if (-not $check.AreAccessRulesProtected) { throw 'ACL inheritance remains enabled' }
  foreach ($entry in $check.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($entry.IdentityReference.Value -ne $owner.Value) { throw 'Unexpected ACL principal' }
  }
  if ($item.PSIsContainer) {
    foreach ($child in Get-ChildItem -LiteralPath $path -Force) { Protect-Path $child.FullName }
  }
}
Protect-Path $target
`;

export async function protectWindowsDirectory(directory:string):Promise<void> {
  if(process.platform!=='win32')return;
  await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{
    env:{...process.env,CPB_ACL_TARGET:directory},timeout:60000,maxBuffer:64*1024
  });
}

export async function protectWindowsFile(file:string):Promise<void> {
  await protectWindowsDirectory(file);
}
