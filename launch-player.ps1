# ==========================================================================
#  音乐播放器 · 启动器
# --------------------------------------------------------------------------
#  用法（任选其一）：
#    1. 双击根目录的 play.bat        （推荐，不需要管理员权限）
#    2. 右键本文件 -> 使用 PowerShell 运行
#    3. 命令行：powershell -ExecutionPolicy Bypass -File .\launch-player.ps1
#
#  本文件保存为 UTF-8 with BOM —— Windows PowerShell 5.1 据此正确识别中文。
#  用编辑器改完请确认编码仍是「UTF-8 带 BOM」，存成无 BOM 会让中文变乱码。
#
#  为什么启动逻辑放在 PowerShell 而不是批处理里：
#  cmd.exe 按系统 ANSI 代码页解析 .bat，含中文的批处理在 GBK / UTF-8 之间
#  极易乱码，而乱码会导致引号错位、直接解析失败（不只是显示难看）。
#  所以 play.bat 保持纯 ASCII 只做转交，中文都交给这里。
# ==========================================================================

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
Set-Location $root

function Write-Line { param([string] $Text = '') Write-Host $Text }

$electron = Join-Path $root 'apps\desktop\node_modules\electron\dist\electron.exe'
$appDir   = Join-Path $root 'apps\desktop'

Write-Line
Write-Line '  音乐播放器'
Write-Line '  ----------------------------------------'
Write-Line

# ---- 依赖检查：给出可照抄的补救命令，而不是让人对着报错发呆 ----
if (-not (Test-Path $electron)) {
  Write-Line '  [x] 找不到 Electron：'
  Write-Line "      $electron"
  Write-Line
  Write-Line '  需要先安装依赖。在项目根目录执行：'
  Write-Line '      pnpm install'
  Write-Line
  Write-Line '  没装 pnpm 的话，逐个装也可以：'
  Write-Line '      cd apps\desktop;        npm install'
  Write-Line '      cd ..\ui;               npm install'
  Write-Line '      cd ..\..\packages\core; npm install'
  Write-Line
  Read-Host '  按回车关闭'
  exit 1
}

if (-not (Test-Path (Join-Path $appDir 'main.js'))) {
  Write-Line '  [x] 找不到应用入口：apps\desktop\main.js'
  Write-Line '      请确认在完整的项目目录下运行。'
  Write-Line
  Read-Host '  按回车关闭'
  exit 1
}

if (-not (Test-Path (Join-Path $root 'packages\core\src\index.js'))) {
  Write-Line '  [x] 找不到音源核心：packages\core\src\index.js'
  Write-Line '      请确认在完整的项目目录下运行。'
  Write-Line
  Read-Host '  按回车关闭'
  exit 1
}

# 若外部设了这个变量，Electron 会退化成纯 Node 模式，界面不会出现
$env:ELECTRON_RUN_AS_NODE = $null

Write-Line '  正在启动，请稍候...'
Write-Line

# ---- 启动 ----
# 用 Start-Process 而不是直接调用：直接调用会把 Electron 的日志全刷在
# 这个控制台窗口里，看起来像报错，容易吓到人。让它独立运行更清爽。
$proc = Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $appDir -PassThru

# 给一点时间让窗口出来。主进程还活着就说明启动成功了。
Start-Sleep -Seconds 4

if ($proc.HasExited) {
  # 退出码要按无符号 32 位转十六进制再比对：Windows 错误码落在 0xC0000000
  # 这一带，PowerShell 报出来却是负数（0xC0000005 -> -1073741819）。
  #
  # 这里不能用 -band 0xFFFFFFFF：PowerShell 把 0xFFFFFFFF 当作 Int32 的 -1，
  # 按位与之后结果仍是负数，转 UInt32 会抛 InvalidCastException。
  # 走字节表示才可靠。
  $code = $proc.ExitCode
  $hex  = '0x{0:X8}' -f [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$code), 0)

  Write-Line "  [x] 播放器启动后立即退出（退出码 $code / $hex）"
  Write-Line

  if ($hex -eq '0xC0000005') {
    Write-Line '      访问违例。常见原因：'
    Write-Line '        - 显卡驱动过旧，试试更新驱动'
    Write-Line '        - 运行在不允许创建图形进程的环境里'
    Write-Line '          （沙箱、无桌面会话的服务、部分远程环境都会这样）'
  } elseif ($hex -eq '0xC0000135') {
    Write-Line '      缺少 DLL，依赖不完整。重装依赖：'
    Write-Line '        cd apps\desktop; npm install'
  } else {
    Write-Line '      进程在初始化阶段就被终止了。可以试试：'
    Write-Line '        1. 更新显卡驱动'
    Write-Line '        2. 删除 apps\desktop\node_modules 后重新 pnpm install'
    Write-Line '        3. 若杀毒开了「受控文件夹访问」，把本目录加入白名单'
    Write-Line '        4. 确认不是在沙箱 / 无图形环境里运行'
  }

  Write-Line
  Read-Host '  按回车关闭'
  exit 1
}

Write-Line '  已启动，窗口应该已经出现了。'
Write-Line '  本窗口可以直接关掉，不影响播放器运行。'
Write-Line
Start-Sleep -Seconds 2
exit 0
