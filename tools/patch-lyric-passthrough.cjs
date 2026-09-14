/*
 * 按 Mineradio 的思路重做桌面歌词的"不挡鼠标"。
 *
 * ★ 我之前的方向错了：我去**把窗口缩到文字大小**，结果一路踩坑 ——
 *   量到容器宽度（2395px）、量出来比实际渲染小（字体被系统放大）、
 *   最后还把文件写坏了。
 *
 * 学 Mineradio（desktop/main.js:3593 applyDesktopLyricsMouseBehavior）：
 *   · 窗口是**一块固定的大区域**，够装长句，永远不会裁字
 *   · 渲染进程量出**文字的实际范围**（hotBounds）报给主进程
 *   · 主进程轮询鼠标：光标在文字上 → 捕获；不在文字上 → **穿透**
 *
 * 于是"透明区域挡鼠标"这个问题**根本不存在** —— 不需要缩窗口。
 *
 * 比 Mineradio 简单的一点：它为了检测中键，起了一个 PowerShell 子进程
 * 去调 GetAsyncKeyState（见 3638 行）。我们只需要"光标在不在文字上"，
 * Electron 自带 screen.getCursorScreenPoint()，一个定时器就够，
 * 不用额外进程。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const mainFile = path.join(root, 'apps', 'desktop', 'main.js');
const preloadFile = path.join(root, 'apps', 'desktop', 'preload.js');
const log = (m) => console.log(m);
const readNorm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const writeNorm = (p, t) => fs.writeFileSync(p, t.replace(/\n/g, '\r\n'));

// ---------- ① 主进程：固定舒适尺寸 + 热点轮询 ----------
{
  let t = readNorm(mainFile);

  // 1.1 窗口尺寸改成"够装长句的固定区域"
  t = t.replace(
    `const LYRIC_W = 880;
const LYRIC_H = 132;`,
    `/*
 * 窗口是一块**固定的大区域**，不是"贴合文字"的小框。
 *
 * 学自 Mineradio（desktop/main.js:3544）：它按屏幕比例取
 * min(max(880, 屏宽*0.72), 屏宽-96)。固定大小的好处是
 * **长句永远不会被裁** —— 而"贴合文字"那条路我走过，
 * 量不准（系统文本缩放会让实际渲染比测量值大），最后把文件都写坏了。
 *
 * 至于"大框会挡鼠标"：那不是靠尺寸解决的，靠下面的动态穿透。
 */
const LYRIC_W = 900;
const LYRIC_H = 190;`
  );

  // 1.2 热点：渲染进程报来的"文字实际范围"，相对窗口左上角
  if (!t.includes('lyricHotBounds')) {
    t = t.replace(
      `let lyricWindow = null;`,
      `let lyricWindow = null;
