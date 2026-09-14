/*
 * 涟漪做实：让"环"真正看得见。
 *
 * 为什么上一版看不出环（截图就是一片均匀星点）✗
 *
 *   我只让波去调制**亮度和点径**。稀疏的点（22000 颗撒在半径 11 的圆盘上）
 *   每个只有 1~2 像素，"亮度不同"根本不足以连成一条环 ——
 *   眼睛看到的是噪点，不是环 ✗
 *
 * ★ 关键改动：**沿半径方向位移**。
 *
 *   把每颗粒子从 aRad 挪到 aRad + w·amp。
 *   由于 w = sin(r·k − t·ω)，这个位移对 r 的导数是 amp·k·cos(…) ——
 *   在导数为负的地方，粒子被**挤到一起**，密度升高；
 *   在为正的地方被拉开，密度降低。
 *   于是**稠密/稀疏本身就构成了环**，不再依赖亮度 ✗→✓
 *
 *   取 amp·k ≈ 0.86（amp 0.75、k 1.15）：足够强的聚拢，又不会超过 1
 *   导致粒子**折叠**（超过 1 时波会自我覆盖，看起来是脏乱而不是水面）。
 *
 *   同时保留亮度/点径调制 —— 密度 + 亮度一起作用，环才干净利落。
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'ui', 'src', 'effects.js');
let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const log = (m) => console.log(m);
let n = 0;
const rep = (a, b, label) => {
  if (t.includes(a)) {
    t = t.replace(a, b);
    n++;
  } else log('!! ' + label);
};

// ① 密度提上来（填充率不是瓶颈，这是文件里实测过的结论）
rep(`  const count = opts.count ?? 22000;`, `  const count = opts.count ?? 42000;`, '粒子数');

// ② 径向位移 —— 这一版的核心
rep(
  `        // 很小的前后位移：只提供一点"水面有起伏"的感觉
        pos.z += w * 0.8;`,
  `        /*
         * ★ 核心：**沿半径方向**位移，而不是前后。
         *
         * 位移量对半径的导数在负的地方粒子被挤密、在正的地方被拉疏 ——
         * **密度差本身就画出了环**。只调亮度是画不出环的（上一版就是这么失败的）。
         *
         * amp 0.75 × k 1.15 ≈ 0.86 < 1：聚拢足够强，又不会让波自我折叠。
         */
        vec2 dir0 = normalize(pos.xy + vec2(1e-5));
        pos.xy = dir0 * (aRad + w * 0.75);

        // 前后也动一点：给水面一点厚度感，但很克制（不制造纵深）
        pos.z += w * 0.5;`,
  '径向位移'
);

// ③ 亮度/点径对比拉大
rep(
  `        gl_PointSize = aSize * uPixelRatio * (17.0 / -mv.z) * (0.70 + crest * 0.75);
        vAlpha = (0.20 + crest * 0.66) * edge`,
  `        /*
         * 密度已经负责画出环了，这里再把对比拉开一档：
         * 波谷几乎看不见、波峰又亮又大 —— 两个机制叠加，环才立得住。
         */
        gl_PointSize = aSize * uPixelRatio * (17.0 / -mv.z) * (0.55 + crest * 1.15);
        vAlpha = (0.06 + crest * 0.85) * edge`,
  '对比'
);

fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
log('改了 ' + n + ' 处');
