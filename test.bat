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
