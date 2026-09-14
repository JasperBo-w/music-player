/*
 * 系统托盘 + 最小化到托盘。
 *
 * 这是"媒体控制"那一项的后半截：SMTC / 媒体键已经通了，托盘还没有。
 * 补齐之后才是能日常用的桌面播放器 —— 关窗口不退出、托盘上能切歌。
 *
 * 图标不往仓库塞二进制，而是在运行时**用 zlib 手写一个 PNG**：
 * 一小段编码器换掉一个 .ico 资源文件，省得为了改个图标还要带个二进制。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const f = path.join(path.dirname(here), 'apps', 'desktop', 'main.js');
let t = fs.readFileSync(f, 'utf8');
const log = (m) => console.log(m);

if (t.includes('makeTrayIcon')) {
  log('已存在，跳过');
  process.exit(0);
}

// ① require 里补 Tray / Menu / nativeImage
if (!t.includes('nativeImage')) {
  t = t.replace(
    "const { app, BrowserWindow, ipcMain, shell, protocol, net, globalShortcut } = require('electron');",
    "const {\n  app,\n  BrowserWindow,\n  ipcMain,\n  shell,\n  protocol,\n  net,\n  globalShortcut,\n  Tray,\n  Menu,\n  nativeImage,\n} = require('electron');"
  );
  log('ok: require 补 Tray/Menu/nativeImage');
}

// ② 托盘模块（插在全局热键那一段之前）
const block = `
/* ------------------------------------------------------------------ */
/* 系统托盘                                                            */
/* ------------------------------------------------------------------ */

/**
 * 手写一个 32x32 的 PNG 当托盘图标。
 *
 * 为什么要自己编码：Tray 需要一个图标文件，而这个项目里没有任何
 * .ico / .png 资源。为了一张图标往仓库塞二进制不值当 ——
 * 这里用 zlib 现场压一个出来，改图标只要改下面那几行像素逻辑。
 */
function pngFromRGBA(rgba, w, h) {
  const zlib = require('node:zlib');
  // CRC32（PNG 每个块都要）
  const table = (() => {
    const tb = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      tb[n] = c;
    }
    return tb;
  })();
  const crc32 = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td), 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // 每行前面要加一个 filter 字节（0 = None）
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 画一张"黑胶唱片"样子的图标：深色圆盘 + 亮环 + 中心点 */
function makeTrayIcon() {
  const S = 32;
  const px = Buffer.alloc(S * S * 4, 0);
  const c = (S - 1) / 2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.hypot(x - c, y - c);
      const i = (y * S + x) * 4;
      if (d > 15) continue; // 圆外透明
      if (Math.abs(d - 11) < 2.6 || d < 3.0) {
        px[i] = 236; px[i + 1] = 244; px[i + 2] = 255; px[i + 3] = 255; // 亮环 + 中心
      } else if (Math.abs(d - 7.2) < 1.6) {
        px[i] = 120; px[i + 1] = 170; px[i + 2] = 230; px[i + 3] = 255; // 细沟槽
      } else {
        px[i] = 14; px[i + 1] = 17; px[i + 2] = 24; px[i + 3] = 235; // 盘面
      }
    }
  }
  return pngFromRGBA(px, S, S);
}

let tray = null;
let closeHintShown = false;

/** 托盘菜单里的一条：把动作发回渲染进程执行（状态都在那边） */
function trayAction(action) {
  sendGlobalHotkeyAction(action);
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

function createTray() {
  if (tray) return tray;
  try {
    const img = nativeImage.createFromBuffer(makeTrayIcon());
    tray = new Tray(img);
  } catch (e) {
    console.error('[托盘] 创建失败:', (e && e.message) || e);
    return null;
  }
  tray.setToolTip('音乐播放器');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 / 隐藏窗口', click: toggleWindow },
      { type: 'separator' },
      { label: '播放 / 暂停', click: () => trayAction('playpause') },
      { label: '上一首', click: () => trayAction('prev') },
      { label: '下一首', click: () => trayAction('next') },
      { type: 'separator' },
      { label: '静音开关', click: () => trayAction('mute') },
      {
        label: '退出',
        click: () => {
          /*
           * 必须先立这个标记再 quit。
           * 否则窗口的 close 会被"最小化到托盘"拦下来，点了退出却只是藏起来 ——
           * 这类 bug 在托盘应用里非常常见，用户会以为程序退不掉。
           */
          app.isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  // 单击托盘图标切换显示（Windows 上 click 就够）
  tray.on('click', toggleWindow);
  console.log('[托盘] 已创建');
  return tray;
}

`;
t = t.replace("/* ------------------------------------------------------------------ */\n/* 全局自定义热键                                                      */", block + "/* ------------------------------------------------------------------ */\n/* 全局自定义热键                                                      */");
log('ok: 托盘模块');

// ③ 关窗改为隐藏到托盘 + 首次提示
const oldClose = `  ipcMain.handle('win:close', () => {
    mainWindow?.close();
  });`;
if (t.includes(oldClose)) {
  t = t.replace(
    oldClose,
    `  ipcMain.handle('win:close', () => {
    /*
     * 界面右上角的 ✕ 改成"收进托盘"，不退出。
     * 这是托盘应用的标准行为：✕ 只是收起来，真要退出走托盘菜单或 Alt+F4 之外的方式。
     * 第一次收起来时给个气泡提示，否则用户会以为程序被自己关掉了。
     */
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.hide();
    if (!closeHintShown && tray && typeof tray.displayBalloon === 'function') {
      closeHintShown = true;
      try {
        tray.displayBalloon({
          title: '音乐播放器还在运行',
          content: '已经收进托盘，点击托盘图标可以重新打开；退出请用托盘菜单里的「退出」。',
        });
      } catch {}
    }
  });`
  );
  log('ok: ✕ 改为收进托盘');
} else {
  log('!! 未匹配 win:close');
}

// ④ 窗口 close 事件也拦下来（关窗 / Alt+F4）
const oldWac = `app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});`;
if (t.includes(oldWac)) {
  t = t.replace(
    oldWac,
    `app.on('window-all-closed', () => {
  /*
   * 有托盘之后**不能在这里退出** —— 窗口被收进托盘时就走到这里了。
   * 真正的退出只有两条路：托盘菜单的「退出」，以及快捷键里的退出
   * （它们都会先立 app.isQuitting）。
   */
  if (process.platform !== 'darwin' && app.isQuitting) app.quit();
});`
  );
  log('ok: window-all-closed 不再直接退出');
} else {
  log('!! 未匹配 window-all-closed');
}

// ⑤ ready 之后建托盘
const anchor = `  mainWindow.once('ready-to-show', () => mainWindow.show());`;
if (t.includes(anchor)) {
  t = t.replace(anchor, anchor + '\n  createTray();');
  log('ok: ready 后创建托盘');
} else {
  log('!! 未匹配 ready-to-show');
}

fs.writeFileSync(f, t);
console.log('done');
