@echo off
setlocal
cd /d "%~dp0"
echo Synchronizing verified Kosh standby backups...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\sync-kosh-standby.ps1"
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo Kosh standby sync failed with exit code %RC%.
) else (
  echo Kosh standby sync completed.
)
pause
exit /b %RC%
