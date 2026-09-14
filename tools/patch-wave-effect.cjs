/*
 * 新效果：波浪（wave）。
 *
 * 用户的原话："封面粒子效果我不满意了，乱挑动了感觉，有些舒缓的歌都不匹配，
 *             最好把这个效果改成有节奏有规律的舒缓的波浪起伏那种感觉。"
 *
 * ---------------------------------------------------------------------------
 * ★ 这次和以前那次"涟漪深潭"的失败有什么区别
 *
 * effects.js 开头记着一条教训：做过"涟漪深潭（水面）"，最后被换掉了，
 * 原因是**把平面铺在 y=0、而摄像机正好在同一高度** —— 整个面侧对镜头，
 * 渲染出来就是一条横线 ✗
 *
 * 所以这次的"波浪"**不是三维水面**，而是**正面看的起伏**：
 *   · 粒子铺满画面平面（x/y），z 只用来分层次，不制造纵深
 *   · 起伏体现在 **y 方向的位移**，横跨画面流动 —— 就像正对着看一片起伏的帘子
 *   · 零透视，所以"不可能看不见"
 *
 * ---------------------------------------------------------------------------
 * ★ 为什么用**规则栅格**而不是随机撒点
 *
 * 用户要的是"有规律"。随机分布天然读作**噪点**：哪怕每颗粒子的运动完全同步，
 * 看起来也是一片乱麻 —— 因为**位置本身没有秩序**。
 * 规则栅格才让"整片一起起伏"这件事看得出来：波峰是一条线，不是一个点。
 * （这和黑洞那次"随机分布上的剪切统计上等于没剪切"是同一类认识。）
 *
 * ---------------------------------------------------------------------------
 * ★ 为什么这么慢
 *
 * 对照「粒子雨」：它的时间系数是 9.0。这里最大的是 0.62 —— **慢 15 倍**。
 * 用户要的就是"舒缓"：波浪的整个卖点是**慢**，快了就变成抖动，
 * 又回到他不满意的那种感觉。
 *
 * 三层正弦叠加（波长和速度各不相同）是为了避免单一正弦那种机械感，
 * 但三层都是低频、都慢，所以读起来仍是"有规律的起伏"而不是"杂乱的运动"。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const log = (m) => console.log(m);
let n = 0;

// ---------- ① effects.js：实现 + 注册 ----------
{
  const f = path.join(root, 'apps', 'ui', 'src', 'effects.js');
  let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

  if (!t.includes('function buildWave')) {
    const anchor = `function buildRain(U, opts) {`;
    const impl = `function buildWave(U, opts) {
  /*
   * 「波浪」—— 见文件末尾 BUILDERS 附近的说明。
   *
   * 结构：一层规则栅格（横 260 × 纵 46 ≈ 12000 颗），
   * 在顶点着色器里按 x 做三层低频正弦叠加，整体沿 y 起伏。
   */
  const cols = opts.cols ?? 260;
  const rows = opts.rows ?? 46;
  const spanX = opts.spanX ?? 34;
  const spanY = opts.spanY ?? 17;
  const count = cols * rows;

  const group = new THREE.Group();

  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  /** 归一化行号 0(下)~1(上)：给片元做上下渐隐和亮度层次用 */
  const rowT = new Float32Array(count);

  let k = 0;
  for (let r = 0; r < rows; r++) {
    const fy = r / (rows - 1);
    for (let c = 0; c < cols; c++) {
      const fx = c / (cols - 1);
      /*
       * x 上**不要**加随机抖动：规则是刻意保留的（见文件头说明）。
       * z 上给一点厚度，做出几层前后叠加的帘子 —— 纯平面会显得像贴纸。
       */
      pos[k * 3] = (fx - 0.5) * spanX;
      pos[k * 3 + 1] = (fy - 0.5) * spanY;
      pos[k * 3 + 2] = (Math.random() - 0.5) * 5.0 - 1.5;

      col[k * 3] = col[k * 3 + 1] = col[k * 3 + 2] = 1;

      // 点小一点、密一点 —— "面"的观感来自密度，不是来自单颗的大小
      size[k] = 0.85 + Math.random() * 0.42;
      // 相位只用来给每颗一点点个性（呼吸），不参与波形 —— 波形由 x 决定
      phase[k] = Math.random() * TAU;
      rowT[k] = fy;
      k++;
    }
  }

  const wave = new THREE.Points(
    makeGeo(pos, col, size, phase, [['aRowT', rowT, 1]]),
    makeMat(
      U,
      \`
      attribute float aRowT;
      void main() {
        vColor = aColor;
        vec3 pos = position;

        /*
         * 三层低频正弦叠加。
         * 波长：0.34 / 0.19 / 0.58（波数）→ 画面宽度上大约 2~3 个完整波
         * 速度：0.62 / 0.41 / 0.28 —— 都很慢，这是"舒缓"的来源
         * 权重：1.0 / 0.62 / 0.28 → 主波主导，另两层只是破掉机械感
         *
         * 注意方向：前两层 +x 走，第三层 -x 走，于是波面之间有**相对滑动**，
         * 看起来像水面上两组波在互相穿过，而不是一整块板子上下平移。
         */
        float w1 = sin(pos.x * 0.34 + uTime * 0.62);
        float w2 = sin(pos.x * 0.19 - uTime * 0.41 + 1.7) * 0.62;
        float w3 = sin(pos.x * 0.58 + uTime * 0.28 + 3.1) * 0.28;
        float wv = (w1 + w2 + w3) / 1.90;            // -1 ~ 1

        /*
         * 幅度：基础 2.1，节拍最多再加 1.1。
         *
         * ★ 这里刻意**不做"鼓点炸开"**。用户嫌之前的乱，就是因为一拍就整体弹一下。
         *   波浪该有的是"呼吸变深" —— 所以节拍只抬幅度，且只有 1.1 的余量，
         *   配上 0.6~1.0 的权重区间，重拍也仅仅让波峰高一点、低一点。
         */
        float amp = 2.1 + uBeatAmp * 1.1 * (0.6 + uPulse * 0.4);
        pos.y += wv * amp;

        /*
         * 上下缘渐隐。
         * 栅格是矩形的，硬切会在画面上下留下两条明显的直边 ——
         * 让最上和最下几行淡出，边界就看不见了。
         */
        float edge = smoothstep(0.0, 0.16, aRowT) * smoothstep(1.0, 0.84, aRowT);

        // 指针轻微推开（和其它效果保持一致的交互）
        vec2 d = pos.xy - uPointer;
        float infl = smoothstep(8.0, 0.0, length(d)) * uPointerStrength;
        pos.xy += normalize(d + vec2(1e-5)) * infl * 2.2;

        /*
         * ★ 不调 applyBeat()。
         *
         * 那个函数是"径向向外推 + 整体外扩"，对环、雨、隧道是对的，
         * 但对**一片水平铺开的波面**，径向推会把整片往外撑 —— 上下缘直接被推出画面。
         * 波浪的节奏感已经完全由上面的 amp 承担了。
         */

        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mv;

        /*
         * 波峰的点更大更亮 —— 这是"起伏"能被眼睛读出来的关键。
         * 只做位移的话，一密一疏的栅格看起来只是整体在晃。
         */
        float crest = smoothstep(-0.35, 1.0, wv);
        gl_PointSize = aSize * uPixelRatio * (10.5 / -mv.z)
                       * (0.80 + crest * 0.55)
                       * (1.0 + uPulse * 0.10);

        vAlpha = (0.30 + crest * 0.52)
                 * (0.86 + 0.14 * sin(uTime * 0.9 + aPhase * 2.0))
                 * edge
                 + infl * 0.35;
      }\`
    )
  );

  group.add(wave);
  return group;
}

${anchor}`;
    if (t.includes(anchor)) {
      t = t.replace(anchor, impl);
      n++;
      log('ok: buildWave');
    } else log('!! buildRain 锚点没找到');
  }

  // 注册到 EFFECT_LIST
  if (!t.includes("key: 'wave'")) {
    t = t.replace(
      `  { key: 'halo', name: '月蚀圣环',`,
      `  {
    key: 'wave',
    name: '波光',
    hint: '规则栅格上的低频起伏：三层正弦横向流动，节拍只让波峰变高，不炸开',
  },
  { key: 'halo', name: '月蚀圣环',`
    );
    n++;
  }

  // 注册到 BUILDERS
  if (!t.includes('wave: buildWave')) {
    t = t.replace(`  spectrum: buildSpectrum,`, `  wave: buildWave,\n  spectrum: buildSpectrum,`);
    n++;
  }

  fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
}

