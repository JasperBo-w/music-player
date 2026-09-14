/*
 * 桌面歌词：独立置顶透明窗口。
 *
 * 设计要点（都是"不做就会难用"的地方）：
 *   · transparent + frame:false + skipTaskbar —— 它是一块浮在桌面上的字，
 *     不是第二个应用窗口，不该在任务栏里出现
 *   · alwaysOnTop('screen-saver') —— 用普通 'normal' 会被很多窗口盖住；
 *     'screen-saver' 是最高层级，桌面歌词要的就是"一直在最上面"
 *   · 位置单独存（和主窗口分开存），并且同样要过显示器校验
 *   · 双击穿透：压着别的窗口时，点到它就成了点它 —— 穿透之后
 *     又没法双击回来，所以**必须有第二个入口**（这里是主界面的按钮）
 *
 * 歌词数据的流向：渲染进程（主界面）算好当前行 → IPC 到主进程 →
 * 转发给歌词窗口。**主进程不做歌词解析** —— 解析逻辑在渲染进程里
 * （它才有歌词数据），主进程只当管道。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const mainFile = path.join(root, 'apps', 'desktop', 'main.js');
const preloadFile = path.join(root, 'apps', 'desktop', 'preload.js');
const log = (m) => console.log(m);

// ---------- ① 主进程：歌词窗口 ----------
{
  let t = fs.readFileSync(mainFile, 'utf8');
  if (t.includes('function createLyricWindow')) {
    log('主进程：已存在');
  } else {
    const block = String.raw`
/* ------------------------------------------------------------------ */
/* 桌面歌词（独立置顶窗口）                                            */
/* ------------------------------------------------------------------ */

const LYRIC_STATE_FILE = () => path.join(app.getPath('userData'), 'lyric-window.json');
const LYRIC_W = 880;
const LYRIC_H = 132;

let lyricWindow = null;
/** 鼠标穿透（锁定）状态。穿透后窗口不再接收任何鼠标事件。 */
let lyricLocked = false;

function loadLyricBounds() {
  let s = null;
  try {
    s = JSON.parse(fs.readFileSync(LYRIC_STATE_FILE(), 'utf8'));
  } catch {
    return null;
  }
  if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y)) return null;
  // 和主窗口一样的道理：显示器可能被拔掉，旧坐标要验一遍
  try {
    const ok = screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return s.x < b.x + b.width && s.x + LYRIC_W > b.x && s.y < b.y + b.height && s.y + LYRIC_H > b.y;
    });
    if (!ok) return null;
  } catch {
    return null;
  }
  return { x: Math.round(s.x), y: Math.round(s.y) };
}

/** 没存过位置时：屏幕底部居中、离任务栏一点距离 —— 这是桌面歌词最常见的位置 */
function defaultLyricBounds() {
  try {
    const b = screen.getPrimaryDisplay().workArea;
    return { x: Math.round(b.x + (b.width - LYRIC_W) / 2), y: Math.round(b.y + b.height - LYRIC_H - 56) };
  } catch {
    return { x: 200, y: 600 };
  }
}

let lyricSaveTimer = null;
function scheduleSaveLyricBounds() {
  if (lyricSaveTimer) clearTimeout(lyricSaveTimer);
  lyricSaveTimer = setTimeout(() => {
    if (!lyricWindow || lyricWindow.isDestroyed()) return;
    try {
      fs.writeFileSync(LYRIC_STATE_FILE(), JSON.stringify(lyricWindow.getBounds()));
    } catch (e) {
      console.warn('[桌面歌词] 位置存不下来：', (e && e.message) || e);
    }
  }, 400);
}

/** 把穿透状态同时应用到窗口和页面（页面要显示"已锁定"提示） */
function applyLyricLock() {
  if (!lyricWindow || lyricWindow.isDestroyed()) return;
  /*
   * setIgnoreMouseEvents(true) 之后窗口完全不收鼠标事件 ——
   * 连"双击解锁"都收不到，所以必须有别的入口（主界面按钮 / 托盘菜单）。
   * forward:true 让事件仍能转发给下层窗口，桌面歌词压在浏览器上时
   * 用户还能正常点浏览器。
   */
  lyricWindow.setIgnoreMouseEvents(lyricLocked, { forward: true });
  lyricWindow.webContents.send('lyric:lock', lyricLocked);
}

