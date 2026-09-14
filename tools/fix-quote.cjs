/*
 * 修一行被 PowerShell 引号规则吃坏的代码。
 *
 * 我在 PowerShell 的单引号字符串里写 '''' 想表达两个单引号，
 * 结果只出来一个 —— 变成 `song.artist || ');` 这种语法错。
 * 这类问题反复出现，所以这次直接用 node 写目标内容，不经过 PowerShell。
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'ui', 'src', 'main.js');
const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);

let fixed = 0;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("bg.setStageText(song.name, song.artist || ');")) {
    lines[i] = "  else if (song) bg.setStageText(song.name, song.artist || '');";
    fixed++;
  }
}
fs.writeFileSync(f, lines.join('\r\n'));
console.log('修了 ' + fixed + ' 行');
