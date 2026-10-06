param(
  [switch]$InstallToolchain,
  [switch]$StartNow,
  [int]$Port = 4100,
  [string]$PublicOrigin = "https://tamishra.in/kosh"
)

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "Kosh Cloud Controller setup must run on Windows." }
if ($Port -lt 1 -or $Port -gt 65535) { throw "Port must be between 1 and 65535." }

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$StateRoot = Join-Path $env:USERPROFILE ".kosh\cloud-controller"
$EnvPath = Join-Path $StateRoot "controller.env"
$StartScript = Join-Path $Root "scripts\start-kosh-cloud-controller.ps1"
$RepoCache = "C:\Kosh\cloud-cache\repos"

function Has-Command([string]$Name) {
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
}

function Install-WingetPackage([string]$Id) {
  if (-not (Has-Command "winget")) {
    throw "winget is required for automatic setup. Install App Installer, then rerun."
  }
  & winget install --id $Id --exact --accept-package-agreements --accept-source-agreements --silent
  if ($LASTEXITCODE -ne 0) { throw "winget failed while installing $Id." }
  Refresh-Path
}

function New-Secret([int]$Bytes = 32) {
  $buffer = New-Object byte[] $Bytes
  [Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return ([Convert]::ToBase64String($buffer)).TrimEnd('=').Replace('+','-').Replace('/','_')
}

function Read-SecretText([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

if ($InstallToolchain) {
  if (-not (Has-Command "git")) { Install-WingetPackage "Git.Git" }
  if (-not (Has-Command "node")) { Install-WingetPackage "OpenJS.NodeJS.LTS" }
}

$Missing = @("git", "node", "npm") | Where-Object { -not (Has-Command $_) }
if ($Missing.Count -gt 0) {
  throw "Missing required tools: $($Missing -join ', '). Rerun with -InstallToolchain or install them first."
}

$NodeMajor = [int]((& node -p "process.versions.node.split('.')[0]").Trim())
if ($NodeMajor -lt 22) { throw "Node.js 22 or newer is required." }

$DatabaseUrl = Read-SecretText "Enter WORKSPACE_DATABASE_URL (stored only on this PC)"
if ([string]::IsNullOrWhiteSpace($DatabaseUrl)) { throw "WORKSPACE_DATABASE_URL is required." }

New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null
New-Item -ItemType Directory -Force -Path $RepoCache | Out-Null

$IpHashSecret = New-Secret 32
$EnrollmentSecret = New-Secret 32
$GitToken = New-Secret 32
$RunnerToken = New-Secret 32

$EnvLines = @(
  "NODE_ENV=production",
  "WORKSPACE_CORE_ONLY=true",
  "WORKSPACE_GATEWAY_PORT=$Port",
  "WORKSPACE_DATABASE_URL=$DatabaseUrl",
  "WORKSPACE_ALLOWED_ORIGINS=https://tamishra.in,https://www.tamishra.in,https://kosh.tamishra.in",
  "WORKSPACE_IP_HASH_SECRET=$IpHashSecret",
  "WORKSPACE_SESSION_COOKIE_SECURE=true",
  "WORKSPACE_SESSION_COOKIE_PATH=/api/workspace",
  "WORKSPACE_TRUST_PROXY=true",
  "KOSH_PUBLIC_ORIGIN=$($PublicOrigin.TrimEnd('/'))",
  "KOSH_REPO_PERSISTENCE=postgres",
  "KOSH_REPO_AUTHORITY=online",
  "KOSH_REPO_SNAPSHOT_MAX_MB=512",
  "KOSH_REPO_ROOT=$($RepoCache.Replace('\\','/'))",
  "KOSH_BOOTSTRAP_REPOSITORIES=tamishra/kavyn-2d,tamishra/os",
  "KOSH_BOOTSTRAP_SINGLE_OWNER_FALLBACK=true",
  "KOSH_CLOUD_ENABLED=true",
  "KOSH_CLOUD_NODE_ENROLLMENT_SECRET=$EnrollmentSecret",
  "KOSH_CLOUD_RELAY_MAX_BODY_MB=8",
  "KOSH_CLOUD_RELAY_TIMEOUT_MS=30000",
  "KOSH_GIT_TOKEN=$GitToken",
  "KOSH_RUNNER_TOKEN=$RunnerToken",
  "KOSH_RUNNER_ALLOW_HOST_EXECUTION=true",
  "KOSH_RUNNER_ALLOW_NETWORK=true",
  "KOSH_PACKAGE_MAX_MB=512",
  "KOSH_NATIVE_STORAGE_SELFTEST=false"
)
$EnvLines | Set-Content -Encoding UTF8 $EnvPath
& icacls.exe $EnvPath /inheritance:r /grant:r "$env:USERNAME:(R,W)" | Out-Null

Write-Host "[Kosh Cloud] Installing workspace dependencies and building gateway..."
Push-Location $Root
try {
  & npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
  & npm run build:gateway
  if ($LASTEXITCODE -ne 0) { throw "Kosh gateway build failed." }
} finally {
  Pop-Location
}

$TaskName = "Kosh Cloud Controller"
$TaskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$StartScript`""
& schtasks.exe /Create /F /SC ONLOGON /TN $TaskName /TR $TaskCommand | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Warning "Could not create the auto-start task. Start the controller manually with the start script."
} else {
  Write-Host "[Kosh Cloud] Auto-start task installed: $TaskName"
}

if ($StartNow) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $StartScript
}

Write-Host ""
Write-Host "Kosh Cloud Controller is configured."
Write-Host "Public origin: $($PublicOrigin.TrimEnd('/'))"
Write-Host "Local port:   $Port"
Write-Host "Private env:  $EnvPath"
Write-Host "Repo cache:   $RepoCache"
Write-Host ""
Write-Host "IMPORTANT: DNS/NAT/firewall must make the controller reachable from the public Kosh route."
Write-Host "The generated database and authentication secrets were not printed and were not committed."
