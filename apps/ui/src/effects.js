import * as THREE from 'three';

/**
 * 粒子效果库
 *
 * 每个效果都是**形态完全不同**的粒子系统，不是同一个效果换配色：
 *
 *   spectrum    声纹星盘   按真实频谱塑形的径向光针（16 段频率直接决定形状）
 *   spectrogram 声纹长卷   把过去几秒的音乐摊成一条向左流动的光河
 *   coral       光珊瑚     分叉枝干，鼓点化作一道光顺着枝杈跑向梢头
 *   tunnel      滚筒       舱壁绕视轴旋转，纵深隧道
 *   rain        粒子雨     受重力下落的粒子，带侧风摇摆
 *   vinyl       唱片       螺旋沟槽匀速转动，像黑胶
 *   halo        月蚀圣环   轨道环 + 日冕，指针推开环流
 *
 * ---------------------------------------------------------------------------
 * 一条设计教训（换掉过三个效果之后总结的）：**背景效果要走正面构图。**
 *
 * 曾经做过"涟漪深潭（水面）/ 极光帷幕 / 引力深渊（吸积盘）"，全是三维空间里的
 * 自然现象模拟。问题有两个层次：
 *   1. 上手就错：前两个把平面铺在了 y = 0，而摄像机正好在 (0,0,9) 即同一高度，
 *      整个面**侧对镜头**，渲染出来就是一条横线 —— 等于没画。
 *      再有深度也白搭，因为它们根本没进画面。
 *   2. 方向本身也不合适：它们要求观者去理解空间纵深，而这是**播放器的背景**，
 *      上面还压着半透明面板 —— 纵深既容易被挡住，也容易算错。
 *
 * 现在这三个都改成正面构图、零透视：在画面平面内把形状做足，
 * 尺寸差和亮度差负责层次，不依赖透视。既不可能"看不见"，
 * 也不会和界面抢注意力。
 * ---------------------------------------------------------------------------
 *
 * 性能约定（这是"流畅度"的关键）：
 *   - **所有运动都在顶点着色器里算**，CPU 每帧零计算，只更新几个 uniform
 *   - 每个效果只有 1 个 draw call
 *   - 换效果时按需重建几何，运行中不做任何几何操作
 *   - 指针/时间/脉冲/频谱通过共享 uniform 传入，避免每个效果各自维护状态
 */

const TAU = Math.PI * 2;

/**
 * 粒子精灵
 *
 * 关键：不要用 smoothstep 直接裁一个硬边圆点 —— 那样看着很"计算感"。
 * 用多段衰减拟合一张径向渐变精灵贴图（中心接近实心，外围拖一圈很长很淡的
 * 光晕），粒子才像"发光体"。配合泛光差别很明显。
 *
 * 拟合的渐变（半径归一化）：
 *   0.00 -> 0.96   0.42 -> 0.78   0.72 -> 0.22   1.00 -> 0
 */
const FRAG = `
varying vec3  vColor;
varying float vAlpha;

float softDot(float r) {
  // 光晕收紧：原来 22% 的透明度一直拖到 72% 半径，那片极淡的像素
  // 对观感贡献很小，却占了绝大部分填充率。收窄后覆盖面积减少约 40%，
  // 发光感由泛光后处理去补，观感基本不变。
  if (r >= 0.88) return 0.0;
  if (r < 0.36) return mix(0.95, 0.76, r / 0.36);
  if (r < 0.64) return mix(0.76, 0.16, (r - 0.36) / 0.28);
  return mix(0.16, 0.0, (r - 0.64) / 0.24);
}

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;   // 归一化到 0~1
  float a = softDot(r);
  if (a <= 0.001) discard;
  gl_FragColor = vec4(vColor, a * clamp(vAlpha, 0.0, 1.6));
}
`;

/** 每段顶点着色器都需要的公共声明与工具 */
const VERT_HEAD = `
attribute vec3  aColor;
attribute float aSize;
attribute float aPhase;
uniform float uTime;
uniform float uPulse;
uniform float uPixelRatio;
uniform vec2  uPointer;
uniform float uPointerStrength;
uniform float uBeatAmp;     // 节拍位移幅度，按效果尺度由 setEffect 设定
/**
 * 距离上一次鼓点过去了多少秒。
 *
 * 这是专门为"有创新感"的效果加的：只有 uPulse（一个起落的标量）时，
 * 效果最多只能做"整体鼓一下"；有了 uBeatAge 就能做**按时间展开的行波** ——
 * 涟漪从中心一圈圈荡开、冲击波向外扩张、极光沿着帷幕扫过去。
 * 这种"事件向外传播"的观感比整体缩放高级得多，也更贴节奏。
 */
uniform float uBeatAge;
/**
 * 实时频谱：把低频到高频分成 16 段，每段强度 0~1。
 *
 * 这是给"声纹星盘"用的 —— 它让效果能按**当前正在响的频率**来塑形，
 * 而不只是对鼓点做一次整体反应。低音段撑起内圈、高音段把外圈挑起来，
 * 于是同一段音乐在不同乐器进来时形状真的不一样。
 * 只有 16 个数，uniform 开销可以忽略。
 */
uniform float uBands[16];
/**
 * 频谱的历史长卷（宽 16 = 频段，高 128 = 时间，v 越大越新）。
 * "声纹长卷"靠它把过去几秒的音乐画出来，见 buildSpectrogram 的说明。
 */
uniform sampler2D uBandTex;
varying vec3  vColor;
varying float vAlpha;

/**
 * 节拍位移 —— 所有效果共用
 *
 * "跳动"和"闪烁"是两件事：跳是**位置**的变化，闪是**亮度**的变化。
 * 加色混合下，亮度一变、泛光再一放大，就是刺眼的频闪；
 * 而位置向外鼓出再弹回，看起来才是"跟着鼓点跳"。
 * 所以统一让粒子沿径向鼓出 + 略微前冲，各效果不必自己处理。
 *
 * 另外注意每个效果自己的 gl_PointSize 里也有一个 uPulse 项
 * （现在是 1.0 + uPulse * 0.10，曾经是 0.95，后来降到 0.30 仍偏亮）。
 * **那一项同样是在调亮度**：粒子是加色混合的，尺寸放大 N 倍等于面积放大 N² 倍。
 *   uPulse=0.9 时：0.95 → 面积 ×3.8（剧烈频闪）
 *                  0.30 → 面积 ×1.61（每秒近 4 拍，看久了仍然难受）
 *                  0.10 → 面积 ×1.19（轻微起伏，只剩一点"鼓一下"的呼吸感）
 * 跳动主要靠位移表达 —— **位移看得见却不刺眼，亮度变化才是"闪"的来源**。
 */
vec3 applyBeat(vec3 pos) {
  /*
   * ★ 方向必须是**径向向外**，不能每颗粒子一个随机方向。
   *
   * 原来是 dir = normalize(vec2(sin(aPhase*7.13), cos(aPhase*5.37)))，
   * 也就是每颗粒子每拍被推一个**随机方向**。对粗结构（雨、隧道、环）看不出问题，
   * 但对**细结构**是毁灭性的：唱片那 58 条沟槽间距只有约 11 像素，
   * 而这个位移峰值约 0.7 世界单位 ≈ 64 像素 —— 用 6 倍间距的随机抖动
   * 去砸一圈圈细纹，纹路必然散掉。
   * （我先前一直以为是点径和侧倾的问题，其实那些都只是次要因素。）
   *
   * 径向外推则只让整个结构**张缩**，相对几何关系保持不变 ——
   * 沟槽还是沟槽，只是整张唱片"鼓"了一下。
   *
   * 各颗粒子的差异改由**幅度**承担（vary 收窄到 0.55~1.10），
   * 保留"一颗颗在动"的观感，但不再打乱结构。
   */
  float vary = 0.55 + 0.55 * fract(aPhase * 0.15915);
  vec2 dir = normalize(pos.xy + vec2(1e-5));   // 径向向外
  float k = uPulse * vary;

  /*
   * 位移系数：0.55（最初）→ 1.45（我调过头了）→ 0.85（现在）。
   *
   * 中间那次 1.45 是矫枉过正：峰值位移 = uPulse × vary × uBeatAmp × 系数，
   * 代入 uPulse≈0.84、uBeatAmp=1.2×1.0（律动强度）算出来约 **1.46 个世界单位**，
   * 而"月蚀圣环"这类效果的环半径只有 3~8 单位 —— 粒子被推出去这么远，
   * 整个环的结构会被撑变形，看起来就像"效果突然重置/变了个样子"，
   * 而不只是"跳了一下"。跳动应该是**在原结构上弹一下**，不能改变结构本身。
   *
   * 0.85 配 0.8 的律动强度后峰值约 0.69 单位（重拍时个别粒子到 1.1），
   * 明显看得见，又不会把形状推散。
   */
  // 系数 0.85 → 0.45：径向推是"整张结构一起张缩"，同样幅度观感更强，
  // 降下来才能既不散结构、又看得出在跳（原来那一版的 0.85 是配随机方向用的）
  pos.xy += dir * k * uBeatAmp * 0.45;
  // 整体外扩给得很克制：相乘项一大会让整个结构"呼吸"到变形
  pos.xy *= 1.0 + k * uBeatAmp * 0.06;
  pos.z  += k * uBeatAmp * 0.30;
  return pos;
}
`;

export const EFFECT_LIST = [
  { key: 'cover', name: '封面粒子', hint: '封面网点跟着鼓点跳，不叠任何背景效果' },
  { key: 'spectrum', name: '声纹星盘', hint: '极坐标声纹：刻度针按频段逐格点亮，带雷达扫描与低音光核' },
  { key: 'spectrogram', name: '声纹长卷', hint: '把过去几秒的音乐摊成一条向左流动的光河' },
  { key: 'coral', name: '光珊瑚', hint: '分叉的枝干，鼓点化作一道光顺着枝杈跑向梢头' },
  { key: 'tunnel', name: '滚筒', hint: '舱壁绕视轴旋转，纵深隧道' },
  { key: 'rain', name: '粒子雨', hint: '受重力下落，带侧风摇摆' },
  { key: 'vinyl', name: '唱片', hint: '螺旋沟槽匀速转动，像黑胶' },
  {
    key: 'wave',
    name: '波浪',
    hint: '横向波线恒定缓慢起伏，完全不跟鼓点走',
  },
  { key: 'halo', name: '月蚀圣环', hint: '轨道环 + 日冕，指针推开环流' },
  { key: 'blackhole', name: '黑洞', hint: '事件视界 + 吸积盘 + 引力透镜，盘的光被弯到黑球上下' },
];

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function makeGeo(pos, col, size, phase, extra) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  for (const [name, arr, itemSize] of extra || []) {
    geo.setAttribute(name, new THREE.BufferAttribute(arr, itemSize));
  }
  return geo;
}

