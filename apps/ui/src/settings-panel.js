import { THEMES, DEFAULT_SETTINGS, PERF_PROFILES } from './settings.js';
import { EFFECT_LIST } from './effects.js';

/**
 * 设置面板
 *
 * 四组：
 *   外观    主题预设 / 强调色
 *   粒子    效果形态（六选一）/ 总开关 / 密度
 *   流畅度  渲染倍率 / 自动降级 / 磨砂模糊 / 实时帧率
 *   透明    面板不透明度 / 文字压暗
 *
 * 面板自己也是玻璃材质，所以拖"面板不透明度"时能实时看到自己变透。
 */

function el(tag, cls, html) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

/**
 * @param {object} opts
 * @param {() => object} opts.getSettings
 * @param {(patch: object) => void} opts.update
 * @param {() => void} opts.onReset
 * @param {(s: boolean) => void} [opts.onOpenChange]
 */
export function mountSettingsPanel({
  getSettings,
  update,
  onReset,
  /* 全局热键编辑器要的四样，见下面「全局热键」那段 */
  hotkeyActions,
  hotkeyMap,
  hotkeyResults,
  onHotkeyChange,
}) {
  const overlay = el('div', 'settings-overlay');
  overlay.id = 'settings-overlay';

  const panel = el('aside', 'settings-panel');
  overlay.appendChild(panel);

  /* -------- 头部 -------- */
  const head = el('header', 'sp-head');
  head.innerHTML = '<h2>设置</h2>';
  const fpsBadge = el('span', 'sp-fps', '-- FPS');
  const closeBtn = el('button', 'sp-close', '✕');
  closeBtn.title = '关闭 (Esc)';
  head.appendChild(fpsBadge);
  head.appendChild(closeBtn);
  panel.appendChild(head);

  const body = el('div', 'sp-body');
  panel.appendChild(body);

  /* ================= 外观 ================= */
  const secLook = section('外观', '主题决定整套配色，粒子颜色会跟着一起变');
  const themeGrid = el('div', 'theme-grid');
  for (const [key, theme] of Object.entries(THEMES)) {
    const card = el('button', 'theme-card');
    card.dataset.theme = key;
    card.title = theme.hint;
    card.innerHTML = `
      <span class="theme-swatch" style="background: linear-gradient(135deg, ${theme.ui['--bg']} 0%, ${theme.ui['--surface-2']} 55%, ${theme.ui['--accent']} 100%);"></span>
      <span class="theme-name">${theme.name}</span>`;
    card.addEventListener('click', () => update({ theme: key, accentOverride: '' }));
    themeGrid.appendChild(card);
  }
  secLook.body.appendChild(themeGrid);
  // 封面取色：和"手动强调色"放在同一块，因为它俩是同一件事的两种来源
  const coverAccent = toggle('sp-cover-accent', '配色跟着封面走', (v) =>
    update({ coverAccent: v })
  );
  coverAccent.root.title = '从当前歌曲的封面里取主色，界面和粒子会跟着一起变';
  secLook.body.appendChild(coverAccent.root);

  const accentRow = el('div', 'sp-row');
  accentRow.innerHTML = `
    <label for="sp-accent">强调色</label>
    <div class="sp-controls">
      <input type="color" id="sp-accent" />
      <button id="sp-accent-reset" class="sp-mini">跟随主题</button>
    </div>
    <div class="sp-note" id="sp-accent-note"></div>`;
  secLook.body.appendChild(accentRow);

  // 专辑封面氛围背景
  const albumToggle = toggle('sp-albumbg', '专辑封面氛围背景', (v) => update({ albumBackground: v }));
  albumToggle.hint.textContent = '用当前歌曲的封面当整个应用的背景，换歌时两层交叉淡入';
  secLook.body.appendChild(albumToggle.root);

  const albumOpacity = slider('sp-albumop', '背景强度', 0, 130, 5, (v) =>
    update({ albumBgOpacity: v / 100 })
  );
  albumOpacity.hint.textContent = '调低让粒子更突出，调高让封面氛围更浓';
  secLook.body.appendChild(albumOpacity.root);

  body.appendChild(secLook.root);

  /* ================= 粒子 ================= */
  const secFx = section('粒子效果', '六种形态完全不同的粒子系统，不是换配色');
  body.appendChild(secFx.root);

  const particleToggle = toggle('sp-particles', '启用粒子背景', (v) => update({ particles: { enabled: v } }));
  secFx.body.appendChild(particleToggle.root);

  const effectGrid = el('div', 'effect-grid');
  const effectCards = new Map();
  for (const fx of EFFECT_LIST) {
    const card = el('button', 'effect-card');
    card.dataset.effect = fx.key;
    card.title = fx.hint;
    card.innerHTML = `<span class="effect-thumb" data-fx="${fx.key}"></span>
      <span class="effect-name">${fx.name}</span>
      <span class="effect-hint">${fx.hint}</span>`;
    card.addEventListener('click', () => update({ effect: fx.key }));
    effectGrid.appendChild(card);
    effectCards.set(fx.key, card);
  }
  secFx.body.appendChild(effectGrid);

  const density = slider('sp-density', '粒子密度', 40, 180, 5, (v) => update({ particles: { density: v / 100 } }));
  density.hint.textContent = '改动会重建粒子，有一次短暂卡顿。越大越壮观也越吃显卡';
  secFx.body.appendChild(density.root);

  const pulse = slider('sp-pulse', '律动强度', 0, 150, 5, (v) =>
    update({ particles: { pulseIntensity: v / 100 } })
  );
  pulse.hint.textContent = '节拍对粒子的影响程度。觉得闪就往下调，0 就是完全不跟节拍';
  secFx.body.appendChild(pulse.root);

  const motion = slider('sp-motion', '运动速度', 20, 300, 10, (v) =>
    update({ particles: { motionSpeed: v / 100 } })
  );
  motion.hint.textContent = '所有效果的动画都由时间驱动，这一个值同时调快调慢全部效果。觉得画面太静就往上调';
  secFx.body.appendChild(motion.root);

  /* ================= 音频驱动 ================= */
  const secBeat = section('音频驱动', '决定"节拍是怎么被听到的"。换个曲风觉得不跟拍，就调这里');
  body.appendChild(secBeat.root);

  const sens = slider('sp-beatsens', '鼓点灵敏度', 10, 150, 5, (v) =>
    update({ beat: { sensitivity: v / 100 } })
  );
  sens.hint.textContent = '越高越容易触发。太灵敏会把杂音也当鼓点，画面就会乱跳';
  secBeat.body.appendChild(sens.root);

  const gain = slider('sp-beatgain', '触发力度', 20, 250, 5, (v) =>
    update({ beat: { gain: v / 100 } })
  );
  gain.hint.textContent = '每次鼓点让粒子跳多高';
  secBeat.body.appendChild(gain.root);

  const minInt = slider('sp-beatmin', '最小间隔', 80, 600, 10, (v) =>
    update({ beat: { minInterval: v } })
  );
  minInt.hint.textContent = '两次触发之间至少隔多久（毫秒）。太密会连成一片，失去"跳"的节奏感';
  secBeat.body.appendChild(minInt.root);

  const bandLow = slider('sp-bandlow', '频段起点', 0, 120, 1, (v) => update({ beat: { bandLow: v } }));
  bandLow.hint.textContent = 'FFT 频段序号，每个约 43Hz。0 ≈ 20Hz';
  secBeat.body.appendChild(bandLow.root);

  const bandHigh = slider('sp-bandhigh', '频段终点', 1, 200, 1, (v) => update({ beat: { bandHigh: v } }));
  bandHigh.hint.textContent = '默认 12 ≈ 520Hz，正好覆盖底鼓和贝斯。往上调会开始跟着人声和旋律跳';
  secBeat.body.appendChild(bandHigh.root);

  /* ================= 流畅度 ================= */
  const secPerf = section('流畅度', '影响帧率的东西有好几项，先选档位再微调');
  body.appendChild(secPerf.root);

  // 性能档位：一键把几项一起调到位
  const profileRow = el('div', 'sp-row');
  profileRow.innerHTML = `<label>性能档位</label><div class="profile-grid"></div>`;
  const profileGrid = profileRow.querySelector('.profile-grid');
  const profileCards = new Map();
  for (const [key, prof] of Object.entries(PERF_PROFILES)) {
    const card = el('button', 'profile-card');
    card.dataset.profile = key;
    card.title = prof.hint;
    card.innerHTML = `<span class="profile-name">${prof.name}</span><span class="profile-hint">${prof.hint}</span>`;
    card.addEventListener('click', () => applyProfile(key));
    profileGrid.appendChild(card);
    profileCards.set(key, card);
  }
  const profileHint = el('p', 'sp-hint');
  profileHint.textContent = '选档位会把粒子密度、泛光、玻璃磨砂一起设好；之后单独改任何一项都会变成"自定义"';
  profileRow.appendChild(profileHint);
  secPerf.body.appendChild(profileRow);

  const renderScale = slider('sp-renderscale', '渲染精细度', 100, 140, 5, (v) =>
    update({ particles: { renderScale: v / 100 } })
  );
  renderScale.hint.textContent =
    '最低就是 100%（等于屏幕分辨率），往下调会让画布被拉伸、粒子发虚发亮，所以不提供更低档位。掉帧时系统会在 86%~100% 之间自动微调，肉眼看不出来';
  secPerf.body.appendChild(renderScale.root);

  const autoQuality = toggle('sp-autoq', '掉帧时自动降精细度', (v) =>
    update({ particles: { autoQuality: v } })
  );
  autoQuality.hint.textContent =
    '默认关闭。开启后掉帧时会自动降倍率，但每次改倍率画布都会被重新拉伸、整幅画面跳一下，看起来像频闪，所以不建议开';
  secPerf.body.appendChild(autoQuality.root);

  // ---- 泛光 ----
  const bloom = toggle('sp-bloom', '泛光后处理（推荐开）', (v) => update({ particles: { bloom: v } }));
  bloom.hint.textContent = '粒子的"发光晕开"效果，炫酷感主要来自这里。代价是整条后处理链，比较吃显卡';
  secPerf.body.appendChild(bloom.root);

  const bloomStrength = slider('sp-bloomstrength', '泛光强度', 0, 250, 5, (v) =>
    update({ particles: { bloomStrength: v / 100 } })
  );
  bloomStrength.hint.textContent = '调高更梦幻，但过亮会糊成一片、文字也难读';
  secPerf.body.appendChild(bloomStrength.root);

  const bloomThreshold = slider('sp-bloomthreshold', '泛光阈值', 0, 60, 1, (v) =>
    update({ particles: { bloomThreshold: v / 100 } })
  );
  bloomThreshold.hint.textContent = '越高只有越亮的粒子才发光。画面发白就调高这个';
  secPerf.body.appendChild(bloomThreshold.root);

  const blur = slider('sp-blur', '面板磨砂模糊', 0, 60, 2, (v) => update({ glassBlur: v }));
  blur.hint.textContent = '玻璃模糊是最大的性能开销来源。卡的话直接拉到 0，界面会变成纯透明玻璃，依然好看';
  secPerf.body.appendChild(blur.root);

  /* ================= 透明 ================= */
  const secGlass = section('透明', '数值越低，粒子越明显地从界面底下透出来');

  /*
   * ============ 全局热键 ============
   *
   * 必须建在下面的"分类搬移"**之前** —— 搬移是按标题找小节的，
   * 建晚了就找不到它，这一页会是空的（我第一版就是这样）。
   */
  const secKeys = section(
    '全局热键',
    '在任意窗口都生效。点「录制」再按下组合键；「清除」表示不绑定。显示"被占用"说明这个组合被系统或别的软件抢走了'
  );
  body.appendChild(secKeys.root);

  const keyRows = new Map();
  for (const a of hotkeyActions || []) {
    const row = el('div', 'sp-row sp-row-hotkey');
    const name = el('label', 'sp-hotkey-name');
    name.textContent = a.label;
    const cur = el('button', 'sp-hotkey-key');
    cur.type = 'button';
    const rec = el('button', 'sp-hotkey-btn');
    rec.type = 'button';
    rec.textContent = '录制';
    const clr = el('button', 'sp-hotkey-btn');
    clr.type = 'button';
    clr.textContent = '清除';
    const st = el('span', 'sp-hotkey-state');
    row.appendChild(name);
    row.appendChild(cur);
    row.appendChild(rec);
    row.appendChild(clr);
    row.appendChild(st);
    secKeys.body.appendChild(row);
    keyRows.set(a.id, { cur, rec, clr, st, recording: false });

    clr.addEventListener('click', () => {
      onHotkeyChange && onHotkeyChange(a.id, '');
    });
    rec.addEventListener('click', () => startRecording(a.id));
  }

  /*
   * 建完立刻填一次绑定显示。
   * 不补这一步的话，从面板建好到第一次 sync() 之间绑定列是空的 ——
   * 我第一次验证时看到的就是 6 行全是空白。
   */
  refreshHotkeys(
    hotkeyMap ? hotkeyMap() : {},
    hotkeyResults ? hotkeyResults() : []
  );
  /** 有没有修饰键 */
  const hasMod = (e) => e.ctrlKey || e.altKey || e.shiftKey || e.metaKey;
  /** 函数键与导航键可以单独用（不会抢走打字） */
  const STANDALONE = /^(F([1-9]|1[0-9]|2[0-4])|Home|End|PageUp|PageDown|Insert|Delete|MediaPlayPause|MediaNextTrack|MediaPreviousTrack|MediaStop)$/;

  /** 把一个 keydown 事件转成 Electron 的 accelerator 字符串 */
  function accelFromEvent(e) {
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return { pending: true };
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');

    let key = e.key;
    if (key === ' ') key = 'Space';
    else if (key === 'ArrowUp') key = 'Up';
    else if (key === 'ArrowDown') key = 'Down';
    else if (key === 'ArrowLeft') key = 'Left';
    else if (key === 'ArrowRight') key = 'Right';
    else if (key === 'Escape') key = 'Esc';
    else if (key.length === 1 && /[a-zA-Z0-9]/.test(key)) key = key.toUpperCase();
    else if (key.length === 1) return { error: '这个符号键请配一个修饰键' };

    /*
     * 没有修饰键时，只允许函数键 / 导航键 / 媒体键。
     * 否则用户录一个 "M" 就会把系统里所有的 M 都抢走 —— 打字都会触发播放。
     */
    if (!mods.length && !STANDALONE.test(key)) {
      return { error: '请加一个修饰键（Ctrl / Alt / Shift）' };
    }
    return { accel: mods.concat([key]).join('+') };
  }

  let recordingId = null;
  function stopRecording() {
    if (recordingId && keyRows.has(recordingId)) {
      const r = keyRows.get(recordingId);
      r.recording = false;
      r.rec.textContent = '录制';
      r.rec.classList.remove('recording');
      r.st.textContent = '';
    }
    recordingId = null;
    window.removeEventListener('keydown', onRecordKey, true);
  }

  function onRecordKey(e) {
    if (recordingId == null) return;
    e.preventDefault();
    e.stopPropagation();
    const id = recordingId;
    const r = keyRows.get(id);
    if (e.key === 'Escape') {
      stopRecording();
      return;
    }
    const got = accelFromEvent(e);
    if (got.pending) {
      r.st.textContent = '继续按…';
      return;
    }
    if (got.error) {
      r.st.textContent = got.error;
      return;
    }
    stopRecording();
    onHotkeyChange && onHotkeyChange(id, got.accel);
  }

  function startRecording(id) {
    stopRecording();
    recordingId = id;
    const r = keyRows.get(id);
    r.recording = true;
    r.rec.textContent = '按下组合键…';
    r.rec.classList.add('recording');
    r.st.textContent = 'Esc 取消';
    // 用捕获阶段，抢在其它键盘处理之前拿到按键
    window.addEventListener('keydown', onRecordKey, true);
  }

  /** 把当前绑定与注册结果刷到界面上 */
  function refreshHotkeys(map, results) {
    const res = new Map((results || []).map((x) => [x.action, x]));
    for (const [id, r] of keyRows) {
      const acc = String((map && map[id]) || '').trim();
      r.cur.textContent = acc || '未绑定';
      r.cur.classList.toggle('unbound', !acc);
      const info = res.get(id);
      if (!acc) r.st.textContent = '';
      else if (!info) r.st.textContent = '';
      else if (info.ok) r.st.textContent = '可用';
      else if (info.reason === 'duplicate') r.st.textContent = '和其它条重复';
      else if (info.reason === 'api-error') r.st.textContent = '接口异常';
      else r.st.textContent = '被占用';
      r.st.classList.toggle('bad', !!info && !info.ok);
    }
  }

  body.appendChild(secGlass.root);

  /*
   * ============ 分类 ============
   *
   * 原来五段小节全平铺在一列里，滚很久才找得到东西 ——
   * 用户的原话是"太乱了，太杂了"。
   * 这里在它们都建好之后按标题搬进分类页；各段的构建代码一行没动。
   */
  const GROUPS = [
    { id: 'look', name: '外观', titles: ['外观', '透明'] },
    { id: 'fx', name: '效果', titles: ['粒子效果'] },
    { id: 'beat', name: '节奏', titles: ['音频驱动'] },
    { id: 'perf', name: '性能', titles: ['流畅度'] },
    { id: 'keys', name: '热键', titles: ['全局热键'] },
  ];
  const tabs = el('div', 'sp-tabs');
  const pages = new Map();
  for (const g of GROUPS) {
    const btn = el('button', 'sp-tab');
    btn.type = 'button';
    btn.textContent = g.name;
    btn.dataset.group = g.id;
    btn.addEventListener('click', () => showGroup(g.id));
    tabs.appendChild(btn);
    const page = el('div', 'sp-page');
    page.dataset.group = g.id;
    pages.set(g.id, page);
  }

  /*
   * 按标题把小节搬进分类。
   * 用 :scope > 是为了只取直接子级 —— 小节里面还嵌着别的 section 时，
   * 不加这句会把内层的也一起搬到别的页里去。
   */
  for (const sec of Array.from(body.querySelectorAll(':scope > .sp-section'))) {
    const h3 = sec.querySelector('h3');
    const title = h3 ? h3.textContent.trim() : '';
    const g = GROUPS.find((x) => x.titles.includes(title));
    if (!g) continue;   // 没登记的段落留在原地，不会被弄丢
    pages.get(g.id).appendChild(sec);
  }

  // 先把还没被搬走的小节摘出来（否则会被 textContent='' 一起清掉）
  const leftOver = Array.from(body.querySelectorAll(':scope > .sp-section'));
  body.textContent = '';
  body.appendChild(tabs);
  for (const g of GROUPS) body.appendChild(pages.get(g.id));
  for (const s of leftOver) body.appendChild(s);   // 未登记的追加到最后，不至于消失

  function showGroup(id) {
    for (const [k, p] of pages) p.hidden = k !== id;
    for (const b of Array.from(tabs.children)) {
      b.classList.toggle('active', b.dataset.group === id);
    }
  }
  showGroup(GROUPS[0].id);

  const glassOpacity = slider('sp-glass', '面板不透明度', 0, 100, 1, (v) => update({ glassOpacity: v / 100 }));
  secGlass.body.appendChild(glassOpacity.root);

  const scrim = slider('sp-scrim', '文字压暗', 0, 160, 5, (v) => update({ scrim: v / 100 }));
  scrim.hint.textContent = '粒子很花时调高这个，文字更好读';
  secGlass.body.appendChild(scrim.root);

  /* -------- 底部 -------- */
  const foot = el('footer', 'sp-foot');
  const resetBtn = el('button', 'sp-reset', '恢复默认设置');
  resetBtn.addEventListener('click', () => {
    if (confirm('确定恢复全部默认设置？')) onReset();
  });
  foot.appendChild(resetBtn);
  panel.appendChild(foot);

  document.body.appendChild(overlay);

  /* -------- 滚动优化 --------
     面板带 backdrop-filter，而它要每帧重新模糊背后的粒子画布。
     滚动时浏览器每帧都要重算这块模糊 → 背景明显掉帧。
     做法：滚动期间临时关掉模糊、换成纯色底，停手 160ms 后再恢复玻璃质感。
     视觉上几乎察觉不到（滚动时本来就看不清背景），但帧率差别很大。 */
  let scrollTimer = 0;
  body.addEventListener(
    'scroll',
    () => {
      if (!panel.classList.contains('scrolling')) panel.classList.add('scrolling');
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => panel.classList.remove('scrolling'), 160);
    },
    { passive: true }
  );

  /* -------- 事件 -------- */
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) close();
  });

  const accentInput = accentRow.querySelector('#sp-accent');
  const accentNote = accentRow.querySelector('#sp-accent-note');
