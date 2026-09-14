/*
 * 把我插入的那块"歌手/专辑"代码从 ipcMain.handle('account',...) 内部搬出来。
 *
 * 事故经过：我用 `wrap('account', async () => {` 当锚点插入，
 * 而那一行只是 `ipcMain.handle(` 的**参数** —— 于是整块代码被塞进了
 * 那个调用内部，语法直接坏掉（missing ) after argument list）。
 *
 * 这已经是同一个坑第二次了（写"退出登录"时也一样）。
 * **锚点必须选一个"块级"位置**：要么在某个函数定义之前，
 * 要么在某个完整语句之后 —— 绝不能选一个"某个调用内部的某一行"。
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'desktop', 'main.js');
const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);

// 找块的起止：从"歌手 / 专辑详情"的注释头，到 album:songs 的 ");" 为止
const markerAt = lines.findIndex((l) => l.includes('歌手 / 专辑详情'));
if (markerAt < 0) {
  console.log('!! 没找到标记');
  process.exit(1);
}
// 往上吃掉 /* ---- */ 分隔线的第一行
let start = markerAt;
if (lines[start - 1] && lines[start - 1].trim() === '/* ------------------------------------------------------------------ */') start--;
// 往下找 album:songs 之后那个收尾的 ");"
let end = -1;
for (let i = markerAt; i < lines.length; i++) {
  if (lines[i].includes("'album:songs'")) {
    for (let j = i; j < i + 12; j++) {
      if (lines[j] && lines[j].trim() === ');') {
        end = j;
        break;
      }
    }
    break;
  }
}
if (end < 0) {
  console.log('!! 没找到块结尾');
  process.exit(1);
}
const block = lines.slice(start, end + 1);
console.log('块: ' + (start + 1) + ' ~ ' + (end + 1) + ' 行，共 ' + block.length + ' 行');

// 删掉它
const rest = lines.slice(0, start).concat(lines.slice(end + 1));

// 找到 wrap('account' 所在的 ipcMain.handle( 那一行
const accAt = rest.findIndex((l) => l.includes("wrap('account', async"));
if (accAt < 0) {
  console.log('!! 没找到 account 处理器');
  process.exit(1);
}
// 往上找它所属的 ipcMain.handle(
let insertAt = -1;
for (let i = accAt; i >= 0 && i > accAt - 8; i--) {
  if (rest[i].trim() === 'ipcMain.handle(') {
    insertAt = i;
    break;
  }
}
if (insertAt < 0) insertAt = accAt;
console.log('插到第 ' + (insertAt + 1) + ' 行之前（那是 ipcMain.handle( 的位置）');

const out = rest.slice(0, insertAt).concat(block, [''], rest.slice(insertAt));
fs.writeFileSync(f, out.join('\r\n'));
console.log('done');