/**
 * 校验着色器源码是否完整。
 *
 * 为什么要做运行时校验，而不是写个静态检查脚本：
 * 我前后写过两版"扫反引号"的静态脚本，**两版都不可靠** ——
 * 第一版的判断分支是死代码、永远不报错；第二版信号选错，真出错时也不报。
 * 而这类 bug（在 GLSL 模板的注释里写反引号）真正的破坏是
 * **把着色器源码截断**，所以直接在构造时检查源码完整性最可靠：
 * 不管字符串是怎么被弄坏的，缺了主体就一定查得出来。
 *
 * 实测踩过的坑：注释里一个反引号让模板提前闭合，
 * 后面的 (aWeight*0.72 + ...) 被当成 JS 执行，抛 ReferenceError，
 * 封面几何整个没建出来、画面空白 —— 当时静态检查脚本还一直显示"通过"。
 */
function assertShaderOk(src, label) {
  const s = String(src || '');
  if (!s.includes('void main(')) {
    console.error(
      `[着色器] ${label} 源码不完整（找不到 void main）—— ` +
        `多半是模板字符串被注释里的反引号截断了。长度 ${s.length}`
    );
    return false;
  }
  // 顶点着色器必须有 gl_Position，片元着色器必须有 gl_FragColor
  if (label.includes('顶点') && !s.includes('gl_Position')) {
    console.error(`[着色器] ${label} 缺少 gl_Position，源码被截断。长度 ${s.length}`);
    return false;
  }
  if (label.includes('片元') && !s.includes('gl_FragColor')) {
    console.error(`[着色器] ${label} 缺少 gl_FragColor，源码被截断。长度 ${s.length}`);
    return false;
  }
  return true;
}

/**
 * @param {object} uniforms 共享 uniform
 * @param {string} vertBody 顶点着色器主体（会拼在 VERT_HEAD 之后）
 * @param {string} [fragBody] 可选：自定义片元着色器。
 *   默认用 FRAG（柔光点，适合发光点云）。像需要"实心圆盘带亮边"的效果，
 *   就必须换成自己的片元着色器 —— 柔光点画不出那种形态。
 *   自定义时必须自己声明 varying vec3 vColor / varying float vAlpha。
 */
function makeMat(uniforms, vertBody, fragBody) {
  const vert = VERT_HEAD + vertBody;
  const frag = fragBody || FRAG;
  // 构造时就校验，坏掉的着色器立刻在日志里点名，而不是留到画面空白再猜
  assertShaderOk(vert, '顶点着色器');
  assertShaderOk(frag, '片元着色器');
  return new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: vert,
    fragmentShader: frag,
  });
}

/** 收集所有 Points 对象，方便统一换配色和释放 */
function collect(root, out) {
  root.traverse((o) => {
    if (o.isPoints) out.push(o);
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* 1. 星云光带                                                         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 2. 旋转星系                                                         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 3. 星际穿越                                                         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 4. 声波矩阵                                                         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 5. 粒子雨                                                           */
/* ------------------------------------------------------------------ */

function buildWave(U, opts) {
  /*
   * 「波浪」—— 横向波带，跟着音乐走。见本函数上方的大段说明。
   */
  const bands = opts.bands ?? 6;
  const perBand = opts.perBand ?? 7000;
  const spanX = opts.spanX ?? 30;
  const spanY = opts.spanY ?? 12;
  /*
   * 由带间距推出厚度和幅度：
   *   厚度必须远小于间距，带与带之间才有空隙（否则糊成一片雾 ✗）
   *   幅度必须小于间距的一半，否则相邻带会互相穿透、看不出层次 ✗
   */
  const spacing = bands > 1 ? spanY / (bands - 1) : spanY;
  /*
   * ★ 厚度必须**很小**。
   *
   * 用户一直说"做的不对，波浪啊" —— 问题在这里：
   * 厚度给到间距的 17%（±0.5 世界单位）时，每条带是一**团雾**，
   * 屏幕上看到的是"几排点"，不是"一波一波的曲线" ✗
   * 收成 7%（±0.2）之后它才是一条**线**，起伏才读得出来 ✓
   */
  const thick = opts.thick ?? spacing * 0.07;
  /*
   * ★ 幅度有**硬上界**：总位移必须小于间距的一半。
   *
   * 相邻两条带的间距是 spacing。只要某处的位移差超过 spacing，
   * 两条带就会**互相穿透、堆在一起** —— 屏幕上就是一团亮斑 ✗
   *（用户看到的"最左边还是跳动、越做越烂"就是这个：
   *  基础 0.42 + 鼓点浪 1.6×0.42 = 1.82 倍间距，早就越界了 ✗）
   *
   * 所以：基础 0.28、鼓点最多再加 0.21 —— 合计 0.49 < 0.5 ✓
   * 刚好贴到极限但不越界：起伏给足，又永远不会撞在一起。
   */
  const amp = opts.amp ?? spacing * 0.28;
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
      /*
       * z 方向要**收拢**：点径按 1/(-mv.z) 算，z 一散开点径就忽大忽小，
       * 线就发虚 ✗ 收到 ±0.8 之后每颗点大小一致，一条线才是干净的。
       */
      pos[k * 3 + 2] = (Math.random() - 0.5) * 1.6 - 1.0;

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
      `
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
        /*
         * ★ 起点必须在**画面之外**。
         *
         * 画面可见范围是 x ∈ ±15。我原来写 -9 —— 那在画面**内部**，
         * 于是每一拍都有一团亮斑在左侧凭空出现然后往右扫 ✗
         * 用户的原话："他妈的为什么左侧在跳动啊恶心死了"。
         * 改成 -16（画面外）之后，浪是**从边界外涌进来**的，不再是"冒出来" ✓
         *
         * 再乘上 xFade：即使它刚好在边界附近，也是淡的，不会有硬边 ✗→✓
         */
        /*
         * ★ 这里**没有**鼓点浪。
         *
         * 用户："我不要跳动啊"。
         * 我先后做过两种节拍响应 —— 鼓点环、以及一道从左向右扫过去的浪 ——
         * 两者在他眼里都是"跳动"✗
         * 波浪要的是**恒定、匀速、有规律**的起伏：节奏感来自波自己流过去，
         * 不来自对鼓点的反应。所以这里干脆一点都不跟节拍走。
         */
        float swell = 0.0;

        /*
         * 低音抬**幅度**（不是缩放整片 —— 那是"画面呼吸"，用户明确否过 ✗）
         */
        // 幅度是**常数**，低音也不影响 —— 见上面关于"不要跳动"的说明
        float a = aAmp;
        pos.y += wv * a + swell * a * 0.75;

        /* 上下位置的带起伏小一点、中间的带大 —— 整体有一个柔和收束 */
        float bandShrink = 0.68 + 0.32 * (1.0 - abs(aBandT - 0.5) * 2.0);
        pos.y = position.y + (pos.y - position.y) * bandShrink;

        /*
         * ★ 波浪**不做鼠标交互**。
         *
         * 其它效果都在钳针位置推挤粒子+提亮，对它们没问题；
         * 但这里每颗粒子都在一条**细波长线**上，指针一推就在线上鼓出一团亮斑 ✗
         * 鼠标一动亮斑就跟着跳 —— 用户的原话："左侧在跳动，恶心死了" ✗
         * 细线的美在匀净，任何局部扰动都会被放大。
         */
        float infl = 0.0;

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

        /*
         * 点径系数校准过两次：15 时几乎看不见（截图就是一片黑）✗，
         * 涟漪那版最后落在 21 才清楚。摄像机在 z=9、粒子在 z≈-1~-4，
         * 所以屏幕上的实际点径 ≈ 系数 × aSize / 10 左右 —— 要 2~4 像素才够。
         */
        gl_PointSize = aSize * uPixelRatio * (22.0 / -mv.z) * (0.72 + crest * 0.72);
        vAlpha = (0.26 + crest * 0.62) * soft * xFade
                 * (0.90 + 0.10 * sin(uTime * 0.9 + aPhase * 2.0))
                 + infl * 0.3;
      }`
    )
  );

  group.add(wave);
  return group;
}
function buildRain(U, opts) {
  /*
   * 「粒子雨」重写版。
   *
   * 旧版为什么读不出"雨"（把七个效果单独截出来审查时才看明白）：
   *   ① 画的是**圆点**。雨的形态特征是**竖直的条痕** —— 圆点再密也只是星空，
   *      永远不像雨。这是根子上的错。
   *   ② 体积 44x40x30 摊得太开，16000 颗撒进去屏幕上就没几颗。
   *   ③ alpha 只有 0.25~0.53，配上深色背景几乎看不见。
   *
   * 现在：
   *   · 每颗雨滴用一个**竖直条痕**的片元着色器（横窄、纵长、两端渐隐）
   *   · 体积收紧到 30x26x20 → 同样的点数密一倍多
   *   · 下落更快、每颗速度差更大 → 有速度层次
   *   · 亮度提上来（alpha 0.5~0.95）
   */
  const count = opts.count ?? 18000;
  const group = new THREE.Group();

  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  const fall = new Float32Array(count);

  const H = 26; // 竖直范围，也是循环周期

  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 30;
    pos[i * 3 + 1] = (Math.random() - 0.5) * H;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 20 - 3;
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 1;
    /*
     * 精灵尺寸 = 条痕长度。雨滴的"长"就是它的速度感，
     * 所以这里给得很宽（1.6~5.4），快的雨滴拉得更长。
     */
    size[i] = 1.6 + Math.random() * 3.8;
    phase[i] = Math.random() * TAU;
    // 速度差做大（0.6~2.4）：有快有慢，画面才有雨帘的层次
    fall[i] = 0.6 + Math.random() * 1.8;
  }

  const rain = new THREE.Points(
    makeGeo(pos, col, size, phase, [['aFall', fall, 1]]),
    makeMat(
      U,
      `
      attribute float aFall;
      void main() {
        vColor = aColor;
        vec3 pos = position;
        /*
         * 下落：位移与时间成正比（不做加速度 —— 加了反而显得一顿一顿的，
         * 匀速下落配速度差就已经够"像雨"了）。
         */
        float y = mod(pos.y - uTime * 9.0 * aFall + ${(H * 0.5).toFixed(1)}, ${H.toFixed(1)}) - ${(H * 0.5).toFixed(1)};
        pos.y = y;
        // 侧风摇摆：越往下偏得越多，像被风吹斜的雨帘
        pos.x += sin(uTime * 0.7 + aPhase) * 2.4 * (1.0 - (y + ${(H * 0.5).toFixed(1)}) / ${H.toFixed(1)});
        // 每一滴自己的小幅偏移，破掉"整片一起摆"的机械感
        pos.x += sin(uTime * 1.3 + aPhase * 2.1) * 0.6;

        // 指针像一阵风，把雨推开
        vec2 d = pos.xy - uPointer;
        float infl = smoothstep(9.0, 0.0, length(d)) * uPointerStrength;
        pos.xy += normalize(d + vec2(1e-5)) * infl * 4.0;

        pos = applyBeat(pos);   // 鼓点时向外鼓出（位移，不是亮度）
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mv;
        // 落得快的点更长更亮，速度感更强
        gl_PointSize = aSize * uPixelRatio * (11.5 / -mv.z) * (0.55 + aFall * 0.6) * (1.0 + uPulse * 0.10);
        vAlpha = (0.50 + aFall * 0.22) * (0.9 + 0.1 * sin(uTime * 2.4 + aPhase * 3.0))
                 + uPulse * 0.02 + infl * 0.55;
      }`,
      /*
       * 雨滴的片元着色器：**竖直条痕**，不是圆点。
       *
       * 横向上很快收窄（0.10~0.42 就走完渐隐），纵向上贯穿整个精灵
       * （0.45~1.0 才收），于是每条都是一个细长的雨丝。
       * 这是让"粒子"读出"雨"的关键一笔 —— 圆点做不到。
       *
       * 自定义片元着色器必须自己声明这两个 varying（见 makeMat 的说明）。
       */
      `
      varying vec3  vColor;
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float x = abs(c.x) * 2.0;
        float y = abs(c.y) * 2.0;
        float a = (1.0 - smoothstep(0.10, 0.42, x))
                * (1.0 - smoothstep(0.45, 1.0, y));
        if (a <= 0.004) discard;
        gl_FragColor = vec4(vColor, a * clamp(vAlpha, 0.0, 1.6));
      }`
    )
  );

  rain.frustumCulled = false;
  rain.userData.tintable = true;
  group.add(rain);
  return group;
}

