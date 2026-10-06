@echo off
setlocal
cd /d "%~dp0"
echo ======================================
echo   Kosh Production Readiness Check
echo ======================================
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\check-kosh-production-readiness.ps1"
set EXITCODE=%ERRORLEVEL%
echo.
if "%EXITCODE%"=="0" (
  echo Kosh production readiness checks passed.
) else (
  echo Kosh still has one or more commissioning blockers.
)
pause
exit /b %EXITCODE%
