$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Require-Command([string]$name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Required command '$name' is not installed or not on PATH."
  }
}

function New-HexSecret([int]$bytes = 32) {
  $buffer = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return [Convert]::ToHexString($buffer).ToLowerInvariant()
}

Require-Command node
Require-Command npm
Require-Command git

$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) {
  throw "Kosh Node requires Node.js 22 or newer. Found $(node --version)."
}

$envFile = Join-Path $repoRoot '.env.kosh-node'
$exampleFile = Join-Path $repoRoot '.env.kosh-node.example'
if (-not (Test-Path $envFile)) {
  Copy-Item $exampleFile $envFile
}

$content = Get-Content $envFile -Raw
$content = [regex]::Replace($content, '(?m)^WORKSPACE_IP_HASH_SECRET=.*$', "WORKSPACE_IP_HASH_SECRET=$(New-HexSecret 32)")
$content = [regex]::Replace($content, '(?m)^KOSH_GIT_TOKEN=.*$', "KOSH_GIT_TOKEN=$(New-HexSecret 32)")
$content = [regex]::Replace($content, '(?m)^KOSH_RUNNER_TOKEN=.*$', "KOSH_RUNNER_TOKEN=$(New-HexSecret 32)")
Set-Content -Path $envFile -Value $content -Encoding utf8

New-Item -ItemType Directory -Path 'C:\Kosh\data\repos' -Force | Out-Null

$databaseLine = (Get-Content $envFile | Where-Object { $_ -like 'WORKSPACE_DATABASE_URL=*' } | Select-Object -First 1)
if (-not $databaseLine -or $databaseLine -match 'CHANGE_ME') {
  Write-Host ''
  Write-Host 'Kosh Node files and secrets are prepared.' -ForegroundColor Green
  Write-Host 'Set WORKSPACE_DATABASE_URL in .env.kosh-node to the PostgreSQL/Neon URL used by Kosh, then run this script again.' -ForegroundColor Yellow
  exit 2
}

Write-Host 'Installing exact workspace dependencies...'
npm ci

Write-Host 'Building Kosh gateway...'
npm run kosh:node:build

Write-Host ''
Write-Host 'Kosh Node is built.' -ForegroundColor Green
Write-Host 'Start it with: npm run kosh:node:start'
Write-Host 'Local health endpoint: http://127.0.0.1:4100/health'
