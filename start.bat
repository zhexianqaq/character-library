@echo off
setlocal
cd /d "%~dp0"

set "NODE_BIN="
where node >nul 2>nul
if not errorlevel 1 set "NODE_BIN=node"

if not defined NODE_BIN (
  if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
)
rem portable node: managed environments keep several versions side by side
if not defined NODE_BIN (
  for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if not defined NODE_BIN if exist "%%D\node.exe" set "NODE_BIN=%%D\node.exe"
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
