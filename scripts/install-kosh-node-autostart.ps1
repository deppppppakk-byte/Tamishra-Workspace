$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$watchdog = Join-Path $PSScriptRoot 'run-kosh-node-watchdog.ps1'
$taskName = 'Kosh Node'

if (-not (Test-Path $watchdog)) { throw 'Kosh watchdog script is missing.' }

$powerShell = (Get-Command powershell.exe).Source
$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdog`""

$action = New-ScheduledTaskAction -Execute $powerShell -Argument $arguments -WorkingDirectory $repoRoot
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggerLogon -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Installed Windows scheduled task '$taskName'." -ForegroundColor Green
Write-Host 'It will start automatically whenever this Windows user signs in.'
Write-Host 'Starting it now...'
Start-ScheduledTask -TaskName $taskName

Start-Sleep -Seconds 3
$task = Get-ScheduledTask -TaskName $taskName
Write-Host "Task state: $($task.State)"
