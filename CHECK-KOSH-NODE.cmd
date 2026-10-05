@echo off
setlocal
cd /d "%~dp0"
title Kosh Node Status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\status-kosh-node.ps1"
set "EXITCODE=%ERRORLEVEL%"
echo.
pause
exit /b %EXITCODE%
