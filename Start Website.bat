@echo off
rem ===========================================================================
rem  Start Website.bat  --  same as "Start Vision Auto Solutions.bat"
rem
rem  Kept for old shortcuts. Every option is passed straight through:
rem     --admin  --console  --status  --stop
rem ===========================================================================
call "%~dp0Start Vision Auto Solutions.bat" %*
exit /b %ERRORLEVEL%
