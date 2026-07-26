@echo off
setlocal

rem ASCII only on purpose: cmd.exe reads .bat files in the OEM codepage,
rem so Cyrillic comments here get mangled into bogus commands.
rem
rem /d is required: without it, "cd D:\..." does not switch the drive.
cd /d "%~dp0app" || goto :nofolder

set "ELECTRON=node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" (
  echo Installing dependencies, this runs only once...
  call npm install --no-audit --no-fund || goto :nonode
)

rem "start" detaches the app so this console closes immediately.
start "" "%ELECTRON%" "."
exit /b 0

:nofolder
echo Folder not found: %~dp0app
pause
exit /b 1

:nonode
echo.
echo npm install failed. Is Node.js installed?  https://nodejs.org
pause
exit /b 1
