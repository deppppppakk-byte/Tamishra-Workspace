$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Install-WithWinget([string]$id, [string]$label) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "$label is missing and Windows Package Manager (winget) is unavailable. Install $label, then run INSTALL-KOSH-NODE.cmd again."
  }
  Write-Host "Installing $label..." -ForegroundColor Cyan
  & winget install --id $id --exact --accept-package-agreements --accept-source-agreements --silent
  if ($LASTEXITCODE -ne 0) { throw "$label installation failed." }
  Refresh-Path
}

Write-Host ''
Write-Host 'Kosh Node - one-click Windows bootstrap' -ForegroundColor Cyan
Write-Host '=======================================' -ForegroundColor Cyan

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Install-WithWinget 'Git.Git' 'Git'
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js'
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Refresh-Path
}

if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw 'Node.js/npm is still unavailable after installation. Sign out/in once, then rerun INSTALL-KOSH-NODE.cmd.'
}

$major = [int]((node --version).TrimStart('v').Split('.')[0])
if ($major -lt 22) {
  Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js 22+'
  $major = [int]((node --version).TrimStart('v').Split('.')[0])
  if ($major -lt 22) { throw "Kosh Node requires Node.js 22 or newer. Found $(node --version)." }
}

Write-Host "Node: $(node --version)" -ForegroundColor Green
Write-Host "Git:  $(git --version)" -ForegroundColor Green
Write-Host ''

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'activate-kosh-node.ps1')
if ($LASTEXITCODE -ne 0) {
  throw "Kosh Node activation failed with exit code $LASTEXITCODE."
}

Write-Host ''
Write-Host 'Kosh Node installation is complete.' -ForegroundColor Green
Write-Host 'You can close this window.'
