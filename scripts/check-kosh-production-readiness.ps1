param(
  [string]$PublicOrigin = "https://tamishra.in/kosh",
  [string[]]$Repositories = @("tamishra/kavyn-2d", "tamishra/os")
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ControllerState = Join-Path $env:USERPROFILE ".kosh\cloud-controller"
$ControllerEnv = Join-Path $ControllerState "controller.env"
$AndroidConfig = Join-Path $env:USERPROFILE ".kosh\android-builder\config.json"

$Results = New-Object System.Collections.Generic.List[object]

function Add-Result([int]$Step, [string]$Name, [string]$State, [string]$Detail) {
  $Results.Add([pscustomobject]@{
    Step = $Step
    Name = $Name
    State = $State
    Detail = $Detail
  }) | Out-Null
}

function Read-EnvFile([string]$Path) {
  $map = @{}
  if (-not (Test-Path $Path)) { return $map }
  foreach ($line in Get-Content $Path) {
    $text = $line.Trim()
    if (-not $text -or $text.StartsWith('#')) { continue }
    $index = $text.IndexOf('=')
    if ($index -le 0) { continue }
    $map[$text.Substring(0, $index)] = $text.Substring($index + 1)
  }
  return $map
}

function Test-Http([string]$Url) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 15
    return [int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 400
  } catch {
    return $false
  }
}

function Git-LsRemote([string]$Url, [string]$Token) {
  $output = & git -c "http.extraHeader=Authorization: Bearer $Token" ls-remote $Url 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  return @($output)
}

$PublicOrigin = $PublicOrigin.TrimEnd('/')
$Env = Read-EnvFile $ControllerEnv
$GitToken = [string]$Env["KOSH_GIT_TOKEN"]

# 1. Production UI
$UiUrl = "https://tamishra.in/workspace/apps/kosh/build"
if (Test-Http $UiUrl) {
  Add-Result 1 "Workspace production UI" "PASS" $UiUrl
} else {
  Add-Result 1 "Workspace production UI" "FAIL" "Production UI is not reachable yet."
}

# 2. Kosh Cloud controller/relay public reachability
$HealthUrl = "$PublicOrigin/health"
if (Test-Http $HealthUrl) {
  Add-Result 2 "Kosh Cloud controller" "PASS" $HealthUrl
} elseif (Test-Path $ControllerEnv) {
  Add-Result 2 "Kosh Cloud controller" "BLOCKED" "Controller is configured locally but public health is unreachable. Check DNS/NAT/firewall and production routing."
} else {
  Add-Result 2 "Kosh Cloud controller" "BLOCKED" "No local controller configuration was found and public health is unreachable."
}

# 3. Android builder host
$AndroidTask = Get-ScheduledTask -TaskName "Kosh Android Builder" -ErrorAction SilentlyContinue
if ((Test-Path $AndroidConfig) -and $AndroidTask) {
  Add-Result 3 "Android Builder" "PASS" "Local Android Builder configuration and auto-start task are present."
} elseif (Test-Path $AndroidConfig) {
  Add-Result 3 "Android Builder" "BLOCKED" "Android Builder is configured locally, but the auto-start task is missing."
} else {
  Add-Result 3 "Android Builder" "BLOCKED" "Run SETUP-KOSH-ANDROID-BUILDER.cmd on the Windows build PC."
}

# 4. Android signing cannot be proven without an authenticated Kosh repository session.
Add-Result 4 "Android release signing" "VERIFY" "Check the repository's Kosh Secrets for ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD. Secret values are intentionally not read or printed by this script."

# 5. Real repository history in Kosh
if (-not $GitToken) {
  Add-Result 5 "Repository migration" "BLOCKED" "KOSH_GIT_TOKEN is not available from the local controller configuration, so repository history cannot be verified here."
} else {
  $missing = @()
  foreach ($repo in $Repositories) {
    $parts = $repo.Split('/', 2)
    if ($parts.Count -ne 2) {
      $missing += "$repo (invalid name)"
      continue
    }
    $url = "$PublicOrigin/git/$($parts[0])/$($parts[1]).git"
    $refs = Git-LsRemote $url $GitToken
    if ($null -eq $refs -or $refs.Count -eq 0) {
      $missing += $repo
    }
  }
  if ($missing.Count -eq 0) {
    Add-Result 5 "Repository migration" "PASS" "All configured repositories expose Git refs from Kosh."
  } else {
    Add-Result 5 "Repository migration" "BLOCKED" ("Missing/unreachable Git history: " + ($missing -join ', '))
  }
}

# 6. Transport smoke test
if (-not $GitToken -or -not (Test-Http $HealthUrl)) {
  Add-Result 6 "End-to-end transport smoke" "BLOCKED" "Requires a reachable public controller plus KOSH_GIT_TOKEN."
} else {
  $OldPublic = $env:KOSH_PUBLIC_ORIGIN
  $OldToken = $env:KOSH_GIT_TOKEN
  $OldRepo = $env:KOSH_REPOSITORY
  try {
    $env:KOSH_PUBLIC_ORIGIN = $PublicOrigin
    $env:KOSH_GIT_TOKEN = $GitToken
    $env:KOSH_REPOSITORY = $Repositories[0]
    Push-Location $Root
    try {
      & node scripts/kosh-online-smoke.mjs
      if ($LASTEXITCODE -eq 0) {
        Add-Result 6 "End-to-end transport smoke" "PASS" "Health + authenticated Git read + Git write authorization passed. APK/release proof still requires an online Android runner and configured signing secrets."
      } else {
        Add-Result 6 "End-to-end transport smoke" "FAIL" "kosh-online-smoke.mjs returned exit code $LASTEXITCODE."
      }
    } finally {
      Pop-Location
    }
  } finally {
    $env:KOSH_PUBLIC_ORIGIN = $OldPublic
    $env:KOSH_GIT_TOKEN = $OldToken
    $env:KOSH_REPOSITORY = $OldRepo
  }
}

Write-Host ""
Write-Host "Kosh Production Readiness"
Write-Host "========================="
$Results | Format-Table -AutoSize -Wrap

$Failed = @($Results | Where-Object { $_.State -in @("FAIL", "BLOCKED") })
if ($Failed.Count -gt 0) {
  Write-Host ""
  Write-Host "$($Failed.Count) blocking item(s) remain."
  exit 2
}

Write-Host ""
Write-Host "Core production readiness checks passed."
exit 0
