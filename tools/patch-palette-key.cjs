/*
 * 把 paletteKey 的算法统一成一份。
 *
 * 之前这个字符串在三个地方各写了一遍，其中两处（启动路径）漏了封面取色。
 * 后果是"启动时算的 key"和"改设置时算的 key"永远对不上：
 *   · 该重涂时不涂 → 界面和粒子颜色分家（用户看到的"叠加"）
 *   · 不该涂时白涂一次 → 每颗粒子重新随机取色，看着闪一下
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'ui', 'src', 'main.js');
let t = fs.readFileSync(f, 'utf8');
const log = (m) => console.log(m);

// ① 插入唯一的 key 函数
if (t.includes('function paletteKeyOf')) {
  log('已存在 paletteKeyOf');
} else {
  const anchor = "let lastPaletteKey = '';";
  const add = `${anchor}

/**
 * 粒子配色的"签名"。
 *
 * 只此一份 —— 之前这个字符串在三个地方各写了一遍，其中两处漏了封面取色，
 * 于是"启动时算的 key"和"改设置时算的 key"永远对不上：要么该重涂时不涂
 *（界面一个色、粒子另一个色），要么不该涂时白涂一次（粒子会闪一下）。
 */
function paletteKeyOf(s) {
  return [s.theme, s.accentOverride || '', s.coverAccent ? s.coverAccentColor || '' : ''].join('|');
}`;
  if (t.includes(anchor)) {
    t = t.replace(anchor, add);
    log('ok: 插入 paletteKeyOf');
  } else {
    log('!! 未匹配 lastPaletteKey 声明');
  }
}

// ② 三处调用点统一
const before = t;
t = t.replace(
  /const paletteKey = `\$\{settings\.theme\}\|\$\{settings\.accentOverride \|\| ''\}\|\$\{\s*settings\.coverAccent \? settings\.coverAccentColor \|\| '' : ''\s*\}`;/,
  'const paletteKey = paletteKeyOf(settings);'
);
t = t.replace(
  /lastPaletteKey = `\$\{settings\.theme\}\|\$\{settings\.accentOverride \|\| ''\}`;/g,
  'lastPaletteKey = paletteKeyOf(settings);'
);
fs.writeFileSync(f, t);
log(t === before ? '调用点：没有需要改的（或已被替换）' : 'ok: 调用点已统一');

const hits = [];
t.split('\n').forEach((line, i) => {
  if (line.includes('paletteKeyOf') || line.includes('lastPaletteKey =')) hits.push(`${i + 1}: ${line.trim()}`);
});
console.log(hits.join('\n'));
