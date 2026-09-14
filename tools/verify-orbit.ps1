$w = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $w 'apps\desktop\node_modules\electron\dist\electron.exe'
$out = Join-Path $w '.logs\ret-out.txt'
$err = Join-Path $w '.logs\ret-err.txt'

Remove-Item Env:\MP_BENCH, Env:\MP_PULSE, Env:\MP_CYCLE, Env:\MP_SHOT, Env:\MP_COVERSHOT -ErrorAction SilentlyContinue
Remove-Item (Join-Path $w '.shots11') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $out, $err -Force -ErrorAction SilentlyContinue

$env:MP_COVERSHOT = (Join-Path $w '.shots11')
$env:MUSIC_SESSION_FILE = (Join-Path $w 'packages\core\.session.json')

$p = Start-Process -FilePath $exe -ArgumentList '.' -WorkingDirectory (Join-Path $w 'apps\desktop') `
  -RedirectStandardOutput $out -RedirectStandardError $err -PassThru

if (-not $p.WaitForExit(150000)) {
  Write-Host 'TIMEOUT - killing'
  try { $p.Kill() } catch {}
}
Write-Host "exit=$($p.ExitCode)"
