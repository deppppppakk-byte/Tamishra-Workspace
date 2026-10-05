@echo off
setlocal
cd /d "%~dp0"
echo.
echo ========================================
echo   Kosh Node - Verified Backup
echo ========================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\backup-kosh-node.ps1"
set EXITCODE=%ERRORLEVEL%
echo.
if not "%EXITCODE%"=="0" (
  echo Backup failed. Check C:\Kosh\logs and the message above.
) else (
  echo Backup completed successfully.
)
pause
exit /b %EXITCODE%
