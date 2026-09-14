/*
 * 拖动改成**指针捕获**（学自 Mineradio）。
 *
 * 用户反馈"还是一顿一顿不跟手"。
 *
 * 去看 Mineradio 的实现（public/desktop-lyrics.html:1127-1170）：
 *   · 用 **pointermove**，不是 mousemove
 *   · **stage.setPointerCapture(pointerId)**          ← 关键
 *   · 每个事件都发 moveLyricsBy，**不节流**
 *
 * 我这两条都反着做了：
 *   ① 没做指针捕获 → 拖动一快，光标就跑出窗口范围，
 *      mousemove 不再送进窗口 → 窗口停住不跟 → 等光标被拖回来才又跟上。
 *      **"一顿一顿不跟手"正是丢事件的样子。**
 *   ② 加了 requestAnimationFrame 归拢 → 每一帧的位移要等下一个绘制周期
 *      才发出去，凭空多了一帧延迟。"跟手"要的恰恰是零延迟。
 *
 * 所以这一版严格照它的做法：pointer 事件 + 捕获 + 逐事件发送。
 * 之前为性能做的"廉价模式"（拖动时停粒子、辉光降一层）保留 ——
 * 那个是独立的好处，和这条不冲突。
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'ui', 'lyric.html');
let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const log = (m) => console.log(m);

const start = t.indexOf('      /* ---------------- 自己拖窗口 ---------------- */');
const end = t.indexOf("      /*\n       * ★ 这里**不要**再处理中键了。");
if (start < 0 || end < 0 || end < start) {
  log('!! 没定位到拖动态');
  process.exit(1);
}

const block = `      /* ---------------- 自己拖窗口 ---------------- */

      /*
       * ★ 用**指针捕获**，这是从 Mineradio 学来的关键一条
       *（它的 desktop-lyrics.html:1127-1170）。
       *
       * 没有捕获的时候：拖动一快，光标就跑出了窗口范围，
       * 窗口收不到 mousemove 了 → 停住不跟 → 光标被拖回来才又跟上。
       * 表现出来就是"一顿一顿、不跟手"。
       *
       * setPointerCapture 之后，**指针的所有事件都会继续送到这个元素，
       * 哪怕光标已经跑到窗口外面** —— 于是窗口能一直贴着光标走。
       *
       * 另外：位移**逐事件发送，不做节流**。
       * 我上一版用 requestAnimationFrame 归拢，等于每帧的位移要等下一个
       * 绘制周期才发出去，凭空多一帧延迟 —— 而"跟手"要的正是零延迟。
       * Mineradio 也是逐事件发的，它不卡。
       */
      let dragging = false;
      let dragPointerId = null;
      let isDragging = false;
      let lastX = 0;
      let lastY = 0;

      const stageEl = document.querySelector('.stage');

      /** 捕获/释放指针。包一层 try：某些环境下 pointerId 已失效会抛错 */
      function capturePointer(on) {
        try {
          if (!stageEl) return;
          if (on && dragPointerId != null && stageEl.setPointerCapture) {
            stageEl.setPointerCapture(dragPointerId);
          } else if (!on && dragPointerId != null && stageEl.releasePointerCapture && stageEl.hasPointerCapture
                     && stageEl.hasPointerCapture(dragPointerId)) {
            stageEl.releasePointerCapture(dragPointerId);
          }
        } catch {}
      }

      function beginDrag(e) {
        dragging = true;
        isDragging = true;
        dragPointerId = e.pointerId;
        lastX = e.screenX;
        lastY = e.screenY;
        // 切到廉价模式：停粒子、辉光降一层（拖动时没人看这些）
        document.body.classList.add('dragging');
        // 先冻结主进程的穿透判定，否则第一下移动就可能把窗口切成穿透
        window.api.desktopLyric.dragStart();
        capturePointer(true);
      }

      function moveDrag(e) {
        if (!dragging) return;
        const dx = e.screenX - lastX;
        const dy = e.screenY - lastY;
        if (!dx && !dy) return;
        lastX = e.screenX;
        lastY = e.screenY;
        window.api.desktopLyric.moveBy(dx, dy);
      }

      function endDrag(e) {
        if (!dragging) return;
        if (e && dragPointerId != null && e.pointerId != null && e.pointerId !== dragPointerId) return;
        dragging = false;
        isDragging = false;
        capturePointer(false);
        dragPointerId = null;
        document.body.classList.remove('dragging');
        // 解冻穿透 + 位置落盘，各做一次
        window.api.desktopLyric.dragEnd();
      }

      document.body.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        beginDrag(e);
        e.preventDefault();
      });

      window.addEventListener('pointermove', (e) => {
        /*
         * 捕获可能因为各种原因掉了（系统切换、窗口重建）——
         * 这时如果还按着左键，就重新捕获一次。
         * 不补这一步的话，中途掉捕获就等于"这一拖废了"。
         */
        if (dragging && e.buttons != null && (e.buttons & 1) === 1) {
          try {
            if (dragPointerId != null && stageEl && stageEl.hasPointerCapture
                && !stageEl.hasPointerCapture(dragPointerId)) {
              stageEl.setPointerCapture(dragPointerId);
            }
          } catch {}
        }
        // 左键已经松开但没收到 pointerup（比如在窗口外松的）→ 主动收尾
        if (dragging && e.buttons != null && (e.buttons & 1) === 0) {
          endDrag(e);
          return;
        }
        moveDrag(e);
      });

      window.addEventListener('pointerup', endDrag);
      window.addEventListener('pointercancel', endDrag);
      // 捕获被系统收走时也要收尾，否则状态会留在"拖动中"
      window.addEventListener('lostpointercapture', () => {
        if (dragging) endDrag();
      });

`;
t = t.slice(0, start) + block + t.slice(end);
fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
console.log('done');
