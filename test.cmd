@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tests\packager.tests.ps1"
exit /b %ERRORLEVEL%

