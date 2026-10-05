$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$envFile = Join-Path $repoRoot '.env.kosh-node'
if (-not (Test-Path $envFile)) {
  throw 'Missing .env.kosh-node. Run scripts/setup-kosh-node.ps1 first.'
}

$gateway = Join-Path $repoRoot 'apps/gateway/dist/index.js'
if (-not (Test-Path $gateway)) {
  Write-Host 'Gateway build not found. Building Kosh Node...'
  npm run kosh:node:build
  if ($LASTEXITCODE -ne 0) { throw 'Kosh Node build failed.' }
}

$configPath = Join-Path $env:USERPROFILE '.cloudflared/config.yml'
if (-not (Test-Path $configPath)) {
  throw 'Cloudflare tunnel is not configured. Run scripts/setup-kosh-tunnel.ps1 first.'
}

Write-Host 'Starting Kosh Node on port 4100...'
$nodeProcess = Start-Process -FilePath 'npm.cmd' -ArgumentList @('run','kosh:node:start') -WorkingDirectory $repoRoot -PassThru -NoNewWindow

try {
  $healthy = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4100/health' -TimeoutSec 2
      if ($response.StatusCode -eq 200) { $healthy = $true; break }
    } catch {}
    if ($nodeProcess.HasExited) { throw 'Kosh Node stopped before becoming healthy.' }
  }
  if (-not $healthy) { throw 'Kosh Node did not become healthy within 30 seconds.' }

  Write-Host 'Kosh Node is healthy. Starting secure public tunnel...' -ForegroundColor Green
  Write-Host 'Public Git example: https://tamishra.in/kosh/git/tamishra/kavyn-2d.git'
  cloudflared tunnel --config $configPath run kosh-node
} finally {
  if ($nodeProcess -and -not $nodeProcess.HasExited) {
    Stop-Process -Id $nodeProcess.Id -Force -ErrorAction SilentlyContinue
  }
}
