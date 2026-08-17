@echo off
setlocal
if not defined DSH_HOME set "DSH_HOME=%APPDATA%\DeepSeek Harness\dsh-home"
set "PATH=%~dp0;%PATH%"
"%~dp0..\node-runtime\node.exe" "%~dp0..\app\node_modules\@deepseek-ai\dsh\lib\bin.js" %*
exit /b %ERRORLEVEL%
