/*
 * 中键锁/解锁 —— 全局监听。
 *
 * 用户要求："只用鼠标中间就能实现解锁和锁定"。
 *
 * 为什么必须从**系统层面**读按键：
 * 锁定 = 整窗穿透（setIgnoreMouseEvents(true)）→ 窗口收不到**任何**鼠标事件，
 * 页面里的 mousedown 永远不会触发。所以那个"中键解锁"在锁定状态下根本不可能跑到。
 *
 * Mineradio 的解法就是起一个 PowerShell 循环读 GetAsyncKeyState(4)（4 = 中键），
 * 我在它 desktop/main.js 的 startDesktopLyricsMousePoller 里见过，
 * 当时判定"多余" —— 判断错了，它就是为这个场景存在的。
 *
 * 用 -EncodedCommand（base64/UTF-16LE）传脚本：
 * 直接把多行 PowerShell 塞进参数会被引号规则吃掉（这个坑我在本项目的
 * tools/repl-send.mjs 上已经踩过一次），编码传参完全绕开它。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const mainFile = path.join(root, 'apps', 'desktop', 'main.js');
const log = (m) => console.log(m);
const readNorm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const writeNorm = (p, t) => fs.writeFileSync(p, t.replace(/\n/g, '\r\n'));

let t = readNorm(mainFile);
if (t.includes('startMiddleClickWatcher')) {
  log('已存在，跳过');
  process.exit(0);
}

// ---------- ① require child_process ----------
if (!t.includes("require('node:child_process')")) {
  t = t.replace(
    `const fs = require('node:fs');`,
    `const fs = require('node:fs');
const { spawn } = require('node:child_process');`
  );
  log('ok: 引入 child_process');
}

// ---------- ② 监听器 ----------
const block = String.raw`
/* ------------------------------------------------------------------ */
/* 中键全局监听（用于锁定状态下也能解锁）                              */
/* ------------------------------------------------------------------ */

let middleClickProc = null;

/*
 * 这段 PowerShell 只做一件事：把每次"中键按下"作为一行 MMB 打到 stdout。
 * 边沿检测（$down -and -not $prev）放在子进程里做 —— 主进程只要收事件，
 * 不用自己记上一次的状态，逻辑少一层。
 *
 * 40ms 轮询：手感上察觉不到延迟，CPU 占用可以忽略。
 */
const MIDDLE_CLICK_PS = [
  '\Continue = "SilentlyContinue"',
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class MRMiddle {',
  '  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);',
  '}',
  '"@',
  '\ = \False',
  'while (\True) {',
  '  \ = (([MRMiddle]::GetAsyncKeyState(4) -band 0x8000) -ne 0)',
  '  if (\ -and -not \) { [Console]::Out.WriteLine("MMB"); [Console]::Out.Flush() }',
  '  \ = \',
  '  Start-Sleep -Milliseconds 40',
  '}',
  '',
].join('\n');

/**
 * 收到一次中键点击。
 *
 * 只在光标位于歌词文字范围内时生效 —— 全局中键属于所有程序，
 * 不设这个前提的话，用户在浏览器里按中键（自动滚动）也会把歌词锁掉。
 */
function onGlobalMiddleClick() {
  if (!lyricWindow || lyricWindow.isDestroyed() || !lyricWindow.isVisible()) return;
  const hot = lyricHotBoundsOnScreen();
  const p = screen.getCursorScreenPoint();
  if (hot) {
    const inside = p.x >= hot.x && p.x <= hot.x + hot.width && p.y >= hot.y && p.y <= hot.y + hot.height;
    if (!inside) return;
  }
  lyricLocked = !lyricLocked;
  applyLyricLock();
  console.log('[桌面歌词] 中键 →', lyricLocked ? '已锁定' : '已解锁');
}

function startMiddleClickWatcher() {
  if (process.platform !== 'win32' || middleClickProc) return;
  try {
    /*
     * -EncodedCommand 收的是 UTF-16LE 的 base64。
     * 不用 -Command "..."：多行脚本里的引号和换行会被参数解析吃掉。
     */
    const encoded = Buffer.from(MIDDLE_CLICK_PS, 'utf16le').toString('base64');
    middleClickProc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    let buf = '';
    middleClickProc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === 'MMB') onGlobalMiddleClick();
      }
    });
    middleClickProc.on('error', (e) => {
      // 起不来不该影响播放器本身，留一条痕迹就够了
      console.warn('[桌面歌词] 中键监听启动失败：', (e && e.message) || e);
      middleClickProc = null;
    });
    middleClickProc.on('exit', () => {
      middleClickProc = null;
    });
    console.log('[桌面歌词] 中键监听已启动');
  } catch (e) {
    console.warn('[桌面歌词] 中键监听异常：', (e && e.message) || e);
    middleClickProc = null;
  }
}

function stopMiddleClickWatcher() {
  if (middleClickProc) {
    try {
      middleClickProc.kill();
    } catch {}
    middleClickProc = null;
  }
}

`;

const anchor = 'function createLyricWindow() {';
if (t.includes(anchor)) {
  t = t.replace(anchor, block.trimStart() + anchor);
  log('ok: 中键监听模块');
} else {
  log('!! 没找到 createLyricWindow');
}

// ---------- ③ 开关窗口时启停监听 ----------
t = t.replace(
  `    lyricWindow.showInactive(); // 不抢焦点`,
  `    lyricWindow.showInactive(); // 不抢焦点
    startMiddleClickWatcher();`
);
t = t.replace(
  `    lyricWindow.hide();
    stopLyricMousePoller();`,
  `    lyricWindow.hide();
    stopLyricMousePoller();
    stopMiddleClickWatcher();`
);
// 应用退出时收掉子进程，否则会留一个孤立的 powershell
t = t.replace(
  `app.on('before-quit'`,
  `app.on('will-quit', () => stopMiddleClickWatcher());
app.on('before-quit'`
);

writeNorm(mainFile, t);
console.log('done');