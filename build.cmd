@echo off
setlocal
cd /d "%~dp0"

echo DeepSeek Harness desktop packager
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build.ps1" %*
set "BUILD_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%BUILD_EXIT_CODE%"=="0" (
  echo Build failed. Check the latest file in the logs folder.
  pause
  exit /b %BUILD_EXIT_CODE%
)

echo Build completed. The installer is in the dist folder.
pause
exit /b 0

