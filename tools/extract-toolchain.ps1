# Extract the Android toolchain into .toolchain/
#
# NOTE: This file is intentionally ASCII-only.
# Windows PowerShell 5.1 reads .ps1 as ANSI/GBK unless the file has a UTF-8 BOM,
# which corrupts non-ASCII characters and breaks parsing. Keep it ASCII.
#
# Resulting layout:
#   .toolchain/jdk/                               <- JDK 17  (JAVA_HOME)
#   .toolchain/gradle/gradle-8.11.1/              <- Gradle
#   .toolchain/android-sdk/cmdline-tools/latest/  <- sdkmanager (must be at "latest")
#   .toolchain/android-sdk/                       <- ANDROID_HOME

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$DL   = Join-Path $Root '.toolchain\dl'
$Tool = Join-Path $Root '.toolchain'
$Sdk  = Join-Path $Tool 'android-sdk'
$Tmp  = Join-Path $Tool 'tmp'

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

$Tar = Get-Command tar.exe -ErrorAction SilentlyContinue
if (-not $Tar) { throw 'tar.exe not found (ships with Windows 10 1803+)' }

function Expand-Zip($zip, $dest) {
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  & tar.exe -xf $zip -C $dest
  if ($LASTEXITCODE -ne 0) { throw "extract failed: $zip" }
}

# ---------- JDK ----------
Write-Step 'JDK 17'
$JdkDir = Join-Path $Tool 'jdk'
if (Test-Path (Join-Path $JdkDir 'bin\java.exe')) {
  Write-Host 'already present, skipping'
} else {
  $zip = Get-ChildItem $DL -Filter '*jdk*windows*x64*.zip' | Select-Object -First 1
  if (-not $zip) { throw "no JDK archive found in $DL" }
  Write-Host "extracting $($zip.Name) ..."
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Zip $zip.FullName $Tmp
  $inner = Get-ChildItem $Tmp -Directory | Select-Object -First 1
  if (-not $inner) { throw 'unexpected JDK archive layout' }
  Move-Item $inner.FullName $JdkDir
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
# java -version writes to stderr; with $ErrorActionPreference='Stop' that would
# become a terminating error and abort the script. Capture it with Continue.
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$javaOut = (& (Join-Path $JdkDir 'bin\java.exe') -version 2>&1 | Out-String).Trim()
$ErrorActionPreference = $prevEap
Write-Host ('  ' + ($javaOut -split "`r?`n")[0])

# ---------- Gradle ----------
Write-Step 'Gradle'
$GradleDir = Join-Path $Tool 'gradle'
$gradleBat = Get-ChildItem $GradleDir -Filter 'gradle.bat' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($gradleBat) {
  Write-Host "already present: $($gradleBat.FullName)"
} else {
  $zip = Get-ChildItem $DL -Filter 'gradle-*-bin.zip' | Select-Object -First 1
  if (-not $zip) { throw "no Gradle archive found in $DL" }
  Write-Host "extracting $($zip.Name) ..."
  Expand-Zip $zip.FullName $GradleDir
}
Get-ChildItem $GradleDir -Directory | ForEach-Object { Write-Host "  $($_.Name)" }

# ---------- Android cmdline-tools ----------
Write-Step 'Android SDK command-line tools'
$CmdlineLatest = Join-Path $Sdk 'cmdline-tools\latest'
if (Test-Path (Join-Path $CmdlineLatest 'bin\sdkmanager.bat')) {
  Write-Host 'already present, skipping'
} else {
  $zip = Get-ChildItem $DL -Filter 'commandlinetools-win-*.zip' | Select-Object -First 1
  if (-not $zip) { throw "no cmdline-tools archive found in $DL" }
  Write-Host "extracting $($zip.Name) ..."
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Zip $zip.FullName $Tmp
  # Archive contains a top-level "cmdline-tools/" dir; sdkmanager expects it under cmdline-tools/latest/
  $inner = Join-Path $Tmp 'cmdline-tools'
  if (-not (Test-Path $inner)) { throw 'cmdline-tools dir not found inside archive' }
  New-Item -ItemType Directory -Path (Split-Path $CmdlineLatest -Parent) -Force | Out-Null
  Move-Item $inner $CmdlineLatest
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "  $CmdlineLatest"

Write-Step 'Done'
Write-Host "JAVA_HOME    = $JdkDir"
Write-Host "ANDROID_HOME = $Sdk"
