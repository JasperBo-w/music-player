@echo off
rem ==========================================================================
rem  Build the installer as Administrator (bootstrap)
rem --------------------------------------------------------------------------
rem  Double-click this file. It will raise a UAC prompt -- click Yes.
rem
rem  Why elevation is needed: electron-builder unpacks the winCodeSign toolkit,
rem  which contains macOS symlinks (.dylib). Windows does not let a normal user
rem  create symlinks, so unpacking fails with:
rem      ERROR: Cannot create symbolic link : A required privilege is not held
rem      ERROR: 7-Zip cannot create symbolic link
rem  This package is fetched even without a code-signing certificate, so it
rem  cannot be skipped -- it needs elevation (or a hand-placed cache).
rem
rem  This file only hands off to tools\build-as-admin.ps1 -- all logic lives
rem  there, because PowerShell handles Chinese text reliably while a batch file
rem  containing Chinese is easy to break between GBK and UTF-8.
rem  Keep this file pure ASCII so its encoding never matters.
rem ==========================================================================

cd /d "%~dp0"

title Build MusicPlayer Installer (Admin)

powershell -NoProfile -ExecutionPolicy Bypass -File ".\tools\build-as-admin.ps1" %*

if errorlevel 1 (
  echo.
  echo   Build failed. See the messages above.
  echo.
  pause
)