/** 文字在窗口内的实际范围（由歌词窗口量好报上来），null 表示整窗都算热点 */
let lyricHotBounds = null;
/** 当前是否处于"整窗穿透"状态，避免重复调 setIgnoreMouseEvents */
let lyricMouseIgnored = null;
/** 用户手动锁定的穿透（锁定后无论光标在哪都穿透） */
let lyricHardLock = false;
let lyricMousePoller = null;`
    );
    log('ok: 热点状态变量');
  }

  // 1.3 轮询 + 应用穿透
  if (!t.includes('function applyLyricMouseBehavior')) {
    const anchor = `function createLyricWindow() {`;
    const block = `/**
 * 把"文字热点"换算成屏幕坐标。
 * 热点由歌词窗口量出（相对窗口左上角），这里加上窗口位置。
 */
function lyricHotBoundsOnScreen() {
  if (!lyricWindow || lyricWindow.isDestroyed()) return null;
  const wb = lyricWindow.getBounds();
  const rel = lyricHotBounds;
  if (!rel) return null;
  return {
    x: wb.x + rel.left,
    y: wb.y + rel.top,
    width: Math.max(1, rel.right - rel.left),
    height: Math.max(1, rel.bottom - rel.top),
  };
}

/**
 * 按光标位置决定要不要穿透。
 *
 * 这就是 Mineradio 的做法（main.js:3593）：
 *   锁定了        → 一直穿透
 *   光标在文字上  → 不穿透（可以拖、可以双击）
 *   光标不在文字上 → 穿透，鼠标照常点到底下的窗口
 *
 * 于是"窗口里那些透明的地方"不会挡任何东西 ——
 * 不需要为了不挡鼠标去把窗口缩小，也就不会裁到长句。
 */
function applyLyricMouseBehavior() {
  if (!lyricWindow || lyricWindow.isDestroyed()) return;
  let shouldIgnore = true;
  if (!lyricHardLock) {
    const hot = lyricHotBoundsOnScreen();
    if (hot) {
      const p = screen.getCursorScreenPoint();
      const inside =
        p.x >= hot.x && p.x <= hot.x + hot.width && p.y >= hot.y && p.y <= hot.y + hot.height;
      shouldIgnore = !inside;
    } else {
      // 还没量到热点时，整窗都算可交互（否则用户一开始就拖不动它）
      shouldIgnore = false;
    }
  }
  if (lyricMouseIgnored === shouldIgnore) return;
  lyricMouseIgnored = shouldIgnore;
  // forward: true —— 穿透时事件要转给下层窗口，不然用户点桌面也没反应
  lyricWindow.setIgnoreMouseEvents(shouldIgnore, { forward: true });
}

function startLyricMousePoller() {
  if (lyricMousePoller) return;
  /*
   * 80ms 一次。这个频率下用户感觉不到延迟，而 CPU 开销可以忽略
   *（getCursorScreenPoint 是一次轻量的系统调用，不像 Mineradio 那样要
   * 为检测中键另起一个进程）。
   */
  lyricMousePoller = setInterval(applyLyricMouseBehavior, 80);
}

function stopLyricMousePoller() {
  if (lyricMousePoller) {
    clearInterval(lyricMousePoller);
    lyricMousePoller = null;
  }
}

${anchor}`;
    t = t.replace(anchor, block);
    log('ok: 穿透逻辑');
  }

  // 1.4 窗口创建/关闭时启停轮询
  t = t.replace(
    `  lyricWindow.on('move', scheduleSaveLyricBounds);`,
    `  lyricWindow.on('move', () => {
    scheduleSaveLyricBounds();
    // 窗口一挪，热点的屏幕坐标就变了，立刻重算一次
    applyLyricMouseBehavior();
  });
  startLyricMousePoller();`
  );
  t = t.replace(
    `  lyricWindow.on('closed', () => {
    lyricWindow = null;
  });`,
    `  lyricWindow.on('closed', () => {
    lyricWindow = null;
    stopLyricMousePoller();
    lyricMouseIgnored = null;
  });`
  );
  // 显示时也要重算
  t = t.replace(
    `    if (!lyricWindow.isDestroyed()) lyricWindow.showInactive(); // 不抢焦点`,
    `    if (!lyricWindow.isDestroyed()) {
      lyricWindow.showInactive(); // 不抢焦点
      // 刚显示时状态是未知的，清掉缓存强制重算一次
      lyricMouseIgnored = null;
      applyLyricMouseBehavior();
    }`
  );
  t = t.replace(
    `  } else if (lyricWindow && !lyricWindow.isDestroyed()) {
    lyricWindow.hide();
  }`,
    `  } else if (lyricWindow && !lyricWindow.isDestroyed()) {
    lyricWindow.hide();
    stopLyricMousePoller();
  }`
  );

  // 1.5 锁定状态改用硬锁
  t = t.replace(
    `function applyLyricLock() {
  if (!lyricWindow || lyricWindow.isDestroyed()) return;
  /*
   * setIgnoreMouseEvents(true) 之后窗口完全不收鼠标事件 ——
   * 连"双击解锁"都收不到，所以必须有别的入口（主界面按钮 / 托盘菜单）。
   * forward:true 让事件仍能转发给下层窗口，桌面歌词压在浏览器上时
   * 用户还能正常点浏览器。
   */
  lyricWindow.setIgnoreMouseEvents(lyricLocked, { forward: true });
  lyricWindow.webContents.send('lyric:lock', lyricLocked);
}`,
    `function applyLyricLock() {
  if (!lyricWindow || lyricWindow.isDestroyed()) return;
  /*
   * 锁定 = **硬锁**：无论光标在哪都穿透。
   *（不锁的时候是"光标在文字上就不穿透"，见 applyLyricMouseBehavior。）
   *
   * 锁定之后窗口收不到任何鼠标事件，连"双击解锁"都收不到 ——
   * 所以主界面上的「词」按钮是必须的第二个入口。
   */
  lyricHardLock = lyricLocked;
  lyricMouseIgnored = null; // 清掉缓存，强制重算
  applyLyricMouseBehavior();
  lyricWindow.webContents.send('lyric:lock', lyricLocked);
}`
  );

  // 1.6 resize IPC 改成"接收热点"，不再改窗口尺寸
  const oldResize = t.slice(t.indexOf("  ipcMain.handle('lyric:resize'"), t.indexOf("  ipcMain.handle('lyric:visible'"));
  const newResize = `  /*
   * 接收"文字的实际范围"（相对窗口左上角）。
   *
   * ★ 注意这里**不改窗口尺寸** —— 窗口是固定的。
   * 这个矩形只用来判断"光标是不是在歌词上"，从而决定要不要穿透。
   * 我原来在这里 setBounds 把窗口贴合文字，方向是错的：
   * 量不准会裁字，而且越量越乱。学 Mineradio 之后这条路就不需要了。
   */
  ipcMain.handle('lyric:hotBounds', (_e, rect) => {
    if (!rect || !Number.isFinite(rect.left)) return false;
    lyricHotBounds = {
      left: Number(rect.left) || 0,
      top: Number(rect.top) || 0,
      right: Number(rect.right) || 0,
      bottom: Number(rect.bottom) || 0,
    };
    lyricMouseIgnored = null; // 热点变了要立刻重算
    applyLyricMouseBehavior();
    return true;
  });

`;
  if (oldResize.includes("'lyric:resize'")) {
    t = t.replace(oldResize, newResize);
    log('ok: resize → hotBounds');
  } else {
    log('!! 没找到 lyric:resize 那段');
  }

  writeNorm(mainFile, t);
}

// ---------- ② preload ----------
{
  let t = readNorm(preloadFile);
  t = t.replace(
    `    /** 歌词窗口量完文字尺寸后报给主进程，让窗口贴合文字 */
    resize: (size) => ipcRenderer.invoke('lyric:resize', size),`,
    `    /** 歌词窗口量完"文字实际范围"后报给主进程，用来决定要不要穿透 */
    hotBounds: (rect) => ipcRenderer.invoke('lyric:hotBounds', rect),`
  );
  writeNorm(preloadFile, t);
  log('ok: preload hotBounds');
}

console.log('done');
