@echo off
rem ==========================================================================
rem  Music Player launcher (bootstrap)
rem --------------------------------------------------------------------------
rem  Double-click this file to start the player.
rem
rem  This file only hands off to launch-player.ps1 -- all the real logic lives
rem  there, because PowerShell handles Chinese text reliably while a batch
rem  file containing Chinese is extremely easy to break between GBK and
rem  UTF-8. cmd.exe parses .bat using the system ANSI codepage, and mojibake
rem  there causes hard parse failures (stray quotes), not just ugly output.
rem
rem  Keep this file pure ASCII: then its encoding never matters, and you can
rem  edit it with anything.
rem ==========================================================================

cd /d "%~dp0"

title Music Player

powershell -NoProfile -ExecutionPolicy Bypass -File ".\launch-player.ps1"

if errorlevel 1 (
  echo.
  echo   Startup failed. See the messages above.
  echo.
  pause
)
