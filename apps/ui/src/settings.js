/**
 * 设置系统
 *
 * 设计参考了 Mineradio 的设置模型（它把「背景透明度 / 玻璃模糊 / 强调色」
 * 这些都做成了可调项，并用 preset 做整套预设），但代码和结构是本项目自己的。
 *
 * 三个职责：
 *   1. 定义设置项 schema 与默认值
 *   2. 提供若干套主题预设（几套配色 + 对应的粒子配色）
 *   3. 把设置落到 CSS 变量上，并持久化到 localStorage
 *
 * 界面只跟 CSS 变量打交道，所以换主题不需要重绘任何组件。
 */

const STORE_KEY = 'music-player.settings.v1';

/**
 * 设置版本号
 *
 * 有些默认值改过之后，旧存档里的老值会一直生效，光改默认值没用。
 * 用版本号做一次性迁移，以后每次调整默认值都递增它。
 *
 *   1 → 初版
 *   2 → 泛光强度 0.9 过曝，改 0.45
 *       渲染倍率低于 1.0 会让画布被拉伸（粒子发虚发亮），强制拉回 1.0
 *       自适应降级会让画面跳（表现为频闪），默认关闭
 *   3 → 脉冲从"驱动亮度"改为"驱动位移"（跳而不是闪），律动强度默认提到 0.7，
 *       新增音频驱动参数（频段 / 灵敏度 / 间隔 / 力度）
 *   4 → 修正 bug：beat 曾误放进 particles 里，导致顶层的 settings.beat 是空对象，
 *       频段算成 NaN、鼓点永远检测不到。这里重建完整的 beat 配置。
 *   5 → 流畅度优先：玻璃磨砂 30→10、粒子密度 1→0.7，新增性能档位
 *   6 → 节拍触发间隔 200→280 毫秒。200 太密，脉冲来不及回落就被下一次顶上来，
 *       结果是恒定位移、看起来反而不动
 */
const SETTINGS_VERSION = 19;

/* ------------------------------------------------------------------ */
/* 主题预设                                                            */
/* ------------------------------------------------------------------ */

/**
 * 每套主题包含：
 *   ui        —— 写入 CSS 变量的值（背景、文字、强调色等）
 *   particles —— 粒子的星点色与光带色，让背景和界面配色统一
 */
export const THEMES = {
  champagne: {
    name: '暗夜青金',
    hint: '近黑底 + 香槟金，最接近沉浸式播放器的观感',
    ui: {
      '--bg': '#08090B',
      '--surface': '#0E1014',
      '--surface-2': '#14171D',
      '--ink': '#E8ECEF',
      '--ink-2': '#D2D7DC',
      '--muted': '#8A9099',
      '--hair': '#1A1D22',
      '--hair-2': '#262A31',
      '--accent': '#E8C87A',
      '--accent-dim': '#9A7F42',
      '--accent-rgb': '232, 200, 122',
      '--violet': '#7C5CFF',
      '--ice': '#8FE9FF',
    },
    particles: {
      stars: [[0.95, 0.96, 1.0], [0.82, 0.88, 1.0], [1.0, 0.94, 0.82], [0.78, 0.86, 1.0]],
      ribbons: [
        [0.98, 0.82, 0.42],
        [0.55, 0.38, 1.0],
        [0.38, 0.85, 1.0],
        [1.0, 0.45, 0.72],
      ],
    },
  },

  nebula: {
    name: '深邃蓝紫',
    hint: '赛博感，和粒子、3D 视觉最搭',
    ui: {
      '--bg': '#07070F',
      '--surface': '#0D0D18',
      '--surface-2': '#141428',
      '--ink': '#EAEAF5',
      '--ink-2': '#D0D0E4',
      '--muted': '#8A8AB0',
      '--hair': '#191930',
      '--hair-2': '#26264A',
      '--accent': '#7C5CFF',
      '--accent-dim': '#5238B8',
      '--accent-rgb': '124, 92, 255',
      '--violet': '#B07CFF',
      '--ice': '#6FE0FF',
    },
    particles: {
      stars: [[0.85, 0.86, 1.0], [0.72, 0.76, 1.0], [0.95, 0.9, 1.0], [0.8, 0.9, 1.0]],
      ribbons: [
        [0.49, 0.36, 1.0],
        [0.69, 0.42, 1.0],
        [0.30, 0.62, 1.0],
        [0.95, 0.38, 0.95],
      ],
    },
  },

  abyss: {
    name: '深海青碧',
    hint: '冷调青绿，干净通透',
    ui: {
      '--bg': '#04100F',
      '--surface': '#081A18',
      '--surface-2': '#0E2624',
      '--ink': '#E2F2EF',
      '--ink-2': '#C4DED9',
      '--muted': '#7FA39D',
      '--hair': '#122926',
      '--hair-2': '#1B3A36',
      '--accent': '#34E5C0',
      '--accent-dim': '#1F8C76',
      '--accent-rgb': '52, 229, 192',
      '--violet': '#4FB8FF',
      '--ice': '#A8FFF0',
    },
    particles: {
      stars: [[0.86, 1.0, 0.97], [0.72, 0.98, 0.94], [0.9, 1.0, 1.0], [0.75, 0.9, 0.88]],
      ribbons: [
        [0.20, 0.90, 0.75],
        [0.28, 0.70, 1.0],
        [0.62, 1.0, 0.86],
        [0.15, 0.55, 0.62],
      ],
    },
  },

  mono: {
    name: '极简黑白',
    hint: '去掉所有彩色，全靠动效撑视觉',
    ui: {
      '--bg': '#000000',
      '--surface': '#0A0A0A',
      '--surface-2': '#151515',
      '--ink': '#F2F2F2',
      '--ink-2': '#D8D8D8',
      '--muted': '#8C8C8C',
      '--hair': '#1C1C1C',
      '--hair-2': '#2A2A2A',
      '--accent': '#FFFFFF',
      '--accent-dim': '#8A8A8A',
      '--accent-rgb': '255, 255, 255',
      '--violet': '#BFBFBF',
      '--ice': '#E0E0E0',
    },
    particles: {
      stars: [[1.0, 1.0, 1.0], [0.9, 0.9, 0.9], [0.8, 0.8, 0.8], [0.95, 0.95, 0.95]],
      ribbons: [
        [0.95, 0.95, 0.95],
        [0.62, 0.62, 0.62],
        [1.0, 1.0, 1.0],
        [0.45, 0.45, 0.45],
      ],
    },
  },

  sepia: {
    name: '暖褐胶片',
    hint: '老胶片质感，适合慢歌和民谣',
    ui: {
      '--bg': '#100A06',
      '--surface': '#19110B',
      '--surface-2': '#241810',
      '--ink': '#F2E6D8',
      '--ink-2': '#DAC9B6',
      '--muted': '#A28C74',
      '--hair': '#2A1D13',
      '--hair-2': '#3D2A1C',
      '--accent': '#E8A15C',
      '--accent-dim': '#96612F',
      '--accent-rgb': '232, 161, 92',
      '--violet': '#C06A4A',
      '--ice': '#F0C99A',
    },
    particles: {
      stars: [[1.0, 0.94, 0.86], [0.95, 0.85, 0.72], [1.0, 0.9, 0.8], [0.9, 0.82, 0.74]],
      ribbons: [
        [0.95, 0.68, 0.36],
        [0.80, 0.42, 0.28],
        [1.0, 0.82, 0.52],
        [0.62, 0.38, 0.30],
      ],
    },
  },
};

