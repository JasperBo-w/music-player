/*
 * 修桌面歌词的尺寸测量（第二版）。
 *
 * 第一版量出来 2395×63，还把窗口推到了屏幕外（x=-303）。
 * 原因：我量的是**元素的盒子**，而 #main 是 left:0; right:0 的通栏元素 ——
 * getBoundingClientRect() 给它的是**整个容器宽度**，和文字多长毫无关系。
 *
 * 正确做法是用 Range 圈住**文字内容本身**再取矩形：
 * text 节点的排版结果才是"文字在哪"。
 *
 * 另外补一道保险：调完尺寸把窗口夹回可视工作区。
 * 否则一次错误的宽度就能把窗口推到屏幕外 —— 用户看到的是"歌词不见了"，
 * 而窗口其实还在，只是画在看不见的地方。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const htmlFile = path.join(root, 'apps', 'ui', 'lyric.html');
const mainFile = path.join(root, 'apps', 'desktop', 'main.js');
const log = (m) => console.log(m);
const readNorm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const writeNorm = (p, t) => fs.writeFileSync(p, t.replace(/\n/g, '\r\n'));

// ---------- ① 量文字本身，不是量盒子 ----------
{
  let t = readNorm(htmlFile);
  const old = `      function reportSize() {
        const rects = [mainEl, nextEl]
          .filter((el) => el && el.offsetParent !== null && el.textContent.trim() !== '')
          .map((el) => el.getBoundingClientRect());
        if (!rects.length) return;`;
  const neu = `      /*
       * ★ 量的是**文字本身**，不是元素的盒子。
       *
       * #main 是 left:0; right:0 的通栏元素 —— getBoundingClientRect() 给它的是
       * 整个容器宽度（第一版就是这么量出 2395px 的），和文字多长毫无关系。
       * 用 Range 圈住内容，取到的才是排版后的真实文字矩形。
       */
      function textRect(el) {
        if (!el || !el.textContent.trim()) return null;
        const r = document.createRange();
        r.selectNodeContents(el);
        return r.getBoundingClientRect();
      }

      function reportSize() {
        const rects = [textRect(mainEl), textRect(nextEl)].filter(Boolean);
        if (!rects.length) return;`;
  if (t.includes(old)) {
    t = t.replace(old, neu);
    writeNorm(htmlFile, t);
    log('ok: 用 Range 量文字');
  } else {
    log('!! reportSize 没匹配');
  }
}

// ---------- ② 主进程：缩完夹回可视区 ----------
{
  let t = readNorm(mainFile);
  const old = `    const b = lyricWindow.getBounds();
    if (Math.abs(b.width - w) < 2 && Math.abs(b.height - h) < 2) return true; // 没变就别动，免得抖
    lyricWindow.setBounds({
      x: Math.round(b.x + (b.width - w) / 2),
      y: Math.round(b.y + (b.height - h) / 2),
      width: w,
      height: h,
    });
    return true;`;
  const neu = `    const b = lyricWindow.getBounds();
    if (Math.abs(b.width - w) < 2 && Math.abs(b.height - h) < 2) return true; // 没变就别动，免得抖

    let x = Math.round(b.x + (b.width - w) / 2);
    let y = Math.round(b.y + (b.height - h) / 2);

    /*
     * ★ 夹回可视工作区。
     *
     * 不夹的话，一次量错（比如量到了容器宽度）就能把窗口推到屏幕外 ——
     * 窗口还在、也在"显示"，只是画在看不见的地方，
     * 用户看到的是"歌词不见了"，而且没有任何办法找回来。
     */
    try {
      const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
      x = Math.max(wa.x, Math.min(x, wa.x + wa.width - w));
      y = Math.max(wa.y, Math.min(y, wa.y + wa.height - h));
    } catch {
      /* 拿不到显示器信息就按原样放，至少不会崩 */
    }

    lyricWindow.setBounds({ x, y, width: w, height: h });
    return true;`;
  if (t.includes(old)) {
    t = t.replace(old, neu);
    writeNorm(mainFile, t);
    log('ok: 夹回可视区');
  } else {
    log('!! setBounds 那段没匹配');
  }
}

console.log('done');
