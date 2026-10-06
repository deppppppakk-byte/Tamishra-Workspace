param(
  [string]$StateRoot = (Join-Path $env:USERPROFILE ".kosh\cloud-controller")
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$EnvPath = Join-Path $StateRoot "controller.env"
$LogRoot = Join-Path $StateRoot "logs"

if (-not (Test-Path $EnvPath)) {
  throw "Kosh Cloud Controller is not configured. Run SETUP-KOSH-CLOUD-CONTROLLER.cmd first."
}

New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Stdout = Join-Path $LogRoot "controller-$Timestamp.out.log"
$Stderr = Join-Path $LogRoot "controller-$Timestamp.err.log"
$Gateway = Join-Path $Root "apps\gateway\dist\index.js"
if (-not (Test-Path $Gateway)) {
  throw "Kosh gateway build is missing. Run npm run build:gateway first."
}

$Node = (Get-Command node -ErrorAction Stop).Source
Write-Host "Starting Kosh Cloud Controller..."
Write-Host "State: $StateRoot"
Write-Host "Logs:  $LogRoot"

$Process = Start-Process -FilePath $Node -ArgumentList @("--env-file=$EnvPath", $Gateway) -WorkingDirectory $Root -RedirectStandardOutput $Stdout -RedirectStandardError $Stderr -PassThru -WindowStyle Hidden
$Process.Id | Set-Content -Encoding ASCII (Join-Path $StateRoot "controller.pid")
Write-Host "Kosh Cloud Controller started (PID $($Process.Id))."