export const DEFAULT_SETTINGS = {
  theme: 'champagne',
  /** 覆盖主题里的强调色，空串表示用主题自带的 */
  accentOverride: '',

  /** 当前性能档位（见 PERF_PROFILES），手动改过细项后会变成 'custom' */
  perfProfile: 'balanced',

  /** 粒子效果形态（见 effects.js 的 EFFECT_LIST） */
  /* 默认效果改成「封面粒子」—— 它现在是效果列表里的一个独立选项 */
    effect: 'cover',

  /*
   * 音频驱动的主题色：从当前歌曲封面里取主色，当作强调色用。
   *
   * 分成两项：
   *   coverAccent      用户开关
   *   coverAccentColor 当前取到的颜色（十六进制小写）。它是**算出来的**，
   *                    不是用户设的 —— 存下来只是为了刷新后不必等封面加载
   *                    才能对上色，下次换歌会自动覆盖。
   */
  coverAccent: true,
  coverAccentColor: '',

  /*
   * 全局热键的**用户覆盖表**：{ 动作id: 加速键 }。
   * 只存覆盖项，缺的用代码里的默认值补 —— 于是默认值以后能改，
   * 而用户改过的那些不会被覆盖回去。
   * 值存空串表示"这条显式不绑定"。
   */
  hotkeys: {},

    /**
     * 用专辑封面当整个应用的氛围背景（换歌时交叉淡入）
     */
    albumBackground: true,

    /**
     * "正在播放"页用粒子去画封面。
     *
     * 默认开启 —— 这是这个播放器的招牌观感。
     * （中途曾试过换成"直接放真正的封面图"，用户明确否决：比粒子版更难看。
     *   原因也说得通：一张写实的图片贴在粒子氛围里，两者气质是割裂的，
     *   而粒子画的封面和背景是同一种语言，整体感更强。
     *   所以方向是**把粒子封面做好**，而不是换掉它。）
     */
    coverParticles: true,
  /** 氛围背景的强度：0 关掉，1 = 默认 */
  albumBgOpacity: 0.85,

  /** 面板玻璃的透明度：0 = 全透明（粒子完全透出），1 = 不透明 */
  glassOpacity: 0.34,
  /**
   * 玻璃磨砂模糊强度（px）
   *
   * backdrop-filter 每帧都要重新读取并模糊它背后的画面，而背后正是每帧都在变的
   * 粒子画布 —— 它确实是一项纯合成器开销。
   *
   * 但**代价取决于实际在跑哪块 GPU**：之前在核显上实测它极贵（一度以为是头号开销），
   * 换到独显（RTX 5060）后实测**完全免费** —— 开 14px 磨砂帧率就是满刷新率 165，
   * 再叠上粒子密度 1.0 也还有 154。
   *
   * 所以这里恢复默认开启。它是不是负担，取决于显卡，不取决于这一行代码。
   * 详见 apps/desktop/main.js 里 force_high_performance_gpu 的说明。
   */
  glassBlur: 10,
  /** 文字后面的压暗程度：0 = 不压暗，1 = 默认，1.6 = 更暗更好读 */
  scrim: 1,

  /**
   * 音频驱动的节拍检测参数
   *
   * 对应 Mineradio 设置里的「Kick 灵敏 / 频段起点 / 频段终点 / 触发力度」——
   * 把"节拍是怎么被感知的"开放出来，才能按不同曲风调。
   *
   * 注意：这个对象在**顶层**，不在 particles 里面。
   * （早先误放进 particles 里，导致 settings.beat 恒为 undefined，
   *   节拍检测的频段算成 NaN，鼓点永远检测不到。）
   */
  beat: {
    /** 鼓点灵敏度：越高越容易触发 */
    sensitivity: 0.5,
    /** 分析频段的起点（FFT bin 序号，0 ≈ 20Hz） */
    bandLow: 0,
    /**
     * 分析频段的终点
     * fftSize=1024 时每个 bin 约 43Hz，12 ≈ 520Hz —— 正好覆盖底鼓和贝斯
     */
    bandHigh: 12,
    /**
     * 两次触发的最小间隔（毫秒）—— **只在"还没估出速度"时兜底用**
     *
     * 注意它现在不是节奏的来源了。节奏由"速度估计 + 拍点锁定"负责：
     * 程序对通量做自相关，估出这首歌的拍周期，然后**按预测的拍点主动起搏**，
     * 再用检测到的鼓点校正相位。这样换任何速度的歌都自动适配，
     * 不需要为某首歌调参数。
     *
     * 这个值只在前奏/间奏等"听不出周期"的段落兜底，防止噪声乱触发。
     * 200ms 对应 300 BPM，已经足够宽松，不会限制任何正常歌曲的主拍。
     *
     * （踩过的坑：一度把它当成节奏来源，按测试歌曲的 142 BPM 硬调成 380ms ——
     *   那是"只对一首歌有效"，换歌就错。参数不该承担算法的职责。）
     */
    minInterval: 200,
    /** 触发力度：每次鼓点注入多少脉冲 */
    gain: 1,
  },

  particles: {
    enabled: true,
    /**
     * 整体密度倍率
     *
     * 默认 0.7 而不是 1：粒子是带大光晕的软边精灵，用加色混合绘制，
     * 填充率（overdraw）是最大的性能瓶颈 —— 数量直接决定像素写入量。
     * 0.7 相比 1.0 少约 30% 的粒子，观感差别不大但帧率明显更稳。
     */
    density: 1,
    /**
     * 渲染倍率
     *
     * 只允许 >= 1.0。低于 1.0 时绘制缓冲区会小于 CSS 显示尺寸，
     * 画布被浏览器拉伸 → 粒子变大变糊、加色混合下重叠更多 → 整个画面变亮。
     * 这不是"画质换性能"那么单纯，它会改变观感，所以干脆不给低于 1 的档位。
     * 掉帧由自适应在 0.86~1.0 之间微调，幅度很小、看不出来。
     */
    renderScale: 1,
    /**
     * 掉帧时自动降渲染倍率
     *
     * 默认**关闭**：每次改倍率都会让浏览器重新拉伸画布，整幅画面跳一下。
     * 开关本身留着，但默认不开，避免出现"画面自己一闪一闪"的观感。
     */
    autoQuality: false,
    /** 泛光后处理：粒子的"发光感"来源。开启会明显吃显卡 */
    bloom: true,
    /**
     * 泛光强度 0~3
     *
     * 这个值跟着泛光实现走，别混用：
     *   bloomMode='unreal' —— 0.45 左右比较克制（原来的观感就是这个）
     *   bloomMode='cheap'  —— 同数字下明显更暗，要 0.9 才相当于上面的 0.45，
     *                         因为 UnrealBloomPass 把 5 级降采样的结果叠在一起了
     */
    bloomStrength: 0.45,
    /** 泛光亮度阈值 0~1。越高只有越亮的粒子才发光 */
    bloomThreshold: 0.12,

    /**
     * 泛光实现：'unreal' = three 自带的 UnrealBloomPass，'cheap' = 自写的两级金字塔
     *
     * 为什么默认用回 UnrealBloomPass：
     *   我一度把它换成自写的廉价版，理由只有一个 —— 在**核显**上省性能。
     *   后来发现这台机器其实是双显卡，Chromium 一直把应用挂在核显上跑，
     *   独显（RTX 5060）全程闲着；加上 force_high_performance_gpu 之后，
     *   UnrealBloomPass 这点开销在独显上根本不值一提。
     *   也就是说换掉它的理由从一开始就不成立，而它的多尺度光晕观感明显更"润"。
     *
     * 所以默认用回原版（观感就是这个），'cheap' 保留给核显 / 省电场景。
     */
    bloomMode: 'unreal',

    /**
     * 律动强度：节拍对粒子的影响程度
     *
     * 脉冲驱动的是**位移和尺寸**（径向鼓出 + 点变大），不是亮度。
     *
     * 默认 0.8：0.7 时跳动偏弱几乎看不出来；1.0 又配着偏大的位移系数，
     * 峰值把粒子推出了环结构之外，看起来像"效果被重置/变了形"而不像"跳一下"。
     * 0.8 是既能明显看到跟着鼓点弹、又不会把效果撑变形的档位。
     * 面板里可以随时调。
     */
    pulseIntensity: 0.8,

    /**
     * 运动速度倍率
     *
     * 所有效果的动画都由 uTime 驱动，这一个值同时调快调慢全部效果。
     * 觉得画面太静就往上调。
     */
    motionSpeed: 1,

    /**
     * 背景帧率上限
     *
     * **默认 0 = 不限帧。**
     *
     * 原来默认 60，本意是"粒子不需要跑满高刷屏、省点 GPU"。但实测下来这是个纯粹的损失：
     *   1. 它省不下东西 —— 帧率对画布像素数和画面内容都无感（分辨率降到 12% 帧率不变，
     *      关掉全部粒子也不变），瓶颈根本不在 GPU 填充率上。
     *   2. 它在高刷屏上会错位量化 —— 144Hz 上 60 变成 48 帧，165Hz 上变成 55 帧，
     *      因为可用的帧率只能是刷新率的整数分频。
     * 实测：不限帧 80 帧，限帧 60 只有 53 帧。
     *
     * 所以默认放开。真要限帧（比如笔记本想省电），可选 30/60 等，程序会按屏幕刷新率
     * 取最接近的分频档。
     */
    maxFps: 0,
  },
};

