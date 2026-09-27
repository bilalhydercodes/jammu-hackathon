@echo off
setlocal
cd /d "%~dp0"
echo ============================================
echo   ALTITUDE - HACKATHON LIVE DEMO
ECHO ============================================
if not exist "frontend\node_modules" (
  echo Installing website packages once...
  call npm --prefix frontend install
  if errorlevel 1 pause & exit /b 1
)
node scripts\start-all.js
pause
