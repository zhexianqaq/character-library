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
  echo [ERROR] Node.js not found. Please install Node.js 20 or newer.
  pause
  exit /b 1
)

if not exist "server\node_modules" (
  echo [SETUP] Installing dependencies for the first time...
  pushd server
  call npm install --no-audit --no-fund
  popd
)

echo [RUN] Starting character library on http://127.0.0.1:7788
"%NODE_BIN%" server\src\index.js --open

echo.
echo [STOP] Server exited.
pause
