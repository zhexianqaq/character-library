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

echo [BACKUP] Copying E:\CharacterLibrary to E:\CharacterLibrary-Backup ...
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