// ---------- ② settings.js：合法 key + 默认值 ----------
{
  const f = path.join(root, 'apps', 'ui', 'src', 'settings.js');
  let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

  if (!t.includes("'wave'")) {
    t = t.replace(
      `const EFFECT_KEYS = new Set([`,
      `const EFFECT_KEYS = new Set([\n  'wave',`
    );
    n++;
  }

  // 默认效果改成 wave，并做一次迁移（老用户也切过去）
  const oldVer = /const SETTINGS_VERSION = (\d+);/.exec(t);
  if (oldVer && !t.includes('/* wave-default */')) {
    const v = Number(oldVer[1]);
    t = t.replace(`const SETTINGS_VERSION = ${v};`, `const SETTINGS_VERSION = ${v + 1};`);
    t = t.replace(
      `export function loadSettings() {`,
      `export function loadSettings() {`
    );
    // 迁移：把 effect 换成 wave
    t = t.replace(
      `    // ---- 一次性迁移 ----`,
      `    // ---- 一次性迁移 ----
    /*
     * /* wave-default *\\/
     * 把默认背景效果换成「波光」。
     * 用户对原来那种"一拍就整体弹开"的观感不满意（原话："乱挑动了感觉，
     * 有些舒缓的歌都不匹配"），要的是有规律的舒缓起伏。
     * 老的设置里若存的还是 spectrum，一并迁过去。
     */
    if ((Number(parsed.settingsVersion) || 1) <= ${v}) {
      if (!parsed.effect || parsed.effect === 'spectrum') merged.effect = 'wave';
    }`
    );
    n++;
  }

  fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
}

log('改了 ' + n + ' 处');
