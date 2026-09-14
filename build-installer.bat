@echo off
rem ==========================================================================
rem  Build the Windows installer (bootstrap)
rem --------------------------------------------------------------------------
rem  Double-click this file to build MusicPlayer-<version>-Setup.exe
rem
rem  This file only hands off to build-installer.ps1 -- all the real logic
rem  lives there, because PowerShell handles Chinese text reliably while a
rem  batch file containing Chinese is easy to break between GBK and UTF-8.
rem  Keep this file pure ASCII so its encoding never matters.
rem
rem  Options are passed through, e.g.:
rem     build-installer.bat -CheckOnly
rem     build-installer.bat -DirOnly
rem ==========================================================================

cd /d "%~dp0"

title Build MusicPlayer Installer

powershell -NoProfile -ExecutionPolicy Bypass -File ".\build-installer.ps1" %*

if errorlevel 1 (
  echo.
  echo   Build failed. See the messages above.
  echo.
  pause
)
