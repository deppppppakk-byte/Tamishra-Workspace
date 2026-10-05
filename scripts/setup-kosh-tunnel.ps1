$ErrorActionPreference = 'Stop'

function Require-Cloudflared {
  if (Get-Command cloudflared -ErrorAction SilentlyContinue) { return }
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host 'Installing cloudflared...'
    winget install --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements
  }
  if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    throw 'cloudflared is required. Install it and run this script again.'
  }
}

Require-Cloudflared

$cloudflaredDir = Join-Path $env:USERPROFILE '.cloudflared'
New-Item -ItemType Directory -Path $cloudflaredDir -Force | Out-Null

$certPath = Join-Path $cloudflaredDir 'cert.pem'
if (-not (Test-Path $certPath)) {
  Write-Host 'A browser window will open once so Cloudflare can authorize the tamishra.in tunnel.' -ForegroundColor Yellow
  cloudflared tunnel login
  if ($LASTEXITCODE -ne 0) { throw 'Cloudflare tunnel login failed.' }
}

$tunnels = @()
try {
  $raw = cloudflared tunnel list --output json
  if ($raw) { $tunnels = @($raw | ConvertFrom-Json) }
} catch {
  $tunnels = @()
}

$tunnel = $tunnels | Where-Object { $_.name -eq 'kosh-node' } | Select-Object -First 1
if (-not $tunnel) {
  cloudflared tunnel create kosh-node
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the kosh-node tunnel.' }
  $raw = cloudflared tunnel list --output json
  $tunnels = @($raw | ConvertFrom-Json)
  $tunnel = $tunnels | Where-Object { $_.name -eq 'kosh-node' } | Select-Object -First 1
}

if (-not $tunnel -or -not $tunnel.id) { throw 'Could not determine the kosh-node tunnel UUID.' }
$tunnelId = [string]$tunnel.id
$credentialsFile = Join-Path $cloudflaredDir ($tunnelId + '.json')
if (-not (Test-Path $credentialsFile)) {
  throw "Tunnel credentials file was not found at $credentialsFile"
}

$routeOutput = & cloudflared tunnel route dns kosh-node kosh-node.tamishra.in 2>&1
if ($LASTEXITCODE -ne 0 -and ($routeOutput -join "`n") -notmatch 'already exists|already has') {
  throw "Could not create DNS route: $($routeOutput -join ' ')"
}

$yamlCredentials = $credentialsFile.Replace('\\', '/')
$configPath = Join-Path $cloudflaredDir 'config.yml'
$config = @"
tunnel: $tunnelId
credentials-file: $yamlCredentials
ingress:
  - hostname: kosh-node.tamishra.in
    service: http://127.0.0.1:4100
  - service: http_status:404
"@
Set-Content -Path $configPath -Value $config -Encoding utf8

cloudflared tunnel --config $configPath ingress validate
if ($LASTEXITCODE -ne 0) { throw 'Cloudflare tunnel ingress configuration is invalid.' }

Write-Host ''
Write-Host 'Kosh tunnel is configured.' -ForegroundColor Green
Write-Host "Tunnel: $tunnelId"
Write-Host 'Public node: https://kosh-node.tamishra.in'
Write-Host 'Start it with: cloudflared tunnel --config "$env:USERPROFILE\.cloudflared\config.yml" run kosh-node'
