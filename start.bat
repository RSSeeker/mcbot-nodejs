@echo off
chcp 65001 >nul
echo ==============================================
echo          MC Bot Python 启动脚本
echo ==============================================
echo.

set "SCRIPT_DIR=%~dp0"

echo [INFO] 检查 Node.js 依赖...
if not exist "%SCRIPT_DIR%node_modules" (
    echo [WARN] 未找到 node_modules，正在安装依赖...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] Node.js 依赖安装失败
        pause
        exit /b 1
    )
)

echo [INFO] 启动 Mineflayer 代理和 Python 控制端...
echo.

cd /d "%SCRIPT_DIR%"
python main.py

echo.
echo [INFO] 程序已退出
pause