@echo off
chcp 65001 >nul
title mcbot 控制面板

echo ==========================================
echo   mcbot 网页控制面板
echo ==========================================
echo.
echo 正在启动服务端...
echo 浏览器将自动打开: http://localhost:5001
echo.

start "" http://localhost:5001

:loop
node server.js
if %errorlevel% equ 100 goto loop

echo.
echo 服务已停止。
pause