/* ------------------------------------------------------------------ */
/* 性能档位                                                            */
/* ------------------------------------------------------------------ */

/**
 * 一键性能档位
 *
 * 影响帧率的东西有好几项（粒子密度、泛光、玻璃磨砂），单独调很容易顾此失彼。
 * 这里打包成档位：先选一个接近的，再微调单项。
 *
 * 注意玻璃磨砂那项：它要每帧重新模糊背后的粒子画布，是全套里最贵的，
 * 所以"流畅优先"档直接关掉它 —— 界面变成纯透明玻璃，其实也好看。
 */
export const PERF_PROFILES = {
  smooth: {
    name: '流畅优先',
    hint: '粒子减量 + 关掉玻璃磨砂 + 换成廉价泛光。核显或想省电时用这档',
    patch: {
      glassBlur: 0,
      particles: {
        density: 0.7,
        bloom: true,
        bloomStrength: 0.9,
        bloomMode: 'cheap',
        renderScale: 1,
        autoQuality: false,
      },
    },
  },
  balanced: {
    name: '均衡（推荐）',
    hint: '默认。满密度粒子 + 玻璃磨砂 + 原版泛光，独立显卡上实测 100+ 帧',
    patch: {
      glassBlur: 10,
      particles: {
        density: 1,
        bloom: true,
        bloomStrength: 0.45,
        bloomMode: 'unreal',
        renderScale: 1,
        autoQuality: false,
      },
    },
  },
  quality: {
    name: '画质优先',
    hint: '粒子更密、泛光更足、磨砂更重。独立显卡选这个',
    patch: {
      glassBlur: 20,
      particles: {
        density: 1.4,
        bloom: true,
        bloomStrength: 0.75,
        bloomMode: 'unreal',
        renderScale: 1,
        autoQuality: false,
      },
    },
  },
};

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (typeof base !== 'object' || Array.isArray(base)) return patch;
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k])) {
      out[k] = deepMerge(base[k] ?? {}, patch[k]);
    } else {
      out[k] = patch[k];
    }
  }
  return out;
}

