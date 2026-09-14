/*
 * 补丁：暂停播放后，所有粒子效果回到「初始状态」。
 *
 * 用户原话："声纹星盘以及其他的或者后续新加的，也是暂停播放后回到初始的状态"。
 *
 * 现状：this.paused 只在窗口隐藏时触发（this.paused = document.hidden），
 * 跟音频播放状态无关。所以点暂停后 uTime 照样往前走 ——
 * 星盘还在转、扫描线还在扫、雨还在下。
 *
 * 做法（一处机制覆盖所有效果，包括以后新加的）：
 *   所有效果的动画都挂在 uTime 上，而 uTime = this.elapsed * 速度。
 *   于是只要让 **elapsed 只在播放时推进、暂停时平滑收回 0**，
 *   每个效果就都回到了它 t=0 的姿态。不必逐个效果改代码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const log = (m) => console.log(m);
const edit = (file, from, to, label) => {
  let t = fs.readFileSync(file, 'utf8');
  if (!t.includes(from)) {
    log('!! 未匹配: ' + label);
    return false;
  }
  if (t.includes(to)) {
    log('已存在，跳过: ' + label);
    return true;
  }
  t = t.replace(from, to);
  fs.writeFileSync(file, t);
  log('ok: ' + label);
  return true;
};

const pf = path.join(root, 'apps', 'ui', 'src', 'particles.js');
const mf = path.join(root, 'apps', 'ui', 'src', 'main.js');

edit(
  pf,
  '    this.paused = false;',
  `    this.paused = false;
    /*
     * 音频是否在播放。
     *
     * 暂停时要把 uTime 收回 0，让**所有**效果回到初始姿态 ——
     * 不这么做的话暂停后星盘还在转、扫描线还在扫、雨还在下，
     * 观感是"暂停了但动画没停"。
     * 由 main.js 的 play/pause 事件驱动（见 setPlaying）。
     */
    this.playing = true;`,
  'this.playing'
);

edit(
  pf,
  `  setRenderScale(s) {`,
  `  /**
   * 音频播放状态。暂停时所有效果回到初始状态。
   *
   * 为什么做成"收 uTime"而不是逐个效果去改：
   * 所有效果的动画都挂在 uTime 上，收它一处就等于全部复位，
   * 而且**以后新加的效果自动适用** —— 用户要的正是
   * "声纹星盘以及其他的或者后续新加的"。
   */
  setPlaying(on) {
    this.playing = Boolean(on);
  }

  setRenderScale(s) {`,
  'setPlaying'
);

edit(
  pf,
  '    this.elapsed += dt;',
  `    /*
     * ★ 时间推进：只在播放时往前走；暂停时平滑收回 0。
     *
     * 收 0 就是"回到初始状态"：uTime = elapsed × 速度，
     * 所有效果的姿态都是 uTime 的函数，所以 elapsed 归零
     * 等于全部效果复位到 t=0 的那个样子。
     *
     * 用缓动而不是直接置 0，是为了让它"自己走回去"而不是啪一下跳变；
     * 系数 3.5 大约是 0.6 秒走完，跟暂停这个动作的节奏合得上。
     */
    if (this.playing) {
      this.elapsed += dt;
    } else if (this.elapsed > 1e-4) {
      this.elapsed += (0 - this.elapsed) * Math.min(1, dt * 3.5);
      if (this.elapsed < 1e-3) this.elapsed = 0;
    }`,
  'elapsed 推进/回收'
);

edit(
  mf,
  `audio.addEventListener('play', () => {
  $('#pb-toggle').textContent = '⏸';
});
audio.addEventListener('pause', () => {
  $('#pb-toggle').textContent = '▶';
});`,
  `audio.addEventListener('play', () => {
  $('#pb-toggle').textContent = '⏸';
  // 播放：效果恢复运动
  if (bg) bg.setPlaying(true);
});
audio.addEventListener('pause', () => {
  $('#pb-toggle').textContent = '▶';
  /*
   * 暂停：让所有粒子效果回到**初始状态**。
   * 否则 uTime 会继续推进 —— 星盘还在转、扫描线还在扫、雨还在下，
   * 看起来就是"暂停了但动画没停"。
   */
  if (bg) bg.setPlaying(false);
});`,
  '接上 play/pause 事件'
);

console.log('done');