/*
   * ★ 手动选色和「跟着封面走」是**同一个东西的两个来源**，必须互斥。
   *
   * 之前两条都开着时，applySettings 里封面色优先级更高，
   * 用户选了色却"不生效" —— 看起来像 bug（用户就是这么反馈的）。
   * 现在选了手动色就自动把封面取色关掉，意图明确，也不会有"谁覆盖谁"的疑问。
   */
  accentInput.addEventListener('input', () =>
    update({ accentOverride: accentInput.value, coverAccent: false })
  );
  accentRow.querySelector('#sp-accent-reset').addEventListener('click', () =>
    update({ accentOverride: '', coverAccent: false })
  );

  let openState = false;

  /** 套用一个性能档位：把该档位的几项一次性设好 */
  function applyProfile(key) {
    const prof = PERF_PROFILES[key];
    if (!prof) return;
    update({ perfProfile: key, ...structuredClone(prof.patch) });
  }

  function open() {
    openState = true;
    sync();
    overlay.classList.add('open');
  }

  function close() {
    openState = false;
    overlay.classList.remove('open');
  }

  function isOpen() {
    return openState;
  }

  function toggleOpen() {
    if (openState) close();
    else open();
  }

  /** 把当前设置回填到控件 */
  function sync() {
    /*
     * 热键那一栏要在每次 sync 时刷新 —— 注册结果是异步从主进程回来的，
     * 不能只在构建时读一次（那时还没有结果）。
     */
    try {
      refreshHotkeys(
        hotkeyMap ? hotkeyMap() : {},
        hotkeyResults ? hotkeyResults() : []
      );
    } catch (e) {
      console.warn('[设置] 刷新热键显示失败:', e && e.message);
    }
    const s = getSettings();

    themeGrid.querySelectorAll('.theme-card').forEach((c) => c.classList.toggle('active', c.dataset.theme === s.theme));
    /*
     * 「配色跟着封面走」和「手动强调色」的关系 —— 我在这上面来回改了四轮，
     * 结论写死在这里，别再动了：
     *
     *   v1 两个来源共存、封面静默优先        → "选了不生效"
     *   v2 把选择器禁用 + 压暗              → "根本选不了"
     *   v3 永远可用、显示当前生效色、选色即接管 → **用户认可这一版**（"选别的颜色变成别的颜色"）
     *   v4 干脆把整行隐藏                   → "哪不见了 / 还是没变化"（连选都选不了，最差）
     *
     * 所以：**选择器永远可见、永远可用，绝不禁用、绝不隐藏。**
     * 开着封面取色时它显示"当前真正生效的封面色"（不让控件说谎），
     * 一选就自动切成手动并立刻生效 —— 一步完成，不需要先去关开关。
     *
     * 教训：**用户要的是"我能操作，而且立刻看到结果"，
     * 不是"你把容易混淆的东西藏起来"。**
     */
    const coverOn = !!s.coverAccent && !!s.coverAccentColor;
    accentInput.value =
      (coverOn ? s.coverAccentColor : s.accentOverride) ||
      THEMES[s.theme]?.ui['--accent'] ||
      '#E8C87A';
    accentRow.hidden = false;
    if (accentNote) {
      accentNote.textContent = coverOn ? '当前由封面决定 · 选色即切换为手动' : '';
    }

    const on = s.particles.enabled;
    particleToggle.set(on);
    /*
     * 封面取色开关也要显式同步。
     *
     * 漏了这一句的后果很具体：用户拖一下颜色，内容其实已经切成手动了
     *（accent 变了、说明文字也清了），**但开关还显示"开"** ——
     * 控件之间的状态自相矛盾，比原来的问题更让人迷惑。
     */
    coverAccent.set(!!s.coverAccent);

    // 性能档位高亮（手动改过细项后会是 'custom'，此时都不亮）
    for (const [key, card] of profileCards) {
      card.classList.toggle('active', s.perfProfile === key);
    }

    albumToggle.set(s.albumBackground);
    albumOpacity.set(s.albumBgOpacity * 100);
    albumOpacity.root.classList.toggle('disabled', !s.albumBackground);
    albumOpacity.input.disabled = !s.albumBackground;

    for (const [key, card] of effectCards) {
      card.classList.toggle('active', key === s.effect);
      card.classList.toggle('disabled', !on);
    }

    density.set(s.particles.density * 100);
    pulse.set(s.particles.pulseIntensity * 100);
    motion.set(s.particles.motionSpeed * 100);
    sens.set(s.beat.sensitivity * 100);
    gain.set(s.beat.gain * 100);
    minInt.set(s.beat.minInterval);
    bandLow.set(s.beat.bandLow);
    bandHigh.set(s.beat.bandHigh);
    renderScale.set(s.particles.renderScale * 100);
    autoQuality.set(s.particles.autoQuality);
    bloom.set(s.particles.bloom);
    bloomStrength.set(s.particles.bloomStrength * 100);
    bloomThreshold.set(s.particles.bloomThreshold * 100);
    blur.set(s.glassBlur);
    glassOpacity.set(s.glassOpacity * 100);
    scrim.set(s.scrim * 100);

    // 泛光关掉时，下面两个参数变灰
    for (const node of [bloomStrength.root, bloomThreshold.root]) {
      node.classList.toggle('disabled', !s.particles.bloom);
    }
    bloomStrength.input.disabled = !s.particles.bloom;
    bloomThreshold.input.disabled = !s.particles.bloom;

    // 粒子关掉时，跟粒子相关的项变灰但仍可见（让用户知道它们还在）
    for (const node of [effectGrid, density.root, pulse.root, motion.root, renderScale.root, autoQuality.root, bloom.root]) {
      node.classList.toggle('disabled', !on);
    }
    density.input.disabled = !on;
    pulse.input.disabled = !on;
    motion.input.disabled = !on;
    renderScale.input.disabled = !on;
    autoQuality.input.disabled = !on;
    bloom.input.disabled = !on;
  }

  /** 实时帧率显示 */
  function setFps(fps, scale) {
    fpsBadge.textContent = `${fps} FPS${scale < 0.99 ? ` · ${Math.round(scale * 100)}%` : ''}`;
    fpsBadge.classList.toggle('warn', fps < 45);
  }

  return { open, close, toggleOpen, isOpen, sync, setFps, overlay, refreshHotkeys };
}

