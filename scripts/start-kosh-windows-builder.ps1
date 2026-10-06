$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "Kosh Windows Builder can only run on Windows." }

$StateRoot = Join-Path $env:USERPROFILE ".kosh\windows-builder"
$ConfigPath = Join-Path $StateRoot "config.json"
if (-not (Test-Path $ConfigPath)) {
  throw "Kosh Windows Builder is not configured. Run scripts\setup-kosh-windows-builder.ps1 first."
}

$Config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$Root = [string]$Config.repositoryRoot
if ([string]::IsNullOrWhiteSpace($Root) -or -not (Test-Path $Root)) {
  throw "Configured Tamishra-Workspace path is unavailable."
}

$SecureToken = ConvertTo-SecureString ([string]$Config.encryptedRunnerToken)
$Credential = New-Object System.Management.Automation.PSCredential("kosh-runner", $SecureToken)
$RunnerToken = $Credential.GetNetworkCredential().Password
if ([string]::IsNullOrWhiteSpace($RunnerToken)) { throw "Could not decrypt KOSH_RUNNER_TOKEN." }

$env:KOSH_GATEWAY_ORIGIN = ([string]$Config.gateway).TrimEnd('/')
$env:KOSH_RUNNER_TOKEN = $RunnerToken
$env:KOSH_RUNNER_ID = [string]$Config.runnerId
$env:KOSH_RUNNER_EXECUTOR = "host"
$env:KOSH_RUNNER_ALLOW_HOST_EXECUTION = "true"
$env:KOSH_RUNNER_ALLOW_NETWORK = "true"
$env:KOSH_RUNNER_CONCURRENCY = [string]$Config.concurrency
$env:KOSH_RUNNER_LABELS = (@($Config.labels) -join ",")
$env:KOSH_RUNNER_PACKAGE_MAX_MB = [string]$Config.packageMaxMb
$env:NODE_ENV = "production"

Write-Host "[Kosh Build] Starting Windows Builder $env:KOSH_RUNNER_ID"
Write-Host "[Kosh Build] Gateway: $env:KOSH_GATEWAY_ORIGIN"
Write-Host "[Kosh Build] Labels: $env:KOSH_RUNNER_LABELS"

Push-Location $Root
try {
  if (-not (Test-Path (Join-Path $Root "apps\kosh-runner\dist\index.js"))) {
    & npm run build --workspace @tamishra/kosh-runner
    if ($LASTEXITCODE -ne 0) { throw "Kosh Runner build failed." }
  }
  & node "apps\kosh-runner\dist\index.js"
  if ($LASTEXITCODE -ne 0) { throw "Kosh Windows Builder exited with code $LASTEXITCODE." }
} finally {
  $env:KOSH_RUNNER_TOKEN = ""
  Pop-Location
}
