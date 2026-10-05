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

Write-Host ''
Write-Host 'Repository: https://tamishra.in/kosh/git/tamishra/kavyn-2d.git'
Write-Host 'Logs:       C:\Kosh\logs'

if ($local -and $tunnel -and $public) {
  Write-Host ''
  Write-Host 'Kosh Node is ONLINE.' -ForegroundColor Green
  exit 0
}

Write-Host ''
Write-Host 'Kosh Node is not fully online. Run INSTALL-KOSH-NODE.cmd or inspect C:\Kosh\logs.' -ForegroundColor Yellow
exit 1
