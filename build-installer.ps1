# ==========================================================================
#  音乐播放器 · 打包安装包
# --------------------------------------------------------------------------
#  用法（任选其一）：
#    1. 双击根目录的 build-installer.bat   （推荐）
#    2. 命令行：powershell -ExecutionPolicy Bypass -File .\build-installer.ps1
#    3. 只检查已有产物、不重新打包：加 -CheckOnly
#
#  产出：apps/desktop/dist/MusicPlayer-<版本>-Setup.exe
#
#  本文件保存为 UTF-8 with BOM —— Windows PowerShell 5.1 据此识别中文。
# ==========================================================================

[CmdletBinding()]
param(
  # 跳过打包，只对已有产物跑检查
  [switch] $CheckOnly,
  # 出免安装目录而不是安装器（快很多，用于快速验证）
  [switch] $DirOnly
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

function Write-Line { param([string] $Text = '') Write-Host $Text }
function Step { param([string] $Text) Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Ok { param([string] $Text) Write-Host "   [OK] $Text" -ForegroundColor Green }
function Bad { param([string] $Text) Write-Host "   [X]  $Text" -ForegroundColor Red }

Write-Line
Write-Line '  音乐播放器 · 打包'
Write-Line '  ----------------------------------------'

$desktop = Join-Path $root 'apps\desktop'

if (-not (Test-Path (Join-Path $desktop 'main.js'))) {
  Bad '找不到 apps\desktop\main.js，请在项目根目录运行。'
  Read-Host '  按回车关闭'
  exit 1
}

if (-not $CheckOnly) {
  # ---- 1. 依赖 ----
  Step '检查依赖'
  $builder = Join-Path $desktop 'node_modules\electron-builder'
  if (-not (Test-Path $builder)) {
    Write-Line '   electron-builder 未安装，正在安装（首次会慢一些）...'
    Write-Line '   注意 electron-builder 是本次新增的依赖，别用 npm ci —— 它会按旧的'
    Write-Line '   lock 文件装，把新依赖又删掉。'
    Push-Location $root
    # 直接用 pnpm：它是这个工作区本来就用的包管理器
    & pnpm install
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0 -or -not (Test-Path $builder)) {
      Bad '依赖安装失败。手动试一次： 在项目根目录执行 pnpm install'
      Read-Host '  按回车关闭'
      exit 1
    }
  }
  Ok 'electron-builder 就位'

  $electron = Join-Path $desktop 'node_modules\electron\dist\electron.exe'
  if (Test-Path $electron) { Ok 'electron 就位' } else { Bad 'electron 缺失，请先 pnpm install'; Read-Host '  按回车关闭'; exit 1 }

  # ---- 2. 打包 ----
  Step '开始打包（首次会下载 NSIS 工具链，几百 MB，耐心等）'
  Push-Location $desktop
  if ($DirOnly) {
    Write-Line '   模式：免安装目录（dist:dir）'
    & npm run dist:dir
  } else {
    Write-Line '   模式：NSIS 安装包（dist）'
    & npm run dist
  }
  $code = $LASTEXITCODE
  Pop-Location

  if ($code -ne 0) {
    Bad "打包失败，退出码 $code"
    Write-Line '   常见原因：网络下载 NSIS 工具链失败（重试一次），或路径含特殊字符。'
    Read-Host '  按回车关闭'
    exit 1
  }
  Ok '打包完成'
}

# ---- 3. 检查产物 ----
Step '检查打包产物'
& (Join-Path $root 'tools\check-package.ps1')
$checkCode = $LASTEXITCODE

# ---- 4. 结果 ----
Step '结果'
$dist = Join-Path $desktop 'dist'
$installer = Get-ChildItem $dist -Filter '*Setup.exe' -File -ErrorAction SilentlyContinue |
               Sort-Object LastWriteTime -Descending | Select-Object -First 1

if ($installer) {
  $mb = [Math]::Round($installer.Length / 1MB, 1)
  Ok "安装包：$($installer.FullName)"
  Write-Line  "          大小 $mb MB"
  Write-Line ''
  Write-Line '   下一步（算校验值，填进下载页配置）：'
  Write-Line ''
  Write-Line "     `$f = Get-Item '$($installer.FullName)'"
  Write-Line '     "{0:N1} MB" -f ($f.Length / 1MB)'
  Write-Line '     (Get-FileHash $f -Algorithm SHA256).Hash.ToLower()'
  Write-Line ''
  Write-Line '   然后按 apps\site\DEPLOY.md 传 R2 并部署。'
} else {
  Write-Line '   没有找到 *Setup.exe（可能用了 -DirOnly，或只跑了检查）。'
  $unpackedExe = Get-ChildItem (Join-Path $dist 'win-unpacked') -Filter '*.exe' -File -ErrorAction SilentlyContinue |
                   Select-Object -First 1
  if ($unpackedExe) { Write-Line "   可先手动运行验证：$($unpackedExe.FullName)" }
}

Write-Line ''
if ($checkCode -eq 0) {
  Write-Host '  可以进了。' -ForegroundColor Green
} else {
  Write-Host "  有 $checkCode 项检查未通过，看上面的 [X] 说明。" -ForegroundColor Red
}
Write-Line ''
Read-Host '  按回车关闭'
exit $checkCode
