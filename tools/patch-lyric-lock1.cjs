/*
 * 统一锁定状态的入口 + 中键去抖。
 *
 * 现象：信号文件确实在长（18 次中键都收到了），但日志里每一条都是
 * 「中键 → 已解锁」—— 说明每次进来时 lyricLocked 都是 true，
 * 也就是**一次物理按键被切换了两次**（切过去又切回来，净效果为零）。
 *
 * 代码里确实有两条切换路径：
 *   · 731 行  ipcMain.handle('lyric:toggleLock') 里的 lyricLocked = !lyricLocked
 *   · 1180 行 onGlobalMiddleClick 里的同一句
 * 两条各自都能切，一旦某个来源同时命中（比如有多个监听进程在往信号文件里写，
 * 或者 UI 那边也调了一次），就会互相抵消。
 *
 * 与其去追到底是谁多切了一次，不如**从结构上让它不可能双触发**：
 *   ① 锁定状态只有一个写入口 setLyricLock(on)，两条路径都走它
 *   ② 中键加 300ms 去抖 —— 物理按键不可能 300ms 内按两次有效的，
 *      而多进程/多重触发造成的连击正好被它吃掉
 *   ③ 状态变化统一在这一处打日志，不再各打各的
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'desktop', 'main.js');
let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const log = (m) => console.log(m);

// ① 唯一的写入口
if (!t.includes('function setLyricLock(')) {
  const anchor = 'function applyLyricLock() {';
  const fn = `/**
 * **唯一的**锁定状态写入口。
 *
 * 为什么必须唯一：这个状态有多个可能来源（UI 按钮、热键、中键），
 * 之前每个来源各自写一次 lyricLocked，结果一次物理按键被切了两次，
 * 表现就是"按下去没反应"。状态这种东西只留一个写入口，
 * 是避免这类互相抵消最直接的办法。
 */
function setLyricLock(on) {
  const next = !!on;
  if (next === lyricLocked) return lyricLocked; // 无变化就不重复应用（也避免重复打日志）
  lyricLocked = next;
  applyLyricLock();
  console.log('[桌面歌词] 锁定 →', next ? '已锁定' : '已解锁');
  if (lyricWindow && !lyricWindow.isDestroyed()) {
    lyricWindow.webContents.send('lyric:lock', next);
  }
  return lyricLocked;
}

${anchor}`;
  if (t.includes(anchor)) {
    t = t.replace(anchor, fn);
    log('ok: setLyricLock');
  } else {
    log('!! 没找到 applyLyricLock');
  }
}

// ② IPC 走统一入口
t = t.replace(
  `  ipcMain.handle('lyric:toggleLock', () => {
    lyricLocked = !lyricLocked;
    applyLyricLock();
    return lyricLocked;
  });
  ipcMain.handle('lyric:setLock', (_e, on) => {
    lyricLocked = !!on;
    applyLyricLock();
    return lyricLocked;
  });`,
  `  ipcMain.handle('lyric:toggleLock', () => setLyricLock(!lyricLocked));
  ipcMain.handle('lyric:setLock', (_e, on) => setLyricLock(on));`
);

// ③ 中键走统一入口 + 去抖
t = t.replace(
  `  lyricLocked = !lyricLocked;
  applyLyricLock();
  console.log('[桌面歌词] 中键 →', lyricLocked ? '已锁定' : '已解锁');
  if (lyricWindow && !lyricWindow.isDestroyed()) {
    lyricWindow.webContents.send('lyric:lock', lyricLocked);
  }
}`,
  `  /*
   * 去抖 300ms。
   *
   * 物理按键不可能在 300ms 内产生两次有效点击，所以这个阈值不会
   * 吞掉真实操作；但"多个监听进程各写一次信号文件"或"某处多触发一次"
   * 造成的连击，正好被它吃掉。
   */
  const now = Date.now();
  if (now - lastMiddleAt < 300) {
    console.log('[桌面歌词] 中键被忽略：300ms 内重复触发');
    return;
  }
  lastMiddleAt = now;
  setLyricLock(!lyricLocked);
}`
);

// ④ 去抖用的时间戳
t = t.replace(
  `let middleSignalTimer = null;`,
  `let middleSignalTimer = null;
/** 上一次中键生效的时间，用于去抖 */
let lastMiddleAt = 0;`
);

// ⑤ 打开窗口时也走统一入口（原来是直接赋值，绕过了日志）
t = t.replace(
  `    lyricLocked = false;
    lyricHardLock = false;
    lyricMouseIgnored = null;
    createLyricWindow();`,
  `    if (lyricLocked) setLyricLock(false);
    createLyricWindow();`
);

fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
console.log('done');
