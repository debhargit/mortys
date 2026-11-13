@echo off
rem ===========================================================================
rem  Start Vision Auto Solutions.bat  --  start the till / website server
rem
rem  Double-click to start the server and open the shop. The server runs in
rem  the background (app\boot.js, hidden, via "Start Service Only.vbs"), so
rem  closing this window no longer stops the tills. Double-clicking while it
rem  is already running just opens the site.
rem
rem  Usage:
rem     Start Vision Auto Solutions.bat            start if needed, open the shop
rem     Start Vision Auto Solutions.bat --admin    start if needed, open the admin panel
rem     Start Vision Auto Solutions.bat --console  run in this window and show the log
rem     Start Vision Auto Solutions.bat --status   one line of JSON about the instance
rem     Start Vision Auto Solutions.bat --stop     stop the server
rem
rem  The port is pinned to 3056 in app\server-config.json (other keys kept).
rem ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"
title Vision Auto Solutions

rem Ports come from app\portable.json (appPort) and app\.env (HTTPS_PORT):
rem live = 3056 / 3059, the development copy = 3156 / 3159. 3057 is MelthaHonda.
set "PORT=3056"
set "HTTPS_PORT=3059"
set "BOOT=%~dp0app\boot.js"
set "CFG=%~dp0app\server-config.json"
set "LOGS=%~dp0data\logs"
set "PAGE=/"

rem -- Colours (Windows 10 and later understand ANSI escapes) -----------------
for /f %%a in ('echo prompt $E^| cmd') do set "ESC=%%a"
set "N=%ESC%[0m"
set "BOLD=%ESC%[1m"
set "DIM=%ESC%[90m"
set "RED=%ESC%[91m"
set "GRN=%ESC%[92m"
set "YEL=%ESC%[93m"
set "WHT=%ESC%[97m"
set "BAR=%ESC%[41;97m"

rem -- Node: the bundled runtime, else one on PATH ------------------------------
set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node"

if not exist "%BOOT%" goto no_boot
rem -- This copy's own ports (live or development) ----------------------------------
"%NODE%" -e "try{var c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8').replace(/^\uFEFF/,''));if(c.appPort)process.stdout.write(String(c.appPort))}catch(e){}" "%~dp0app\portable.json" > "%TEMP%\va_port.txt" 2>nul
set /p PORT=<"%TEMP%\va_port.txt"
del "%TEMP%\va_port.txt" >nul 2>&1
if not defined PORT set "PORT=3056"
for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"HTTPS_PORT=" "%~dp0app\.env" 2^>nul') do set "HTTPS_PORT=%%b"
if exist "%~dp0DEVELOPMENT-COPY.txt" title Vision Auto Solutions - DEVELOPMENT COPY (not the live till)
where "%NODE%" >nul 2>&1
if errorlevel 1 if /i "%NODE%"=="node" goto no_node

rem -- Options -------------------------------------------------------------------
if /i "%~1"=="--console" goto console
if /i "%~1"=="--admin" set "PAGE=/admin.html"
if /i "%~1"=="--admin" goto main
if not "%~1"=="" goto passthru

:main
call :banner

rem -- Pin the port (keeps the other keys in server-config.json) ---------------
"%NODE%" -e "var f=process.argv[1],fs=require('fs'),t='',c={};try{t=fs.readFileSync(f,'utf8');if(t.charCodeAt(0)===65279)t=t.slice(1);c=JSON.parse(t);}catch(e){}if(c.port!==%PORT%){c.port=%PORT%;fs.writeFileSync(f,JSON.stringify(c,null,2));}" "%CFG%"

echo   %WHT%[1/3]%N% Checking the server on port %PORT% ...
call :health
if errorlevel 1 goto start_it
echo         %GRN%Already running.%N%
goto ready

:start_it
echo   %WHT%[2/3]%N% Starting the server in the background ...
if exist "%~dp0Start Service Only.vbs" (
    wscript //nologo "%~dp0Start Service Only.vbs"
) else (
    start "Vision Auto Solutions server" /min "%NODE%" "%BOOT%"
)
echo         %DIM%The first start of the day can take up to a minute.%N%
<nul set /p "=        "
set /a tries=0
:waitloop
set /a tries+=1
call :health
if not errorlevel 1 goto started
if %tries% geq 90 goto failed
<nul set /p "=%YEL%.%N%"
ping -n 2 127.0.0.1 >nul
goto waitloop

