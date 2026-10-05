@echo off
setlocal
cd /d "%~dp0"
echo.
echo ========================================
echo   Kosh Node - Safe Update
echo ========================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\update-kosh-node.ps1"
set EXITCODE=%ERRORLEVEL%
echo.
if not "%EXITCODE%"=="0" (
  echo Update did not complete. Existing Kosh Node remains on the prior known-good build when rollback was possible.
) else (
  echo Update completed successfully.
)
pause
exit /b %EXITCODE%
