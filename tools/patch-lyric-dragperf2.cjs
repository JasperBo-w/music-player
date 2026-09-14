/*
 * 拖动整段都涩 → 瓶颈在**每帧的重绘**，不在 IPC 频率。
 *
 * 上一轮我把 IPC 降到每帧一次，用户反馈"整段"还是涩。
 * 那就说明瓶颈不是消息量，而是"移动一次窗口就要重画一次整个窗口"。
 *
 * 这个窗口的重绘确实很贵：
 *   · 900x190 的全尺寸 canvas 每帧都在画（26 颗星点 + lighter 混合）
 *   · 主文字上挂**四层链式 drop-shadow**（每层都要模糊上一层的输出）
 *   · 透明 + 置顶窗口，DWM 每次移动都要重新合成
 *
 * 拖动期间没人需要流光粒子，也没人细看辉光的层次。所以：
 *   · 拖动时**停掉 canvas 循环**并清空
 *   · 辉光降到**一层**
 *   · 松手后恢复
 *
 * 这不是"糊弄"：拖动是一个瞬态操作，用户此刻的注意力在"把窗口放哪儿"，
 * 不在视觉效果上。用临时的画质换手感，是这场景下正确的取舍。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const htmlFile = path.join(root, 'apps', 'ui', 'lyric.html');
const log = (m) => console.log(m);
const readNorm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const writeNorm = (p, t) => fs.writeFileSync(p, t.replace(/\n/g, '\r\n'));

let t = readNorm(htmlFile);

// ---------- ① 廉价模式的样式 ----------
if (!t.includes('body.dragging')) {
  t = t.replace(
    `      #main {`,
    `      /*
       * 拖动中的"廉价模式"。
       *
       * 四层链式 drop-shadow 在静止时很好看，但它意味着**每次重绘都要
       * 做四轮模糊**；拖动时窗口每移动一次就重绘一次，这个开销直接
       * 变成手上的滞涩感。降到一层之后重绘成本大约只有原来的 1/4。
       */
      body.dragging .glow {
        filter: drop-shadow(0 1px 3px rgba(4, 6, 12, 0.75));
        transition: none;
      }
      /* 拖动时不做入场动画，避免和拖动叠加 */
      body.dragging #main.enter {
        animation: none;
      }

      #main {`
  );
  log('ok: 廉价模式样式');
}

// ---------- ② canvas 循环：拖动时停 ----------
t = t.replace(
  `      function frame(now) {
        lastT = now;
        const w = window.innerWidth;
        const h = window.innerHeight;
        ctx.clearRect(0, 0, w, h);`,
  `      function frame(now) {
        lastT = now;
        const w = window.innerWidth;
        const h = window.innerHeight;

        /*
         * 拖动中直接跳过并清空。
         * canvas 每帧都在重绘（26 颗星点 + lighter 混合），
         * 而拖动时窗口每次移动都会触发重绘 —— 这笔开销必须省掉。
         */
        if (isDragging) {
          ctx.clearRect(0, 0, w, h);
          requestAnimationFrame(frame);
          return;
        }

        ctx.clearRect(0, 0, w, h);`
);

// ---------- ③ 拖动时切类 ----------
t = t.replace(
  `      let dragging = false;
      let lastX = 0;`,
  `      let dragging = false;
      /** 给 canvas 循环看的同一个状态（它是另一个作用域里的函数） */
      let isDragging = false;
      let lastX = 0;`
);

t = t.replace(
  `        dragging = true;
        accX = 0;
        accY = 0;`,
  `        dragging = true;
        isDragging = true;
        // 切到廉价模式：辉光降一层、停掉粒子
        document.body.classList.add('dragging');
        accX = 0;
        accY = 0;`
);

t = t.replace(
  `      function endDrag() {
        if (!dragging) return;
        dragging = false;`,
  `      function endDrag() {
        if (!dragging) return;
        dragging = false;
        isDragging = false;
        document.body.classList.remove('dragging');`
);

writeNorm(htmlFile, t);
console.log('done');
