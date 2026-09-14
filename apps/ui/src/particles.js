import * as THREE from 'three';
import { buildEffect, tintEffect, EFFECT_LIST } from './effects.js';

// 后处理：泛光是"炫酷感"的最大来源 —— 粒子只是加色混合会显得很平，
// 加上 bloom 才会真正"发光晕开"。这几个模块是从 three 的 examples/jsm
// 拷到 vendor/ 的（路径已改好相对引用），因为本项目不用打包器。
import { EffectComposer } from '../vendor/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/postprocessing/RenderPass.js';
import { CheapBloomPass } from './bloom.js';
import { UnrealBloomPass } from '../vendor/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/postprocessing/OutputPass.js';

export { EFFECT_LIST };

/**
 * 粒子舞台
 *
 * 负责：承载当前粒子效果、共享 uniform、切换效果、配色、性能自适应。
 *
 * 流畅度上做了四件事：
 *   1. **所有运动在顶点着色器算**，CPU 每帧只更新 3 个 uniform，零几何操作
 *   2. **自适应降级**：连续掉帧就自动降渲染分辨率倍率，恢复了再升回去
 *   3. **窗口隐藏时暂停渲染**（最小化/切走时不再空转 GPU）
 *   4. **渲染倍率可手动调**，低配机器能直接砍一半像素
 */

const TAU = Math.PI * 2;

/**
 * 粒子精灵（与 effects.js 保持一致）
 *
 * 用多段衰减拟合径向渐变精灵贴图，而不是硬边圆点 —— 粒子外围要有一圈
 * 长而淡的光晕，看起来才像发光体。配合泛光差别很明显。
 */
const ROUND_POINT_FRAGMENT = `
varying vec3  vColor;
varying float vAlpha;
varying float vStar;

/**
 * 封面层的粒子：**实心圆 + 按亮度长出的柔光**。
 *
 * 为什么是实心圆而不是背景粒子那种大光晕：封面层要呈现图像，
 * 用软光晕的话相邻采样点会糊在一起，图案细节全丢。
 *
 * 但纯实心圆又会把专辑图上的星点画成"死点"，失去光彩 ——
 * 而封面层为了修白底过曝被移出了泛光链，没有后处理帮忙发光。
 * 所以这里按 vStar（该点的亮度）在两者之间过渡：
 *   暗部 → 干净的小实心圆（保持图像清晰）
 *   亮部 → 实心核外面裹一圈柔和光晕（星点就会闪）
 * 这样既有细节又有光彩，而且是封面层自己的开销，不会波及白底。
 */
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;
  if (r > 1.0) discard;

  float disc = 1.0 - smoothstep(0.80, 0.97, r);
  float halo = exp(-r * r * 3.2) * (1.0 - smoothstep(0.9, 1.0, r));
  float a = mix(disc, max(disc, halo * 0.55), vStar);
  if (a <= 0.002) discard;
  gl_FragColor = vec4(vColor, a * clamp(vAlpha, 0.0, 1.0));
}
`;

/**
 * 各效果的节拍位移幅度（世界单位）
 *
 * 位移按世界单位走，而各效果的空间尺度差很多（隧道半径 7、星系跨度 15、
 * 音域回响跨度 46）。用同一个数值的话，大尺度效果里位移只占百分之几，
 * 根本看不出来。按各自尺度给，"跳"的观感才一致。
 */
/**
 * 拖动旋转的幅度限制（弧度）。
 *
 * ★ 改成整圈 360°。
 *
 * 原来限制在 ±55°，理由是"背景效果都是正面构图的平面，转到侧面会变成一条线"。
 * 那个顾虑在当时成立 —— 那时封面是一块固定的平面点阵，转过去确实只剩一条线。
 * 但现在不一样了：**歌词牌是 billboard，永远正对镜头**，
 * 所以哪怕你把视角转到正后方，画面里始终有一个正着的、可读的大字在。
 * 有了这个"锚"，整圈旋转就不会转出"画面坏了"的观感 ——
 * 这也正是用户描述的那个感觉：360° 随便转，歌词一直是顺的。
 *
 * 俯仰仍然要限：那是绕水平轴转，转到极点画面会翻过去，
 * 而且封面是竖直平面，真正的"看反面"只需要方位角整圈。
 */
const AZ_LIMIT = Infinity; // 方位角完全不限：可以一直往一个方向转下去
/*
 * 俯仰范围：±89°。
 *
 * 原来写的是 ±32°，注释里还当成"设计决定"（"转到极点画面会翻过去"）。
 * 但用户一句就说清了："360° 连上下都没有还算个屁啊" ——
 * 只有方位角整圈、俯仰限在三十二度，那不叫全景。
 *
 * 取 89° 而不是 90°：正好 90° 时相机在正上方，视线方向与相机默认的
 * up(0,1,0) 平行，lookAt 会退化、画面会突然翻转。差 1° 就完全避开，
 * 而观感上已经是从正上方/正下方俯瞰了。
 */
const EL_LIMIT = 1.5533; // 约 89°，接近整球的上下极限
/** 双击归位时的默认轨道半径（和构造函数里的初值一致） */
const ORBIT_HOME_RADIUS = 9;

/**
 * 停手多久之后开始自动回正（毫秒），以及回正速度。
 *
 * 3 秒是"我确实转完想看点东西"和"我只是随手拨了一下"之间的分界；
 * 回正速度 2.2 对应大约 1 秒多转回正面 —— 慢到看得出是个动作，
 * 快到不会让人等。
 */
const ORBIT_RETURN_DELAY_MS = Infinity; // 自动归位已按要求关闭（原来是 3000ms）
const ORBIT_RETURN_SPEED = 2.2;

/**
 * 从这些元素上开始按下时不旋转画面 —— 否则拖动面板、滑杆、按钮
 * 会顺带把整个场景转走，非常难受。
 */
const ORBIT_UI_SELECTOR = [
  '#sidebar',
  '#playerbar',
  '#settings-panel',
  '#settings-overlay',
  '#topbar',
  '.chip-menu',
  '#queue-popover',
  '.np-info',
  'button',
  'input',
  'a',
].join(',');

const BEAT_AMP = {  spectrum: 1.0,
  spectrogram: 1.2,
  coral: 1.5,
  tunnel: 1.2,
  rain: 0.7,
  vinyl: 0.9,
  halo: 1.2,
};

export class ParticleStage {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.disposed = false;
    this.paused = false;
    /*
     * 音频是否在播放。
     *
     * 暂停时要把 uTime 收回 0，让**所有**效果回到初始姿态 ——
     * 不这么做的话暂停后星盘还在转、扫描线还在扫、雨还在下，
     * 观感是"暂停了但动画没停"。
     * 由 main.js 的 play/pause 事件驱动（见 setPlaying）。
     */
    this.playing = true;
    /*
     * 渲染的最小间隔（毫秒）。60 FPS ≈ 16.7ms。
     * 设成 0 就等于不限帧（老行为），排查时可以用 __mpSet 改。
     */
    /*
     * 滚轮是否归缩放管。由 main.js 按当前页面设置：
     * 只有「正在播放」页为 true（那一页没有列表要滚）。
     * 默认 false —— 默认值必须是"让给滚动"，
     * 否则任何一段内容超高的页面都会变成"滚不动、只会缩放"。
     */
    this.zoomEnabled = false;
    this.elapsed = 0;
    this.pulseValue = 0;
    this.effectKey = opts.effect || 'spectrum';
    this.density = opts.density ?? 1;
    this.pulseIntensity = opts.pulseIntensity ?? 0.7;
    /** 节拍位移幅度（世界单位），由 setEffect 按效果尺度设定 */
    this.beatAmp = opts.beatAmp ?? 0.6;
    /*
     * 帧率上限。**默认 0 = 不限帧。**
     *
     * ★ 2026-09 补记：我曾经另写了一个 renderMinGap（默认 1000/60）
     *   来做同样的事，**没有读到下面这段说明**，于是重犯了一遍：
     *   · 帧率被从 165 压到 55，拖动、跳动都变顿 —— 用户报"唱片和月蚀
     *     怎么变成呼吸的了"，就是这个造成的 ✗
     *   · 而且它根本不省东西（下面写了实测数据）
     *   已删除。要做限帧就用这个 maxFps，且**默认不开**。
     *
     * 这里踩过一个很深的坑，记下来免得再犯：
     *
     * 原来的实现是"距上次渲染不足 1000/maxFps 就跳过这一帧"，默认 60。
     * 在高刷屏上这个判断会**错位量化**：144Hz 的 rAF 间隔是 6.94ms，而
     * 1000/60 - 1.5 = 15.17ms，于是每 3 个刷新周期才满足一次，实际只有 48 帧；
     * 165Hz 屏上则是 165/3 = 55 帧。
     *
     * 更关键的是：它省不下任何东西。实测帧率对**画布像素数和画面内容都无感**
     * （分辨率降到 12% 帧率不变，关掉全部粒子也不变），说明瓶颈根本不在 GPU
     * 填充率上 —— 这个上限纯粹是在白白丢帧。
     *
     * 实测：不限帧 80 帧，限帧 60 只有 53 帧。
     */
    this.maxFps = opts.maxFps ?? 0;
    this._lastRender = 0;
    /** rAF 间隔采样，用来估计屏幕刷新率（限帧要按刷新分频） */
    this._tickSamples = [];

    /**
     * 实测的刷新间隔（毫秒），由 rAF 间隔滚动中位数得到。
     *
     * 限帧必须按**刷新率的分频**来做：只能整周期地跳，所以能落到的帧率是
     * 刷新率 / 1、/ 2、/ 3 …… 165Hz 上就是 165、82.5、55、41。
     * 想精确得到 60 帧在 165Hz 上是不可能的，只能取最接近的那一档。
     */
    this._refreshMs = 1000 / 60;
    this.motionSpeed = opts.motionSpeed ?? 1;
    this.group = null;

    /**
     * 渲染倍率
     *
     * 关键：**上限就是 1.0，不跟 devicePixelRatio 走**。
     *
     * 粒子是柔和的模糊光点，不需要 1.5 倍 DPI 渲染 —— 按 DPR 渲染纯属浪费，
     * 只会掉帧；一掉帧自适应就把倍率往下砍，缓冲区小于显示尺寸后画布被浏览器
     * 拉伸，粒子变大变糊、加色混合下重叠更多 → 整个画面变亮。
     * （实测：倍率 1.5 掉帧后砍到 0.55，682x441 的缓冲区被拉到 1240x802 显示。）
     *
     * 固定 1.0 既避免了拉伸，又省掉 55% 的像素，帧率反而更好。
     */
    /*
     * ★ 渲染倍率改成跟着 devicePixelRatio 走（上限 1.5）。
     *
     * 原来是钉死 1.0，理由写在下面（省像素、避免自适应降级导致画布拉伸）。
     * 那个理由当时是对的 —— 那时在追帧率，而且效果都是大团柔光粒子，
     * 糊一点看不出来。
     *
     * 但**半调封面和这条是直接冲突的**：这块屏 dpr=1.5，
     * 而缓冲只有 1240x802，要放大到 1860x1203 显示 ——
     * 也就是每一颗网点都被双线性插值模糊了 1.5 倍。
     * 半调靠的就是"点要脆"，点一糊，网点就退化成灰雾，
     * 这正是我前面几版一直"太暗"的原因之一：不是不够亮，是被糊掉了。
     *
     * 代价方面：后来测出性能瓶颈在出图路径上、**跟像素数几乎无关**
     * （画布面积砍到 6% 也只快了 13%），所以这一次提倍率的代价
     * 比我当初估计的小得多。
     */
    const dpr = Math.max(1, Math.min(1.5, window.devicePixelRatio || 1));
    this.baseScale = Math.min(dpr, opts.maxPixelRatio ?? 1.5);
    this.scale = this.baseScale;

