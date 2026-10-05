$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$scriptRoot = $PSScriptRoot
Set-Location $repoRoot

$envFile = Join-Path $repoRoot '.env.kosh-node'
if (-not (Test-Path $envFile)) { throw 'Missing .env.kosh-node. Run standby setup first.' }

function Get-EnvValue([string]$name) {
  $line = Get-Content $envFile | Where-Object { $_ -like "$name=*" } | Select-Object -First 1
  if (-not $line) { return '' }
  return $line.Substring($name.Length + 1).Trim()
}
function Set-EnvValue([string]$content, [string]$name, [string]$value) {
  $escaped = [regex]::Escape($name)
  if ($content -match "(?m)^$escaped=") {
    return [regex]::Replace($content, "(?m)^$escaped=.*$", "$name=$value")
  }
  return ($content.TrimEnd() + "`r`n$name=$value`r`n")
}

$role = (Get-EnvValue 'KOSH_NODE_ROLE').ToUpperInvariant()
if ($role -ne 'STANDBY') { throw "This computer is not configured as a STANDBY node (current role: $role)." }

$healthUrl = Get-EnvValue 'KOSH_PRIMARY_HEALTH_URL'
if (-not $healthUrl) { $healthUrl = 'https://tamishra.in/kosh/health' }
$confirmations = 6
$intervalSeconds = 10
$configuredConfirmations = Get-EnvValue 'KOSH_FAILOVER_OFFLINE_CONFIRMATIONS'
$configuredInterval = Get-EnvValue 'KOSH_FAILOVER_OFFLINE_INTERVAL_SECONDS'
if ($configuredConfirmations -match '^\d+$') { $confirmations = [Math]::Max(3, [int]$configuredConfirmations) }
if ($configuredInterval -match '^\d+$') { $intervalSeconds = [Math]::Max(5, [int]$configuredInterval) }

Write-Host 'Checking that the primary Kosh Node is genuinely offline...' -ForegroundColor Cyan
for ($i = 1; $i -le $confirmations; $i++) {
  $online = $false
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 6
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) { $online = $true }
  } catch {}
  if ($online) {
    throw 'Primary Kosh Node is reachable. Promotion was blocked to prevent split-brain writes.'
  }
  Write-Host "Offline confirmation $i/$confirmations"
  if ($i -lt $confirmations) { Start-Sleep -Seconds $intervalSeconds }
}

$cloudflaredDir = Join-Path $env:USERPROFILE '.cloudflared'
$configPath = Join-Path $cloudflaredDir 'config.yml'
if (-not (Test-Path $configPath)) { throw 'Missing Cloudflare tunnel config.yml on this standby.' }
$configText = Get-Content $configPath -Raw
$credentialMatch = [regex]::Match($configText, '(?m)^\s*credentials-file:\s*(.+?)\s*$')
if (-not $credentialMatch.Success) { throw 'Tunnel config does not contain credentials-file.' }
$credentialPath = $credentialMatch.Groups[1].Value.Trim().Trim('"').Replace('/', '\')
if (-not (Test-Path $credentialPath)) { throw "Missing tunnel credential file: $credentialPath" }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptRoot 'sync-kosh-standby.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Standby synchronization failed.' }

$standbyRoot = 'C:\Kosh\standby-backups'
$manifestPath = Join-Path $standbyRoot 'latest-manifest.json'
if (-not (Test-Path $manifestPath)) { throw 'No verified standby manifest is available.' }
$manifest = @(Get-Content $manifestPath -Raw | ConvertFrom-Json)
if ($manifest.Count -eq 0) { throw 'Standby manifest is empty.' }

$repositoryRoot = Get-EnvValue 'KOSH_REPO_ROOT'
if (-not $repositoryRoot) { $repositoryRoot = 'C:/Kosh/data/repos' }
$repositoryRoot = [IO.Path]::GetFullPath($repositoryRoot)
$restoreStamp = Get-Date -Format 'yyyyMMdd-HHmmss'

foreach ($item in $manifest) {
  $repository = [string]$item.repository
  $parts = $repository -split '/', 2
  if ($parts.Count -ne 2) { throw "Invalid repository in standby manifest: $repository" }
  $namespace = $parts[0]
  $slug = $parts[1]
  $bundle = Join-Path $standbyRoot (([string]$item.relativeBundle) -replace '/', [IO.Path]::DirectorySeparatorChar)
  if (-not (Test-Path $bundle)) { throw "Standby bundle missing for $repository." }
  $hash = (Get-FileHash -Algorithm SHA256 -Path $bundle).Hash.ToLowerInvariant()
  if ($hash -ne ([string]$item.sha256).ToLowerInvariant()) { throw "Checksum mismatch for $repository." }
  & git bundle verify $bundle *> $null
  if ($LASTEXITCODE -ne 0) { throw "Bundle verification failed for $repository." }

  $namespaceDir = Join-Path $repositoryRoot $namespace
  New-Item -ItemType Directory -Path $namespaceDir -Force | Out-Null
  $target = Join-Path $namespaceDir "$slug.git"
  if (Test-Path $target) {
    $protected = Join-Path $namespaceDir "$slug.pre-failover-$restoreStamp.git"
    Move-Item -Path $target -Destination $protected
    Write-Host "Protected previous local copy: $protected" -ForegroundColor Yellow
  }

  & git clone --bare $bundle $target
  if ($LASTEXITCODE -ne 0) { throw "Could not restore $repository from standby bundle." }
  & git --git-dir $target config http.receivepack true
  & git --git-dir $target fsck --no-progress --connectivity-only *> $null
  if ($LASTEXITCODE -ne 0) { throw "Restored repository integrity check failed for $repository." }
  Write-Host "Restored $repository" -ForegroundColor Green
}

$content = Get-Content $envFile -Raw
$content = Set-EnvValue $content 'KOSH_NODE_ROLE' 'PRIMARY'
Set-Content -Path $envFile -Value $content -Encoding utf8

Write-Host ''
Write-Host 'Repositories restored. Installing/starting the Kosh Node watchdog...' -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptRoot 'install-kosh-node-autostart.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Could not start promoted Kosh Node.' }

$online = $false
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 2
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'https://tamishra.in/kosh/health' -TimeoutSec 5
    if ($response.StatusCode -eq 200) { $online = $true; break }
  } catch {}
}
if (-not $online) { throw 'Standby was promoted locally but the public Kosh health route did not become online.' }

Write-Host ''
Write-Host 'Kosh standby promotion complete.' -ForegroundColor Green
Write-Host 'This computer is now the PRIMARY Kosh Node.'
Write-Host 'Public Git: https://tamishra.in/kosh/git/tamishra/kavyn-2d.git'