/* ------------------------------------------------------------------ */
/* 6. 粒子球体                                                         */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 7. 唱片                                                             */
/* ------------------------------------------------------------------ */

function buildVinyl(U, opts) {
  const count = opts.count ?? 26000;
  const group = new THREE.Group();

  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  const radius = new Float32Array(count);
  const groove = new Float32Array(count);

  /*
   * ★ 沟槽必须"每条是一整圈"，而不是"一条螺旋线"。
   *
   * 旧版写的是 a = r * 16.5 + jitter，也就是**角度是半径的确定函数**，
   * 角度抖动只有 ±0.08 弧度 —— 同一半径上的粒子几乎都在同一个角度，
   * 于是 26000 颗全挤在**一条又细又长的螺旋线**上。
   * 单独截出来看就是"一片均匀噪点"：不是密度不够，是**根本没有圈**。
   * 这就是它读不出"唱片"的原因。
   *
   * 现在：半径量化到 GROOVES 条沟槽，每条沟槽在整圈上随机撒点，
   * 而沟槽序号给出一个整体角偏移（g * 0.85 弧度）—— 相邻沟槽错开，
   * 连起来才是螺旋。远看是一圈圈的纹路，近看点是散的。
   */
  const GROOVES = 58;
  const R_IN = 0.8;
  const R_OUT = 8.0;
  const pitch = (R_OUT - R_IN) / GROOVES;

  for (let i = 0; i < count; i++) {
    const g = Math.floor(Math.random() * GROOVES);
    // 半径落在该条沟槽上，只留很小的抖动（太大就糊成一片，沟槽感就没了）
    const r = R_IN + (g + (Math.random() - 0.5) * 0.22) * pitch;
    // 整圈随机 + 按沟槽序号整体错开 → 圈与圈连成螺旋
    const a = Math.random() * TAU + g * 0.85;

    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = Math.sin(a) * r;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 0.1;

    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 1;
    // 越靠外颗粒略大（视觉上像唱片的边缘反光）
    const t = (r - R_IN) / (R_OUT - R_IN);
    /*
     * 点径标定（我在这里 over-correct 过一次，把数字留下来）：
     *   沟槽间距 = 7.2/58 ≈ 0.124 世界单位 ≈ 设备像素 11px
     *   目标点径 ≈ 3px（约占间距 30% —— 环清楚，点又不糊）
     *   实际点径 = size × (8.6/9) × uPixelRatio(1.5)
     *            = size × 0.956 × 1.5 = size × 1.43
     *   → size 要落在 1.6~2.6
     * 我先写成 0.45~1.2，乘完只有 0.65~1.7px，整片几乎看不见。
     */
    size[i] = (1.60 + Math.random() * 1.00) * (0.90 + t * 0.35);
    phase[i] = Math.random() * TAU;
    radius[i] = r;
    // 沟槽序号归一化：着色器用它做明暗交错，让"纹路"更明显
    groove[i] = g / GROOVES;
  }

  const disc = new THREE.Points(
    makeGeo(pos, col, size, phase, [['aRadius', radius, 1], ['aGroove', groove, 1]]),
    makeMat(
      U,
      `
      attribute float aRadius;
      attribute float aGroove;
      void main() {
        vec3 pos = position;
        // 唱片整体匀速转动：角速度恒定，所以外圈线速度更快（和真实唱片一致）
        float ang = uTime * 1.0;
        mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
        pos.xy = rot * pos.xy;

        // 轻微上下浮动，让它不是一张死平面
        pos.z += sin(uTime * 1.3 + aRadius * 0.9 + aPhase) * 0.06;

        // 指针把邻近的粒子往上抬，像指针压在唱片上
        vec2 d = pos.xy - uPointer;
        float infl = smoothstep(4.6, 0.0, length(d)) * uPointerStrength;
        pos.z += infl * 1.1;
        pos.xy += normalize(d + vec2(1e-5)) * infl * 0.5;

        // 整体侧倾，露出一点厚度
        pos = applyBeat(pos);   // 鼓点时向外鼓出（位移，不是亮度）

        vec3 tilted = vec3(pos.x, pos.y * 0.9 + pos.z * 0.32, pos.z * 0.9 - pos.y * 0.32);

        vec4 mv = modelViewMatrix * vec4(tilted, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uPixelRatio * (8.6 / -mv.z) * (1.0 + uPulse * 0.10);

        /*
         * 逐条沟槽明暗交替 —— 这是让"纹路"读出来的关键一笔。
         *
         * 旧版是 step(0.5, aGroove)，而 aGroove 当时是随机数，
         * 等于把唱片随机切成两半，看不出任何纹路。
         * 现在 aGroove 是归一化的沟槽序号，乘回条数就得到序号本身，
         * sin 一下就得到"明-暗-明-暗"的环 —— 一圈圈的纹路立刻出来。
         */
        float gIdx = aGroove * ${GROOVES}.0;
        float grooveShade = 0.5 + 0.5 * sin(gIdx * 3.14159265);
        float edge = 1.0 - smoothstep(5.0, 8.1, aRadius);
        vAlpha = (0.48 + grooveShade * 0.50) * (0.9 + 0.1 * sin(uTime * 1.6 + aPhase * 3.0))
                 + uPulse * 0.02 + infl * 0.5;
        vColor = aColor * (0.55 + grooveShade * 0.5) * (0.6 + edge * 0.6);
      }`
    )
  );

  disc.frustumCulled = false;
  disc.userData.tintable = true;
  group.add(disc);
  // 侧倾从 0.42 减到 0.20：倾斜会把同心环压扁、互相重叠，纹路就糊了`r`n  group.rotation.x = -0.20;
  return group;
}

/* ------------------------------------------------------------------ */
/* 8. 滚筒（隧道）                                                     */
/* ------------------------------------------------------------------ */

function buildTunnel(U, opts) {
  const count = opts.count ?? 24000;
  const group = new THREE.Group();

  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  const along = new Float32Array(count); // 在隧道轴上的位置 0~1
  const ang = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // 贴着圆柱内壁分布，但要有厚度，否则像一层纸
    const r = 7.2 * (0.94 + Math.random() * 0.12);
    const a = Math.random() * TAU;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = Math.sin(a) * r;
    pos[i * 3 + 2] = -26 + Math.random() * 52;

    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 1;
    size[i] = 0.9 + Math.random() * 2.1;
    phase[i] = Math.random() * TAU;
    along[i] = (pos[i * 3 + 2] + 26) / 52;
    ang[i] = a;
  }

  const tunnel = new THREE.Points(
    makeGeo(pos, col, size, phase, [['aAlong', along, 1], ['aAng', ang, 1]]),
    makeMat(
      U,
      `
      attribute float aAlong;
      attribute float aAng;
      void main() {
        vec3 pos = position;
        // 舱壁整体绕视轴旋转（滚筒感），并沿轴向缓慢推进
        float spin = uTime * 0.62;
        mat2 rot = mat2(cos(spin), -sin(spin), sin(spin), cos(spin));
        pos.xy = rot * pos.xy;

        float z = mod(pos.z + uTime * 9.0 + 26.0, 52.0) - 26.0;
        pos.z = z;

        // 沿圆周的波纹，像滚筒上的环带
        float ripple = sin(aAng * 6.0 + uTime * 1.2 + aAlong * 10.0) * 0.7;
        pos.xy += normalize(pos.xy + vec2(1e-5)) * ripple;

        // 指针把舱壁压出一个凹坑
        vec2 d = pos.xy - uPointer;
        float infl = smoothstep(8.5, 0.0, length(d)) * uPointerStrength;
        pos.xy += normalize(d + vec2(1e-5)) * infl * 3.0;

        pos = applyBeat(pos);   // 鼓点时向外鼓出（位移，不是亮度）
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mv;

        // 越远越小，纵深靠这个拉开
        float depth01 = 1.0 - smoothstep(0.0, 46.0, abs(z));
        gl_PointSize = aSize * uPixelRatio * (21.6 / -mv.z) * (0.5 + depth01 * 0.9) * (1.0 + uPulse * 0.10);

        // 远端淡出，避免看到回卷的接缝
        vAlpha = smoothstep(26.0, 10.0, abs(z)) * 0.7 + uPulse * 0.02 + infl * 0.45;
        vColor = aColor * (0.6 + depth01 * 0.8);
      }`
    )
  );

  tunnel.frustumCulled = false;
  tunnel.userData.tintable = true;
  group.add(tunnel);
  return group;
}

/* ------------------------------------------------------------------ */
/* 9. 音域回响（地形）                                                 */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 10. 月蚀圣环                                                        */
/* ------------------------------------------------------------------ */

