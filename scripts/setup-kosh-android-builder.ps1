param(
  [switch]$InstallToolchain,
  [switch]$InstallFlutter,
  [string]$Gateway = "https://tamishra.in/api/workspace"
)

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "Kosh Android Builder setup must run on Windows." }

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$StateRoot = Join-Path $env:USERPROFILE ".kosh\android-builder"
$ConfigPath = Join-Path $StateRoot "config.json"
$StartScript = Join-Path $Root "scripts\start-kosh-android-builder.ps1"
$ToolsRoot = Join-Path $env:USERPROFILE ".kosh\tools"
$SdkRoot = Join-Path $env:LOCALAPPDATA "Android\Sdk"
$FlutterRoot = Join-Path $ToolsRoot "flutter"

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
    throw "winget is required for automatic Android Builder setup. Install App Installer from Microsoft Store, then rerun."
  }
  Write-Host "[Kosh Android] Installing $Id..."
  & winget install --id $Id --exact --accept-package-agreements --accept-source-agreements --silent
  if ($LASTEXITCODE -ne 0) { throw "winget failed while installing $Id." }
  Refresh-Path
}

function Find-JavaHome {
  if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME "bin\java.exe"))) {
    return $env:JAVA_HOME
  }
  $java = Get-Command java -ErrorAction SilentlyContinue
  if ($java) {
    $bin = Split-Path $java.Source -Parent
    $home = Split-Path $bin -Parent
    if (Test-Path (Join-Path $home "bin\java.exe")) { return $home }
  }
  $candidates = @(
    "C:\Program Files\Eclipse Adoptium",
    "C:\Program Files\Microsoft",
    "C:\Program Files\Java"
  )
  foreach ($base in $candidates) {
    if (-not (Test-Path $base)) { continue }
    $javaExe = Get-ChildItem $base -Recurse -Filter java.exe -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match "\\bin\\java\.exe$" } |
      Select-Object -First 1
    if ($javaExe) { return Split-Path (Split-Path $javaExe.FullName -Parent) -Parent }
  }
  return $null
}

function Find-SdkManager([string]$Sdk) {
  $known = @(
    (Join-Path $Sdk "cmdline-tools\latest\bin\sdkmanager.bat"),
    (Join-Path $Sdk "cmdline-tools\bin\sdkmanager.bat"),
    (Join-Path $Sdk "tools\bin\sdkmanager.bat")
  )
  foreach ($item in $known) {
    if (Test-Path $item) { return $item }
  }
  return $null
}

function Install-AndroidCommandLineTools([string]$Sdk) {
  New-Item -ItemType Directory -Force -Path $Sdk | Out-Null
  $manager = Find-SdkManager $Sdk
  if ($manager) { return $manager }

  $download = Join-Path $env:TEMP "kosh-android-commandlinetools.zip"
  $expand = Join-Path $env:TEMP ("kosh-android-commandlinetools-" + [guid]::NewGuid().ToString("N"))
  $url = "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip"
  Write-Host "[Kosh Android] Installing Android command-line tools..."
  Invoke-WebRequest -Uri $url -OutFile $download -UseBasicParsing
  Expand-Archive -Path $download -DestinationPath $expand -Force

  $latest = Join-Path $Sdk "cmdline-tools\latest"
  Remove-Item $latest -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path (Split-Path $latest -Parent) | Out-Null
  $source = Join-Path $expand "cmdline-tools"
  if (-not (Test-Path $source)) { throw "Android command-line tools archive layout was unexpected." }
  Move-Item $source $latest -Force
  Remove-Item $download -Force -ErrorAction SilentlyContinue
  Remove-Item $expand -Recurse -Force -ErrorAction SilentlyContinue

  $manager = Find-SdkManager $Sdk
  if (-not $manager) { throw "sdkmanager.bat was not installed correctly." }
  return $manager
}

function Install-AndroidSdkPackages([string]$SdkManager, [string]$Sdk) {
  $env:ANDROID_HOME = $Sdk
  $env:ANDROID_SDK_ROOT = $Sdk
  Write-Host "[Kosh Android] Accepting Android SDK licenses..."
  1..80 | ForEach-Object { "y" } | & $SdkManager --licenses | Out-Null

  Write-Host "[Kosh Android] Installing platform tools and Android build tools..."
  & $SdkManager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Android 36 packages were unavailable. Falling back to Android 35."
    & $SdkManager "platform-tools" "platforms;android-35" "build-tools;35.0.0"
    if ($LASTEXITCODE -ne 0) { throw "Android SDK package installation failed." }
  }
}

