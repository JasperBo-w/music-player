/*
 * 柔和化。
 *
 * 用户："波动太硬了"
 *
 * 我把三个对比都拉满了，所以看起来"硬"：
 *   · 鼓点环太窄（高斯宽度 0.85）→ 像一道锋利的白环划过去 ✗
 *   · 波谷压到几乎全黑（alpha 下限 0.06）→ 明暗反差过猛 ✗
 *   · 点径调制 1.15 倍 → 波峰的点突然变大，像塑料 ✗
 *   · 径向聚拢 0.75 → 密度带太"实" ✗
 *
 * 柔和的关键不是"降低幅度"，而是**把过渡拉长**：
 * 波峰和波谷之间要有足够的中间层次，眼睛才觉得是"水"而不是"台阶"。
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

// ① 鼓点环：加宽、降幅、衰减更慢（荡得更远但更淡）
rep(
  `        float front = uBeatAge * 5.5;
        float ring = exp(-pow((aRad - front) * 0.85, 2.0)) * exp(-uBeatAge * 0.9);`,
  `         *    高斯宽度从 0.85 放宽到 0.42 —— 环"厚"了，过渡就软了；
         *    幅度 1.5→0.85、衰减 0.9→0.55（荡得更远但更淡）。
         */
        float front = uBeatAge * 5.5;
        float ring = exp(-pow((aRad - front) * 0.42, 2.0)) * exp(-uBeatAge * 0.55);`,
  '鼓点环'
);
// 上面那段替换把注释头吃掉了，补回来
rep(
  `         *    高斯宽度从 0.85 放宽到 0.42`,
  `         *    ★ 柔和化的三处：高斯宽度从 0.85 放宽到 0.42 —— 环"厚"了、过渡就软了；
         *    高斯宽度从 0.85 放宽到 0.42`,
  '补注释'
);
rep(`        float w = base * (0.55 + uBeatAmp * 0.65) + ring * 1.5;`,
    `        float w = base * (0.55 + uBeatAmp * 0.5) + ring * 0.85;`, '幅度');

// ② 径向聚拢减弱：密度带更"虚"
rep(`        pos.xy = dir0 * (aRad + w * 0.75);`, `        pos.xy = dir0 * (aRad + w * 0.45);`, '径向聚拢');

// ③ 明暗过渡拉长 + 波谷抬起来
rep(
  `        float crest = smoothstep(-0.75, 0.95, w);`,
  `        /*
         * 柔和化的核心：把 smoothstep 的区间**拉长**。
         * 原来是 (-0.75, 0.95) —— 一个很窄的窗口，w 一旦越过就立刻到顶，
         * 于是波峰波谷之间几乎没有中间层次，看着是"台阶"而不是"水" ✗
         * 放宽到 (-1.30, 1.50) 之后过渡拉满，起伏变成渐变的。
         */
        float crest = smoothstep(-1.30, 1.50, w);`,
  'crest'
);

// ④ 亮度：抬波谷、降波峰
rep(
  `        gl_PointSize = aSize * uPixelRatio * (17.0 / -mv.z) * (0.55 + crest * 1.15);
        vAlpha = (0.06 + crest * 0.85) * edge`,
  `        /*
         * 点径和亮度的调制都收一档：
         *   点径 0.55+1.15 → 0.78+0.50（波峰不再突然变大）
         *   亮度 0.06+0.85 → 0.22+0.50（波谷抬起来，不再是黑带）
         * 波谷有底、波峰不满，中间才有"水"的层次。
         */
        gl_PointSize = aSize * uPixelRatio * (17.0 / -mv.z) * (0.78 + crest * 0.50);
        vAlpha = (0.22 + crest * 0.50) * edge`,
  '亮度'
);

fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
log('改了 ' + n + ' 处');