function createLyricWindow() {
  if (lyricWindow && !lyricWindow.isDestroyed()) return lyricWindow;
  const b = loadLyricBounds() || defaultLyricBounds();

  lyricWindow = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: LYRIC_W,
    height: LYRIC_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    /* 不要 show:false + ready-to-show —— 那会在启动瞬间闪一下白底 */
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  lyricWindow.setAlwaysOnTop(true, 'screen-saver');
  lyricWindow.setVisibleOnAllWorkspaces(true);

  const url = isDev ? DEV_URL.replace(/index\.html.*$/, '') + 'lyric.html' : 'app://bundle/lyric.html';
  void lyricWindow.loadURL(url);

  lyricWindow.on('move', scheduleSaveLyricBounds);
  lyricWindow.on('closed', () => {
    lyricWindow = null;
  });
  console.log('[桌面歌词] 窗口已创建');
  return lyricWindow;
}

function showLyricWindow(on) {
  if (on) {
    createLyricWindow();
    if (!lyricWindow.isDestroyed()) lyricWindow.showInactive(); // 不抢焦点
  } else if (lyricWindow && !lyricWindow.isDestroyed()) {
    lyricWindow.hide();
  }
  return !!on;
}

/** 主界面推来的歌词/歌名 —— 原样转发给歌词窗口，主进程不解析 */
function pushLyric(payload) {
  if (!lyricWindow || lyricWindow.isDestroyed()) return;
  lyricWindow.webContents.send('lyric:update', payload || {});
}

`;
    const anchor = 'function createWindow() {';
    if (t.includes(anchor)) {
      t = t.replace(anchor, block.trimStart() + anchor);
      log('ok: 主进程歌词窗口模块');
    } else {
      log('!! 未找到 createWindow');
    }

    // IPC
    const ipc = String.raw`
  /* ---- 桌面歌词 ---- */
  ipcMain.handle('lyric:toggle', (_e, on) => showLyricWindow(on));
  ipcMain.handle('lyric:push', (_e, payload) => {
    pushLyric(payload);
    return true;
  });
  ipcMain.handle('lyric:toggleLock', () => {
    lyricLocked = !lyricLocked;
    applyLyricLock();
    return lyricLocked;
  });
  ipcMain.handle('lyric:setLock', (_e, on) => {
    lyricLocked = !!on;
    applyLyricLock();
    return lyricLocked;
  });
  ipcMain.handle('lyric:visible', () => !!(lyricWindow && !lyricWindow.isDestroyed() && lyricWindow.isVisible()));

`;
    const ipcAnchor = "  ipcMain.handle('hotkeys:list'";
    if (t.includes(ipcAnchor)) {
      t = t.replace(ipcAnchor, ipc + ipcAnchor);
      log('ok: 歌词 IPC');
    } else {
      log('!! 未找到 IPC 插入点');
    }

    fs.writeFileSync(mainFile, t);
  }
}

// ---------- ② preload ----------
{
  let t = fs.readFileSync(preloadFile, 'utf8');
  if (t.includes('desktopLyric')) {
    log('preload：已存在');
  } else {
    t = t.replace(
      `  /** 无边框窗口控制 */`,
      `  /** 桌面歌词 */
  desktopLyric: {
    toggle: (on) => ipcRenderer.invoke('lyric:toggle', on),
    visible: () => ipcRenderer.invoke('lyric:visible'),
    /** 主界面把算好的歌词行推过去 */
    push: (payload) => ipcRenderer.invoke('lyric:push', payload),
    toggleLock: () => ipcRenderer.invoke('lyric:toggleLock'),
    setLock: (on) => ipcRenderer.invoke('lyric:setLock', on),
    /** 歌词窗口自己订阅（只有 lyric.html 用） */
    onUpdate: (cb) => {
      const fn = (_e, p) => cb(p);
      ipcRenderer.on('lyric:update', fn);
      return () => ipcRenderer.removeListener('lyric:update', fn);
    },
    onLock: (cb) => {
      const fn = (_e, v) => cb(v);
      ipcRenderer.on('lyric:lock', fn);
      return () => ipcRenderer.removeListener('lyric:lock', fn);
    },
  },

  /** 无边框窗口控制 */`
    );
    fs.writeFileSync(preloadFile, t);
    log('ok: preload desktopLyric');
  }
}

console.log('done');
