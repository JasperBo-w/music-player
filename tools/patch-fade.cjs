/*
 * 淡入淡出。
 *
 * 现在切歌是硬切（旧歌戛然而止、新歌从全音量开始），暂停也是瞬间静音。
 * 加一层音量渐变之后听感会柔和很多 —— 这是"像正经播放器"和"网页播放器"
 * 的一个明显分界。
 *
 * 实现选择：**直接渐变 audio.volume**，不引入 Web Audio 的 GainNode。
 * 后者理论上更干净（可以做真正的交叉淡化），但代价很大：
 *   · 要建 AudioContext，而 AudioContext 有自动播放策略和 CORS 限制
 *   · 我们这个 audio 的元素音源来自网络接口，一旦接进 AudioContext
 *     就可能因为跨域被静音（需要 crossOrigin + 服务端 CORS 配合）
 * 为了一个淡入淡出付这个代价不划算。音量渐变虽然粗，但听感上够用。
 *
 * 曲线用**平方**而不是线性：
 * 人耳对音量的感知接近对数，线性渐变听起来会"前半段几乎没变、最后突然没了"。
 * 平方之后主观上更像匀速。
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'ui', 'src', 'main.js');
let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const log = (m) => console.log(m);

if (t.includes('function fadeVolumeTo')) {
  log('已存在，跳过');
  process.exit(0);
}

// ① 淡入淡出的实现，插在 applyVolume 之前
const anchor = `function applyVolume() {`;
const block = `/* ------------------------------------------------------------------ */
/* 淡入淡出                                                            */
/* ------------------------------------------------------------------ */

/** 切歌时的淡出时长。太长会显得拖沓，太短听不出效果 —— 220ms 是比较通行的值。 */
const FADE_OUT_MS = 220;
/** 淡入稍微长一点：进歌时柔一点更舒服，而且不会掩盖第一句歌词 */
const FADE_IN_MS = 420;
/** 暂停用短淡出，播放用短淡入（这两个是"随手按"的动作，不该等） */
const PAUSE_FADE_MS = 140;

let fadeRaf = 0;

/**
 * 把音量渐变到目标值。
 *
 * @param {number} target 目标音量（0~1）
 * @param {number} ms     时长
 * @param {Function=} onDone 到达后回调（切歌要等淡出完成再换源）
 */
function fadeVolumeTo(target, ms, onDone) {
  if (fadeRaf) cancelAnimationFrame(fadeRaf);
  const from = audio.volume;
  const to = clamp01(target);
  if (ms <= 0 || Math.abs(to - from) < 0.001) {
    audio.volume = to;
    if (onDone) onDone();
    return;
  }
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / ms);
    /*
     * 平方曲线：人耳对音量近似对数感知，线性渐变听起来会
     * "前半段几乎没变化、最后一下突然没了"。
     */
    const k = p * p;
    audio.volume = clamp01(from + (to - from) * k);
    if (p < 1) {
      fadeRaf = requestAnimationFrame(step);
    } else {
      fadeRaf = 0;
      audio.volume = to;
      if (onDone) onDone();
    }
  };
  fadeRaf = requestAnimationFrame(step);
}

/** 当前该有的音量（考虑静音） */
function targetVolume() {
  return state.muted ? 0 : state.volume;
}

/**
 * 淡入：从当前（通常是 0）升到目标音量。
 * 换歌、点播放、取消静音都走它。
 */
function fadeIn(ms) {
  fadeVolumeTo(targetVolume(), ms == null ? FADE_IN_MS : ms);
}

/** 淡出到 0，完成后回调（换歌要等这一刻再切源） */
function fadeOut(ms, onDone) {
  fadeVolumeTo(0, ms == null ? FADE_OUT_MS : ms, onDone);
}

${anchor}`;

if (t.includes(anchor)) {
  t = t.replace(anchor, block);
  log('ok: 淡入淡出实现');
} else {
  log('!! 没找到 applyVolume');
  process.exit(1);
}

// ② applyVolume 里改音量时，如果正在淡入淡出，直接改会被动画覆盖 —— 先停掉
t = t.replace(
  `function applyVolume() {
  audio.volume = state.muted ? 0 : state.volume;`,
  `function applyVolume() {
  /*
   * 用户手动拖音量条时，**必须取消正在进行的淡入淡出** ——
   * 否则动画每一帧都会把 volume 写回去，用户会看到滑块跟着乱跳。
   */
  if (fadeRaf) {
    cancelAnimationFrame(fadeRaf);
    fadeRaf = 0;
  }
  audio.volume = state.muted ? 0 : state.volume;`
);

fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
console.log('done');
