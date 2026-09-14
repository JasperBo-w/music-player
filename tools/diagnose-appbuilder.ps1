# ==========================================================================
#  app-builder.exe 执行失败诊断
# --------------------------------------------------------------------------
#  报错：
#    ...node_modules\app-builder-bin\win\x64\app-builder.exe
#    process failed ERR_ELECTRON_BUILDER_CANNOT_EXECUTE
#
#  app-builder 是 electron-builder 用来处理图标、签名、打包资源的一个
#  Go 编译的单文件程序。它起不来的常见原因有三类：
#
#    1. 文件根本没落地 / 是 0 字节（npm 解压在最后一步被打断或被杀软拦下）
#    2. 被杀毒软件或"受控文件夹访问"拦住了执行
#    3. 文件在但无法执行（权限、被占用、下载不完整）
#
#  这个脚本逐项检查，并给出对应的修法。
#
#  用法：
#    powershell -File tools/diagnose-appbuilder.ps1
#    powershell -File tools/diagnose-appbuilder.ps1 -Fix   （自动尝试修复）
# ==========================================================================

[CmdletBinding()]
param(
  [switch] $Fix
)

$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path (Join-Path $root 'apps\desktop\main.js'))) {
  # 也许它就在仓库根目录被调用的
  $root = $PSScriptRoot
}

$binDir = Join-Path $root 'apps\desktop\node_modules\app-builder-bin\win\x64'
$exe    = Join-Path $binDir 'app-builder.exe'

Write-Host ''
Write-Host '  app-builder.exe 诊断'
Write-Host '  ========================================'
Write-Host ''

# ---- 1. 文件是否存在 ----
Write-Host "[1] 文件是否存在"
Write-Host "    $exe"
if (Test-Path $exe) {
  Write-Host '    [OK] 存在' -ForegroundColor Green
} else {
  Write-Host '    [X] 不存在 —— 这就是起不来的直接原因' -ForegroundColor Red
  Write-Host ''
  Write-Host '    整个目录里现在有什么：'
  if (Test-Path $binDir) {
    Get-ChildItem $binDir -Force | ForEach-Object {
      Write-Host ("       {0,-30} {1,12} bytes" -f $_.Name, $_.Length)
    }
  } else {
    Write-Host "       （连目录都不存在：$binDir）"
  }
}

# ---- 2. 文件大小是否合理 ----
Write-Host ''
Write-Host '[2] 文件大小'
if (Test-Path $exe) {
  $len = (Get-Item $exe).Length
  $mb = [Math]::Round($len / 1MB, 1)
  Write-Host "    $mb MB"
  if ($len -eq 0) {
    Write-Host '    [X] 0 字节 —— 解压没完成，文件是空的' -ForegroundColor Red
  } elseif ($len -lt 5MB) {
    Write-Host '    [X] 太小了，正常应该 30 MB 以上 —— 下载或解压不完整' -ForegroundColor Red
  } elseif ($len -gt 60MB) {
    Write-Host '    [!] 偏大，但也可能正常（版本差异）' -ForegroundColor Yellow
  } else {
    Write-Host '    [OK] 大小正常' -ForegroundColor Green
  }
}

# ---- 3. 能否真的执行 ----
Write-Host ''
Write-Host '[3] 能否执行（直接调它的 --version）'
if (Test-Path $exe) {
  try {
    $out = & $exe --version 2>&1
    $code = $LASTEXITCODE
    if ($out) {
      Write-Host "    [OK] 输出: $($out -join ' ')" -ForegroundColor Green
    } else {
      Write-Host "    [!] 没有输出，退出码 $code" -ForegroundColor Yellow
    }
  } catch {
    Write-Host "    [X] 执行抛错: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host '        这通常意味着杀毒软件 / 受控文件夹访问 拦住了它。' -ForegroundColor Yellow
  }
} else {
  Write-Host '    跳过（文件不存在）'
}

# ---- 4. 相关缓存 ----
Write-Host ''
Write-Host '[4] electron-builder 的工具链缓存'
$cache = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache'
if (Test-Path $cache) {
  Get-ChildItem $cache -Directory | ForEach-Object {
    $size = (Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue |
              Measure-Object Length -Sum).Sum
    Write-Host ("    {0,-24} {1,8:N1} MB" -f $_.Name, ($size / 1MB))
  }
  Write-Host '    （能列出这些说明网络下载这关已经过了）'
} else {
  Write-Host '    [X] 缓存目录不存在' -ForegroundColor Red
}

# ---- 5. 修复 ----
Write-Host ''
if ($Fix) {
  Write-Host '[5] 尝试修复：重新安装 app-builder-bin'
  $desktop = Join-Path $root 'apps\desktop'
  $pkgDir = Join-Path $desktop 'node_modules\app-builder-bin'

  if (Test-Path $pkgDir) {
    Write-Host "    删除 $pkgDir"
    Remove-Item $pkgDir -Recurse -Force -ErrorAction SilentlyContinue
  }

  $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
  if (-not $npm) { $npm = (Get-Command npm -ErrorAction SilentlyContinue).Source }

  if ($npm) {
    Write-Host '    重新安装（会重新下载 app-builder-bin）...'
    $proc = Start-Process -FilePath $npm -ArgumentList 'install', '--no-audit', '--no-fund' `
      -WorkingDirectory $desktop -PassThru -Wait -NoNewWindow
    Write-Host "    npm 退出码: $($proc.ExitCode)"
  } else {
    Write-Host '    [X] 找不到 npm，请手动执行：' -ForegroundColor Red
    Write-Host '        cd apps\desktop'
    Write-Host '        npm install'
  }

  Write-Host ''
  if (Test-Path $exe) {
    $len = (Get-Item $exe).Length
    if ($len -gt 5MB) {
      Write-Host '    [OK] 修复后文件正常了，回去重跑 build-installer.bat' -ForegroundColor Green
    } else {
      Write-Host "    [X] 重新装完还是只有 $len 字节" -ForegroundColor Red
      Write-Host '        大概率是杀毒软件在解压后立刻把 exe 删掉了。' -ForegroundColor Yellow
      Write-Host '        请把下面这个目录加入杀毒软件白名单，然后重跑本脚本 -Fix：' -ForegroundColor Yellow
      Write-Host "           $pkgDir" -ForegroundColor Yellow
      Write-Host '        同时检查 Windows 安全中心 → 病毒和威胁防护 → 保护历史记录，' -ForegroundColor Yellow
      Write-Host '        看有没有被隔离的 app-builder.exe。' -ForegroundColor Yellow
    }
  } else {
    Write-Host '    [X] 重新安装后文件仍然不存在' -ForegroundColor Red
  }
} else {
  Write-Host '  下一步'
  Write-Host '    · 如果上面 [2] 显示 0 字节或太小，或 [3] 执行失败：'
  Write-Host '        重跑本脚本并加上 -Fix（会自动重装 app-builder-bin）：'
  Write-Host '          powershell -File tools/diagnose-appbuilder.ps1 -Fix'
  Write-Host ''
  Write-Host '    · 如果 [3] 报"执行抛错"：'
  Write-Host '        几乎可以确定是杀毒软件拦的。把 apps\desktop\node_modules 加入白名单。'
  Write-Host ''
  Write-Host '    · 如果一切 [OK] 但打包仍失败：'
  Write-Host '        把本脚本的完整输出发我，我再看下一层。'
}

Write-Host ''
Read-Host '  按回车关闭'
