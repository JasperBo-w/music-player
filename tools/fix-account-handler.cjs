/*
 * 修复 account handler 被吃掉的 'account', 那一行。
 *
 * 事故经过：我上一版补丁把插入点选在 wrap('account', ...) 之前，
 * 但那一行的**上面**正是 ipcMain.handle( 的注释块开头 `/*` ——
 * 于是我的代码被塞进了注释里。第二次按行号搬移时，
 * 又把注释块本该占的那一行（'account',）当成了我的代码一起搬走。
 *
 * 教训：**按行号搬代码之前，要先确认那几行到底是什么**。
 * 我凭"行号算出来是这里"就动手，没有回读确认，结果吃掉了相邻的一行。
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'desktop', 'main.js');
const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);

// 找到 ipcMain.handle( 后面紧跟 /* 且缺 'account', 的那处
const at = lines.findIndex((l, i) => l.trim() === 'ipcMain.handle(' && lines[i + 1] && lines[i + 1].trim() === '/*');
if (at < 0) {
  console.log('!! 没找到受损处（可能已经修好）');
  process.exit(0);
}
console.log('受损处：第 ' + (at + 1) + ' 行起');

lines.splice(
  at + 1,
  2,
  "    'account',",
  '    /*',
  '     * 账号信息。注意用的是 wrap(\'account\', ...) —— 那个包装负责统一错误处理，',
  '     * 新加的 handler 也应该照这个来，别自己另起一套 try/catch 风格。',
  '     */'
);
fs.writeFileSync(f, lines.join('\r\n'));
console.log('ok');
