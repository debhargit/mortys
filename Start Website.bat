@echo off
rem ===========================================================================
rem  Start Website.bat  --  same as "Start Morty's Auto Parts.bat"
rem
rem  Kept for old shortcuts. Every option is passed straight through:
rem     --admin  --console  --status  --stop
rem ===========================================================================
call "%~dp0Start Morty's Auto Parts.bat" %*
exit /b %ERRORLEVEL%
