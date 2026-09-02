@echo off
rem ===========================================================================
rem  Start Website.bat  --  launch the Morty's Auto Parts / Morty's Auto Parts site
rem
rem  Runs the bundled Node runtime against app\boot.js, which starts the
rem  database (if this build ships one), supervises server.js and serves the
rem  site on http://localhost:3057/ .
rem
rem  The listening port is read by server.js from app\server-config.json
rem  (that file wins over the PORT environment variable), so this script
rem  makes sure server-config.json says 3057 before it starts -- other keys
rem  in that file are preserved. This is a persistent change: every launch
rem  method will use 3057 until server-config.json is changed again.
rem
rem  Usage:
rem     Start Website.bat            start the server (opens the site in a browser)
rem     Start Website.bat --status   print one line of JSON about the instance
rem     Start Website.bat --stop     stop a running instance
rem
rem  boot.js is single-instance safe: starting it twice just exits.
rem ===========================================================================
setlocal
title Morty's Auto Parts / Morty's Auto Parts - Website Server (port 3057)

rem -- Always run from the folder this script lives in --------------------------
cd /d "%~dp0"

set "PORT=3057"
set "BOOT=%~dp0app\boot.js"
set "CFG=%~dp0app\server-config.json"

rem -- Pick a Node: prefer the bundled runtime, fall back to one on PATH -------
set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node"

if not exist "%BOOT%" (
    echo ERROR: cannot find "%BOOT%"
    echo Run this file from the project root ^(the folder that contains "app" and "runtime"^).
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

rem -- Control commands go straight to boot.js, with its exit code ------------
if not "%~1"=="" goto passthru

rem -- Make sure server-config.json pins the port to 3057 (keeps other keys) ---
"%NODE%" -e "var f=process.argv[1],fs=require('fs'),t='',c={};try{t=fs.readFileSync(f,'utf8');if(t.charCodeAt(0)===65279)t=t.slice(1);c=JSON.parse(t);}catch(e){}if(c.port!==%PORT%){c.port=%PORT%;fs.writeFileSync(f,JSON.stringify(c,null,2));console.log('server-config.json port set to %PORT%');}" "%CFG%"

rem -- On a plain start, open the site once the server has had time to boot ----
echo Starting the website server...
echo   Local:   http://localhost:%PORT%/
echo   Admin:   http://localhost:%PORT%/admin.html
echo   ^(Close this window or press Ctrl+C to stop the server.^)
echo.
start "" /min cmd /c "timeout /t 4 /nobreak >nul & start "" http://localhost:%PORT%/"

"%NODE%" "%BOOT%"
set "RC=%ERRORLEVEL%"
echo.
echo Server stopped ^(exit code %RC%^).
pause
exit /b %RC%

:passthru
"%NODE%" "%BOOT%" %*
exit /b %ERRORLEVEL%
