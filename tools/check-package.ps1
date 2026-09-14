# ==========================================================================
#  打包产物检查
# --------------------------------------------------------------------------
#  在 dist:dir 之后跑一下，不用启动程序就能查出两个最可能翻车的点：
#
#    1. apps/ui 有没有被放进 resources/ui
#       （放错路径的表现是白屏：窗口出来了但 app:// 全部 404）
#    2. app.asar 里有没有打进音源核心及其依赖
#       （@dsh/music-core 是指向仓库的 junction 链接，electron-builder
#        对软链接依赖的收集最容易漏，漏了就是启动即崩）
#
#  asar 的头部格式（不想装额外依赖，直接按格式读）：
#     [UInt32 pickle 大小][UInt32 header 长度 + ...][JSON 头部]
#  头部里递归存着每个文件的路径和大小，所以只读文件开头就能列清单。
#
#  用法：
#    powershell -File tools/check-package.ps1
#    powershell -File tools/check-package.ps1 -Dist apps/desktop/dist
# ==========================================================================

[CmdletBinding()]
param(
  [string] $Dist = 'apps/desktop/dist'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Dist)) {
  Write-Host "找不到打包目录：$Dist" -ForegroundColor Red
  Write-Host '先执行： cd apps\desktop; npm run dist:dir' -ForegroundColor Yellow
  exit 1
}

$unpacked = Join-Path $Dist 'win-unpacked'
if (-not (Test-Path $unpacked)) {
  Write-Host "找不到 $unpacked" -ForegroundColor Red
  Write-Host '先执行： cd apps\desktop; npm run dist:dir' -ForegroundColor Yellow
  exit 1
}

$fail = 0
function Pass { param($m) Write-Host "  [OK]   $m" -ForegroundColor Green }
function Fail { param($m) Write-Host "  [FAIL] $m" -ForegroundColor Red; $script:fail++ }
function Warn { param($m) Write-Host "  [WARN] $m" -ForegroundColor Yellow }

Write-Host ''
Write-Host "检查 $unpacked"
Write-Host ''

# ---- 1. 主程序 ----
Write-Host '主程序'
$exe = Get-ChildItem $unpacked -Filter '*.exe' -File | Select-Object -First 1
if ($exe) {
  Pass ("$($exe.Name)  {0:N1} MB" -f ($exe.Length / 1MB))
} else {
  Fail 'win-unpacked 里没有 .exe'
}

$res = Join-Path $unpacked 'resources'

