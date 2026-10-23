@echo off
setlocal
title Watch Dogs - Local Frontend
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not on PATH.
  echo Install Node.js 20.11 or newer, then run this file again.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm is not installed or not on PATH.
  pause
  exit /b 1
)

echo.
echo  WATCH DOGS - FRONTEND STARTUP
echo  ==============================
echo.

for /f "tokens=1 delims=v" %%V in ('node --version') do set NODE_VERSION=%%V
echo Detected Node.js:
node --version
echo.

if not exist "node_modules" (
  echo [1/4] Installing gateway dependencies...
  call npm install
  if errorlevel 1 goto :failed
) else (
  echo [1/4] Gateway dependencies already installed.
)

if not exist "frontend\node_modules" (
  echo [2/4] Installing frontend dependencies...
  call npm --prefix frontend install
  if errorlevel 1 goto :failed
) else (
  echo [2/4] Frontend dependencies already installed.
)

echo [3/4] Starting local Watch Dogs gateway in a new window...
start "Watch Dogs Gateway" cmd /k "cd /d ""%~dp0"" && npm run wd:web"

timeout /t 2 /nobreak >nul

echo [4/4] Starting Vite frontend in a new window...
start "Watch Dogs Frontend" cmd /k "cd /d ""%~dp0"" && npm run web:dev"

echo.
echo Startup commands launched.
echo Frontend: http://127.0.0.1:5173
echo Gateway:  http://127.0.0.1:4317
echo.
echo Keep both terminal windows open while using Watch Dogs.
echo Use the pairing code printed in the Gateway window to connect.
pause
exit /b 0

:failed
echo.
echo [ERROR] Dependency installation failed. Check the messages above.
pause
exit /b 1
