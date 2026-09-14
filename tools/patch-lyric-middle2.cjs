/*
 * 中键监听改成**写文件**，不用管道；并删掉锁按钮 / 全局热键。
 *
 * 用户反馈两件事：
 *   ① 中键按一下锁上了，再按一下解不开
 *   ② 软件里的「锁」按钮和全局热键 Alt+K 都删掉，只留中键
 *
 * ① 的根因从日志看得很清楚：主进程**一次中键都没收到**
 *   （只有"[桌面歌词] 中键监听已启动"，没有一条"中键 →"）。
 *   PowerShell 进程是活的，所以问题出在**通道**上：
 *   本项目的环境说明里写过 —— 沙箱下程序不能开命名管道，
 *   child_process.spawn 用 stdio:'pipe' 抓输出会失败。
 *   spawn 自己成功了（所以 error 回调没触发），但输出到不了主进程。
 *
 *   → 改成**子进程写文件、主进程轮询文件大小**，完全不经过管道。
 *     每 80ms 读一次文件大小，几乎不花钱，而且对各种沙箱都稳。
 *
 * ② 直接删掉：锁按钮（index.html 里的元素 + main.js 里的逻辑）、
 *   热键表里的 lyriclock 条目和它的分发分支。
 *   用户明确要"只用鼠标中间"，多留入口反而容易互相干扰。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const mainFile = path.join(root, 'apps', 'desktop', 'main.js');
const htmlFile = path.join(root, 'apps', 'ui', 'index.html');
const uiFile = path.join(root, 'apps', 'ui', 'src', 'main.js');
const log = (m) => console.log(m);
const readNorm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const writeNorm = (p, t) => fs.writeFileSync(p, t.replace(/\n/g, '\r\n'));

// ---------- ① 中键监听：改成写文件 ----------
{
  let t = readNorm(mainFile);

  // 1.1 PowerShell 脚本改成写文件
  const oldPs = t.slice(t.indexOf('const MIDDLE_CLICK_PS = ['), t.indexOf(".join('\\n');") + ".join('\\n');".length);
  const newPs = [
    "const MIDDLE_CLICK_PS = [",
    "  '$ErrorActionPreference = \"SilentlyContinue\"',",
    "  'Add-Type @\"',",
    "  'using System;',",
    "  'using System.Runtime.InteropServices;',",
    "  'public class MRMiddle {',",
    "  '  [DllImport(\"user32.dll\")] public static extern short GetAsyncKeyState(int vKey);',",
    "  '}',",
    "  '\"@',",
    "  // 信号文件：只往里追加字节，主进程轮询它的大小",
    "  '$path = $env:MR_MIDDLE_SIGNAL',",
    "  '$prev = $false',",
    "  'while ($true) {',",
    "  '  $down = (([MRMiddle]::GetAsyncKeyState(4) -band 0x8000) -ne 0)',",
    "  '  if ($down -and -not $prev) {',",
    "  '    try { Add-Content -LiteralPath $path -Value \"x\" -NoNewline -Encoding ascii } catch {}',",
    "  '  }',",
    "  '  $prev = $down',",
    "  '  Start-Sleep -Milliseconds 40',",
    "  '}',",
    "].join('\\n');",
  ].join('\n');
  if (oldPs && t.includes(oldPs)) {
    t = t.replace(oldPs, newPs);
    log('ok: PS 脚本改写文件');
  } else {
    log('!! 没定位到 MIDDLE_CLICK_PS');
  }

  // 1.2 启动/轮询逻辑
  const oldStart = t.slice(t.indexOf('function startMiddleClickWatcher() {'), t.indexOf('function stopMiddleClickWatcher() {'));
  const newStart = [
    'function startMiddleClickWatcher() {',
    '  if (process.platform !== \'win32\' || middleClickProc) return;',
    '  try {',
    '    /*',
    '     * 信号文件放在 userData 下。',
    '     * 为什么不用 stdout 管道：沙箱下 spawn 的 pipe 抓不到子进程输出',
    '     *（本项目环境说明里写明了这条），而 spawn 本身会成功、也不报错，',
    '     * 表现就是"监听明明起来了，却一个事件都收不到"。',
    '     */',
    '    middleSignalPath = path.join(app.getPath(\'userData\'), \'middle-click.signal\');',
    '    try {',
    '      fs.writeFileSync(middleSignalPath, \'\');',
    '    } catch {}',
    '    middleSignalSize = 0;',
    '',
    '    const encoded = Buffer.from(MIDDLE_CLICK_PS, \'utf16le\').toString(\'base64\');',
    '    middleClickProc = spawn(',
    '      \'powershell.exe\',',
    '      [\'-NoProfile\', \'-NonInteractive\', \'-ExecutionPolicy\', \'Bypass\', \'-EncodedCommand\', encoded],',
    '      {',
    '        windowsHide: true,',
    '        /* 不抓输出：stdout 丢掉，只靠信号文件通信 */',
    '        stdio: \'ignore\',',
    '        env: { ...process.env, MR_MIDDLE_SIGNAL: middleSignalPath },',
    '      }',
    '    );',
    '    middleClickProc.on(\'error\', (e) => {',
    '      console.warn(\'[桌面歌词] 中键监听启动失败：\', (e && e.message) || e);',
    '      middleClickProc = null;',
    '    });',
    '    middleClickProc.on(\'exit\', () => {',
    '      middleClickProc = null;',
    '    });',
    '',
    '    /*',
    '     * 轮询信号文件的大小。',
    '     * 只比大小、不读内容 —— 每按一次中键文件长 1 字节，',
    '     * 大小变了就是"按了一次"，简单且不会漏（不需要解析内容）。',
    '     */',
    '    middleSignalTimer = setInterval(() => {',
    '      if (!middleSignalPath) return;',
    '      try {',
    '        const size = fs.statSync(middleSignalPath).size;',
    '        if (size > middleSignalSize) {',
    '          const times = size - middleSignalSize;',
    '          middleSignalSize = size;',
    '          // 连按只算一次，避免手抖多切几次',
    '          onGlobalMiddleClick(times);',
    '        } else if (size < middleSignalSize) {',
    '          middleSignalSize = size; // 文件被重建过',
    '        }',
    '      } catch {}',
    '    }, 80);',
    '    console.log(\'[桌面歌词] 中键监听已启动\');',
    '  } catch (e) {',
    '    console.warn(\'[桌面歌词] 中键监听异常：\', (e && e.message) || e);',
    '    middleClickProc = null;',
    '  }',
    '}',
    '',
  ].join('\n');
  if (oldStart && t.includes(oldStart)) {
    t = t.replace(oldStart, newStart);
    log('ok: 启动/轮询逻辑');
  } else {
    log('!! 没定位到 startMiddleClickWatcher');
  }

  // 1.3 停止时一并清掉定时器
  t = t.replace(
    `function stopMiddleClickWatcher() {
  if (middleClickProc) {`,
    `function stopMiddleClickWatcher() {
  if (middleSignalTimer) {
    clearInterval(middleSignalTimer);
    middleSignalTimer = null;
  }
  if (middleClickProc) {`
  );

  // 1.4 状态变量
  t = t.replace(
    `let middleClickProc = null;`,
    `let middleClickProc = null;
/** 中键信号文件路径（子进程往里追加字节，我们轮询它的大小） */
let middleSignalPath = null;
let middleSignalSize = 0;
let middleSignalTimer = null;`
  );

  // 1.5 日志加一行，方便以后一眼看出"到底收到没有"
  t = t.replace(
    `  lyricLocked = !lyricLocked;
  applyLyricLock();
  console.log('[桌面歌词] 中键 →', lyricLocked ? '已锁定' : '已解锁');`,
    `  lyricLocked = !lyricLocked;
  applyLyricLock();
  console.log('[桌面歌词] 中键 →', lyricLocked ? '已锁定' : '已解锁');
  if (lyricWindow && !lyricWindow.isDestroyed()) {
    lyricWindow.webContents.send('lyric:lock', lyricLocked);
  }`
  );

  writeNorm(mainFile, t);
}

