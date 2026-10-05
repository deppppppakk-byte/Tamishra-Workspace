$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is required.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is required.' }

$dirty = git status --porcelain
if ($dirty) {
  throw 'Kosh Node update stopped because the working copy has local changes. Commit or move them first.'
}

$before = (git rev-parse HEAD).Trim()
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if (-not $before -or -not $branch -or $branch -eq 'HEAD') { throw 'Kosh Node must be on a normal Git branch to update safely.' }

Write-Host "Current Kosh Node: $before" -ForegroundColor Cyan
Write-Host "Branch: $branch"
Write-Host 'Fetching configured origin...'
git fetch --prune origin
if ($LASTEXITCODE -ne 0) { throw 'Could not fetch the configured Kosh source remote.' }

$upstream = "origin/$branch"
git rev-parse --verify $upstream *> $null
if ($LASTEXITCODE -ne 0) { throw "Remote branch $upstream does not exist." }

$behind = [int]((git rev-list --count "HEAD..$upstream").Trim())
$ahead = [int]((git rev-list --count "$upstream..HEAD").Trim())
if ($ahead -gt 0) { throw 'Local Kosh Node has commits not present on the configured origin. Automatic update is intentionally blocked.' }
if ($behind -eq 0) {
  Write-Host 'Kosh Node is already up to date.' -ForegroundColor Green
  exit 0
}

Write-Host "Applying $behind fast-forward commit(s)..."
git merge --ff-only $upstream
if ($LASTEXITCODE -ne 0) { throw 'Fast-forward update failed.' }

try {
  npm ci
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed after update.' }
  npm run kosh:node:build
  if ($LASTEXITCODE -ne 0) { throw 'Kosh Node build failed after update.' }
} catch {
  Write-Warning 'New Kosh build failed. Rolling back to the previous known-good commit.'
  git reset --hard $before
  npm ci
  npm run kosh:node:build
  throw
}

$task = Get-ScheduledTask -TaskName 'Kosh Node' -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName 'Kosh Node' -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName 'Kosh Node'
}

$after = (git rev-parse HEAD).Trim()
Write-Host ''
Write-Host "Kosh Node updated successfully: $before -> $after" -ForegroundColor Green
Write-Host 'Run CHECK-KOSH-NODE.cmd to confirm public health.'
