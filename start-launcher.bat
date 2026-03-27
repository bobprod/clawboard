@echo off
title ClawBoard Launcher
cd /d "%~dp0"
echo.
echo  ============================================
echo   ClawBoard Launcher
echo   http://localhost:3999
echo  ============================================
echo.
echo  Ouverture du navigateur dans 2 secondes...
timeout /t 2 /nobreak >nul
start "" "http://localhost:3999"
node launcher.mjs
pause