// ---------- ② 删掉锁按钮和热键 ----------
{
  // 2.1 index.html 去掉按钮
  let h = readNorm(htmlFile);
  const btn = `        <button id="lyriclock-chip" class="chip" title="锁定桌面歌词（点不动、鼠标穿过去）· Alt+K">锁</button>\n`;
  if (h.includes(btn)) {
    h = h.replace(btn, '');
    writeNorm(htmlFile, h);
    log('ok: 删锁按钮');
  } else {
    log('!! 锁按钮没找到');
  }

  // 2.2 main.js 去掉逻辑 + 热键
  let u = readNorm(uiFile);
  const lockBlock = u.slice(u.indexOf('/* ---- 锁定按钮 ---- */'), u.indexOf("setInterval(() => void syncLyricLockChip(), 1500);") + "setInterval(() => void syncLyricLockChip(), 1500);".length);
  if (lockBlock && u.includes(lockBlock)) {
    u = u.replace(lockBlock, '');
    log('ok: 删锁逻辑');
  }
  u = u.replace(
    `  // Alt+K：锁/解锁桌面歌词。锁上之后窗口收不到鼠标事件，热键是唯一稳定的出口\n  { id: 'lyriclock', label: '桌面歌词锁定', def: 'Alt+K' },\n`,
    ''
  );
  u = u.replace(
    `    case 'lyriclock':
      void toggleLyricLock();
      break;
`,
    ''
  );
  writeNorm(uiFile, u);
  log('ok: 删热键');
}

console.log('done');
