# GPU adapter A/B.
# Four Chromium GPU configurations, each launched once, measured, then killed.
# Written as ONE script so the whole sweep needs a single approval instead of four.
$w = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $w 'apps\desktop\node_modules\electron\dist\electron.exe'
$repl = Join-Path $w '.repl'
$spec = Join-Path $w 'tools\spec-gpuab.json'
$session = Join-Path $w 'packages\core\.session.json'

$variants = @(
  @{ name = 'A force_high_performance (current)'; gpu = 'high'; flags = '' },
  @{ name = 'B no gpu switch (chromium decides)'; gpu = 'none'; flags = '' },
  @{ name = 'C force_low_power (igpu)';           gpu = 'low';  flags = '' },
  @{ name = 'D high + no direct composition';     gpu = 'high'; flags = 'disable-direct-composition' }
)

foreach ($v in $variants) {
  Write-Host ""
  Write-Host "==================== $($v.name) ===================="

  Remove-Item $repl -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $repl -Force | Out-Null
  Remove-Item Env:\MP_BENCH, Env:\MP_PULSE, Env:\MP_CYCLE, Env:\MP_SHOT, Env:\MP_COVERSHOT, Env:\MP_JANK, Env:\MP_REPL, Env:\MP_GPU, Env:\MP_GPU_FLAGS -ErrorAction SilentlyContinue

  $env:MP_REPL = $repl
  $env:MP_GPU = $v.gpu
  if ($v.flags -ne '') { $env:MP_GPU_FLAGS = $v.flags }
  $env:MUSIC_SESSION_FILE = $session

  $out = Join-Path $w ".logs\gpuab-out.txt"
  $err = Join-Path $w ".logs\gpuab-err.txt"
  Remove-Item $out, $err -Force -ErrorAction SilentlyContinue

  $p = Start-Process -FilePath $exe -ArgumentList '.' -WorkingDirectory (Join-Path $w 'apps\desktop') `
    -RedirectStandardOutput $out -RedirectStandardError $err -PassThru

  # wait for the REPL to report ready
  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 800
    if (Test-Path (Join-Path $repl 'out.jsonl')) {
      $c = Get-Content (Join-Path $repl 'out.jsonl') -Raw -ErrorAction SilentlyContinue
      if ($c -match 'ready') { $ready = $true; break }
    }
  }
  if (-not $ready) {
    Write-Host "  !! REPL never became ready"
    try { $p.Kill() } catch {}
    continue
  }

  # which GPU did WebGL actually get?
  $gpuInfo = & node (Join-Path $w 'tools\repl-send.mjs') "(()=>{const c=document.createElement('canvas');const g=c.getContext('webgl2')||c.getContext('webgl');const d=g&&g.getExtension('WEBGL_debug_renderer_info');return d?g.getParameter(d.UNMASKED_RENDERER_WEBGL):'?';})()"
  Write-Host "  WebGL GPU: $gpuInfo"

  & node (Join-Path $w 'tools\measure.mjs') --file $spec

  try { $p.Kill() } catch {}
  Start-Sleep -Seconds 3
}

Write-Host ""
Write-Host "done"
