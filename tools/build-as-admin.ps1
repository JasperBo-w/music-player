# ==========================================================================
#  以管理员身份重跑打包
# --------------------------------------------------------------------------
#  为什么需要管理员：
#
#  electron-builder 会下载并解压 winCodeSign 工具包，而这个包是从 macOS 环境
#  打的，里面有指向 .dylib 的符号链接。Windows 默认禁止普通用户创建符号链接，
#  于是解压失败：
#
#    ERROR: Cannot create symbolic link : 客户端没有所需的特权
#      ...winCodeSign\...\darwin\10.12\lib\libcrypto.dylib
#    ERROR: 7-Zip cannot create symbolic link
#
#  这个包即使没有配置代码签名证书也会被下载（electron-builder 启动时就检查），
#  所以绕不开 —— 要么给它管理员权限，要么手工把缓存铺好后禁止它下载。
#
#  这个脚本做两件事：
#    1. 清掉之前失败解压留下的半成品缓存（它们会让后续每次都重新解压）
#    2. 用管理员权限重新启动 build-installer.ps1
#
#  用法：
#    powershell -File tools/build-as-admin.ps1
#    powershell -File tools/build-as-admin.ps1 -CheckOnly   （只清理，不打包）
# ==========================================================================

[CmdletBinding()]
param(
  [switch] $CheckOnly
)

$ErrorActionPreference = 'Continue'

$root = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path (Join-Path $root 'build-installer.ps1'))) {
  # 也可能就在仓库根被调用
  $root = $PSScriptRoot
}

Write-Host ''
Write-Host '  以管理员身份打包'
Write-Host '  ========================================'
Write-Host ''

# ---- 1. 清理损坏的 winCodeSign 缓存 ----
Write-Host '[1] 检查 winCodeSign 缓存'

$wc = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign'
if (Test-Path $wc) {
  $dirs = @(Get-ChildItem $wc -Directory -ErrorAction SilentlyContinue)

  # 完整性判据：Windows 构建真正需要的是 rcedit（用来改 exe 的图标和版本信息）。
  #
  # 不要用"文件总数"判断 —— 这个包正常解压出来就是 83 个文件。原因：它里面的
  # darwin/linux 那些 .dylib 是符号链接，没权限时 7-Zip 会跳过它们，
  # 所以文件数永远到不了 100+。之前按 100 判断，把一个完好的缓存反复删掉重解压。
  # 按实际产物判断才是可靠的。
  $broken = @()
  $healthy = @()
  foreach ($d in $dirs) {
    $rcedit = Get-ChildItem $d.FullName -Filter 'rcedit-x64.exe' -File -Recurse -ErrorAction SilentlyContinue |
                Select-Object -First 1
    if ($rcedit -and $rcedit.Length -gt 100KB) { $healthy += $d } else { $broken += $d }
  }

  if ($broken.Count -gt 0) {
    foreach ($d in $broken) {
      $count = (Get-ChildItem $d.FullName -Recurse -File -ErrorAction SilentlyContinue |
                  Measure-Object).Count
      Write-Host ("    删除不完整的缓存 {0}（{1} 个文件，但找不到 rcedit-x64.exe）" -f $d.Name, $count) -ForegroundColor Yellow
      Remove-Item $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host '    [OK] 已清理，下次会重新解压' -ForegroundColor Green
  } elseif ($healthy.Count -gt 0) {
    Write-Host ("    [OK] 缓存完好（{0} 份，rcedit 就位，无需重解压）" -f $healthy.Count) -ForegroundColor Green
  } else {
    Write-Host '    （缓存为空，首次会下载并解压）'
  }
} else {
  Write-Host '    （缓存目录不存在，首次会下载并解压）'
}

# 顺带清掉 electron-builder 缓存里的下载中间产物
$dl = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\downloads'
if (Test-Path $dl) {
  $partial = Get-ChildItem $dl -Recurse -File -ErrorAction SilentlyContinue |
               Where-Object { $_.Extension -ne '.7z' -and $_.Extension -ne '.zip' -and $_.Extension -ne '.gz' }
  if ($partial) {
    Write-Host ("    清理下载中间产物 {0} 个" -f ($partial | Measure-Object).Count)
    $partial | Remove-Item -Force -ErrorAction SilentlyContinue
  }
}

# ---- 2. 已提权就直接打包 ----
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host ''
Write-Host '[2] 当前权限'
Write-Host "    用户: $($identity.Name)"
Write-Host "    管理员: $isAdmin"

if ($CheckOnly) {
  Write-Host ''
  Write-Host '    （-CheckOnly，不启动打包）'
  Read-Host '  按回车关闭'
  exit 0
}

if ($isAdmin) {
  Write-Host '    已是管理员，直接开始打包'
  Write-Host ''

  # 输出同时写日志：窗口万一被关掉，结果还能查
  $log = Join-Path $root '.logs\build-as-admin.log'
  New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
  Write-Host "    过程日志：$log"
  Write-Host ''

  & (Join-Path $root 'build-installer.ps1') *>&1 | Tee-Object -FilePath $log
  $code = $LASTEXITCODE

  Write-Host ''
  if ($code -eq 0) {
    Write-Host '  [OK] 打包脚本退出码 0' -ForegroundColor Green
  } else {
    Write-Host "  [!] 打包脚本退出码 $code，看上面输出或日志" -ForegroundColor Yellow
  }
  Write-Host '  本窗口会保持打开，方便你看结果。' -ForegroundColor DarkGray
  exit $code
}

# ---- 3. 未提权：弹 UAC 重新启动自己 ----
Write-Host ''
Write-Host '[3] 需要提权'
Write-Host '    普通用户无法创建符号链接，winCodeSign 解压必然失败。'
Write-Host '    即将弹出 UAC 确认框，请点「是」。'
Write-Host ''

$ps1 = Join-Path $root 'tools\build-as-admin.ps1'
try {
  $proc = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$ps1`"" `
    -Verb RunAs -PassThru
  Write-Host '    已在新窗口启动（管理员权限）。'
  Write-Host '    打包过程在**那个新窗口**里，本窗口可以关掉。'
  Write-Host ''
  Write-Host '    如果 UAC 被拒绝，也可以手工操作：' -ForegroundColor Yellow
  Write-Host '      1. 开始菜单搜 PowerShell → 右键 → 以管理员身份运行' -ForegroundColor Yellow
  Write-Host "      2. cd `"$root`"" -ForegroundColor Yellow
  Write-Host '      3. .\build-installer.ps1' -ForegroundColor Yellow
} catch {
  Write-Host "    [X] 提权失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host ''
  Write-Host '    手工操作：' -ForegroundColor Yellow
  Write-Host '      1. 开始菜单搜 PowerShell → 右键 → 以管理员身份运行' -ForegroundColor Yellow
  Write-Host "      2. cd `"$root`"" -ForegroundColor Yellow
  Write-Host '      3. .\build-installer.ps1' -ForegroundColor Yellow
}

Write-Host ''
Start-Sleep -Seconds 2
