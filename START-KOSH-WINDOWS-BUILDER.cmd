@echo off
setlocal
cd /d "%~dp0"
title Kosh Windows Builder
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-kosh-windows-builder.ps1"
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo.
  echo Kosh Windows Builder stopped with code %EXITCODE%.
  pause
)
exit /b %EXITCODE%
