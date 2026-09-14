/*
 * 给吸积盘和透镜环的粒子**加角度聚束**。
 *
 * 起因：用户说"开普勒剪切效果没了"。
 *
 * 原因不是剪切没生效，而是**没有东西能体现它**：
 *   `wSpin = 3.2 / r^1.5` 确实让内圈比外圈快，但粒子的初始角度是纯随机的 ——
 *   而"随机分布被剪切之后"仍然是随机分布，统计上完全一样。
 *   所以算了几何、看不见效果。
 *
 * 修法：把粒子按角度**聚成若干束**（每束占一小段角度），
 * 于是初始看起来是一圈径向的条纹；剪切一上来，条纹被**卷成螺旋**——
 * 那就是黑洞盘那种缠绕感，也是唯一能让"内快外慢"被眼睛读到的办法。
 *
 * 真实吸积盘本来也是这个道理：物质成流，不是均匀撒开的雾。
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'tools', 'blackhole-effect.js');
let t = fs.readFileSync(f, 'utf8');
const log = (m) => console.log(m);

// ---------- ① 吸积盘：角度聚成 64 束 ----------
const diskOld = `    const a = Math.random() * TAU;
    const thin = 0.025 + 0.06 * ((r - R_IN) / (R_OUT - R_IN));`;
const diskNew = `    /*
     * ★ 角度要**聚束**，不能纯随机。
     *
     * 纯随机的粒子分布被剪切之后还是随机分布 —— 内快外慢算得再对，
     * 画面上也看不出任何东西在流动。成束之后，初始是一圈径向条纹，
     * 剪切会把条纹卷成螺旋，缠绕感就出来了。
     *
     * 64 束：足够多，远看仍是均匀的盘；足够少，近看能看出螺旋结构。
     */
    const stream = Math.floor(Math.random() * 64);
    const a = (stream / 64) * TAU + (Math.random() - 0.5) * (TAU / 64) * 0.55;
    const thin = 0.025 + 0.06 * ((r - R_IN) / (R_OUT - R_IN));`;
if (t.includes(diskOld)) {
  t = t.replace(diskOld, diskNew);
  log('ok: 吸积盘聚束');
} else {
  log('!! 吸积盘未匹配');
}

// ---------- ② 透镜环：角度聚成 24 束 ----------
const lensOld = `    const a = Math.random() * TAU;
    /*
     * 结构：透镜弧要**厚**。`;
const lensNew = `    /*
     * 环同样要成束（24 束，比盘粗一档 —— 环本身窄，束太细看不出来）。
     * 环上的束和盘上的束会各自被剪切卷开，两张图一起"淌"。
     */
    const stream = Math.floor(Math.random() * 24);
    const a = (stream / 24) * TAU + (Math.random() - 0.5) * (TAU / 24) * 0.6;
    /*
     * 结构：透镜弧要**厚**。`;
if (t.includes(lensOld)) {
  t = t.replace(lensOld, lensNew);
  log('ok: 透镜环聚束');
} else {
  log('!! 透镜环未匹配');
}

fs.writeFileSync(f, t);
console.log('done');