if ($InstallToolchain) {
  if (-not (Has-Command "git")) { Install-WingetPackage "Git.Git" }
  if (-not (Has-Command "node")) { Install-WingetPackage "OpenJS.NodeJS.LTS" }
  if (-not (Has-Command "java")) { Install-WingetPackage "EclipseAdoptium.Temurin.17.JDK" }
  Refresh-Path
}

$Required = @("git", "node", "npm")
$Missing = @($Required | Where-Object { -not (Has-Command $_) })
if ($Missing.Count -gt 0) {
  throw "Missing required tools: $($Missing -join ', '). Rerun with -InstallToolchain or install them first."
}

$JavaHome = Find-JavaHome
if (-not $JavaHome) {
  throw "JDK 17+ was not found. Rerun with -InstallToolchain or install a supported JDK."
}
$env:JAVA_HOME = $JavaHome
$env:Path = (Join-Path $JavaHome "bin") + ";" + $env:Path

$SdkManager = Find-SdkManager $SdkRoot
if (-not $SdkManager) {
  if (-not $InstallToolchain) {
    throw "Android SDK command-line tools were not found. Rerun with -InstallToolchain."
  }
  $SdkManager = Install-AndroidCommandLineTools $SdkRoot
}
if ($InstallToolchain) {
  Install-AndroidSdkPackages $SdkManager $SdkRoot
}

$FlutterInstalled = Has-Command "flutter"
if ($InstallFlutter -and -not $FlutterInstalled) {
  New-Item -ItemType Directory -Force -Path $ToolsRoot | Out-Null
  if (Test-Path $FlutterRoot) { Remove-Item $FlutterRoot -Recurse -Force }
  Write-Host "[Kosh Android] Installing Flutter stable SDK..."
  & git clone --depth 1 --branch stable https://github.com/flutter/flutter.git $FlutterRoot
  if ($LASTEXITCODE -ne 0) { throw "Flutter SDK installation failed." }
  $env:Path = (Join-Path $FlutterRoot "bin") + ";" + $env:Path
  $FlutterInstalled = $true
  & flutter config --android-sdk $SdkRoot | Out-Null
  & flutter doctor --android-licenses < $null
}

$TokenSecure = Read-Host "Enter KOSH_RUNNER_TOKEN (stored locally using Windows encryption)" -AsSecureString
$EncryptedToken = ConvertFrom-SecureString $TokenSecure
if ([string]::IsNullOrWhiteSpace($EncryptedToken)) { throw "Runner token is required." }

$Labels = @("android-build", "toolchain:jdk17", "toolchain:android-sdk", "toolchain:gradle", "toolchain:node")
if ($FlutterInstalled -or (Test-Path (Join-Path $FlutterRoot "bin\flutter.bat"))) {
  $Labels += "toolchain:flutter"
}

New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null
$Config = [ordered]@{
  gateway = $Gateway.TrimEnd('/')
  encryptedRunnerToken = $EncryptedToken
  runnerId = "android-builder-$($env:COMPUTERNAME.ToLowerInvariant())"
  labels = $Labels
  concurrency = 1
  packageMaxMb = 512
  repositoryRoot = $Root
  androidSdkRoot = $SdkRoot
  javaHome = $JavaHome
  flutterRoot = if (Test-Path $FlutterRoot) { $FlutterRoot } else { "" }
  configuredAt = (Get-Date).ToUniversalTime().ToString("o")
}
$Config | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $ConfigPath

Write-Host "[Kosh Android] Installing workspace dependencies and compiling Kosh Runner..."
Push-Location $Root
try {
  & npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
  & npm run build --workspace @tamishra/kosh-runner
  if ($LASTEXITCODE -ne 0) { throw "Kosh Runner build failed." }
} finally {
  Pop-Location
}

$TaskName = "Kosh Android Builder"
$TaskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$StartScript`""
& schtasks.exe /Create /F /SC ONLOGON /TN $TaskName /TR $TaskCommand | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Warning "Could not create the auto-start task. The Android Builder can still be started manually."
} else {
  Write-Host "[Kosh Android] Auto-start task installed: $TaskName"
}

Write-Host ""
Write-Host "Kosh Android Builder is configured."
Write-Host "Android SDK: $SdkRoot"
Write-Host "Java: $JavaHome"
Write-Host "Flutter: $FlutterInstalled"
Write-Host "Config: $ConfigPath"
Write-Host "Start now: powershell -ExecutionPolicy Bypass -File `"$StartScript`""
Write-Host "The runner token was not written to the repository."