:started
echo  %GRN%ready.%N%

:ready
call :lanip
echo   %WHT%[3/3]%N% Opening %BOLD%http://localhost:%PORT%%PAGE%%N% in your browser ...
start "" "http://localhost:%PORT%%PAGE%"
echo.
echo   %DIM%------------------------------------------------------------------%N%
echo     %BOLD%Shop%N%        http://localhost:%PORT%/
echo     %BOLD%Admin%N%       http://localhost:%PORT%/admin.html
echo     %BOLD%Cashier%N%     http://localhost:%PORT%/cashier.html
if defined LANIP echo     %BOLD%Other PCs%N%   http://%LANIP%:%PORT%/
if defined LANIP echo     %BOLD%Phones%N%      https://%LANIP%:%HTTPS_PORT%/warehouse   %DIM%(scanners on the shop Wi-Fi)%N%
echo   %DIM%------------------------------------------------------------------%N%
echo.
echo   %GRN%The server keeps running when you close this window.%N%
echo   %DIM%To stop it: "%~nx0" --stop%N%
echo.
timeout /t 30
exit /b 0

:failed
echo.
echo.
echo   %RED%%BOLD%The server did not answer within 90 seconds.%N%
echo.
echo   %WHT%Last lines of the logs:%N%
"%NODE%" -e "var fs=require('fs'),path=require('path');['boot.log','server.log'].forEach(function(n){try{var l=fs.readFileSync(path.join(process.argv[1],n),'utf8').trim().split(/\r?\n/).slice(-8);console.log('\n  -- '+n);l.forEach(function(x){console.log('  '+x.slice(0,110))});}catch(e){}})" "%LOGS%"
echo.
echo   %YEL%Try:%N%  "%~nx0" --stop    then run this file again.
echo   %YEL%Or:%N%   "%~nx0" --console to watch it start.
echo   %DIM%If it keeps failing, send these lines to support.%N%
echo.
pause
exit /b 1

:console
call :banner
echo   %WHT%Running in this window.%N% %DIM%Closing it, or Ctrl+C, stops the server.%N%
echo   %DIM%Logs: %LOGS%%N%
echo.
"%NODE%" "%BOOT%"
set "RC=%ERRORLEVEL%"
echo.
echo   %YEL%boot.js ended (exit code %RC%).%N%
echo   %DIM%If the log says "already running", the server is up in the background.%N%
pause
exit /b %RC%

:passthru
"%NODE%" "%BOOT%" %*
exit /b %ERRORLEVEL%

:no_boot
echo ERROR: cannot find "%BOOT%"
echo Run this file from the Vision Auto Solutions folder (the one with "app" and "runtime" in it).
echo.
pause
exit /b 1

:no_node
echo ERROR: no bundled runtime at "%~dp0runtime\node.exe" and no "node" on PATH.
echo Restore the runtime folder (or install Node.js 18+), then try again.
echo.
pause
exit /b 1

rem ---------------------------------------------------------------- helpers --
:banner
cls
echo.
echo   %BAR%                                                                  %N%
echo   %BAR%   VISION AUTO SOLUTIONS              Till and website server     %N%
echo   %BAR%                                                                  %N%
echo   %DIM%  112C Waltham Park Road, Kingston  .  876-728-4735%N%
echo.
exit /b 0

rem exit 0 when /api/health answers 200
:health
"%NODE%" -e "require('http').get({host:'127.0.0.1',port:%PORT%,path:'/api/health',timeout:1500},function(r){process.exit(r.statusCode===200?0:1)}).on('error',function(){process.exit(1)}).on('timeout',function(){this.destroy();process.exit(1)})" 2>nul
exit /b %ERRORLEVEL%

rem this PC's shop-network address, as boot.js recorded it
:lanip
set "LANIP="
"%NODE%" -e "try{process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).lan_ip||''))}catch(e){}" "%~dp0app\machine-config.json" > "%TEMP%\va_lanip.txt" 2>nul
set /p LANIP=<"%TEMP%\va_lanip.txt"
del "%TEMP%\va_lanip.txt" >nul 2>&1
exit /b 0
