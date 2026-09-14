/*
 * 单实例 + 窗口位置记忆。
 *
 * 两件都是"像正经软件"的基础件，各十几行，但缺了很显眼：
 *   · 没有单实例 → 双击图标就多开一个，两个实例抢同一个 session 文件，
 *     托盘里也会出现两个图标
 *   · 没有位置记忆 → 每次开都回到屏幕正中，用户挪到副屏的窗口下次又跑回来
 *
 * 位置记忆里**最容易漏的是校验**：用户可能拔掉显示器、改分辨率，
 * 存下来的坐标落在一块已经不存在的屏幕上 —— 窗口就"打不开"了
 *（其实开着，只是画在看不见的地方）。所以恢复前必须拿当前显示器列表验一遍。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const f = path.join(root, 'apps', 'desktop', 'main.js');
let t = fs.readFileSync(f, 'utf8');
const log = (m) => console.log(m);

// ---------- ① require 里补 screen ----------
if (!t.includes('  screen,\n} = require')) {
  t = t.replace(/\n\} = require\('electron'\);/, '\n  screen,\n} = require(\'electron\');');
  log(t.includes('  screen,') ? 'ok: 补 screen' : '!! screen 没补上');
}

// ---------- ② 窗口状态模块，插在 createWindow 之前 ----------
if (t.includes('function loadWindowState')) {
  log('窗口状态模块已存在');
} else {
  const block = String.raw`
/* ------------------------------------------------------------------ */
/* 窗口位置记忆                                                        */
/* ------------------------------------------------------------------ */

const WINDOW_STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');

/**
 * 读回上次的窗口位置。
 *
 * ★ 坐标必须拿**当前显示器列表**验一遍才能用。
 * 用户可能拔了显示器 / 改了分辨率，旧坐标会落在已经不存在的屏幕上 ——
 * 那种情况下窗口其实是开着的，只是画在看不见的地方，用户看到的是"打不开"。
 * 尺寸可以保留（任何屏幕都放得下），位置要丢掉、让它回到默认居中。
 */
function loadWindowState() {
  let s = null;
  try {
    s = JSON.parse(fs.readFileSync(WINDOW_STATE_FILE(), 'utf8'));
  } catch {
    return null;
  }
  if (!s || !Number.isFinite(s.width) || !Number.isFinite(s.height)) return null;

  const w = Math.max(860, Math.round(s.width));
  const h = Math.max(560, Math.round(s.height));
  if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) return { width: w, height: h };

  let visible = false;
  try {
    // screen 只能在 app ready 之后用，而 createWindow 就是在 ready 里调的
    visible = screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return s.x < b.x + b.width && s.x + w > b.x && s.y < b.y + b.height && s.y + h > b.y;
    });
  } catch {
    visible = false;
  }
  return visible ? { x: Math.round(s.x), y: Math.round(s.y), width: w, height: h } : { width: w, height: h };
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    /*
     * 最大化时 getBounds 给的是最大化后的框 —— 直接存下来，
     * 下次恢复会变成一个"铺满屏幕的普通窗口"而不是最大化的窗口。
     * 所以要分开记：普通状态存 getNormalBounds，另外记一个 maximized。
     */
    const b = mainWindow.isMaximized() || mainWindow.isFullScreen()
      ? mainWindow.getNormalBounds()
      : mainWindow.getBounds();
    fs.writeFileSync(
      WINDOW_STATE_FILE(),
      JSON.stringify({ ...b, maximized: mainWindow.isMaximized() })
    );
  } catch {
    /* 写不进去（磁盘满 / 权限）不该影响使用，静默即可 */
  }
}

/** 拖动 / 缩放时不要每帧都写盘 —— 节流到停下来 400ms 之后写一次 */
let windowStateTimer = null;
function scheduleSaveWindowState() {
  if (windowStateTimer) clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(saveWindowState, 400);
}

`;
  const anchor = 'function createWindow() {';
  if (t.includes(anchor)) {
    t = t.replace(anchor, block.trimStart() + anchor);
    log('ok: 窗口状态模块');
  } else {
    log('!! 未找到 createWindow');
  }
}

// ---------- ③ 用存下来的位置建窗口 ----------
const oldWin = `  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 860,
    minHeight: 560,`;
const newWin = `  const savedState = loadWindowState();
  mainWindow = new BrowserWindow({
    // 没存过就用默认尺寸；存过就回到上次的位置和大小
    ...(savedState || { width: 1240, height: 800 }),
    minWidth: 860,
    minHeight: 560,`;
if (t.includes(oldWin)) {
  t = t.replace(oldWin, newWin);
  log('ok: 用存下来的位置建窗口');
} else {
  log('!! 未匹配 BrowserWindow 参数');
}

// ---------- ④ 挂上保存监听 + 恢复最大化 ----------
const oldReady = `  mainWindow.once('ready-to-show', () => mainWindow.show());`;
const newReady = `  // 最大化状态要单独恢复（见 saveWindowState 里的说明）
  if (savedState && savedState.maximized) mainWindow.maximize();
  /*
   * 拖动和缩放分别监听：Windows 上拖窗口只触发 move、拉边框只触发 resize，
   * 两个都挂才能覆盖全。节流在 scheduleSaveWindowState 里做。
   */
  mainWindow.on('resize', scheduleSaveWindowState);
  mainWindow.on('move', scheduleSaveWindowState);
  mainWindow.on('close', saveWindowState);

  mainWindow.once('ready-to-show', () => mainWindow.show());`;
if (t.includes(oldReady)) {
  t = t.replace(oldReady, newReady);
  log('ok: 保存监听 + 恢复最大化');
} else {
  log('!! 未匹配 ready-to-show');
}

// ---------- ⑤ 单实例锁 ----------
if (t.includes('requestSingleInstanceLock')) {
  log('单实例锁已存在');
} else {
  /*
   * 必须放在**建窗口之前**，而且要在 app.whenReady 之前拿到锁。
   * 拿不到锁说明已经有一个实例在跑 —— 直接退出，并让那个实例把窗口亮出来。
   */
  const lock = String.raw`
/* ------------------------------------------------------------------ */
/* 单实例                                                              */
/* ------------------------------------------------------------------ */

/*
 * 为什么必须有：没有它，双击图标就多开一个 ——
 * 两个实例会**抢同一个 session 文件**（登录态可能被写坏），
 * 托盘里还会冒出两个图标，媒体键也会被两份注册互相打架。
 *
 * 第二个实例不自己干活：拿到锁的失败方直接退出，
 * 而已经在跑的那个收到 second-instance 事件后把窗口亮出来 ——
 * 用户看到的效果是"点图标，窗口就出来了"，符合直觉。
 * 注意要连托盘里藏着的窗口一起处理（hide 过就 show 回来）。
 */
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });
}

`;
  // 插在 app.whenReady 之前
  const readyAnchor = 'app.whenReady()';
  if (t.includes(readyAnchor)) {
    t = t.replace(readyAnchor, lock.trimStart() + readyAnchor);
    log('ok: 单实例锁');
  } else {
    log('!! 未找到 app.whenReady');
  }
}

fs.writeFileSync(f, t);
console.log('done');
