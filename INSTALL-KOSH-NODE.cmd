@echo off
setlocal
cd /d "%~dp0"
title Kosh Node Installer
echo.
echo Kosh Node Installer
echo ===================
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap-kosh-node.ps1"
set "EXITCODE=%ERRORLEVEL%"
echo.
if not "%EXITCODE%"=="0" (
  echo Kosh Node setup did not complete. Review the message above.
  echo Logs are stored under C:\Kosh\logs after the node starts.
) else (
  echo Kosh Node setup completed successfully.
)
echo.
pause
exit /b %EXITCODE%
