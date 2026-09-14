/*
 * 按行号精确修改（edit 工具在这个文件上反复匹配不上，多半是行尾/空白差异）。
 *
 * 两件事：
 *   ① .stage 去掉 transform —— 它只负责居中
 *   ② HTML 里把文字块包进 .positioner
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'ui', 'lyric.html');
const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);

// ① 找到 .stage 里那段 transform 注释 + transform + will-change，整段替换成新注释
const stageAt = lines.findIndex((l) => l.trim() === '.stage {');
if (stageAt < 0) {
  console.log('!! 没找到 .stage');
  process.exit(1);
}
// 从 .stage { 往下找 transform 行
let tfAt = -1;
for (let i = stageAt; i < stageAt + 20; i++) {
  if (lines[i] && lines[i].includes('transform: translate3d(var(--lx')) {
    tfAt = i;
    break;
  }
}
if (tfAt < 0) {
  console.log('!! 没找到 .stage 里的 transform（可能已改过）');
} else {
  // 往上吃掉它的注释块
  let cStart = tfAt - 1;
  while (cStart > stageAt && !lines[cStart].trim().startsWith('/*')) cStart--;
  if (lines[cStart].trim().startsWith('/*')) cStart--; // 含起始行
  cStart++;
  // 往下吃掉 will-change
  let cEnd = tfAt;
  if (lines[cEnd + 1] && lines[cEnd + 1].includes('will-change')) cEnd++;
  const repl = [
    '        /*',
    '         * ★ 这里只负责**居中**，不承担位置偏移 —— 偏移在 .positioner 上。',
    '         * 两层分开各司其职。',
    '         *（我第一版把偏移加在这里，等于"居中之后再偏移一次"，',
    '         *  默认值 404,822 直接把文字推出了屏幕，用户看到的是"词在哪"。）',
    '         */',
  ];
  lines.splice(cStart, cEnd - cStart + 1, ...repl);
  console.log('ok: .stage 去掉 transform（替换 ' + (cEnd - cStart + 1) + ' 行）');
}

// ② HTML：包一层 .positioner
const glowAt = lines.findIndex((l) => l.includes('class="glow"') && l.includes('id="main"'));
if (glowAt < 0) {
  console.log('!! 没找到 .glow 那行');
} else if (lines[glowAt - 1] && lines[glowAt - 1].includes('positioner')) {
  console.log('positioner 已存在');
} else {
  // glow 行 + next 行 一起包起来
  const nextAt = lines.findIndex((l, i) => i > glowAt && l.includes('id="next"'));
  if (nextAt < 0) {
    console.log('!! 没找到 #next 行');
  } else {
    const ind = '        ';
    lines.splice(
      glowAt,
      nextAt - glowAt + 1,
      ind + '<div class="positioner">',
      ind + '  ' + lines[glowAt].trim(),
      ind + '  ' + lines[nextAt].trim(),
      ind + '</div>'
    );
    console.log('ok: HTML 包了 .positioner');
  }
}

fs.writeFileSync(f, lines.join('\r\n'));
console.log('done');
