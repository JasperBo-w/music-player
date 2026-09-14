<#
.SYNOPSIS
    构建只包含站点文件的部署暂存目录，并做上线前校验。

.DESCRIPTION
    apps/site 里混着文档（README/DEPLOY/RELEASE）和工具脚本，
    直接把整个目录 deploy 上去会有把这些一起公开的风险。
    这个脚本按白名单复制，避免"漏掉某个文件"或"多传了不该传的文件"。

    复制完会检查：
      - 必备文件是否齐全（index.html / app.js / styles.css / site.config.json）
      - 是否混入了 .md / tools/ 之类的非站点文件
      - site.config.json 是否是合法 JSON
      - 配置里的下载链接是否还是占位符（会提示但不算失败）

.PARAMETER OutDir
    暂存目录，默认 .tmpcheck/site-deploy

.EXAMPLE
    powershell -File apps/site/tools/stage-deploy.ps1
    npx wrangler pages deploy .tmpcheck/site-deploy --project-name=music-player-download
#>

[CmdletBinding()]
param(
  [string] $OutDir = '.tmpcheck/site-deploy'
)

$ErrorActionPreference = 'Stop'

$siteDir = Resolve-Path (Join-Path $PSScriptRoot '..')
$repoRoot = Resolve-Path (Join-Path $siteDir '..\..')
Set-Location $repoRoot

# 白名单：只有这些会进入暂存目录
$files = @(
  'index.html',
  'styles.css',
  'app.js',
  'site.config.json',
  'robots.txt',
  '_headers',
  '_redirects',
  '.assetsignore'
)
$dirs = @('assets')

Write-Host "站点目录 : $siteDir"
Write-Host "输出目录 : $OutDir"
Write-Host ''

if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# 统一用绝对路径：后面要和 Get-ChildItem 返回的绝对路径做比较，
# 混用相对路径会让每个文件都被误判成"多余文件"。
$OutDir = (Resolve-Path $OutDir).Path

foreach ($f in $files) {
  $src = Join-Path $siteDir $f
  if (-not (Test-Path $src)) { throw "缺少必备文件：$f" }
  Copy-Item $src (Join-Path $OutDir $f)
}

foreach ($d in $dirs) {
  $src = Join-Path $siteDir $d
  if (-not (Test-Path $src)) { throw "缺少必备目录：$d" }
  Copy-Item $src (Join-Path $OutDir $d) -Recurse
}

Write-Host '已复制：'
Get-ChildItem (Join-Path $OutDir 'assets') -Directory | ForEach-Object {
  Write-Host ("  assets/{0}/  ({1} 个文件)" -f $_.Name, (Get-ChildItem $_.FullName -File).Count)
}

# ---- 校验 1：不能混入非站点文件 ----
$allowed = @()
foreach ($f in $files) { $allowed += (Join-Path $OutDir $f) }
foreach ($d in $dirs) { $allowed += (Get-ChildItem (Join-Path $OutDir $d) -Recurse -File).FullName }
$stray = Get-ChildItem $OutDir -Recurse -File | Where-Object { $allowed -notcontains $_.FullName }

Write-Host ''
if ($stray) {
  Write-Host '发现不该出现的文件：' -ForegroundColor Red
  $stray | ForEach-Object { Write-Host ("  {0}" -f $_.FullName.Replace((Resolve-Path $OutDir).Path, '')) -ForegroundColor Red }
  throw '暂存目录校验失败：存在多余文件'
}
Write-Host '✓ 无多余文件（文档与工具脚本均未混入）' -ForegroundColor Green

# ---- 校验 2：JSON 合法性 ----
$cfgPath = Join-Path $OutDir 'site.config.json'
try {
  $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host '✓ site.config.json 是合法 JSON' -ForegroundColor Green
} catch {
  throw "site.config.json 解析失败：$($_.Exception.Message)"
}

# ---- 校验 3：必须文件的体积不能是 0 ----
$empty = Get-ChildItem $OutDir -Recurse -File | Where-Object { $_.Length -eq 0 }
if ($empty) { throw "存在空文件：$($empty.Name -join ', ')" }
Write-Host '✓ 无空文件' -ForegroundColor Green

# ---- 提示：占位符状态（不算失败，允许先发页面后传包）----
Write-Host ''
$url = $cfg.release.downloads.windows
if ($url -match 'REPLACE' -or $cfg.release.sha256 -match '待填写') {
  Write-Host '提示：配置里还有占位符。' -ForegroundColor Yellow
  Write-Host '      页面上会显示「安装包未发布」且下载按钮不可点，这是预期行为。' -ForegroundColor Yellow
  Write-Host '      等安装包传上 R2 后再填 release.downloads.windows 和 sha256。' -ForegroundColor Yellow
} else {
  Write-Host ("✓ 下载链接已配置：{0}" -f $url) -ForegroundColor Green
  Write-Host ("  版本 {0} / {1} / SHA256 {2}..." -f `
    $cfg.release.version, $cfg.release.fileSize, $cfg.release.sha256.Substring(0, 12))
}

$total = (Get-ChildItem $OutDir -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ''
Write-Host ("暂存目录就绪，共 {0} 个文件 / {1:N0} KB" -f `
  (Get-ChildItem $OutDir -Recurse -File).Count, ($total / 1KB)) -ForegroundColor Green
Write-Host ''
Write-Host '下一步：' -ForegroundColor Cyan
Write-Host ("  npx wrangler pages deploy $OutDir --project-name=music-player-download")
Write-Host '或把该目录拖进 Cloudflare 面板的 Upload assets。'