/**
 * 有效的效果 key 集合。
 *
 * 在这里单独列一份，是为了让 settings.js 不必 import effects.js ——
 * 后者会连带把 three 拉进来，而 settings 是纯配置模块，不该有渲染依赖。
 * 代价是**增删效果时两边都要改**（effects.js 的 EFFECT_LIST 和这里）。
 */
const EFFECT_KEYS = new Set([
  'wave', 'cover', 'spectrum', 'spectrogram', 'coral', 'tunnel', 'rain', 'vinyl', 'halo', 'blackhole',
]);

export function loadSettings() {  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...structuredClone(DEFAULT_SETTINGS), settingsVersion: SETTINGS_VERSION };

    const parsed = JSON.parse(raw);
    const merged = deepMerge(DEFAULT_SETTINGS, parsed);

    // 主题名失效时退回默认，避免旧存档把界面搞成没样式的
    if (!THEMES[merged.theme]) merged.theme = DEFAULT_SETTINGS.theme;

    /*
     * 效果名失效时也要退回默认。
     *
     * 这一条在删掉六个效果之后变成了**必须项**：老存档里存的是 nebula /
     * galaxy / warp / wave / terrain / sphere 之一，而这些 key 已经不存在于
     * BUILDERS 里了。虽然 buildEffect 有兜底（找不到就用 halo），
     * 但 settings.effect 会一直是个死值，设置面板里也高亮不出任何一项 ——
     * 界面看起来像"效果选择坏了"。这里直接归位到默认。
     */
    if (!EFFECT_KEYS.has(merged.effect)) merged.effect = DEFAULT_SETTINGS.effect;

    // ---- 一次性迁移 ----
    /*
     * ★ 这里**不要**再写"把用户的 effect 换掉"的迁移。
     *
     * 我加过一次：把用户存的 'spectrum' 强行改成 'wave'。
     * 结果用户打开发现"我原来的效果怎么失效了" —— 那是他自己选的，
     * 凭什么被我改掉 ✗
     *
     * 新增一个效果，只该做两件事：注册进 EFFECT_KEYS、出现在列表里。
     * **默认值和用户已存的偏好都不该动。**
     */
    if ((Number(parsed.settingsVersion) || 1) < 2) {
      merged.particles.bloomStrength = DEFAULT_SETTINGS.particles.bloomStrength;
      merged.particles.bloomThreshold = DEFAULT_SETTINGS.particles.bloomThreshold;
      // 低于 1.0 的渲染倍率会把画布拉伸，画布一变观感就变
      merged.particles.renderScale = Math.max(1, Number(merged.particles.renderScale) || 1);
      // 自适应降级会改倍率 → 画布被重新拉伸 → 整幅画面跳一下，看起来像频闪
      merged.particles.autoQuality = false;
    }

    if ((Number(parsed.settingsVersion) || 1) < 3) {
      // 之前为了压频闪把律动压到 0.3，现在脉冲改成驱动位移了，可以给足
      merged.particles.pulseIntensity = DEFAULT_SETTINGS.particles.pulseIntensity;
    }

    if ((Number(parsed.settingsVersion) || 1) < 4) {
      // v3 把 beat 误放进了 particles 里面，导致顶层的 beat 成了空对象 {}，
      // 于是 settings.beat.bandLow 是 undefined、频段算成 NaN、鼓点永远不触发。
      // 这里直接重建一份完整的 beat 配置。
      merged.beat = { ...DEFAULT_SETTINGS.beat };
      if (merged.particles) delete merged.particles.beat;
    }

    // 无论什么版本，都保证 beat 的每一项都存在（防御性：老存档可能缺字段）
    merged.beat = { ...DEFAULT_SETTINGS.beat, ...(merged.beat || {}) };

    if ((Number(parsed.settingsVersion) || 1) < 17) {
      /*
       * 「封面粒子」从这一版起成为**效果列表里的一个独立选项**，并且是默认效果。
       *
       * 为什么必须专门写一条迁移：默认值只在"存档里没有合法值"时才会被采纳，
       * 而老存档里存着 effect:'spectrum' —— 它是合法值，所以
       * 光把 DEFAULT_SETTINGS.effect 改成 'cover' **完全不起作用**。
       * 我第一版就是这么改的，回读日志里还是"效果=spectrum"。
       *
       * 顺手把 renderScale 归位：这个字段的语义在这一版变成了
       * "相对原生分辨率的倍率"（1.0 = 原生清晰），老存档里的 1.0 在旧语义下
       * 其实是"低于原生"，会导致半调网点发糊。
       */
      merged.effect = 'cover';
      merged.particles.renderScale = DEFAULT_SETTINGS.particles.renderScale;
    }

    if ((Number(parsed.settingsVersion) || 1) < 5) {
      // 流畅度优先：玻璃磨砂是最大的性能开销来源，默认降到很低；
      // 粒子密度同理（填充率瓶颈）。旧存档如果没手动调过就按新默认走。
      if (Number(merged.glassBlur) > 12) merged.glassBlur = DEFAULT_SETTINGS.glassBlur;
      if (Number(merged.particles.density) >= 1) {
        merged.particles.density = DEFAULT_SETTINGS.particles.density;
      }
    }

    if ((Number(parsed.settingsVersion) || 1) < 6) {
      // 200ms 太密：脉冲还没回落就被下一次顶起，形成恒定位移，反而看不出跳
      if (Number(merged.beat.minInterval) === 200) {
        merged.beat.minInterval = DEFAULT_SETTINGS.beat.minInterval;
      }
    }

    if ((Number(parsed.settingsVersion) || 1) < 7) {
      /*
       * 泛光换成了自写的 CheapBloomPass（3 次绘制 @1/4 分辨率，
       * 而不是 UnrealBloomPass 的约 10 次），同数字下亮度大约只有原来的一半，
       * 所以把存下来的强度翻倍，观感接得上。上限 3。
       */
      const old = Number(merged.particles.bloomStrength);
      if (Number.isFinite(old) && old > 0) {
        merged.particles.bloomStrength = Math.min(3, Math.round(old * 2 * 100) / 100);
      } else {
        merged.particles.bloomStrength = DEFAULT_SETTINGS.particles.bloomStrength;
      }
      // 实测瓶颈是核显的填充率，密度整体下调
      if (Number(merged.particles.density) > 0.6) {
        merged.particles.density = DEFAULT_SETTINGS.particles.density;
      }
    }

    if ((Number(parsed.settingsVersion) || 1) < 8) {
      /*
       * 关掉玻璃磨砂 —— 实测这是整个软件最贵的一项。
       *
       * backdrop-filter 每帧都要重新读取并模糊它背后的区域，而背后是持续动画的
       * WebGL 画布，于是合成器每帧要为每个磨砂面板重做一遍模糊。它换来的是
       * "磨砂玻璃"观感，代价完全不成比例。
       *
       * 注意老存档里 glassBlur 就算是 0 也没用：以前 0 会被写成 `blur(0px)`，
       * 那**不等于关闭**，照样要走读取+过滤这一趟。现在 0 = 彻底 none。
       * 想找回磨砂观感的话，"画质优先"档会重新打开它。
       */
      merged.glassBlur = 0;

      /*
       * 帧率上限默认改成"不限帧"。
       *
       * 原来默认 60，在高刷屏上会错位量化成 48/55 帧（只能按刷新率整数分频），
       * 而且省不下任何 GPU —— 实测不限帧 80 帧、限帧 60 只有 53 帧。
       * 老存档如果还停在 60，一并放开。
       */
      if (Number(merged.particles.maxFps) === 60) merged.particles.maxFps = 0;
    }

    if ((Number(parsed.settingsVersion) || 1) < 9) {
      /*
       * 把画质还回来。
       *
       * v8 里为了迁就**核显**，把粒子密度砍到 0.5、玻璃磨砂整个关掉了。
       * 但真正的病根是 Chromium 把应用挂在了核显上跑，独显（RTX 5060）全程闲着；
       * 加上 force_high_performance_gpu 之后实测：满密度粒子 + 14px 磨砂仍有 154 帧，
       * 单开磨砂就是满刷新率 165 帧。
       *
       * 也就是说 v8 砍掉的那些画质**本来就是白砍的**。这里恢复默认值，
       * 想省电或确实在用核显的话，用"流畅优先"档即可。
       */
      if (Number(merged.particles.density) <= 0.6) {
        merged.particles.density = DEFAULT_SETTINGS.particles.density;
      }
      if (Number(merged.glassBlur) === 0) merged.glassBlur = DEFAULT_SETTINGS.glassBlur;
    }

    if ((Number(parsed.settingsVersion) || 1) < 10) {
      /*
       * v10：把这一轮排查过程中被改乱、以及为了迁就核显而砍掉的画质项，
       * 全部恢复成默认值。
       *
       * 背景：排查性能问题时写了几个自动探测函数，它们内部调用了 updateSettings，
       * 而 updateSettings 是会**存盘**的 —— 结果把用户的设置搅成了一团
       * （比如为了做泛光对比把专辑氛围背景关掉、把密度和磨砂在几个档位之间反复改）。
       * 这里直接按默认值重建这几个"被探测污染过"的项，其余偏好（主题、配色、
       * 音量、播放模式等）保持不动。
       */
      merged.glassBlur = DEFAULT_SETTINGS.glassBlur;
      merged.albumBackground = DEFAULT_SETTINGS.albumBackground;
      merged.particles.density = DEFAULT_SETTINGS.particles.density;
      merged.particles.bloom = DEFAULT_SETTINGS.particles.bloom;
      merged.particles.bloomStrength = DEFAULT_SETTINGS.particles.bloomStrength;
      merged.particles.bloomThreshold = DEFAULT_SETTINGS.particles.bloomThreshold;
      merged.particles.bloomMode = DEFAULT_SETTINGS.particles.bloomMode;
      merged.particles.pulseIntensity = DEFAULT_SETTINGS.particles.pulseIntensity;
      merged.perfProfile = DEFAULT_SETTINGS.perfProfile;
    }

    if ((Number(parsed.settingsVersion) || 1) < 11) {
      /*
       * v11：节拍检测提速相关。
       *
       * 这一版修了"跟不上节奏"的三个延迟源（频谱平滑 0.6→0、脉冲起振 τ 55ms→14ms、
       * 触发间隔 280ms→170ms），并加了上升沿判定。老存档里若还是那几个旧值，
       * 一并换到新默认，否则用户升级后依然踩不准。
       */
      if (Number(merged.beat.minInterval) >= 250) {
        merged.beat.minInterval = DEFAULT_SETTINGS.beat.minInterval;
      }
      // 泛光实现换回原版了，强度和阈值要跟着回到原版那一套
      merged.particles.bloomMode = DEFAULT_SETTINGS.particles.bloomMode;
      merged.particles.bloomStrength = DEFAULT_SETTINGS.particles.bloomStrength;
      merged.particles.bloomThreshold = DEFAULT_SETTINGS.particles.bloomThreshold;
      merged.particles.pulseIntensity = DEFAULT_SETTINGS.particles.pulseIntensity;
    }

    if ((Number(parsed.settingsVersion) || 1) < 12) {
      /*
       * v12：节拍检测从"频段能量 vs 慢基线"整体换成业界标准的**频谱通量**
       * （每个频点相对上一帧涨了多少 + 中位数自适应门限 + 局部极大值判定），
       * 并重新校准了触发间隔和跳动幅度。
       *
       * 老存档里这几个值都是旧方案下的产物，一律换成新默认，否则升级后依然踩不准。
       */
      merged.beat.minInterval = DEFAULT_SETTINGS.beat.minInterval;
      merged.beat.sensitivity = DEFAULT_SETTINGS.beat.sensitivity;
      merged.particles.pulseIntensity = DEFAULT_SETTINGS.particles.pulseIntensity;
    }

    if ((Number(parsed.settingsVersion) || 1) < 13) {
      /*
       * v13：把"跳动"和"变亮"彻底分开。
       *
       * 根因：全部 12 个效果的 gl_PointSize 都乘了 `1.0 + uPulse * 0.95`。
       * 粒子是加色混合的，尺寸放大 1.95 倍 = 面积放大 3.8 倍 = 亮度涨 3.8 倍。
       * 这就是"播放一会突然变亮、效果像被重置"的来源 —— 它一直是**亮度**在响应鼓点，
       * 而不是位移。现在那一项压到 0.30，跳动主要靠位移表达。
       *
       * 老存档里的律动强度是按旧行为调的（那时一部分是亮度效果），
       * 一并恢复默认，免得在新行为下偏弱或偏强。
       */
      merged.particles.pulseIntensity = DEFAULT_SETTINGS.particles.pulseIntensity;
    }

    if ((Number(parsed.settingsVersion) || 1) < 14) {
      /*
       * v14：把自动探测可能留下的残留设置清掉。
       *
       * 起因：我为了自动验证加的探测脚本会依次切换三个画质档位（改密度、泛光、磨砂），
       * 而它走的 updateSettings 会**存盘** —— 如果探测被中途打断，还原那一步不会执行，
       * 用户存档里就留下了一个测试用的中间状态（例如密度 0.7、泛光关掉之类），
       * 表现为"播一会效果突然变了"。
       *
       * 现在探测已经改成不存盘（见 main.js 的 suppressSettingsSave），
       * 这里再把可能已经写坏的值复位一次。
       */
      merged.glassBlur = DEFAULT_SETTINGS.glassBlur;
      merged.albumBackground = DEFAULT_SETTINGS.albumBackground;
      // 注意：**不要**重置 settings.effect —— 那是用户自己挑的粒子风格，
      // 探测脚本从来不动它，把它复位等于白扔用户的偏好。
      merged.particles.density = DEFAULT_SETTINGS.particles.density;
      merged.particles.bloom = DEFAULT_SETTINGS.particles.bloom;
      merged.particles.bloomStrength = DEFAULT_SETTINGS.particles.bloomStrength;
      merged.particles.bloomThreshold = DEFAULT_SETTINGS.particles.bloomThreshold;
      merged.particles.bloomMode = DEFAULT_SETTINGS.particles.bloomMode;
      merged.particles.renderScale = DEFAULT_SETTINGS.particles.renderScale;
      merged.particles.pulseIntensity = DEFAULT_SETTINGS.particles.pulseIntensity;
      merged.perfProfile = DEFAULT_SETTINGS.perfProfile;
    }

    merged.settingsVersion = SETTINGS_VERSION;
    return merged;
  } catch {
    return { ...structuredClone(DEFAULT_SETTINGS), settingsVersion: SETTINGS_VERSION };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  } catch {
    /* 隐私模式等场景写入失败，忽略即可，不影响本次会话 */
  }
}

