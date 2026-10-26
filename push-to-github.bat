@echo off
setlocal
cd /d "%~dp0"

rem Change this if you name the repo differently
set "REMOTE=https://github.com/zhexianqaq/character-library.git"

where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] git not found in PATH.
  pause
  exit /b 1
)

git remote get-url origin >nul 2>nul
if errorlevel 1 (
  echo [SETUP] adding remote %REMOTE%
  git remote add origin %REMOTE%
) else (
  echo [INFO] remote origin already set
)

echo.
echo [PUSH] pushing main and tags to GitHub ...
echo        A login window may pop up the first time - sign in once and it is remembered.
echo.
git push -u origin main
if errorlevel 1 goto fail
git push origin --tags
if errorlevel 1 goto fail

echo.
echo [OK] done -^> https://github.com/zhexianqaq/character-library
echo.
pause
exit /b 0

:fail
echo.
echo [FAILED] push failed, see messages above.
echo   - make sure the repository exists on GitHub and is empty (no README)
echo   - if login was cancelled, run this again
pause
exit /b 1