    /*
     * ============ desynchronized（低延迟上屏）============
     *
     * 背景：实测"只要调用一次 renderer.render()，就固定多花约 5ms"，
     * 跟画什么、画多大、主线程忙不忙全都无关（主线程每帧只占 0.97ms，
     * 75 秒内一个 ≥50ms 的长任务都没有）。而不出图时帧间隔正好是
     * 6.1ms —— 165Hz 的垂直同步间隔，一帧不丢。
     * 所以那 5ms 是"把 WebGL 画面合成进页面"这件事本身的开销。
     *
     * desynchronized 就是针对这个的：让画布走**低延迟直通路径**，
     * 不再等合成器的常规排队。代价是画布与页面上其它元素之间可能不同步，
     * 而我们的画布是垫在最底下的纯背景，正好没有这个问题。
     *
     * three.js 的 WebGLRenderer **不转发**未知的 context 属性，
     * 所以这里要自己建 context 再交给它。
     *
     * 用 URL 上的 #desync 开关，方便 A/B 对比而不必改代码。
     */
    const wantDesync = /(^|[#&])desync/.test(location.hash);
    this.desync = false;
    let glCtx = null;
    if (wantDesync) {
      const attribs = {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance',
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
        desynchronized: true,
      };
      try {
        glCtx = canvas.getContext('webgl2', attribs) || canvas.getContext('webgl', attribs);
      } catch (e) {
        glCtx = null;
      }
      // ★ 回读实际生效的属性，不能只看"我请求了"
      const got = glCtx && glCtx.getContextAttributes ? glCtx.getContextAttributes() : null;
      this.desync = Boolean(got && got.desynchronized);
      console.log(
        `[上屏] 请求 desynchronized=true → 实际 ${this.desync ? '已生效' : '未生效（浏览器忽略了这个提示）'}`
      );
    }

    this.renderer = new THREE.WebGLRenderer(
      glCtx
        ? { canvas, context: glCtx }
        : {
            canvas,
            antialias: false, // 粒子是柔边圆点，抗锯齿收益很小、开销不小
            alpha: true,
            powerPreference: 'high-performance',
            stencil: false,
            depth: false,
          }
    );
    this.renderer.setPixelRatio(this.scale);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.setClearColor(0x000000, 0);

    /*
     * 把**实际在用的** GPU 报出来。
     *
     * 为什么必须单独查这个：`app.getGPUInfo()` 报的是"系统里装了哪些显卡"，
     * 在双显卡笔记本上它会把核显排在最前面，于是日志看着像在用核显，
     * 但真正跑 WebGL 的可能是独显 —— 反过来也一样。只有 GL 上下文的
     * UNMASKED_RENDERER_WEBGL 才是"这块画布实际画在哪块 GPU 上"的权威答案。
     * 排查性能问题第一步就该看这一行。
     */
    try {
      const gl = this.renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const r = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '未知（缺 debug_renderer_info 扩展）';
      const soft = /swiftshader|software|llvmpipe|basic render/i.test(String(r));
      console.log(`[渲染] WebGL 实际后端 = ${r}${soft ? '   ⚠️ 这是软件渲染，性能优化全部无效！' : ''}`);
    } catch (e) {
      console.warn('[渲染] 查询 WebGL 后端失败:', e.message);
    }

    this.scene = new THREE.Scene();
    /*
     * 封面粒子层单独一个场景。
     *
     * 它不参与泛光 —— 见 setCoverFromCanvas 与 _tick 里的说明。
     * 单独成场景是唯一干净的做法：只要它在主场景里，就必然被后处理链
     * 一起处理，白底封面会被泛光炸成一片眩光。
     */
    this.coverScene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 400);
    this.camera.position.set(0, 0, 9);

    /*
     * ============ 歌词 / 歌名舞台（billboard）============
     *
     * 照 Mineradio 的做法实现。三条缺一不可：
     *
     * 1. **巨大、粗体、发光**。它那行歌名几乎占屏宽 60%，而我们的标题
     *    原来只有 20px 细体 —— 之前说的"歌词很清楚"，靠的就是这个尺寸。
     * 2. **永远正对镜头**（billboard）。所以 360° 转到任何角度，
     *    文字都不镜像、不变形、不会被看成一条线。
     * 3. **摆在封面后面**（沿视线方向再退一段）。但封面是**点阵、有缝**，
     *    文字从缝里透出来 —— 于是看着像嵌在封面里，而不像隔着一层板子。
     *    这就是"在封面后面、但看着又不像在后面"。
     *
     * 放进 coverScene（不进泛光链）是有意的：它和封面是同一层视觉，
     * 而且巨大白字一旦进泛光就会被炸成一片眩光。
     */
    {
      const LW = 2048;
      const LH = 512;
      this.stageCanvas = document.createElement('canvas');
      this.stageCanvas.width = LW;
      this.stageCanvas.height = LH;
      this.stageCtx = this.stageCanvas.getContext('2d');
      this.stageTex = new THREE.CanvasTexture(this.stageCanvas);
      if ('colorSpace' in this.stageTex) this.stageTex.colorSpace = THREE.SRGBColorSpace;
      this.stageW = 9.6;    // 世界宽度：正面可见宽 13.58，取 9.6 让大字约占屏宽 65%（Mineradio 那行也是约 60%）
      this.stageBack = 0.9; // 退到封面之后多少（世界单位）。不能大：板子退得越远，从背面看离镜头越近、字放得越大（退 2.6 时背面比正面大 1.8 倍，很跳）
      this.stageGeo = new THREE.PlaneGeometry(this.stageW, (this.stageW * LH) / LW);
      /*
       * ★ 两面各一块板，**不是 billboard**。
       *
       * 我第一版做成了"永远正对镜头的公告板"，那是错的 ——
       * 那样从任何角度看文字都是正的，而用户要的是：
       * **只有正面和反面看得见，转到侧面就没了**（侧对镜头变成一条线），
       * 也就是**文字跟封面绑死在同一块平面上**。
       *
       * 于是用最经典的做法：两块完全重合、背对背的板。
       *   · 都用默认的 FrontSide（**不能**用 DoubleSide ——
       *     双面板会从背面透出镜像的文字，和正面那块叠成双影）
       *   · 后面那块绕 Y 轴转 180° —— 于是它正对 -Z 方向
       *   · 人转到反面时看到的是**后面那块板的正面**，所以文字依然是顺的，
       *     而不是镜像
       *   · 转到 90° 侧面时两块都侧对镜头，文字自然消失
       *
       * 另外它们在 Z 上退到封面之后（stageBack），所以纵深上确实"在封面后面"；
       * 而绘制排在点阵之后（renderOrder 2 > 1），于是字永远干净锐利。
       * 这两条合起来才是"在封面后面、但看着又不像在后面"。
       */
      const stageMat = new THREE.MeshBasicMaterial({
        map: this.stageTex,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.NormalBlending,
        side: THREE.FrontSide,
      });
      this.stageFront = new THREE.Mesh(this.stageGeo, stageMat);
      this.stageRear = new THREE.Mesh(this.stageGeo, stageMat);
      this.stageRear.rotation.y = Math.PI;
      this.stageFront.renderOrder = 2;
      this.stageRear.renderOrder = 2;
      this.stageFront.visible = false;
      this.stageRear.visible = false;
      this.stageFront.visible = false;
      this.stageRear.visible = false;
      this.coverScene.add(this.stageFront);
      this.coverScene.add(this.stageRear);
      this._stageKey = null;
    }

    // 所有效果共享这一份 uniform，避免各自维护状态
    this.uniforms = {
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uPixelRatio: { value: this.scale },
      uPointer: { value: new THREE.Vector2(0, 0) },
      uPointerStrength: { value: 0 },
      // 节拍位移幅度：按效果自身的空间尺度设定，见 BEAT_AMP
      uBeatAmp: { value: 0.6 },
      /**
       * 距上次鼓点多少秒（上限约 2 秒）。
       *
       * 这是"涟漪深潭 / 极光帷幕 / 引力深渊"这三个效果的基础：
       * 它们要做的是**从中心向外传播的行波**（水波、扫过的涌动、冲击波），
       * 而这类观感需要知道"鼓点发生在多久之前"才能算出波前走到哪了。
       * 只有 uPulse 那种起落的标量是做不到的 —— 它没有时间维度，
       * 最多只能做整体缩放。
       */
      uBeatAge: { value: 2 },
      /**
       * 实时频谱，16 段。
       *
       * "声纹星盘"靠它把当前响着的频率画成形状 —— 低音撑内圈、高音挑外圈。
       * 只有 16 个 float，uniform 开销可以忽略。
       * 注意传数组 uniform 时**必须传同一个数组引用**（不要每帧新建），
       * 否则 three 每帧都要重传，白白多花开销。
       */
      uBands: { value: new Array(16).fill(0) },
      /**
       * 频谱的历史长卷（16 段 × 128 个时间片）。
       *
       * "声纹长卷"靠它把**过去几秒的音乐**画出来：每一列是一次采样的频谱，
       * 新的一列从右边进来、旧的往左退。于是画面不是"当下这一刻的频谱"，
       * 而是**一段时间里音乐的轨迹**，能看出鼓点落在哪、旋律怎么走。
       *
       * 用纹理而不是 attribute，是因为它每帧都要整体位移一格 ——
       * 纹理只要把数据挪一位再标记 needsUpdate，比重建 attribute 便宜得多。
       */
      uBandTex: { value: null },
    };

    this.pointerTarget = { x: 0, y: 0, active: 0 };
    this.palette = null;
    /** 封面上的涟漪队列，见 pulse() 与 setCoverFromCanvas 里的说明 */
    this.coverRipples = [];
    /**
     * 相机轨道状态：左键拖动绕中心旋转。
     * 见 _tick 里相机那段的说明 —— 空间感是从"能转着看"来的。
     */
    this.orbit = {
      az: 0,
      el: 0,
      vAz: 0,   // 角速度，松手后靠它做惯性
      vEl: 0,
      dragging: false,
      returning: false,     // 是否正在自动回正
      lastActiveAt: 0,      // 最后一次拖动/惯性的时刻，用来算"停手多久"
      lastX: 0,
      lastY: 0,
      radius: 9,
    };

    /*
     * 频谱历史纹理。
     *
     * 布局刻意做成 **宽 16（频段）× 高 128（时间）**，而不是反过来：
     * 这样每个时间片是连续的 16 个字节，"向左滚动"就是一次连续内存搬移
     * （copyWithin），搬 2KB 而已。若做成宽 128 × 高 16，就得逐行搬 16 次。
     *
     * 采样约定（着色器里要用对）：
     *   u → 频段（0 = 最低频）
     *   v → 时间（0 = 最旧，1 = 最新）
     *
     * 用 RedFormat + UnsignedByteType：只有亮度一个通道、8 位精度，
     * 对"把强度画成光"完全够，而且是最省的一档。
     * LinearFilter 让相邻时间/频段之间插值，长卷才是连续的光带而不是马赛克。
     */
    {
      const W = 16;
      const H = 128;
      const data = new Uint8Array(W * H);
      const tex = new THREE.DataTexture(data, W, H, THREE.RedFormat, THREE.UnsignedByteType);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      this._bandTexData = data;
      this._bandTexW = W;
      this._bandTexH = H;
      this.uniforms.uBandTex.value = tex;
    }

    // ---- 后处理：泛光 ----
    this.bloomEnabled = opts.bloom !== false;
    /** 'unreal' | 'cheap'，见 CheapBloomPass / settings.bloomMode 的说明 */
    this.bloomMode = opts.bloomMode === 'cheap' ? 'cheap' : 'unreal';
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    /*
     * 泛光有两种实现，默认用 three 自带的 UnrealBloomPass。
     *
     * 我一度把它换成自写的 CheapBloomPass，理由只有一个：在**核显**上省性能。
     * 但后来查明这台机器是双显卡，Chromium 一直把应用挂在核显上跑，独显
     * （RTX 5060）全程闲着；加上 force_high_performance_gpu 之后，UnrealBloomPass
     * 这点开销在独显上完全不值一提 —— 换掉它的理由从一开始就不成立。
     *
     * 而且它的多尺度光晕（5 级降采样叠加）观感明显更"润"：
     * 廉价版即使做到两级金字塔，也还是能看出光晕层次偏薄。
     * 所以默认回到原版；'cheap' 留给核显或想省电的场景。
     *
     * threshold 控制"多亮才发光"：太低会整片发白过曝，太高则只有最亮的核才发光。
     */
    if (this.bloomMode === 'unreal') {
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        opts.bloomStrength ?? 0.45, // strength
        0.58,                       // radius
        opts.bloomThreshold ?? 0.12 // threshold
      );
    } else {
      this.bloomPass = new CheapBloomPass(
        opts.bloomStrength ?? 0.9,
        opts.bloomThreshold ?? 0.12
      );
    }
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

    // 性能统计
    this.fps = 60;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this._slowStreak = 0;
    this._fastStreak = 0;
    this.autoQuality = opts.autoQuality !== false;

    this.clock = new THREE.Clock();
    this._tick = this._tick.bind(this);
    this._onResize = this._onResize.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onVisibility = this._onVisibility.bind(this);
    this._onOrbitDown = this._onOrbitDown.bind(this);
    this._onOrbitMove = this._onOrbitMove.bind(this);
    this._onOrbitUp = this._onOrbitUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onDblClick = this._onDblClick.bind(this);

    window.addEventListener('resize', this._onResize);
    window.addEventListener('pointermove', this._onPointerMove, { passive: true });
    document.addEventListener('visibilitychange', this._onVisibility);
    /*
     * 拖动旋转。监听挂在 window 上而不是 canvas 上 ——
     * canvas 是 pointer-events:none，收不到事件；而且挂在 window 上
     * 拖动时可以划出窗口范围也不丢失。
     */
    window.addEventListener('pointerdown', this._onOrbitDown);
    window.addEventListener('pointermove', this._onOrbitMove);
    window.addEventListener('pointerup', this._onOrbitUp);
    window.addEventListener('pointercancel', this._onOrbitUp);

    /*
     * 滚轮缩放（用户要求："可以鼠标滚轮放大缩小画面"）。
     *
     * 缩放就是改轨道半径。注意必须 passive:false ——
     * 默认的 passive 监听里 preventDefault 无效，页面会跟着一起滚。
     * 另外只在真的缩放了才 preventDefault：滚到上下限之后要把滚动权还给页面，
     * 否则用户在小窗口里会被"滚不动也翻不了页"卡住。
     */
    window.addEventListener('wheel', this._onWheel, { passive: false });

    /*
     * 左键双击归位。
     * 自动归位已经按要求关掉了（ORBIT_RETURN_DELAY_MS = Infinity），
     * 但仍需要一个"回到正面"的入口 —— 双击是最顺手的那个。
     */
    window.addEventListener('dblclick', this._onDblClick);

    // 盯 canvas 自己的尺寸变化：窗口化启动、DPI 变化、布局回流都会触发，
    // 比只监听 window.resize 可靠得多
    this._ro = new ResizeObserver(() => this._onResize());
    this._ro.observe(canvas);

    // 立刻校一次，并在下一帧再校一次（此时布局才真正稳定）
    this._onResize();
    requestAnimationFrame(() => this._onResize());

    // 再在几秒后打一次，用来观察自适应降级有没有把 scale 改掉
    setTimeout(() => this._logSize('3s'), 3000);
    setTimeout(() => this._logSize('8s'), 8000);

