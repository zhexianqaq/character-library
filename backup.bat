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

echo [BACKUP] Copying D:\CharacterLibrary to D:\CharacterLibrary-Backup ...
echo          (server can keep running)
echo.

"%NODE_BIN%" tools\backup.mjs

if errorlevel 1 (
  echo.
  echo [FAILED] Backup did not pass verification. Check the messages above.
) else (
  echo.
  echo [OK] Backup finished.
)
echo.
pause
