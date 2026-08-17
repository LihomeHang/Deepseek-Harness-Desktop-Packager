@echo off
setlocal
"%~dp0..\node-runtime\node.exe" "%~dp0..\app\node_modules\pnpm\bin\pnpm.mjs" %*
exit /b %ERRORLEVEL%