    this.setEffect(this.effectKey, { silent: true });
    this._tick();
  }

  /* ---------------- 效果切换 ---------------- */

  setEffect(key, { silent = false } = {}) {
    /*
     * 换效果时把相机归位到正面。
     *
     * 每个效果的空间布局差别很大（有的是正面圆盘、有的是纵深隧道、
     * 有的是环绕结构），上一个效果转到侧面之后换新的，新效果一上来就是歪的，
     * 第一眼会很怪 —— 而且用户看到的"换效果"应该是一个干净的重新开始。
     * 所以这里直接归零，不走去抖（换效果本来就是个突变的动作）。
     */
    if (this.orbit) {
      this.orbit.az = 0;
      this.orbit.el = 0;
      this.orbit.vAz = 0;
      this.orbit.vEl = 0;
      this.orbit.returning = false;
      this.orbit.dragging = false;
      document.body.classList.remove('is-orbiting');
    }

    if (this.group) {
      this.scene.remove(this.group);
      disposeGroup(this.group);
      this.group = null;
    }

    const d = this.density;
    // 各效果的基础粒子数，按密度缩放。数量直接决定观感和帧率。
    const counts = {
      spectrum: { count: Math.round(24000 * d) },
      spectrogram: { count: Math.round(21000 * d) },
      coral: { count: Math.round(20000 * d) },
      tunnel: { count: Math.round(24000 * d) },
      rain: { count: Math.round(16000 * d) },
      vinyl: { count: Math.round(26000 * d) },
      halo: { rings: 7, perRing: Math.round(3200 * d), corona: Math.round(2600 * d) },
    };

    // 按效果自身的空间尺度设定节拍位移幅度
    this.beatAmp = BEAT_AMP[key] ?? 0.6;
    if (this.uniforms.uBeatAmp) {
      this.uniforms.uBeatAmp.value = this.beatAmp * (this.pulseIntensity ?? 0.7);
    }

    this.group = buildEffect(key, this.uniforms, counts[key] || {});
    this.scene.add(this.group);
    this.effectKey = key;

    // 诊断：确认新效果的材质确实共享了舞台的 uniform 对象
    let shared = null;
    this.group.traverse((o) => {
      if (shared === null && o.isPoints && o.material && o.material.uniforms) {
        shared = o.material.uniforms.uPulse === this.uniforms.uPulse;
      }
    });
    console.log(`[粒子] 切换到 ${key}：材质共享 uPulse = ${shared}`);

    if (this.palette) this.setPalette(this.palette);

    if (!silent && this.onEffectChange) this.onEffectChange(key);
    return key;
  }

  /** 换配色：只改颜色属性，不重建几何 */
  setPalette(palette) {
    this.palette = palette;
    if (!this.group) return;
    tintEffect(this.group, palette);
    /*
     * 线段要单独上色 —— tintEffect 第一句就是 `if (!obj.isPoints) return`，
     * 所以 LineSegments（黑洞的时空网格）它根本不碰。
     * 不补这一段，网格会一直是材质上的白色，在"配色跟着封面走"打开时
     * 它就是画面里唯一一处不跟着变的颜色。
     */
    const lineSrc = palette && (palette.ribbons || palette.stars);
    if (!lineSrc || !lineSrc.length) return;
    const c = lineSrc[0];
    this.group.traverse((o) => {
      if (o.isLineSegments && o.material && o.userData.tintable) {
        o.material.color.setRGB(c[0], c[1], c[2]);
      }
    });
  }

  /* ---------------- 封面层 ---------------- */

  /**
   * 封面粒子层
   *
   * 它和背景效果处在**同一个场景**里，共享相机、共享泛光后处理链 ——
   * 这是关键。之前封面是独立的 canvas + 独立的 WebGL 上下文 + 独立的渲染
   * 循环，而且没有泛光，所以看起来像"贴在旁边的一块"。
   *
   * 每颗粒子有两套位置：
   *   散开态  在背景体积里随机漂浮（和背景粒子混在一起，分不出来）
   *   成形态  落在封面圆盘的网格点上
   * uForm 在这两者之间插值，所以切到"正在播放"时，封面是从周围的粒子
   * **聚拢成形**的，切走时再散回背景里。
   *
   * @param {string|HTMLImageElement|HTMLCanvasElement} source 封面图
   * @param {number} [grid] 采样网格密度
   */
  /**
   * 设置 3D 舞台上的大字（歌名 / 当前歌词行）+ 副行。
   *
   * 只在文字真的变了才重画 —— 每帧重绘 2048x512 的画布再上传纹理，
   * 是那种"看着不卡、但一直在偷偷吃 GPU"的开销。
   */
  setStageText(main, sub) {
    const key = `${main || ''}\u0000${sub || ''}`;
    if (key === this._stageKey) return false;
    this._stageKey = key;
    const ctx = this.stageCtx;
    if (!ctx) return false;

    const W = this.stageCanvas.width;
    const H = this.stageCanvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!main) {
      this.stageFront.visible = false;
      this.stageRear.visible = false;
      this.stageTex.needsUpdate = true;
      return false;
    }

    const FONT = '"Microsoft YaHei","PingFang SC","Noto Sans SC","Segoe UI",sans-serif';
    const hasSub = Boolean(sub);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 长标题要缩到放得下，否则会被画布直接裁掉
    let size = hasSub ? 150 : 170;
    ctx.font = `700 ${size}px ${FONT}`;
    const maxW = W * 0.94;
    for (let i = 0; i < 24 && ctx.measureText(main).width > maxW; i++) {
      size -= 6;
      ctx.font = `700 ${size}px ${FONT}`;
    }

    const y = hasSub ? H * 0.40 : H * 0.5;
    /*
     * 柔光做法：先用大 shadowBlur 画两遍（叠出辉光），再把 shadow 关掉画一遍实心。
     * 只画一遍带 shadow 的话，字心会被辉光吃掉、看着发虚。
     */
    ctx.shadowColor = 'rgba(255,255,255,0.50)';
    ctx.shadowBlur = 46;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(main, W / 2, y);
    ctx.fillText(main, W / 2, y);
    ctx.shadowBlur = 0;
    ctx.fillText(main, W / 2, y);

    if (hasSub) {
      let ss = 76;
      ctx.font = `500 ${ss}px ${FONT}`;
      for (let i = 0; i < 20 && ctx.measureText(sub).width > maxW; i++) {
        ss -= 4;
        ctx.font = `500 ${ss}px ${FONT}`;
      }
      ctx.fillStyle = 'rgba(232,238,255,0.70)';
      ctx.fillText(sub, W / 2, H * 0.72);
    }

    this.stageTex.needsUpdate = true;
    this.stageFront.visible = true;
    this.stageRear.visible = true;
    return true;
  }

  async setCover(source, grid = 176) {
    if (!source) {
      this.clearCover();
      return 0;
    }

    const SRC = 512;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SRC;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return 0;

    let img;
    try {
      img = typeof source === 'string' ? await loadImage(source) : source;
    } catch {
      return 0; // 跨域或加载失败：保持现状，由调用方决定退回什么
    }

    ctx.clearRect(0, 0, SRC, SRC);
    ctx.drawImage(img, 0, 0, SRC, SRC);
    return this.setCoverFromCanvas(ctx, SRC, SRC, grid);
  }

  /** 程序化绘制的采样源（没有封面时画一张唱片兜底） */
  setCoverFromCanvas(ctx, w, h, grid = 176) {
    const alphaCut = 42;
    const data = ctx.getImageData(0, 0, w, h).data;

    /*
     * 先算一张**边缘图**（Sobel 梯度）。
     *
     * 这是参考 Mineradio 的做法学到的，也是"封面看起来像不像那张图"的关键：
     * 只按像素亮度铺点阵的话，图案的**轮廓**和**平坦色块**在视觉上一样重，
     * 结果整张图糊成一片发光的色块，认不出是什么。
     * 把梯度大的地方（也就是轮廓线）单独提出来加亮，封面立刻变成
     * "发光线条 + 暗部填充"的层次 —— 这正是专辑封面最容易辨认的形态。
     *
     * 在 512×512 上做一次 Sobel 大约几毫秒，只在换歌时算一次，可以接受。
     */
    const lumAt = (x, y) => {
      const i = ((y * w + x) | 0) * 4;
      return (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    };
    const edgeMap = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        // Sobel：分别求 x / y 方向的一阶差分
        const gx =
          -lumAt(x - 1, y - 1) - 2 * lumAt(x - 1, y) - lumAt(x - 1, y + 1) +
          lumAt(x + 1, y - 1) + 2 * lumAt(x + 1, y) + lumAt(x + 1, y + 1);
        const gy =
          -lumAt(x - 1, y - 1) - 2 * lumAt(x, y - 1) - lumAt(x + 1, y - 1) +
          lumAt(x - 1, y + 1) + 2 * lumAt(x, y + 1) + lumAt(x + 1, y + 1);
        edgeMap[y * w + x] = Math.min(1, Math.hypot(gx, gy) * 0.9);
      }
    }

    const target = [];   // 成形：封面圆盘上的位置
    const scatter = [];  // 散开：背景体积里的位置
    const colors = [];
    const phases = [];
    const sizes = [];
    const delays = [];
    /*
     * 三个**互相独立**的随机量。
     *
     * 以前所有节拍参数都从 aPhase 一个相位推出来（fract(bph*0.777)、
     * fract(bph*0.618)…），等于每颗粒子只抽了一次随机 —— 于是"深度"和
     * "触发时刻"是**相关**的，侧面看就有结构感、像一层一层的。
     * 用户原话："每个粒子不要复用"。
     * 所以这里各发一份独立随机：深度、时机、弹跳高度各用各的。
     */
    const rndA = [];
    const rndB = [];
    const rndC = [];
    const weights = [];
    const edges = [];    // 该采样点的边缘强度，供着色器加亮轮廓
    const stars = [];    // 该采样点的明亮程度，用来决定"要不要给它一圈柔光"
    const depths = [];   // 伪深度：把封面在 Z 方向顶起来，做成浮雕而不是平面点阵

    const DISC_R = 4.05; // 铺满竖向（正面可见半高 4.4）；原来 3.5 明显小一圈
    this.coverRadius = DISC_R; // 供着色器算边缘淡出
    const stepX = w / grid;
    const stepY = h / grid;

    /*
     * ============ 自动色阶（半调必需的预处理）============
     *
     * 加这一步的原因：改成半调之后，"ilyhiryu - COMBATANT"这种**85% 是黑底**
     * 的封面直接消失了 —— 亮度几乎全是 0，点径全落到最小值、颜色又接近黑，
     * 黑点画在黑背景上，等于没画。
     *
     * 问题出在我把点径直接绑到了**绝对亮度**上。而半调是**色调**渲染：
     * 它该映射的是图像**自身**的明暗范围，不是绝对亮度 ——
     * 印刷厂做网点之前一定先调色阶，就是这个道理。
     *
     * 这里用 64 档直方图取 2% / 98% 分位当作黑白场，而不是直接取最小最大值：
     * 一张图里往往有几个纯黑/纯白像素（边框、水印），
     * 用极值当黑白场会把整张图的层次压扁成一小段。
     */
    const hist = new Int32Array(64);
    let lumLo = 0;
    let lumHi = 1;
    {
      let n = 0;
      for (let p = 0; p < data.length; p += 4) {
        if (data[p + 3] < alphaCut) continue;
        const l =
          (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
        hist[Math.min(63, Math.max(0, (l * 64) | 0))]++;
        n++;
      }
      if (n > 0) {
        const lo = Math.floor(n * 0.02);
        const hi = Math.ceil(n * 0.98);
        let acc = 0;
        let loBin = 0;
        let hiBin = 63;
        for (let b = 0; b < 64; b++) {
          acc += hist[b];
          if (acc <= lo) loBin = b + 1;
        }
        acc = 0;
        for (let b = 0; b < 64; b++) {
          acc += hist[b];
          if (acc >= hi) {
            hiBin = b;
            break;
          }
        }
        lumLo = loBin / 64;
        lumHi = Math.max(lumLo + 1 / 64, hiBin / 64);
      }
    }
    const lumSpan = Math.max(1e-4, lumHi - lumLo);
    /*
     * 存到 this 上，等 coverUniforms 建好之后再取。
     * 注意不能在这里直接写 this.coverUniforms —— 它是在本函数后面
     * 才被创建的，这里它还是 undefined，赋值会静默落空，
     * 结果是颜色完全不走色阶、封面依旧一片暗灰，而且**没有任何报错**。
     */
    this._toneLo = lumLo;
    this._toneSpan = lumSpan;
    /** 把绝对亮度映射到"这张图自己的 0~1" */
    const tone = (l) => Math.min(1, Math.max(0, (l - lumLo) / lumSpan));
    console.log(
      `[封面] 自动色阶 黑场=${lumLo.toFixed(3)} 白场=${lumHi.toFixed(3)}（点径按这一段拉伸）`
    );

    for (let gy = 0; gy < grid; gy++) {
      for (let gx = 0; gx < grid; gx++) {
        const px = Math.min(w - 1, Math.floor(gx * stepX + stepX * 0.5));
        const py = Math.min(h - 1, Math.floor(gy * stepY + stepY * 0.5));
        const i = (py * w + px) * 4;
        const a = data[i + 3];
        if (a < alphaCut) continue;

        /*
         * ★ 网格点必须用**理想格子位置**算，不能用取整后的源图像素反算。
         *
         * 原来的写法是 u = (px / w) * 2 - 1，而 px 是
         * Math.floor(gx * stepX + stepX * 0.5) —— 一个整数像素下标。
         * 512 的源图配 176 网格时步长只有 2.9 像素，取整之后
         * 相邻格子的间隔在 3 和 4 像素之间跳，换算到世界坐标就是
         * **±17% 的间距误差** —— 放大一看就是"粒子错位、不等间距"。
         *
         * （px/py 仍然用来采样源图颜色，那没问题；错的只是拿它当坐标。）
         */
        const u = ((gx + 0.5) / grid) * 2 - 1;
        const v = -(((gy + 0.5) / grid) * 2 - 1);

        target.push(u * DISC_R, v * DISC_R, 0);

        // 散开位置：球壳内随机，范围比背景略小，看起来像是从背景里来的
        const r = 6 + Math.pow(Math.random(), 0.6) * 14;
        const th = Math.random() * TAU;
        const ph = Math.acos(2 * Math.random() - 1);
        scatter.push(
          r * Math.sin(ph) * Math.cos(th),
          r * Math.sin(ph) * Math.sin(th) * 0.85,
          r * Math.cos(ph) * 0.7 - 6
        );

        /*
         * 亮度感知权重 —— 现在它是**不透明度**，不再是防止过曝的补偿系数。
         *
         * 这里改动很大，原因值得记下来：封面层原本用的是**加色混合**，
         * 而加色混合根本无法表达一张图片 ——
         *   · 暗部：加上去等于没加，整片消失，封面丢了轮廓
         *   · 亮部：几千颗粒子叠加，直接糊成一片白
         *   · 原来的 aWeight = 1 - 亮度×0.72 是想压住过曝，但这样一来
         *     亮底封面被压得很淡、暗底封面反而更亮，**明暗关系是反的**
         * 表现出来就是"封面像素点阵看不出是什么"。
         *
         * 现在改成正常混合 + 用像素自己的明度当不透明度：
         * 暗部仍然很低（融进深色背景，这本来就对），但给了一个下限，
         * 保证封面的轮廓始终可辨；亮部明确地亮。图像关系终于是对的。
         */
        const lum = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;

        /*
         * 高光压缩（轻度）。
         *
         * 白底封面过曝的**主因**是泛光，已经通过"把封面层移出后处理链"解决
         * （见 _tick 里渲染那段）。这里只留一道轻压作为保险：
         * 纯白在深色背景上一大片铺开本来就会显得刺眼，压到 0.82
         * 既保住"这是白底"的观感，又不会晃眼。
         *
         * 只压高光端、不动中间调 —— 封面的色彩层次几乎都在 0~0.62 这一段，
         * 用 pow 之类的整条曲线会把中间调一起压暗，封面就发灰发闷了。
         */
        const HI = 0.62;
        const HI_CAP = 0.82;
        let shapedLum = lum;
        if (lum > HI) shapedLum = HI + ((lum - HI) / (1 - HI)) * (HI_CAP - HI);
        // 按明度比例缩放三个通道，保持色相不变
        const k = lum > 1e-4 ? shapedLum / lum : 1;

        /*
         * ★ 用"鲜艳度"而不是"亮度"来判断一个点该多大多亮。
         *
         * lum = 0.2126R + 0.7152G + 0.0722B 对**饱和的红和蓝**严重低估：
         * 一颗鲜艳的红星 (200,30,50) 算出来 lum 只有 0.27，跟暗部差不多，
         * 于是被当成"暗点"处理 —— 而它视觉上非常醒目。
         * 这张封面恰好只有红和青两种颜色，正好全踩在这个盲区上，
         * 所以怎么调亮度都还是"一片发闷的点"。
         *
         * maxc = max(R,G,B) 才反映"这个点有多扎眼"：
         *   黑 → 0，红星 → 0.78，青星 → 0.78，白 → 1.0
         * 用 maxc 驱动点径和明暗，星点才终于能跳出来。
         * （lum 仍然保留，用于颜色的高光压缩 —— 那一处要的是真实亮度。）
         */
        const maxc = Math.max(data[i], data[i + 1], data[i + 2]) / 255;

        /*
         * ============ 伪深度（浮雕）============
         *
         * 这一步是我看 Mineradio 的着色器才意识到缺了什么：
         * 它把封面在 **Z 方向按深度图顶起来**（pos.z 加上一个从深度图来的偏移），
         * 于是封面是一个**有起伏的立体雕塑**，而不是一块平的点阵。
         * 这正是"它做得好看、我做得像脏点"的关键差别。
         *
         * 我没有 AI 深度估计，但可以用**模糊后的亮度**当伪深度：
         * 亮的区域往前顶、暗的区域往后沉。虽然不是真深度，
         * 但足够产生"这张图有体积"的观感 —— 对氛围来说这就够了。
         *
         * 模糊用"中心加权 + 四方向邻域"，是个很便宜的近似：
         * 直接用原亮度会得到一张到处是台阶的碎面，模糊之后才连成起伏。
         */
        const span = Math.max(4, Math.round(w / grid * 1.6));
        const depth =
          (lumAt(px, py) * 4 +
            lumAt(Math.max(0, px - span), py) +
            lumAt(Math.min(w - 1, px + span), py) +
            lumAt(px, Math.max(0, py - span)) +
            lumAt(px, Math.min(h - 1, py + span))) /
          8;

        /*
         * 暗部的地板不能再低了。
         *
         * 这张封面 85% 是黑的，而背景也是黑的 —— 暗部一旦融进背景，
         * 图案就失去了"体"，只剩几个亮点浮在空处（实测渲染出来只有 19/255，
         * 看着就是"黑底上几团彩色污点"）。
         *
         * 要让封面读得出来，暗部必须是一块**看得见的板**：
         * 0.62 的 alpha 地板，乘上下面 0.42 的基色，落在约 67/255 ——
         * 像一块深灰的底板，亮点才有依托，整张图才成立。
         */
        /*
         * 改成半调之后，**alpha 就不再承担表达图像的任务了** ——
         * 明暗已经由点径负责。半调要的是"实心油墨"：
         * 每颗点都该是实打实的一个点，而不是半透明的雾。
         * 所以这里取一个接近恒定的高值，只留一点随亮度的微调。
         */
        weights.push(0.90 + maxc * 0.10);
        stars.push(maxc);
        depths.push(depth);

        /*
         * 轮廓强度：取该点 3×3 邻域里最大的梯度值。
         * 取 max 而不是平均值，是为了让细线也能被完整提出来 ——
         * 平均会把一像素宽的线条稀释掉，那正是最需要突出的部分。
         */
        let eg = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const ex = px + ox;
            const ey = py + oy;
            if (ex < 0 || ey < 0 || ex >= w || ey >= h) continue;
            const v = edgeMap[ey * w + ex];
            if (v > eg) eg = v;
          }
        }
        edges.push(eg);

        // 颜色按 k 做高光压缩，色相不变
        /*
         * ★ 底色托底 —— 这是"封面认不出来"的真正原因，我绕了好几轮才看到。
         *
         * 关键事实：**纯黑像素的颜色是 0，alpha 再大也画不出东西。**
         * 而大部分专辑封面（尤其这张，85% 是黑底）暗部占绝大多数，
         * 于是那些粒子**完全消失**，只剩零星几个亮点浮在空处 ——
         * 看起来就是"散落的彩色噪点"，不是一张图。
         *
         * 截图对照才看明白：原图是黑底上一格格红/青四角星，
         * 而我的渲染只剩下那几个星点，黑底整个塌掉了，图案失去完整性。
         *
         * 修法：给暗部一个极小的基色（略微偏蓝的深灰），
         * 让整个封面重新成为一个"面"，亮点才有依托。
         * 数值取 0.16 而不是更小，是因为它还要乘 alpha（约 0.47），
         * 乘完落在 19/255 左右 —— 刚好能看出有一层底，又不至于发灰。
         */
        /*
         * 点径必须小于粒子间距，否则点阵会糊成实心块；
         * 但也不能太小，否则图案的亮度撑不起来。
         *
         * 网格提到 200 之后间距约 2.7px（封面约占屏宽 45%、窗口 1240 时），
         * 所以点径要压到 2px 左右，覆盖约 55% —— 既能看清每个采样点，
         * 又不会被糊成一片。
         */
        colors.push((data[i] / 255) * k, (data[i + 1] / 255) * k, (data[i + 2] / 255) * k);
        phases.push(Math.random() * TAU);
        /*
         * ============ 半调网点（halftone）============
         *
         * ★ 这里推翻了我上一版写下的结论，必须留下记录。
         *
         * 上一版我写的是"点径不能承载图像数据，应该恒定为 0.84×间距，
         * 让颜色去表达图像"。**这个结论是错的。**
         *
         * 错在把"点径承载图像"和"点径跨度失控"当成了一回事。
         * 真正的问题从来不是"由亮度决定点径"，而是：
         *   · 依据选错了 —— 我用的是 max(R,G,B)（饱和度），该用的是**亮度**
         *   · 跨度失控 —— 0.7px 到 6.1px，近 9 倍，中间还隔着随机数
         *   · 还叠了加色混合和泛光，大点直接炸成光斑
         * 那不是半调，那是撒纸屑。
         *
         * 看了 Mineradio 的实际画面才明白：它就是**经典半调网点** ——
         * 细密规整的网格，点径随局部亮度平滑变化，
         * 相邻点在亮处连成面、在暗处散成点，整张图就"印"出来了。
         * 这是印刷业一百多年的办法，也确实是封面粒子最好看的做法。
         *
         * 所以现在按半调来：
         *   点径 = f(该点亮度)，跨度 0.45~2.15（约 4.8 倍，受控）
         *   混合保持正常混合（不是加色）、不进泛光链 —— 这两条早就对了
         *   间距要足够细，否则点连不成面（见下面网格分辨率的说明）
         */
        /*
         * 点径区间要足够大，否则"墨量"不够。
         *
         * 第一版我取 0.45~2.15（平均约 1.0），结果整块封面几乎看不见 ——
         * 因为之前能看清的版本是**恒定 1.95**，而半调这一版在暗图上
         * 大部分点径都落在 1.0 以下。点太小 × 柔边遮罩，屏幕上的平均亮度
         * 就塌了。半调靠的是"点连成面"，点不够大就只是灰尘。
         * 现在 0.85~3.30，暗处是稀疏的点、亮处连成实面。
         */
        sizes.push(0.72 + tone(shapedLum) * 1.95);
        delays.push(Math.random()); // 逐粒延迟，聚拢时有先后，更自然
        rndA.push(Math.random());
        rndB.push(Math.random());
        rndC.push(Math.random());
      }
    }

    const count = sizes.length;
    if (count === 0) return 0;

    if (this.coverPoints) {
      this.coverScene.remove(this.coverPoints);
      this.coverPoints.geometry.dispose();
      this.coverPoints = null;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(target), 3));
    geo.setAttribute('aScatter', new THREE.BufferAttribute(new Float32Array(scatter), 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(colors), 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(new Float32Array(phases), 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(sizes), 1));
    geo.setAttribute('aDelay', new THREE.BufferAttribute(new Float32Array(delays), 1));
    geo.setAttribute('aRndA', new THREE.BufferAttribute(new Float32Array(rndA), 1));
    geo.setAttribute('aRndB', new THREE.BufferAttribute(new Float32Array(rndB), 1));
    geo.setAttribute('aRndC', new THREE.BufferAttribute(new Float32Array(rndC), 1));
    geo.setAttribute('aWeight', new THREE.BufferAttribute(new Float32Array(weights), 1));
    geo.setAttribute('aEdge', new THREE.BufferAttribute(new Float32Array(edges), 1));
    geo.setAttribute('aStar', new THREE.BufferAttribute(new Float32Array(stars), 1));
    geo.setAttribute('aDepth', new THREE.BufferAttribute(new Float32Array(depths), 1));

    this.coverUniforms = {
      ...this.uniforms,          // 共享时间/脉冲/指针
      uForm: { value: this.coverFocus ?? 0 },
      // 封面的半边长（世界单位），给着色器算边缘淡出用
      uCoverRadius: { value: this.coverRadius ?? 3.5 },
      /*
       * 浮雕强度：封面上"亮的部分往前顶、暗的部分往后沉"的幅度。
       *
       * 这是把它从"平面点阵"变成"立体光雕"的关键（学自 Mineradio 的深度浮雕思路）。
       * 用假深度（模糊亮度）时幅度不能太大，否则会穿帮；
       * 0.85 个世界单位在封面半边长 3.0 的尺度下约 28%，起伏明显但不失真。
       */
      uCoverDepth: { value: 0.12 },
      /*
       * 自动色阶的黑场/跨度，传给着色器**也用来拉颜色**。
       *
       * 只拉点径是不够的：点径拉开了、颜色还是原始值，一张暗封面的网点
       * 依然是一片暗灰。印刷调色阶是**黑白场同时作用于墨色和网点大小**的，
       * 这里也一样 —— 把 (aColor - lo) / span 映射到 0~1，
       * 无论原图偏暗还是偏亮，网点都能铺满整个动态范围。
       */
      uToneLo: { value: this._toneLo ?? 0 },
      uToneSpan: { value: this._toneSpan ?? 1 },
      // 成形时整体往左偏，给右边留出歌词面板的构图空间
      uCoverShift: {
        value: new THREE.Vector2(this.coverShift?.x ?? -0.35, this.coverShift?.y ?? 0),
      },
      /*
       * 封面上的涟漪（借鉴 Mineradio 的思路）。
       *
       * 它的做法是：低音砸下来时在封面上**随机位置**激起几圈水波，
       * 波在封面上传播 —— 于是鼓点表现为封面上"荡开一圈涟漪"，
       * 而不是整块封面一起缩放。
       *
       * 局部涟漪比全局缩放高级得多：全局缩放看久了像在喘气，
       * 而涟漪是有位置的、会跑的，像鼓点真的砸在了这张图上。
       *
       * 每个涟漪 4 个数：(x, y, 已存活秒数, 强度)，最多同时 5 个。
       * 用 uniform 数组而不是纹理 —— 只有 5 个，不值得为它开一张纹理。
       */
      uRipples: { value: new Array(20).fill(0) },
      uRippleCount: { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      uniforms: this.coverUniforms,
      transparent: true,
      depthWrite: false,
      /* 见下面 blending 的说明 */
      /*
       * 正常混合，**不是加色混合**。
       *
       * 加色混合适合"发光点云"（背景粒子），但封面层要做的是**呈现一张图片**，
       * 而加法天生表达不了图像：暗部会消失、亮部会过曝叠白。
       * 换成正常混合之后，每颗粒子按自己的颜色和不透明度落笔，
       * 整片点阵才会"看得出是那张封面"。
       */
      blending: THREE.NormalBlending,
      vertexShader: `
        attribute vec3  aScatter;
        attribute vec3  aColor;
        attribute float aSize;
        attribute float aPhase;
        attribute float aDelay;
        // 三个互相独立的随机量（见 JS 侧 rndA/rndB/rndC 的说明）
        attribute float aRndA;
        attribute float aRndB;
        attribute float aRndC;
        attribute float aWeight;
        uniform float uTime;
        uniform float uPulse;
        uniform float uPixelRatio;
        uniform vec2  uPointer;
        uniform float uPointerStrength;
        uniform float uBeatAmp;
        /*
         * 距上一次鼓点过了多少秒。封面要用它做**逐粒的节拍脉冲**：
         * 每颗粒子有自己的延迟，到点才起跳、然后快速回落 ——
         * 这样才是"一颗一颗弹"，而不是整片跟着 uPulse 一起呼吸。
         */
        uniform float uBeatAge;
        uniform float uForm;
        uniform vec2  uCoverShift;
        uniform float uCoverRadius;
        attribute float aEdge;
        attribute float aStar;
        attribute float aDepth;
        uniform float uCoverDepth;
        uniform float uToneLo;
        uniform float uToneSpan;
        uniform float uRipples[20];
        uniform int   uRippleCount;
        varying vec3  vColor;
        varying float vAlpha;
        varying float vStar;

        // 绕 Y 轴的旋转矩阵
        mat3 rotY(float a) {
          return mat3(cos(a), 0.0, -sin(a), 0.0, 1.0, 0.0, sin(a), 0.0, cos(a));
        }
        // 绕 X 轴的旋转矩阵
        mat3 rotX(float a) {
          return mat3(1.0, 0.0, 0.0, 0.0, cos(a), -sin(a), 0.0, sin(a), cos(a));
        }

        void main() {
          vColor = aColor;

          /*
           * 边缘淡出：越靠近封面方块的边界越透明。
           *
           * 这是为了修"白底封面看着不舒服"。之前封面是一片边缘齐整的亮点阵，
           * 在深色背景上像**贴上去的一块板**，边界又硬又亮 —— 不刺眼但别扭。
           * 让边缘化开之后，封面像是从背景里浮出来的，而不是盖上去的。
           *
           * position.xy 是成形后的目标位置，范围 ±DISC_R，所以归一化之后
           * 到边界就是 1。用 max 取"最接近哪条边"，再往外淡。
           */
          float edge = max(abs(position.x), abs(position.y)) / uCoverRadius;
          /*
           * 边缘渐隐。原来只在最外圈 28%（0.72→1.0）淡出，范围太窄 ——
           * 截图里封面的**右边是一条硬切的直线**，看着像图被裁掉了一块。
           * 放宽到从 0.42 就开始渐隐，边界就变成一层暗角，
           * 封面像是"化开"在背景里，而不是贴了一块方板。
           */
          float edgeFade = 1.0 - smoothstep(0.62, 1.0, edge);

          /*
           * ============ 封面上的涟漪 ============
           *
           * 借鉴 Mineradio 的思路：鼓点在封面上**随机位置**激起几圈水波，
           * 波在封面平面内向外传播。
           *
           * 这比"整块封面一起缩放"高级得多 —— 全局缩放看久了像在喘气，
           * 而涟漪是有位置、会跑的，像鼓点真的砸在了这张图上。
           *
           * 每个涟漪在 uRipples 里占 4 个数：(x, y, 已存活秒数, 强度)。
           * 我们按"波前半径 = 存活秒数 × 速度"算出一圈很窄的环，
           * 环到哪儿就把哪儿的粒子往前顶 + 加亮。
           */
          float rippleZ = 0.0;
          float rippleGlow = 0.0;
          for (int i = 0; i < 5; i++) {
            if (i >= uRippleCount) break;
            float rx = uRipples[i * 4 + 0];
            float ry = uRipples[i * 4 + 1];
            float rage = uRipples[i * 4 + 2];
            float rstr = uRipples[i * 4 + 3];

            float d = distance(position.xy, vec2(rx, ry));
            // 波前半径随存活时间扩张
            float front = rage * 2.6;
            // 窄环：只有波前附近的粒子被抬起
            float ring = exp(-pow((d - front) / 0.42, 2.0));
            // 越走越弱、越走越淡（能量扩散）
            float decay = max(0.0, 1.0 - rage * 0.75);
            rippleZ += ring * decay * rstr * 1.5;
            rippleGlow += ring * decay * rstr;
          }

          // 逐粒延迟：uForm 从 0 到 1 的过程中，各粒子先后归位
          float f = clamp((uForm - aDelay * 0.35) / 0.65, 0.0, 1.0);
          f = f * f * (3.0 - 2.0 * f); // 平滑一下

          vec3 pos = mix(aScatter, position, f);

          /*
           * 涟漪的立体位移：成形之后才生效（乘以 f），
           * 否则散开状态下封面还没成形状，会显得莫名其妙。
           */
          // 涟漪位移也去掉：封面不许动（涟漪是鼓点激发的）

          /*
           * 浮雕位移：亮部往前顶（+z）、暗部往后沉（-z）。
           * 乘 f 是因为散开状态下还没成形，那时加位移会很怪。
           * 这一步把封面从"一块平面点阵"变成"有起伏的立体光雕" ——
           * 是我看 Mineradio 的深度浮雕才意识到自己一直缺的东西。
           */
          pos.z += (aDepth - 0.5) * uCoverDepth * f;

          // 未成形时在背景里缓慢漂浮，和背景粒子混在一起
          float drift = (1.0 - f);
          pos.x += sin(uTime * 0.28 + aPhase) * 1.4 * drift;
          pos.y += cos(uTime * 0.24 + aPhase * 1.3) * 1.4 * drift;
          pos.z += sin(uTime * 0.2 + aPhase * 0.8) * 1.2 * drift;

          // 成形后：整体悬在空间里，缓慢摆动 + 跟着指针倾斜。
          // 关键是要让它有"立体感"，否则就是贴在屏幕上的一张平面。
        /*
         * ★ 指针**不参与整体漂移**。
         *
         * 原来这两项是 uPointer * 0.45 / 0.32。uPointer 从归一化
         * （±1）改成世界坐标（±6.8）之后，同一个系数算出来是
         * **3.06 世界单位 —— 屏幕高度的 70%**：鼠标一划整片粒子就飞出去。
         * 用户的原话："我滑动鼠标就跟着动，我不要"。
         *
         * 所以这里只留时间项（自然摆动）。指针只负责"推开粒子"那个洞，
         * 不参与整体位移 —— 缩放单位时最容易漏的就是这种"另一个消费方"。
         */
        float swayY = sin(uTime * 0.23) * 0.30;
        float swayX = cos(uTime * 0.18) * 0.15;
        pos = rotY(swayY * f) * rotX(swayX * f) * pos;
          {
            /*
             * ★ 粒子**前后跳动**（沿 Z）、随机固定、有起伏。
             *
             * 用户原话："我现在面对的是正面，然后播放粒子是前后跳动，
             * 随机固定跳动，有起伏的那种"。逐条对应：
             *
             *   · **前后** —— 沿 Z 朝镜头/背离镜头。不是上下弹、不是往外炸，
             *     也不是整块板前冲（那几版我都做过，全是错的）
             *   · **随机固定** —— 每颗粒子的相位与幅度由它自己的 aPhase
             *     固定决定，**不随时间重随机**，所以每颗的节奏是稳定的；
             *     同时 xy 完全不动，颗粒牢牢待在自己的位置上
             *   · **有起伏** —— 相位彼此错开，整片网点呈现一波一波的起伏，
             *     而不是整块平面一起前后平移
             *
             * 两项相加：
             *   sin(...)              各自的节奏（随机、固定）
             *   fract(bph*0.618)-0.5  各自的静态前后偏置 —— 有了它，
             *                         这一片网点才不是一块平板，而是有厚薄
             *
             * 由 uPulse 驱动：暂停归零，所有网点回到同一平面、彻底静止。
             */
            float bph = aPhase;

            /*
             * ★★★ 逐粒的节拍脉冲 —— 不是整片共用一个包络。
             *
             * 用户的原话："我是说你做的是像呼吸再跳动不是他"。
             * 一针见血：我原来乘的是 uPulse，而它是一个**慢起慢落的整体包络**
             * （起振约 45ms、之后缓慢衰减）—— 所有粒子一起涨、一起落，
             * 观感就是**深呼吸**，而不是粒子在跳。
             *
             * Mineradio 那种是**一颗一颗弹**：每颗粒子有自己的触发时刻、
             * 有自己的快落，所以是清脆、有先后的跳动，有层次。
             *
             * 用 uBeatAge（距上次鼓点多少秒）+ 每颗粒子自己的延迟来做：
             *   · delay 由 aPhase **固定**决定 —— 谁先弹谁后弹是稳定的
             *   · 到自己的时刻之前是 0（不参与），到点起跳，然后 exp 快速回落
             *   · 衰减系数 7.0 → 约 0.4 秒走完，干脆利落，不拖成"呼吸"
             *   · depth 也是每颗不同 → 有的弹得远有的弹得近，这就是"层次感"
             */
            float delay = aRndB * 0.30;
            float age = uBeatAge - delay;
            float imp = age < 0.0 ? 0.0 : exp(-age * 3.2);
            float depth = 0.80 + 0.95 * aRndC;

            /*
             * ★★★ 每颗粒子的**阻尼振荡** —— 一颗就是一颗，不分前后两套。
             *
             * 用户："我还是感觉你又用了一层粒子（一套往前一套往后）这不是我要的"。
             *
             * 根因：之前持续态和跳动两项都乘同一个 base = (aRndA-0.5)*2，
             * 每颗粒子的正负是**固定**的 —— 正的永远在前、永远往前弹；
             * 负的永远在后、永远往后弹。位置分布连续，但"两套"的结构一直在。
             *
             * 现在改成：每颗粒子沿**自己的时间轴**做一次阻尼振荡。
             * 鼓点过后，它冲出去 → 回摆过来 → 停住。一颗粒子在一次跳动里
             * **前后都走过**，所以不存在"只往前的那一套"和"只往后的那一套"。
             *
             *   t   = uBeatAge - delay   该粒子自己的时间轴（各自延迟不同）
             *   sin(t*8)                 一个来回
             *   exp(-t*2.6)              衰减，约 1 秒停住
             *   aRndC                    各自的振幅 → 有的弹得远有的近
             *
             * 注意这里**没有 base**：位移既不按固定正负、也不按固定深度分配，
             * 完全由各自的相位与延迟决定。
             */
            float t = uBeatAge - delay;
            float osc = t < 0.0 ? 0.0 : sin(t * 8.0) * exp(-t * 2.6);
            pos.z += osc * (0.7 + 0.8 * aRndC) * uBeatAmp * 2.4 * f;

            /*
             * 去掉的两项，记下来免得又加回来：
             *
             * ① 按图像明暗的浮雕 (aDepth-0.5)*uCoverDepth*bamp*16
             *    —— 相邻网点明暗相近，会**一整块区域一起鼓**，
             *    看起来就是"整个封面在呼吸"。这是用户明确否掉的观感。
             *
             * ② xy 上的整体呼吸 pos.x += sin(uTime*0.75)*0.010
             *    —— 整张网一起平移，同样是"整体在动"。
             * 网格的等间距是 xy 的**静态**属性，不需要靠这个来维持。
             */

            /*
             * ★★ 粒子**钉在网格点上，左右一动不动**。
             *
             * 我上一版在这里加了左右分散（pos.xy += 各自方向散开），那是错的。
             * 用户把机制说全了：
             *   "他的粒子就是固定在网格点上的，然后播放起来
             *     向前后分别跳动有层次感"
             *
             *   · 固定在网格点 —— xy 一颗都不许离开自己的格子
             *   · 向前后分别跳 —— 只有 Z 在动
             *   · 分别 + 层次感 —— 每颗各自的幅度与节奏不同，
             *     于是有的在前有的在后，形成一层一层的纵深
             * 所以整段删掉了，位移全部交给下面的 Z 项。
             */

            /*
             * 每颗网点各自的前后跳动（随机但固定），这是"层次感"的来源。
             * sin 项给出各自的节奏，(fract-0.5) 项给出各自的静态前后偏置 ——
             * 没有后者，整片就是一块平板在前后平移，出不来层次。
             */
          }

          /*
           * xy 上的整体"呼吸"已删除。
           * 它让整张网一起平移，观感是"整个封面在动"（用户："像整个封面在呼吸"）。
           * 网格的等间距靠**静态坐标**保证（target 用理想格子位置算），
           * 不需要靠这层呼吸来维持 —— 我上一轮为了"网格不齐"把它做成全局同相位，
           * 属于过度修正：那是 xy 的静态属性，和"Z 方向各跳各的"并不冲突。
           */

          // 指针推开
        vec2 d = pos.xy - uPointer;   // 指针已是世界坐标，不再乘系数
          float infl = smoothstep(3.4, 0.0, length(d)) * uPointerStrength * f;
          pos.xy += normalize(d + vec2(1e-5)) * infl * 0.5;

          /*
           * 节拍的表达方式改了：**从"整块缩放"改成"局部涟漪"**。
           *
           * 原来这里是 pos.xy *= 1 + uPulse*uBeatAmp*0.16 ——
           * 整块封面一起胀缩。那种做法看久了像在喘气，而且因为整块都在动，
           * 反而看不出鼓点"砸在哪儿"。现在鼓点由上面的涟漪负责，
           * 这里的全局项压到几乎只剩一点点呼吸（0.02），
           * 真正的节拍感交给那几圈会跑的水波。
           */
          /*
           * ★ 跳动要落在**每一颗粒子**身上，不是整块封面缩放。
           *
           * 我上一版写的是 pos.xy *= 1.0 + k —— 那让整张图一起涨缩，
           * 观感是"封面在呼吸"，不是"粒子在跳"。这个区别用户一眼就看出来了。
           *
           * 现在改成逐粒位移：
           *   · 每颗粒子沿**自己**的方向顶出去（aPhase 决定方向）
           *   · 强度也随相位各不相同 —— 有的跳得多、有的跳得少
           *   · z 方向再各自抖一下，泛光下就是"炸开又收回"
           * 整片网点于是是"沙沙地跳"，而不是一块板在缩放。
           *
           * 幅度标定：系数 0.34 时每颗粒子位移约 3~10 像素（按实测
           * uPulse 0.6 / uBeatAmp 0.48 算）。我第一版取了 0.62（5.7~19px），
           * 跳是跳了，但把网点结构冲散了 —— 半调会散成一团糊。
           * 这个值就是"跳得动"和"图像不散"之间的平衡点，要调就调它。
           */
          float ph = aPhase;
          vec2 pdir = vec2(cos(ph), sin(ph));
          float pvary = 0.35 + 0.85 * fract(ph * 0.3183);

          vec4 mv = modelViewMatrix * vec4(pos, 1.0);
          gl_Position = projectionMatrix * mv;
          /*
           * 尺寸：半调 —— **点径就是图像的载体**。
           *
           * 上一版我把 aStar 那一项删掉、写成恒定尺寸，理由是"点径不该承载图像"。
           * 那个判断是错的，真因是跨度失控 + 加色混合（见 JS 侧 sizes.push 的说明）。
           * 现在尺寸完全来自 aSize（由亮度算出），
           * 着色器里只保留**事件类**的加成（涟漪、节拍），它们不是图像数据，
           * 放大一点不会破坏网点。
           */
          gl_PointSize = aSize * uPixelRatio * (10.6 / -mv.z) * (0.5 + f * 0.8)
                         * (1.0 + rippleGlow * 0.28);

          /*
           * 亮度结构 —— 这里我连错了两版，把结论写清楚。
           *
           * ★ 屏幕上真正看到的是 **alpha × color**，两者都要对才行。
           *
           * 第 1 版：(aWeight*0.72 + aEdge*0.85) 配 aColor*(0.75 + aEdge*0.9)
           *   —— 轮廓和填充**都在加亮**，两项相加到处都是亮的，
           *   白底封面直接烧成一片白，线条和色块毫无区别 → 用户："太恶心了"。
           *
           * 第 2 版：改成"压暗填充"的对比思路（fill 0.26 / 轮廓 1.0），
           *   同时把颜色也压到 aColor*0.42。结果**两个因子同时变小**，
           *   相乘之后整块封面落到约 8/255 —— 实测点亮占比只有 0.5%，
           *   封面几乎全黑看不见。矫枉过正。
           *
           * 现在按"目标亮度"来定：
           *   填充  ≈ 0.85(aWeight基准) → alpha≈0.5，配 color≈0.9×原色
           *           中灰底色落在约 60/255、白底色约 96/255 —— 看得见但不刺眼
           *   轮廓  额外 +0.45 alpha、+0.45 颜色 → 白底轮廓可达约 245/255
           * 这样线条和填充相差两三倍，既有对比又不会两头跑偏。
           */
          float ink = aWeight * 0.95 + aEdge * 0.35;

          vAlpha = (0.12 + f * 0.88) * edgeFade * ink
                   * (0.94 + 0.06 * sin(uTime * 1.4 + aPhase * 3.0))
                   + rippleGlow * 0.5
                   + uPulse * 0.03 * f + infl * 0.4 * edgeFade;

          /*
           * 颜色。
           *
           * ★ max(..., base) 是关键：**纯黑像素的颜色是 0，alpha 再大也画不出来。**
           * 这张专辑图 85% 是黑底，不给基色的话那部分粒子全部消失，
           * 封面只剩几个浮在空处的亮点，完全认不出是什么 —— 截图对照才看出来。
           * 加一个深灰基色之后，暗部形成一层"底"，亮点才有依托，
           * 整张图才重新成为一个完整的方形图像。
           *
           * ★ 但**只有基色是不够的**：基色是个常数，凡是比它暗的像素
           * 全都被压成同一个灰，图像的内在结构就没了 ——
           * 实测出来就是"一块均匀的灰板"，能看见"有个封面"，
           * 但看不出封面画的是什么。
           *
           * 所以这里先对颜色做一次 **gamma 提亮**（pow 0.72），再取基色。
           * 为什么要提亮：这张图的像素几乎全挤在 0~0.35 这一小段
           * （黑底 + 暗星），线性映射之后整段都落在基色下面，全被抹平。
           * pow(0.72) 把 0.05 抬到 0.12、0.2 抬到 0.31、0.35 抬到 0.47，
           * 正好把这挤成一团的暗部拉开成能看见层次的区间。
           * 1.0 仍然是 1.0，高光不受影响。
           *
           * 半调版本里的基色要压到很低。
           * 明暗既然已经由点径表达，颜色就该尽量贴近原图；
           * 再垫一块灰底板只会把网点糊成一片灰雾。
           * 留一点点（0.10）是为了极暗处还有一丝可辨的底，
           * 不至于整块封面凭空消失。
           */
          vec3 base = vec3(0.25, 0.26, 0.31);
          vec3 lit = pow(
            clamp((aColor - vec3(uToneLo)) / max(uToneSpan, 1e-4), 0.0, 1.0),
            vec3(0.85)
          );
          vColor = max(lit * (1.05 + aEdge * 0.5 + rippleGlow * 0.6), base);

          /*
           * 把"有多亮"传给片元着色器，让它决定这颗点要不要长出一圈柔光。
           *
           * 背景粒子靠泛光后处理发光，而封面层为了修白底过曝被移出了泛光链
           * （见 _tick 里渲染那段），于是它的点变成了**平的死点** ——
           * 专辑图上那些四角星本来是闪的，画成死点就没了光彩，整张图发闷。
           *
           * 这里不把它塞回泛光链（白底会再次过曝），而是让封面层**自带柔光**：
           * 亮的点用"实心核 + 光晕"的混合，暗的点保持实心。
           * 既能闪，又完全可控、不会牵连白底。
           */
          vStar = clamp(aStar * 1.3, 0.0, 1.0) * f;
        }
      `,
      fragmentShader: ROUND_POINT_FRAGMENT,
    });

    /*
     * 封面着色器的完整性校验。
     *
     * 这里就是踩过坑的地方：注释里的一个反引号把上面那段模板字符串提前闭合，
     * 后半段被当成 JS 执行，抛 ReferenceError，**封面几何整个没建出来** ——
     * 表现是"封面不见了"，而日志里只有一句很难对应的 ReferenceError。
     * 直接检查源码本身是否完整，比事后猜可靠得多。
     */
    {
      const vs = mat.vertexShader || '';
      const fs = mat.fragmentShader || '';
      if (!vs.includes('void main(') || !vs.includes('gl_Position')) {
        console.error(`[着色器] 封面顶点着色器不完整（长度 ${vs.length}）—— 多半是模板被反引号截断`);
      }
      if (!fs.includes('void main(') || !fs.includes('gl_FragColor')) {
        console.error(`[着色器] 封面片元着色器不完整（长度 ${fs.length}）`);
      }
    }

    this.coverPoints = new THREE.Points(geo, mat);
    this.coverPoints.frustumCulled = false;
    // 1 = 画在歌词牌之后（歌词 renderOrder 0），点阵有缝，大字就从缝里透出来
    this.coverPoints.renderOrder = 1;
    this.coverPoints.userData.tintable = false; // 封面用图自己的颜色，不参与主题染色
    /*
     * 封面层放进**自己的场景**，而不是主场景。
     *
     * 这样它就能在主场景的后处理（泛光）走完之后，单独叠加到屏幕上 ——
     * 也就是**封面完全不经过泛光**。原因见 _tick 里渲染那段的说明：
     * 泛光的亮度阈值只有 0.12，白底封面无论怎么压亮度都会被满强度泛光炸开。
     */
    this.coverScene.add(this.coverPoints);

    if (this.palette) this._tintCover();
    return count;
  }

  /** 封面不参与主题换色，但亮度要跟主题走，否则在某些主题下会突兀 */
  _tintCover() {
    // 目前保持原色即可；留这个钩子是方便以后做"封面跟着主题偏色"
  }

  /**
   * 封面成形程度：0 = 完全散开融进背景，1 = 聚拢成封面
   *
   * 这里只设目标值，实际过渡在渲染循环里插值 —— 所以要的是
   * "聚拢/散开"的动画，而不是瞬间切换。
   */
  setCoverFocus(t) {
    this.coverFocusTarget = Math.max(0, Math.min(1, t));
  }

  /**
   * 封面成形时的位置偏移
   * 宽屏时往左偏，给右侧歌词面板让出构图空间；窄屏时居中。
   */
  setCoverShift(x, y = 0) {
    this.coverShift = { x, y };
    if (this.coverUniforms) this.coverUniforms.uCoverShift.value.set(x, y);
  }

  clearCover() {
    if (!this.coverPoints) return;
    this.coverScene.remove(this.coverPoints);
    this.coverPoints.geometry.dispose();
    this.coverPoints.material.dispose();
    this.coverPoints = null;
    this.coverUniforms = null;
    this.coverFocus = 0;
  }

  /* ---------------- 设置 ---------------- */

  /** 密度变了必须重建几何，因为粒子数量写在 attribute 里 */
  setDensity(d) {
    if (Math.abs(d - this.density) < 0.001) return;
    this.density = d;
    this.setEffect(this.effectKey);
  }

  /** 渲染倍率。低于 1.0 会让画布被拉伸（粒子发虚发亮），所以下限锁在 1.0。 */
  /**
   * 音频播放状态。暂停时所有效果回到初始状态。
   *
   * 为什么做成"收 uTime"而不是逐个效果去改：
   * 所有效果的动画都挂在 uTime 上，收它一处就等于全部复位，
   * 而且**以后新加的效果自动适用** —— 用户要的正是
   * "声纹星盘以及其他的或者后续新加的"。
   */
