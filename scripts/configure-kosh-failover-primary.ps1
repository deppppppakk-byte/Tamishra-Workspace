$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot '.env.kosh-node'
if (-not (Test-Path $envFile)) { throw 'Missing .env.kosh-node. Install the primary Kosh Node first.' }

function Set-EnvValue([string]$content, [string]$name, [string]$value) {
  $escaped = [regex]::Escape($name)
  if ($content -match "(?m)^$escaped=") {
    return [regex]::Replace($content, "(?m)^$escaped=.*$", "$name=$value")
  }
  return ($content.TrimEnd() + "`r`n$name=$value`r`n")
}

Write-Host 'Configure the primary Kosh Node to replicate verified backups to the standby computer.' -ForegroundColor Cyan
Write-Host 'Use a folder that remains available when the primary PC is offline.' -ForegroundColor Yellow
Write-Host 'Example: \\KOSH-STANDBY\KoshFailover'
$syncRoot = Read-Host 'Standby replication path'
if (-not $syncRoot.Trim()) { throw 'A standby replication path is required.' }
$syncRoot = $syncRoot.Trim()

if (-not (Test-Path $syncRoot)) {
  throw "The standby replication path is not reachable: $syncRoot"
}

$probe = Join-Path $syncRoot ('.kosh-write-test-' + [guid]::NewGuid().ToString('N') + '.tmp')
try {
  'kosh-failover-write-test' | Set-Content -Path $probe -Encoding ascii
  Remove-Item $probe -Force
} catch {
  throw "The primary cannot write to the standby replication path: $($_.Exception.Message)"
}

$content = Get-Content $envFile -Raw
$content = Set-EnvValue $content 'KOSH_NODE_ROLE' 'PRIMARY'
$content = Set-EnvValue $content 'KOSH_FAILOVER_SYNC_ROOT' $syncRoot
Set-Content -Path $envFile -Value $content -Encoding utf8

Write-Host 'Running the first verified replicated backup...' -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'backup-kosh-node.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Initial replicated backup failed.' }

Write-Host ''
Write-Host 'Primary failover replication is configured.' -ForegroundColor Green
Write-Host "Standby target: $syncRoot"
Write-Host 'Existing automatic Kosh backups will now also publish verified snapshots to this target.'
