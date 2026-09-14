/*
 * 修正波浪效果的结构。
 *
 * ★ 第一版错在哪（截图一眼可见：出来是竖条纹，像幕布，不是波浪）
 *
 *   我用了一片 **46 行铺满整个高度**的栅格，而位移只跟 x 有关：
 *       pos.y += wv(x) * amp
 *   于是**每一列的所有行一起上下移** —— 栅格被整体剪切，密的地方密、疏的地方疏，
 *   读出来就是竖条纹 ✗
 *
 *   根子上的误解：我以为"位移是 x 的函数"就等于波浪。不是。
 *   波浪要能读出来，粒子必须**集中在一条薄带里**，让"整条带在起伏"这件事可见。
 *   一片铺满高度的栅格，你看到的是"列在动"，不是"面在起伏"。
 *
 * ★ 正确结构：若干条**水平薄带**（每条厚度约 ±0.9），
 *   每条带自己的相位，随 x 做低频正弦起伏 →
 *   整个画面就是一层层缓慢起伏的丝带 ✓ 舒缓、有规律、看得懂。
 *
 * （这和"黑洞那次随机分布上的剪切统计上等于没剪切"是同一类认识：
 *   **形态取决于结构，不取决于运动本身**。）
 */
const fs = require('node:fs');
const path = require('node:path');
const f = path.join(__dirname, '..', 'apps', 'ui', 'src', 'effects.js');
let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const log = (m) => console.log(m);

const start = t.indexOf('function buildWave(U, opts) {');
if (start < 0) {
  log('!! 没找到 buildWave');
  process.exit(1);
}
// 找到函数结尾：下一个顶层 function 之前
const nextFn = t.indexOf('\nfunction build', start + 10);
if (nextFn < 0) {
  log('!! 没找到 buildWave 的结尾');
  process.exit(1);
}

const impl = `function buildWave(U, opts) {
  /*
   * 「波浪」—— 若干条水平薄带，各自按低频正弦缓慢起伏。
   *
   * 结构上为什么必须是**薄带**而不是铺满高度的栅格：
   * 位移只跟 x 有关，如果粒子在竖直方向铺得很开，那每一列都是"整体上下移"，
   * 画面读出来是竖条纹；只有把粒子收进薄带里，"整条带在起伏"才看得见。
   */
  const bands = opts.bands ?? 8;
  const perBand = opts.perBand ?? 1700;
  const spanX = opts.spanX ?? 38;
  const spanY = opts.spanY ?? 16;
  /** 薄的厚度：太大就退化成"一片雾"，太小就成了一条硬线 */
  const thick = opts.thick ?? 0.95;
  const count = bands * perBand;

  const group = new THREE.Group();

  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  /** 所属带的序号 0~1：给每条带不同的相位和幅度，避免所有带整齐划一地动 */
  const bandT = new Float32Array(count);
  /** 带内的相对高度 -1~1：做带内渐隐用（让每条带边缘柔一点） */
  const bandEdge = new Float32Array(count);

  let k = 0;
  for (let b = 0; b < bands; b++) {
    const bt = bands === 1 ? 0.5 : b / (bands - 1);
    // 带心在画面上的高度
    const baseY = (bt - 0.5) * spanY;

    for (let i = 0; i < perBand; i++) {
      /*
       * x 用**接近均匀**的分布（加了极小抖动）—— 均匀才让波峰是一条连续的光带；
       * 纯随机会让波峰碎成一片点。
       */
      const fx = (i + Math.random() * 0.9) / perBand;
      const dy = (Math.random() * 2 - 1) * thick;

      pos[k * 3] = (fx - 0.5) * spanX;
      pos[k * 3 + 1] = baseY + dy;
      // 前后几层，避免完全是同一个平面（纯平面看着像贴纸）
      pos[k * 3 + 2] = (Math.random() - 0.5) * 6.0 - 1.0;

      col[k * 3] = col[k * 3 + 1] = col[k * 3 + 2] = 1;

      // 点小而密：丝带的形来自密度，不来自单颗的大小
      size[k] = 0.75 + Math.random() * 0.45;
      phase[k] = Math.random() * TAU;
      bandT[k] = bt;
      bandEdge[k] = dy / thick;
      k++;
    }
  }

  const wave = new THREE.Points(
    makeGeo(pos, col, size, phase, [
      ['aBandT', bandT, 1],
      ['aBandEdge', bandEdge, 1],
    ]),
    makeMat(
      U,
      \`
      attribute float aBandT;
      attribute float aBandEdge;
      void main() {
        vColor = aColor;
        vec3 pos = position;

        /*
         * 每条带一个自己的相位偏移（aBandT * 2.3）。
         * 不加这个的话所有带会**完全同步**地上下 —— 看起来像一整块板子在平移，
         * 而不是一层层各自起伏的水面。
         */
        float ph = aBandT * 2.3;

        /*
         * 两层低频正弦叠加：
         *   主波 波长 ~ 画面宽度的 1.7 倍，速度 0.42（很慢）
         *   副波 波长 ~ 3 倍，速度 0.26，反向
         * 反向走是为了让波面之间有相对滑动 —— 像两组波互相穿过。
         */
        float w1 = sin(pos.x * 0.185 + uTime * 0.42 + ph);
        float w2 = sin(pos.x * 0.098 - uTime * 0.26 + ph * 0.6 + 1.7) * 0.55;
        float wv = (w1 + w2) / 1.55;

        /*
         * 幅度：基础 1.5，节拍最多再抬 0.9。
         * ★ 刻意不做"鼓点炸开" —— 用户嫌之前乱，就是因为一拍整体弹一下。
         *   波浪该有的是"呼吸变深"。
         */
        float amp = 1.5 + uBeatAmp * 0.9 * (0.6 + uPulse * 0.4);
        // 上下位置的带起伏小一点，中间大 —— 让整体有一个柔和的收束
        amp *= 0.62 + 0.38 * (1.0 - abs(aBandT - 0.5) * 2.0);
        pos.y += wv * amp;

        // 指针轻推
        vec2 d = pos.xy - uPointer;
        float infl = smoothstep(7.0, 0.0, length(d)) * uPointerStrength;
        pos.xy += normalize(d + vec2(1e-5)) * infl * 1.6;

        // 不用 applyBeat：那是"径向向外推"，会把整条带往外撑出画面
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mv;

        // 波峰更亮更大：只做位移的话，起伏很难被看出来
        float crest = smoothstep(-0.5, 1.0, wv);
        // 带内上下缘稍淡，丝带的边缘就柔了
        float soft = 1.0 - pow(abs(aBandEdge), 3.0) * 0.55;

        gl_PointSize = aSize * uPixelRatio * (10.0 / -mv.z)
                       * (0.82 + crest * 0.5)
                       * (1.0 + uPulse * 0.10);

        vAlpha = (0.24 + crest * 0.46) * soft
                 * (0.87 + 0.13 * sin(uTime * 0.8 + aPhase * 2.0))
                 + infl * 0.3;
      }\`
    )
  );

  group.add(wave);
  return group;
}
`;

t = t.slice(0, start) + impl + t.slice(nextFn + 1);
// 名字改得更直白
t = t.replace(`    name: '波光',`, `    name: '波浪',`);
fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
log('ok: 波浪结构改成薄带');
