@echo off
setlocal
cd /d "%~dp0"
title Kosh Windows Builder Setup
echo.
echo ==========================================
echo   Kosh Windows Builder - Setup
echo ==========================================
echo.
echo This will configure this Windows PC to build EXE files for Kosh.
echo Required tools can be installed automatically with winget.
echo Your Kosh runner token will be encrypted locally by Windows.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-kosh-windows-builder.ps1" -InstallToolchain
set EXITCODE=%ERRORLEVEL%
echo.
if not "%EXITCODE%"=="0" (
  echo Kosh Windows Builder setup failed with code %EXITCODE%.
  echo Review the message above and run this file again.
) else (
  echo Kosh Windows Builder setup completed.
  echo Starting the builder now...
  start "Kosh Windows Builder" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-kosh-windows-builder.ps1"
)
echo.
pause
exit /b %EXITCODE%
