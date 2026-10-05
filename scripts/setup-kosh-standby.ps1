$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$scriptRoot = $PSScriptRoot
Set-Location $repoRoot

Write-Host 'Preparing Kosh standby node...' -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptRoot 'setup-kosh-node.ps1')
if ($LASTEXITCODE -ne 0) { throw "Base Kosh Node setup failed with exit code $LASTEXITCODE." }

$envFile = Join-Path $repoRoot '.env.kosh-node'
function Set-EnvValue([string]$content, [string]$name, [string]$value) {
  $escaped = [regex]::Escape($name)
  if ($content -match "(?m)^$escaped=") {
    return [regex]::Replace($content, "(?m)^$escaped=.*$", "$name=$value")
  }
  return ($content.TrimEnd() + "`r`n$name=$value`r`n")
}
function Get-EnvValue([string]$content, [string]$name) {
  $escaped = [regex]::Escape($name)
  $match = [regex]::Match($content, "(?m)^$escaped=(.*)$")
  return if ($match.Success) { $match.Groups[1].Value.Trim() } else { '' }
}

$content = Get-Content $envFile -Raw
$content = Set-EnvValue $content 'KOSH_NODE_ROLE' 'STANDBY'
$syncRoot = Get-EnvValue $content 'KOSH_FAILOVER_SYNC_ROOT'
if (-not $syncRoot) {
  $suggested = 'C:\Kosh\failover-inbox'
  Write-Host ''
  Write-Host 'Enter the local folder where the primary PC will replicate verified backups.' -ForegroundColor Yellow
  Write-Host "Press Enter to use: $suggested"
  $entered = Read-Host 'KOSH_FAILOVER_SYNC_ROOT'
  $syncRoot = if ($entered.Trim()) { $entered.Trim() } else { $suggested }
  $content = Set-EnvValue $content 'KOSH_FAILOVER_SYNC_ROOT' $syncRoot
}
Set-Content -Path $envFile -Value $content -Encoding utf8

New-Item -ItemType Directory -Path $syncRoot -Force | Out-Null
New-Item -ItemType Directory -Path 'C:\Kosh\standby-backups' -Force | Out-Null

$syncScript = Join-Path $scriptRoot 'sync-kosh-standby.ps1'
$taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$syncScript`""
& schtasks.exe /Create /TN 'Kosh Standby Sync' /TR $taskCommand /SC MINUTE /MO 15 /F *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Warning 'Could not install the 15-minute standby sync task. You can still run SYNC-KOSH-STANDBY.cmd manually.'
} else {
  Write-Host 'Installed 15-minute standby synchronization task.' -ForegroundColor Green
}

$manifest = Join-Path $syncRoot 'latest-manifest.json'
if (Test-Path $manifest) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $syncScript
  if ($LASTEXITCODE -ne 0) { throw 'Initial standby synchronization failed.' }
} else {
  Write-Host 'No replicated manifest is present yet. The standby will sync automatically when the primary publishes one.' -ForegroundColor Yellow
}

$cloudflaredDir = Join-Path $env:USERPROFILE '.cloudflared'
$config = Join-Path $cloudflaredDir 'config.yml'
$credentialFiles = @(Get-ChildItem -Path $cloudflaredDir -Filter '*.json' -File -ErrorAction SilentlyContinue)

Write-Host ''
Write-Host 'Kosh standby node is prepared.' -ForegroundColor Green
Write-Host "Failover inbox: $syncRoot"
Write-Host 'Public Kosh service is NOT started on this standby, preventing split-brain writes.'
if (-not (Test-Path $config) -or $credentialFiles.Count -eq 0) {
  Write-Host ''
  Write-Host 'Before failover can be promoted, securely copy the primary Kosh Tunnel config.yml and its tunnel credential JSON into:' -ForegroundColor Yellow
  Write-Host "  $cloudflaredDir"
  Write-Host 'Transfer those files directly between your PCs/USB. Do not paste tunnel credentials into chat.' -ForegroundColor Yellow
}
Write-Host ''
Write-Host 'When the primary is genuinely offline, use PROMOTE-KOSH-STANDBY.cmd on this PC.'
