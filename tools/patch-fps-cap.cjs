/*
 * 给粒子渲染循环**加帧率上限**。
 *
 * 起因：用户反馈"开着音乐窗口，鼠标周围滑动也是一顿一顿的" ——
 * 而且是主窗口和桌面歌词都有。两条线索合起来指向同一个原因：
 *
 *   **GPU 被粒子渲染占满了。**
 *
 * 我早先测过：粒子背景跑满刷新率（165 FPS，等于垂直同步的上限）。
 * 而 Windows 的鼠标光标是 **DWM 用 GPU 合成的** —— GPU 没有余量时，
 * 光标就会一顿一顿，而且这个现象**跟鼠标下面是什么窗口无关**，
 * 只要那个吃 GPU 的窗口开着就会发生。正好对上用户描述的"周围滑动也一样"。
 *
 * 一个音乐可视化跑 165 FPS 是纯浪费：动画本身是缓慢的流动，
 * 60 FPS 和 165 FPS 在观感上分不出来，但 GPU 占用差近三倍。
 *
 * 做法：记下上一次真正渲染的时刻，没到间隔就**只更新逻辑、不出图**。
 * 注意是"跳过渲染"而不是"跳过整个 tick" —— 时间推进、音频分析这些
 * 每帧都要更新，否则动画会变慢。
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'ui', 'src', 'particles.js');
let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const log = (m) => console.log(m);

if (t.includes('this.renderMinGap')) {
  log('已存在，跳过');
  process.exit(0);
}

// ① 状态：帧率上限
const anchor = `  _tick() {
    if (this.disposed) return;
    requestAnimationFrame(this._tick);`;
const neu = `  _tick() {
    if (this.disposed) return;
    requestAnimationFrame(this._tick);

    /*
     * ★ 帧率上限。
     *
     * 原来不限帧 —— 于是粒子背景跑满刷新率（这台机器是 165Hz），
     * GPU 被吃满，而 **Windows 的鼠标光标是 DWM 用 GPU 合成的**，
     * 结果就是"开着这个窗口，鼠标到哪儿都一顿一顿"。
     * 用户的原话："如果开着音乐窗口，鼠标周围滑动也是一样。"
     *
     * 60 FPS 对"缓慢流动的粒子"来说和 165 完全分不出来，
     * 但 GPU 占用差近三倍 —— 省下来的正好够 DWM 把光标画顺。
     *
     * 这里**只跳过渲染**，不跳过整个 tick：时间推进、音频分析
     * 这些每帧都要更新，跳了动画就会变慢。
     */
    const nowMs = performance.now();
    if (this.renderMinGap && nowMs - (this._lastRenderAt || 0) < this.renderMinGap) {
      return;
    }
    this._lastRenderAt = nowMs;`;
if (t.includes(anchor)) {
  t = t.replace(anchor, neu);
  log('ok: 帧率上限');
} else {
  log('!! 没找到 _tick');
  process.exit(1);
}

// ② 在构造里初始化（60 FPS = 16.7ms）
const ctorAnchor = `    this.playing = true;`;
if (t.includes(ctorAnchor)) {
  t = t.replace(
    ctorAnchor,
    `    this.playing = true;
    /*
     * 渲染的最小间隔（毫秒）。60 FPS ≈ 16.7ms。
     * 设成 0 就等于不限帧（老行为），排查时可以用 __mpSet 改。
     */
    this.renderMinGap = 1000 / 60;
    this._lastRenderAt = 0;`
  );
  log('ok: 构造里初始化');
} else {
  log('!! 构造锚点没匹配');
}

fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
console.log('done');