/* ------------------------------------------------------------------ */
/* 应用                                                                */
/* ------------------------------------------------------------------ */

function hexToRgbTriplet(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

/** 十六进制颜色 → [r,g,b]（0~1），粒子配色用的是这个量纲 */
function hexToRgb01(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function shade(hex, factor) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((n >> 16) & 255) * factor);
  const g = clamp(((n >> 8) & 255) * factor);
  const b = clamp((n & 255) * factor);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/**
 * 把一个颜色**按色相偏转**并提亮 —— 用来从强调色派生出主题的副色
 * （--violet / --ice）。
 *
 * 为什么不直接把副色也设成强调色：那样整个界面会退化成单色，主次层次全丢。
 * 按色相偏转几十度、再抬一点亮度，既保留"主色 + 副色"的两色语言，
 * 又保证它们**和封面色同属一个色系** —— 这正是"封面取色"该有的效果。
 *
 * @param {string} hex  源色
 * @param {number} deg  色相偏转角度（正数往暖走，负数往冷走）
 * @param {number} lift 往白里推的比例 0~1，用来拉开明度层次
 */
function rotateHue(hex, deg, lift = 0) {
  const rgb = hexToRgb01(hex);
  if (!rgb) return hex;
  const max = Math.max(rgb[0], rgb[1], rgb[2]);
  const min = Math.min(rgb[0], rgb[1], rgb[2]);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rgb[0]) h = ((rgb[1] - rgb[2]) / d + (rgb[1] < rgb[2] ? 6 : 0)) / 6;
    else if (max === rgb[1]) h = ((rgb[2] - rgb[0]) / d + 2) / 6;
    else h = ((rgb[0] - rgb[1]) / d + 4) / 6;
  }
  h = (h + deg / 360 + 1) % 1;
  // 副色的饱和度不要拉满，否则会和主色抢眼
  const s2 = Math.min(1, s * 0.85 + 0.15);

  const hue2rgb = (p, q, t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s2) : l + s2 - l * s2;
  const p = 2 * l - q;
  let out = [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
  if (lift > 0) out = out.map((v) => v + (1 - v) * lift);
  const to = (v) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${to(out[0])}${to(out[1])}${to(out[2])}`;
}

/** hex → [h(0~1), s(0~1), l(0~1)] */
function toHsl(hex) {
  const rgb = hexToRgb01(hex);
  if (!rgb) return null;
  const max = Math.max(rgb[0], rgb[1], rgb[2]);
  const min = Math.min(rgb[0], rgb[1], rgb[2]);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rgb[0]) h = ((rgb[1] - rgb[2]) / d + (rgb[1] < rgb[2] ? 6 : 0)) / 6;
    else if (max === rgb[1]) h = ((rgb[2] - rgb[0]) / d + 2) / 6;
    else h = ((rgb[0] - rgb[1]) / d + 4) / 6;
  }
  return [h, s, l];
}

/** [h,s,l] → hex */
function fromHsl(h, s, l) {
  const hue2rgb = (p, q, t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const to = (v) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${to(hue2rgb(p, q, h + 1 / 3))}${to(hue2rgb(p, q, h))}${to(hue2rgb(p, q, h - 1 / 3))}`;
}