function buildHalo(U, opts) {
  const rings = opts.rings ?? 7;
  const perRing = opts.perRing ?? 3200;
  const total = rings * perRing;
  const group = new THREE.Group();

  const pos = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  const size = new Float32Array(total);
  const phase = new Float32Array(total);
  const ringId = new Float32Array(total);
  const tilt = new Float32Array(total);
  const radius = new Float32Array(total);

  let n = 0;
  for (let r = 0; r < rings; r++) {
    // 每条环自己的半径、倾角、相位，避免所有环叠在一个平面上
    const R = 3.2 + r * 1.05 + Math.random() * 0.5;
    const tiltA = (Math.random() - 0.5) * 1.5;
    const thick = 0.1 + Math.random() * 0.22;

    for (let i = 0; i < perRing; i++) {
      const a = (i / perRing) * TAU + Math.random() * 0.02;
      const rr = R + (Math.random() - 0.5) * thick;

      const x = Math.cos(a) * rr;
      const y = Math.sin(a) * rr;
      // 绕 x 轴倾斜
      const z = y * Math.sin(tiltA) + (Math.random() - 0.5) * thick;

      pos[n * 3] = x;
      pos[n * 3 + 1] = y * Math.cos(tiltA);
      pos[n * 3 + 2] = z;

      col[n * 3] = col[n * 3 + 1] = col[n * 3 + 2] = 1;
      size[n] = 0.8 + Math.random() * 1.8;
      phase[n] = Math.random() * TAU;
      ringId[n] = r;
      tilt[n] = tiltA;
      radius[n] = rr;
      n++;
    }
  }

  const halo = new THREE.Points(
    makeGeo(pos, col, size, phase, [
      ['aRing', ringId, 1],
      ['aTilt', tilt, 1],
      ['aRadius', radius, 1],
    ]),
    makeMat(
      U,
      `
      attribute float aRing;
      attribute float aTilt;
      attribute float aRadius;
      void main() {
        vec3 pos = position;
        // 每条环以不同角速度绕 y 轴公转，形成轨道盘
        float speed = 0.32 / (0.5 + aRing * 0.22);
        float a = uTime * speed;
        mat2 rot = mat2(cos(a), -sin(a), sin(a), cos(a));
        pos.xz = rot * pos.xz;

        // 环上的粒子自己也在抖，像尘埃
        pos += vec3(sin(uTime * 1.7 + aPhase), cos(uTime * 1.5 + aPhase * 1.4), sin(uTime * 1.3 + aPhase * 2.0)) * 0.075;

        // 指针把环流推开
        vec2 d = pos.xy - uPointer;
        float infl = smoothstep(7.0, 0.0, length(d)) * uPointerStrength;
        pos.xy += normalize(d + vec2(1e-5)) * infl * 2.2;

        pos = applyBeat(pos);   // 鼓点时向外鼓出（位移，不是亮度）
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uPixelRatio * (12.2 / -mv.z) * (1.0 + uPulse * 0.10);

        // 中心是"蚀"：内圈被遮暗，只有最内层靠近日冕的地方亮
        float inner = smoothstep(2.6, 4.6, aRadius);
        vAlpha = (0.16 + inner * 0.5) * (0.888 + 0.112 * sin(uTime * 2.2 + aPhase * 3.0))
                 + uPulse * 0.02 + infl * 0.5;
        vColor = aColor * (0.35 + inner * 1.15);
      }`
    )
  );

  halo.frustumCulled = false;
  halo.userData.tintable = true;
  group.add(halo);

  /* 日冕：中心一小团高亮粒子，是"月蚀"里透出来的光 */
  {
    const coronaCount = opts.corona ?? 2600;
    const cp = new Float32Array(coronaCount * 3);
    const cc = new Float32Array(coronaCount * 3);
    const cs = new Float32Array(coronaCount);
    const cph = new Float32Array(coronaCount);

    for (let i = 0; i < coronaCount; i++) {
      const a = Math.random() * TAU;
      const r = 2.3 + Math.pow(Math.random(), 0.4) * 1.5;
      cp[i * 3] = Math.cos(a) * r;
      cp[i * 3 + 1] = Math.sin(a) * r * 0.9;
      cp[i * 3 + 2] = (Math.random() - 0.5) * 0.7;
      cc[i * 3] = cc[i * 3 + 1] = cc[i * 3 + 2] = 1;
      cs[i] = 1.4 + Math.random() * 2.6;
      cph[i] = Math.random() * TAU;
    }

    const corona = new THREE.Points(
      makeGeo(cp, cc, cs, cph),
      makeMat(
        U,
        `
        void main() {
          vec3 pos = position;
          float a = uTime * 0.5;
          mat2 rot = mat2(cos(a), -sin(a), sin(a), cos(a));
          pos.xy = rot * pos.xy;
          // 日冕沿半径方向呼吸
          pos.xy *= 1.0 + sin(uTime * 1.9 + aPhase) * 0.075 + uPulse * 0.06;

          pos = applyBeat(pos);   // 鼓点时向外鼓出（位移，不是亮度）
          vec4 mv = modelViewMatrix * vec4(pos, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uPixelRatio * (14.4 / -mv.z) * (1.0 + uPulse * 0.10);
          vAlpha = 0.4 * (0.86 + 0.14 * sin(uTime * 3.0 + aPhase)) + uPulse * 0.02;
          vColor = aColor;
        }`
      )
    );
    corona.frustumCulled = false;
    corona.userData.tintable = true;
    group.add(corona);
  }

  return group;
}

/* ------------------------------------------------------------------ */
/* 正面构图的新效果                                                     */
/* ------------------------------------------------------------------ */

/**
 * 声纹长卷 —— 把过去几秒的音乐画成一条光河
 *
 * 这是我自己最想做的一个。已有的频谱类可视化（包括"声纹星盘"）
 * 都只画**当下这一刻**：音乐一过形状就没了，你看到的永远是"此刻"，
 * 而音乐是有走向的 —— 鼓点落在哪、旋律怎么爬、副歌什么时候进来。
 *
 * 这个效果把**时间轴摊开**：横轴是时间（右边最新，往左越来越旧），
 * 纵轴是频率（下面低音、上面高音），每一点的亮度就是那一瞬间那个频段的强度。
 * 于是画面变成一条向左流动的光河，你看的是**刚才那几秒音乐的样子**。
 * 频谱历史存在纹理里，所以"滚动"只是一次 2KB 的内存搬移，零额外成本。
 *
 * 亮度之外还加了两层：
 *   · 越强的格子往镜头方向凸出（z 位移）—— 形成起伏的"山谷"
 *   · 低频行的粒子更大 —— 低音在视觉上更有重量
 */
function buildSpectrogram(U, opts) {
  const COLS = 220; // 时间方向的分辨率
  const ROWS = 34;  // 频率方向的分辨率
  const count = COLS * ROWS;

  // 铺满正面可见范围（半宽 6.79 / 半高 4.39），四周留余量
  const HALF_W = 6.4;
  const HALF_H = 4.0;

  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  const uv = new Float32Array(count * 2); // (频段, 时间)

  let n = 0;
  for (let cx = 0; cx < COLS; cx++) {
    const u = cx / (COLS - 1); // 时间：0 在左（旧），1 在右（新）
    for (let ry = 0; ry < ROWS; ry++) {
      const v = ry / (ROWS - 1); // 频率：0 在下（低音），1 在上（高音）

      pos[n * 3] = (u - 0.5) * 2 * HALF_W;
      pos[n * 3 + 1] = (v - 0.5) * 2 * HALF_H;
      pos[n * 3 + 2] = 0;

      col[n * 3] = col[n * 3 + 1] = col[n * 3 + 2] = 1;
      // 低频行的点更大：低音在视觉上更有重量，也让整条河有上下层次
      size[n] = (0.75 + Math.random() * 0.5) * (1.25 - v * 0.5);
      phase[n] = Math.random() * TAU;
      uv[n * 2] = v;     // 纹理 u → 频段
      uv[n * 2 + 1] = u; // 纹理 v → 时间
      n++;
    }
  }

  const points = new THREE.Points(
    makeGeo(pos, col, size, phase, [['aUV', uv, 2]]),
    makeMat(
      U,
      `
      attribute vec2 aUV;
      void main() {
        /*
         * 从历史纹理取这一刻这个频段的强度。
         * 纹理布局是 宽=频段(16) × 高=时间(128)，见 particles.js 的说明，
         * 所以采样坐标就是 (频段, 时间)。
         */
        float amp = texture2D(uBandTex, aUV).r;

        vec3 p = position;

        /*
         * 强度越高越往镜头方向凸出 —— 明亮区域会"长高"，
         * 整条河因此有起伏，而不是一块平的显示板。
         */
        p.z += amp * 2.2;

        // 高频的格子轻微上下抖动，像光在流动；低频保持稳定
        p.y += sin(uTime * 1.1 + aPhase + aUV.y * 40.0) * 0.06 * aUV.x;

        // 鼓点时整条河轻微向外呼吸（位移，不是变亮）
        p.xy *= 1.0 + uPulse * uBeatAmp * 0.05;

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;

        /*
         * 尺寸随强度放大 —— 这是主力表达：
         * 安静的段落是细密的暗点阵，鼓点砸下来就是一片明亮的大光点。
         */
        gl_PointSize = aSize * uPixelRatio * (9.5 / -mv.z) * (0.75 + amp * 1.9);

        /*
         * 亮度：底噪压得很低（0.035），"没有声音"的地方几乎看不见，
         * 有声音的部分自然跳出来，对比强烈。
         */
        /*
         * 基色从 0.035 提到 0.12。
         * 原来静音段几乎是纯黑 —— 七个效果单独审查时才看出来：
         * 形态是对的，但配上界面就完全看不见。
         */
        vAlpha = 0.12 + amp * 0.80;
        vColor = aColor * (0.28 + amp * 1.35);
      }`
    )
  );

  points.frustumCulled = false;
  points.userData.tintable = true;
  const group = new THREE.Group();
  group.add(points);
  return group;
}

/**
 * 光珊瑚 —— 沿着分叉枝干传递的光
 *
 * 想法：其他效果都在"空间里撒点"，而这个是**有骨架的**。
 * 枝干用递归分叉生成（像珊瑚或霜花），光沿枝干从根部往梢头传 ——
 * 每一下鼓点放出一道光，顺着所有枝杈同时往外跑，到梢头散掉。
 * 梢头再按高音频段的强度发亮，所以镲片一进来，满树梢头就闪起来。
 *
 * 正面构图：枝干生成时就摊在画面平面内，不涉及透视 ——
 * 结构一眼看懂，也不会出现"平面侧对镜头"那类问题。
 */
