/*
 * 把桌面歌词的开关逻辑插进渲染进程 —— 按**行号**定位，不用字符串匹配。
 *
 * 这已经是本轮第三次栽在"拿注释当锚点"上了：
 * 那些注释里有用于对齐的尾随空格，肉眼看不出来，数量对不上就静默失败。
 * 只要插入点是"文件里第 N 行"这种信息，就不该用字符串去描述它。
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'ui', 'src', 'main.js');
const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);

if (lines.some((l) => l.includes('function toggleDesktopLyric'))) {
  console.log('已存在，跳过');
  process.exit(0);
}

const at = lines.findIndex((l) => l.includes('系统媒体控制'));
if (at < 0) {
  console.log('!! 没找到「系统媒体控制」');
  process.exit(1);
}
// 往上吃掉那两行 /* ---- */ 分隔线（一行标题 + 上下各一条）
let start = at;
while (start > 0 && lines[start - 1].trim().startsWith('/*')) start--;
start = Math.max(0, start - 1);

const block = [
  '/* ------------------------------------------------------------------ */',
  '/* 桌面歌词开关                                                        */',
  '/* ------------------------------------------------------------------ */',
  '',
  '/*',
  ' * 状态从主进程回读，而不是在渲染进程里自己记一份 ——',
  ' * 歌词窗口可能被别的方式打开/关闭（托盘、快捷键、双击穿透），',
  ' * 本地记一份迟早会和真实状态不一致，按钮就会显示成反的。',
  ' */',
  'async function syncLyricChip() {',
  '  if (!window.api || !window.api.desktopLyric) return;',
  '  try {',
  '    const on = await window.api.desktopLyric.visible();',
  "    $('#lyric-chip').classList.toggle('on', !!on);",
  '  } catch {}',
  '}',
  '',
  'async function toggleDesktopLyric() {',
  '  if (!window.api || !window.api.desktopLyric) return;',
  '  const on = await window.api.desktopLyric.visible();',
  '  await window.api.desktopLyric.toggle(!on);',
  '  await syncLyricChip();',
  '  // 开的时候立刻推一次当前歌词，不然要等到下一句才换字',
  '  if (!on) updateStageText();',
  '}',
  '',
  "$('#lyric-chip').addEventListener('click', () => void toggleDesktopLyric());",
  'void syncLyricChip();',
  '',
];

lines.splice(start, 0, ...block);
fs.writeFileSync(f, lines.join('\r\n'));
console.log('ok: 插在第 ' + (start + 1) + ' 行');