# ---- 2. 界面文件 ----
Write-Host ''
Write-Host '界面文件（apps/ui → resources/ui）'
$uiIndex = Join-Path $res 'ui\index.html'
if (Test-Path $uiIndex) {
  $uiFiles = Get-ChildItem (Join-Path $res 'ui') -Recurse -File
  Pass ("resources/ui/index.html 存在，共 {0} 个文件 / {1:N1} MB" -f `
    $uiFiles.Count, (($uiFiles | Measure-Object Length -Sum).Sum / 1MB))

  $required = @(
    'ui\index.html',
    'ui\lyric.html',
    'ui\src\main.js',
    'ui\src\styles.css',
    'ui\src\particles.js',
    'ui\vendor\three.module.js'
  )
  foreach ($r in $required) {
    if (-not (Test-Path (Join-Path $res $r))) { Fail "缺少 resources/$r" }
  }
  if ($fail -eq 0) { Pass '界面关键文件齐全（含 three.module.js 与 particles.js）' }
} else {
  Fail 'resources/ui/index.html 不存在 —— 装完会白屏'
  Write-Host '       检查 package.json 的 build.extraResources 是否指向 ../ui' -ForegroundColor DarkGray
}

# ---- 3. asar 内的代码 ----
Write-Host ''
Write-Host '代码包（app.asar）'
$asar = Join-Path $res 'app.asar'
if (-not (Test-Path $asar)) {
  Fail 'resources/app.asar 不存在'
} else {
  Pass ("app.asar {0:N1} MB" -f ((Get-Item $asar).Length / 1MB))

  # 按 asar 格式读头部
  $bytes = [System.IO.File]::ReadAllBytes($asar)
  # 边界校验：asar 头不该超过文件本身，否则说明格式不是我们预期的
  if ($bytes.Length -lt 16) { Fail 'app.asar 太小/格式不对'; Write-Host 'CHECK_RESULT=FAIL:1'; exit 1 }
  $headerJsonLen = [BitConverter]::ToInt32($bytes, 12)
  if ($headerJsonLen -le 0 -or (16 + $headerJsonLen) -gt $bytes.Length) {
    Fail "app.asar 头部长度异常（$headerJsonLen），无法解析"
    exit 1
  }
  $headerJson = [System.Text.Encoding]::UTF8.GetString($bytes, 16, $headerJsonLen)
  $header = $headerJson | ConvertFrom-Json

  # 递归收集所有文件路径
  $paths = New-Object System.Collections.Generic.List[string]
  function Walk {
    param($node, [string] $prefix)
    foreach ($p in $node.files.PSObject.Properties) {
      $name = $p.Name
      $child = $p.Value
      $full = if ($prefix) { "$prefix/$name" } else { $name }
      if ($child.files) { Walk $child $full }
      else { $script:paths.Add($full) }
    }
  }
  Walk $header ''
  Pass ("包内 {0} 个文件" -f $paths.Count)

  # 必须存在的运行时文件
  $need = @(
    'main.js',
    'preload.js',
    'package.json',
    'node_modules/@dsh/music-core/src/index.js',
    'node_modules/@dsh/music-core/src/web-api.js',
    'node_modules/@dsh/music-core/src/session-store.js'
  )
  foreach ($n in $need) {
    if ($paths -contains $n) { Pass $n } else { Fail "缺少 $n" }
  }

  # 音源核心的运行时依赖 —— 这是漏得最多的地方
  Write-Host ''
  Write-Host '音源核心的依赖（junction 链接，最容易漏）'
  $deps = 'axios','crypto-js','node-forge','pako','qrcode','big-integer'
  $missing = @()
  foreach ($d in $deps) {
    $hit = $paths | Where-Object { $_ -like "node_modules/$d/*" } | Select-Object -First 1
    if ($hit) { Pass "$d" } else { Fail "$d 没有打进包"; $missing += $d }
  }
  if ($missing.Count) {
    Write-Host ''
    Write-Host '  这几个依赖缺失会让程序启动即崩（Cannot find module）。' -ForegroundColor Yellow
    Write-Host '  原因通常是 @dsh/music-core 是指向仓库外 packages/core 的 junction，' -ForegroundColor Yellow
    Write-Host '  electron-builder 没有跟着链接收集它自己的 node_modules。' -ForegroundColor Yellow
    Write-Host '  处理办法：在 apps/desktop 下发 npm install，把 core 的依赖装到' -ForegroundColor Yellow
    Write-Host '  apps/desktop/node_modules 下（扁平化），再重新打包。' -ForegroundColor Yellow
  }

  # 不该出现在包里的东西
  Write-Host ''
  Write-Host '敏感文件检查'
  $bad = $paths | Where-Object { $_ -match '\.session\.json$|\.log$|kugou-session' }
  if ($bad) {
    foreach ($b in $bad) { Fail "包里不该有：$b" }
  } else {
    Pass '不含 .session.json / 日志'
  }
}

Write-Host ''
if ($fail -eq 0) {
  Write-Host '全部通过，可以进了。' -ForegroundColor Green
  $finalExe = Get-ChildItem $unpacked -Filter '*.exe' -File | Select-Object -First 1
  if ($finalExe) { Write-Host "建议再手动跑一次 $($finalExe.FullName)" -ForegroundColor DarkGray }
  Write-Host '确认界面能出来、能放歌，再去传 R2。' -ForegroundColor DarkGray
} else {
  Write-Host "有 $fail 项没过，先修掉再发。" -ForegroundColor Red
}

# 机器可读的结果行 —— 调用方读这一行判断成败，不依赖退出码传递。
# 为什么：跨脚本用 $LASTEXITCODE 取退出码在不同 PowerShell 版本上行为不一致，
# 曾导致"检查其实通过、调用方却当成失败"。读一行确定的文本可靠得多。
Write-Host ''
if ($fail -eq 0) {
  Write-Host 'CHECK_RESULT=PASS'
} else {
  Write-Host "CHECK_RESULT=FAIL:$fail"
}

exit $fail
