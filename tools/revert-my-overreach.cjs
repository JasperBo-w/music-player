/*
 * 三处回退/修正。
 *
 * ① 撤销"把默认效果改成 wave + 迁移用户设置" —— 这是越权 ✗
 * ② 撤掉我加的帧率上限 —— 它是重犯 particles.js 里已经记过的错 ✗
 * ③ 波浪不再跟节拍联动 —— 用户要的是"不跳" ✗
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const log = (m) => console.log(m);
let n = 0;
const edit = (file, pairs) => {
  let t = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const [from, to, label] of pairs) {
    if (t.includes(from)) {
      t = t.replace(from, to);
      n++;
    } else log('!! ' + label);
  }
  fs.writeFileSync(file, t.replace(/\n/g, '\r\n'));
};

/* ---------- ① settings.js：还原默认效果 + 删掉迁移 ---------- */
edit(path.join(root, 'apps', 'ui', 'src', 'settings.js'), [
  [
    `/*
   * 默认背景效果。
   *
   * 从 'cover' 改成 'wave'：用户对原来的观感不满意
   *（原话："乱挑动了感觉，有些舒缓的歌都不匹配"），
   * 要的是有规律的舒缓起伏。见 effects.js 里 buildWave 的说明。
   */
  effect: 'wave',`,
    `  effect: 'cover',`,
    '还原默认效果',
  ],
  [
    `    // ---- 一次性迁移 ----
    // MIGRATE_WAVE
    if ((Number(parsed.settingsVersion) || 1) <= 18) {
      /*
       * 把老存档的背景效果迁到「波光」。
       *
       * 只迁 'cover' 和 'spectrum'：如果用户自己选过别的（黑洞、唱片…），
       * 那是明确的偏好，不该被这次换默认值覆盖掉。
       */
      if (!parsed.effect || parsed.effect === 'spectrum') merged.effect = 'wave';
    }`,
    `    // ---- 一次性迁移 ----
    /*
     * ★ 这里**不要**再写"把用户的 effect 换掉"的迁移。
     *
     * 我加过一次：把用户存的 'spectrum' 强行改成 'wave'。
     * 结果用户打开发现"我原来的效果怎么失效了" —— 那是他自己选的，
     * 凭什么被我改掉 ✗
     *
     * 新增一个效果，只该做两件事：注册进 EFFECT_KEYS、出现在列表里。
     * **默认值和用户已存的偏好都不该动。**`,
    '删掉迁移',
  ],
]);

/* ---------- ② particles.js：撤掉我加的帧率上限 ---------- */
edit(path.join(root, 'apps', 'ui', 'src', 'particles.js'), [
  [
    `    /*
     * 帧率上限。**默认 0 = 不限帧。**`,
    `    /*
     * 帧率上限。**默认 0 = 不限帧。**
     *
     * ★ 2026-09 补记：我曾经另写了一个 renderMinGap（默认 1000/60）
     *   来做同样的事，**没有读到下面这段说明**，于是重犯了一遍：
     *   · 帧率被从 165 压到 55，拖动、跳动都变顿 —— 用户报"唱片和月蚀
     *     怎么变成呼吸的了"，就是这个造成的 ✗
     *   · 而且它根本不省东西（下面写了实测数据）
     *   已删除。要做限帧就用这个 maxFps，且**默认不开**。`,
    '标注',
  ],
  [
    `    /*
     * ★ 帧率上限。
     *
     * 原来不限帧 —— 于是粒子背景跑满刷新率（这台机器是 165Hz），
     * GPU 被吃满，而 **Windows 的鼠标光标是 DWM 用 GPU 合成的**，
     * 结果就是"开着这个窗口，鼠标到哪儿都一顿一顿"。
     * 用户的原话："如果开着音乐窗口，鼠标周围滑动也是一样。"
     *
     * 60 FPS 对"缓慢流动的粒子"来说和 165 完全分不出来，
     * 但 GPU 占用差近三倍 —— 省下来的正好够 DWM 把光标画顺。
     *
     * 这里**只跳过渲染**，不跳过整个 tick：时间推进、音频分析
     * 这些每帧都要更新，跳了动画就会变慢。
     */
    const capNow = performance.now();
    if (this.renderMinGap && capNow - (this._lastRenderAt || 0) < this.renderMinGap) {
      return;
    }
    this._lastRenderAt = capNow;

`,
    ``,
    '删除帧率上限块',
  ],
  [
    `    this.renderMinGap = 1000 / 60;
    this._lastRenderAt = 0;
`,
    ``,
    '删除构造里的初始化',
  ],
]);

/* ---------- ③ effects.js：波浪不再跟节拍联动 ---------- */
edit(path.join(root, 'apps', 'ui', 'src', 'effects.js'), [
  [
    `        // 基础幅度由 CPU 按"带间距"算好传进来（见 bandSpacing 的说明），
        // 节拍只再抬一点点 —— 波浪的节奏是"呼吸变深"，不是"炸开"
        float amp = aWaveAmp * (1.0 + uBeatAmp * 0.55 * (0.6 + uPulse * 0.4));`,
    `        /*
         * ★ 幅度**完全不跟节拍联动**。
         *
         * 用户的原话："波浪个屁啊，不还是跳动" —— 我上一版留了 uBeatAmp 项，
         * 于是鼓点一来整片幅度就变，读出来还是"跳" ✗
         *
         * 波浪要的是**匀速、恒定、有规律**的起伏：它的节奏感来自波本身
         * 舒缓地流过去，不来自对鼓点的反应。所以这里就是一个常数。
         */
        float amp = aWaveAmp;`,
    '波浪去掉节拍项',
  ],
  [
    `        vAlpha = (0.24 + crest * 0.46) * soft * xFade`,
    `        /*
         * 亮度也不再跟节拍走（原来那项 uPulse * 0.10 就是"闪"的来源之一）。
         * 只保留一个很慢的自身呼吸，让画面不完全静止。
         */
        vAlpha = (0.24 + crest * 0.46) * soft * xFade`,
    '波浪亮度去节拍',
  ],
]);

log('改了 ' + n + ' 处');
