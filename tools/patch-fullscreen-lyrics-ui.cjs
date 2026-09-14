/*
 * 全屏歌词页的视觉改进。
 *
 * 用户看截图后提了两点：退出按钮设计不行、整体 UI 能不能改进。
 * 截图里能看出的问题：
 *   ① 退出按钮是个灰底圆 ✕ —— 突兀，像是"临时加的"
 *   ② 歌词全挤在左边，宽窗口下右边一整片空 —— 版面是失衡的
 *   ③ 背景是死板的深色，**没用上封面** —— 全屏歌词最该有的就是氛围
 *   ④ 当前行只有变个颜色，没有"亮起来"的感觉
 *
 * 改法：
 *   ① 幽灵按钮：默认很淡，鼠标靠近才显形（全屏模式不该有抢眼的控件）
 *   ② 歌词**居中成一栏**（max-width 限制宽度，长句不会拉满整屏）
 *   ③ 用当前歌曲的**封面做模糊背景** + 压暗，氛围立刻出来
 *   ④ 当前行加柔光（和桌面歌词同一套做法）
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const cssFile = path.join(root, 'apps', 'ui', 'src', 'styles.css');
const uiFile = path.join(root, 'apps', 'ui', 'src', 'main.js');
const log = (m) => console.log(m);
const readNorm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const writeNorm = (p, t) => fs.writeFileSync(p, t.replace(/\n/g, '\r\n'));
let n = 0;

// ---------- ① 样式整段重写 ----------
{
  let c = readNorm(cssFile);
  const start = c.indexOf('/* ---------------- 全屏歌词 ---------------- */');
  if (start < 0) {
    log('!! 没找到全屏歌词样式段');
  } else {
    const neu = `/* ---------------- 全屏歌词 ---------------- */

/*
 * 盖住整个窗口（连侧栏一起）—— 它是"专注模式"，不是普通视图。
 * position:fixed 而不是 absolute：要盖住 #app 的 padding 和侧栏。
 *
 * 背景用**当前歌曲的封面**（--fl-cover 由 JS 设置）+ 大范围模糊，
 * 再压一层深色渐变。全屏歌词的氛围基本就靠这一层 ——
 * 之前只用一个纯色底，宽窗口下看着像"没做完"。
 */
.view-lyrics {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: none;
  flex-direction: column;
  padding: 48px 6vw 36px;
  box-sizing: border-box;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  overflow: hidden;
}
.view-lyrics.active { display: flex; }

/* 封面模糊层 */
.view-lyrics::before {
  content: '';
  position: absolute;
  inset: -60px;
  background-image: var(--fl-cover, none);
  background-size: cover;
  background-position: center;
  filter: blur(56px) saturate(1.25);
  opacity: .42;
  z-index: 0;
  pointer-events: none;
}
/* 压暗层：保证文字始终可读（封面可能是亮色的） */
.view-lyrics::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to bottom,
    color-mix(in srgb, var(--bg) 58%, transparent) 0%,
    color-mix(in srgb, var(--bg) 76%, transparent) 45%,
    color-mix(in srgb, var(--bg) 90%, transparent) 100%
  );
  z-index: 1;
  pointer-events: none;
}
/* 内容要压在两层背景之上 */
.view-lyrics > * { position: relative; z-index: 2; }

/*
 * 退出按钮：**幽灵样式**。
 * 全屏模式里不该有抢眼的控件 —— 默认很淡，鼠标移到右上角才显形。
 * （用户的原话："退出按钮是不是设计的不太行"，指的就是那个灰底圆 ✕。）
 */
.fl-close {
  position: absolute;
  top: 20px;
  right: 24px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  font-size: 15px;
  line-height: 1;
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--ink) 18%, transparent);
  color: var(--muted);
  opacity: .35;
  transition: opacity .22s, background .22s, color .22s, transform .22s;
}
.fl-close:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--ink) 10%, transparent);
  color: var(--ink);
  transform: scale(1.06);
}

.fl-head {
  flex: 0 0 auto;
  text-align: center;
  margin-bottom: 26px;
}
.fl-title { font-size: 19px; font-weight: 700; color: var(--ink); }
.fl-artist { font-size: 12.5px; color: var(--muted); margin-top: 5px; }

/*
 * 歌词：**居中成一栏**。
 * 之前是左对齐铺满，宽窗口下右边一整片空、版面失衡。
 * 限制 max-width 之后长句也不会拉满整屏。
 */
.fl-lines {
  flex: 1 1 auto;
  width: 100%;
  max-width: 980px;
  margin: 0 auto;
  overflow: hidden auto;
  scrollbar-width: none;
  text-align: center;
  -webkit-mask-image: linear-gradient(to bottom, transparent 0%, #000 15%, #000 82%, transparent 100%);
  mask-image: linear-gradient(to bottom, transparent 0%, #000 15%, #000 82%, transparent 100%);
}
.fl-lines::-webkit-scrollbar { width: 0; }

.fl-line {
  padding: 11px 12px;
  font-size: 30px;
  font-weight: 700;
  line-height: 1.42;
  color: var(--ink-2);
  opacity: .34;
  cursor: pointer;
  border-radius: 8px;
  transition: opacity .3s, color .3s, transform .3s, text-shadow .3s;
}
.fl-line:hover {
  opacity: .72;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
}
/*
 * 当前行：强调色 + 柔光。
 * 和桌面歌词同一套做法（那里已经验证过观感）——
 * 只变色会显得"平"，加一层柔光才有"亮起来"的感觉。
 */
.fl-line.active {
  color: var(--accent-ink, var(--accent));
  opacity: 1;
  transform: scale(1.04);
  text-shadow: 0 0 22px color-mix(in srgb, var(--accent) 45%, transparent);
}

@media (max-width: 980px) {
  .fl-line { font-size: 22px; padding: 8px 10px; }
  .view-lyrics { padding: 40px 5vw 28px; }
}
`;
    c = c.slice(0, start) + neu;
    writeNorm(cssFile, c);
    n++;
    log('ok: 全屏歌词样式重写');
  }
}

// ---------- ② JS：设置封面变量 ----------
{
  let t = readNorm(uiFile);
  const anchor = `  $('#fl-head .fl-title').textContent = state.currentSong ? state.currentSong.name || '' : '';`;
  if (t.includes(anchor) && !t.includes('--fl-cover')) {
    t = t.replace(
      anchor,
      `  /*
   * 把封面交给 CSS 做模糊背景。
   * 用 CSS 变量而不是直接写 background-image：
   * 背景那层是伪元素（::before），JS 改不到它 —— 变量能传下去。
   */
  const cover = state.currentSong && state.currentSong.cover;
  document
    .getElementById('view-lyrics')
    .style.setProperty('--fl-cover', cover ? \`url("\${cover}")\` : 'none');

${anchor}`
    );
    n++;
    log('ok: 封面变量');
  } else if (!t.includes(anchor)) {
    log('!! openFullLyrics 锚点没找到');
  }
  writeNorm(uiFile, t);
}

log('改了 ' + n + ' 处');
