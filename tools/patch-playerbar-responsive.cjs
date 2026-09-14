/*
 * 修「窄窗口下播放条元素重叠」。
 *
 * 根因不在宽度不够，而在**grid/flex 子项的默认 min-width: auto** ——
 * 它不允许子项收缩到内容宽度以下。于是宽度不足时子项**不会变窄**，
 * 而是直接压到邻居身上（用户截图里"音量图标跟时长重叠"就是这个）。
 *
 * 播放条那几列：
 *   grid-template-columns: 52px minmax(110px,1.1fr) auto minmax(160px,1.5fr) auto
 *                         封面  歌曲信息           控制   进度条            右侧杂项
 * 右半边（进度 + 音量 + FPS + 音质 + 词 + 倍速）在窄窗口下总宽早就超了，
 * 而 auto 和 minmax 都不肯让步 → 重叠。
 *
 * 两处修：
 *   ① 给会挤的那些子项加 min-width: 0，让它们**可以收缩**
 *   ② 按宽度**逐级收起**次要元素（FPS → 音质 → 倍速），
 *      顺序按"不重要程度"排 —— 先收最没用的
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'ui', 'src', 'styles.css');
let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const log = (m) => console.log(m);

if (t.includes('/* 播放条：允许收缩')) {
  log('已存在，跳过');
  process.exit(0);
}

const anchor = `/* 窄窗口：音量条收起来，只留静音按钮 */
@media (max-width: 1180px) {
  #vol, .vol-value { display: none; }
}

@media (max-width: 980px) {
  .pb-volume { border-right: 0; }
  #quality-chip { display: none; }
}

@media (max-width: 900px) {
  .pb-extra { display: none; }
}`;

const neu = `/* ------------------------------------------------------------------ */
/* 播放条：允许收缩 + 逐级收起                                          */
/* ------------------------------------------------------------------ */

/*
 * ★ min-width: 0 是这里的关键。
 *
 * grid/flex 子项默认 min-width: auto = "不许窄于内容"，
 * 于是宽度不够时它们不收缩、直接压到邻居身上（重叠）。
 * 显式给 0 之后它们才会真的变窄。
 */
.pb-progress,
.pb-extra,
.pb-meta,
.pb-volume {
  min-width: 0;
}

/* 进度条：能缩，但保住一个可用长度，别缩成一条线 */
.pb-progress input[type='range'] {
  min-width: 70px;
  flex: 1 1 auto;
}

/* 右侧杂项允许被压缩（里面的 chip 各自还有最小宽度，不会挤成一团） */
.pb-extra {
  flex-wrap: nowrap;
  overflow: hidden;
}

/*
 * 逐级收起。按"不重要程度"排：先收最没用的。
 *
 * 1300 —— FPS 芯片（调试用，用户平时不看）
 * 1180 —— 音量条（静音按钮还在，够用）
 * 1050 —— 音质芯片
 * 980  —— 倍速芯片
 * 900  —— 整个右侧杂项
 */
@media (max-width: 1300px) {
  #fps-chip { display: none; }
}

@media (max-width: 1180px) {
  #vol, .vol-value { display: none; }
}

@media (max-width: 1050px) {
  #quality-chip { display: none; }
}

@media (max-width: 980px) {
  .pb-volume { border-right: 0; }
  #speed-chip { display: none; }
}

@media (max-width: 900px) {
  .pb-extra { display: none; }
}`;

if (t.includes(anchor)) {
  t = t.replace(anchor, neu);
  fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
  log('ok: 播放条响应式重写');
} else {
  log('!! 没找到原来的断点块');
}
