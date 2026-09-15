@echo off
REM Burtplace Workforce - double-click launcher for Windows.
REM Runs scripts\start.ps1 without changing the machine's PowerShell execution policy.
setlocal
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
if errorlevel 1 (
  echo.
  echo The launcher stopped with an error. The message above says what to fix.
  pause
)
