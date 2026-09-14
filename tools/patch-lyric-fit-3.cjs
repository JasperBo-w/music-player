/*
 * 桌面歌词尺寸：留安全余量 + 兜底。
 *
 * 现状：量出 249px，实际渲染出来的字比它宽，右边被裁掉了。
 * 根因是"测量时"和"最终渲染"不是同一个状态 —— 字体加载、字距微调、
 * 逐字 span 的排版都会在测量之后改变宽度。
 * 这个窗口我这边没有调试手段（独立窗口、没有 devtools），
 * 所以不追求"毫厘不差"，改成"宁可略大也不能裁字"：
 *
 *   · 宽度乘一个余量系数，再兜一个固定值
 *   · 同时**让文字自己能缩**：万一还是超了，用 CSS 缩放兜底，
 *     保证任何情况下都完整可见，而不是被裁一半
 *
 * 取舍说明：框略大一点，用户可能多出一两个像素的透明区；
 * 但裁字是"信息直接丢了"，性质严重得多。
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'ui', 'lyric.html');
let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const log = (m) => console.log(m);

// ① 尺寸加余量
const old = `        const w = Math.ceil(right - left) + PAD_X * 2;
        const h = Math.ceil(bottom - top) + PAD_Y * 2;`;
const neu = `        /*
         * 余量：测量值和最终渲染会差一点（字体加载、逐字 span 的字距），
         * 所以宽度乘 1.12 再兜 24px，高度兜 8px。
         * 宁可框大一点，也不能裁掉字 —— 裁字是信息直接丢了。
         */
        const w = Math.ceil((right - left) * 1.12) + PAD_X * 2 + 24;
        const h = Math.ceil((bottom - top) * 1.1) + PAD_Y * 2 + 8;`;
if (t.includes(old)) {
  t = t.replace(old, neu);
  log('ok: 尺寸余量');
} else {
  log('!! 尺寸计算没匹配');
}

// ② 兜底：文字真的超宽时自己缩放，保证完整可见
if (!t.includes('fitScale')) {
  t = t.replace(
    `        if (key === lastSize) return; // 没变就别反复调 setBounds，会抖
        lastSize = key;
        window.api.desktopLyric.resize({ w, h });`,
    `        if (key === lastSize) return; // 没变就别反复调 setBounds，会抖
        lastSize = key;
        window.api.desktopLyric.resize({ w, h });
      }

      /*
       * 兜底：如果文字仍然比视口宽（比如余量还是不够），
       * 整体等比缩小一点，保证**完整可见**。
       * 缩放是最后一道防线 —— 有它在，就不会出现"歌词被裁一半"这种情况。
       */
      function fitScale() {
        for (const el of [mainEl, nextEl]) {
          if (!el || !el.textContent.trim()) continue;
          el.style.transform = 'none';
          const r = textRect(el);
          if (!r) continue;
          const avail = window.innerWidth - 8;
          if (r.width > avail && r.width > 0) {
            el.style.transform = 'scale(' + (avail / r.width).toFixed(3) + ')';
          }
        }`;
  );
  // 在每次 reportSize 之后也跑一次 fitScale
  t = t.replace(
    `        requestAnimationFrame(reportSize);`,
    `        requestAnimationFrame(() => {
          reportSize();
          fitScale();
        });`
  );
  log('ok: 缩放兜底');
}

fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
console.log('done');
