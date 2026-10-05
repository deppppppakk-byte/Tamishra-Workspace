$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot '.env.kosh-node'
if (-not (Test-Path $envFile)) { throw 'Missing .env.kosh-node. Run standby setup first.' }

function Get-EnvValue([string]$name) {
  $line = Get-Content $envFile | Where-Object { $_ -like "$name=*" } | Select-Object -First 1
  if (-not $line) { return '' }
  return $line.Substring($name.Length + 1).Trim()
}

$syncRoot = Get-EnvValue 'KOSH_FAILOVER_SYNC_ROOT'
if (-not $syncRoot) { throw 'KOSH_FAILOVER_SYNC_ROOT is not configured on this standby node.' }
if (-not (Test-Path $syncRoot)) { throw "Failover sync root is unavailable: $syncRoot" }

$sourceManifest = Join-Path $syncRoot 'latest-manifest.json'
if (-not (Test-Path $sourceManifest)) { throw 'No complete failover manifest is available yet.' }

$manifest = @(Get-Content $sourceManifest -Raw | ConvertFrom-Json)
if ($manifest.Count -eq 0) { throw 'Failover manifest contains no repository snapshots.' }

$standbyRoot = 'C:\Kosh\standby-backups'
New-Item -ItemType Directory -Path $standbyRoot -Force | Out-Null

$verified = @()
foreach ($item in $manifest) {
  $repository = [string]$item.repository
  $relative = [string]$item.relativeBundle
  $expectedHash = ([string]$item.sha256).ToLowerInvariant()
  if (-not $repository -or -not $relative -or -not $expectedHash) {
    throw 'Failover manifest entry is incomplete.'
  }

  $source = Join-Path $syncRoot ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
  if (-not (Test-Path $source)) { throw "Missing failover bundle for $repository." }
  $sourceHash = (Get-FileHash -Algorithm SHA256 -Path $source).Hash.ToLowerInvariant()
  if ($sourceHash -ne $expectedHash) { throw "Source checksum failed for $repository." }

  $destination = Join-Path $standbyRoot ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
  New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
  $partial = "$destination.partial"
  Copy-Item -Path $source -Destination $partial -Force
  $destinationHash = (Get-FileHash -Algorithm SHA256 -Path $partial).Hash.ToLowerInvariant()
  if ($destinationHash -ne $expectedHash) {
    Remove-Item $partial -Force -ErrorAction SilentlyContinue
    throw "Standby copy checksum failed for $repository."
  }
  Move-Item $partial $destination -Force
  & git bundle verify $destination *> $null
  if ($LASTEXITCODE -ne 0) { throw "Git bundle verification failed for $repository." }

  $verified += [pscustomobject]@{
    repository = $repository
    relativeBundle = $relative
    sha256 = $expectedHash
    bytes = [long]$item.bytes
    createdAt = [string]$item.createdAt
  }
}

$manifestTemp = Join-Path $standbyRoot 'latest-manifest.json.partial'
$manifestFinal = Join-Path $standbyRoot 'latest-manifest.json'
$verified | ConvertTo-Json -Depth 4 | Set-Content -Path $manifestTemp -Encoding utf8
Move-Item $manifestTemp $manifestFinal -Force

Write-Host ''
Write-Host "Standby sync complete: $($verified.Count) verified repository snapshot(s)." -ForegroundColor Green
Write-Host "Standby backup root: $standbyRoot"
Write-Host "Manifest:            $manifestFinal"
