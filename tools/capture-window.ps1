# Capture an arbitrary window by title substring.
# My REPL hook only works inside my own app, so for looking at another
# program's rendering I need a plain Win32 + GDI capture.
# ASCII-only on purpose: PowerShell 5.1 reads UTF-8 .ps1 as GBK and would
# mangle any non-ASCII literal into a parse error.
param(
  [Parameter(Mandatory = $true)][string]$TitleLike,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$WaitMs = 1200
)

Add-Type -AssemblyName System.Drawing -ErrorAction Stop
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Cap {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@ -ErrorAction Stop

$target = $null
foreach ($p in Get-Process) {
  if ($p.MainWindowHandle -eq 0) { continue }
  $sb = New-Object System.Text.StringBuilder 400
  [void][Cap]::GetWindowTextW($p.MainWindowHandle, $sb, 400)
  $t = $sb.ToString()
  if ($t -like "*$TitleLike*") { $target = $p; break }
}
if (-not $target) {
  Write-Host "NOT FOUND: no window matching '$TitleLike'"
  Write-Host "--- windows seen ---"
  foreach ($p in Get-Process) {
    if ($p.MainWindowHandle -ne 0) {
      $sb = New-Object System.Text.StringBuilder 400
      [void][Cap]::GetWindowTextW($p.MainWindowHandle, $sb, 400)
      Write-Host ("  {0}  [{1}]" -f $sb.ToString(), $p.ProcessName)
    }
  }
  exit 1
}

$h = $target.MainWindowHandle
[void][Cap]::ShowWindow($h, 9)
[void][Cap]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0043)  # topmost + show
[void][Cap]::SetForegroundWindow($h)
Start-Sleep -Milliseconds $WaitMs

$r = New-Object Cap+RECT
[void][Cap]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L
$hh = $r.B - $r.T
if ($w -le 0 -or $hh -le 0) { Write-Host "bad rect"; exit 1 }

# Try PrintWindow first: it asks the window to draw itself into our DC, so an
# occluded window still comes out whole. Screen copy only sees whatever happens
# to be on top, which is how the first attempt ended up half browser toolbar.
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [Cap]::PrintWindow($h, $hdc, 2)   # 2 = PW_RENDERFULLCONTENT
$g.ReleaseHdc($hdc)
if (-not $ok) {
  Write-Host "PrintWindow failed, falling back to screen copy"
  $g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size $w, $hh))
}
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host ("captured '{0}' {1}x{2} printwindow={3} -> {4}" -f $target.MainWindowTitle, $w, $hh, $ok, $Out)