/**
 * 把一个中性色**换成目标色相但保留它的明暗角色**。
 *
 * 用途：封面模式下，主题的 --ink / --muted / --bg / --hair 这些"中性色"
 * 其实都带着主题的色调（nebula 全都偏蓝紫）。封面是暖色时，这些字和边框
 * 仍然是蓝紫的 —— 用户看到的"整体的外观还是外观色的叠加"就是它。
 *
 * 做法是只换色相、保留明度和饱和度（并把饱和度压一个上限），
 * 于是 --bg 还是那么深、--ink 还是那么亮，但整体色调统一到封面那一系。
 * 直接把它们染成封面色是不行的 —— 文字会失去对比、界面会糊。
 *
 * @param {string} hex      主题原本的中性色
 * @param {number} hue      目标色相 0~1（来自封面色）
 * @param {number} [satMax] 饱和度上限，避免中性色变得太艳
 */
function retintNeutral(hex, hue, satMax = 0.42) {
  const hsl = toHsl(hex);
  if (hsl === null) return hex;
  const [, s, l] = hsl;
  return fromHsl(hue, Math.min(s, satMax), l);
}

/**
 * 把设置写到 CSS 变量上
 * @returns {{stars: number[][], ribbons: number[][]}} 供粒子系统使用的配色
 */
