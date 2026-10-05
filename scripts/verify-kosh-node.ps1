param(
  [string]$Repository = 'tamishra/kavyn-2d'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot '.env.kosh-node'

if (-not (Test-Path $envFile)) { throw 'Missing .env.kosh-node.' }

function Read-EnvValue([string]$name) {
  $line = Get-Content $envFile | Where-Object { $_ -like "$name=*" } | Select-Object -First 1
  if (-not $line) { return '' }
  return $line.Substring($name.Length + 1).Trim()
}

function Assert-Web([string]$name, [string]$url, [int[]]$allowed = @(200)) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 10
    if ($allowed -notcontains [int]$response.StatusCode) {
      throw "$name returned HTTP $($response.StatusCode)."
    }
    Write-Host "PASS  $name  HTTP $($response.StatusCode)" -ForegroundColor Green
    return $response
  } catch {
    if ($_.Exception.Response -and $allowed -contains [int]$_.Exception.Response.StatusCode) {
      Write-Host "PASS  $name  HTTP $([int]$_.Exception.Response.StatusCode)" -ForegroundColor Green
      return $null
    }
    throw
  }
}

$parts = $Repository.Split('/', 2)
if ($parts.Count -ne 2) { throw 'Repository must be namespace/slug.' }
$namespace = $parts[0]
$slug = $parts[1]
$gitToken = Read-EnvValue 'KOSH_GIT_TOKEN'
if (-not $gitToken -or $gitToken -match '^CHANGE_ME') { throw 'KOSH_GIT_TOKEN is not configured.' }

Write-Host 'Kosh Node verification' -ForegroundColor Cyan
Assert-Web 'Local health' 'http://127.0.0.1:4100/health' | Out-Null
Assert-Web 'Local readiness' 'http://127.0.0.1:4100/ready' | Out-Null
Assert-Web 'Public Kosh health' 'https://tamishra.in/kosh/health' | Out-Null

# The Browser IDE route is private. A 401/403 without a browser session proves the
# route is live and protected; 404/5xx means routing/backend is broken.
$ideUrl = "https://tamishra.in/api/workspace/v1/kosh/repos/$namespace/$slug/ide/state?branch=work%2Fbrowser-edit&baseBranch=main"
Assert-Web 'Browser IDE backend route' $ideUrl @(200,401,403) | Out-Null

$remote = "https://tamishra.in/kosh/git/$namespace/$slug.git"
$basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("kosh:$gitToken"))

$oldCount = $env:GIT_CONFIG_COUNT
$oldKey = $env:GIT_CONFIG_KEY_0
$oldValue = $env:GIT_CONFIG_VALUE_0
try {
  $env:GIT_CONFIG_COUNT = '1'
  $env:GIT_CONFIG_KEY_0 = 'http.extraHeader'
  $env:GIT_CONFIG_VALUE_0 = "Authorization: Basic $basic"

  $null = & git ls-remote $remote 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'Git read verification failed.' }
  Write-Host 'PASS  Git read / clone transport' -ForegroundColor Green

  $temp = Join-Path ([IO.Path]::GetTempPath()) ('kosh-verify-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $temp | Out-Null
  try {
    & git -C $temp init -q
    & git -C $temp config user.name 'Kosh Verification'
    & git -C $temp config user.email 'verify@kosh.local'
    Set-Content -Path (Join-Path $temp 'VERIFY.txt') -Value 'Kosh dry-run write verification' -Encoding utf8
    & git -C $temp add VERIFY.txt
    & git -C $temp commit -q -m 'Kosh dry-run verification'
    & git -C $temp remote add origin $remote
    $pushOutput = & git -C $temp push --dry-run origin HEAD:refs/heads/__kosh_transport_verify__ 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "Git write authorization failed: $($pushOutput -join ' ')"
    }
    Write-Host 'PASS  Git write authorization (dry-run; remote unchanged)' -ForegroundColor Green
  } finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
  }
} finally {
  if ($null -eq $oldCount) { Remove-Item Env:GIT_CONFIG_COUNT -ErrorAction SilentlyContinue } else { $env:GIT_CONFIG_COUNT = $oldCount }
  if ($null -eq $oldKey) { Remove-Item Env:GIT_CONFIG_KEY_0 -ErrorAction SilentlyContinue } else { $env:GIT_CONFIG_KEY_0 = $oldKey }
  if ($null -eq $oldValue) { Remove-Item Env:GIT_CONFIG_VALUE_0 -ErrorAction SilentlyContinue } else { $env:GIT_CONFIG_VALUE_0 = $oldValue }
}

Write-Host ''
Write-Host "Kosh Node transport verification passed for $Repository." -ForegroundColor Green
Write-Host 'Open the Kosh Browser IDE while signed in for the final UI edit/commit check.'
