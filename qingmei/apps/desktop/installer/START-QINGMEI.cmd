@echo off
cd /d "%~dp0"
taskkill /IM "??.exe" /F >nul 2>&1
taskkill /IM "Qingmei.exe" /F >nul 2>&1
if not exist "%~dp0Qingmei.exe" (
  echo Qingmei.exe not found. Extract the whole ZIP first.
  pause
  exit /b 1
)
start "" "%~dp0Qingmei.exe"
