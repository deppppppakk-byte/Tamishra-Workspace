param(
  [Parameter(Mandatory=$true)][string]$Namespace,
  [Parameter(Mandatory=$true)][string]$Slug,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

if ($Namespace -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$') { throw 'Invalid namespace.' }
if ($Slug -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$') { throw 'Invalid repository slug.' }

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot '.env.kosh-node'
if (-not (Test-Path $envFile)) { throw 'Missing .env.kosh-node.' }

function Get-EnvValue([string]$name) {
  $line = Get-Content $envFile | Where-Object { $_ -like "$name=*" } | Select-Object -First 1
  if (-not $line) { return '' }
  return $line.Substring($name.Length + 1).Trim()
}

$repositoryRoot = Get-EnvValue 'KOSH_REPO_ROOT'
if (-not $repositoryRoot) { $repositoryRoot = 'C:/Kosh/data/repos' }
$repositoryRoot = [IO.Path]::GetFullPath($repositoryRoot)
$backupDir = Join-Path 'C:\Kosh\backups' (Join-Path $Namespace $Slug)
if (-not (Test-Path $backupDir)) { throw "No backups exist for $Namespace/$Slug." }

$bundle = Get-ChildItem -Path $backupDir -Filter '*.bundle' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $bundle) { throw "No bundle backup exists for $Namespace/$Slug." }

& git bundle verify $bundle.FullName *> $null
if ($LASTEXITCODE -ne 0) { throw 'Latest repository backup failed Git bundle verification.' }

$targetNamespace = Join-Path $repositoryRoot $Namespace
$target = Join-Path $targetNamespace ($Slug + '.git')
New-Item -ItemType Directory -Path $targetNamespace -Force | Out-Null

if (Test-Path $target) {
  if (-not $Force) {
    throw "Repository already exists at $target. Re-run with -Force only when recovery is actually required."
  }
  $quarantine = "$target.corrupt-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Move-Item -Path $target -Destination $quarantine
  Write-Host "Existing repository moved to: $quarantine" -ForegroundColor Yellow
}

& git clone --bare $bundle.FullName $target
if ($LASTEXITCODE -ne 0) { throw 'Repository restore from backup failed.' }

& git --git-dir $target config http.receivepack true
& git --git-dir $target fsck --no-progress
if ($LASTEXITCODE -ne 0) { throw 'Recovered repository failed integrity verification.' }

Write-Host ''
Write-Host "Recovered $Namespace/$Slug successfully." -ForegroundColor Green
Write-Host "Source backup: $($bundle.FullName)"
Write-Host "Repository:    $target"
