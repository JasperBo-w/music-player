/*
 * 「波浪」= 正常的横向波浪。
 *
 * 用户："要不就改成正常的波浪，，，"
 *
 * 也就是他最早说的那个 B —— 横向起伏的波带。
 * 我最早那版（薄带 + 低频正弦）方向其实是对的（v5 的截图观感不错），
 * 后来被"同心圆涟漪"整个推倒重做了 ✗ 绕了一大圈。
 *
 * 这一版 = **那版的结构 + 音乐响应**：
 *   · 5 条水平薄带，各自低频正弦缓慢起伏（那条路的观感已经验证过 ✓）
 *   · 节拍来了 → **一道浪从左向右横扫过画面**（用 uBeatAge）
 *   · 低音抬整体起伏幅度
 *   · 亮度/点径对比保持柔和（不重犯"硬"的错）
 *
 * ★ 结构上的关键（最早那版踩过、这次直接照做）：
 *   位移只跟 x 有关，所以粒子必须**收在薄带里**。
 *   在竖直方向铺得开的话，每一列会整体平移 —— 画面读出来是竖条纹，不是波浪 ✗
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const f = path.join(root, 'apps', 'ui', 'src', 'effects.js');
let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const log = (m) => console.log(m);

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
   * 「波浪」—— 横向波带，跟着音乐走。见本函数上方的大段说明。
   */
  const bands = opts.bands ?? 5;
  const perBand = opts.perBand ?? 2600;
  const spanX = opts.spanX ?? 30;
  const spanY = opts.spanY ?? 12;
  /*
   * 由带间距推出厚度和幅度：
   *   厚度必须远小于间距，带与带之间才有空隙（否则糊成一片雾 ✗）
   *   幅度必须小于间距的一半，否则相邻带会互相穿透、看不出层次 ✗
   */
  const spacing = bands > 1 ? spanY / (bands - 1) : spanY;
  const thick = opts.thick ?? spacing * 0.17;
  const amp = opts.amp ?? spacing * 0.42;
  const count = bands * perBand;

  const group = new THREE.Group();

  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  /** 所属带的序号 0~1：每条带自己的相位，避免整片同步平移 */
  const bandT = new Float32Array(count);
  /** 带内相对高度 -1~1：做带内渐隐 */
  const bandEdge = new Float32Array(count);
  /** 起伏幅度。用属性传而不是写进着色器源码 —— 它是运行时算的，没法拼进字符串 */
  const ampAttr = new Float32Array(count);

  let k = 0;
  for (let b = 0; b < bands; b++) {
    const bt = bands === 1 ? 0.5 : b / (bands - 1);
    const baseY = (bt - 0.5) * spanY;

    for (let i = 0; i < perBand; i++) {
      /*
       * x 用**接近均匀**的分布：均匀才让波峰连成一条完整的光带，
       * 纯随机会把波峰打碎成一片点 ✗
       */
      const fx = (i + Math.random() * 0.9) / perBand;
      const dy = (Math.random() * 2 - 1) * thick;

      pos[k * 3] = (fx - 0.5) * spanX;
      pos[k * 3 + 1] = baseY + dy;
      // 前后几层，避免完全是同一个平面（纯平面像贴纸）
      pos[k * 3 + 2] = (Math.random() - 0.5) * 6.0 - 1.0;

      col[k * 3] = col[k * 3 + 1] = col[k * 3 + 2] = 1;
      size[k] = 0.78 + Math.random() * 0.42;
      phase[k] = Math.random() * TAU;
      bandT[k] = bt;
      bandEdge[k] = dy / thick;
      ampAttr[k] = amp;
      k++;
    }
  }

  const wave = new THREE.Points(
    makeGeo(pos, col, size, phase, [
      ['aBandT', bandT, 1],
      ['aBandEdge', bandEdge, 1],
      ['aAmp', ampAttr, 1],
    ]),
    makeMat(
      U,
      \`
      attribute float aBandT;
      attribute float aBandEdge;
      attribute float aAmp;
      void main() {
        vColor = aColor;
        vec3 pos = position;

        /* 每条带自己的相位：不加的话所有带会完全同步，像一块板子在平移 */
        float ph = aBandT * 2.1;

        /*
         * 基础起伏：两层低频正弦叠加。
         *   0.42 → 波长约 15 世界单位（画面里约 2 个波）
         *   0.21 → 波长约 30（约 1 个波），反向走 → 波面之间有相对滑动
         * 速度 0.55 / 0.33 都很慢 —— "舒缓"就是这个慢来的。
         */
        float w1 = sin(pos.x * 0.42 + uTime * 0.55 + ph);
        float w2 = sin(pos.x * 0.21 - uTime * 0.33 + ph * 0.7 + 1.7) * 0.5;
        float wv = (w1 + w2) / 1.5;

        /*
         * ★ 音乐响应：一道浪从**左向右横扫**过画面。
         *
         *   用 uBeatAge（距上次鼓点的秒数）当时间轴：
         *     波前位置 = 年龄 × 11 - 画面半宽，于是它从左边扫到右边。
         *     高斯包络让它是一"道"浪，不是整片一起抬：
         *       exp(-((x - front) * 0.30)^2)
         *     开头 0.25 秒淡入（否则浪是"啪"地凭空出现，很像"一顿"✗），
         *     再按时间衰减。
         *
         *   这比"整体鼓一下"贴节奏得多 —— 也是 uBeatAge 注释里说的
         *   "按时间展开的行波"。
         */
        float front = uBeatAge * 11.0 - 9.0;
        float swell = exp(-pow((pos.x - front) * 0.30, 2.0))
                    * exp(-uBeatAge * 0.8)
                    * smoothstep(0.0, 0.25, uBeatAge);

        /*
         * 低音抬**幅度**（不是缩放整片 —— 那是"画面呼吸"，用户明确否过 ✗）
         */
        float a = aAmp * (0.85 + uBeatAmp * 0.35);
        pos.y += wv * a + swell * a * 1.6;

        /* 上下位置的带起伏小一点、中间的带大 —— 整体有一个柔和收束 */
        float bandShrink = 0.68 + 0.32 * (1.0 - abs(aBandT - 0.5) * 2.0);
        pos.y = position.y + (pos.y - position.y) * bandShrink;

        /* 指针轻推（和其它效果保持一致的交互） */
        vec2 d = pos.xy - uPointer;
        float infl = smoothstep(7.0, 0.0, length(d)) * uPointerStrength;
        pos.xy += normalize(d + vec2(1e-5)) * infl * 1.6;

        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mv;

        /*
         * 左右两端渐隐：栅格是矩形的，硬切会留下两条笔直的边界 ——
         * 一看就是"程序画的"✗
         */
        float xT = pos.x / 15.0;
        float xFade = smoothstep(1.0, 0.80, abs(xT));

        /*
         * 波峰更亮 —— 只做位移的话，起伏很难被看出来。
         * 但要**柔和**：区间给宽（-1.15 ~ 1.45），中间才有层次，
         * 不至于变成"台阶"✗（那是上一版被否掉的原因）
         */
        float crest = smoothstep(-1.15, 1.45, wv + swell * 1.6);
        float soft = 1.0 - pow(abs(aBandEdge), 3.0) * 0.5;

        gl_PointSize = aSize * uPixelRatio * (15.0 / -mv.z) * (0.72 + crest * 0.72);
        vAlpha = (0.18 + crest * 0.56) * soft * xFade
                 * (0.90 + 0.10 * sin(uTime * 0.9 + aPhase * 2.0))
                 + infl * 0.3;
      }\`
    )
  );

  group.add(wave);
  return group;
}
`;

t = t.slice(0, start) + impl + t.slice(nextFn + 1);

// 名字和说明
t = t.replace(
  /  \{\n    key: 'wave',\n    name: '波浪',\n    hint: '[^']*',\n  \},/,
  `  {
    key: 'wave',
    name: '波浪',
    hint: '横向波带缓慢起伏，鼓点会有一道浪从左向右横扫过去',
  },`
);

fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
log('ok: 波浪改成横向波带');
