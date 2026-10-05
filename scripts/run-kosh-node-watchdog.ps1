$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$envFile = Join-Path $repoRoot '.env.kosh-node'
$configPath = Join-Path $env:USERPROFILE '.cloudflared/config.yml'
$gateway = Join-Path $repoRoot 'apps/gateway/dist/index.js'
$backupScript = Join-Path $PSScriptRoot 'backup-kosh-node.ps1'
$logRoot = 'C:\Kosh\logs'

if (-not (Test-Path $envFile)) { throw 'Missing .env.kosh-node. Run setup-kosh-node.ps1 first.' }
if (-not (Test-Path $configPath)) { throw 'Missing Cloudflare tunnel config. Run setup-kosh-tunnel.ps1 first.' }
if (-not (Test-Path $gateway)) { throw 'Missing gateway build. Run setup-kosh-node.ps1 first.' }
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) { throw 'cloudflared is not installed.' }

New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

function Start-KoshGateway {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdout = Join-Path $logRoot "gateway-$stamp.out.log"
  $stderr = Join-Path $logRoot "gateway-$stamp.err.log"
  return Start-Process -FilePath 'node.exe' -ArgumentList @('--env-file=.env.kosh-node','apps/gateway/dist/index.js') -WorkingDirectory $repoRoot -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
}

function Wait-LocalHealth([Diagnostics.Process]$process) {
  for ($i = 0; $i -lt 45; $i++) {
    if ($process.HasExited) { return $false }
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4100/health' -TimeoutSec 2
      if ($response.StatusCode -eq 200) { return $true }
    } catch {}
    Start-Sleep -Seconds 1
  }
  return $false
}

function Start-KoshTunnel {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdout = Join-Path $logRoot "tunnel-$stamp.out.log"
  $stderr = Join-Path $logRoot "tunnel-$stamp.err.log"
  return Start-Process -FilePath 'cloudflared.exe' -ArgumentList @('tunnel','--config',$configPath,'run','kosh-node') -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
}

function Start-KoshBackup {
  if (-not (Test-Path $backupScript)) { return $null }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdout = Join-Path $logRoot "backup-$stamp.out.log"
  $stderr = Join-Path $logRoot "backup-$stamp.err.log"
  return Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$backupScript) -WorkingDirectory $repoRoot -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
}

Write-Host 'Kosh Node watchdog started.'
$lastBackup = [datetime]::MinValue
$backupProcess = $null

while ($true) {
  $gatewayProcess = $null
  $tunnelProcess = $null
  try {
    $gatewayProcess = Start-KoshGateway
    if (-not (Wait-LocalHealth $gatewayProcess)) {
      throw 'Gateway did not become healthy.'
    }

    $tunnelProcess = Start-KoshTunnel
    Write-Host "Kosh Node healthy. Gateway PID=$($gatewayProcess.Id), tunnel PID=$($tunnelProcess.Id)"

    while (-not $gatewayProcess.HasExited -and -not $tunnelProcess.HasExited) {
      Start-Sleep -Seconds 10
      try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4100/health' -TimeoutSec 3
        if ($response.StatusCode -ne 200) { throw 'unhealthy' }
      } catch {
        throw 'Gateway health check failed.'
      }

      if ($backupProcess -and $backupProcess.HasExited) {
        if ($backupProcess.ExitCode -eq 0) { $lastBackup = Get-Date }
        $backupProcess = $null
      }

      if (-not $backupProcess -and ((Get-Date) - $lastBackup).TotalHours -ge 6) {
        $backupProcess = Start-KoshBackup
        if ($backupProcess) {
          Write-Host "Kosh repository backup started. PID=$($backupProcess.Id)"
        } else {
          $lastBackup = Get-Date
        }
      }
    }

    throw 'Kosh Node process exited.'
  } catch {
    Write-Warning $_.Exception.Message
  } finally {
    if ($tunnelProcess -and -not $tunnelProcess.HasExited) { Stop-Process -Id $tunnelProcess.Id -Force -ErrorAction SilentlyContinue }
    if ($gatewayProcess -and -not $gatewayProcess.HasExited) { Stop-Process -Id $gatewayProcess.Id -Force -ErrorAction SilentlyContinue }
  }

  Start-Sleep -Seconds 5
}
