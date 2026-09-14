/*
 * 全屏歌词：接管应用的边框。
 *
 * 用户看完截图之前的反馈是"背景不是粒子的吗"，改成透明之后粒子出来了 ✓，
 * 但**侧栏、播放条、以及 3D 舞台上的歌名也一起露出来了** ✗ ——
 * 看上去不是"全屏歌词"，而是"叠在应用上面的一层字" ✗
 *
 * 浮层只负责自己这一层，应用的边框它管不着。正确做法是**复用已有的沉浸模式**
 *（body.immersive 会收起侧栏、隐藏播放条、淡化窗口按钮）。
 *
 * 另外 3D 舞台上也在显示歌词和歌名 —— 那是给"正在播放"页用的，
 * 全屏歌词开着时它会和浮层重复（截图里就是两行一样的字）。要清掉。
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'ui', 'src', 'main.js');
let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const log = (m) => console.log(m);
let n = 0;

// ① 打开：进沉浸模式 + 清掉 3D 舞台文字
const oldOpen = `  flOpen = true;
  flActive = -1;
  syncFullLyrics();
}`;
const newOpen = `  /*
   * ★ 接管应用的边框。
   *
   * 沉浸模式会收起侧栏、隐藏播放条、淡化窗口按钮 —— 全屏歌词要的正是这个。
   * 不复用的话，浮层再漂亮也只是"叠在应用上面的一层字"。
   *
   * 先记下用户原本是不是沉浸模式：关掉全屏歌词时要**还原成原样**，
   * 不能无条件退出沉浸（那会把用户自己的设置改掉）。
   */
  flWasImmersive = document.body.classList.contains('immersive');
  setImmersive(true);
  // 3D 舞台上的歌词/歌名要清掉，否则和浮层重复
  if (bg && bg.setStageText) bg.setStageText('', '');

  flOpen = true;
  flActive = -1;
  syncFullLyrics();
}`;
if (t.includes(oldOpen)) {
  t = t.replace(oldOpen, newOpen);
  n++;
} else log('!! openFullLyrics 结尾未匹配');

// ② 关闭：还原沉浸状态 + 恢复舞台文字
const oldClose = `function closeFullLyrics() {
  flOpen = false;
  flActive = -1;
  switchView('nowplaying');
}`;
const newClose = `function closeFullLyrics() {
  flOpen = false;
  flActive = -1;
  setImmersive(flWasImmersive);
  switchView('nowplaying');
  // 让 3D 舞台的文字回来（updateStageText 里那道 flOpen 守卫此刻已经放行了）
  updateStageText();
}`;
if (t.includes(oldClose)) {
  t = t.replace(oldClose, newClose);
  n++;
} else log('!! closeFullLyrics 未匹配');

// ③ 声明 flWasImmersive
const oldDecl = `let flOpen = false;
let flActive = -1;`;
const newDecl = `let flOpen = false;
let flActive = -1;
/** 打开全屏歌词之前是不是沉浸模式 —— 关掉时要还原成原样，不能改掉用户的设置 */
let flWasImmersive = false;`;
if (t.includes(oldDecl)) {
  t = t.replace(oldDecl, newDecl);
  n++;
} else log('!! flOpen 声明未匹配');

// ④ updateStageText 里加守卫：全屏歌词开着时，舞台文字保持空白
const oldGuard = `  syncFullLyrics();

  if (line && song) bg.setStageText(line, song.name);`;
const newGuard = `  syncFullLyrics();

  /*
   * 全屏歌词开着时，3D 舞台上的文字要**保持空白** ——
   * 那里的歌词和歌名是给"正在播放"页用的，全屏歌词时和浮层重复。
   * 放在 syncFullLyrics 之后、真正设置之前，所以每帧都会维持空白。
   */
  if (flOpen) {
    bg.setStageText('', '');
    return;
  }

  if (line && song) bg.setStageText(line, song.name);`;
if (t.includes(oldGuard)) {
  t = t.replace(oldGuard, newGuard);
  n++;
} else log('!! updateStageText 守卫未匹配');

fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
log('改了 ' + n + ' 处');
