# ==========================================================================
#  国内网络：给 electron / electron-builder 配镜像
# --------------------------------------------------------------------------
#  背景：electron-builder 打包时需要从 GitHub Releases 下载这些二进制：
#    · electron-v<版本>-win32-x64.zip        约 150 MB
#    · nsis / nsis-resources                 约 13 MB
#    · winCodeSign                           约 5 MB
#  直连 GitHub 在国内经常超时，典型报错是：
#    read tcp ...: connection attempt failed ... connected host has failed to respond
#    ⨯ downloadArtifact ... electron-v42.11.3-win32-x64.zip
#
#  更坑的是失败点会被掩盖：下载是 app-builder 干的，下载失败它就非零退出，
#  electron-builder 于是报：
#    app-builder.exe process failed ERR_ELECTRON_BUILDER_CANNOT_EXECUTE
#  看起来像"可执行文件坏了"，实际是网络问题。所以先配镜像。
#
#  用法：
#    powershell -File tools/setup-cn-mirrors.ps1            （当前窗口生效）
#    powershell -File tools/setup-cn-mirrors.ps1 -Persist   （写入用户环境变量，长期生效）
#
#  改的是环境变量，不动任何配置文件，随时可以通过 -Persist 之后手工删除还原。
# ==========================================================================

[CmdletBinding()]
param(
  # 写进用户级环境变量（新开的窗口都会带上），不加则只在当前窗口生效
  [switch] $Persist
)

$ErrorActionPreference = 'Stop'

# npmmirror 是阿里维护的 npm/二进制镜像，国内速度快且覆盖 electron 相关全部产物
$vars = [ordered]@{
  'ELECTRON_MIRROR'         = 'https://npmmirror.com/mirrors/electron/'
  'ELECTRON_BUILDER_BINARIES_MIRROR' = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
  'npm_config_registry'     = 'https://registry.npmmirror.com'
}

Write-Host ''
Write-Host '  electron / electron-builder 镜像配置'
Write-Host '  ========================================'
Write-Host ''

foreach ($name in $vars.Keys) {
  $value = $vars[$name]
  # 当前进程（含本脚本之后启动的子进程）一定能拿到
  Set-Item -Path "Env:$name" -Value $value

  if ($Persist) {
    # 用户级环境变量：新开的终端会继承
    [Environment]::SetEnvironmentVariable($name, $value, 'User')
    Write-Host ("  {0}`n     = {1}   [已写入用户环境变量]" -f $name, $value) -ForegroundColor Green
  } else {
    Write-Host ("  {0}`n     = {1}" -f $name, $value) -ForegroundColor Green
  }
}

Write-Host ''
if ($Persist) {
  Write-Host '  已持久化。以后新开的终端会自动带上这些设置。' -ForegroundColor Cyan
  Write-Host '  想还原：系统 → 环境变量 → 删除上面这三个变量。' -ForegroundColor DarkGray
} else {
  Write-Host '  注意：只在当前窗口生效。' -ForegroundColor Yellow
  Write-Host '  安装包脚本会自动带上它们，但你手工跑命令时不会 ——'
  Write-Host '  想让所有窗口都生效，加 -Persist 重跑一次：' -ForegroundColor Yellow
  Write-Host '     powershell -File tools/setup-cn-mirrors.ps1 -Persist' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '  下一步：重跑打包'
Write-Host '     build-installer.bat'
Write-Host ''
Write-Host '  如果镜像也超时，可以手工验证镜像是否可达：' -ForegroundColor DarkGray
Write-Host '     curl.exe -I https://npmmirror.com/mirrors/electron/' -ForegroundColor DarkGray
Write-Host ''
