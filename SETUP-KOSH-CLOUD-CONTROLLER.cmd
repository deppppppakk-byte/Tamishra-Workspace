@echo off
setlocal
cd /d "%~dp0"
echo ======================================
echo   Kosh Cloud Controller Setup
echo ======================================
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-kosh-cloud-controller.ps1" -InstallToolchain -StartNow
set EXITCODE=%ERRORLEVEL%
echo.
if not "%EXITCODE%"=="0" (
  echo Kosh Cloud Controller setup failed with code %EXITCODE%.
) else (
  echo Kosh Cloud Controller setup completed.
)
pause
exit /b %EXITCODE%
