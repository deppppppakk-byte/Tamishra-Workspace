$ErrorActionPreference = 'Continue'

function Check-Url([string]$label, [string]$url) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 8
    $ok = $response.StatusCode -ge 200 -and $response.StatusCode -lt 400
    $state = if ($ok) { 'ONLINE' } else { "HTTP $($response.StatusCode)" }
    Write-Host ("{0,-22} {1}" -f $label, $state) -ForegroundColor $(if ($ok) { 'Green' } else { 'Yellow' })
    return $ok
  } catch {
    Write-Host ("{0,-22} OFFLINE" -f $label) -ForegroundColor Red
    return $false
  }
}

Write-Host ''
Write-Host 'Kosh Node status' -ForegroundColor Cyan
Write-Host '================' -ForegroundColor Cyan

$task = Get-ScheduledTask -TaskName 'Kosh Node' -ErrorAction SilentlyContinue
if ($task) {
  Write-Host ("{0,-22} {1}" -f 'Windows auto-start', $task.State) -ForegroundColor Green
} else {
  Write-Host ("{0,-22} NOT INSTALLED" -f 'Windows auto-start') -ForegroundColor Yellow
}

$local = Check-Url 'Local gateway' 'http://127.0.0.1:4100/health'
$tunnel = Check-Url 'Public node' 'https://kosh-node.tamishra.in/health'
$public = Check-Url 'Tamishra Kosh route' 'https://tamishra.in/kosh/health'

try {
  $drive = Get-PSDrive -Name 'C'
  $freeGb = [math]::Round($drive.Free / 1GB, 1)
  $diskState = if ($freeGb -ge 5) { "$freeGb GB free" } else { "$freeGb GB free - LOW" }
  Write-Host ("{0,-22} {1}" -f 'Repository disk', $diskState) -ForegroundColor $(if ($freeGb -ge 5) { 'Green' } else { 'Yellow' })
} catch {
  Write-Host ("{0,-22} UNKNOWN" -f 'Repository disk') -ForegroundColor Yellow
}

$manifest = 'C:\Kosh\backups\latest-manifest.json'
if (Test-Path $manifest) {
  $ageHours = [math]::Round(((Get-Date) - (Get-Item $manifest).LastWriteTime).TotalHours, 1)
  $backupState = if ($ageHours -le 8) { "$ageHours h ago" } else { "$ageHours h ago - STALE" }
  Write-Host ("{0,-22} {1}" -f 'Verified backup', $backupState) -ForegroundColor $(if ($ageHours -le 8) { 'Green' } else { 'Yellow' })
} else {
  Write-Host ("{0,-22} NONE YET" -f 'Verified backup') -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Repository: https://tamishra.in/kosh/git/tamishra/kavyn-2d.git'
Write-Host 'Logs:       C:\Kosh\logs'
Write-Host 'Backups:    C:\Kosh\backups'

if ($local -and $tunnel -and $public) {
  Write-Host ''
  Write-Host 'Kosh Node is ONLINE.' -ForegroundColor Green
  exit 0
}

Write-Host ''
Write-Host 'Kosh Node is not fully online. Run INSTALL-KOSH-NODE.cmd or inspect C:\Kosh\logs.' -ForegroundColor Yellow
exit 1
