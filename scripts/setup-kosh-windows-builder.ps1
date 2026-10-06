param(
  [switch]$InstallToolchain,
  [string]$Gateway = "https://tamishra.in/api/workspace"
)

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "Kosh Windows Builder setup must run on Windows." }

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$StateRoot = Join-Path $env:USERPROFILE ".kosh\windows-builder"
$ConfigPath = Join-Path $StateRoot "config.json"
$StartScript = Join-Path $Root "scripts\start-kosh-windows-builder.ps1"

function Has-Command([string]$Name) {
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Install-WingetPackage([string]$Id, [string[]]$Extra = @()) {
  if (-not (Has-Command "winget")) {
    throw "winget is required for automatic toolchain installation. Install App Installer from Microsoft Store, then rerun."
  }
  Write-Host "[Kosh Build] Installing $Id..."
  $Args = @("install", "--id", $Id, "--exact", "--accept-package-agreements", "--accept-source-agreements", "--silent") + $Extra
  & winget @Args
  if ($LASTEXITCODE -ne 0) { throw "winget failed while installing $Id." }
}

if ($InstallToolchain) {
  if (-not (Has-Command "git")) { Install-WingetPackage "Git.Git" }
  if (-not (Has-Command "node")) { Install-WingetPackage "OpenJS.NodeJS.LTS" }
  if (-not (Has-Command "python") -and -not (Has-Command "py")) { Install-WingetPackage "Python.Python.3.12" }
  if (-not (Has-Command "cmake")) { Install-WingetPackage "Kitware.CMake" }

  $VsWhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  $HasCpp = $false
  if (Test-Path $VsWhere) {
    $CppInstall = & $VsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    $HasCpp = -not [string]::IsNullOrWhiteSpace(($CppInstall | Out-String))
  }
  if (-not $HasCpp) {
    if (-not (Has-Command "winget")) { throw "Visual Studio Build Tools with C++ workload is required." }
    Write-Host "[Kosh Build] Installing Visual Studio 2022 Build Tools C++ workload. This can take several minutes..."
    & winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --accept-package-agreements --accept-source-agreements --silent --override "--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    if ($LASTEXITCODE -ne 0) { throw "Visual Studio Build Tools installation failed." }
  }
}

$Required = @("git", "node", "npm", "cmake")
$Missing = @($Required | Where-Object { -not (Has-Command $_) })
if ($Missing.Count -gt 0) {
  throw "Missing required tools: $($Missing -join ', '). Rerun with -InstallToolchain or install them first."
}
if (-not (Has-Command "python") -and -not (Has-Command "py")) {
  throw "Python 3 is required for KavYN Windows packaging."
}

$TokenSecure = Read-Host "Enter KOSH_RUNNER_TOKEN (stored locally using Windows encryption)" -AsSecureString
$EncryptedToken = ConvertFrom-SecureString $TokenSecure
if ([string]::IsNullOrWhiteSpace($EncryptedToken)) { throw "Runner token is required." }

New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null
$Config = [ordered]@{
  gateway = $Gateway.TrimEnd('/')
  encryptedRunnerToken = $EncryptedToken
  runnerId = "windows-builder-$($env:COMPUTERNAME.ToLowerInvariant())"
  labels = @("windows-build", "toolchain:msvc", "toolchain:cmake", "toolchain:python", "toolchain:pyinstaller")
  concurrency = 1
  packageMaxMb = 512
  repositoryRoot = $Root
  configuredAt = (Get-Date).ToUniversalTime().ToString("o")
}
$Config | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $ConfigPath

Write-Host "[Kosh Build] Installing workspace dependencies and compiling Kosh Runner..."
Push-Location $Root
try {
  & npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
  & npm run build --workspace @tamishra/kosh-runner
  if ($LASTEXITCODE -ne 0) { throw "Kosh Runner build failed." }
} finally {
  Pop-Location
}

$TaskName = "Kosh Windows Builder"
$TaskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$StartScript`""
& schtasks.exe /Create /F /SC ONLOGON /TN $TaskName /TR $TaskCommand | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Warning "Could not create the auto-start task. The builder can still be started manually."
} else {
  Write-Host "[Kosh Build] Auto-start task installed: $TaskName"
}

Write-Host ""
Write-Host "Kosh Windows Builder is configured."
Write-Host "Config: $ConfigPath"
Write-Host "Start now: powershell -ExecutionPolicy Bypass -File `"$StartScript`""
Write-Host "The runner token was not written to the repository."
