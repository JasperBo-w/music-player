/*
 * 桌面歌词：改成**自己拖**，不用 -webkit-app-region: drag。
 *
 * 用户反馈两件事：
 *   ① 中键没反应
 *   ② 拖动的时候能看到边框
 *
 * 根因是同一个：`-webkit-app-region: drag` 把文字区变成"系统标题栏" ——
 *   · 页面的 JS 收不到鼠标事件 → 中键的监听根本不触发
 *   · 拖动由**系统**代劳 → 拖动时会出现系统那套拖拽反馈（用户看到的"边框"）
 *
 * Mineradio 的 desktop-lyrics.html 里 `.stage{-webkit-app-region:no-drag}`，
 * 拖动靠页面自己算：mousedown 记起点、mousemove 发差值、
 * 主进程 `moveLyricsBy(dx,dy)` 移动窗口 —— 它的 overlay-preload 里
 * setLyricsDrag / moveLyricsBy 就是为这个准备的。
 *
 * 我们照做：事件全归页面，中键、左键拖、双击都能正常收到。
 * 顺带把 resizable 关掉 —— 窗口尺寸是固定的，不需要可调边框
 *（那也是"能看到边框"的一个来源）。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const mainFile = path.join(root, 'apps', 'desktop', 'main.js');
const preloadFile = path.join(root, 'apps', 'desktop', 'preload.js');
const htmlFile = path.join(root, 'apps', 'ui', 'lyric.html');
const log = (m) => console.log(m);
const readNorm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const writeNorm = (p, t) => fs.writeFileSync(p, t.replace(/\n/g, '\r\n'));

// ---------- ① 主进程：moveBy + resizable:false ----------
{
  let t = readNorm(mainFile);

  if (!t.includes("'lyric:moveBy'")) {
    const anchor = `  ipcMain.handle('lyric:hotBounds'`;
    const add = `  /*
   * 拖动：页面算好位移差值，这里挪窗口。
   *
   * 为什么不让系统拖（-webkit-app-region: drag）：
   * 那样页面收不到鼠标事件（中键就废了），而且拖动时会看到系统的拖拽边框。
   * 自己拖之后这两个问题一起消失。
   *
   * 用 setBounds 而不是 setPosition：Windows 上窗口一多，
   * setPosition 在多显示器/缩放场景下偶尔会把窗口弹回去，
   * setBounds 给全量几何更稳。
   */
  ipcMain.handle('lyric:moveBy', (_e, dx, dy) => {
    if (!lyricWindow || lyricWindow.isDestroyed()) return false;
    const b = lyricWindow.getBounds();
    const x = Math.round(b.x + (Number(dx) || 0));
    const y = Math.round(b.y + (Number(dy) || 0));
    lyricWindow.setBounds({ x, y, width: b.width, height: b.height });
    // 挪完热点位置就变了，立刻重算穿透状态
    applyLyricMouseBehavior();
    scheduleSaveLyricBounds();
    return true;
  });

`;
    if (t.includes(anchor)) {
      t = t.replace(anchor, add + anchor);
      log('ok: lyric:moveBy');
    } else {
      log('!! 没找到 lyric:hotBounds');
    }
  }

  // 尺寸固定，不需要可调边框
  t = t.replace(
    `/* 程序要按文字尺寸改它，所以不能锁死；无边框下用户也拖不到边框 */
    resizable: true,`,
    `/* 尺寸是固定的（不贴合文字），所以锁死 —— 可调整边框也是"能看到边框"的来源之一 */
    resizable: false,`
  );
  writeNorm(mainFile, t);
}

// ---------- ② preload ----------
{
  let t = readNorm(preloadFile);
  if (!t.includes('moveBy:')) {
    t = t.replace(
      `    /** 歌词窗口量完"文字实际范围"后报给主进程，用来决定要不要穿透 */`,
      `    /** 拖动：页面算好差值，主进程挪窗口（不用系统拖拽，见 main.js 的说明） */
    moveBy: (dx, dy) => ipcRenderer.invoke('lyric:moveBy', dx, dy),
    /** 歌词窗口量完"文字实际范围"后报给主进程，用来决定要不要穿透 */`
    );
    writeNorm(preloadFile, t);
    log('ok: preload moveBy');
  }
}

// ---------- ③ 歌词页：取消系统拖拽区，自己拖 ----------
{
  let t = readNorm(htmlFile);

  // 3.1 去掉 app-region: drag
  const oldStage = `        pointer-events: auto;
        -webkit-app-region: drag;
        cursor: default;`;
  const newStage = `        pointer-events: auto;
        /*
         * ★ 这里**不能**用 -webkit-app-region: drag。
         *
         * 它会把整块变成"系统标题栏"：页面的 JS 收不到鼠标事件（中键就废了），
         * 而且拖动时会出现系统那套拖拽反馈（看起来就是一圈边框）。
         * 拖动改由下面的 JS 自己做（Mineradio 也是这么干的）。
         */
        cursor: move;`;
  if (t.includes(oldStage)) {
    t = t.replace(oldStage, newStage);
    log('ok: 去掉 app-region');
  } else {
    log('!! stage 那段没匹配');
  }
  t = t.replace(`      .stage:active {
        cursor: move;
      }`, '');

  // 3.2 自己拖 + 中键
  const oldDrag = `      /*
       * 中键：切换锁定 / 穿透。`;
  const newDrag = `      /* ---------------- 自己拖窗口 ---------------- */

      /*
       * 左键按住拖 —— 自己算差值发给主进程。
       *
       * 用 screenX/screenY（屏幕坐标）而不是 clientX/clientY：
       * 窗口自己在移动，client 坐标会跟着变，差值算出来是错的
       *（表现就是"越拖越慢"或者抖动）。
       *
       * 阈值 3px：不加的话，单击（想切锁定）会被当成一次 0 位移的拖动，
       * 虽然结果一样，但会多打一次 IPC；更重要的是防止手抖被识别成拖动。
       */
      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      let moved = 0;

      document.body.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        dragging = true;
        moved = 0;
        lastX = e.screenX;
        lastY = e.screenY;
        e.preventDefault();
      });

      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.screenX - lastX;
        const dy = e.screenY - lastY;
        lastX = e.screenX;
        lastY = e.screenY;
        moved += Math.abs(dx) + Math.abs(dy);
        if (moved < 3) return;
        window.api.desktopLyric.moveBy(dx, dy);
      });

      window.addEventListener('mouseup', () => {
        dragging = false;
      });
      // 鼠标移出窗口时也要结束拖动，否则回来会"粘住"
      window.addEventListener('blur', () => {
        dragging = false;
      });

      /*
       * 中键：切换锁定 / 穿透。`;
  if (t.includes(oldDrag)) {
    t = t.replace(oldDrag, newDrag);
    log('ok: 自己拖 + 中键');
  } else {
    log('!! 中键那段没匹配');
  }

  writeNorm(htmlFile, t);
}

console.log('done');
