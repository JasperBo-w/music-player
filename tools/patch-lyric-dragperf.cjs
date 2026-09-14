/*
 * 修「拖动卡顿严重」。
 *
 * 原因很清楚：每来一次 mousemove 就做四件事
 *   ① IPC 往返  ② setBounds 移窗口  ③ applyLyricMouseBehavior（查光标+改穿透）
 *   ④ 重置写盘定时器
 * 而 mousemove 每秒触发 60~125 次。
 *
 * 其中最要命的是 ③：拖动时窗口在光标底下移动，那个 80ms 的穿透轮询
 * 很可能判定"光标已经不在窗口里了" → setIgnoreMouseEvents(true)
 * → **窗口当场不再接收鼠标事件 → 拖动断掉**。
 * 表现出来就是一顿一顿的。
 *
 * 四处修改：
 *   ① 页面侧：把位移**攒起来**，用 requestAnimationFrame 每帧最多发一次
 *   ② 拖动期间**冻结**穿透判定（lyricDragging 标志）
 *   ③ moveBy 里不再调 applyLyricMouseBehavior、也不再写盘
 *   ④ 写盘挪到松手时（dragEnd）做一次
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const mainFile = path.join(root, 'apps', 'desktop', 'main.js');
const htmlFile = path.join(root, 'apps', 'ui', 'lyric.html');
const preloadFile = path.join(root, 'apps', 'desktop', 'preload.js');
const log = (m) => console.log(m);
const readNorm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const writeNorm = (p, t) => fs.writeFileSync(p, t.replace(/\n/g, '\r\n'));

// ---------- ① 主进程：拖动期间冻结穿透 ----------
{
  let t = readNorm(mainFile);

  t = t.replace(
    `let middleSignalTimer = null;`,
    `let middleSignalTimer = null;
/** 正在被用户拖动。拖动期间必须冻结穿透判定，否则窗口一挪就被判成"光标不在上面"而穿透，拖动会断 */
let lyricDragging = false;`
  );

  t = t.replace(
    `function applyLyricMouseBehavior() {
  if (!lyricWindow || lyricWindow.isDestroyed()) return;`,
    `function applyLyricMouseBehavior() {
  if (!lyricWindow || lyricWindow.isDestroyed()) return;
  /*
   * ★ 拖动期间不动穿透状态。
   *
   * 拖动时窗口在光标底下移动，判定随时可能得出"光标已经不在窗口里"，
   * 于是 setIgnoreMouseEvents(true) —— 窗口当场收不到鼠标事件，拖动断掉。
   * 用户看到的就是"一顿一顿"。拖动期间保持现状即可，松手后再校准。
   */
  if (lyricDragging) return;`
  );

  // moveBy：去掉每次移动都做的重活
  const oldMove = t.slice(t.indexOf("  ipcMain.handle('lyric:moveBy'"), t.indexOf("  ipcMain.handle('lyric:hotBounds'"));
  const newMove = `  /*
   * 拖动：页面算好位移差值，这里挪窗口。
   *
   * ★ 这里**只挪窗口**，别的什么都不做。
   * 原来还顺手调了 applyLyricMouseBehavior（查光标 + 可能改穿透）和
   * scheduleSaveLyricBounds（重置写盘定时器）—— 这两个都是每次 mousemove
   * 都要跑的重活，是卡顿的主要来源。
   * 穿透校准改由松手时的 dragEnd 做一次；写盘也在那时做一次。
   */
  ipcMain.handle('lyric:moveBy', (_e, dx, dy) => {
    if (!lyricWindow || lyricWindow.isDestroyed()) return false;
    const b = lyricWindow.getBounds();
    lyricWindow.setBounds({
      x: Math.round(b.x + (Number(dx) || 0)),
      y: Math.round(b.y + (Number(dy) || 0)),
      width: b.width,
      height: b.height,
    });
    return true;
  });

  /** 开始拖动：先冻结穿透判定，否则第一下移动就可能把窗口切成穿透 */
  ipcMain.handle('lyric:dragStart', () => {
    lyricDragging = true;
    return true;
  });

  /** 结束拖动：解冻、校准一次穿透、位置落盘一次 */
  ipcMain.handle('lyric:dragEnd', () => {
    lyricDragging = false;
    lyricMouseIgnored = null; // 清缓存，强制按当前光标重算
    applyLyricMouseBehavior();
    scheduleSaveLyricBounds();
    return true;
  });

`;
  if (oldMove && oldMove.includes("'lyric:moveBy'")) {
    t = t.replace(oldMove, newMove);
    log('ok: moveBy 瘦身 + dragStart/dragEnd');
  } else {
    log('!! 没定位到 moveBy');
  }

  writeNorm(mainFile, t);
}

// ---------- ② preload ----------
{
  let t = readNorm(preloadFile);
  if (!t.includes('dragStart')) {
    t = t.replace(
      `    moveBy: (dx, dy) => ipcRenderer.invoke('lyric:moveBy', dx, dy),`,
      `    moveBy: (dx, dy) => ipcRenderer.invoke('lyric:moveBy', dx, dy),
    /** 拖动开始/结束。开始时要冻结穿透判定，结束时要校准并落盘 */
    dragStart: () => ipcRenderer.invoke('lyric:dragStart'),
    dragEnd: () => ipcRenderer.invoke('lyric:dragEnd'),`
    );
    writeNorm(preloadFile, t);
    log('ok: preload dragStart/End');
  }
}

// ---------- ③ 页面：攒位移，每帧最多发一次 ----------
{
  let t = readNorm(htmlFile);

  const oldDrag = t.slice(
    t.indexOf('      /* ---------------- 自己拖窗口 ---------------- */'),
    t.indexOf("      /*\n       * ★ 这里**不要**再处理中键了。")
  );
  const newDrag = `      /* ---------------- 自己拖窗口 ---------------- */

      /*
       * 左键按住拖。
       *
       * ★ 位移要**攒起来，每帧最多发一次 IPC**。
       *
       * mousemove 每秒能触发 60~125 次，每次都发一次 IPC + 移一次窗口，
       * 主进程会被这类小消息堆满 —— 表现就是拖动明显发涩。
       * 用 requestAnimationFrame 归拢之后，最多和屏幕刷新率一样
       *（60~165 次/秒，而且和绘制同拍），手感立刻顺。
       *
       * 用 screenX/screenY（屏幕坐标）而不是 clientX/clientY：
       * 窗口自己在动，client 坐标会跟着变，差值算出来是错的
       *（表现是"越拖越慢"或者抖动）。
       */
      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      let accX = 0;
      let accY = 0;
      let rafId = 0;

      function flushMove() {
        rafId = 0;
        if (!accX && !accY) return;
        const dx = accX;
        const dy = accY;
        accX = 0;
        accY = 0;
        window.api.desktopLyric.moveBy(dx, dy);
      }

      document.body.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        dragging = true;
        accX = 0;
        accY = 0;
        lastX = e.screenX;
        lastY = e.screenY;
        // 先冻结主进程的穿透判定，否则第一下移动就可能把窗口切成穿透、拖动断掉
        window.api.desktopLyric.dragStart();
        e.preventDefault();
      });

      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.screenX - lastX;
        const dy = e.screenY - lastY;
        if (!dx && !dy) return;
        lastX = e.screenX;
        lastY = e.screenY;
        accX += dx;
        accY += dy;
        if (!rafId) rafId = requestAnimationFrame(flushMove);
      });

      function endDrag() {
        if (!dragging) return;
        dragging = false;
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
        if (accX || accY) {
          window.api.desktopLyric.moveBy(accX, accY);
          accX = 0;
          accY = 0;
        }
        // 解冻穿透 + 位置落盘，各做一次
        window.api.desktopLyric.dragEnd();
      }

      window.addEventListener('mouseup', endDrag);
      // 鼠标移出窗口时也要收尾，否则回来会"粘住"
      window.addEventListener('blur', endDrag);

`;
  if (oldDrag && oldDrag.includes('let dragging')) {
    t = t.replace(oldDrag, newDrag);
    writeNorm(htmlFile, t);
    log('ok: 页面侧攒位移');
  } else {
    log('!! 没定位到拖动段');
  }
}

console.log('done');