function buildCoral(U, opts) {
  const segs = [];
  const rand = (a, b) => a + Math.random() * (b - a);

  /** 递归分叉。ang：0 = 向上 */
  function grow(x, y, ang, len, depth, along0) {
    if (depth <= 0 || len < 0.12) return;
    const x2 = x + Math.sin(ang) * len;
    const y2 = y + Math.cos(ang) * len;
    segs.push({ x1: x, y1: y, x2, y2, along0, along1: along0 + 0.16 });
    const next = along0 + 0.16;
    const branches = depth > 3 ? 2 : Math.random() < 0.45 ? 3 : 2;
    for (let i = 0; i < branches; i++) {
      const spread = rand(0.3, 0.62) * (i === 0 ? -1 : 1);
      grow(x2, y2, ang + spread, len * rand(0.68, 0.84), depth - 1, next);
    }
  }

  // 从画面下方中央往上长（半高 4.39，所以 y 从 -3.6 起）
  grow(0, -3.6, 0, 1.5, 6, 0);

  const count = opts.count ?? 20000;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  const along = new Float32Array(count);
  const dir = new Float32Array(count * 2);

  for (let i = 0; i < count; i++) {
    const s = segs[(Math.random() * segs.length) | 0];
    const t = Math.random();
    const x = s.x1 + (s.x2 - s.x1) * t;
    const y = s.y1 + (s.y2 - s.y1) * t;

    // 沿垂直枝干的方向散开一点，枝干才有粗细和绒感，而不是一根数学线
    const nx = -(s.y2 - s.y1);
    const ny = s.x2 - s.x1;
    const nl = Math.hypot(nx, ny) || 1;
    const off = (Math.random() - 0.5) * 0.14;

    pos[i * 3] = x + (nx / nl) * off;
    pos[i * 3 + 1] = y + (ny / nl) * off;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 0.7;

    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 1;
    size[i] = 0.8 + Math.random() * 1.2;
    phase[i] = Math.random() * TAU;
    along[i] = s.along0 + (s.along1 - s.along0) * t;
    dir[i * 2] = nx / nl;
    dir[i * 2 + 1] = ny / nl;
  }

  const points = new THREE.Points(
    makeGeo(pos, col, size, phase, [
      ['aAlong', along, 1],
      ['aDir', dir, 2],
    ]),
    makeMat(
      U,
      `
      attribute float aAlong;
      attribute vec2  aDir;
      void main() {
        vec3 p = position;

        // 水流般的摇曳：越靠梢头摆得越大，像珊瑚在水流里
        p.x += sin(uTime * 0.55 + aAlong * 3.0) * 0.16 * aAlong;
        p.xy += aDir * sin(uTime * 0.9 + aPhase * 2.0) * 0.045 * aAlong;

        /*
         * 鼓点：一道光从根部出发、沿枝干往外传。
         * 用 uBeatAge（距上次鼓点的秒数）算光走到了哪儿 ——
         * 它不是"整棵树一起亮"，而是**一道光顺着枝杈跑出去**，到梢头散掉。
         * 这是这个效果最有生命力的地方。
         */
        float front = clamp(uBeatAge * 1.9, 0.0, 1.4);
        float wave = exp(-pow((aAlong - front) / 0.13, 2.0)) * max(0.0, 1.0 - uBeatAge * 0.55);

        /*
         * 梢头按**高音**发亮：取最高三段（13~15）的平均。
         * 镲片、弦乐泛音一进来，满树梢头就闪。
         */
        float treble = (uBands[13] + uBands[14] + uBands[15]) / 3.0;
        float tip = smoothstep(0.55, 1.0, aAlong) * treble;

        // 鼓点时整棵树轻轻向外张开
        p.xy *= 1.0 + uPulse * uBeatAmp * 0.045;

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;

        gl_PointSize = aSize * uPixelRatio * (10.5 / -mv.z)
                       * (0.8 + wave * 1.6 + tip * 1.0);

        /*
         * 亮度分三层，相加而不是相乘，所以谁在响谁就明显、互不掩盖：
         *   基础 —— 暗但不为零，枝干结构始终看得见
         *   光波 —— 那道顺着枝干跑的光（主体）
         *   梢头 —— 跟着高音闪
         */
        /*
         * 基色 0.055 → 0.16。理由同长卷：形态正确但存在感不足，
         * 枝条在界面上几乎看不见，只剩梢头几点。
         */
        vAlpha = 0.16 + aAlong * 0.09 + wave * 0.92 + tip * 0.46;
        vColor = aColor * (0.34 + wave * 1.5 + tip * 0.8);
      }`
    )
  );

  points.frustumCulled = false;
  points.userData.tintable = true;
  const group = new THREE.Group();
  group.add(points);
  return group;
}

/**
 * 声纹星盘 —— 按真实频谱塑形的径向图形
 *
 * 这是**方向上的改变**：前面三个（水面、极光、吸积盘）都是三维空间里的自然现象模拟，
 * 需要观者去理解纵深，而这是音乐播放器的背景，上面还压着面板，纵深既容易被挡住、
 * 又容易算错（前三个里有两个就是因为平面正好和摄像机同高、整个侧对镜头而"看不见"）。
 *
 * 这一个改成：**正面构图、零透视、一眼就知道在表达音乐。**
 * 每一根辐条对应一个频段，辐条长度直接由 uBands 里那段频率的强度决定 ——
 * 所以鼓进来时内圈撑开、镲片进来时外圈发亮，形状是真的跟着音乐在变，
 * 而不是"整体抖一下"。
 *
 * 布局：角度按频段从低到高环绕一圈，同一条辐条上按半径铺多颗粒子，
 * 形成"从中心射出的光针"，比一根实线更有粒子和光的质感。
 */
function buildSpectrum(U, opts) {
  /*
   * 「声纹星盘」重做版 —— 从"十六根粗光柱"改成"一台极坐标声纹仪"。
   *
   * 旧版为什么不行（我看截图才想明白）：
   *   16 根辐条，每根塞 1500 颗粒子，用加色混合叠在一起，再被泛光一糊 ——
   *   出来就是十几条**粗、软、雾**的白带子，从黑心往外射。
   *   而且每根的长度虽然由频段决定，但动态范围被压扁，看起来条条一样长，
   *   于是整幅图像一朵蒲公英，或者说一片溅开的白漆。
   *   最根本的问题是：**它把粒子当笔画用**，而粒子叠在一起是糊的。
   *
   * 新版反过来：**把粒子当刻度点用**。
   *   · 96 根细针，不再是 16 根粗柱 —— 针与针之间留空，形状立刻清楚
   *   · 每根针是一串**离散的点**（固定半径格），点与点之间有缝
   *     → 加色混合叠不起来，泛光也糊不掉，永远是一串亮点
   *   · 声音越大，点亮的格数越多 → 针"长"出去，像刻度被逐格点亮
   *   · 没被点亮的格留一条**极暗的刻度轨**，于是整张盘永远看得见刻度
   *     —— 这才是"星盘"：它是一台仪器，安静时也有形
   *   · 针尖上有一颗**亮珠**跟着长度跑，是最抓眼的一笔
   *   · 一条**雷达扫描线**绕着转，扫到哪儿哪儿的刻度亮起来
   *   · 中心一颗**随低音呼吸的核心**，补掉旧版那个黑洞
   *
   * 另外点数从 24000 降到约 8000，**帧率也顺带好了**。
   */
  const base = opts.count ?? 24000;
  const k = Math.max(0.55, Math.min(1.5, base / 24000));
  const NEEDLES = Math.max(48, Math.round(96 * Math.min(1, k))); // 针数
  const RAIL = Math.max(40, Math.round(68 * k));                 // 每针的格数
  const CORE = Math.max(700, Math.round(1500 * k));              // 核心点数

  const count = NEEDLES * RAIL + CORE;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  const needle = new Float32Array(count);
  const rnd = new Float32Array(count);

  let i = 0;
  for (let n = 0; n < NEEDLES; n++) {
    // 每根针给一个固定的随机长度系数，避免 96 根齐刷刷一样长（那样又像蒲公英了）
    const rj = 0.78 + Math.random() * 0.5;
    // 针的角度：留一点随机抖动，破掉机械感
    const a0 = (n / NEEDLES) * TAU - Math.PI / 2 + (Math.random() - 0.5) * 0.012;
    for (let g = 0; g < RAIL; g++) {
      const rail = RAIL === 1 ? 0 : g / (RAIL - 1);
      pos[i * 3] = a0;                      // x 存角度
      pos[i * 3 + 1] = rail;                // y 存格位（0 内圈 → 1 外圈）
      pos[i * 3 + 2] = (Math.random() - 0.5) * 1.4; // 一点点厚度
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 1;
      // 点径基本恒定：刻度点就该一样大，大小一乱就变成噪声
      size[i] = 1.05 + Math.random() * 0.42;
      phase[i] = Math.random() * TAU;
      needle[i] = n;
      rnd[i] = rj;
      i++;
    }
  }
  // 核心：一个半径 0.5 以内的致密点云（uniform disc 采样，不然中心会结块）
  for (let c = 0; c < CORE; c++) {
    const a = Math.random() * TAU;
    pos[i * 3] = a;
    pos[i * 3 + 1] = 0.5 * Math.sqrt(Math.random()); // 这里 y 存的是半径
    pos[i * 3 + 2] = (Math.random() - 0.5) * 0.9;
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 1;
    size[i] = 0.95 + Math.random() * 1.10;
    phase[i] = Math.random() * TAU;
    needle[i] = -1;     // -1 = 核心，着色器里走另一条分支
    rnd[i] = 1;
    i++;
  }

  const points = new THREE.Points(
    makeGeo(pos, col, size, phase, [
      ['aNeedle', needle, 1],
      ['aRand', rnd, 1],
    ]),
    makeMat(
      U,
      `
      attribute float aNeedle;
      attribute float aRand;

      void main() {
        float rot = uTime * 0.09;          // 整盘缓慢自转

        /* ---------- 核心 ---------- */
        if (aNeedle < -0.5) {
          /*
           * 核心用 position.y 存半径（不是格位），x 存角度。
           * 半径随低音鼓一下，让盘子"有心跳"；旧版这里是纯黑的洞。
           */
          float bass = clamp(uBands[0] * 1.6, 0.0, 1.4);
          float r = position.y * (1.0 + bass * 0.28 + uPulse * uBeatAmp * 0.12);
          float a = position.x + rot * 2.6;   // 核心转得快一点
          vec3 p = vec3(cos(a) * r, sin(a) * r, position.z * (0.6 + bass * 0.8));

          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uPixelRatio * (11.0 / -mv.z) * (1.0 + uPulse * 0.18);

          /*
           * 越靠里越亮（r 最大 0.5，所以 1-2r 在中心是 1、边缘是 0），
           * 于是核心是一颗有实心的光核，不是一个模糊的球。
           */
          float core = 1.0 - position.y * 2.0;
          vAlpha = (0.18 + core * 0.90) * (0.60 + bass * 0.95)
                   * (0.85 + 0.15 * sin(uTime * 3.1 + aPhase * 3.0));
          vColor = aColor * (1.00 + bass * 1.45 + core * 0.65);
          return;
        }

        /* ---------- 针 ---------- */
        float rail = position.y;

        /*
         * 该针所属频段的强度。
         * 96 根针要落在 16 个频段上，所以在相邻两个频段之间插值 ——
         * 不插值的话相邻几根针会一起跳，看得出"台阶"。
         */
        float bn = aNeedle * (16.0 / ${NEEDLES}.0);
        int b0 = int(floor(bn));
        if (b0 < 0) b0 = 0;
        if (b0 > 15) b0 = 15;
        int b1 = b0 + 1;
        if (b1 > 15) b1 = 15;
        float amp = mix(uBands[b0], uBands[b1], bn - floor(bn)) * aRand;
        amp = clamp(amp, 0.0, 1.35);

        // 针的长度（归一化到 0~1 的格位）。安静时也留一小截，盘子不会塌空。
        float len = clamp(0.14 + amp * 0.86, 0.0, 1.0);

        // 半径范围：外圈 4.25 是算过的 —— 正面可见半高约 4.4，刚好完整在画面里
        float r = mix(0.50, 4.25, rail);
        float a = position.x + rot;

        /*
         * 声音越大的部分往外鼓得越多（沿径向，不是整体缩放）。
         * 这和"整体放大"是两回事：整体放大像在喘气，径向鼓出才像频谱在动。
         */
        r *= 1.0 + uPulse * uBeatAmp * 0.05 * rail;

        vec3 p = vec3(cos(a) * r, sin(a) * r, position.z);

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;

        /*
         * 三种粒子，各司其职：
         *   lit   长度以内的刻度点 —— 主体
         *   ghost 长度以外的刻度轨 —— 极暗，但让整张盘的刻度永远看得见
         *   bead  正好压在针尖上的那颗亮珠 —— 跟着长度来回跑，最抓眼
         */
        float lit   = 1.0 - smoothstep(len - 0.055, len + 0.015, rail);
        float ghost = smoothstep(len - 0.015, len + 0.075, rail);
        float bead  = exp(-pow((rail - len) / 0.028, 2.0));

        // 由内向外略暗，视觉上把重量收在内圈
        float taper = 1.0 - 0.55 * rail;

        /*
         * 雷达扫描线：一条绕圈的高斯包，扫到哪儿哪儿的刻度亮起来。
         * 这一笔把"粒子图"变成"仪表盘"—— 静止时也一直在读数。
         */
        float dA = a - uTime * 0.85;
        dA = atan(sin(dA), cos(dA));                 // 归一到 -PI..PI
        float sweep = exp(-pow(dA / 0.24, 2.0));

        /*
         * 亮度标定（我第一版打得太暗了，这条记下来）：
         *
         * 旧版靠 24000 颗粒子**加色叠在一起**才亮起来的，而新版是
         * 离散的点、彼此不重叠 —— 同样一个 alpha，总光量差了六七倍。
         * 第一版照搬了旧版的量级，出来是一张几乎看不见的蛛网。
         * 离散点必须**单颗就更亮**，因为不再有"数量顶着"的红利。
         */
        vAlpha = lit * (0.34 + amp * 1.25) * taper
               + ghost * 0.16 * taper * (0.35 + sweep * 2.2)
               + bead * (0.55 + amp * 1.00)
               + sweep * 0.30 * taper;

        vColor = aColor * (0.85 + amp * 1.35 + bead * 1.10 + sweep * 0.80
                           + ghost * 0.30);

        gl_PointSize = aSize * uPixelRatio * (11.0 / -mv.z)
                       * (1.0 + uPulse * 0.10)
                       * (1.0 + bead * 1.15 + sweep * 0.25);
      }`
    )
  );

  points.frustumCulled = false;
  points.userData.tintable = true;
  const group = new THREE.Group();
  group.add(points);
  return group;
}

