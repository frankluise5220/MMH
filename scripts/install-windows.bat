@echo off
setlocal enabledelayedexpansion

title MMH 安装

echo ============================================
echo  MMH 家用记账 - Windows 一键安装
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

:: 检查 Git 是否安装
where git >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [错误] 未检测到 Git，请先安装 Git for Windows
    echo 下载地址: https://git-scm.com/download/win
    pause
    exit /b 1
)

echo [1/4] 创建项目目录...
set "APP_DIR=%USERPROFILE%\mmh"
if exist "%APP_DIR%" (
    echo 目录已存在，删除旧目录...
    rmdir /s /q "%APP_DIR%"
)
mkdir "%APP_DIR%"
cd /d "%USERPROFILE%"

echo [2/4] 拉取源码...
echo 正在从 GitHub 克隆仓库...
git clone "https://github.com/frankluise5220/MMH.git" "%APP_DIR%"
if %ERRORLEVEL% neq 0 (
    echo [错误] 拉取失败，请检查网络连接
    pause
    exit /b 1
)
cd /d "%APP_DIR%"

echo [3/4] 生成随机密码...
set "POSTGRES_DB=mmh"
set "POSTGRES_USER=mmh-fs"
:: 生成随机密码 (PowerShell)
powershell -Command "$pwd = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object {[char]$_}); Write-Output $pwd" > "%TEMP%\pgpass.txt"
set /p POSTGRES_PASSWORD=<"%TEMP%\pgpass.txt"
del "%TEMP%\pgpass.txt"

powershell -Command "$pwd = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object {[char]$_}); Write-Output $pwd" > "%TEMP%\stmtkey.txt"
set /p STATEMENT_API_KEY=<"%TEMP%\stmtkey.txt"
del "%TEMP%\stmtkey.txt"

echo [4/4] 创建 .env 文件...
(
echo DATABASE_URL="postgresql://%POSTGRES_USER%:%POSTGRES_PASSWORD%@postgres:5432/%POSTGRES_DB%?schema=public"
echo POSTGRES_DB="%POSTGRES_DB%"
echo POSTGRES_USER="%POSTGRES_USER%"
echo POSTGRES_PASSWORD="%POSTGRES_PASSWORD%"
echo STATEMENT_API_KEY="%STATEMENT_API_KEY%"
echo MMH_GIT_REMOTE="origin"
echo MMH_GIT_BRANCH="main"
echo PRISMA_CLIENT_ENGINE_TYPE="binary"
echo MMH_APP_IMAGE="ghcr.io/frankluise5220/mmh:latest"
echo NODE_BUILD_IMAGE="node:20-bookworm"
echo NODE_RUNTIME_IMAGE="node:20-bookworm"
echo POSTGRES_IMAGE="postgres:15-alpine"
) > .env

echo.
echo 正在拉取镜像并启动...
docker compose pull app
if %ERRORLEVEL% neq 0 (
    echo [错误] 拉取应用镜像失败，请检查网络连接
    pause
    exit /b 1
)
docker compose up -d

echo.
echo ============================================
echo  安装完成！
echo.
echo  访问地址: http://localhost:7777
echo  首次打开将引导设置管理员密码
echo.
echo  数据库密码: %POSTGRES_PASSWORD%
echo  请立即保存上面的数据库密码
echo  数据库密码已保存在 .env 文件中（同时用于"系统初始化"验证）
echo ============================================
echo.

pause
