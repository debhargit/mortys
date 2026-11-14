@echo off
rem Morty's Auto Parts - opens the remote support set-up as Administrator.
cd /d "%~dp0"
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-Remote-Support.ps1" %*
