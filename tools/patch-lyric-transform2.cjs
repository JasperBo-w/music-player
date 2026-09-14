/*
 * 歌词页：位置改由 CSS transform 承载。
 *
 * 配合主进程的"窗口铺满屏幕、永远不动" —— 拖动时只改 .stage 的
 * translate3d，不碰窗口。transform 由 GPU 合成，改它几乎不花钱，
 * 所以拖动是跟手的。
 *
 * 几个要点：
 *   · 偏移只在**松手时**报回主进程一次（拖动中每帧都报就是又开了一条 IPC 洪流）
 *   · getBoundingClientRect() 返回的是**视口坐标、已经包含 transform**，
 *     所以热点计算不用改 —— 它自动跟着走
 *   · 主进程在"显示时"和"拖动开始时"各推一次偏移做同步，
 *     避免页面和主进程各记一份、久了不一致
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'ui', 'lyric.html');
let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const log = (m) => console.log(m);

// ① stage 加 transform 承载位置
if (!t.includes('translate3d(var(--lx)')) {
  t = t.replace(
    `      .stage {
        position: absolute;
        inset: 0;`,
    `      .stage {
        position: absolute;
        inset: 0;
        /*
         * ★ 位置由这个 transform 承载（窗口本身铺满屏幕、永远不动）。
         * translate3d 会走 GPU 合成，改它几乎不花钱 —— 这是拖动跟手的关键。
         * 加 will-change 提前把它提升为合成层，避免第一次拖动时才开始建层。
         */
        transform: translate3d(var(--lx, 0px), var(--ly, 0px), 0);
        will-change: transform;`
  );
  log('ok: stage transform');
}

// ② 逻辑：接收偏移 / 接收拖动位移 / 松手时回报
if (!t.includes('applyOffset')) {
  const anchor = `      function beginDrag(e) {`;
  const block = `      /* ---------------- 位置（transform 承载） ---------------- */

      let offX = 0;
      let offY = 0;

      function applyOffset() {
        root.style.setProperty('--lx', offX + 'px');
        root.style.setProperty('--ly', offY + 'px');
      }

      // 主进程推来的偏移（显示时、拖动开始时各同步一次）
      window.api.desktopLyric.onOffset((o) => {
        if (!o) return;
        offX = Number(o.x) || 0;
        offY = Number(o.y) || 0;
        applyOffset();
        requestAnimationFrame(reportHot);
      });

      /*
       * 主进程转发来的拖动位移。
       * 这里**只改 transform**，一次系统调用都不发 —— 这是整条链路上最便宜的一环，
       * 也是拖动跟手的根本原因。
       */
      window.api.desktopLyric.onMove((d) => {
        if (!d) return;
        offX += Number(d.dx) || 0;
        offY += Number(d.dy) || 0;
        applyOffset();
        requestAnimationFrame(reportHot);
      });

${anchor}`;
  t = t.replace(anchor, block);
  log('ok: 偏移逻辑');
}

// ③ 松手时把最终偏移报回主进程（只报一次，不每帧报）
const oldEnd = `        if (dragStarted) {
          dragStarted = false;
          window.api.desktopLyric.dragEnd();
        }`;
const newEnd = `        if (dragStarted) {
          dragStarted = false;
          /*
           * 只在**松手时**把最终偏移报回主进程一次。
           * 拖动中每帧都报的话，等于又开了一条 IPC 洪流 ——
           * 那正是我们好不容易绕开的东西。
           */
          window.api.desktopLyric.setOffset({ x: offX, y: offY });
          window.api.desktopLyric.dragEnd();
        }`;
if (t.includes(oldEnd)) {
  t = t.replace(oldEnd, newEnd);
  log('ok: 松手回报偏移');
} else {
  log('!! endDrag 段没匹配');
}

fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
console.log('done');
