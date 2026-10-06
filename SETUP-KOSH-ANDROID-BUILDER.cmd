@echo off
setlocal
cd /d "%~dp0"
echo.
echo ======================================
echo   Kosh Android Builder Setup
 echo ======================================
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-kosh-android-builder.ps1" -InstallToolchain -InstallFlutter
set EXITCODE=%ERRORLEVEL%
echo.
if not "%EXITCODE%"=="0" (
  echo Kosh Android Builder setup failed with exit code %EXITCODE%.
  echo Review the message above and rerun this file.
) else (
  echo Kosh Android Builder setup completed.
  echo You can now run START-KOSH-ANDROID-BUILDER.cmd.
)
echo.
pause
exit /b %EXITCODE%
