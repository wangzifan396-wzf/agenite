@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Agenite

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [Agenite] 没有找到 Node.js。
  echo   请先安装 Node 18 或更高版本: https://nodejs.org
  echo.
  pause
  exit /b 1
)

rem 可选: start.cmd D:\your\project  —— 让智能体在指定目录里干活
if not "%~1"=="" set "AGENITE_WORKSPACE=%~1"

echo.
echo   正在启动 Agenite 本地服务，浏览器会自动打开...
echo   关闭这个窗口即可退出。
echo.

node server.js --open
echo.
echo   服务已停止。
pause
