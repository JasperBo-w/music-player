$w = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $w 'apps\desktop\node_modules\electron\dist\electron.exe'
$out = Join-Path $w '.logs\repl-out.txt'
$err = Join-Path $w '.logs\repl-err.txt'
$repl = Join-Path $w '.repl'

Remove-Item Env:\MP_BENCH, Env:\MP_PULSE, Env:\MP_CYCLE, Env:\MP_SHOT, Env:\MP_COVERSHOT, Env:\MP_JANK, Env:\MP_REPL -ErrorAction SilentlyContinue
Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
Remove-Item $repl -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $repl -Force | Out-Null

# 常驻模式：起来之后不自己退出，一直等 cmd.json
$env:MP_REPL = $repl
$env:MUSIC_SESSION_FILE = (Join-Path $w 'packages\core\.session.json')

$p = Start-Process -FilePath $exe -ArgumentList '.' -WorkingDirectory (Join-Path $w 'apps\desktop') `
  -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
Write-Host "electron pid=$($p.Id)"
