# ==========================================================================
#  音乐播放器 · 打包安装包
# --------------------------------------------------------------------------
#  用法（任选其一）：
#    1. 双击根目录的 build-installer.bat      （推荐）
#    2. powershell -ExecutionPolicy Bypass -File .\build-installer.ps1
#    3. 只检查已有产物：加 -CheckOnly
#    4. 快速验证（不出安装器）：加 -DirOnly
#    5. app-builder 起不来时的兜底：加 -NoAppBuilder
#    6. 排查用详细日志：加 -VerboseLog
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
  [switch] $DirOnly,
  # 兜底方案：用备用配置关掉 asar 与签名，绕开 app-builder
  [switch] $NoAppBuilder,
  # 让 electron-builder 打印完整过程（排查用）
  [switch] $VerboseLog
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

# npm 路径在这里解析一次，装依赖和后面的步骤都要用。
# 不要放进下面的 if 里：那个 if 只在"没装过依赖"时才进入，
# 第二次运行时 $npmExe 会是 null，Start-Process 直接报参数校验失败。
$npmExe = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npmExe) { $npmExe = (Get-Command npm -ErrorAction SilentlyContinue).Source }

if (-not $CheckOnly) {
  # ---- 1. 依赖 ----
  Step '检查依赖'

  if (-not $npmExe) {
    Bad '找不到 npm，请确认 Node.js 已安装并在 PATH 里。'
    Read-Host '  按回车关闭'
    exit 1
  }
  Ok "npm 就位（$npmExe）"

  $builderCli = Join-Path $desktop 'node_modules\electron-builder\out\cli\cli.js'

  if (-not (Test-Path $builderCli)) {
    Write-Line ''
    Write-Line '   electron-builder 未就位，正在安装（首次会慢一些）...'
    Write-Line '   必须在 apps\desktop 里装：这个仓库不是 pnpm workspace，'
    Write-Line '   在根目录跑 pnpm install 只会看到空 workspace，什么也不装。'
    Write-Line ''

    $proc = Start-Process -FilePath $npmExe `
      -ArgumentList 'install', '--no-audit', '--no-fund' `
      -WorkingDirectory $desktop -PassThru -Wait
    $code = $proc.ExitCode

    if ($code -ne 0 -or -not (Test-Path $builderCli)) {
      Bad "依赖安装失败（npm 退出码 $code）"
      Write-Line ''
      Write-Line '   手动排查：'
      Write-Line '       cd apps\desktop'
      Write-Line '       npm install'
      Write-Line '   网络不通的话换个镜像：'
      Write-Line '       npm config set registry https://registry.npmmirror.com'
      Read-Host '  按回车关闭'
      exit 1
    }
  }
  Ok 'electron-builder 就位'

  $electron = Join-Path $desktop 'node_modules\electron\dist\electron.exe'
  if (Test-Path $electron) {
    Ok 'electron 就位'
  } else {
    Bad 'electron 缺失，请先在 apps\desktop 下执行 npm install'
    Read-Host '  按回车关闭'
    exit 1
  }

  # ---- 2. 打包 ----
  # 直接调 electron-builder 的入口，不经过 npm run。
  # npm run 后面用 -- 传的参数会被原样转发给它，而它只认自己那套旗标 ——
  # 之前传 --loglevel debug 就被当成 Unknown argument 直接退出。
  Step '开始打包（首次会下载 NSIS 工具链，几百 MB，耐心等）'

  $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $nodeExe) {
    Bad '找不到 node，请确认 Node.js 已安装并在 PATH 里。'
    Read-Host '  按回车关闭'
    exit 1
  }

  $buildArgs = @($builderCli, '--win')

  if ($NoAppBuilder) {
    $fallbackCfg = Join-Path $desktop 'electron-builder-noapp.json'
    if (-not (Test-Path $fallbackCfg)) {
      Bad "找不到备用配置：$fallbackCfg"
      Read-Host '  按回车关闭'
      exit 1
    }
    $buildArgs += @('--config', $fallbackCfg)
    Write-Line '   [兜底模式] 关闭 asar 与签名，绕开 app-builder'
  }

  if ($VerboseLog) {
    $buildArgs += '--debug'
    Write-Line '   [详细模式] 会打印大量过程日志'
  }

  if ($DirOnly) {
    $buildArgs += '--dir'
    Write-Line '   模式：免安装目录（快，用于验证打包是否正确）'
  } else {
    Write-Line '   模式：NSIS 安装包'
  }
  Write-Line ''

  # 输出写进日志文件：electron-builder 跑在独立窗口里，窗口一关错误就查不到了。
  # 失败时直接把日志尾部打出来，省得再去翻。
  $log = Join-Path $root '.logs\build-electron-builder.log'
  New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
  Write-Line "   完整日志：$log"
  Write-Line ''

  $proc = Start-Process -FilePath $nodeExe `
    -ArgumentList $buildArgs `
    -WorkingDirectory $desktop -PassThru -Wait `
    -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  $code = $proc.ExitCode

  if ($code -ne 0) {
    Bad "打包失败（electron-builder 退出码 $code）"
    Write-Line ''
    Write-Line '   ---- 日志最后 25 行 ----' -ForegroundColor Yellow
    foreach ($src in @($log, "$log.err")) {
      if (Test-Path $src) {
        Get-Content $src -Tail 25 -ErrorAction SilentlyContinue | ForEach-Object {
          Write-Host "   $_" -ForegroundColor DarkGray
        }
      }
    }
    Write-Line '   -----------------------' -ForegroundColor Yellow
    Write-Line ''
    Write-Line '   常见原因：'
    Write-Line '     · app-builder.exe 无法执行 —— 先跑 tools\diagnose-appbuilder.ps1，'
    Write-Line '       或直接用兜底模式：build-installer.bat -NoAppBuilder'
    Write-Line '     · 杀毒软件锁住了 dist 目录 —— 关掉实时防护再试'
    Write-Line '     · NSIS 工具链下载失败 —— 多试一次，或换个网络'
    Write-Line ''
    Write-Line '   想看详细报错：'
    Write-Line '       build-installer.bat -VerboseLog'
    Read-Host '  按回车关闭'
    exit 1
  }
  Ok '打包完成'
}

# ---- 3. 检查产物 ----
Step '检查打包产物'
# 捕获检查器的输出，从 CHECK_RESULT 行判断成败。
# 不依赖 $LASTEXITCODE 跨脚本传递 —— 那个行为在不同 PowerShell 版本上不一致，
# 曾造成"检查通过但被当成失败"的误判。
$checkLog = Join-Path $root '.logs\check-package.log'
& (Join-Path $root 'tools\check-package.ps1') *>&1 | Tee-Object -FilePath $checkLog
$checkText = if (Test-Path $checkLog) { Get-Content $checkLog -Raw -ErrorAction SilentlyContinue } else { '' }

if ($checkText -match 'CHECK_RESULT=PASS') {
  $checkCode = 0
} elseif ($checkText -match 'CHECK_RESULT=FAIL:(\d+)') {
  $checkCode = [int]$Matches[1]
} else {
  # 没有结果行说明检查器自己挂了，这种情况要当成失败
  $checkCode = 1
}

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
  Write-Host " 有 $checkCode 项检查未通过，看上面的 [X] 说明。" -ForegroundColor Red
}
Write-Line ''
Read-Host '  按回车关闭'
exit $checkCode