/* ------------------------------------------------------------------ */
/* 出口                                                                */
/* ------------------------------------------------------------------ */

/**
 * 「封面粒子」预设里的**粒子层**。
 *
 * 分工必须说清楚，我在这一点上错了四次：
 *   封面 = 一张**完全静止**的半调网点图（particles.js 的 coverPoints）
 *   粒子 = **这一层**，跟着鼓点跳
 *
 * 我先是把这一层整个关掉（用户："你怎么能把粒子效果全关了啊"），
 * 后来又反过来让封面自己去跳（用户："封面不要跳动，只有粒子"）。
 * 根子是我把"封面"和"粒子"当成了同一个东西。
 *
 * 所以这里的粒子是**独立于封面**的一片星点：
 *   · 静止时只是极慢地漂，画面不至于死
 *   · 鼓点一来，每颗粒子沿自己的方向弹出去，再被拽回来
 *   · 逐粒相位不同，所以是此起彼伏地弹，不是整片一起冲
 */
function buildCoverParticles(U, opts) {
  const count = opts.count ?? 5200;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  const seed = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // 铺在封面周围一个略扁的盒子里 —— 比封面厚，转到侧面才看出是空间
    pos[i * 3] = (Math.random() - 0.5) * 26;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 20;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 16;
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 1;
    size[i] = 0.7 + Math.random() * 0.9;
    phase[i] = Math.random() * TAU;
    seed[i] = Math.random();
  }

  const points = new THREE.Points(
    makeGeo(pos, col, size, phase, [['aSeed', seed, 1]]),
    makeMat(
      U,
      `
      attribute float aSeed;
      void main() {
        float ph = aPhase;
        vec3 p = position;

        // 静止时的极慢漂浮（由 uTime 驱动，与鼓点无关）
        p.x += sin(uTime * 0.18 + ph) * 0.35;
        p.y += sin(uTime * 0.14 + ph * 1.7) * 0.35;
        p.z += cos(uTime * 0.11 + ph * 0.9) * 0.30;

        /*
         * 鼓点：每颗粒子沿**自己**的方向弹出去。
         * 幅度随相位分成好几档（fract(ph*0.3183)），
         * 所以是此起彼伏地弹，而不是整片一起冲出去。
         */
        float amp = uPulse * uBeatAmp;
        vec2 dir = vec2(cos(ph), sin(ph));
        float vary = 0.30 + 1.10 * fract(ph * 0.3183);
        p.xy += dir * amp * 1.05 * vary;
        p.z += amp * 1.20 * (aSeed * 2.0 - 1.0);

        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uPixelRatio * (9.0 / -mv.z)
                       * (1.0 + uPulse * 0.40 * aSeed);
        vAlpha = (0.22 + 0.34 * fract(ph * 0.1592))
                 * (0.70 + 0.30 * sin(uTime * 1.6 + ph * 2.0));
        vColor = aColor * (0.80 + amp * 0.90);
      }`
    )
  );

  points.frustumCulled = false;
  points.userData.tintable = true;
  const group = new THREE.Group();
  group.add(points);
  return group;
}

/*
 * 黑洞的两个着色器。
 *
 * 单独放在模块级常量里（而不是像别的效果那样内联在 build 函数中），
 * 纯粹是因为这段 GLSL 太长、还带注释 —— 内联进模板字符串会很难读。
 */

/* eslint-disable no-useless-escape */
/*
 * 黑洞的两个着色器（第二版 —— **只改结构，颜色一律不动**）。
 *
 * 对着参考图（星际穿越 Gargantua）比，结构上差三处：
 *   ① 横盘太厚 —— 参考图里盘是一条**锋利的细线**，两端收成尖
 *   ② 光环太细太均匀 —— 参考图那圈是**厚而软**的，顶部和底部最宽
 *   ③ 点太小太硬 —— 参考图是连续的光，不是一粒一粒
 *
 * 颜色部分与第一版**逐字相同**（内缘白热 → 外缘橙红、多普勒压暗），
 * 用户明确说了颜色不用动。
 */

/*
 * 黑洞着色器（第三版）。
 *
 * 结构：三类粒子走三条分支 ——
 *   kind 0  吸积盘（薄、开普勒、多普勒）
 *   kind 1  光子环 / 透镜弧（视空间搭建，永远正圆）
 *   kind 2  背景星空（**引力弯折**，这一层是"超越三维"的关键）
 *
 * 颜色与第一版保持一致（用户明确说了颜色不用动）。
 */

/*
 * 黑洞着色器（第四版）。
 *
 * 四类粒子走四条分支 ——
 *   kind 0  吸积盘（薄、开普勒、多普勒）
 *   kind 1  光子环 / 透镜弧（视空间搭建，永远正圆）
 *   kind 2  背景星空（**引力弯折**，看到黑洞背后的天区）
 *   kind 3  时空网格（**弗拉姆抛物面**，把空间的形状画出来）
 *
 * 颜色与第一版保持一致（用户明确说了颜色不用动）。
 */

﻿/*
 * 黑洞着色器（第四版）。
 *
 * 四类粒子走四条分支 ——
 *   kind 0  吸积盘（薄、开普勒、多普勒）
 *   kind 1  光子环 / 透镜弧（视空间搭建，永远正圆）
 *   kind 2  背景星空（**引力弯折**，看到黑洞背后的天区）
 *   kind 3  时空网格（**弗拉姆抛物面**，把空间的形状画出来）
 *
 * 颜色与第一版保持一致（用户明确说了颜色不用动）。
 */

﻿/*
 * 黑洞着色器（第四版）。
 *
 * 四类粒子走四条分支 ——
 *   kind 0  吸积盘（薄、开普勒、多普勒）
 *   kind 1  光子环 / 透镜弧（视空间搭建，永远正圆）
 *   kind 2  背景星空（**引力弯折**，看到黑洞背后的天区）
 *   kind 3  时空网格（**弗拉姆抛物面**，把空间的形状画出来）
 *
 * 颜色与第一版保持一致（用户明确说了颜色不用动）。
 */

﻿/*
 * 黑洞着色器（第四版）。
 *
 * 四类粒子走四条分支 ——
 *   kind 0  吸积盘（薄、开普勒、多普勒）
 *   kind 1  光子环 / 透镜弧（视空间搭建，永远正圆）
 *   kind 2  背景星空（**引力弯折**，看到黑洞背后的天区）
 *   kind 3  时空网格（**弗拉姆抛物面**，把空间的形状画出来）
 *
 * 颜色与第一版保持一致（用户明确说了颜色不用动）。
 */

﻿/*
 * 黑洞着色器（第四版）。
 *
 * 四类粒子走四条分支 ——
 *   kind 0  吸积盘（薄、开普勒、多普勒）
 *   kind 1  光子环 / 透镜弧（视空间搭建，永远正圆）
 *   kind 2  背景星空（**引力弯折**，看到黑洞背后的天区）
 *   kind 3  时空网格（**弗拉姆抛物面**，把空间的形状画出来）
 *
 * 颜色与第一版保持一致（用户明确说了颜色不用动）。
 */

﻿/*
 * 黑洞着色器（第四版）。
 *
 * 四类粒子走四条分支 ——
 *   kind 0  吸积盘（薄、开普勒、多普勒）
 *   kind 1  光子环 / 透镜弧（视空间搭建，永远正圆）
 *   kind 2  背景星空（**引力弯折**，看到黑洞背后的天区）
 *   kind 3  时空网格（**弗拉姆抛物面**，把空间的形状画出来）
 *
 * 颜色与第一版保持一致（用户明确说了颜色不用动）。
 */

﻿/*
 * 黑洞着色器（第四版）。
 *
 * 四类粒子走四条分支 ——
 *   kind 0  吸积盘（薄、开普勒、多普勒）
 *   kind 1  光子环 / 透镜弧（视空间搭建，永远正圆）
 *   kind 2  背景星空（**引力弯折**，看到黑洞背后的天区）
 *   kind 3  时空网格（**弗拉姆抛物面**，把空间的形状画出来）
 *
 * 颜色与第一版保持一致（用户明确说了颜色不用动）。
 */

﻿/*
 * 黑洞着色器（第四版）。
 *
 * 四类粒子走四条分支 ——
 *   kind 0  吸积盘（薄、开普勒、多普勒）
 *   kind 1  光子环 / 透镜弧（视空间搭建，永远正圆）
 *   kind 2  背景星空（**引力弯折**，看到黑洞背后的天区）
 *   kind 3  时空网格（**弗拉姆抛物面**，把空间的形状画出来）
 *
 * 颜色与第一版保持一致（用户明确说了颜色不用动）。
 */