/* ------------------------------------------------------------------ */
/* 控件工厂                                                            */
/* ------------------------------------------------------------------ */

function section(title, hint) {
  const root = el('section', 'sp-section');
  const head = el('div', 'sp-section-head');
  head.innerHTML = `<h3>${title}</h3>${hint ? `<p>${hint}</p>` : ''}`;
  const body = el('div', 'sp-section-body');
  root.appendChild(head);
  root.appendChild(body);
  return { root, body };
}

function slider(id, label, min, max, step, onInput) {
  const root = el('div', 'sp-row sp-row-slider');
  root.innerHTML = `
    <label for="${id}">${label}</label>
    <div class="sp-controls">
      <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" />
      <output class="sp-value"></output>
    </div>`;

  const input = root.querySelector('input');
  const out = root.querySelector('output');
  const hint = el('p', 'sp-hint');
  root.appendChild(hint);

  input.addEventListener('input', () => {
    out.textContent = input.value;
    onInput(Number(input.value));
  });

  return {
    root,
    input,
    hint,
    set(v) {
      input.value = String(v);
      out.textContent = String(Math.round(v));
    },
  };
}

function toggle(id, label, onChange) {
  const root = el('div', 'sp-row sp-row-toggle');
  root.innerHTML = `<label for="${id}">${label}</label><input type="checkbox" id="${id}" class="sp-switch" />`;
  const input = root.querySelector('input');
  const hint = el('p', 'sp-hint');
  root.appendChild(hint);

  input.addEventListener('change', () => onChange(input.checked));

  return {
    root,
    input,
    hint,
    set(v) {
      input.checked = Boolean(v);
    },
  };
}