export function applySettings(settings) {
  const root = document.documentElement;
  const theme = THEMES[settings.theme] || THEMES[DEFAULT_SETTINGS.theme];

  // 1. 主题基础色
  for (const [k, v] of Object.entries(theme.ui)) root.style.setProperty(k, v);

  // 2. 强调色覆盖
  /*
   * 强调色的来源按这个优先级：
   *   ① 封面取色（如果开了，且当前确实取到了颜色）
   *   ② 用户手动指定的强调色
   *   ③ 主题自带的
   * 封面色优先是有意的：用户开了这个开关，就是想让界面跟着歌走；
   * 取不到时自动退回手动/主题色，不会出现"开了开关反而变成默认色"。
   */
  const coverAccent =
    settings.coverAccent && settings.coverAccentColor
      ? String(settings.coverAccentColor)
      : '';
  const accent = coverAccent || settings.accentOverride || theme.ui['--accent'];
  if (coverAccent || settings.accentOverride) {
root.style.setProperty('--accent', accent);
    /*
     * ★ --accent-ink：强调色**当文字用**时的版本。
     *
     * 强调色同时兼任两种角色，而它们对亮度的要求是相反的：
     *   · 当**填充色**（按钮底、滑块、粒子）—— 要饱和、要够重
     *   · 当**文字色**（选中导航项、统计数字、按钮文字）—— 必须够亮
     * 封面取到深蓝 / 深紫时，同一个值当填充很好看、当文字就看不清，
     * 用户的原话是"这种蓝色的文字就不行"。
     *
     * 所以拆成两个变量：--accent 保持原样给填充和粒子用，
     * --accent-ink 只抬亮度（色相饱和度照旧），专供文字。
     * 这样"文字看得清"和"配色跟封面走"就不再互相打架。
     */
    const hslInk = toHsl(accent);
    root.style.setProperty(
      '--accent-ink',
      hslInk ? fromHsl(hslInk[0], Math.max(hslInk[1], 0.55), Math.max(hslInk[2], 0.76)) : accent
    );
    root.style.setProperty('--accent-dim', shade(accent, 0.62));
    const trip = hexToRgbTriplet(accent);
    if (trip) root.style.setProperty('--accent-rgb', trip);

    /*
     * ★ 主题的**副色**也要跟着强调色走，否则界面上会出现"两种颜色并存"。
     *
     * 主题除了 --accent 还定义了 --violet 和 --ice 两个彩色变量，而覆盖
     * 强调色时原本只改了 --accent 那一组 —— 它们仍然保持主题的紫 / 青。
     * 最显眼的是左上角 logo 那个圆点：
     *     radial-gradient(circle, var(--accent), var(--violet) 62%, ...)
     * 于是它永远是一颗"封面色 → 主题紫"的渐变球。
     * 用户的原话是"就是封面颜色跟外观色加在一起的颜色" —— 描述的就是它。
     *
     * 做法不是把副色也刷成强调色（那样整个界面会变成单色、丢掉层次），
     * 而是**按新色相重新派生**：在强调色色相上偏转几十度，
     * 既保持"主色 + 副色"的两色语言，又完全落在同一个色系里。
     */
    root.style.setProperty('--violet', rotateHue(accent, 34, 0.16));
    root.style.setProperty('--ice', rotateHue(accent, -46, 0.34));

    /*
     * ★ 封面模式下，**中性色也要跟着换色相**。
     *
     * 主题里那些看起来"没颜色"的变量其实是带色调的 —— nebula 的
     * --ink / --muted / --hair / --bg 全都偏蓝紫。封面是暖褐时，
     * 文字和边框仍然是蓝紫的，于是整屏看上去还是"两种色调叠着"。
     * 用户的原话："别的文字样式，整体的外观还是外观色的叠加"。
     *
     * 只换色相、保留明暗和饱和度（并压饱和度上限），所以
     * --bg 还是那么深、--ink 还是那么亮，但色调统一到封面这一系。
     *
     * 只在封面模式下做 —— 手动色模式本来就在主题体系内，不需要动。
     */
    /*
     * ★ 封面模式下，文字取"**淡淡的封面色调**"，不是封面色本身。
     *
     * 这里试过三种，用户最终选的是这一种，结论写死，别再改：
     *   a) 保持主题中性色的明度、只换色相 → 淡暖白（#f5eaeb）。
     *      数据上只有一个色相，但看着像"白里掺了点色"，用户说"还是叠加"。
     *   b) 直接用封面色（就是橙的就橙的） → 视觉冲击最强，但
     *      **有些封面色当文字压根看不清**，用户的原话：
     *      "还是淡点吧，不然有的颜色太难受了看不清"。
     *   c) ← 现在这个：色相跟着封面走，但**明度抬到高处、饱和度压住**，
     *      于是是一层很淡的同色调，读起来轻松，也仍然能看出"跟着封面"。
     *
     * 一句话总结这个取舍：**文字的首要职责是能读，其次才是好看。**
     * 想要 (b) 那种强效果，就把下面的 satMax 调大 —— 一行的事。
     */
    if (coverAccent) {
      const hsl = toHsl(accent);
      if (hsl) {
        const [hue] = hsl;
        // 文字：高亮度 + 压住的饱和度，只是一层淡色调
        root.style.setProperty('--ink', fromHsl(hue, 0.16, 0.95));
        root.style.setProperty('--ink-2', fromHsl(hue, 0.2, 0.84));
        root.style.setProperty('--muted', fromHsl(hue, 0.24, 0.62));
        // 分隔线 / 面板底色：保持"深"的角色，只把色相带过去
        root.style.setProperty('--hair', retintNeutral(theme.ui['--hair'], hue));
        root.style.setProperty('--hair-2', retintNeutral(theme.ui['--hair-2'], hue));
        for (const key of ['--bg', '--surface', '--surface-2']) {
          const cur = theme.ui[key];
          if (cur) root.style.setProperty(key, retintNeutral(cur, hue));
        }
      }
    }
  }
  // 让下面第 6 段的粒子上色也认这个颜色
  const accentForParticles = coverAccent || settings.accentOverride;

  // 3. 玻璃透明度 / 模糊
  //    glassOpacity 直接决定面板的 alpha，是"界面透明"的主控项
  const a = Math.max(0, Math.min(1, settings.glassOpacity));
  root.style.setProperty('--glass-panel', `rgba(10, 12, 18, ${a.toFixed(3)})`);
  root.style.setProperty('--glass-bar', `rgba(10, 12, 18, ${Math.min(1, a + 0.12).toFixed(3)})`);
  root.style.setProperty('--glass-raise', `rgba(24, 28, 37, ${Math.min(1, a + 0.08).toFixed(3)})`);
  root.style.setProperty('--glass-hover', `rgba(34, 39, 51, ${Math.min(1, a + 0.16).toFixed(3)})`);
  root.style.setProperty('--glass-blur', `${Math.round(settings.glassBlur)}px`);

  /*
   * 玻璃磨砂的开关（关键的性能项）
   *
   * backdrop-filter 要**每一帧重新读取并模糊它背后那块区域**。我们的背面是一张
   * 一直在动的 WebGL 画布，所以只要这个属性生效，合成器每帧都要重做一遍模糊，
   * 面板有多大、有几个面板，就要做几遍 —— 这是整个软件里最贵的一项，实测能把
   * 帧率压到 30 出头（把 WebGL 一停，同一份界面立刻回到 150+ 帧）。
   *
   * 注意：`blur(0px)` **不等于**关闭。半径是 0 也照样要走"读取背景 + 过滤"这一趟，
   * 所以调低半径一点用都没有（实测关到 0 反而 -4 帧，纯属噪声）。
   * 真正关掉必须是 `backdrop-filter: none`，那才是完全跳过这一趟。
   *
   * 因此这里用 `:root.no-glass-blur` 把整条属性彻底掐掉，而不是把半径设成 0。
   */
  const blurOn = Math.round(settings.glassBlur) > 0;
  document.documentElement.classList.toggle('no-glass-blur', !blurOn);

  // 4. 文字压暗
  const s = Math.max(0, settings.scrim);
  root.style.setProperty(
    '--scrim',
    s <= 0.01
      ? 'none'
      : `radial-gradient(120% 90% at 12% 0%, rgba(4, 5, 9, ${(0.72 * s).toFixed(3)}) 0%, ` +
        `rgba(4, 5, 9, ${(0.38 * s).toFixed(3)}) 42%, rgba(4, 5, 9, ${(0.16 * s).toFixed(3)}) 70%, transparent 100%)`
  );

  // 5. 专辑氛围背景强度
  const ab = settings.albumBackground ? Math.max(0, Math.min(1.4, settings.albumBgOpacity)) : 0;
  root.style.setProperty('--album-opacity', ab.toFixed(3));

  root.dataset.theme = settings.theme;

  /*
   * 6. 粒子配色
   *
   * 这里修了一个一直存在的脱节：**换强调色只改了界面，粒子颜色纹丝不动**。
   * 原因是强调色只写进了 CSS 变量（--accent 等），而粒子用的是主题自带的
   * theme.particles，两者之间没有任何联系 —— 用户把强调色调成红色，
   * 界面跟着变了，粒子还是原来那套颜色，看起来就像"外观色没生效"。
   *
   * 现在把强调色接进粒子配色：让它在主体粒子色里占主导，
   * 同时保留主题原有的辅助色做层次，避免整片粒子变成单一颜色。
   * 深拷贝一层是因为后面要改元素，不能动到 THEMES 里的常量。
   */
  const pal = {
    stars: (theme.particles.stars || []).map((c) => c.slice()),
    ribbons: (theme.particles.ribbons || []).map((c) => c.slice()),
  };

  if (accentForParticles) {
    const rgb = hexToRgb01(accentForParticles);
    if (rgb) {
      /*
       * ★ 用户的规则（原文）：
       *     "外观色就外观色，封面色就封面色，这两个绝不能混在一起用，
       *      也不能效果加在一起"
       *
       * 所以分成两种模式，各自**只**用自己那一套颜色，一点不掺：
       *
       *   封面模式（coverAccent）—— pal 的**每一个槽位**都从封面色派生。
       *     之前只覆盖了 ribbons[0..1] 和 stars[0]，剩下的槽位仍然是主题色，
       *     于是粒子场上同时飘着封面色和外观色。
       *     派生方式：色相不变，只改明度和饱和度，做出几档层次 ——
       *     层次是"同一色的深浅"，不是"两种颜色混"。
       *
       *   手动色模式 —— 保留原来的做法：主题辅助色 + 强调色混出 60%。
       *     这里两个都是"外观色"（一个来自主题、一个是用户选的），
       *     按用户的规则这不叫混，而且那层混合本来就是主题的层次感来源。
       */
      if (settings.coverAccent) {
        const V = rgb;
        const mixWhite = (c, k) => c.map((v) => v + (1 - v) * k);
        const mixBlack = (c, k) => c.map((v) => v * (1 - k));
        pal.ribbons = pal.ribbons.map((_, i) => {
          if (i === 0) return V.slice();
          if (i === 1) return mixWhite(V, 0.38);   // 浅一档
          if (i === 2) return mixBlack(V, 0.34);   // 深一档
          return mixWhite(V, 0.62);                // 更浅，当点缀
        });
        pal.stars = pal.stars.map((_, i) => mixWhite(V, i === 0 ? 0.45 : 0.66 + i * 0.08));
      } else {
        if (pal.ribbons.length) {
          pal.ribbons[0] = rgb;
          if (pal.ribbons.length > 1) {
            // 第二个槽位往强调色靠 60%，让它更有存在感但不成单调
            pal.ribbons[1] = pal.ribbons[1].map((v, i) => v * 0.4 + rgb[i] * 0.6);
          }
        }
        if (pal.stars.length) {
          // 背景星点用提亮后的强调色，保持"淡"的层次
          pal.stars[0] = rgb.map((v) => v * 0.55 + 0.45);
        }
      }
    }
  }

  return pal;
}

/** 导出当前设置，用于备份/分享 */
export function exportSettings(settings) {
  return JSON.stringify(settings, null, 2);
}
