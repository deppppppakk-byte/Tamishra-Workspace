$ErrorActionPreference = 'Stop'

$scriptRoot = $PSScriptRoot

function Run-Step([string]$name, [string]$script) {
  Write-Host ''
  Write-Host "=== $name ===" -ForegroundColor Cyan
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptRoot $script)
  if ($LASTEXITCODE -ne 0) { throw "$name failed with exit code $LASTEXITCODE." }
}

Run-Step '1. Configure and build Kosh Node' 'setup-kosh-node.ps1'
Run-Step '2. Configure secure kosh-node.tamishra.in tunnel' 'setup-kosh-tunnel.ps1'
Run-Step '3. Install self-healing Windows auto-start' 'install-kosh-node-autostart.ps1'

Write-Host ''
Write-Host 'Waiting for Kosh Node and tunnel to become reachable...' -ForegroundColor Cyan
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 2
  try {
    $local = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4100/health' -TimeoutSec 2
    $public = Invoke-WebRequest -UseBasicParsing -Uri 'https://tamishra.in/kosh/health' -TimeoutSec 5
    if ($local.StatusCode -eq 200 -and $public.StatusCode -eq 200) {
      $ready = $true
      break
    }
  } catch {}
}
if (-not $ready) {
  throw 'Kosh Node did not become publicly reachable within two minutes. Check C:\Kosh\logs and the Cloudflare tunnel.'
}

Run-Step '4-6. Verify Git read/write transport and Browser IDE backend' 'verify-kosh-node.ps1'

Write-Host ''
Write-Host '=== 7. Kosh Node activation complete ===' -ForegroundColor Green
Write-Host 'Public Git: https://tamishra.in/kosh/git/tamishra/kavyn-2d.git'
Write-Host 'Kosh UI: https://tamishra.in/workspace/apps/kosh'
Write-Host 'Logs: C:\Kosh\logs'
Write-Host ''
Write-Host 'Final UI check: sign in to Kosh, open kavyn-2d -> IDE, edit a UTF-8 file, stage it and commit.' -ForegroundColor Yellow
