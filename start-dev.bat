@echo off
setlocal

cd /d "%~dp0"

echo [wiseme] Checking port 7777...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":7777" ^| findstr "LISTENING"') do (
  echo [wiseme] Stopping process %%a using port 7777...
  taskkill /F /PID %%a >nul 2>nul
)

echo [wiseme] Generating Prisma client...
call npx prisma generate
if errorlevel 1 (
  echo [wiseme] Prisma generate failed.
  pause
  exit /b 1
)

echo [wiseme] Starting dev server at http://localhost:7777 ...
call npm run dev

pause
