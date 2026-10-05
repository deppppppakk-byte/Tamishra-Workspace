@echo off
setlocal
cd /d "%~dp0"
echo.
echo WARNING: Run this only when the PRIMARY Kosh PC is genuinely offline.
echo The promotion script performs repeated health checks and will block if primary is reachable.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\promote-kosh-standby.ps1"
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo Kosh standby promotion did not complete. Exit code %RC%.
) else (
  echo Kosh standby promotion completed successfully.
)
pause
exit /b %RC%
