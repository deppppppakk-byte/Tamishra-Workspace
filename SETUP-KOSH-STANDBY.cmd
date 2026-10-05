@echo off
setlocal
cd /d "%~dp0"
echo Setting up Kosh standby node...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\setup-kosh-standby.ps1"
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" (
  echo Kosh standby setup failed with exit code %RC%.
) else (
  echo Kosh standby node is ready.
)
pause
exit /b %RC%
