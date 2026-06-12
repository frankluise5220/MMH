@echo off
setlocal enabledelayedexpansion

title WiseMe 安装

echo ============================================
echo  WiseMe 家用记账 - Windows 一键安装
echo ============================================
echo.

:: 检查 Docker 是否安装
where docker >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [错误] 未检测到 Docker，请先安装 Docker Desktop
    echo 下载地址: https://www.docker.com/products/docker-desktop/
    echo 安装后请重启电脑，再运行本脚本。
    pause
    exit /b 1
)

echo [1/4] 创建项目目录...
set "APP_DIR=%USERPROFILE%\wiseme"
if exist "%APP_DIR%" (
    echo 目录已存在，删除旧目录...
    rmdir /s /q "%APP_DIR%"
)
mkdir "%APP_DIR%"
cd /d "%APP_DIR%"

echo [2/4] 下载配置文件...
echo 正在从 GitHub 下载 docker-compose.yml 和 .env.example...
curl -fsSL -o docker-compose.yml "https://raw.githubusercontent.com/frankluise5220/Wiseme/main/docker-compose.yml"
curl -fsSL -o .env.example "https://raw.githubusercontent.com/frankluise5220/Wiseme/main/.env.example"
if %ERRORLEVEL% neq 0 (
    echo [错误] 下载失败，请检查网络连接
    pause
    exit /b 1
)

echo [3/4] 生成随机密码...
set "POSTGRES_DB=wiseme"
set "POSTGRES_USER=wiseme-fs"
:: 生成随机密码 (PowerShell)
powershell -Command "$pwd = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object {[char]$_}); Write-Output $pwd" > "%TEMP%\pgpass.txt"
set /p POSTGRES_PASSWORD=<"%TEMP%\pgpass.txt"
del "%TEMP%\pgpass.txt"

powershell -Command "$pwd = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 16 | ForEach-Object {[char]$_}); Write-Output $pwd" > "%TEMP%\adminpass.txt"
set /p ADMIN_PASSWORD=<"%TEMP%\adminpass.txt"
del "%TEMP%\adminpass.txt"

powershell -Command "$pwd = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object {[char]$_}); Write-Output $pwd" > "%TEMP%\stmtkey.txt"
set /p STATEMENT_API_KEY=<"%TEMP%\stmtkey.txt"
del "%TEMP%\stmtkey.txt"

echo [4/4] 创建 .env 文件...
(
echo DATABASE_URL="postgresql://%POSTGRES_USER%:%POSTGRES_PASSWORD%@postgres:5432/%POSTGRES_DB%?schema=public"
echo POSTGRES_DB="%POSTGRES_DB%"
echo POSTGRES_USER="%POSTGRES_USER%"
echo POSTGRES_PASSWORD="%POSTGRES_PASSWORD%"
echo ADMIN_PASSWORD="%ADMIN_PASSWORD%"
echo STATEMENT_API_KEY="%STATEMENT_API_KEY%"
echo PRISMA_CLIENT_ENGINE_TYPE="binary"
) > .env

echo.
echo 正在拉取镜像并启动...
docker compose pull
docker compose up -d

echo.
echo ============================================
echo  安装完成！
echo.
echo  访问地址: http://localhost:7777
echo  管理员初始密码: %ADMIN_PASSWORD%
echo.
echo  请妥善保管上述密码！
echo ============================================
echo.
echo 以后更新请运行: %APP_DIR%\update.bat

:: 创建更新脚本
(
echo @echo off
echo cd /d "%APP_DIR%"
echo echo 正在拉取最新镜像...
echo docker compose pull
echo docker compose up -d
echo echo 更新完成！
echo pause
) > "%APP_DIR%\update.bat"

echo.
pause