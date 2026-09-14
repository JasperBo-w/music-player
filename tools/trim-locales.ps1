# ==========================================================================
#  裁剪 Electron 语言包
# --------------------------------------------------------------------------
#  为什么需要：
#
#  Electron 默认打包全部 55 种语言包，解开后有 47 MB —— 接近安装包的一半。
#  本应用界面只有中文，英文版也只是顺带，其余 53 种永远用不到。
#
#  实测数据（Electron 42.11.3）：
#    55 个 .pak  合计 47.18 MB
#    只留 zh-CN / zh-TW / en-US / en-GB  合计 2.18 MB
#
#  为什么做成脚本而不是只靠 electron-builder 配置：
#  electron-builder 没有"只保留某些语言"的正式选项（这是它仓库里的已知 issue）。
#  靠 files 的排除 glob 是可以的，但不同版本对取反模式的支持不一致 ——
#  配置不生效时它**静默通过**，你只会看到安装包还是那么大。
#  所以这里再加一道确定性的裁剪，跑完直接报出实际删了多少。
#
#  用法：
#    powershell -File tools/trim-locales.ps1
#    powershell -File tools/trim-locales.ps1 -Dist apps/desktop/dist
#    powershell -File tools/trim-locales.ps1 -DryRun    （只报告，不删）
#
#  注意：要在 electron-builder 生成完 win-unpacked 之后、打 NSIS 之前跑才有意义。
#  build-installer.ps1 已经把它接进流程；手工跑请对着已有的 win-unpacked 目录。
# ==========================================================================

[CmdletBinding()]
param(
  [string] $Dist = 'apps/desktop/dist',
  # 只报告能省多少，不实际删除
  [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

# 保留哪些语言。中文是界面语言，英文留着是为了看不懂中文时的兜底界面。
# 想更激进可以只留 zh-CN，但那会让英文系统显示成中文，不推荐。
$keep = @('zh-CN', 'zh-TW', 'en-US', 'en-GB')

$unpacked = Join-Path $Dist 'win-unpacked'
$locales = Join-Path $unpacked 'locales'

Write-Host ''
Write-Host '  裁剪 Electron 语言包'
Write-Host '  ========================================'
Write-Host ''

if (-not (Test-Path $locales)) {
  Write-Host "  找不到 $locales" -ForegroundColor Yellow
  Write-Host '  （还没打包过？先跑 build-installer.bat）'
  exit 0
}

$all = Get-ChildItem $locales -Filter '*.pak' -File
if (-not $all) {
  Write-Host '  locales 目录里没有 .pak 文件，跳过。'
  exit 0
}

# 安全检查：必须能找到要保留的语言，否则说明目录结构和预期不符，
# 这种情况下**不要**动手 —— 删完可能整个界面变成空白语言。
$keepFiles = $all | Where-Object { $keep -contains $_.BaseName }
if ($keepFiles.Count -eq 0) {
  Write-Host '  [X] 一个要保留的语言包都没找到，中止。' -ForegroundColor Red
  Write-Host "      期望其中至少一个: $($keep -join ', ')"
  Write-Host "      实际目录里有: $(($all | Select-Object -First 5 -ExpandProperty BaseName) -join ', ') ..."
  exit 1
}

$toDelete = $all | Where-Object { $keep -notcontains $_.BaseName }

$totalMB = ($all | Measure-Object Length -Sum).Sum / 1MB
$keepMB = (($all | Where-Object { $keep -contains $_.BaseName } | Measure-Object Length -Sum).Sum) / 1MB
$delMB = ($toDelete | Measure-Object Length -Sum).Sum / 1MB

Write-Host ("  语言包总数    : {0}" -f $all.Count)
Write-Host ("  当前合计      : {0:N2} MB" -f $totalMB)
Write-Host ("  保留（$($keep -join '/')）")
Write-Host ("                : {0} 个 / {1:N2} MB" -f $keepFiles.Count, $keepMB)
Write-Host ("  将删除        : {0} 个 / {1:N2} MB" -f $toDelete.Count, $delMB)
Write-Host ''

if ($DryRun) {
  Write-Host '  （-DryRun，未实际删除）' -ForegroundColor Yellow
  Write-Host ''
  Write-Host ("  删掉后 locales 会从 {0:N2} MB 降到 {1:N2} MB" -f $totalMB, $keepMB)
  exit 0
}

$failed = 0
foreach ($f in $toDelete) {
  try {
    Remove-Item $f.FullName -Force -ErrorAction Stop
  } catch {
    $failed++
    Write-Host ("    [X] 删不掉 {0}: {1}" -f $f.Name, $_.Exception.Message) -ForegroundColor Red
  }
}

$after = Get-ChildItem $locales -Filter '*.pak' -File
$afterMB = ($after | Measure-Object Length -Sum).Sum / 1MB

Write-Host ''
if ($failed -eq 0) {
  Write-Host ("  [OK] 已删除 {0} 个语言包，locales: {1:N2} MB -> {2:N2} MB" -f `
    $toDelete.Count, $totalMB, $afterMB) -ForegroundColor Green
  Write-Host ("       剩余: {0}" -f (($after | Sort-Object Name | ForEach-Object { $_.BaseName }) -join ', '))
} else {
  Write-Host ("  [!] {0} 个文件删除失败（可能有进程占用）" -f $failed) -ForegroundColor Yellow
  Write-Host ("       locales 现在 {0:N2} MB" -f $afterMB)
  Write-Host '       关掉正在运行的程序再跑一次。'
  exit 1
}

Write-Host ''