/**
   * 滚轮是否用于缩放（而不是翻页）。
   * 由 main.js 在切换视图时设置 —— 见 _onWheel 里那段说明。
   */
  setZoomEnabled(on) {
    this.zoomEnabled = Boolean(on);
  }

  setPlaying(on) {
    this.playing = Boolean(on);
  }

  setRenderScale(s) {
    /*
     * ★ 下限从 1.0 放到 0.6。
     *
     * 原来这里是 Math.max(1.0, ...)，也就是**只能往上调，不能往下调** ——
     * 于是没有任何办法真正减少 WebGL 的像素量（自动降质那条路的底也只到 0.88）。
     * 我拿 setRenderScale(0.6) 去测"像素数到底吃不吃性能"，得到"完全无差别"的结论，
     * 差点就据此断定"像素数无关"；后来才发现 0.6 被这行钳成了 1.0 ——
     * **测的根本不是我以为的那个东西**。
     *
     * 为什么需要往下调：这块屏是 165Hz，垂直同步间隔只有 6.06ms，
     * 而实测整个管线正好卡在这个边界上（一半的帧要等下一个周期）。
     * 能不能用一点清晰度换流畅度，必须是个真实可用的档位。
     */
    /*
     * ★ 语义变了：这里的 s 现在表示"**相对原生分辨率的倍率**"。
     *
     *   1.0 → 原生（dpr=1.5 的屏上就是 1.5 倍缓冲，点最脆）
     *   0.6 → 0.9 倍缓冲（省像素，但半调会糊）
     *
     * 为什么必须改语义：main.js 建好舞台后会立刻用用户设置里的 renderScale
     * 覆盖一次，而那个值默认是 1.0 —— 只要它还是"绝对倍率"，
     * 构造函数里那个 dpr 感知就永远被盖掉，半调的网点照样是糊的。
     * 我上次就是这么白改了一遍（scale 回读还是 1）。
     */
    const dpr = Math.max(1, Math.min(1.5, window.devicePixelRatio || 1));
    this.baseScale = Math.max(0.6, Math.min(1.5, (Number(s) || 1) * dpr));
    this.scale = this.baseScale;
    this._applyScale();
  }

  setAutoQuality(on) {
    this.autoQuality = Boolean(on);
  }

  /**
   * 把视口高度折算进 uPixelRatio
   *
   * 着色器里 gl_PointSize 用的是常数系数（14.0 / -mv.z），这个值**不随视口变化**。
   * 结果：窗口小的时候，同样世界空间里粒子占的像素数不变，但可见范围变小，
   * 于是粒子相对变大、重叠变多 → 整个画面变亮；切成全屏又恢复正常。
   *
   * 这里按视口高度等比缩放，让粒子的**相对大小**恒定 —— 窗口大小只影响清晰度，
   * 不影响观感和亮度。800 是设计基准高度。
   */
  _updatePointScale(h) {
    this.uniforms.uPixelRatio.value = this.scale * (h / 800);
  }

  _applyScale() {
    const w = this._cssWidth();
    const h = this._cssHeight();

    this.renderer.setPixelRatio(this.scale);
    this.renderer.setSize(w, h, false);
    this._updatePointScale(h);

    // 后处理的中间缓冲也要跟着缩放，否则「渲染分辨率」这个设置对泛光不生效
    if (this.composer) {
      this.composer.setPixelRatio(this.scale);
      this.composer.setSize(w, h);
    }
    this._logSize('applyScale');
  }

  /**
   * canvas 的 CSS 显示尺寸
   *
   * 必须用 canvas 自己的盒子，而不是 window.innerWidth/innerHeight ——
   * 窗口化启动时两者在布局稳定前可能不一致，一旦缓冲区比显示尺寸小，
   * canvas 就会被浏览器放大，粒子变大变亮（切全屏才因为 resize 归位）。
   */
  _cssWidth() {
    return Math.max(1, Math.round(this.canvas.clientWidth || window.innerWidth));
  }

  _cssHeight() {
    return Math.max(1, Math.round(this.canvas.clientHeight || window.innerHeight));
  }

  /** 泛光开关与参数。强度 0 等同关闭。 */
  setBloom(enabled, strength, threshold) {
    this.bloomEnabled = enabled !== false && (strength === undefined || strength > 0.01);
    const p = this.bloomPass;
    if (!p) return;

    /*
     * 两种泛光实现的参数接口不一样，这里要分开处理：
     *   UnrealBloomPass —— strength / threshold 是普通属性，render() 时直接读
     *   CheapBloomPass  —— 强度存在 uniform 里（阈值也在 uniform），必须走 setter
     * 早期只写 `p.strength = v` 的时候，CheapBloomPass 的阈值根本改不动，
     * 调了滑杆没反应。
     */
    if (strength !== undefined) {
      const v = Math.max(0, Math.min(3, strength));
      if (typeof p.setStrength === 'function') p.setStrength(v);
      else p.strength = v;
    }
    if (threshold !== undefined) {
      const v = Math.max(0, Math.min(1, threshold));
      if (typeof p.setThreshold === 'function') p.setThreshold(v);
      else p.threshold = v;
    }
  }

  /* ---------------- 交互 ---------------- */

  /**
   * 节拍脉冲
   *
   * 只**累加目标值**，不直接改实际值 —— 实际值在渲染循环里平滑跟随目标，
   * 形成"起振 → 回落"的包络。原来是瞬间跳变再衰减，阶跃叠上泛光就是硬闪，
   * 密集鼓点连起来就是频闪感。
   */
  pulse(strength = 1) {
    const scaled = strength * (this.pulseIntensity ?? 0.7);
    this.pulseTarget = Math.min(0.9, (this.pulseTarget ?? 0) + scaled);
    /*
     * 记下鼓点发生的时刻。
     *
     * 渲染循环据此算出 uBeatAge（距上次鼓点多少秒），
     * 让效果能做"向外传播的行波"而不是只有整体缩放 ——
     * 详见 uniforms.uBeatAge 的说明。
     */
    this._lastBeatAt = performance.now();
    this._beatStrength = scaled;

    /*
     * 在封面上激起涟漪（借鉴 Mineradio 的思路）。
     *
     * 位置不是随机的，而是从一个 3×3 的网格里选 —— 每个格子再抖动一点。
     * 这样涟漪会落在封面的不同区域（左中右、上中下），而不是挤在一起；
     * 纯随机的话经常会连着几次都砸在相近的位置，看起来像只有一个波源。
     *
     * 每次鼓点激起 1~2 圈，力度跟这次鼓点的强度走。
     */
    if (this.coverRipples && this.coverFocus > 0.02) {
      const R = this.coverRadius || 3.5;
      const n = Math.random() < 0.55 ? 1 : 2;
      for (let k = 0; k < n; k++) {
        // 3×3 网格里随机挑一格，避免重复挑同一格
        const cell = Math.floor(Math.random() * 9);
        const cx = ((cell % 3) / 2 - 0.5) * R * 1.25;
        const cy = (Math.floor(cell / 3) / 2 - 0.5) * R * 1.25;
        this.coverRipples.push({
          x: cx + (Math.random() - 0.5) * R * 0.3,
          y: cy + (Math.random() - 0.5) * R * 0.3,
          age: 0,
          // 强度跟鼓点走，但给个下限，轻拍也要看得见
          str: 0.45 + Math.min(1, scaled) * 0.75,
        });
      }
      // 同时最多 5 圈：uniform 数组就这么大，而且太多会糊成一片
      while (this.coverRipples.length > 5) this.coverRipples.shift();
    }
  }

  /** 律动强度（0~1.5），由设置面板控制 */
  setPulseIntensity(v) {
    this.pulseIntensity = Math.max(0, Math.min(1.5, Number(v) || 0));
    if (this.uniforms.uBeatAmp) {
      this.uniforms.uBeatAmp.value = (BEAT_AMP[this.effectKey] ?? 0.6) * this.pulseIntensity;
    }
  }

  /** 背景帧率上限（0 = 不限制） */
  setMaxFps(v) {
    this.maxFps = Math.max(0, Math.min(240, Number(v) || 0));
  }

  /** 运动速度倍率 —— 所有效果的动画都由 uTime 驱动，所以一个值控全局 */
  setMotionSpeed(v) {
    this.motionSpeed = Math.max(0, Math.min(4, Number(v) || 0));
  }

  /**
   * 更新 16 段实时频谱（"声纹星盘"用）。
   *
   * 注意**就地改写**这个数组，不要每次新建：three 判断 uniform 是否要重传
   * 靠的是引用比较，每帧换个新数组会让它每帧都重传一遍。
   *
   * @param {ArrayLike<number>} bands 16 个 0~1 的强度值（低频在前）
   */
  setBands(bands) {
    const u = this.uniforms && this.uniforms.uBands;
    if (!u || !u.value) return;
    const dst = u.value;
    for (let i = 0; i < dst.length; i++) {
      const v = bands && i < bands.length ? Number(bands[i]) : 0;
      // 平滑跟随：频谱本身跳得很厉害，直接照搬会让图形抖成噪声
      dst[i] += ((Number.isFinite(v) ? v : 0) - dst[i]) * 0.35;
    }

    /*
     * 把这一列推进历史长卷。
     *
     * 纹理是 128 列宽、16 行高；第 0 列是最旧的、第 127 列是刚进来的。
     * 做法是整体左移一列（copyWithin），再把新数据写到最后一列 ——
     * 这样着色器里只要按固定坐标采样，"向左滚动"就自动发生了，
     * 不需要每帧去改任何粒子的位置。
     */
    const d = this._bandTexData;
    const W = this._bandTexW || 16;
    const H = this._bandTexH || 128;
    if (!d) return;
    // 布局是 宽=频段(16) × 高=时间(128)，索引 = band + time * W
    // 整体上移一行 = 丢掉最旧的那个时间片；一行正好是连续的 W 个字节
    d.copyWithin(0, W);
    for (let b = 0; b < W; b++) {
      d[(H - 1) * W + b] = Math.max(0, Math.min(255, Math.round(dst[b] * 255)));
    }
    const tex = this.uniforms.uBandTex.value;
    if (tex) tex.needsUpdate = true;
  }

  /**
   * 把封面层叠加到已经画好的画面上。
   *
   * 关键点：
   *   · `autoClear = false` —— 否则会把刚渲染好的背景粒子清掉
   *   · 必须在 composer.render() 之后调用（那时 OutputPass 已经把画面写到屏幕）
   *   · 只在封面确实可见时才做，避免白跑一次 draw call
   */
  _renderCoverOverlay() {
    /*
     * ★ 判据不能只看 coverPoints。
     *
     * 原来这里写的是 `if (!coverPoints.visible) return;` ——
     * 而 coverScene 里**还有两块舞台文字板**。
     * 封面网点被效果门控隐藏之后（只有「封面粒子」才显示），
     * 这一句会把整个 coverScene 一起跳过：文字板的 visible 是 true
     * （我的层清单如实报了"可见"），**但从来没被画出来**。
     * 用户看到的就是"歌词呢"。
     *
     * 教训：层清单报的是 visible 这个**标志位**，不是"有没有真的画"。
     * 标志位为真、渲染却被上游跳过，光看清单是查不出来的 ——
     * 必须看画面。
     */
    const anyVisible =
      (this.coverPoints && this.coverPoints.visible) ||
      (this.stageFront && this.stageFront.visible) ||
      (this.stageRear && this.stageRear.visible);
    if (!anyVisible) return;
    const r = this.renderer;
    const prev = r.autoClear;
    r.autoClear = false;
    r.render(this.coverScene, this.camera);
    r.autoClear = prev;
  }

  _onPointerMove(e) {
    // 拖动旋转中就不再做指针视差，否则两者会打架
    if (this.orbit.dragging) return;
    this.pointerTarget.x = (e.clientX / window.innerWidth) * 2 - 1;
    this.pointerTarget.y = -((e.clientY / window.innerHeight) * 2 - 1);
    this.pointerTarget.active = 1;
  }

  /* ---------------- 拖动旋转（围绕中心） ---------------- */

  /**
   * 滚轮缩放（改轨道半径）。
   *
   * 范围 4~20：太近会穿进点阵里、太远覆盖面会缩成一小块。
   * 用乘法而不是加法 —— 这样每一格滚轮的"视觉变化量"是恒定的，
   * 在近处不会一格跳很远、在远处也不会一格几乎不动。
   */
  _onWheel(e) {
    const o = this.orbit;
    if (!o) return;

    /*
     * ★ 先把滚动权让给界面。
     *
     * 这个监听挂在 window 上，如果无条件 preventDefault，设置面板、
     * 歌单列表这些自己需要滚动的区域就会被一起吃掉 ——
     * 用户原话："打开设置滚动只放大画面，设置里失效"。
     *
     * 两道判据：
     *   ① 落在界面控件上（复用拖动那套 ORBIT_UI_SELECTOR）→ 不管
     *   ② 祖先里有一个**确实能纵向滚动**的容器 → 让给它
     */
    const tgt = e.target;
    if (tgt && tgt.closest && tgt.closest(ORBIT_UI_SELECTOR)) return;
    if (tgt && tgt.closest && tgt.closest('input, textarea, select')) return;

    /*
     * ★ #main 要**单独摘出来**，不能和其它祖先一视同仁。
     *
     * 它是应用自己的滚动容器（overflow-y: auto），不是"某个需要滚动的面板"。
     * 之前这里把所有能滚的祖先都当成"让给它"，于是只要 #main 的内容比视口高
     *（比如「正在播放」页，加了标题栏那 38px 之后就超了），滚轮缩放就整个失效 ——
     * 用户反馈"正在播放里滚轮怎么失效了"就是这个。
     *
     * 现在的规则清楚得多：
     *   · #main 之外能滚的容器（设置面板、下拉列表）→ 一律让给它（保持原样）
     *   · #main 能滚 + 当前在「正在播放」页 → **归缩放**（那一页本来也没什么好滚的）
     *   · #main 能滚 + 其它页 → 归滚动
     */
    let mainScrollable = false;
    let el = tgt;
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.id === 'main') {
        mainScrollable = el.scrollHeight > el.clientHeight + 1;
        el = el.parentElement;
        continue;
      }
      let st = null;
      try {
        st = getComputedStyle(el);
      } catch {
        st = null;
      }
      if (st && (st.overflowY === 'auto' || st.overflowY === 'scroll')) {
        if (el.scrollHeight > el.clientHeight + 1) return;   // 能滚 → 让给它
      }
      el = el.parentElement;
    }
    // #main 能滚、又不在「正在播放」页 → 这一滚是"翻列表"，不是"缩放"
    if (mainScrollable && this.zoomEnabled === false) return;

    const prev = o.radius;
    const next = Math.max(4, Math.min(20, prev * (1 + e.deltaY * 0.0011)));
    if (next === prev) return;   // 到边了就把滚动权还给页面
    o.radius = next;
    e.preventDefault();
  }
  /**
   * 双击归位：平滑滑回正面，并把缩放恢复到默认。
   *
   * 直接置 0 是瞬移，会让人不知道发生了什么；所以走 returning 那条缓动
   * （自动归位关掉之后它就空着）。半径的一并归位也放在那段里。
   */
  _onDblClick(e) {
    const o = this.orbit;
    if (!o) return;
    // 落在界面控件上的双击不算（和拖动、滚轮同一套判据）
    const t2 = e.target;
    if (t2 && t2.closest && t2.closest(ORBIT_UI_SELECTOR)) return;
    o.dragging = false;
    o.lastActiveAt = performance.now();
    o.returning = true;
    if (window.__mpMark) window.__mpMark('双击归位');
  }

  _onOrbitDown(e) {
    // 只认左键
    if (e.button !== 0) return;
    /*
     * 从界面元素上按下的不算。
     * 用 closest 往上找，因为按到的往往不是按钮本身而是它里面的一层。
     * 这一步不做的话，拖动设置面板滑杆会把整个场景转走。
     */
    const t = e.target;
    if (t && t.closest && t.closest(ORBIT_UI_SELECTOR)) return;

    const o = this.orbit;
    o.dragging = true;
    o.lastX = e.clientX;
    o.lastY = e.clientY;
    o.vAz = 0;
    o.vEl = 0;
    /*
     * 拖动期间禁止选中文字。
     *
     * 不处理的话，在歌曲名、歌词、列表上按住一拖，Windows 会拉出一整片
     * 蓝色高亮选区 —— 又难看又会有"我在拖别的东西"的错觉。
     * 除了加过渡类，还要 preventDefault：光靠 CSS 在已经开始的拖拽里
     * 有时拦不住文本选择的启动。
     */
    document.body.classList.add('is-orbiting');
    e.preventDefault();
    if (this.canvas && this.canvas.style) this.canvas.style.cursor = 'grabbing';
  }

  _onOrbitMove(e) {
    const o = this.orbit;
    if (!o.dragging) return;
    const dx = e.clientX - o.lastX;
    const dy = e.clientY - o.lastY;
    o.lastX = e.clientX;
    o.lastY = e.clientY;

    /*
     * 灵敏度 0.0042 弧度/像素：横跨半个屏幕（约 600px）大约转 2.5 弧度，
     * 但会被 AZ_LIMIT 截住 —— 也就是"一次拖到底"就能到边，
     * 手感是轻快的；再慢会显得拖不动。
     *
     * ★ 两个轴的符号是**分开定**的，因为它们的"跟手"方向并不对称：
     *
     *   水平：拖右 → az 减小 → 相机往左绕 → 画面里的东西往右转 ✔ 跟手
     *   竖直：拖下 → el 增大 → 相机往上走 → 画面里的东西往下沉 ✔ 跟手
     *
     * 竖直那一轴我一开始写反了（写成"相机自己往下走"），
     * 实测用户反馈"上下反着来"。这不是数学问题 —— 两种写法在数学上都自洽，
     * 区别只在于人拿鼠标拖的时候预期"抓住的东西跟着手走"。
     * 所以这两行不要凭直觉统一符号，**要按实际手感分别定**。
     */
    const k = 0.0115;   // 提高灵敏度：整圈 2PI 约 546px 就能拖完（原来 0.0042 要拖 1500px，一次拖不到底，所以感觉'只能转一点点'）
    o.vAz = -dx * k;
    o.vEl = dy * k;
    o.az += o.vAz;
    o.el += o.vEl;
  }

  _onOrbitUp() {
    const o = this.orbit;
    if (!o.dragging) return;
    o.dragging = false;
    document.body.classList.remove('is-orbiting');
    if (this.canvas && this.canvas.style) this.canvas.style.cursor = '';
  }

  /**
   * 窗口尺寸变化
   *
   * 拖动窗口 / 切全屏会在一秒内触发几十次 resize，直接每次都重建渲染目标会卡死。
   * 所以做两件事：
   *   1. 同一帧内的多次事件合并成一次（rAF）
   *   2. 尺寸没真变就直接跳过
   *   3. composer.setSize 会重建所有渲染目标（泛光有好几级降采样纹理），
   *      最贵，所以再延后一段，等尺寸稳定了才做
   */
  _onResize() {
    if (this._resizePending) return;
    this._resizePending = true;
    requestAnimationFrame(() => {
      this._resizePending = false;
      this._doResize();
    });
  }

  _doResize() {
    if (this.disposed) return;

    const w = this._cssWidth();
    const h = this._cssHeight();
    if (w === this._lastW && h === this._lastH) return; // 尺寸没变，白做
    this._lastW = w;
    this._lastH = h;

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this._updatePointScale(h);

    clearTimeout(this._composerTimer);
    this._composerTimer = setTimeout(() => {
      if (this.disposed || !this.composer) return;
      this.composer.setSize(this._lastW, this._lastH);
    }, 150);

    this._logSize('resize');
  }

  /**
   * 诊断：把实际尺寸和倍率打出来
   *
   * 排查"绘制缓冲区比显示尺寸小 → 画布被拉伸 → 粒子变亮"这类问题时非常有用。
   * 需要时在控制台执行 __particleDebug = true 打开。
   */
  _logSize(tag) {
    if (!globalThis.__particleDebug) return;
    const dbs = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const c = this.composer;
    console.log(
      `[粒子尺寸:${tag}] css=${this.canvas.clientWidth}x${this.canvas.clientHeight} ` +
        `inner=${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio} ` +
        `scale=${this.scale.toFixed(2)} rendererDpr=${this.renderer.getPixelRatio()} ` +
        `buffer=${dbs.x}x${dbs.y}` +
        (c ? ` composer=${c._width}x${c._height}@${c._pixelRatio}` : '')
    );
  }

  /** 窗口不可见时停掉渲染循环，省电也省 GPU */
  _onVisibility() {
    this.paused = document.hidden;
    if (!this.paused) this.clock.getDelta(); // 丢弃暂停期间累积的时间差
  }

  /* ---------------- 主循环 ---------------- */

  _tick() {
    if (this.disposed) return;
    requestAnimationFrame(this._tick);

    /*
     * 这里曾有我自己加的 renderMinGap（默认 1000/60）限帧，已删除。
     *
     * 它重犯了本文件开头已经记过的错：限帧在这个项目里**省不下任何东西**
     *（实测分辨率降到 12% 帧率不变、关掉全部粒子也不变，瓶颈不在填充率），
     * 代价却是把帧率从 165 压到 55 —— 拖动、跳动全都变顿，
     * 用户报的"唱片和月蚀星环怎么变成呼吸的了"就是这个造成的。
     *
     * 要做限帧请用下面的 maxFps，且默认不开。
     */
    /*
     * ★ 量这一帧在**主线程上花了多少毫秒**。
     *
     * 为什么必须要这个数：我一直在用"帧间隔"反推性能，但帧间隔里混着
     * 三样东西 —— 主线程的 JS、GPU 的出图、以及合成器的调度。三者分不开，
     * 就只能猜。实测把粒子、封面、泛光全关掉、分辨率降到 0.6，
     * 帧间隔**一点没变**；可整个画布一隐藏，立刻从 12ms 回到 6.1ms。
     * 这说明瓶颈要么在主线程（跟画什么无关），要么在合成器。
     * 有了这个数就能一刀切开：jsMs 大 = 主线程；jsMs 很小 = 合成器。
     */
    const jsT0 = performance.now();
    const jsDone = () => {
      if (this._jsMs === undefined) {
        this._jsMs = 0;
        this._jsN = 0;
      }
      this._jsMs += performance.now() - jsT0;
      this._jsN++;
    };
    if (this.paused) return;

    /*
     * 性能基准用的开关。
     *
     * 排查"到底哪一层在吃帧"时，靠猜是没用的 —— 这几个开关让基准脚本能
     * 逐层关掉再测：关掉整个 WebGL 渲染、只关粒子、只关泛光。
     * 正常运行时全是 false，不进任何分支。
     */
    if (this.benchSkipRender) {
      // 完全不出图：这一档测的是"粒子之外的界面"能跑到多少帧
      this._trackPerf();
      jsDone();
      return;
    }

    const dt = Math.min(this.clock.getDelta(), 0.05);
    /*
     * 冻结模式（只给截图比对用）。
     *
     * 起因：想量化"泛光到底有没有在起作用"，就得把不同泛光强度下的截图逐像素比对。
     * 但粒子一直在动，每张图的粒子位置都不同，动画噪声完全盖住了泛光的差异 ——
     * 实测泛光从 0 到 2.6，整幅图的亮度统计几乎不变，分不清是"泛光没用"还是"测不准"。
     * 冻结之后所有截图是同一帧粒子，差异只可能来自泛光。
     */
    if (this.frozen) {
      this.pulseValue = 0;
      this.pulseTarget = 0;
    } else {
      /*
     * ★ 时间推进：只在播放时往前走；暂停时平滑收回 0。
     *
     * 收 0 就是"回到初始状态"：uTime = elapsed × 速度，
     * 所有效果的姿态都是 uTime 的函数，所以 elapsed 归零
     * 等于全部效果复位到 t=0 的那个样子。
     *
     * 用缓动而不是直接置 0，是为了让它"自己走回去"而不是啪一下跳变；
     * 系数 3.5 大约是 0.6 秒走完，跟暂停这个动作的节奏合得上。
     */
    /*
     * ★ 复位只给"声纹星盘那种"时间驱动的效果，**封面不做**。
     *
     * 用户："应该是声纹星盘那种类型的才用这种复位的"。
     * 封面本来就是一张静止的网点图，只有 uPulse 驱动的跳动 ——
     * 暂停时 uPulse 自己归零就够了；再把它"倒带"反而多此一举。
     */
    const wantReset = this.effectKey !== 'cover';
    if (this.playing || !wantReset) {
      this.elapsed += dt;
    } else if (this.elapsed > 1e-4) {
      this.elapsed += (0 - this.elapsed) * Math.min(1, dt * 3.5);
      if (this.elapsed < 1e-3) this.elapsed = 0;
    }
    }

    // 脉冲包络：起振快、回落稍慢，形成"跳一下再落回来"的感觉。
    // 关键区别在于**驱动的是位移而不是亮度**，所以快起快落不会刺眼。
    /*
     * 衰减必须够快，否则脉冲会一直悬在高位。
     *
     * 之前用 0.2^dt（半衰期 0.43 秒），而鼓点约每秒 5 次 —— 每次还没落下去
     * 就被下一次顶上来，脉冲恒在 0.7~0.8。结果是粒子被"恒定"推开一个位移，
     * 画面反而看起来是静止的（实测日志：pulse 一直挂在 0.7~0.8 从不回落）。
     * 现在半衰期约 0.23 秒，两次鼓点之间能落回去，才形成"跳一下再落回来"。
     */
    this.pulseTarget = (this.pulseTarget ?? 0) * Math.pow(0.05, dt);
    if (this.pulseTarget < 0.002) this.pulseTarget = 0;

    /*
     * 起振时间常数：约 14ms → 约 45ms（dt*70 → dt*22）。
     *
     * 这里我把"时刻"和"包络"搞混了，值得记下来。
     *
     * 当初为了修"跟不上节奏"，把起振调到 dt*70 —— 165Hz 下每帧推进 42%，
     * 整幅画面约 3 帧（18 毫秒）就完成一次形变。我以为"快 = 准"，
     * 但**每秒近 4 次的 18ms 突变，在人眼里就是"闪"** ——
     * 变的是位置还是亮度其实次要，关键是变化速度。
     * 所以后来一直只盯着"幅度"往下压（尺寸项 0.95→0.30→0.10）却收效不大，
     * 因为问题出在时间维度上。
     *
     * 正确的分工是：
     *   脉冲**落在拍点的时刻**要精确（那个由节拍跟踪负责，与这里无关）；
     *   而**包络**要平滑展开，约 45ms 到位 —— 这只有 3~7 帧，
     *   人眼判断"是否踩在拍上"的容差在 50ms 以上，所以时机感不受影响，
     *   但看起来是"鼓一下涨起来"而不是"啪地跳变"。
     */
    this.pulseValue += (this.pulseTarget - this.pulseValue) * Math.min(1, dt * 22);
    if (this.pulseValue < 0.002) this.pulseValue = 0;

    const U = this.uniforms;
    // 时间乘上运动速度倍率：所有效果的动画都由 uTime 驱动，
    // 所以这一个值就能整体调快调慢，不用去改每个效果的参数。
    U.uTime.value = this.elapsed * (this.motionSpeed ?? 1);
    U.uPulse.value = this.pulseValue;

    /*
     * 距上次鼓点的秒数，上限 2 秒。
     *
     * 上限是必须的：歌曲停了一会儿之后这个值会变得很大，而行波半径是
     * 按它算的（r = age × 速度），不封顶的话波前会一路飞到无穷远之外，
     * 那些效果就整片空了。封在 2 秒之后，波前最多走到画面外一点点，
     * 视觉上就是"涟漪荡出去消失了"，正好。
     */
    if (U.uBeatAge) {
      const age = this._lastBeatAt ? (performance.now() - this._lastBeatAt) / 1000 : 99;
      U.uBeatAge.value = Math.min(2, Math.max(0, age));
    }

    /*
     * 封面涟漪的推进与上传。
     *
     * 只在这里做一次：把存活时间加上 dt、丢掉已经消散的、再把剩下几个
     * 平铺进 uniform 数组。涟漪总数上限 5，所以这段是常数级开销。
     */
    if (this.coverUniforms && this.coverUniforms.uRipples) {
      const list = this.coverRipples;
      for (let i = list.length - 1; i >= 0; i--) {
        list[i].age += dt;
        // 存活超过约 1.5 秒、或者波前早跑出封面范围了，就回收
        if (list[i].age > 1.5) list.splice(i, 1);
      }
      const arr = this.coverUniforms.uRipples.value;
      for (let i = 0; i < 5; i++) {
        const r = list[i];
        arr[i * 4 + 0] = r ? r.x : 0;
        arr[i * 4 + 1] = r ? r.y : 0;
        arr[i * 4 + 2] = r ? r.age : 0;
        arr[i * 4 + 3] = r ? r.str : 0;
      }
      this.coverUniforms.uRippleCount.value = Math.min(5, list.length);
    }

    // 保险：把脉冲直接写进每个材质自己的 uniform。
    // 正常情况材质与舞台共享同一个 uniform 对象，这一句是冗余的；
    // 但"换效果后就不跳了"这类问题一旦出现就很难查，这里做一次显式同步，
    // 成本只有遍历一两个 Points 对象。
    if (this.group && this.pulseValue > 0.001) {
      this.group.traverse((o) => {
        if (o.isPoints && o.material && o.material.uniforms && o.material.uniforms.uPulse) {
          o.material.uniforms.uPulse.value = this.pulseValue;
        }
      });
    }

    /*
     * ★ 指针要换算成**世界坐标**再交给着色器。
     *
     * 各效果里写的是 `pos.xy - uPointer * K`，K 从 8 到 15 不等 ——
     * 而屏幕可见范围只有半高约 4.4、半宽约 6.8（相机半径 9、fov 52°）。
     * 乘那么大等于把那个"推开粒子的洞"扔到画面外，所以完全不跟鼠标。
     *
     * 这里按相机实际可视范围换算一次：半高 = tan(fov/2) × 距离，
     * 半宽 = 半高 × 宽高比。各效果直接用它，不再乘系数。
     */
    const halfH =
      Math.tan((((this.camera.fov || 52) * Math.PI) / 180) / 2) *
      Math.abs(this.orbit.radius || 9);
    const halfW = halfH * (this.camera.aspect || 1.6);
    const p = U.uPointer.value;
    const tx = this.pointerTarget.x * halfW;
    const ty = this.pointerTarget.y * halfH;
    p.x += (tx - p.x) * Math.min(1, dt * 5);
    p.y += (ty - p.y) * Math.min(1, dt * 5);
    U.uPointerStrength.value += (this.pointerTarget.active - U.uPointerStrength.value) * Math.min(1, dt * 6);

    /*
     * ★ 黑洞**跟手**：整体朝指针方向偏移一点。
     *
     * 用户的要求很明确：「是小黑洞跟手，别的改回原来的」。
     * 所以只有黑洞这一个效果做位移，其余效果的指针交互只保留
     * "推开粒子"那个洞，不做整体漂移。
     *
     * 偏移加在 **group.position** 上（而不是在着色器里加），有两个好处：
     *   · Points（盘/环/星空）和 LineSegments（时空网格）会一起走，不会分家
     *   · 顶点着色器里的阴影判据用的是 modelViewMatrix * vec4(0,0,0,1)，
     *     它天然包含 group 的位移，所以"黑洞在黑处"这条自动仍然成立 ——
     *     不用去改那段判据
     *
     * 系数 0.13：指针最大约 6.8 世界单位，所以最多偏移约 0.9 ——
     * 明显看得出来在跟手，又不会把黑洞拽出画面中心区域。
     */
    if (this.group) {
      const k = this.effectKey === 'blackhole' ? 0.13 : 0;
      const gp = this.group.position;
      const ease = Math.min(1, dt * 4);
      gp.x += (U.uPointer.value.x * k - gp.x) * ease;
      gp.y += (U.uPointer.value.y * k - gp.y) * ease;
    }
    this.pointerTarget.active *= Math.pow(0.45, dt);

    // 封面聚拢 / 散开的过渡（不在事件里做，避免打断动画）
    if (this.coverUniforms) {
      const form = this.coverUniforms.uForm;
      const target = this.coverFocusTarget ?? 0;
      form.value += (target - form.value) * Math.min(1, dt * 2.0);
      /*
       * 可见性**只在这一处决定**，不要在两处都写。
       * 之前这段和渲染前那段都在赋值，后面那句会把这里的成形判断覆盖掉，
       * 结果"散开时不渲染"的优化失效、而且分层测试也失灵。
       */
      if (this.coverPoints) {
        /*
         * ★ 封面层只在「封面粒子」这个效果里显示。
         *
         * 用户："封面只有在封面效果才显示，别的粒子效果要么不显示要么
         * 你想个风格，放在不挡画面的"。
         *
         * 封面是铺满整屏的半透明网点平面 + 一块很宽的文字板，
         * 换成声纹星盘、粒子雨这些效果时会把它们全压住 ——
         * 等于每个效果都隔着一层纱在看。所以这里取用户给的第一个选项：
         * 只在这个效果里出现，其余效果把画面完整让出来。
         *
         * 功能都没删：切回「封面粒子」立刻回来。
         */
        const coverStageOn = this.effectKey === 'cover';
        this.coverPoints.visible =
          coverStageOn && form.value > 0.012 && !this.benchHideCover;
        /*
         * 舞台文字**不跟着封面一起收**。
         *
         * 我上一版把它们绑在一起（理由是"文字是封面构图的一部分"），做过头了 ——
         * 用户："封面虽然不见了，但是别把歌词去掉啊"。
         * 现在**只有封面网点**受效果门控；歌词/歌名在任何效果下都显示。
         * 文字的可见性由 setStageText 自己管（没有文字时它会置 false）。
         */
        /*
         * 早先这里还有一段"封面立起来就收掉背景效果"的逻辑，现在删掉了。
         * 原因：现在封面层**只在「封面粒子」效果里显示**（见上面的门控），
         * 而这个效果本身不建任何背景粒子（effects.js 里返回空组），
         * 所以"要不要收掉背景"这个问题已经不存在了 ——
         * 留着只会让人以为背景层会被谁动态关掉。
         *
         * 背景粒子层（this.group）的可见性只在渲染前那一处决定。
         */
      }
    }

    /*
     * ============ 相机：围绕中心的轨道 ============
     *
     * 这是学 Mineradio 得到的最后一个、也是最关键的一块：
     * **左键按住拖动就能绕着中心转着看。**
     *
     * 为什么它重要：在这之前我做的所有效果都是"正对镜头的一块平板"，
     * 所以怎么调都像贴图 —— 因为用户根本没法从别的角度去看它，
     * 也就没有"这是一个东西"的感知。能转着看之后，同样的粒子立刻变成
     * 一个**在空间里的物体**，空间感是从这里来的，不是靠加特效。
     *
     * 两层控制叠在一起：
     *   · 轨道角（拖动改变）—— 大范围、带惯性
     *   · 指针视差（鼠标位置）—— 很小的一点偏移，让画面"活"着
     * 幅度做了限制（方位 ±55°、俯仰 ±32°）：因为背景效果是正面构图的
     * 圆盘/平面，转太多会变成侧对镜头的一条线，反而难看。
     */
    const o = this.orbit;
    const nowMs2 = performance.now();
    if (o.dragging) {
      // 正在拖：记录活跃时刻，并取消正在进行的回正
      o.lastActiveAt = nowMs2;
      o.returning = false;
    } else if (o.returning) {
      /*
       * 停手一会儿之后自动回到正面。
       *
       * 为什么需要：能转着看之后，用户很容易随手转到某个侧角就不管了，
       * 而侧角下背景效果（正面构图的圆盘/平面）会变成侧对镜头的一条线，
       * 画面看起来像坏了。自动回正让"转着看"变成一个可以放心乱玩的动作 ——
       * 反正它会自己回到最好的角度。
       */
      o.vAz = 0;
      o.vEl = 0;
      const t = Math.min(1, dt * ORBIT_RETURN_SPEED);
      o.az += (0 - o.az) * t;
      o.el += (0 - o.el) * t;
      // 缩放也跟着回家（"归位"应该包含远近）
      o.radius += (ORBIT_HOME_RADIUS - o.radius) * t;
      // 足够接近就直接归零，避免无限逼近
      if (Math.abs(o.az) < 0.002 && Math.abs(o.el) < 0.002) {
        o.az = 0;
        o.el = 0;
        o.returning = false;
      }
    } else {
      // 松手后带惯性继续转一会儿，然后停住（比"啪"地停住自然得多）
      o.az += o.vAz;
      o.el += o.vEl;
      o.vAz *= 0.93;
      o.vEl *= 0.93;
      if (Math.abs(o.vAz) < 1e-4) o.vAz = 0;
      if (Math.abs(o.vEl) < 1e-4) o.vEl = 0;

      // 停手够久就启动回正（惯性停下来之后才开始计时，不然刚松手就回正了）
      if (
        o.vAz === 0 &&
        o.vEl === 0 &&
        nowMs2 - o.lastActiveAt > ORBIT_RETURN_DELAY_MS
      ) {
        o.returning = true;
      }
    }
    o.az = Math.max(-AZ_LIMIT, Math.min(AZ_LIMIT, o.az));
    o.el = Math.max(-EL_LIMIT, Math.min(EL_LIMIT, o.el));

    const az = o.az + p.x * 0.055;
    const el = Math.max(-EL_LIMIT, Math.min(EL_LIMIT, o.el - p.y * 0.035));
    const ce = Math.cos(el);
    this.camera.position.set(
      Math.sin(az) * ce * o.radius,
      Math.sin(el) * o.radius,
      Math.cos(az) * ce * o.radius
    );
    this.camera.lookAt(0, 0, 0);

    /*
     * 把两块文字板**钉在封面平面**上（跟着封面走，不是 billboard）。
     *
     * 我第一版做成"沿视线方向摆、朝向复制相机"的公告板 —— 那错了：
     * 那样从任何角度看文字都是正的，而实际要的是**只有正反面看得见**，
     * 转到侧面就没（侧对镜头成一条线）。
     * 所以位置只需要跟着封面的位移走，朝向永远是固定的（+Z / -Z 两块）。
     */
    if (this.stageFront && this.stageFront.visible) {
      const sx = this.coverShift?.x ?? -0.35;
      const sy = this.coverShift?.y ?? 0;
      this.stageFront.position.set(sx, sy, -this.stageBack);
      this.stageRear.position.set(sx, sy, -this.stageBack);
    }

    /*
     * 帧率上限（默认不限帧，见构造函数里的说明）
     *
     * 必须先量出刷新间隔，再按"刷新率的整数分频"来限帧 —— 只能整周期地跳帧，
     * 所以可用的帧率就是 刷新率/1、/2、/3……
     * 拿"距上次渲染的毫秒数"去比阈值是错的：那会随刷新率错位量化，
     * 在 165Hz 屏上把 60 帧变成 55 帧、在 144Hz 上变成 48 帧。
     */
    const nowMs = performance.now();

    // 用 rAF 间隔的**低分位**估计刷新间隔（首帧先跳过）
    if (this._lastTickMs !== undefined) {
      const d = nowMs - this._lastTickMs;
      // 只采信正常区间，忽略被挂起/切换窗口造成的异常间隔
      if (d > 1 && d < 100) {
        this._tickSamples.push(d);
        if (this._tickSamples.length > 31) this._tickSamples.shift();
        if (this._tickSamples.length >= 7) {
          /*
           * ★ 必须取**低分位**，不能取中位数。
           *
           * 这是限帧失效的真正原因：中位数反映的是"应用实际跑多快"，
           * 而不出图的那些帧会把它抬得很高。应用慢的时候中位数是 12ms，
           * 于是 1000/82/12 = 1.02 → skip 取整成 1 → **限帧变成空操作**；
           * 更糟的是自适应降级也读同一个值，于是永远认为"屏幕只有 60Hz"。
           *
           * 垂直同步间隔是"最快的那些帧"的间隔，所以要往下取。
           * 不能直接取最小值：实测噪声里混着 1.6ms 的假样本（计时抖动）。
           * 取 20 分位既贴近真实周期，又不会被个别假样本带偏 ——
           * 实测这台机器上稳定落在 5.8~6.1ms，正是 165Hz 的 6.06ms。
           */
          const sorted = [...this._tickSamples].sort((a, b) => a - b);
          this._refreshMs = sorted[Math.floor(sorted.length * 0.2)];
        }
      }
    }
    this._lastTickMs = nowMs;

    if (this.maxFps > 0) {
      /*
       * 目标间隔 → 需要跳过几个刷新周期，四舍五入到最接近的整数。
       *
       * _refreshMs 是从 rAF 间隔的滚动中位数估出来的，理论上第一帧之后就有值，
       * 但这里还是要兜一下底：万一它还是 undefined，`1000/maxFps/undefined` 是 NaN，
       * 而 `n % NaN` 永远不等于 0 —— 于是每一帧都被 return 掉，**整个画面直接不出图**。
       * 这种"一设限帧就黑屏"的故障极难从现象反推，不如现在就挡住。
       */
      const refMs = this._refreshMs > 0.5 ? this._refreshMs : 1000 / 60;
      const skip = Math.max(1, Math.round(1000 / this.maxFps / refMs));
      this._tickCount = (this._tickCount || 0) + 1;
      if (this._tickCount % skip !== 0) {
        // 被跳过的帧也要计入耗时统计，否则 jsMs 只反映"真正出图的那几帧"
        jsDone();
        return;
      }
    }
    this._lastRender = nowMs;

    /*
     * ★ 背景粒子层（this.group）的可见性**不在这里赋值**。
     *
     * 它现在由上面的"封面成形过渡"统一决定：封面立起来之后要收掉频谱，
     * 免得放射针压在半调网点和文字上。
     * 我第一版就是在这里又写了一次，结果**把上面的判断整个覆盖掉** ——
     * 频谱照样显示，而日志和回读都会说"已经隐藏了"。
     * 这正是这个项目里反复出现的那类 bug：可见性在两个地方写，
     * 后一处静默覆盖前一处。所以这里留一条注释，不再放代码。
     */
    // 粒子层的可见性在这里统一决定（只此一处）
    if (this.group) this.group.visible = !this.benchHideParticles;
    /*
     * 封面层的可见性在**上面的成形过渡里**统一决定（成形进度 + benchHideCover），
     * 这里不再重复赋值 —— 两处都写的话后一处会覆盖前一处，
     * 之前就是这么把"散开时不渲染"和分层测试一起弄坏的。
     */

    /*
     * 渲染。封面层**永远在主画面之后单独叠加**，所以它完全不经过泛光。
     *
     * 这是"白底封面过曝"的最终解法。之前试过只压低封面亮度，
     * 但泛光的亮度阈值只有 0.12，白底即使压到 0.74 也仍然远超阈值、
     * 被满强度泛光（smoothstep(0.12,0.47,0.74) = 1.0）炸开；
     * 要继续靠压亮度解决就得压到 0.35 以下，封面会发灰发闷，不成样子。
     *
     * 根子在于：**封面是一张图片，本来就不该被"发光"处理**。
     * 泛光是给背景粒子那类发光点云用的，用在图片上只会毁掉它。
     * 把它移出后处理链之后，图像保真、不过曝，
     * 顺带还省掉了它那一份泛光的绘制开销。
     */
    if (this.bloomEnabled && !this.benchSkipBloom) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    this._renderCoverOverlay();

    this._trackPerf();
    jsDone();
  }

  /**
   * 帧率统计 + 自适应降级
   *
   * 必须用**真实墙钟时间**来算，不能用渲染循环里的 dt。
   * dt 是两次 rAF 之间的间隔，而限帧逻辑会 `return` 掉多余的帧 ——
   * 被丢掉的那一帧的 dt 同时也被丢掉了，于是累加出来的时间只有真实时间的一半，
   * 60 帧就被报成 120 帧。之前日志里那些 125 FPS 就是这么来的，
   * 更糟的是自适应降级看到假的高帧率，永远不会降档。
   */
  _trackPerf() {
    const now = performance.now();

    /*
     * ★ 帧间隔分布 —— 这才是"掉帧"的度量，不是平均帧率。
     *
     * 之前这里只统计"每 500ms 里画了多少帧"，也就是平均值。
     * **平均值看不见卡顿**：60 帧里插进一次 120ms 的停顿，平均值只是从
     * 16.7ms 变成 18.7ms，看上去一切正常，但人眼看到的是明显一顿。
     * 用户说"还是会掉帧"，症状是**卡**，而我一直拿平均值在回答他 ——
     * 答非所问。所以现在改成逐帧记录间隔，报 p50/p95/p99 和长帧计数。
     */
    if (this._lastFrameAt !== undefined) {
      const gap = now - this._lastFrameAt;
      // 忽略标签页切回来那种几秒级的间隔，那不是渲染卡顿
      if (gap > 0 && gap < 1000) {
        if (!this._gapRing) {
          this._gapRing = new Float32Array(1024);
          this._gapCount = 0;
          this._gapHead = 0;
        }
        this._gapRing[this._gapHead] = gap;
        this._gapHead = (this._gapHead + 1) % this._gapRing.length;
        if (this._gapCount < this._gapRing.length) this._gapCount++;

        // 单帧超过 50ms 就是一次能被看出来的卡顿，单独记下来备查
        if (gap > 50) {
          if (!this._jankLog) this._jankLog = [];
          this._jankLog.push({ t: Math.round(now), ms: +gap.toFixed(1) });
          if (this._jankLog.length > 24) this._jankLog.shift();
          if (this.jank) this.jank.worst = this._jankLog.slice(-6);
        }
      }
    }
    this._lastFrameAt = now;

    if (this._perfT0 === undefined) {
      this._perfT0 = now;
      this._perfFrames = 0;
      return;
    }
    this._perfFrames++;

    const elapsed = now - this._perfT0;
    if (elapsed < 500) return;

    this.fps = Math.round((this._perfFrames * 1000) / elapsed);
    this._perfT0 = now;
    this._perfFrames = 0;

    // 主线程每帧平均耗时（毫秒），跟帧间隔对照着看就能分清瓶颈在哪一侧
    this.jsMs = this._jsN ? +(this._jsMs / this._jsN).toFixed(2) : 0;
    this._jsMs = 0;
    this._jsN = 0;

    /*
     * 分位数：把最近的帧间隔排一次序取 p50/p95/p99。
     * 1024 个样本排一次序大约 0.1ms，每 500ms 才做一次，可以忽略。
     * p50 是"平时多顺"，p99 是"最差的时候多差" ——
     * 后者才是用户说的"卡"。
     */
    if (this._gapCount > 8) {
      const n = this._gapCount;
      const arr = new Float32Array(n);
      // 环形缓冲可能还没绕满，只取有效的那一段
      const start = this._gapCount < this._gapRing.length ? 0 : this._gapHead;
      for (let i = 0; i < n; i++) arr[i] = this._gapRing[(start + i) % this._gapRing.length];
      arr.sort();
      const at = (q) => arr[Math.min(n - 1, Math.floor(n * q))];
      let over33 = 0;
      let over50 = 0;
      for (let i = 0; i < n; i++) {
        if (arr[i] > 33.4) over33++;
        if (arr[i] > 50) over50++;
      }
      this.jank = {
        n,
        p50: +at(0.5).toFixed(1),
        p95: +at(0.95).toFixed(1),
        p99: +at(0.99).toFixed(1),
        max: +arr[n - 1].toFixed(1),
        // 每 10 秒大约多少次长帧 —— 用比例表示，和窗口长度无关
        over33,
        over50,
        worst: (this._jankLog || []).slice(-6),
      };
    }

    if (this.onStats) this.onStats(this.fps, this.scale);

    if (!this.autoQuality) return;

    // 连续 4 次采样都低于 45 帧 → 降一档分辨率
    if (this.fps < 45) {
      this._slowStreak++;
      this._fastStreak = 0;
    } else if (this.fps > 57) {
      this._fastStreak++;
      this._slowStreak = 0;
    } else {
      this._slowStreak = this._fastStreak = 0;
    }

    if (this._slowStreak >= 4 && this.scale > 0.88) {
      // 下限 0.88。再低画布拉伸就看得出来了。
      // 注意这里**只降不升**：如果能自动升回去，帧率在阈值附近时就会
      // 反复升降，而每次改倍率都会让浏览器重新拉伸画布 —— 整幅画面一跳一跳，
      // 看起来就是频闪。
      this.scale = Math.max(0.88, this.scale - 0.06);
      this._applyScale();
      this._slowStreak = 0;
    }
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this._composerTimer);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('pointermove', this._onPointerMove);
    document.removeEventListener('visibilitychange', this._onVisibility);
    window.removeEventListener('pointerdown', this._onOrbitDown);
    window.removeEventListener('pointermove', this._onOrbitMove);
    window.removeEventListener('pointerup', this._onOrbitUp);
    window.removeEventListener('pointercancel', this._onOrbitUp);
    window.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('dblclick', this._onDblClick);
    if (this._ro) this._ro.disconnect();
    if (this.group) disposeGroup(this.group);
    this.clearCover();
    if (this.composer) {
      // composer 自己持有渲染目标，要一起释放
      this.composer.renderTarget1?.dispose();
      this.composer.renderTarget2?.dispose();
      for (const pass of this.composer.passes) pass.dispose?.();
    }
    this.renderer.dispose();
  }
}

function disposeGroup(group) {
  group.traverse((o) => {
    if (o.isPoints) {
      o.geometry.dispose();
      o.material.dispose();
    }
  });
}

/** 加载图片；酷狗封面在 imge.kugou.com，必须带 crossOrigin 才能读像素 */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`封面加载失败: ${src}`));
    img.src = src;
  });
}