@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
if exist ".next" rmdir /s /q ".next"
npm run dev
pause