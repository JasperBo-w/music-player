# ==========================================================================
#  音乐播放器 · 下载页截图处理工具
# --------------------------------------------------------------------------
#  用途：把你自己截的原始界面图处理成下载页能直接用的格式，并生成配置片段。
#
#  为什么要单独做这个脚本：
#    .shots-effects/ 等目录里的截图是开发过程调试用的，里面混着登录态
#    （侧栏会显示用户名和 UID）和大量"改到一半"的中间状态，不适合直接
#    放到公开下载页上。所以产品截图应当专门截一次。
#
#  用法：
#    powershell -File tools/make-site-shots.ps1 -Shot .\shot1.png,.\shot2.png
#    powershell -File tools/make-site-shots.ps1 -Shot .\a.png -NoRedact
#    powershell -File tools/make-site-shots.ps1 -Shot .\a.png -DryRun
#
#  做了三件事：
#    1. 遮盖侧栏左下角的账号信息（默认开启，-NoRedact 可关）
#    2. 等比缩到 1600px 宽并转成 JPEG（体积约降 85%）
#    3. 打印可直接粘进 apps/site/site.config.json 的 screenshots 数组
# ==========================================================================

[CmdletBinding()]
param(
  # 你自己截的原图，可以给多个
  [Parameter(Mandatory = $true)]
  [string[]] $Shot,

  # 遮盖账号信息（侧栏左下角的用户名 / UID）
  [switch] $NoRedact,

  # 只打印会做什么，不实际写文件。第一次用建议先跑一次看看
  [switch] $DryRun,

  [int]    $MaxWidth = 1600,
  [int]    $Quality  = 88,
  [string] $OutDir   = 'apps/site/assets/screenshots'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# --------------------------------------------------------------------------
# 账号信息所在区域
# --------------------------------------------------------------------------
# 坐标是在 1860x1203（本仓库截图的常见尺寸）下量的，会按实际原图尺寸等比换算，
# 所以你的截图只要窗口比例接近就能对上，不需要改这里。
#
# 如果你的窗口宽度差别很大（比如很窄的窗口），坐标可能不覆盖：
# 用 -DryRun 生成一张带红框的预览图，先确认框住了再正式跑。
$AccountRegion = [pscustomobject]@{ X = 28; Y = 950; W = 300; H = 92; RefW = 1860; RefH = 1203 }

function Get-RedactRect {
  param([System.Drawing.Image] $Image)
  $sx = $Image.Width  / $AccountRegion.RefW
  $sy = $Image.Height / $AccountRegion.RefH
  return [System.Drawing.Rectangle]::new(
    [int][Math]::Round($AccountRegion.X * $sx),
    [int][Math]::Round($AccountRegion.Y * $sy),
    [int][Math]::Round($AccountRegion.W * $sx),
    [int][Math]::Round($AccountRegion.H * $sy)
  )
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

$mime    = 'image/jpeg'
$encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
             Where-Object { $_.MimeType -eq $mime }
if (-not $encoder) { throw '系统缺少 JPEG 编码器' }

$entries = @()

foreach ($item in $Shot) {
  if (-not (Test-Path $item)) { Write-Warning "找不到文件，跳过：$item"; continue }

  $loaded = [System.Drawing.Image]::FromFile((Resolve-Path $item))
  $img    = [System.Drawing.Bitmap]::new($loaded)
  $loaded.Dispose()

  try {
    $rect = Get-RedactRect -Image $img
    $base = [System.IO.Path]::GetFileNameWithoutExtension($item)
    $outPath = Join-Path $OutDir ($base + '.jpg')

    Write-Host ''
    Write-Host "输入 : $item  ($($img.Width)x$($img.Height))"
    if (-not $NoRedact) {
      Write-Host ("遮盖 : x={0}..{1}, y={2}..{3}  (侧栏账号信息)" -f `
        $rect.X, $rect.Right, $rect.Y, $rect.Bottom)
    } else {
      Write-Host '遮盖 : 已关闭（-NoRedact）'
    }
    Write-Host "输出 : $outPath"

    if ($DryRun) {
      # 预览模式：画个红框标出遮盖区域，缩放到 900px 宽方便直接看
      $w = [Math]::Min(900, $img.Width)
      $h = [int][Math]::Round($img.Height * $w / $img.Width)
      $bmp = [System.Drawing.Bitmap]::new($w, $h)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.DrawImage($img, 0, 0, $w, $h)
      if (-not $NoRedact) {
        $k = $w / $img.Width
        $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 255, 60, 60), 3)
        $g.DrawRectangle($pen,
          [int]($rect.X * $k), [int]($rect.Y * $k),
          [int]($rect.Width * $k), [int]($rect.Height * $k))
        $pen.Dispose()
      }
      $g.Dispose()
      $prev = Join-Path $OutDir ("DRYRUN-" + $base + '.png')
      $bmp.Save($prev, [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()
      Write-Host "预览 : $prev   ← 打开看一眼红框有没有框住账号信息"
      continue
    }

    # 缩放到目标宽度（只缩不放）
    $scale = if ($img.Width -gt $MaxWidth) { $MaxWidth / $img.Width } else { 1 }
    $newW = [int][Math]::Round($img.Width * $scale)
    $newH = [int][Math]::Round($img.Height * $scale)

    $bmp = [System.Drawing.Bitmap]::new($newW, $newH)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $g.DrawImage($img, 0, 0, $newW, $newH)

      if (-not $NoRedact) {
        # 采样遮盖区右侧的侧栏底色，铺满整个区域。
        # 只模糊不做填充是不够的：低分辨率下仍可能辨认出数字。
        $sx = $newW / $img.Width
        $sy = $newH / $img.Height
        $dst = [System.Drawing.Rectangle]::new(
          [int][Math]::Round($rect.X * $sx), [int][Math]::Round($rect.Y * $sy),
          [int][Math]::Round($rect.Width * $sx), [int][Math]::Round($rect.Height * $sy))

        $sampleX = [Math]::Min($bmp.Width - 1, $dst.Right + 8)
        $sample  = $bmp.GetPixel($sampleX, $dst.Y + 4)
        $brush   = [System.Drawing.SolidBrush]::new($sample)
        try { $g.FillRectangle($brush, $dst) } finally { $brush.Dispose() }
      }
    } finally { $g.Dispose() }

    $encParams = [System.Drawing.Imaging.EncoderParameters]::new(1)
    $encParams.Param[0] = [System.Drawing.Imaging.EncoderParameter]::new(
      [System.Drawing.Imaging.Encoder]::Quality, [int]$Quality)
    $bmp.Save($outPath, $encoder, $encParams)
    $encParams.Dispose()
    $bmp.Dispose()

    $inKB  = [Math]::Round((Get-Item $item).Length / 1KB)
    $outKB = [Math]::Round((Get-Item $outPath).Length / 1KB)
    Write-Host ("完成 : {0}x{1} -> {2}x{3},  {4} KB -> {5} KB" -f `
      $img.Width, $img.Height, $newW, $newH, $inKB, $outKB)

    $entries += "/assets/screenshots/$base.jpg"
  } finally { $img.Dispose() }
}

Write-Host ''
if ($DryRun) {
  Write-Host '（DryRun 模式，没有生成正式截图。确认红框位置后去掉 -DryRun 重跑。）' -ForegroundColor Yellow
  exit 0
}

if ($entries.Count -gt 0) {
  Write-Host '=== 把下面这段填进 apps/site/site.config.json 的 screenshots 字段 ===' -ForegroundColor Cyan
  Write-Host '（caption 故意留空：自己写一句说明比自动生成的更有用）' -ForegroundColor DarkGray
  Write-Host ''
  # 默认第一张在页面上占满整行，第二、三张并排，以此类推
  for ($i = 0; $i -lt $entries.Count; $i++) {
    Write-Host ("    {{ `"src`": `"{0}`", `"caption`": `"`" }}{1}" -f `
      $entries[$i], $(if ($i -lt $entries.Count - 1) { ',' } else { '' }))
  }
  Write-Host ''
  Write-Host ("共 {0} 张，输出到 $OutDir" -f $entries.Count) -ForegroundColor Green
}
