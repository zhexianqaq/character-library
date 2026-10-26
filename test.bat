@echo off
setlocal
cd /d "%~dp0"

set "NODE_BIN="
where node >nul 2>nul
if not errorlevel 1 set "NODE_BIN=node"

if not defined NODE_BIN (
  if exist "C:\Users\35155\.workbuddy\binaries\node\versions\22.22.2-6\node.exe" (
    set "NODE_BIN=C:\Users\35155\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
  )
)

if not defined NODE_BIN (
  echo [ERROR] Node.js not found.
  pause
  exit /b 1
)

echo ============================================
echo  End-to-end test for Character Library
echo  Target: http://127.0.0.1:7788
echo  NOTE: start.bat must be running first.
echo ============================================
echo.

"%NODE_BIN%" tools\e2e.mjs

echo.
pause
