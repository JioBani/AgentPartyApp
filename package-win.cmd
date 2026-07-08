@echo off
setlocal enableextensions
rem ============================================================
rem  AgentParty - One-click Windows packaging (CLI progress UI)
rem  Double-click this file to build + package the latest source.
rem  Output: release\  (NSIS installer + portable exe)
rem ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found on PATH. Install it first: https://nodejs.org/
  echo Press any key to close.
  pause >nul
  exit /b 1
)

node scripts\package-win.mjs
set EXITCODE=%errorlevel%

echo.
echo Press any key to close.
pause >nul
exit /b %EXITCODE%
