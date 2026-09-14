/*
 * 拖动卡顿的真凶（有数据了）。
 *
 * 诊断输出：
 *     moveBy=223 次  累计=2076ms  平均=9.31ms
 *     穿透状态改变 189 条，其中"拖动中=true" **0 条**
 *
 * ① 冻结生效 → "拖动中途被切成穿透"这条排除
 * ② setBounds 每次要 9.31ms → 主进程每秒最多处理约 107 次
 *    而鼠标事件远超这个数（日志里 dx=0.6666 这种小数说明是高刷新率鼠标
 *    在报亚像素位移）→ IPC 排队 → 窗口落后 → 攒一批一起冲 → "一跳一跳"
 *
 * 修法：**在主进程合并位移，每帧最多真正移一次。**
 *
 * 关键区别：这是**合并（coalescing）**，不是**节流丢弃（throttling）**——
 * 位移是**累加**的，一次都不会丢，只是把"很多次 1px"合成"一次 12px"。
 * 所以窗口位置始终精确，观感上是连续移动而不是跳跃。
 *
 * （我早先在渲染端用 requestAnimationFrame 做过类似的合并，但那次是
 *  在**渲染进程**——它只是少发了 IPC，主进程该做的 setBounds 一次没少，
 *  而且凭空多了一帧延迟。合并在主进程做才对，因为瓶颈就在这里。）
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'desktop', 'main.js');
let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const log = (m) => console.log(m);

if (t.includes('applyPendingLyricMove')) {
  log('已存在，跳过');
  process.exit(0);
}

// ① 合并逻辑 + 变量
t = t.replace(
  `/** 正在被用户拖动。拖动期间必须冻结穿透判定，否则窗口一挪就被判成"光标不在上面"而穿透，拖动会断 */`,
  `/** 待应用的拖动位移（累加，不丢），见 applyPendingLyricMove */
let pendingMoveX = 0;
let pendingMoveY = 0;
let pendingMoveTimer = null;

/** 正在被用户拖动。拖动期间必须冻结穿透判定，否则窗口一挪就被判成"光标不在上面"而穿透，拖动会断 */`
);

const anchor = `  ipcMain.handle('lyric:moveBy', (_e, dx, dy) => {`;
const newHandler = `  /*
   * 合并位移，每帧最多真正移动窗口一次。
   *
   * 实测 setBounds 要 9.31ms，而拖动时鼠标每秒能发几百个 pointermove ——
   * 逐个处理的话主进程根本追不上，IPC 排队之后窗口就会"攒一批一起冲"。
   *
   * 16ms ≈ 一帧：合并后每秒最多 62 次 setBounds（约 0.58 的主进程占用），
   * 既能跟上，移动也是连续的。
   *
   * 位移是**累加**的，所以窗口最终一定落在精确的位置上 ——
   * 这不是"丢弃式节流"，只是把碎步合并成整步。
   */
  ipcMain.handle('lyric:moveBy', (_e, dx, dy) => {
    if (!lyricWindow || lyricWindow.isDestroyed()) return false;
    pendingMoveX += Number(dx) || 0;
    pendingMoveY += Number(dy) || 0;
    if (!pendingMoveTimer) pendingMoveTimer = setTimeout(applyPendingLyricMove, 16);
    return true;
  });

`;
if (t.includes(anchor)) {
  // 把原来那个完整 handler 换掉
  const s = t.indexOf(anchor);
  const e = t.indexOf('  });', t.indexOf('dragStats.moveMs += Date.now() - t0;')) + '  });'.length;
  t = t.slice(0, s) + newHandler.trimStart() + t.slice(e + 1);
  log('ok: moveBy 改成合并');
} else {
  log('!! 没找到 moveBy 处理器');
}

// ② 真正执行移动的函数
t = t.replace(
  `function applyLyricMouseBehavior() {`,
  `/**
 * 把攒下来的位移一次性应用掉。
 *
 * 用 setPosition 而不是 setBounds：窗口尺寸从来不在这里变，
 * setPosition 少一层尺寸协商，比 setBounds 便宜。
 */
function applyPendingLyricMove() {
  pendingMoveTimer = null;
  if (!pendingMoveX && !pendingMoveY) return;
  const dx = pendingMoveX;
  const dy = pendingMoveY;
  pendingMoveX = 0;
  pendingMoveY = 0;
  if (!lyricWindow || lyricWindow.isDestroyed()) return;
  const b = lyricWindow.getBounds();
  const t0 = Date.now();
  lyricWindow.setPosition(Math.round(b.x + dx), Math.round(b.y + dy));
  dragStats.moves++;
  dragStats.moveMs += Date.now() - t0;
}

function applyLyricMouseBehavior() {`
);

// ③ 拖动结束时把剩下的位移补上，别让最后一点被吞掉
t = t.replace(
  `  ipcMain.handle('lyric:dragEnd', () => {
    lyricDragging = false;
    dragStats.ends++;`,
  `  ipcMain.handle('lyric:dragEnd', () => {
    // 收尾前把还没应用的位移补上，否则松手时最后几像素会丢
    if (pendingMoveTimer) {
      clearTimeout(pendingMoveTimer);
      applyPendingLyricMove();
    }
    lyricDragging = false;
    dragStats.ends++;`
);

fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
console.log('done');
