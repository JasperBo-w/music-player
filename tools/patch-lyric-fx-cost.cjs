/*
 * 修「开了桌面歌词之后鼠标发顿」。
 *
 * 原因（从代码直读得出来，不用猜）：
 *
 *   1. #fx 是**全屏尺寸**的 canvas：
 *        canvas.width  = innerWidth  × dpr = 1708 × 1.5 = 2562
 *        canvas.height = innerHeight × dpr = 1068 × 1.5 = 1602
 *      而每一帧都在 clearRect(0, 0, 2562, 1602) —— **410 万像素**，
 *      **即使一颗星点都没有**（纯音乐、暂停时也照样清）。
 *
 *   2. 这个全屏透明窗口还要让 DWM 每帧重新合成整个屏幕大小的层。
 *      而**鼠标光标也是 DWM 合成的** —— 所以光标跟着一起顿。
 *
 * 两处修改：
 *   · canvas 缩到**文字周围一小块**（1400×260），不再铺满屏幕
 *   · 没有粒子要画时**完全不碰 canvas**（连 clearRect 都不做）
 *
 * 第二点是关键：流光粒子在安静时本来就该是"没有"，那就不该有任何绘制开销。
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'ui', 'lyric.html');
let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const log = (m) => console.log(m);
let n = 0;

// ① canvas 改成文字周围的一块固定尺寸区域
const oldCss = `      #fx {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 1;
      }`;
const newCss = `      /*
       * ★ canvas **不要铺满屏幕**。
       *
       * 铺满时它是 1708×1068（×dpr 之后 2562×1602），每帧 clearRect
       * 要清 410 万像素 —— 而窗口本身是全屏透明的，DWM 还要为它
       * 每帧重新合成一次整屏大小的层。鼠标光标也走 DWM，于是光标跟着顿。
       *
       * 星点本来就只在文字附近流动，所以给它一块**够用的固定区域**即可：
       * 1400×260，居中跟着文字走（放在 .positioner 里）。
       */
      #fx {
        position: absolute;
        left: 50%;
        top: 50%;
        width: 1400px;
        height: 260px;
        margin: -130px 0 0 -700px;
        pointer-events: none;
        z-index: 1;
      }`;
if (t.includes(oldCss)) {
  t = t.replace(oldCss, newCss);
  n++;
} else log('!! #fx 样式没匹配');

// ② canvas 的像素尺寸也跟着固定下来
const oldResize = `      function resizeCanvas() {
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(window.innerWidth * dpr);
        canvas.height = Math.round(window.innerHeight * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      resizeCanvas();
      window.addEventListener('resize', resizeCanvas);`;
const newResize = `      function resizeCanvas() {
        const dpr = window.devicePixelRatio || 1;
        // 用 canvas 自己的实际布局尺寸，而不是视口 —— 见上面 #fx 的说明
        const w = canvas.clientWidth || 1400;
        const h = canvas.clientHeight || 260;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      resizeCanvas();
      window.addEventListener('resize', resizeCanvas);`;
if (t.includes(oldResize)) {
  t = t.replace(oldResize, newResize);
  n++;
} else log('!! resizeCanvas 没匹配');

// ③ 安静时完全不绘制（这是最关键的一条）
const oldFrame = `      function frame(now) {
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

        ctx.clearRect(0, 0, w, h);`;
const newFrame = `      function frame(now) {
        lastT = now;

        /*
         * ★ 安静时**什么都不做**：不清、不画、不碰 canvas。
         *
         * 这是"鼠标发顿"的根子 —— 原来无论有没有粒子，每帧都在
         * clearRect 一整块大区域。而"没有粒子"本来就是常态
         *（暂停、纯音乐、间奏），那种时候不该有任何绘制开销。
         *
         * 注意这里直接 return，**跳过了 clearRect**：
         * 上一帧如果是空的，那这一帧也是空的，不需要清。
         */
        if (isDragging || sparkLevel <= 0.02) {
          requestAnimationFrame(frame);
          return;
        }

        const w = canvas.clientWidth || 1400;
        const h = canvas.clientHeight || 260;
        ctx.clearRect(0, 0, w, h);`;
if (t.includes(oldFrame)) {
  t = t.replace(oldFrame, newFrame);
  n++;
} else log('!! frame 没匹配');

// ④ 清出这个状态之后，frame 里原来的判断要去掉（已经在上面 return 了）
t = t.replace(
  `        if (sparkLevel > 0.02) {
          let spanW = w * 0.3;`,
  `        {
          let spanW = w * 0.3;`
);

fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
log('改了 ' + n + ' 处');
