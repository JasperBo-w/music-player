/*
 * 把 effects.js 里已有的黑洞实现**整块替换**成 tools/ 下的新版本。
 *
 * 为什么要"整块替换"而不是逐处改：着色器是两段常量字符串，
 * 散着改很容易漏（比如只改了顶点着色器、忘了片段着色器），
 * 而且改完看不出"整体是不是还是我想要的那版"。
 * 整块换掉的好处是：磁盘上的源文件就是唯一真相，随时可以对账。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const target = path.join(root, 'apps', 'ui', 'src', 'effects.js');
let t = fs.readFileSync(target, 'utf8');

const shaders = fs.readFileSync(path.join(__dirname, 'blackhole-shaders.js'), 'utf8').trimEnd();
const builder = fs.readFileSync(path.join(__dirname, 'blackhole-effect.js'), 'utf8').trimEnd();

const startMark = 'const BH_VERT = `';
const endMark = 'function buildBlackHole';
const buildEndMark = 'const BUILDERS = {';

const s = t.indexOf(startMark);
const e = t.indexOf(buildEndMark);
if (s < 0 || e < 0 || e < s) {
  console.log('!! 定位失败', { s, e });
  process.exit(1);
}
if (!t.includes(endMark)) {
  console.log('!! 没找到 buildBlackHole');
  process.exit(1);
}

// 用新的「着色器 + 构建函数」替换掉从 BH_VERT 到 BUILDERS 之前的全部内容
t = t.slice(0, s) + shaders + '\n\n' + builder + '\n\n' + t.slice(e);

fs.writeFileSync(target, t);
console.log('ok: 黑洞实现已整块替换');
