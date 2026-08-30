@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0demo.ps1"
set "REPO_RESCUE_EXIT=%ERRORLEVEL%"
pause
exit /b %REPO_RESCUE_EXIT%