﻿/*
 * 黑洞着色器（第四版）。
 *
 * 四类粒子走四条分支 ——
 *   kind 0  吸积盘（薄、开普勒、多普勒）
 *   kind 1  光子环 / 透镜弧（视空间搭建，永远正圆）
 *   kind 2  背景星空（**引力弯折**，看到黑洞背后的天区）
 *   kind 3  时空网格（**弗拉姆抛物面**，把空间的形状画出来）
 *
 * 颜色与第一版保持一致（用户明确说了颜色不用动）。
 */

﻿/*
 * 黑洞着色器（第四版）。
 *
 * 四类粒子走四条分支 ——
 *   kind 0  吸积盘（薄、开普勒、多普勒）
 *   kind 1  光子环 / 透镜弧（视空间搭建，永远正圆）
 *   kind 2  背景星空（**引力弯折**，看到黑洞背后的天区）
 *   kind 3  时空网格（**弗拉姆抛物面**，把空间的形状画出来）
 *
 * 颜色与第一版保持一致（用户明确说了颜色不用动）。
 */

﻿/*
 * 黑洞着色器（第四版）。
 *
 * 四类粒子走四条分支 ——
 *   kind 0  吸积盘（薄、开普勒、多普勒）
 *   kind 1  光子环 / 透镜弧（视空间搭建，永远正圆）
 *   kind 2  背景星空（**引力弯折**，看到黑洞背后的天区）
 *   kind 3  时空网格（**弗拉姆抛物面**，把空间的形状画出来）
 *
 * 颜色与第一版保持一致（用户明确说了颜色不用动）。
 */

﻿/*
 * 黑洞着色器（第四版）。
 *
 * 四类粒子走四条分支 ——
 *   kind 0  吸积盘（薄、开普勒、多普勒）
 *   kind 1  光子环 / 透镜弧（视空间搭建，永远正圆）
 *   kind 2  背景星空（**引力弯折**，看到黑洞背后的天区）
 *   kind 3  时空网格（**弗拉姆抛物面**，把空间的形状画出来）
 *
 * 颜色与第一版保持一致（用户明确说了颜色不用动）。
 */

﻿/*
 * 黑洞着色器（第四版）。
 *
 * 四类粒子走四条分支 ——
 *   kind 0  吸积盘（薄、开普勒、多普勒）
 *   kind 1  光子环 / 透镜弧（视空间搭建，永远正圆）
 *   kind 2  背景星空（**引力弯折**，看到黑洞背后的天区）
 *   kind 3  时空网格（**弗拉姆抛物面**，把空间的形状画出来）
 *
 * 颜色与第一版保持一致（用户明确说了颜色不用动）。
 */

﻿/*
 * 黑洞着色器（第四版）。
 *
 * 四类粒子走四条分支 ——
 *   kind 0  吸积盘（薄、开普勒、多普勒）
 *   kind 1  光子环 / 透镜弧（视空间搭建，永远正圆）
 *   kind 2  背景星空（**引力弯折**，看到黑洞背后的天区）
 *   kind 3  时空网格（**弗拉姆抛物面**，把空间的形状画出来）
 *
 * 颜色与第一版保持一致（用户明确说了颜色不用动）。
 */

const BH_VERT = `
      attribute float aKind;
      attribute float aRadius;
      attribute float aAngle;
      attribute float aRnd;

      void main() {
        /*
         * 盘的"长轴"在屏幕上的方向 —— 多普勒增亮的那一侧就沿它。
         * 取世界 +Z（盘在 XZ 平面里）投影到屏幕，所以相机转的时候
         * 亮侧会跟着一起转，不会钉死在屏幕右边。
         */
        vec2 axis = (modelViewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xy;
        axis = normalize(axis + vec2(1e-5));
        vec3 vc = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

        if (aKind < 0.5) {
          /* ================= 吸积盘 ================= */
          vec3 pos = position;
          pos = applyBeat(pos);

          // 开普勒角速度 ∝ r^-1.5：内圈转得明显比外圈快
          float w = 9.0 / pow(max(aRadius, 1.0), 1.5);
          float ang = aAngle + uTime * w;
          mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
          pos.xz = rot * pos.xz;

          vec4 mv = modelViewMatrix * vec4(pos, 1.0);

          /*
           * 多普勒：切向速度在视空间里与视线的夹角。
           * 朝观察者运动的一侧被压亮，背面那侧暗下去 ——
           * 这是黑洞图像里最抓眼的一处不对称。
           */
          vec3 vel = vec3(-sin(ang), 0.0, cos(ang));
          vec3 vv = (modelViewMatrix * vec4(vel, 0.0)).xyz;
          float dop = dot(normalize(vv.xy + vec2(1e-5)), axis);

          /*
           * 阴影遮挡：不画黑球，而是把"该被挡住"的粒子丢出裁剪体。
           * 两个条件都要判（在中心之后 + 横向在阴影圈内），
           * 只判一条会把盘的前半或外围一起吃掉。
           */
          vec2 rel = mv.xy - vc.xy;
          if (mv.z < vc.z && length(rel) < 1.9) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            gl_PointSize = 0.0;
            vAlpha = 0.0;
            vColor = vec3(0.0);
            return;
          }

          gl_Position = projectionMatrix * mv;

          // 内缘白热、外缘橙红（与第一版相同）
          float tR = clamp((aRadius - 4.2) / (17.0 - 4.2), 0.0, 1.0);
          vec3 hot = vec3(1.0, 0.97, 0.90);
          vec3 cool = vec3(1.0, 0.40, 0.09);
          vec3 c = mix(hot, cool, pow(tR, 0.55));
          c = mix(c * vec3(1.0, 0.52, 0.30), c, clamp(dop * 0.5 + 0.5, 0.0, 1.0));
          vColor = aColor * c * (1.0 + uPulse * 0.30);

          float dopp = pow(clamp(dop * 0.5 + 0.5, 0.0, 1.0), 2.4);
          float rim = smoothstep(0.70, 1.0, tR) * 0.45;
          vAlpha = (0.20 + dopp * 1.30) * (1.0 - tR * 0.55) + rim + uPulse * 0.05;
          gl_PointSize = aSize * uPixelRatio * (18.0 / -mv.z)
                         * (0.7 + dopp * 0.8) * (1.0 + uPulse * 0.14);
        } else if (aKind < 1.5) {
          /* ============ 光子环 / 透镜弧 ============ */
          /*
           * ★ 不要再做"整圈刚性旋转"。
           *
           * 原来是 float ang = aAngle + uTime * 0.22 —— **所有粒子同一个
           * 角速度**，看起来就是带花纹的圆盘在匀速转，很假。
           *
           * 黑洞那种"流动"的本质是**开普勒剪切**：越靠内的物质角速度越大，
           * 同一圈上的粒子因此互相错开、被拉成流动的丝。
           * 这里让每个粒子按**自己的半径**取角速度（ω ∝ r^-1.5）。
           */
          float wSpin = 3.2 / pow(max(aRadius, 0.5), 1.5);
          float ang = aAngle + uTime * wSpin;

          /*
           * 在**视空间**里搭环：中心转到视空间，再在 xy 上加一个圆。
           * 这样相机怎么转，环永远是正圆 —— 光子环本来就是这个性质。
           */
          vec3 vp = vc;
          vp.xy += vec2(cos(ang), sin(ang)) * aRadius;
          vp.z -= 0.35;

          gl_Position = projectionMatrix * vec4(vp, 1.0);

          float dop = dot(vec2(cos(ang), sin(ang)), axis);
          float dopp = pow(clamp(dop * 0.5 + 0.5, 0.0, 1.0), 2.2);

          vec3 ring = vec3(0.88, 0.93, 1.0);
          vec3 arc = vec3(1.0, 0.80, 0.52);
          float isArc = smoothstep(1.06, 1.24, aRadius / 1.9);
          vColor = aColor * mix(ring, arc, isArc) * (1.0 + uPulse * 0.35);
          vAlpha = (0.46 + dopp * 1.15) * (1.0 - isArc * 0.30) + uPulse * 0.06;
          gl_PointSize = aSize * uPixelRatio * (18.0 / -vp.z) * (1.0 + uPulse * 0.14);
        } else if (aKind < 2.5) {
          /* ============ 背景星空：引力弯折 ============ */
          vec4 mv = modelViewMatrix * vec4(position, 1.0);

          /*
           * ★ 透镜方程：  θ = (β + √(β² + 4θ_E²)) / 2
           *
           * β → 0（星正好在黑洞**正后方**）时 θ → θ_E：
           * 正后方那一整片天区的光被挤到半径 θ_E 的一圈上，
           * 于是阴影边缘出现致密的亮环，而且**
           * 黑洞背后本来该被挡住的天区，我们能看见**。
           */
          vec2 d = mv.xy - vc.xy;
          float beta = length(d);
          float RE = 2.15;
          float root = sqrt(beta * beta + 4.0 * RE * RE);
          vec2 dir = d / max(beta, 1e-4);

          /*
           * 负根 θ₂ = (β - √(β²+4θ_E²))/2 是**第二像** ——
           * 同一颗星在阴影另一侧还有一个镜像（光走了另一条路绕过来）。
           * 多半落在阴影里被丢掉，只有露在边缘外的一圈能看见。
           */
          bool second = aRnd > 0.62;
          float th = second ? 0.5 * (beta - root) : 0.5 * (beta + root);
          mv.x = vc.x + dir.x * th;
          mv.y = vc.y + dir.y * th;

          if (length(mv.xy - vc.xy) < 1.9) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            gl_PointSize = 0.0;
            vAlpha = 0.0;
            vColor = vec3(0.0);
            return;
          }

          gl_Position = projectionMatrix * mv;
          vColor = aColor;
          // 第二像绕了远路，必然更暗；再叠一点缓慢闪烁让星空活着
          float dim = second ? 0.30 : 1.0;
          vAlpha = clamp(aColor.r, 0.0, 1.0) * dim
                   * (0.62 + 0.38 * sin(uTime * 0.8 + aPhase * 7.0)) + uPulse * 0.04;
          gl_PointSize = aSize * uPixelRatio * (52.0 / -mv.z) * (1.0 + uPulse * 0.10);
        }
      }`;

const BH_FRAG = `
      varying vec3  vColor;
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d2 = dot(c, c);
        if (d2 > 0.25) discard;
        /*
         * 点更软：参考图整体是连续的光晕；点太硬会读成"一串珠子"，
         * 尤其盘变薄之后，硬点会直接变成虚线。
         */
        float a = smoothstep(0.25, 0.0, d2);
        a = pow(a, 1.7);
        gl_FragColor = vec4(vColor, a * clamp(vAlpha, 0.0, 1.6));
      }`;

﻿/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* 9. 黑洞（星际穿越那种）                                             */
/*                                                                     */
/* 四层：                                                              */
/*   吸积盘 / 光子环 / 背景星空引力弯折  —— 一个 Points，靠 aKind 分支  */
/*   时空网格（弗拉姆抛物面）            —— 一个 LineSegments          */
/* ------------------------------------------------------------------ */

