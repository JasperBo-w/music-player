/*
 * 拖动改成"窗口不动、只动内容"。
 *
 * 实测依据（这一晚测出来的硬数据）：
 *   · Win32 直接 SetWindowPos 移动这个窗口      3.68ms
 *   · Electron setPosition 移动同一个窗口       10.5ms（加了 focusable:false 之后）
 *   · 拖动需要每秒上百次移动
 *   → 10.5ms × 上百次 = 主进程被占满，**必然跟不上手**
 *
 * 这个开销在 Electron 层面绕不过去（它没把 SWP_NOSIZE|NOZORDER|NOACTIVATE
 * 那些"跳过多余动作"的标志传全）。所以换思路：
 *
 *   ★ 窗口铺满屏幕，**永远不动**；歌词内容用 CSS transform 在里面平移。
 *     transform 是 GPU 合成的，改它几乎不花钱 → 拖动天然跟手。
 *
 * 窗口铺满屏幕不会干扰别的东西：
 *   · 它是透明的，除了文字什么都不画
 *   · 平时整体鼠标穿透（setIgnoreMouseEvents），只在光标落到文字上时才接管
 *
 * 位置记忆也随之改成记"内容偏移"，而不是窗口位置。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const mainFile = path.join(root, 'apps', 'desktop', 'main.js');
const log = (m) => console.log(m);
const readNorm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const writeNorm = (p, t) => fs.writeFileSync(p, t.replace(/\n/g, '\r\n'));

let t = readNorm(mainFile);
const edits = [];
const sub = (from, to, label) => {
  if (t.includes(from)) {
    t = t.replace(from, to);
    edits.push(label);
  } else {
    edits.push('!! ' + label);
  }
};

// ① 窗口尺寸：改成铺满显示器工作区
sub(
  `const LYRIC_W = 900;
const LYRIC_H = 190;`,
  `/*
 * ★ 窗口铺满显示器工作区，**拖动时它一动不动**。
 *
 * 原来窗口只有 900x190、跟着鼠标走 —— 而实测 Electron 移动一次窗口要 10.5ms，
 * 拖动时每秒要移动上百次，主进程必然被占满，手感就是"不跟手"。
 * 铺满之后，拖动只改内容的 transform（GPU 合成，几乎免费）。
 */
const LYRIC_W = 900;
const LYRIC_H = 190;

/** 歌词窗口铺满哪块屏幕（用主屏的工作区，避开任务栏） */
function lyricFullBounds() {
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    return { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
  } catch {
    return { x: 0, y: 0, width: LYRIC_W, height: LYRIC_H };
  }
}`
);

// ② 建窗口时用铺满的尺寸
sub(
  `  const b = loadLyricBounds() || defaultLyricBounds();

  lyricWindow = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: LYRIC_W,
    height: LYRIC_H,`,
  `  /*
   * 窗口铺满屏幕（不再是 900x190 的小条）。
   * 位置由"内容偏移"决定，所以窗口本身固定不动 —— 见文件开头那段说明。
   */
  const b = lyricFullBounds();

  lyricWindow = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,`
);

// ③ moveBy：不再移动窗口，转发给页面
const moveStart = t.indexOf(`  /*
   * 合并位移，每帧最多真正移动窗口一次。`);
const moveEnd = t.indexOf(`  /** 开始拖动：先冻结穿透判定`);
if (moveStart >= 0 && moveEnd > moveStart) {
  t =
    t.slice(0, moveStart) +
    `  /*
   * ★ 拖动：**不移动窗口**，把位移转发给页面，由它改内容的 transform。
   *
   * 这是实测之后唯一走得通的做法：
   *   Electron 移动一次窗口 10.5ms，而拖动每秒要上百次 → 必然跟不手。
   *   transform 由 GPU 合成，改它几乎不花钱 → 天然跟手。
   *
   * 窗口铺满屏幕，所以内容在屏幕任何位置都在窗口内，不会被裁掉。
   */
  ipcMain.handle('lyric:moveBy', (_e, dx, dy) => {
    if (!lyricWindow || lyricWindow.isDestroyed()) return false;
    lyricWindow.webContents.send('lyric:move', { dx: Number(dx) || 0, dy: Number(dy) || 0 });
    dragStats.moves++;
    return true;
  });

  /** 页面把当前偏移报回来，用于落盘与热点换算 */
  ipcMain.handle('lyric:offset', (_e, off) => {
    if (!off) return false;
    lyricOffsetX = Number(off.x) || 0;
    lyricOffsetY = Number(off.y) || 0;
    scheduleSaveLyricBounds();
    return true;
  });

` +
    t.slice(moveEnd);
  edits.push('ok: moveBy 改成转发');
} else {
  edits.push('!! 没定位到 moveBy 段');
}

// ④ 位置记忆：改成记内容偏移
sub(
  `function loadLyricBounds() {
  let s = null;
  try {
    s = JSON.parse(fs.readFileSync(LYRIC_STATE_FILE(), 'utf8'));
  } catch {
    return null;
  }`,
  `/** 内容偏移（相对窗口左上角）。窗口铺满屏幕，位置全靠这个 */
let lyricOffsetX = 0;
let lyricOffsetY = 0;
/** 首次显示时页面会来要初始偏移 */
let lyricOffsetReady = false;

function loadLyricBounds() {
  let s = null;
  try {
    s = JSON.parse(fs.readFileSync(LYRIC_STATE_FILE(), 'utf8'));
  } catch {
    return null;
  }`
);

// ⑤ 保存：存偏移而不是窗口位置
sub(
  `    const b = mainWindow.isMaximized() || mainWindow.isFullScreen()
      ? mainWindow.getNormalBounds()
      : mainWindow.getBounds();`,
  `    /*
     * 窗口铺满屏幕、永远不动，所以要存的是**内容偏移**。
     * 兼容旧格式：老文件里存的是窗口坐标，读出来当作"默认居中所用的输入"。
     */
    const b = { x: lyricOffsetX, y: lyricOffsetY, isOffset: true };`
);

// ⑥ 显示时把偏移推给页面
sub(
  `    if (!lyricWindow.isDestroyed()) {
      lyricWindow.showInactive(); // 不抢焦点`,
  `    if (!lyricWindow.isDestroyed()) {
      /*
       * 默认位置：屏幕中下方（原来看起来像"小条贴在底部"的位置）。
       * 窗口铺满之后这个位置要换算成**内容偏移**。
       */
      if (!lyricOffsetReady) {
        const full = lyricFullBounds();
        lyricOffsetX = Math.round((full.width - LYRIC_W) / 2);
        lyricOffsetY = Math.round(full.height - LYRIC_H - 56);
        lyricOffsetReady = true;
      }
      lyricWindow.webContents.send('lyric:offset', { x: lyricOffsetX, y: lyricOffsetY });
      lyricWindow.showInactive(); // 不抢焦点`
);

// ⑦ 拖动开始/结束时也把偏移同步一次（防止页面和主进程不一致）
sub(
  `  ipcMain.handle('lyric:dragStart', () => {
    lyricDragging = true;`,
  `  ipcMain.handle('lyric:dragStart', () => {
    if (lyricWindow && !lyricWindow.isDestroyed()) {
      lyricWindow.webContents.send('lyric:offset', { x: lyricOffsetX, y: lyricOffsetY });
    }
    lyricDragging = true;`
);

writeNorm(mainFile, t);
edits.forEach(log);
