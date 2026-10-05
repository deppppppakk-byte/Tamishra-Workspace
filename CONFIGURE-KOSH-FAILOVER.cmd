@echo off
setlocal
cd /d "%~dp0"
echo Configuring Kosh primary failover replication...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\configure-kosh-failover-primary.ps1"
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo Kosh failover configuration failed with exit code %RC%.
) else (
  echo Kosh primary failover replication is configured.
)
pause
exit /b %RC%
