@echo off
setlocal
cd /d "%~dp0"
title Agenite Local Server

rem optional arg: start.cmd D:\your-project  (sets the agent workspace)
if not "%~1"=="" set "AGENITE_WORKSPACE=%~1"

rem === locate node even if it is NOT on PATH (e.g. WorkBuddy-managed node) ===
rem NOTE: deliberately NO "goto" inside ( ) blocks -- cmd mis-resolves labels there.
set "NODE_BIN="
where node >nul 2>nul
if not errorlevel 1 set "NODE_BIN=node"
if not defined NODE_BIN if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_BIN=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_BIN if exist "C:\Program Files\nodejs\node.exe" set "NODE_BIN=C:\Program Files\nodejs\node.exe"
if not defined NODE_BIN if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODE_BIN=C:\Program Files (x86)\nodejs\node.exe"
for /d %%V in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do ( if not defined NODE_BIN if exist "%%V\node.exe" set "NODE_BIN=%%V\node.exe" )

if not defined NODE_BIN (
  echo.
  echo   [Agenite] Node.js not found.
  echo   Install Node 18 or newer: https://nodejs.org
  echo   Then double-click this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting Agenite local server, browser will open automatically...
echo   Close this window to stop.
echo.

"%NODE_BIN%" server.js --open
set "RC=%errorlevel%"
echo.
if not "%RC%"=="0" (
  echo   Server exited with an error (code %RC%). See the message above.
) else (
  echo   Server stopped.
)
pause
