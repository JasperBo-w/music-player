/*
 * 关掉歌词时**销毁窗口**，而不是 hide()。
 *
 * 现象：不关的时候拖动正常；一旦"关掉再打开"，鼠标事件就一个都到不了
 * 歌词页（日志里 [歌词·指针] pointerdown 恒为 0 条），而与此同时
 * 判定逻辑、轮询存活、锁定状态**全都正常**（探针逐项验证过），
 * 连显式 setIgnoreMouseEvents(false) 也救不回来。
 *
 * 也就是说：hide() → showInactive() 这个循环会把窗口"接收鼠标"的能力弄丢，
 * 而我不知道 Windows/Electron 内部到底哪一步坏了。继续查下去要花很多轮，
 * 而且未必查得出来。
 *
 * ★ 所以不去修那个机制，而是**让它不可能发生**：
 *   关掉 = destroy()，打开 = 重新创建。
 *   重建出来的窗口是一份全新状态，没有"上一次留下了什么"可言。
 *
 * 代价是重建要几十毫秒，但开关歌词本来就是低频操作，用户感知不到。
 * 位置靠 lyricOffsetX/Y 保留，did-finish-load 时推回去，所以开关前后位置不变。
 *
 * 这条经验值得记：**当一个状态机在某个转换上反复出问题、又查不到内部原因时，
 * 消掉那个转换（换成重建）通常比继续查更快、也更可靠。**
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'desktop', 'main.js');
let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const log = (m) => console.log(m);

const start = t.indexOf('function showLyricWindow(on) {');
if (start < 0) {
  log('!! 没找到 showLyricWindow');
  process.exit(1);
}
const end = t.indexOf('\n}', t.indexOf('return !!on;', start));
if (end < 0) {
  log('!! 没找到函数结尾');
  process.exit(1);
}

const neu = `function showLyricWindow(on) {
  if (on) {
    /*
     * 已经在显示就不重复创建（重复创建会多出一个窗口）。
     */
    if (lyricWindow && !lyricWindow.isDestroyed() && lyricWindow.isVisible()) return true;

    /*
     * 每次打开都从"未锁定"开始。
     * 锁定 = 整窗穿透 = 收不到任何鼠标事件，如果它被持久化，
     * 用户就会永久卡住。所以"关掉再打开"必须是一条能出去的通道。
     */
    lyricLocked = false;
    lyricHardLock = false;

    // 若还剩一个已销毁/隐藏的实例，先彻底清掉再建新的
    if (lyricWindow && !lyricWindow.isDestroyed()) {
      stopLyricMousePoller();
      stopMiddleClickWatcher();
      lyricWindow.destroy();
      lyricWindow = null;
    }

    createLyricWindow();
    if (!lyricWindow || lyricWindow.isDestroyed()) return !!on;

    if (!lyricOffsetReady) {
      /* 偏移是**相对屏幕中心**的（0,0 = 正中央），不是窗口坐标 */
      const full = lyricFullBounds();
      lyricOffsetX = 0;
      lyricOffsetY = Math.round(full.height * 0.27);
      lyricOffsetReady = true;
    }
    lyricWindow.webContents.send('lyric:offset', { x: lyricOffsetX, y: lyricOffsetY });
    lyricWindow.showInactive(); // 不抢焦点
    startLyricMousePoller();
    startMiddleClickWatcher();
    lyricMouseIgnored = null;
    applyLyricMouseBehavior();
  } else if (lyricWindow && !lyricWindow.isDestroyed()) {
    /*
     * ★ 关掉 = **销毁**，不是隐藏。
     *
     * hide() 之后再 showInactive()，窗口就再也收不到鼠标事件了
     *（日志里 pointerdown 恒为 0），而各项状态又都正常 —— 查不出原因。
     * 与其继续追那个内部机制，不如消掉这个转换：
     * 重建的窗口是一份全新状态，没有"上一次留下了什么"可言。
     */
    stopLyricMousePoller();
    stopMiddleClickWatcher();
    lyricWindow.destroy();
    lyricWindow = null;
    lyricMouseIgnored = null;
    lyricHotBounds = null;
  }
  return !!on;
}`;

t = t.slice(0, start) + neu + t.slice(end + 2);
fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
log('ok: 关掉改成销毁窗口');
