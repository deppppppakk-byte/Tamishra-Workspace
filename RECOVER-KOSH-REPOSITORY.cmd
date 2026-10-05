@echo off
setlocal
cd /d "%~dp0"
echo.
echo ========================================
echo   Kosh Repository Recovery
echo ========================================
echo.
set /p NS=Namespace [tamishra]: 
if "%NS%"=="" set NS=tamishra
set /p SLUG=Repository slug: 
if "%SLUG%"=="" (
  echo Repository slug is required.
  pause
  exit /b 1
)
echo.
echo This restores the newest verified bundle for %NS%/%SLUG%.
echo If a repository already exists, recovery will not overwrite it automatically.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\recover-kosh-repository.ps1" -Namespace "%NS%" -Slug "%SLUG%"
set EXITCODE=%ERRORLEVEL%
echo.
pause
exit /b %EXITCODE%