function buildBlackHole(U, opts) {
  const diskCount = opts.diskCount ?? 12000;
  const lensCount = opts.lensCount ?? 7000;
  const starCount = opts.starCount ?? 11000;
  const count = diskCount + lensCount + starCount;
  const group = new THREE.Group();

  const R_SHADOW = 1.9;
  const R_IN = 2.3;
  const R_OUT = 9.4;

  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const phase = new Float32Array(count);
  const kind = new Float32Array(count);
  const radius = new Float32Array(count);
  const angle = new Float32Array(count);
  const rnd = new Float32Array(count);

  let n = 0;

  /* ---------- ① 吸积盘 ---------- */
  for (let i = 0; i < diskCount; i++) {
    const u = Math.random();
    const r = R_IN + (R_OUT - R_IN) * Math.pow(u, 1.7);
/*
     * ★ 角度要**聚束**，不能纯随机。
     *
     * 纯随机的粒子分布被剪切之后还是随机分布 —— 内快外慢算得再对，
     * 画面上也看不出任何东西在流动。成束之后，初始是一圈径向条纹，
     * 剪切会把条纹卷成螺旋，缠绕感就出来了。
     * 64 束：远看仍是均匀的盘，近看能看出螺旋结构。
     */
    const streamD = Math.floor(Math.random() * 64);
    const a = (streamD / 64) * TAU + (Math.random() - 0.5) * (TAU / 64) * 0.55;
    const thin = 0.025 + 0.06 * ((r - R_IN) / (R_OUT - R_IN));

    pos[n * 3] = Math.cos(a) * r;
    pos[n * 3 + 1] = (Math.random() - 0.5) * thin;
    pos[n * 3 + 2] = Math.sin(a) * r;

    col[n * 3] = col[n * 3 + 1] = col[n * 3 + 2] = 1;
    size[n] = (1.1 + Math.random() * 2.0) * (1.25 - 0.5 * u);
    phase[n] = Math.random() * TAU;
    kind[n] = 0;
    radius[n] = r;
    angle[n] = a;
    rnd[n] = Math.random();
    n++;
  }

  /* ---------- ② 光子环 + 透镜弧 ---------- */
  for (let i = 0; i < lensCount; i++) {
/*
     * 环同样要成束（24 束，比盘粗一档 —— 环本身窄，束太细看不出来）。
     * 环上的束和盘上的束会各自被剪切卷开，两张图一起"淌"。
     */
    const streamL = Math.floor(Math.random() * 24);
    const a = (streamL / 24) * TAU + (Math.random() - 0.5) * (TAU / 24) * 0.6;
    const vert = Math.abs(Math.sin(a));
    /*
     * ★ 厚度差不能太大。
     *
     * 上一版是 0.10 ~ 0.95：上下极厚、左右几乎为零，结果环**断成了两坨**，
     * 中间没有东西连着 —— 用户的原话是"包裹黑洞的那个粒子，两半好丑"。
     *
     * 参考图里那圈确实也是上下宽、左右窄，但**始终是连续的一圈**，
     * 宽度差大概只有一倍。所以基准厚度提到 0.30、变化量压到 0.32：
     * 最窄处也够显眼，最宽处也不会鼓成球。
     */
    const thick = 0.3 + 0.32 * Math.pow(vert, 1.4);
    const rr = R_SHADOW * (1.03 + Math.random() * thick);

    pos[n * 3] = Math.cos(a) * rr;
    pos[n * 3 + 1] = 0;
    pos[n * 3 + 2] = Math.sin(a) * rr;

    col[n * 3] = col[n * 3 + 1] = col[n * 3 + 2] = 1;
    // 点小一点：读成"流动的丝"而不是"一坨"
    size[n] = 1.1 + Math.random() * 1.5;
    phase[n] = Math.random() * TAU;
    kind[n] = 1;
    radius[n] = rr;
    angle[n] = a;
    rnd[n] = Math.random();
    n++;
  }

  /* ---------- ③ 背景星空（引力弯折） ---------- */
  for (let i = 0; i < starCount; i++) {
    const cz = Math.random() * 2 - 1;
    const sp = Math.sqrt(Math.max(0, 1 - cz * cz));
    const ph = Math.random() * TAU;
    const rr = 55 + Math.random() * 40;

    pos[n * 3] = Math.cos(ph) * sp * rr;
    pos[n * 3 + 1] = cz * rr;
    pos[n * 3 + 2] = Math.sin(ph) * sp * rr;

    const b = 0.35 + Math.pow(Math.random(), 2.4) * 0.95;
    col[n * 3] = col[n * 3 + 1] = col[n * 3 + 2] = b;
    size[n] = 0.6 + Math.pow(Math.random(), 3) * 2.6;
    phase[n] = Math.random() * TAU;
    kind[n] = 2;
    radius[n] = rr;
    angle[n] = ph;
    rnd[n] = Math.random();
    n++;
  }

  const blackhole = new THREE.Points(
    makeGeo(pos, col, size, phase, [
      ['aKind', kind, 1],
      ['aRadius', radius, 1],
      ['aAngle', angle, 1],
      ['aRnd', rnd, 1],
    ]),
    makeMat(U, BH_VERT, BH_FRAG)
  );
  blackhole.frustumCulled = false;
  blackhole.userData.tintable = true;
  group.add(blackhole);

  /* ---------- ④ 时空网格（线段，不是点） ---------- */
  group.add(buildSpacetimeGrid(opts));

  return group;
}

/**
 * 时空网格：弗拉姆抛物面。
 *
 * ★ 用 LineSegments 而不是点云 —— 这是上一版失败后改的。
 *
 * 网格是"线"，用点去画它就必须撒得极密才连得起来，于是变成几千个软点、
 * 大面积 alpha 混合：**又糊又贵**（实测帧率从 165 掉到 34~54），
 * 而且密到根本看不出格子。换成线段：2100 条线就把整张网交代清楚，
 * 几乎没有填充开销，线也不会糊成一团。
 *
 * 抛物面的下陷**在 JS 里算好、烘进顶点**，不放在着色器里：
 * 这张网是静止的（物质在动、坐标系不动），没有逐帧变化，
 * 就没必要为它养一个自定义着色器 —— 用标准材质反而更好，
 * 标准材质别的地方（调色、泛光）都认。
 */
function buildSpacetimeGrid(opts) {
  const RINGS = opts.gridRings ?? 15;
  const SPOKES = opts.gridSpokes ?? 30;
  const OUT = 9.4;
  const IN = 2.0;
  const SEG = 72; // 每圈的段数
  const SPOKE_SEG = 40;

  /*
   * 史瓦西度规的嵌入图：离开洞口的高度 h(r) = 2√(R_s·(r − R_s))。
   * 减去外缘处的取值，让远处保持平的、只有洞口附近凹下去。
   */
  const rs = 1.9;
  const hEdge = 2 * Math.sqrt(rs * (OUT - rs));
  const dip = (r) => -(hEdge - 2 * Math.sqrt(rs * Math.max(r - rs, 0.001))) * 0.5;

  const verts = [];
  // 同心环
  for (let g = 0; g < RINGS; g++) {
    const rr = IN + (OUT - IN) * (g / (RINGS - 1));
    const y = dip(rr);
    for (let i = 0; i < SEG; i++) {
      const a0 = (i / SEG) * TAU;
      const a1 = ((i + 1) / SEG) * TAU;
      verts.push(Math.cos(a0) * rr, y, Math.sin(a0) * rr);
      verts.push(Math.cos(a1) * rr, y, Math.sin(a1) * rr);
    }
  }
  // 径向辐条
  for (let j = 0; j < SPOKES; j++) {
    const a = (j / SPOKES) * TAU;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (let i = 0; i < SPOKE_SEG; i++) {
      const r0 = IN + (OUT - IN) * (i / SPOKE_SEG);
      const r1 = IN + (OUT - IN) * ((i + 1) / SPOKE_SEG);
      verts.push(ca * r0, dip(r0), sa * r0);
      verts.push(ca * r1, dip(r1), sa * r1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));

  const grid = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    })
  );
  // tintEffect 只认 isPoints，线段由 ParticleStage.setPalette 单独上色
  grid.userData.tintable = true;
  grid.userData.isGrid = true;
  grid.frustumCulled = false;
  return grid;
}

const BUILDERS = {
  /*
   * 「封面粒子」不建任何背景粒子 —— 效果本身就是封面那一层网点。
   *
   * 返回一个**空组**而不是特判成 null：setEffect 里有一整套
   * "移除旧组 → 释放 → 建新组 → 加进场景"的流程，
   * 返回空组能让这条路径保持单一，不用到处写 if。
   * 代价只是一次空的 draw call，可以忽略。
   */
  /*
   * 「封面粒子」= 只用封面本来的那些网点，不另建粒子层。
   *
   * 我中间加过一层独立的星点（buildCoverParticles），被用户明确否掉了。
   * 所以这里返回空组 —— 效果就是封面那层网点自己在动。
   *
   * 空组而不是 null：setEffect 里有一套「移除旧组 → 释放 → 建新组 → 加场景」
   * 的统一流程，返回空组能让这条路径保持单一，不用到处写 if。
   */
  cover: () => new THREE.Group(),
  wave: buildWave,
  spectrum: buildSpectrum,
  spectrogram: buildSpectrogram,
  coral: buildCoral,
  rain: buildRain,
  vinyl: buildVinyl,
  tunnel: buildTunnel,
  halo: buildHalo,
  blackhole: buildBlackHole,
};

/**
 * 创建一种粒子效果
 * @param {string} key EFFECT_LIST 里的 key
 * @param {object} uniforms 与宿主共享的 uniform 对象
 * @param {object} opts 粒子数量等参数（已经按 density 缩放过）
 * @returns {THREE.Group}
 */
export function buildEffect(key, uniforms, opts = {}) {
  const builder = BUILDERS[key] || BUILDERS.halo;
  const group = builder(uniforms, opts);
  group.userData.effectKey = key;
  return group;
}

/**
 * 给效果换配色
 *
 * 只改 aColor 属性、不重建几何，所以切主题是瞬时的、不掉帧。
 * 背景星点用小粒子色（更淡），主体粒子用光带色（更艳），拉开层次。
 */
export function tintEffect(group, palette) {
  if (!palette) return;

  group.traverse((obj) => {
    if (!obj.isPoints) return;
    const attr = obj.geometry.getAttribute('aColor');
    if (!attr) return;

    // obj.userData.tintable = 主体粒子；否则视为背景星点
    const src = obj.userData.tintable ? palette.ribbons || palette.stars : palette.stars;
    if (!src || !src.length) return;

    const arr = attr.array;
    for (let i = 0; i < arr.length / 3; i++) {
      const c = src[(Math.random() * src.length) | 0];
      const dim = obj.userData.tintable ? 0.6 + Math.random() * 0.4 : 0.25 + Math.random() * 0.6;
      arr[i * 3] = c[0] * dim;
      arr[i * 3 + 1] = c[1] * dim;
      arr[i * 3 + 2] = c[2] * dim;
    }
    attr.needsUpdate = true;
  });
}