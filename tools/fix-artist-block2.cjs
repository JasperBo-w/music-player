/*
 * 把"歌手/专辑"那块从 ipcMain.handle('account',...) 的参数之间搬出来，
 * 放到那个调用**之前**。
 *
 * 结构现状（行号）：
 *   358  ipcMain.handle(          ← account 的调用开始
 *   359    'account',
 *   360-363  注释
 *   366-460  ← 我插进来的块（错误地夹在参数之间）
 *   ...    wrap('account', ...)   ← account 真正的参数
 *   462  );                       ← account 调用结束
 *
 * 正确做法：把 366-460 搬到 358 之前。
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'desktop', 'main.js');
const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);

// 精确定位（1-based → 0-based）
const blockStart = lines.findIndex((l) => l.includes('歌手 / 专辑详情')) - 1; // 含 /* ---- */ 那行
const endMark = lines.findIndex((l) => l.includes("'album:songs'"));
let blockEnd = -1;
for (let j = endMark; j < endMark + 14; j++) {
  if (lines[j] && lines[j].trim() === ');') {
    blockEnd = j;
    break;
  }
}
if (blockStart < 0 || blockEnd < 0) {
  console.log('!! 定位失败', { blockStart, blockEnd });
  process.exit(1);
}

// account 那个 ipcMain.handle( 的位置
const accWrap = lines.findIndex((l) => l.includes("wrap('account', async"));
let handleAt = -1;
for (let i = accWrap; i > accWrap - 8; i--) {
  if (lines[i] && lines[i].trim() === 'ipcMain.handle(') {
    handleAt = i;
    break;
  }
}
if (handleAt < 0) {
  console.log('!! 没找到 account 的 ipcMain.handle(');
  process.exit(1);
}
console.log('块 ' + (blockStart + 1) + '~' + (blockEnd + 1) + ' → 插到第 ' + (handleAt + 1) + ' 行之前');

const block = lines.slice(blockStart, blockEnd + 1);
const rest = lines.slice(0, blockStart).concat(lines.slice(blockEnd + 1));
// 删掉块之后，handleAt 的位置可能左移
const shift = rest.findIndex((l) => l.includes("wrap('account', async"));
let target = -1;
for (let i = shift; i > shift - 8; i--) {
  if (rest[i] && rest[i].trim() === 'ipcMain.handle(') {
    target = i;
    break;
  }
}
if (target < 0) {
  console.log('!! 重定位失败');
  process.exit(1);
}
const out = rest.slice(0, target).concat(block, [''], rest.slice(target));
fs.writeFileSync(f, out.join('\r\n'));
console.log('done, 插到第 ' + (target + 1) + ' 行之前');
