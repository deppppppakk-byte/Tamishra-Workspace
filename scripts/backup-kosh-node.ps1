$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot '.env.kosh-node'
if (-not (Test-Path $envFile)) { throw 'Missing .env.kosh-node. Run Kosh Node setup first.' }

function Get-EnvValue([string]$name) {
  $line = Get-Content $envFile | Where-Object { $_ -like "$name=*" } | Select-Object -First 1
  if (-not $line) { return '' }
  return $line.Substring($name.Length + 1).Trim()
}

$repositoryRoot = Get-EnvValue 'KOSH_REPO_ROOT'
if (-not $repositoryRoot) { $repositoryRoot = 'C:/Kosh/data/repos' }
$repositoryRoot = [IO.Path]::GetFullPath($repositoryRoot)
$backupRoot = 'C:\Kosh\backups'
$failoverRoot = Get-EnvValue 'KOSH_FAILOVER_SYNC_ROOT'
$retention = 14

New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
if (-not (Test-Path $repositoryRoot)) {
  Write-Host 'Repository root does not exist yet; nothing to back up.' -ForegroundColor Yellow
  exit 0
}

$drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($backupRoot).TrimEnd('\').TrimEnd(':')) -ErrorAction SilentlyContinue
if ($drive -and $drive.Free -lt 2GB) {
  throw 'Backup aborted because the Kosh backup drive has less than 2 GB free.'
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$manifest = @()
$repos = Get-ChildItem -Path $repositoryRoot -Directory -Recurse -Filter '*.git' | Where-Object { Test-Path (Join-Path $_.FullName 'HEAD') }

foreach ($repo in $repos) {
  $relative = $repo.FullName.Substring($repositoryRoot.Length).TrimStart('\','/')
  $parts = $relative -split '[\\/]'
  if ($parts.Count -lt 2) { continue }
  $namespace = $parts[0]
  $slug = [IO.Path]::GetFileNameWithoutExtension($repo.Name)
  $targetDir = Join-Path $backupRoot (Join-Path $namespace $slug)
  New-Item -ItemType Directory -Path $targetDir -Force | Out-Null

  $bundle = Join-Path $targetDir "$stamp.bundle"
  & git --git-dir $repo.FullName fsck --no-progress --connectivity-only *> $null
  if ($LASTEXITCODE -ne 0) { throw "Repository integrity check failed for $namespace/$slug." }

  & git --git-dir $repo.FullName bundle create $bundle --all
  if ($LASTEXITCODE -ne 0) { throw "Bundle creation failed for $namespace/$slug." }

  & git bundle verify $bundle *> $null
  if ($LASTEXITCODE -ne 0) {
    Remove-Item $bundle -Force -ErrorAction SilentlyContinue
    throw "Bundle verification failed for $namespace/$slug."
  }

  $hash = (Get-FileHash -Algorithm SHA256 -Path $bundle).Hash.ToLowerInvariant()
  $size = (Get-Item $bundle).Length
  $relativeBundle = ('repositories/{0}/{1}/{2}.bundle' -f $namespace, $slug, $stamp)
  $manifest += [pscustomobject]@{
    repository = "$namespace/$slug"
    bundle = $bundle
    relativeBundle = $relativeBundle
    sha256 = $hash
    bytes = $size
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
  }

  Get-ChildItem -Path $targetDir -Filter '*.bundle' -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip $retention |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

$manifestPath = Join-Path $backupRoot 'latest-manifest.json'
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Path $manifestPath -Encoding utf8

Write-Host ''
Write-Host "Kosh backup complete: $($manifest.Count) repository snapshot(s)." -ForegroundColor Green
Write-Host "Backup root: $backupRoot"
Write-Host "Manifest:    $manifestPath"

if ($failoverRoot) {
  try {
    New-Item -ItemType Directory -Path $failoverRoot -Force | Out-Null
    foreach ($item in $manifest) {
      $destination = Join-Path $failoverRoot ($item.relativeBundle -replace '/', [IO.Path]::DirectorySeparatorChar)
      $destinationDir = Split-Path -Parent $destination
      New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
      $temp = "$destination.partial"
      Copy-Item -Path $item.bundle -Destination $temp -Force
      $copiedHash = (Get-FileHash -Algorithm SHA256 -Path $temp).Hash.ToLowerInvariant()
      if ($copiedHash -ne $item.sha256) {
        Remove-Item $temp -Force -ErrorAction SilentlyContinue
        throw "Standby copy checksum failed for $($item.repository)."
      }
      Move-Item -Path $temp -Destination $destination -Force
    }

    $failoverManifestTemp = Join-Path $failoverRoot 'latest-manifest.json.partial'
    $failoverManifest = Join-Path $failoverRoot 'latest-manifest.json'
    $manifest | ConvertTo-Json -Depth 4 | Set-Content -Path $failoverManifestTemp -Encoding utf8
    Move-Item -Path $failoverManifestTemp -Destination $failoverManifest -Force
    Write-Host "Standby replication: $failoverRoot" -ForegroundColor Green
  } catch {
    Write-Warning "Local backup succeeded but standby replication failed: $($_.Exception.Message)"
  }
}
