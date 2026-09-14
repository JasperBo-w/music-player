/*
 * 「配色跟着封面走」—— 从专辑封面取主色，作为界面强调色 + 粒子配色。
 *
 * 设计上的取巧：**不新增一条配色通路**。
 * applySettings 里已经有一条成熟的机制：settings.accentOverride 会同时写
 * --accent / --accent-dim / --accent-rgb，并且把粒子 ribbon 染成同色。
 * 所以这里只要把"从封面算出来的颜色"喂进同一条路，界面和粒子就一起变了 ——
 * 不用去改任何上色代码，也就不会出现"界面变了粒子没变"这种脱节
 *（那种脱节在这个项目里已经发生过一次，见 applySettings 里的注释）。
 *
 * 取色算法刻意做得朴素但稳：
 *   1. 封面画到 32x32 的小 canvas 上（够用，且很快）
 *   2. 丢掉太暗 / 太亮 / 太灰的像素 —— 它们当强调色要么看不见要么刺眼
 *   3. 按 5bit/通道 分桶计数，取最多的那一桶
 *   4. 桶内求平均，再统一提一点饱和度和亮度
 * 取不到合适的颜色时**返回 null**，调用方保持原主题色 ——
 * 黑白封面上取出来的灰如果直接当强调色，整个界面会变得很脏。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const log = (m) => console.log(m);

// ---------- ① settings.js：设置项 + 让 accentOverride 能接封面色 ----------
{
  const f = path.join(root, 'apps', 'ui', 'src', 'settings.js');
  let t = fs.readFileSync(f, 'utf8');
  if (t.includes('coverAccent')) {
    log('settings: 已存在');
  } else {
    // 默认值
    const anchor = "  effect: 'cover',";
    if (t.includes(anchor)) {
      t = t.replace(
        anchor,
        anchor +
          `

  /*
   * 音频驱动的主题色：从当前歌曲封面里取主色，当作强调色用。
   *
   * 分成两项：
   *   coverAccent      用户开关
   *   coverAccentColor 当前取到的颜色（十六进制小写）。它是**算出来的**，
   *                    不是用户设的 —— 存下来只是为了刷新后不必等封面加载
   *                    才能对上色，下次换歌会自动覆盖。
   */
  coverAccent: true,
  coverAccentColor: '',`
      );
      log('ok: 默认值');
    } else {
      log('!! 未找到 effect 默认值');
    }

    // 强调色解析：封面色优先于手动覆盖
    const oldAccent = `  const accent = settings.accentOverride || theme.ui['--accent'];
  if (settings.accentOverride) {
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-dim', shade(accent, 0.62));
    const trip = hexToRgbTriplet(accent);
    if (trip) root.style.setProperty('--accent-rgb', trip);
  }`;
    const newAccent = `  /*
   * 强调色的来源按这个优先级：
   *   ① 封面取色（如果开了，且当前确实取到了颜色）
   *   ② 用户手动指定的强调色
   *   ③ 主题自带的
   * 封面色优先是有意的：用户开了这个开关，就是想让界面跟着歌走；
   * 取不到时自动退回手动/主题色，不会出现"开了开关反而变成默认色"。
   */
  const coverAccent =
    settings.coverAccent && settings.coverAccentColor
      ? String(settings.coverAccentColor)
      : '';
  const accent = coverAccent || settings.accentOverride || theme.ui['--accent'];
  if (coverAccent || settings.accentOverride) {
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-dim', shade(accent, 0.62));
    const trip = hexToRgbTriplet(accent);
    if (trip) root.style.setProperty('--accent-rgb', trip);
  }
  // 让下面第 6 段的粒子上色也认这个颜色
  const accentForParticles = coverAccent || settings.accentOverride;`;
    if (t.includes(oldAccent)) {
      t = t.replace(oldAccent, newAccent);
      log('ok: 强调色优先级');
    } else {
      log('!! 未匹配强调色段');
    }

    // 粒子配色：把判断条件换成 accentForParticles
    const oldPal = `  if (settings.accentOverride) {
    const rgb = hexToRgb01(settings.accentOverride);`;
    const newPal = `  if (accentForParticles) {
    const rgb = hexToRgb01(accentForParticles);`;
    if (t.includes(oldPal)) {
      t = t.replace(oldPal, newPal);
      log('ok: 粒子配色跟随');
    } else {
      log('!! 未匹配粒子配色段');
    }

    fs.writeFileSync(f, t);
  }
}

console.log('done');
