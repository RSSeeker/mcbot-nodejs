@echo off
chcp 65001 >nul
echo ==============================================
echo          mcbot 网页控制面板
echo ==============================================
echo.

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

echo [INFO] 正在启动网页控制面板...
echo [INFO] 等待服务启动后自动打开浏览器...
echo.

start "" http://localhost:5000

python web_app.py

echo.
echo [INFO] 程序已退出
pause