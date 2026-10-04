$ErrorActionPreference = 'Stop'
$sandbox = Join-Path $env:RUNNER_TEMP ("cpb-package-" + [guid]::NewGuid().ToString('N'))
$install = Join-Path $sandbox 'install'
$project = Join-Path $sandbox 'project'
$data = Join-Path $sandbox 'data'
$entry = $null
$previousData = $env:CODEX_PRO_BRIDGE_DATA_DIR
New-Item -ItemType Directory -Path $sandbox, $install, $project | Out-Null
try {
  $packed = npm pack --json --pack-destination $sandbox | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or @($packed).Count -ne 1) { throw 'Package creation failed' }
  $archive = Join-Path $sandbox $packed[0].filename
  npm install --prefix $install --no-audit --no-fund $archive
  if ($LASTEXITCODE -ne 0) { throw 'Isolated package installation failed' }
  $entry = Join-Path $install 'node_modules/codex-pro-bridge/dist/src/cli/index.js'
  if (-not (Test-Path -LiteralPath $entry)) { throw 'Installed CLI entry is missing' }
  $env:CODEX_PRO_BRIDGE_DATA_DIR = $data
  Set-Content -LiteralPath (Join-Path $project 'readme.txt') -Value 'package smoke fixture'
  $doctor = (& node $entry doctor | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0 -or $doctor.web_automation_enabled -ne $false) { throw 'Installed doctor failed' }
  'yes' | & node $entry setup --root $project | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Installed setup failed' }
  $config = Join-Path $project '.codex/config.toml'
  $body = Get-Content -LiteralPath $config -Raw
  $tomlEntry = $entry.Replace('\', '\\')
  if ($body -notmatch '\[mcp_servers\.codex-pro-bridge\]' -or -not $body.Contains($tomlEntry)) { throw 'Project MCP registration is incorrect' }
  $projects = (& node $entry project list | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0 -or @($projects).Count -ne 1) { throw 'Installed project listing failed' }
  Write-Host 'Packaged CLI install, doctor and project registration passed.'
} finally {
  if ($entry -and (Test-Path -LiteralPath $entry)) { & node $entry shutdown | Out-Null }
  $env:CODEX_PRO_BRIDGE_DATA_DIR = $previousData
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    try { Remove-Item -LiteralPath $sandbox -Recurse -Force; break }
    catch { if ($attempt -eq 4) { throw }; Start-Sleep -Milliseconds 200 }
  }
}
