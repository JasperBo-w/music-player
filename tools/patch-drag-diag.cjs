/*
 * 拖动卡顿的诊断埋点。
 *
 * 用户说是 B 类："一跳一跳"（丢事件），不是 A 类（拖在后面 = 延迟）。
 *
 * 我已经加了 setPointerCapture，理论上不该丢事件了，但现象还在。
 * 猜了四轮都没解决，所以这次**不再猜，改成量**：
 *
 * 要判断的东西有两个，而且它们的症状都是"一跳一跳"：
 *   ① 穿透状态在拖动中途被改掉了
 *      → 窗口当场收不到鼠标事件 → 拖动断掉 → 光标追上 → 又恢复 → 跳
 *   ② moveBy 的处理速度跟不上指针事件
 *      → IPC 排队 → 窗口落后 → 攒一批一起走 → 跳
 *
 * 埋点：
 *   · dragStart / dragEnd 到底有没有到（冻结机制有没有生效的前提）
 *   · applyLyricMouseBehavior **真正改变状态**时打一行（含是否在拖动中）
 *   · moveBy 的调用次数与耗时，每 2 秒汇总一行
 *
 * 全部用 console.log 打到主进程 stdout —— 它会被 repl-start.ps1 收进 .logs。
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'desktop', 'main.js');
let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const log = (m) => console.log(m);

// ① dragStart / dragEnd 到达情况
t = t.replace(
  `  ipcMain.handle('lyric:dragStart', () => {
    lyricDragging = true;
    return true;
  });`,
  `  ipcMain.handle('lyric:dragStart', () => {
    lyricDragging = true;
    dragStats.starts++;
    console.log('[诊断] dragStart 收到，冻结穿透判定');
    return true;
  });`
);
t = t.replace(
  `  ipcMain.handle('lyric:dragEnd', () => {
    lyricDragging = false;
    applyLyricMouseBehavior();
    scheduleSaveLyricBounds();
    return true;
  });`,
  `  ipcMain.handle('lyric:dragEnd', () => {
    lyricDragging = false;
    dragStats.ends++;
    console.log('[诊断] dragEnd 收到，共收到 moveBy ' + dragStats.moves + ' 次');
    applyLyricMouseBehavior();
    scheduleSaveLyricBounds();
    return true;
  });`
);

// ② moveBy 计数 + 耗时
t = t.replace(
  `  ipcMain.handle('lyric:moveBy', (_e, dx, dy) => {
    if (!lyricWindow || lyricWindow.isDestroyed()) return false;
    const b = lyricWindow.getBounds();
    lyricWindow.setBounds({`,
  `  ipcMain.handle('lyric:moveBy', (_e, dx, dy) => {
    if (!lyricWindow || lyricWindow.isDestroyed()) return false;
    const t0 = Date.now();
    const b = lyricWindow.getBounds();
    lyricWindow.setBounds({`
);
t = t.replace(
  `      width: b.width,
      height: b.height,
    });
    return true;
  });

  /**
   * 开始拖动`,
  `      width: b.width,
      height: b.height,
    });
    dragStats.moves++;
    dragStats.moveMs += Date.now() - t0;
    return true;
  });

  /**
   * 开始拖动`
);

// ③ 穿透状态"真正改变"时打点 —— 这是判断 ① 的关键
t = t.replace(
  `  if (lyricMouseIgnored === shouldIgnore) return;
  lyricMouseIgnored = shouldIgnore;`,
  `  if (lyricMouseIgnored === shouldIgnore) return;
  /*
   * ★ 只有**真正改变**时才到这里。
   * 拖动中如果走到这里，说明冻结没生效 —— 那正是"一跳一跳"的头号嫌疑。
   */
  console.log(
    '[诊断] 穿透状态改变 →',
    shouldIgnore ? '穿透' : '可交互',
    '拖动中=' + lyricDragging,
    'dragStats=' + JSON.stringify(dragStats)
  );
  lyricMouseIgnored = shouldIgnore;`
);

// ④ 统计变量 + 定时汇总
t = t.replace(
  `let lyricDragging = false;`,
  `let lyricDragging = false;
/** 拖动诊断统计，见 dragStats 的汇总日志 */
const dragStats = { starts: 0, ends: 0, moves: 0, moveMs: 0 };`
);

t = t.replace(
  `app.on('will-quit', () => stopMiddleClickWatcher());`,
  `app.on('will-quit', () => stopMiddleClickWatcher());

/*
 * 每 4 秒汇总一次 moveBy 的量与耗时。
 * 如果 moves 很大而 moveMs 也很大，就是"主进程处理不过来、IPC 在排队"（症状②）；
 * 如果 moves 很密但穿透状态在拖动中被改过，就是症状①。
 */
setInterval(() => {
  if (!dragStats.moves && !dragStats.starts) return;
  console.log(
    '[诊断·拖动汇总] moveBy=' + dragStats.moves +
      ' 次  累计耗时=' + dragStats.moveMs + 'ms  平均=' +
      (dragStats.moves ? (dragStats.moveMs / dragStats.moves).toFixed(2) : '0') + 'ms' +
      '  dragStart=' + dragStats.starts + ' dragEnd=' + dragStats.ends +
      '  正在拖动=' + lyricDragging
  );
}, 4000);`
);

fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
console.log('done');
