/*
 * 把「黑洞」效果装进 effects.js。
 *
 * 效果代码和着色器分别放在 tools/blackhole-effect.js 和 tools/blackhole-shaders.js
 * —— 不直接写在这个脚本里，是因为这段 GLSL 里全是反引号和 ${}，
 * 塞进 String.raw 模板会被提前截断（第一次就是这么失败的）。
 * 分成独立文件读进来，就完全不涉及转义。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const target = path.join(root, 'apps', 'ui', 'src', 'effects.js');

let t = fs.readFileSync(target, 'utf8');
if (t.includes('buildBlackHole')) {
  console.log('已存在，跳过');
  process.exit(0);
}

const shaders = fs.readFileSync(path.join(__dirname, 'blackhole-shaders.js'), 'utf8');
const builder = fs.readFileSync(path.join(__dirname, 'blackhole-effect.js'), 'utf8');

const anchor = 'const BUILDERS = {';
if (!t.includes(anchor)) {
  console.log('!! 未找到 BUILDERS');
  process.exit(1);
}

// 着色器常量 + 构建函数，一起插在 BUILDERS 之前
t = t.replace(anchor, shaders.trimEnd() + '\n\n' + builder.trimStart() + '\n' + anchor);

// 注册
if (t.includes('blackhole: buildBlackHole')) {
  console.log('BUILDERS 里已有');
} else {
  t = t.replace('  halo: buildHalo,', '  halo: buildHalo,\n  blackhole: buildBlackHole,');
}

// 效果列表
if (t.includes("key: 'blackhole'")) {
  console.log('EFFECT_LIST 里已有');
} else {
  t = t.replace(
    "  { key: 'halo', name: '月蚀圣环', hint: '轨道环 + 日冕，指针推开环流' },",
    "  { key: 'halo', name: '月蚀圣环', hint: '轨道环 + 日冕，指针推开环流' },\n  { key: 'blackhole', name: '黑洞', hint: '事件视界 + 吸积盘 + 引力透镜，盘的光被弯到黑球上下' },"
  );
}

fs.writeFileSync(target, t);
console.log('ok: 黑洞效果已写入并注册');
