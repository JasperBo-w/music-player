/*
 * 把淡入淡出接到换歌 / 播放暂停上。
 *
 * ★ 换歌的切入点很顺手：playAt 开头要先异步取播放地址（一次网络请求），
 *   这段时间正好让旧歌淡出 —— 等地址拿到、audio.src 被替换时，
 *   音量已经降到 0 了。**不需要把那个长函数拆开重排。**
 *
 *   playAt()
 *     ├─ fadeOut(220ms)        ← 旧歌开始淡出
 *     ├─ await 取地址           ← 网络时间（通常一两百毫秒）覆盖了淡出
 *     ├─ audio.src = 新地址     ← 此刻音量已经是 0，不会有硬切
 *     └─ await audio.play()
 *          └─ fadeIn(420ms)    ← 新歌从 0 升上来
 *
 * 暂停/播放同理，只是时长更短（随手按的动作不该等）。
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'ui', 'src', 'main.js');
let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const log = (m) => console.log(m);
let n = 0;

// ① 换歌开头：淡出旧歌（不等待 —— 让取地址的网络时间覆盖它）
const oldAt = `async function playAt(i, dir = 'next', isSkip = false) {
  if (i < 0 || i >= state.queue.length) return;`;
const newAt = `async function playAt(i, dir = 'next', isSkip = false) {
  if (i < 0 || i >= state.queue.length) return;
  /*
   * 旧歌先淡出（**不等它结束**）。
   * 后面还要 await 取播放地址，那段时间正好覆盖这次淡出 ——
   * 等 audio.src 被替换时音量已经到 0，所以不会有"戛然而止"。
   */
  if (audio.src && !audio.paused) fadeOut(FADE_OUT_MS);`;
if (t.includes(oldAt)) {
  t = t.replace(oldAt, newAt);
  n++;
} else log('!! playAt 开头没匹配');

// ② 换歌之后：淡入新歌
const oldPlay = `  audio.src = info.url;
  try {
    await audio.play();
  } catch (e) {
    toast(\`播放被拒绝：\${e.message}\`, true);
  }`;
const newPlay = `  audio.src = info.url;
  // 换源会把音量留在淡出后的 0，这里从头开始升
  audio.volume = 0;
  try {
    await audio.play();
    fadeIn(FADE_IN_MS);
  } catch (e) {
    toast(\`播放被拒绝：\${e.message}\`, true);
  }`;
if (t.includes(oldPlay)) {
  t = t.replace(oldPlay, newPlay);
  n++;
} else log('!! 换源那段没匹配');

// ③ 播放/暂停按钮
const oldToggle = `  if (audio.paused) audio.play();
  else audio.pause();
});`;
const newToggle = `  if (audio.paused) {
    audio.play();
    fadeIn(PAUSE_FADE_MS);
  } else {
    /*
     * 暂停**延迟到淡出结束**再执行。
     * 直接 pause() 是瞬时的，淡出就没有意义了。
     * 140ms 的延迟人手感觉不到。
     */
    fadeOut(PAUSE_FADE_MS, () => audio.pause());
  }
});`;
if (t.includes(oldToggle)) {
  t = t.replace(oldToggle, newToggle);
  n++;
} else log('!! 播放/暂停按钮没匹配');

// ④ 单曲循环重播：也要淡入，否则第二遍是硬起
const oldEnded = `  if (state.playMode === 'single') {
    audio.currentTime = 0;
    audio.play();
    return;
  }`;
const newEnded = `  if (state.playMode === 'single') {
    // 单曲循环也淡一下：接缝处的声音突变最容易听出来
    audio.currentTime = 0;
    audio.volume = 0;
    audio.play();
    fadeIn(FADE_IN_MS);
    return;
  }`;
if (t.includes(oldEnded)) {
  t = t.replace(oldEnded, newEnded);
  n++;
} else log('!! 单曲循环没匹配');

fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
log('接了 ' + n + ' 处');
