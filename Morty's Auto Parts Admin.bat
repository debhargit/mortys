@echo off
rem ===========================================================================
rem  Morty's Auto Parts Admin.bat  --  batch counterpart of "Morty's Auto Parts Admin.vbs"
rem
rem  Double-click to:
rem     1. pin the listening port to 3057 in app\server-config.json
rem     2. open the admin panel if the server already answers
rem     3. otherwise start app\boot.js (bundled Node), wait for /api/health,
rem        then open http://localhost:3057/admin.html
rem
rem  Unlike the .vbs, a .bat cannot launch a console program with the window
rem  genuinely hidden -- boot.js is started minimised instead. For a truly
rem  windowless autostart at login, keep using "Start Service Only.vbs".
rem
rem  Usage:
rem     Morty's Auto Parts Admin.bat            start + open the admin panel
rem     Morty's Auto Parts Admin.bat --status   print one line of JSON about the instance
rem     Morty's Auto Parts Admin.bat --stop     stop a running instance
rem ===========================================================================
setlocal
title Morty's Auto Parts Admin (port 3057)

cd /d "%~dp0"

set "PORT=3057"
set "BOOT=%~dp0app\boot.js"
set "CFG=%~dp0app\server-config.json"
set "URL=http://localhost:%PORT%/admin.html"

rem -- Pick a Node: prefer the bundled runtime, fall back to one on PATH -------
set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node"

if not exist "%BOOT%" (
    echo ERROR: cannot find "%BOOT%"
    echo Copy the whole folder again -- don't move files out of it one at a time.
    echo.
    pause
    exit /b 1
)
where "%NODE%" >nul 2>&1
if errorlevel 1 if /i "%NODE%"=="node" (
    echo ERROR: no bundled runtime at "%~dp0runtime\node.exe" and no "node" on PATH.
    echo Install Node.js 18+ or restore the runtime folder, then try again.
    echo.
    pause
    exit /b 1
)

rem -- Pass control commands straight through to boot.js ----------------------
if not "%~1"=="" goto passthru

rem -- Pin the port to 3057 (other keys in server-config.json are preserved) --
"%NODE%" -e "var f=process.argv[1],fs=require('fs'),t='',c={};try{t=fs.readFileSync(f,'utf8');if(t.charCodeAt(0)===65279)t=t.slice(1);c=JSON.parse(t);}catch(e){}if(c.port!==%PORT%){c.port=%PORT%;fs.writeFileSync(f,JSON.stringify(c,null,2));console.log('server-config.json port set to %PORT%');}" "%CFG%"

rem -- Already up? Just open the panel --------------------------------------
call :health && (
    echo Server already running -- opening %URL%
    start "" "%URL%"
    exit /b 0
)

rem -- Start boot.js minimised (batch can't fully hide a console) -----------
echo Starting the Morty's Auto Parts admin server on port %PORT% ...
start "Morty's Auto Parts Admin server" /min "%NODE%" "%BOOT%"

rem -- Wait up to ~75s for readiness (first run initialises the database) ---
set /a tries=0
:waitloop
set /a tries+=1
call :health && goto ready
if %tries% geq 75 goto timeout
ping -n 2 127.0.0.1 >nul
goto waitloop

:ready
echo Server is up. Opening %URL%
start "" "%URL%"
exit /b 0

:timeout
echo.
echo The admin server did not finish starting within 75 seconds.
echo Check the logs:
echo     "%~dp0data\logs\boot.log"
echo     "%~dp0data\logs\server.log"
echo.
echo If another copy is already running on a different port, stop it first:
echo     "%~nx0" --stop
echo.
pause
exit /b 1

:passthru
"%NODE%" "%BOOT%" %*
exit /b %ERRORLEVEL%

rem -- health check: exit 0 when /api/health returns 200 -------------------
:health
"%NODE%" -e "require('http').get({host:'127.0.0.1',port:%PORT%,path:'/api/health',timeout:1500},function(r){process.exit(r.statusCode===200?0:1)}).on('error',function(){process.exit(1)}).on('timeout',function(){this.destroy();process.exit(1)})" 2>nul
exit /b %ERRORLEVEL%
