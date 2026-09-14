/*
 * 波浪效果重做：改成**水面的涟漪**，正面构图。
 *
 * ---------------------------------------------------------------------------
 * 我错在哪（两处，都值得记）
 *
 * ① **方向错了。** 我做的是一片横向条纹的"波带"。而用户要的"波浪"，
 *    是 `tools/remove-effects.js` 里删掉的那个 —— `buildWave`，
 *    effects.js 里记着它叫什么：「**涟漪深潭（水面）**」。
 *    他记得这个效果，所以一直在说"波浪还是没有" ✗
 *
 * ② **我第一版没先查"用户说的这个词，在这个项目里指什么"。**
 *    如果一开始就搜 `wave`，会立刻看到 settings.js 第 493 行：
 *      「老存档里存的是 nebula / galaxy / warp / **wave** / terrain / sphere 之一，
 *        而这些 key 已经不存在于 BUILDERS 里了」
 *    —— 一句话就能省掉四轮返工 ✗
 *
 * ---------------------------------------------------------------------------
 * ★ 为什么这次能做成正面构图（上一次"涟漪深潭"就是死在这里）
 *
 * effects.js 开头记着：旧的水面效果把平面铺在 y=0，而摄像机正好在 (0,0,9)
 * 同一高度 —— 整个面**侧对镜头**，渲染出来是一条横线 ✗
 *
 * 这次的做法绕开了这个问题：**涟漪在正面看，本来就不该靠"立体的水面"表达**。
 *   · 粒子铺在一个**圆盘**上（x/y 铺开，z 只有一点厚度）—— 正面构图 ✓
 *   · 波的形态由**亮度环**承担：`alpha` 和点径按 sin(r·k − t·ω) 调制，
 *     于是看到的是**一圈圈由内向外扩散的光环** ✓ —— 这天然是正面的 ✓
 *   · z 只做很小的位移（±0.8），提供一点呼吸感，不制造纵深
 *
 * ★ 完全不跟节拍联动。
 *   用户的原话："我要的不是跳动啊，是粒子效果"。
 *   涟漪的节奏来自波本身一圈圈荡开，不来自鼓点。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const f = path.join(root, 'apps', 'ui', 'src', 'effects.js');
let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const log = (m) => console.log(m);
let n = 0;
/** 圆盘半径。补丁脚本里也要有一份 —— impl 是模板字符串，${R} 会被**脚本自己**求值 */
const R = 11;

// ① 换掉 buildWave 的实现
const start = t.indexOf('function buildWave(U, opts) {');
let nextFn = -1;
if (start >= 0) {
  const m = /\n(function build|const BUILDERS)/.exec(t.slice(start + 10));
  if (m) nextFn = start + 10 + m.index;
}
if (start < 0 || nextFn < 0) {
  log('!! 定位 buildWave 失败');
  process.exit(1);
}

const impl = `function buildWave(U, opts) {
  /*
   * 「波浪」= 水面的涟漪。见本函数上方的大段说明。
   */
  const count = opts.count ?? 22000;
  /** 圆盘半径（世界单位）。画面可见范围约 ±11，取 11 刚好铺满 */
  const R = opts.radius ?? 11;
  const group = new THREE.Group();

  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  /** 到圆心的距离：波就是它的函数 */
  const rad = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    /*
     * 极坐标撒点，但半径用 sqrt 分布 —— 这样**面积上是均匀的**。
     * 直接 r = random()*R 会让中心挤成一团、外圈稀稀拉拉，
     * 涟漪读起来就变成"中间一个大亮斑"。
     */
    const r = Math.sqrt(Math.random()) * R;
    const a = Math.random() * TAU;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = Math.sin(a) * r;
    // 只给一点厚度：这是"水面"，不是"水柱"
    pos[i * 3 + 2] = (Math.random() - 0.5) * 1.2;

    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 1;
    size[i] = 0.7 + Math.random() * 0.5;
    phase[i] = Math.random() * TAU;
    rad[i] = r;
  }

  const ripple = new THREE.Points(
    makeGeo(pos, col, size, phase, [['aRad', rad, 1]]),
    makeMat(
      U,
      \`
      attribute float aRad;
      void main() {
        vColor = aColor;
        vec3 pos = position;

        /*
         * 涟漪：以到圆心的距离为相位。
         *   aRad * 1.15  → 波长约 5.5 世界单位（画面里能看到 2~3 圈）
         *   uTime * 0.85 → 一圈从中心荡到边缘约 13 秒，很慢
         * 减号表示**向外传播**（加号是向内收）。
         */
        float w = sin(aRad * 1.15 - uTime * 0.85);

        /*
         * 第二层更慢、波长更长的波，做"大浪叠小浪"。
         * 单层正弦太规整，看着像同心圆靶子而不是水面。
         */
        w = w * 0.7 + sin(aRad * 0.52 - uTime * 0.47 + 1.3) * 0.3;

        /*
         * ★ 不调 applyBeat()，也不读 uBeatAmp / uPulse。
         * 用户明确说过："我要的不是跳动啊，是粒子效果" ——
         * 涟漪的节奏是波自己荡开，不该由鼓点驱动。
         */

        // 很小的前后位移：只提供一点"水面有起伏"的感觉
        pos.z += w * 0.8;

        // 指针处轻轻荡开（和别的效果保持一致的交互）
        vec2 d = pos.xy - uPointer;
        float infl = smoothstep(6.0, 0.0, length(d)) * uPointerStrength;
        pos.xy += normalize(d + vec2(1e-5)) * infl * 1.5;

        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mv;

        /*
         * 边缘渐隐：圆盘是硬边，不收一下会看到一个明显的圆。
         */
        float edge = smoothstep(1.0, 0.72, aRad / ${R.toFixed(1)});

        /*
         * ★ 波的形态主要靠**亮度**表达，不是靠位移。
         * 正面看水面时，看到的就是"一圈亮、一圈暗"，位置变化极小 ——
         * 这才是涟漪该有的样子。
         */
        float crest = smoothstep(-0.75, 0.95, w);
        gl_PointSize = aSize * uPixelRatio * (9.5 / -mv.z) * (0.70 + crest * 0.70);
        vAlpha = (0.14 + crest * 0.62) * edge
                 * (0.90 + 0.10 * sin(uTime * 0.7 + aPhase * 2.0))
                 + infl * 0.3;
      }\`
    )
  );

  group.add(ripple);
  return group;
}
`;

t = t.slice(0, start) + impl + t.slice(nextFn + 1);
n++;

// ② 名字和说明改对
t = t.replace(
  `  {
    key: 'wave',
    name: '波浪',
    hint: '规则栅格上的低频起伏：三层正弦横向流动，节拍只让波峰变高，不炸开',
  },`,
  `  {
    key: 'wave',
    name: '波浪',
    hint: '水面的涟漪：一圈圈由内向外荡开的光环，两层波叠加，完全不跟鼓点走',
  },`
);
n++;

fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
log('改了 ' + n + ' 处');
