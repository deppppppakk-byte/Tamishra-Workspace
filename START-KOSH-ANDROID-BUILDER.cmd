@echo off
setlocal
cd /d "%~dp0"
echo Starting Kosh Android Builder...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-kosh-android-builder.ps1"
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo.
  echo Kosh Android Builder stopped with exit code %EXITCODE%.
  pause
)
exit /b %EXITCODE%
