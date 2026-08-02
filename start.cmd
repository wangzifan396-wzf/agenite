@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Agenite 本地服务

rem 可选参数: start.cmd D:\你的项目  —— 让智能体在该目录里干活
if not "%~1"=="" set "AGENITE_WORKSPACE=%~1"

rem === 定位 node（兼容系统 PATH 里没有 node 的情况）===
set "NODE_BIN="
where node >nul 2>nul
if not errorlevel 1 (
  set "NODE_BIN=node"
  goto :have_node
)
rem 常见安装位置，逐个探测
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_BIN=%LOCALAPPDATA%\Programs\nodejs\node.exe" & goto :have_node
if exist "C:\Program Files\nodejs\node.exe" set "NODE_BIN=C:\Program Files\nodejs\node.exe" & goto :have_node
if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODE_BIN=C:\Program Files (x86)\nodejs\node.exe" & goto :have_node
rem WorkBuddy 管理的 node（任意版本）
for /d %%V in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
  if exist "%%V\node.exe" set "NODE_BIN=%%V\node.exe" & goto :have_node
)
:have_node
if not defined NODE_BIN (
  echo.
  echo   [Agenite] 没有找到 Node.js。
  echo   请先安装 Node 18 或更高版本: https://nodejs.org
  echo   安装后重新双击本文件即可。
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动 Agenite 本地服务，浏览器会自动打开...
echo   关闭这个窗口即可退出。
echo.

"%NODE_BIN%" server.js --open
set "RC=%errorlevel%"
echo.
if not "%RC%"=="0" (
  echo   服务异常退出（退出码 %RC%）。请查看上面的报错信息。
) else (
  echo   服务已停止。
)
pause
