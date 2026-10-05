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

function Set-EnvValue([string]$content, [string]$name, [string]$value) {
  $escaped = [regex]::Escape($name)
  if ($content -match "(?m)^$escaped=") {
    return [regex]::Replace($content, "(?m)^$escaped=.*$", "$name=$value")
  }
  return ($content.TrimEnd() + "`r`n$name=$value`r`n")
}

function Ensure-Secret([string]$content, [string]$name) {
  $escaped = [regex]::Escape($name)
  $match = [regex]::Match($content, "(?m)^$escaped=(.*)$")
  $current = if ($match.Success) { $match.Groups[1].Value.Trim() } else { '' }
  if (-not $current -or $current -match '^CHANGE_ME') {
    return Set-EnvValue $content $name (New-HexSecret 32)
  }
  return $content
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
$content = Ensure-Secret $content 'WORKSPACE_IP_HASH_SECRET'
$content = Ensure-Secret $content 'KOSH_GIT_TOKEN'
$content = Ensure-Secret $content 'KOSH_RUNNER_TOKEN'

$databaseMatch = [regex]::Match($content, '(?m)^WORKSPACE_DATABASE_URL=(.*)$')
$databaseValue = if ($databaseMatch.Success) { $databaseMatch.Groups[1].Value.Trim() } else { '' }
if (-not $databaseValue -or $databaseValue -match '^CHANGE_ME') {
  if ($env:WORKSPACE_DATABASE_URL) {
    $databaseValue = $env:WORKSPACE_DATABASE_URL.Trim()
  } else {
    Write-Host ''
    Write-Host 'Kosh needs its PostgreSQL/Neon connection URL.' -ForegroundColor Yellow
    Write-Host 'Paste it only into this local PowerShell prompt; do not send it in chat.' -ForegroundColor Yellow
    $secure = Read-Host 'WORKSPACE_DATABASE_URL' -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
      $databaseValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
  }
  if (-not $databaseValue) { throw 'WORKSPACE_DATABASE_URL is required.' }
  $content = Set-EnvValue $content 'WORKSPACE_DATABASE_URL' $databaseValue
}

Set-Content -Path $envFile -Value $content -Encoding utf8

New-Item -ItemType Directory -Path 'C:\Kosh\data\repos' -Force | Out-Null
New-Item -ItemType Directory -Path 'C:\Kosh\logs' -Force | Out-Null

Write-Host 'Installing exact workspace dependencies...'
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }

Write-Host 'Building Kosh gateway...'
npm run kosh:node:build
if ($LASTEXITCODE -ne 0) { throw 'Kosh Node build failed.' }

Write-Host ''
Write-Host 'Kosh Node is built and configured.' -ForegroundColor Green
Write-Host 'Repository root: C:\Kosh\data\repos'
Write-Host 'Local health endpoint: http://127.0.0.1:4100/health'
