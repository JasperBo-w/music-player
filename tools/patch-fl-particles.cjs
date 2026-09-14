/*
 * 全屏歌词：背景改成**透出粒子**，不再用封面。
 *
 * 用户一句话点破："全屏歌词背景不是粒子的吗"。
 *
 * 他说得对 —— 粒子背景是这个应用的招牌，而全屏歌词恰恰是最该展示它的场合
 *（普通页面还有列表、卡片挡着，全屏歌词只有字）。我却用封面模糊把它盖住了，
 * 方向整个反了。
 *
 * 改法：
 *   · 浮层**完全透明**，去掉 backdrop-filter —— 那两样都会把粒子挡掉
 *   · 去掉封面那层（::before）
 *   · 只保留一层**很淡的暗角**（::after）：粒子亮的地方文字会看不清，
 *     但暗角必须淡到不遮粒子
 *   · 文字靠自身的柔光提可读性（当前行已经有）
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'ui', 'src', 'styles.css');
let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const log = (m) => console.log(m);
let n = 0;

// ① 浮层本体：透明、去掉模糊
const oldBg = `  background: color-mix(in srgb, var(--bg) 72%, transparent);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  overflow: hidden;`;
const newBg = `  /*
   * ★ 完全透明，**不要 backdrop-filter**。
   *
   * 这两样都会把背后的粒子画布挡掉 —— 而全屏歌词最该展示的就是它。
   * 粒子是每帧都在变的全屏层，一旦这里做背景模糊，
   * 浏览器每帧都要重新模糊整个屏幕，既挡画面又掉帧
   *（设置面板当初就是因为这个才特意不用 backdrop-filter 的）。
   */
  background: transparent;
  overflow: hidden;`;
if (t.includes(oldBg)) {
  t = t.replace(oldBg, newBg);
  n++;
} else log('!! 浮层背景未匹配');

// ② 删掉封面层（整段 ::before）
const beforeStart = t.indexOf('/* 封面模糊层 */');
const beforeEnd = t.indexOf('/* 压暗层');
if (beforeStart >= 0 && beforeEnd > beforeStart) {
  t = t.slice(0, beforeStart) + t.slice(beforeEnd);
  n++;
  log('ok: 删掉封面层');
} else {
  log('!! 封面层定位失败');
}

// ③ 暗角：淡到不遮粒子
const oldAfter = `  /*
   * 压暗层要**够淡**。
   * 我第一版给到 58%~90%，把封面那层彻底盖住了 —— 页面上就是一片纯黑，
   * "用封面做背景"等于没做。30%~66% 之后封面能透出来，文字对比度也够。
   */
  background: linear-gradient(
    to bottom,
    color-mix(in srgb, var(--bg) 30%, transparent) 0%,
    color-mix(in srgb, var(--bg) 48%, transparent) 45%,
    color-mix(in srgb, var(--bg) 66%, transparent) 100%
  );`;
const newAfter = `  /*
   * ★ 只是一层**很淡的暗角**，不是压暗。
   *
   * 作用有两个：
   *   · 上下边缘收一下，让歌词不是硬切在屏幕边上
   *   · 粒子亮的地方给文字垫一点底
   * 所以最深处也只到 42%，中间几乎是通透的 —— 再多就把粒子遮住了。
   */
  background: linear-gradient(
    to bottom,
    color-mix(in srgb, var(--bg) 34%, transparent) 0%,
    color-mix(in srgb, var(--bg) 8%, transparent) 32%,
    color-mix(in srgb, var(--bg) 8%, transparent) 68%,
    color-mix(in srgb, var(--bg) 42%, transparent) 100%
  );`;
if (t.includes(oldAfter)) {
  t = t.replace(oldAfter, newAfter);
  n++;
} else log('!! 暗角未匹配');

// ④ 文字加柔光，弥补"背景没有垫底"
const oldLine = `  color: var(--ink-2);
  opacity: .34;`;
const newLine = `  color: var(--ink-2);
  opacity: .46;
  /*
   * 背景现在是粒子（亮的暗的都有），文字要靠自身描边撑住可读性。
   * 这一层是"暗描边"，和当前行那层柔光叠加使用。
   */
  text-shadow: 0 1px 3px color-mix(in srgb, var(--bg) 75%, transparent),
    0 0 12px color-mix(in srgb, var(--bg) 55%, transparent);`;
if (t.includes(oldLine)) {
  t = t.replace(oldLine, newLine);
  n++;
} else log('!! 歌词行未匹配');

fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
log('改了 ' + n + ' 处');
