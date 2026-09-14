import { ParticleStage } from './particles.js';
import { loadSettings, saveSettings, applySettings, DEFAULT_SETTINGS, PERF_PROFILES } from './settings.js';
import { EFFECT_LIST } from './effects.js';
import { mountSettingsPanel } from './settings-panel.js';
import { LyricView, parseLyrics } from './lyrics.js';

/**
 * 界面入口
 *
 * 与音源核心的通信：桌面端走 Electron 主进程的 IPC（window.api），
 * 请求由 Node 发出，不受浏览器同源策略限制，所以不需要任何跨域代理。
 *
 * 不用打包器，所以这里是原生 ES 模块（详见 particles.js 顶部说明）。
 */

/* ------------------------------------------------------------------ */
/* 与主进程通信                                                        */
/* ------------------------------------------------------------------ */

async function httpFallback(path, init) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...(init || {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const api = window.api || {
  account: () => httpFallback('/account'),
  playlists: () => httpFallback('/playlists'),
  playlistTracks: (id) => httpFallback(`/playlist/${encodeURIComponent(id)}/tracks`),
  search: (kw) => httpFallback(`/search?kw=${encodeURIComponent(kw)}`),
  stream: (song) => httpFallback('/stream', { method: 'POST', body: JSON.stringify(song) }),
  lyric: (song) => httpFallback('/lyric', { method: 'POST', body: JSON.stringify(song) }),
  recommend: () => httpFallback('/recommend'),
  ranks: () => httpFallback('/ranks'),
  rankTracks: (id) => httpFallback(`/rank/${encodeURIComponent(id)}`),
  loginQrCreate: () => httpFallback('/login/qr', { method: 'POST' }),
  loginQrCheck: (key) => httpFallback(`/login/qr/${encodeURIComponent(key)}`),
  favoriteHashes: () => httpFallback('/favorites'),
  like: (song) => httpFallback('/like', { method: 'POST', body: JSON.stringify(song) }),
  unlike: (song) => httpFallback('/unlike', { method: 'POST', body: JSON.stringify(song) }),
};

/* ------------------------------------------------------------------ */
/* DOM 工具                                                            */
/* ------------------------------------------------------------------ */

const $ = (sel) => {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`找不到元素: ${sel}`);
  return el;
};
/**
 * 和 $() 一样，但找不到时返回 null 而不是抛错。
 * 用于"按状态决定要不要显示"的区块：那些节点可能在重构中被删掉，
 * 那种情况下静默跳过比让整个渲染流程炸掉更合适。
 */
const $maybe = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let toastTimer = 0;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2800);
}

const fmtDur = (sec) => {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

const QUICK_QUALITY = { 128: '标准', 320: '较高', flac: '无损' };

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

const state = {
  queue: [],
  index: -1,
  playlists: [],
  currentSong: null,
  quality: Number(localStorage.getItem('music-player.quality')) || 128,
  ranks: [],
};

/* ------------------------------------------------------------------ */
/* 歌词时间轴偏移（学自 Mineradio 的 lyric-timing-control）             */
/* 偏移按歌曲 hash 分别记住：每首歌的对齐情况不一样                     */
/* ------------------------------------------------------------------ */

const TIMING_KEY = 'music-player.lyric-timing.v1';

function loadTimings() {
  try {
    return JSON.parse(localStorage.getItem(TIMING_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

const timings = loadTimings();

function getTiming(hash) {
  return Number(timings[hash]) || 0;
}

function setTiming(hash, offset) {
  if (!hash) return;
  const v = Math.round(offset * 10) / 10;
  if (Math.abs(v) < 0.05) delete timings[hash];
  else timings[hash] = v;
  try {
    localStorage.setItem(TIMING_KEY, JSON.stringify(timings));
  } catch {
    /* 写不进去就只在本次会话生效 */
  }
  updateTimingUI();
}

function updateTimingUI() {
  const v = state.currentSong ? getTiming(state.currentSong.hash) : 0;
  $('#timing-value').textContent = `${v > 0 ? '+' : ''}${v.toFixed(1)}s`;
  $('#timing-value').classList.toggle('changed', Math.abs(v) > 0.05);
}

/* ------------------------------------------------------------------ */
/* 专辑封面氛围背景                                                    */
/* ------------------------------------------------------------------ */

let albumFront = null;

function setAlbumBackground(url) {
  const a = document.getElementById('album-bg');
  const b = document.getElementById('album-bg-next');
  if (!a || !b) return;

  if (!settings.albumBackground || !url) {
    a.classList.remove('visible');
    b.classList.remove('visible');
    albumFront = null;
    return;
  }

  const target = `url("${url}")`;
  if (albumFront && albumFront.style.backgroundImage === target) return;

  const back = albumFront === a ? b : a;
  back.style.backgroundImage = target;
  void back.offsetWidth; // 强制重排，保证过渡从 0 开始
  back.classList.add('visible');
  if (albumFront) albumFront.classList.remove('visible');
  albumFront = back;
}

/* ------------------------------------------------------------------ */
/* 设置 + 粒子舞台                                                     */
/* ------------------------------------------------------------------ */

let settings = loadSettings();

const HOTKEY_ACTIONS = [
  { id: 'playpause', label: '播放 / 暂停', def: 'Alt+F5' },
  { id: 'prev', label: '上一首', def: 'Alt+Home' },
  { id: 'next', label: '下一首', def: 'Alt+End' },
  { id: 'volup', label: '音量增加', def: 'Alt+PageUp' },
  { id: 'voldown', label: '音量降低', def: 'Alt+PageDown' },
  { id: 'mute', label: '静音开关', def: 'Alt+M' },
  // Alt+D（Desktop）：Alt+L 被窗口内的「播放模式」占了，不能重复
  { id: 'lyric', label: '桌面歌词开关', def: 'Alt+D' },
];
let bg = null;
let palette = null;

/**
 * 上一次应用的"主题|强调色"签名。
 *
 * 用来判断粒子配色是否真的需要重涂 —— 涂色是给每颗粒子重新随机取色，
 * 只在主题或强调色变化时才做，否则拖滑杆会让粒子颜色乱闪。
 */
let lastPaletteKey = '';

/**
 * 粒子配色的"签名"。
 *
 * 只此一份 —— 之前这个字符串在三个地方各写了一遍，其中两处漏了封面取色，
 * 于是"启动时算的 key"和"改设置时算的 key"永远对不上：要么该重涂时不涂
 *（界面一个色、粒子另一个色），要么不该涂时白涂一次（粒子会闪一下）。
 */
function paletteKeyOf(s) {
  return [s.theme, s.accentOverride || '', s.coverAccent ? s.coverAccentColor || '' : ''].join('|');
}
/** 当前是否应该让封面聚拢成形（只有「正在播放」页是）。重建舞台后要用它恢复。 */
let coverFocusWanted = false;

/** 按当前设置重建粒子舞台（只在开关粒子时需要，因为要换 canvas） */
function buildBackground() {
  destroyBackground();

  if (!settings.particles.enabled) {
    document.getElementById('bg').style.opacity = '0';
    return;
  }

  const old = document.getElementById('bg');
  const fresh = document.createElement('canvas');
  fresh.id = 'bg';
  fresh.style.opacity = '1';
  old.replaceWith(fresh);

  bg = new ParticleStage(fresh, {
    effect: settings.effect,
    density: settings.particles.density,
    autoQuality: settings.particles.autoQuality,
    bloom: settings.particles.bloom,
    bloomStrength: settings.particles.bloomStrength,
    bloomThreshold: settings.particles.bloomThreshold,
    bloomMode: settings.particles.bloomMode,
    pulseIntensity: settings.particles.pulseIntensity,
    motionSpeed: settings.particles.motionSpeed,
    maxFps: settings.particles.maxFps,
  });
  bg.setRenderScale(settings.particles.renderScale);
  if (palette) bg.setPalette(palette);
  bg.setCoverFocus(coverFocusWanted ? 1 : 0);
  setupMediaSession();
  applyCoverShift();
  bg.onStats = (fps, scale) => {
    if (settingsPanel && settingsPanel.isOpen()) settingsPanel.setFps(fps, scale);
    updateFpsChip(fps, scale);
  };

  // 舞台是新的，封面层要重新喂一次，否则换设置后封面就没了
  if (state.currentSong) void setCoverForSong(state.currentSong);
}

function destroyBackground() {
  if (!bg) return;
  bg.dispose();
  bg = null;
}

function applyRuntimeSettings(prev) {
  if (!bg) return;
  if (settings.particles.renderScale !== prev.renderScale) bg.setRenderScale(settings.particles.renderScale);
  if (settings.particles.autoQuality !== prev.autoQuality) bg.setAutoQuality(settings.particles.autoQuality);

  // 泛光和律动都是运行时可调的，不用重建粒子
  if (
    settings.particles.bloom !== prev.bloom ||
    settings.particles.bloomStrength !== prev.bloomStrength ||
    settings.particles.bloomThreshold !== prev.bloomThreshold
  ) {
    bg.setBloom(settings.particles.bloom, settings.particles.bloomStrength, settings.particles.bloomThreshold);
  }
  if (settings.particles.pulseIntensity !== prev.pulseIntensity) {
    bg.setPulseIntensity(settings.particles.pulseIntensity);
  }
  if (settings.particles.motionSpeed !== prev.motionSpeed) {
    bg.setMotionSpeed(settings.particles.motionSpeed);
  }
  if (settings.particles.maxFps !== prev.maxFps) {
    bg.setMaxFps(settings.particles.maxFps);
  }
}

/** 档位涉及的那些细项 —— 单独改任意一项，档位就变成"自定义" */
const PROFILE_TOP_KEYS = ['glassBlur'];
const PROFILE_PARTICLE_KEYS = ['density', 'bloom', 'bloomStrength', 'renderScale', 'autoQuality'];

function touchedProfileKnobs(patch) {
  if (!patch || patch.perfProfile !== undefined) return false;
  if (PROFILE_TOP_KEYS.some((k) => patch[k] !== undefined)) return true;
  const p = patch.particles || {};
  return PROFILE_PARTICLE_KEYS.some((k) => p[k] !== undefined);
}

function updateSettings(patch) {
  const before = {
    effect: settings.effect,
    density: settings.particles.density,
    enabled: settings.particles.enabled,
    renderScale: settings.particles.renderScale,
    autoQuality: settings.particles.autoQuality,
    bloom: settings.particles.bloom,
    bloomStrength: settings.particles.bloomStrength,
    bloomThreshold: settings.particles.bloomThreshold,
    bloomMode: settings.particles.bloomMode,
    pulseIntensity: settings.particles.pulseIntensity,
    motionSpeed: settings.particles.motionSpeed,
    maxFps: settings.particles.maxFps,
    albumBackground: settings.albumBackground,
  };

  settings = deepMergeSettings(settings, patch);
  // 单独改了档位覆盖的细项，档位就变成"自定义"
  if (touchedProfileKnobs(patch)) settings.perfProfile = 'custom';

  palette = applySettings(settings);
  /*
   * 探测脚本改设置时**不要存盘**。
   *
   * 自动探测（切档位测性能之类）会走 updateSettings，而它会存盘 ——
   * 结果就是我为了验证而跑的脚本把用户的真实设置改掉并存进了存档。
   * 已经实际踩过：一轮探测跑完，专辑氛围背景、粒子密度、泛光都被改了，
   * 而且如果探测被中途打断，连"还原"那一步都不会执行。
   */
  if (!suppressSettingsSave) saveSettings(settings);

  /*
   * 换主题 / 换强调色要**立刻重新给粒子上色**。
   *
   * 这里是第二个脱节：`bg.setPalette()` 原本只在 `buildBackground()` 里调用过，
   * 也就是只有"开关粒子/换泛光实现"这种重建舞台的场合才会执行。
   * 而换主题走的是 updateSettings —— 只更新了 CSS 变量，粒子颜色因此从不刷新，
   * 表现就是"换了外观色，界面变了但粒子还是原来的颜色"。
   *
   * 用 theme|accent 当签名做比较，而不是每次都重涂：涂色会给每颗粒子
   * 重新随机取色，如果每次拖动滑杆都涂一遍，粒子颜色会跟着乱闪。
   *
   * ★ 这个 key 必须包含**当前真正生效的强调色**，而不只是 accentOverride。
   *
   * 漏掉封面取色的后果是"界面和粒子各说各话"：
   * 开着封面取色时一关开关，--accent 变了、粒子没变（key 没变，被这一句拦下），
   * 再打开也一样 —— 用户看到的就是"再关再开没变，甚至两种颜色叠在一起"。
   * 换歌时之所以正常，是因为 applyCoverAccent 里是**直接调** bg.setPalette()，
   * 绕过了这个判断。两条路走法不一致，就成了这个 bug。
   */
  const paletteKey = paletteKeyOf(settings);
  if (paletteKey !== lastPaletteKey) {
    lastPaletteKey = paletteKey;
    if (bg) bg.setPalette(palette);
  }

  const after = settings.particles;

  if (before.enabled !== after.enabled) {
    // 只有"开关粒子"才需要换 canvas，重建整个舞台
    buildBackground();
  } else if (before.bloomMode !== after.bloomMode) {
    // 换泛光实现要重建整条后处理链（pass 本身不一样），必须重建舞台
    buildBackground();
  } else if (bg) {
    // 换效果 / 改密度只在现有舞台上重建几何。
    // 之前这里连舞台一起重建，导致封面层被一起销毁 —— 换风格封面就没了。
    if (before.effect !== settings.effect) {
      if (window.__mpMark) window.__mpMark('换效果');
      bg.setEffect(settings.effect);
    }
    else if (before.density !== after.density) bg.setDensity(after.density);
    applyRuntimeSettings(before);
  }

  // 氛围背景开关变了要立刻生效
  if (before.albumBackground !== settings.albumBackground) {
    if (!settings.albumBackground) setAlbumBackground(null);
    else setAlbumBackground(state.currentSong && state.currentSong.cover);
  }

  if (settingsPanel) settingsPanel.sync();
}

function deepMergeSettings(base, patch) {
  const out = { ...base };
  for (const k of Object.keys(patch || {})) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = { ...(base[k] || {}), ...v };
    else out[k] = v;
  }
  return out;
}

palette = applySettings(settings);
// 记住启动时的配色签名，避免第一次改设置时多做一次无谓的重涂
lastPaletteKey = paletteKeyOf(settings);
buildBackground();

const settingsPanel = mountSettingsPanel({
  getSettings: () => settings,
  update: updateSettings,
  /*
   * 热键编辑器要的三样：动作表、当前生效的绑定、上一次注册的结果。
   * 结果由 applyGlobalHotkeys 写进 globalThis，因为它是异步回来的。
   */
  hotkeyActions: HOTKEY_ACTIONS,
  hotkeyMap: () => ({ ...defaultHotkeyBindings(), ...(settings.hotkeys || {}) }),
  hotkeyResults: () => globalThis.__hotkeyResults || [],
  onHotkeyChange: (id, accel) => setHotkey(id, accel),
  onReset: () => {
    settings = structuredClone(DEFAULT_SETTINGS);
    palette = applySettings(settings);
    lastPaletteKey = paletteKeyOf(settings);
    saveSettings(settings);
    buildBackground();
    settingsPanel.sync();
    toast('已恢复默认设置');
  },
});

/* ------------------------------------------------------------------ */
/* 播放器                                                              */
/* ------------------------------------------------------------------ */

const audio = $('#audio');
const lyricView = new LyricView($('#np-lyric'));

/**
 * 更新封面粒子
 *
 * 封面不是独立的一块画布，而是主粒子场景里的一层：
 * 没有封面（或跨域加载失败）时，退回程序化画的一张唱片当采样源。
 */
/**
 * 把"此刻该显示的大字"喂给 3D 舞台（封面前面那块 billboard）。
 *
 * 优先级：当前歌词行 > 没有歌词就退回歌名。
 * 副行放歌名，于是"有歌词时"上面是歌词、下面是歌名，
 * 没歌词时就是歌名 + 歌手 —— 和 Mineradio 那种构图一致。
 *
 * 每次都调用是安全的：setStageText 内部先做字符串比较，
 * 没变就直接返回，不会重绘画布、也不会重传纹理。
 */
function updateStageText() {
  if (!bg || !bg.setStageText) return;
  const song = state.currentSong;
  let line = '';
  try {
    const el = lyricView.lineEls && lyricView.lineEls[lyricView.activeLine];
    if (el) line = String(el.textContent || '').trim();
  } catch {
    line = '';
  }
  /*
   * ★ 全屏歌词页的高亮在这里同步。
   *
   * 选这里的理由：updateStageText() 是**每次 timeupdate 的唯一汇合点**，
   * 而且它已经在读 lyricView.activeLine。挂在 lyricView.update() 的
   * 四个调用点上的话，漏一处就会有一处不同步。
   */
  syncFullLyrics();

  /*
   * 全屏歌词开着时，3D 舞台上的文字要**保持空白** ——
   * 那里的歌词和歌名是给"正在播放"页用的，全屏歌词时和浮层重复。
   * 放在 syncFullLyrics 之后、真正设置之前，所以每帧都会维持空白。
   */
  if (flOpen) {
    bg.setStageText('', '');
    return;
  }

  if (line && song) bg.setStageText(line, song.name);
  else if (song) bg.setStageText(song.name, song.artist || '');
  else bg.setStageText('', '');

  /*
   * 顺手把同一份结果推给**桌面歌词窗口**。
   *
   * 为什么在这里推而不是在 timeupdate 里单独算一遍：
   * 当前行是 lyricView 算出来的（逐字歌词、时间轴微调都在它手上），
   * 在这儿取是"已经算好的那一份"。再算一遍必然出现两处逻辑不一致 ——
   * 主界面显示的和桌面歌词显示的迟早会对不上。
   *
   * 下一行也一起推：桌面歌词显示"当前 + 下一句"比只有一句好用得多。
   */
  if (window.api && window.api.desktopLyric) {
    let next = '';
    /*
     * 已唱到第几个字：直接数当前行里 .on 的字符数。
     * **不要去重新解析歌词的时间轴** —— 软件内显示到第几个字，
     * 是 lyricView 算出来的那一份，这里照抄它才不会两边不一致。
     */
    let lit = -1;
    try {
      const nEl = lyricView.lineEls && lyricView.lineEls[lyricView.activeLine + 1];
      if (nEl) next = String(nEl.textContent || '').trim();

      /*
       * ★ 只有"显示的就是那一行歌词"时，进度才有意义。
       *
       * line 为空 = 当前没有歌词（间奏、或还没开始），这时界面显示的是**歌名**。
       * 而进度若照抄 lyricView，拿到的是**另一行**（往往是刚唱完的上一句，
       * 比如 6 个字都亮着）—— 把 6/7 套到 7 个字的歌名上，
       * 结果就是最后一个字被判成"还没唱到"，显示成灰的。
       * 用户看到的正是这个：**"为什么赏是灰色的"**。
       *
       * 歌名没有"唱到第几个字"这回事，所以这种情况一律给 -1（整句全亮）。
       */
      if (line) {
        const el = lyricView.lineEls && lyricView.lineEls[lyricView.activeLine];
        if (el) lit = el.querySelectorAll('.lyric-char.on').length;
      }
    } catch {}

    /*
     * 强调色要跟着数据走：主界面的强调色会随封面变（"配色跟着封面走"），
     * 歌词窗口没有这套 CSS 变量，只能由这边算好推过去 ——
     * 否则桌面上的歌词和软件内的歌词会不同色。
     */
    let accent = '';
    let accentRgb = '';
    try {
      const cs = getComputedStyle(document.documentElement);
      accent = (cs.getPropertyValue('--accent-ink') || cs.getPropertyValue('--accent') || '').trim();
      accentRgb = (cs.getPropertyValue('--accent-rgb') || '').trim();
    } catch {}

    /*
     * 连续进度：0~1；-1 表示"显示的不是歌词行"（比如歌名）。
     * 优先取按时间插值的值，拿不到就退回"已唱字数/总字数"。
     */
    let progress = -1;
    try {
      if (line && audio && Number.isFinite(audio.currentTime)) {
        progress = lyricView.lineProgress(audio.currentTime);
      }
    } catch {}
    if (progress < 0 && lit >= 0 && line) {
      progress = Math.min(1, lit / Math.max(1, Array.from(line).length));
    }

    /*
     * 节拍值：直接取舞台那一份（bg.pulseValue）。
     * **不要去另算一个** —— 粒子背景的起伏、舞台文字的呼吸都是用它，
     * 桌面歌词如果用另一个来源，两边的"节拍"迟早会对不上，
     * 看起来就是"歌词和背景各跳各的"。
     */
    let pulseNow = 0;
    try {
      pulseNow = bg && Number.isFinite(bg.pulseValue) ? bg.pulseValue : 0;
    } catch {}

    void window.api.desktopLyric.push({
      text: line || (song ? song.name : ''),
      next,
      lit,
      progress,
      pulse: pulseNow,
      accent,
      accentRgb,
      title: song ? song.name : '',
      artist: song ? song.artist || '' : '',
    });
  }
}

/* ------------------------------------------------------------------ */
/* 桌面歌词开关                                                        */
/* ------------------------------------------------------------------ */

/*
 * 状态从主进程回读，而不是在渲染进程里自己记一份 ——
 * 歌词窗口可能被别的方式打开/关闭（托盘、快捷键、双击穿透），
 * 本地记一份迟早会和真实状态不一致，按钮就会显示成反的。
 */
async function syncLyricChip() {
  if (!window.api || !window.api.desktopLyric) return;
  try {
    const on = await window.api.desktopLyric.visible();
    $('#lyric-chip').classList.toggle('on', !!on);
  } catch {}
}

async function toggleDesktopLyric() {
  if (!window.api || !window.api.desktopLyric) return;
  const on = await window.api.desktopLyric.visible();
  await window.api.desktopLyric.toggle(!on);
  await syncLyricChip();
  // 开的时候立刻推一次当前歌词，不然要等到下一句才换字
  if (!on) updateStageText();
}

$('#lyric-chip').addEventListener('click', () => void toggleDesktopLyric());


void syncLyricChip();


/* ------------------------------------------------------------------ */
/* 系统媒体控制（SMTC / 媒体键）                                       */
/* ------------------------------------------------------------------ */

/**
 * 把当前歌曲同步到系统媒体面板。
 * 每次换歌、以及播放/暂停时都要调 —— 面板上的歌名和进度就是靠它。
 */
function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const song = state.currentSong;
  if (!song) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.name || '未知歌曲',
      artist: song.artist || '未知歌手',
      album: song.album || '',
      artwork: song.cover
        ? [{ src: song.cover, sizes: '512x512', type: 'image/jpeg' }]
        : [],
    });
  } catch {
    /* 封面跨域等情况会让 MediaMetadata 抛错，不能让它影响播放 */
  }
}

/**
 * 同步进度条。
 *
 * 只在 duration 是有限正数时才调 —— timeupdate 在元数据到位之前就会触发，
 * 那时候 duration 是 NaN，直接设进去 setPositionState 会抛错（而且每次都抛）。
 */
function updateMediaPosition() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  if (typeof ms.setPositionState !== 'function') return;
  const dur = audio.duration;
  if (!Number.isFinite(dur) || dur <= 0) return;
  try {
    ms.setPositionState({
      duration: dur,
      position: Math.min(dur, Math.max(0, audio.currentTime || 0)),
      playbackRate: audio.playbackRate || 1,
    });
  } catch {
    /* 位置越界等边界情况，忽略即可 */
  }
}

/** 注册系统面板上的按钮。每一项都单独 try —— 某个动作不支持不该拖垮其余的。 */
function setupMediaSession() {
  if (!('mediaSession' in navigator)) {
    console.log('[媒体] 这个环境没有 Media Session，系统面板/媒体键不可用');
    return;
  }
  const ms = navigator.mediaSession;
  const set = (name, fn) => {
    try {
      ms.setActionHandler(name, fn);
    } catch {
      /* 个别动作不支持是正常的（比如 stop） */
    }
  };
  set('play', () => void audio.play());
  set('pause', () => audio.pause());
  set('stop', () => audio.pause());
  set('previoustrack', () => playAt(prevIndex(), 'prev'));
  set('nexttrack', () => playAt(nextIndex(), 'next'));
  set('seekto', (d) => {
    if (d && Number.isFinite(d.seekTime)) audio.currentTime = d.seekTime;
  });
  set('seekbackward', (d) => {
    audio.currentTime = Math.max(0, audio.currentTime - ((d && d.seekOffset) || 10));
  });
  set('seekforward', (d) => {
    const dur = audio.duration || 0;
    audio.currentTime = Math.min(dur, audio.currentTime + ((d && d.seekOffset) || 10));
  });
  console.log('[媒体] 已接入系统媒体控制（SMTC）');
}


/* ------------------------------------------------------------------ */
/* 全局热键（动作表 + 注册）                                           */
/* ------------------------------------------------------------------ */

/**
 * 可绑定的动作。默认加速键参考 Mineradio 那套（Alt 组合，冲突少）。
 *
 * 说明：动作的**执行**必须在这里，不能放主进程 ——
 * 队列、当前歌、音量这些状态都在渲染进程，主进程拿不到。
 * 所以主进程只做"按键 → 发动作名"这一段。
 */

/** 一条热键的默认绑定 */
function defaultHotkeyBindings() {
  const out = {};
  for (const a of HOTKEY_ACTIONS) out[a.id] = a.def;
  return out;
}

function doHotkeyAction(action) {
  switch (action) {
    case 'playpause':
      $('#pb-toggle').click();
      break;
    case 'prev':
      playAt(prevIndex(), 'prev');
      break;
    case 'next':
      playAt(nextIndex(), 'next');
      break;
    case 'volup':
      // state.volume 是 0~1，步长跟音量滚轮保持一致（0.05）
      setVolume(state.volume + 0.05);
      break;
    case 'voldown':
      setVolume(state.volume - 0.05);
      break;
    case 'lyric':
      // 桌面歌词：复用播放条那个按钮的同一条路径（它会先回读真实状态再切）
      void toggleDesktopLyric();
      break;
    case 'mute':
      /*
       * 直接复用音量按钮那条路径，不要自己手搓。
       *
       * 我第一版写的是 setVolume(state.muted ? state.volume || 60 : 0) ——
       * 单位就错了（state.volume 是 0~1，"60" 在 clamp01 之后变成 1），
       * 而且没有 _lastVolume 那套记忆，所以只能关、不能开。
       * 按钮的处理函数本来就做了"静音前记住原音量、取消时恢复"，
       * 点它一次即可。
       */
      $('#vol-btn').click();
      break;
    default:
      console.warn('[热键] 未知动作:', action);
  }
}

/**
 * 把设置里的绑定表推给主进程注册，并回读逐条结果。
 *
 * 空绑定直接跳过 —— 让用户能"清空某一条"而不是必须绑一个键。
 * 结果（ok / 被占用）存到 globalThis 上，设置面板要用。
 */
async function applyGlobalHotkeys() {
  if (!window.api || !window.api.hotkeys) return;
  /*
   * 必须**合并**，不能二选一。
   * settings.hotkeys 只是"用户改过的那些"，缺的要用默认值补上；
   * 写成 `settings.hotkeys || defaultHotkeyBindings()` 的话，
   * 用户只要改过一条，其余动作的默认绑定就全丢了。
   * 空串是"这条显式不绑定"，下面按 falsy 跳过即可。
   */
  const map = { ...defaultHotkeyBindings(), ...(settings.hotkeys || {}) };
  const bindings = [];
  for (const a of HOTKEY_ACTIONS) {
    const acc = String(map[a.id] || '').trim();
    if (acc) bindings.push({ action: a.id, accelerator: acc });
  }
  try {
    const results = await window.api.hotkeys.configure(bindings);
    globalThis.__hotkeyResults = results || [];
    const bad = (results || []).filter((r) => !r.ok);
    console.log(
      '[热键] 注册 ' + (results || []).length + ' 条' +
        (bad.length ? '，其中 ' + bad.length + ' 条被占用' : '，全部可用')
    );
  } catch (e) {
    console.warn('[热键] 配置失败:', e && e.message);
  }
}

/**
 * 改一条热键绑定：写进设置 → 立刻重新注册 → 把结果推回界面。
 *
 * 存的是**覆盖表**：只记用户改过的那几条，缺的用默认值补。
 * 于是以后要调整默认组合，没被动过的那些会跟着变，改过的不会被覆盖。
 * 空串表示"这条显式不绑定"。
 */
function setHotkey(actionId, accelerator) {
  if (!actionId) return;
  const next = { ...(settings.hotkeys || {}) };
  const acc = String(accelerator || '').trim();
  if (acc) next[actionId] = acc;
  else next[actionId] = '';   // 显式留空，而不是删掉（删掉会退回默认值）
  settings.hotkeys = next;
  saveSettings(settings);
  void applyGlobalHotkeys().then(() => {
    if (settingsPanel && settingsPanel.refreshHotkeys) {
      settingsPanel.refreshHotkeys(
        { ...defaultHotkeyBindings(), ...(settings.hotkeys || {}) },
        globalThis.__hotkeyResults || []
      );
    }
  });
}

/* ------------------------------------------------------------------ */
/* 播放历史上报                                                        */
/* ------------------------------------------------------------------ */

/*
 * 不上报的话，「最近播放」永远只有你在酷狗官方客户端听过的歌 ——
 * 在这里听多少都不会变。用户反馈"最近播放也不会刷新"就是这个。
 *
 * 上报接口只要 { mxid, op, ot, pc }，**不带进度**（不像很多播放器要传秒数），
 * 所以每首歌报一次就够，不需要定时轮询。
 *
 * 两个必须的守卫：
 *   ① 同一首不重复报（暂停再播不该算又听了一遍）
 *   ② 启动恢复播放时**不报** —— 那只是"把上次的进度摆好"，
 *      每次都记一条的话，历史会被同一首歌刷屏
 */
let lastReportedMxid = 0;

function reportPlayHistory() {
  if (state.restoring) return;
  if (!window.api || !window.api.historyUpload) return;
  const s = state.currentSong;
  if (!s) return;
  const mxid = Number(s.mixSongId || s.albumAudioId || 0);
  if (!mxid || mxid === lastReportedMxid) return;
  lastReportedMxid = mxid;
  // 失败不影响播放，主进程那边已经把异常吞掉并返回 ok:false
  void api.historyUpload(mxid);
}

/* ------------------------------------------------------------------ */
/* 记住上次的音乐状态                                                  */
/* ------------------------------------------------------------------ */

const RESUME_KEY = 'mp.resume.v1';
/** 队列上限：只存前 300 首，免得 localStorage 被上千首撑爆 */
const RESUME_MAX_QUEUE = 300;

/**
 * 存一份"上次听到哪儿"。节流调用即可（定时 + 退出时各一次）。
 *
 * 为什么不每次 timeupdate 都存：那会每秒写好几次 localStorage，
 * 而 localStorage 是同步写、会卡主线程 —— 为了一个"恢复播放"不值当。
 */
function saveResume() {
  if (!state.currentSong) return;
  try {
    localStorage.setItem(
      RESUME_KEY,
      JSON.stringify({
        queue: state.queue.slice(0, RESUME_MAX_QUEUE),
        index: state.index,
        time: Number(audio.currentTime) || 0,
        volume: state.volume,
        muted: state.muted,
        playMode: state.playMode,
        savedAt: Date.now(),
      })
    );
  } catch {
    /* 配额满或隐私模式，忽略即可 */
  }
}

/**
 * 恢复上次的状态。
 *
 * 刻意**不自动播放**：开机就突然出声会吓人，而且用户多半不是马上想听。
 * 所以是"把歌和进度摆好、停在暂停"，按一下播放就能接着听。
 */
async function restoreResume() {
  let s = null;
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    if (!raw) return false;
    s = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!s || !Array.isArray(s.queue) || !s.queue.length) return false;
  try {
    state.queue = s.queue;
    state.index = Math.max(0, Math.min(s.queue.length - 1, Number(s.index) || 0));
    if (s.playMode) state.playMode = s.playMode;
    renderQueue();
    /*
     * ★ 恢复期间必须**从 DOM 层静音**。
     *
     * 原因：playAt 会真的开始播放（audio.play()），我随后才 seek + pause。
     * 中间那段时间声音已经出去了 —— 用户听到的就是"开软件瞬间响一下"。
     *
     * 用 audio.muted 而不是 state.muted：前者是 DOM 的静音开关，
     * 而 applyVolume() 只写 audio.volume、不碰 audio.muted，
     * 所以恢复过程中别处调 applyVolume 也不会把静音解除。
     */
    const prevMuted = audio.muted;
    audio.muted = true;
    // 恢复过程不记播放历史（见 reportPlayHistory）
    state.restoring = true;
    try {
      await playAt(state.index, 'next', true);
      if (Number(s.time) > 1) {
        audio.currentTime = Number(s.time);
      }
      audio.pause();
    } finally {
      // 无论成败都要还原，否则用户会莫名其妙一直没声音
      audio.muted = prevMuted;
      state.restoring = false;
    }
    $('#pb-toggle').textContent = '▶';
    console.log('[恢复] 上次听到 ' + (s.queue[state.index] || {}).name + ' @ ' + Math.round(Number(s.time) || 0) + 's');
    return true;
  } catch (e) {
    console.warn('[恢复] 失败:', (e && e.message) || e);
    return false;
  }
}

/** 订阅主进程发回来的动作。重新注册时先退订，避免监听叠加。 */
var hotkeyUnsub = null;
function bindHotkeyActions() {
  if (!window.api || !window.api.hotkeys) return;
  if (hotkeyUnsub) hotkeyUnsub();
  hotkeyUnsub = window.api.hotkeys.onAction((payload) => {
    if (payload && payload.action) doHotkeyAction(payload.action);
  });
}

async function setCoverForSong(song) {
  if (!bg) return;
  // 封面重采样是纯 CPU 活（150×150 网格的 Sobel + 模糊），最可疑的卡顿来源之一
  if (window.__mpMark) window.__mpMark('换封面');
  void applyCoverAccent(song);   // 取色是另一条独立的路，不要 await 阻塞封面
  if (song && song.cover) {
    const n = await bg.setCover(song.cover);
    if (n > 0) return;
  }
  bg.setCoverFromCanvas(drawFallbackDisc(song ? song.name : ''), 512, 512);
}

/* ------------------------------------------------------------------ */
/* 配色跟着封面走                                                      */
/* ------------------------------------------------------------------ */

/**
 * 从封面里取一个能当强调色用的主色。
 *
 * 为什么不用"平均色"：平均值几乎永远是脏灰（封面里明暗冷暖全都混在一起）。
 * 这里按 5bit/通道分桶取**最多的那一桶**，桶内再求平均 ——
 * 得到的才是"这块封面的主色调"，而不是所有颜色的中和。
 *
 * 三类像素直接丢掉：
 *   · 太暗（< 0.16）：当强调色看不见
 *   · 太亮（> 0.94）：白底封面会取到纯白
 *   · 太灰（饱和度 < 0.18）：黑白封面上取出来的灰会让整个界面发脏
 * 全都丢光时返回 null，调用方保持原主题色 —— 宁可不变，也不要变脏。
 */
function extractAccentFromImage(img) {
  const S = 32;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, S, S);
  let data;
  try {
    data = ctx.getImageData(0, 0, S, S).data;
  } catch {
    // 跨域封面会污染 canvas，这里是正常的失败路径
    return null;
  }

  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 0.16 || max > 0.94) continue;
    const sat = max <= 0 ? 0 : (max - min) / max;
    if (sat < 0.18) continue;
    const key = ((data[i] >> 5) << 10) | ((data[i + 1] >> 5) << 5) | (data[i + 2] >> 5);
    const cur = buckets.get(key);
    if (cur) {
      cur.n += 1;
      cur.r += data[i];
      cur.g += data[i + 1];
      cur.b += data[i + 2];
    } else {
      buckets.set(key, { n: 1, r: data[i], g: data[i + 1], b: data[i + 2] });
    }
  }
  if (!buckets.size) return null;

  let best = null;
  for (const v of buckets.values()) if (!best || v.n > best.n) best = v;

  let rr = best.r / best.n / 255;
  let gg = best.g / best.n / 255;
  let bb = best.b / best.n / 255;

  /*
   * 统一提亮提纯。
   * 封面取出来的色往往比"当强调色"要闷 —— 直接用的结果是按钮和滑块
   * 都灰扑扑的。往 1 的方向推一点，同时把明度抬到 0.55 附近。
   */
  const mx = Math.max(rr, gg, bb) || 1;
  const mn = Math.min(rr, gg, bb);
  const l = (mx + mn) / 2;
  const push = (v) => v + (v - l) * 0.35;   // 饱和度 +35%
  rr = push(rr);
  gg = push(gg);
  bb = push(bb);
  const lum = Math.max(rr, gg, bb) || 1;
  const scale = 0.92 / lum;                 // 让最亮通道落在 0.92 附近
  rr = Math.min(1, rr * scale);
  gg = Math.min(1, gg * scale);
  bb = Math.min(1, bb * scale);

  const hex = (v) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${hex(rr)}${hex(gg)}${hex(bb)}`;
}

/**
 * 换歌时重新取色。
 *
 * 直接复用 applySettings 那条通路（它本来就会把 accentOverride 同时写进
 * CSS 变量和粒子配色），所以这里不需要碰任何上色代码。
 * 颜色没变就不重涂 —— 重涂会给每颗粒子重新随机取色，连播同专辑时会乱闪。
 */
let lastCoverAccent = '';
async function applyCoverAccent(song) {
  if (!settings.coverAccent) return;
  if (!song || !song.cover) return;
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = song.cover;
    });
    const hex = extractAccentFromImage(img);
    if (!hex || hex === settings.coverAccentColor) return;
    lastCoverAccent = hex;
    settings.coverAccentColor = hex;
    palette = applySettings(settings);
    if (bg) bg.setPalette(palette);
    saveSettings(settings);
    if (window.__mpMark) window.__mpMark('封面取色 ' + hex);
  } catch {
    /* 取不到就保持原主题色，不弹提示 —— 这是正常情况（跨域/无封面） */
  }
}

function drawFallbackDisc(title) {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const cx = 256;
  const cy = 256;
  const R = 176;

  const g = ctx.createRadialGradient(cx, cy, R * 0.08, cx, cy, R);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.34, '#e8c87a');
  g.addColorStop(0.72, '#7c5cff');
  g.addColorStop(1, 'rgba(20,22,34,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  for (let r = R * 0.2; r < R; r += R * 0.045) {
    ctx.lineWidth = Math.max(1, R * 0.008);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 58px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
  ctx.fillText(String(title || '♪').slice(0, 4), cx, cy);
  return ctx;
}

const QUALITY_SOURCE_LABEL = { mobile: '移动端', gateway: '网关', none: '—' };

/**
 * 播放请求令牌
 *
 * 取流是异步的（要走一次网络）。快速连点两首歌时，两次取流会并发进行，
 * **谁后返回谁就把 audio.src 覆盖掉** —— 于是点了 B，最后播出来的却是 A。
 * 这是"放的歌不对"最典型的成因，而且只在手快的时候出现，很难复现。
 *
 * 做法：每次播放领一个递增令牌，取流回来发现令牌已经不是最新的，直接丢弃。
 * 这样永远只有"最后一次点击"能真正落到播放器上。
 */
let playToken = 0;

/** 上一首真正开始播放的歌曲 hash，用来判断"是否真的换歌了" */
let lastPlayedHash = '';

/**
 * 抑制设置存盘。
 *
 * 给自动探测/基准脚本用 —— 它们会反复调用 updateSettings 试各种参数，
 * 但那些只是测试用的临时状态，绝不能写进用户的存档。
 * 探测开始时打开，结束时关掉（见 window.__mpProbeGuard）。
 */
let suppressSettingsSave = false;

async function playAt(i, dir = 'next', isSkip = false) {
  if (i < 0 || i >= state.queue.length) return;
  /*
   * 旧歌先淡出（**不等它结束**）。
   * 后面还要 await 取播放地址，那段时间正好覆盖这次淡出 ——
   * 等 audio.src 被替换时音量已经到 0，所以不会有"戛然而止"。
   */
  if (audio.src && !audio.paused) fadeOut(FADE_OUT_MS);
  if (window.__mpMark) window.__mpMark('切歌');
  const myToken = ++playToken;

  // 用户主动点的歌要清掉"连续跳不过去"的计数，
  // 否则上次自动跳过留下的计数会限制这一次的重试次数
  if (!isSkip) state.skipFails = 0;

  // 真的换歌了才重置节拍跟踪（同一首重播不用重估速度）
  if (state.currentSong !== state.queue[i]) {
    lastPlayedHash = state.queue[i].hash;
    if (resetBeatState) resetBeatState();
  }

  state.index = i;
  const song = state.queue[i];
  state.currentSong = song;

  $('#pb-title').textContent = song.name;
  $('#pb-artist').textContent = song.artist || '未知歌手';
  if (song.cover) $('#pb-cover').style.backgroundImage = `url("${song.cover}")`;
  else $('#pb-cover').style.backgroundImage = '';
  highlightRow();

  // 诊断：确认"点的这首"和"取的流"是同一首
  console.log(
    `[播放] 令牌=${myToken} 点击索引=${i}  歌曲="${song.name}"  hash=${song.hash}  ` +
      `albumId=${song.albumId}  albumAudioId=${song.albumAudioId}  ` +
      `队列长度=${state.queue.length}`
  );

  let info;
  try {
    info = await api.stream(song, state.quality);
  } catch (e) {
    if (myToken !== playToken) return; // 已被更晚的点击取代，别弹过期的错误
    toast(`取播放地址失败：${e.message}`, true);
    return;
  }

  // ---- 关键：取流回来先确认自己还是最新的那次点击 ----
  if (myToken !== playToken) {
    console.log(`[播放] 丢弃过期结果（令牌 ${myToken} < ${playToken}）歌曲="${song.name}"`);
    return;
  }

  if (!info.url) {
    const why = info.failProcess && info.failProcess.length ? info.failProcess.join('、') : '平台限制';
    toast(`《${song.name}》放不了（${why}）`, true);

    /*
     * 自动跳过播不了的歌（VIP / 版权限制）。
     *
     * 关键：**必须沿着用户走的方向继续**，不能永远往前跳。
     * 原来写死 nextIndex()，导致"点上一曲碰到 VIP"会被弹回当前歌曲 ——
     * 因为 state.index 此时已经是目标下标，再 +1 就回到了出发点。
     * 用 stepIndex(dir) 之后，往前点的继续往前、往后点的继续往后，
     * 一路把播不了的跳过去，行为才符合直觉。
     *
     * 另外要有上限：整个队列都放不了时不能无限跳下去。
     */
    state.skipFails = (state.skipFails || 0) + 1;
    if (state.skipFails < state.queue.length) {
      const nxt = stepIndex(dir);
      console.log(`[播放] 《${song.name}》放不了，沿 ${dir} 方向跳到下标 ${nxt}`);
      window.setTimeout(() => playAt(nxt, dir, true), 900);
    } else {
      state.skipFails = 0;
      toast('这个队列里的歌都放不了（付费或版权限制）', true);
    }
    return;
  }
  state.skipFails = 0;

  // 高音质拿不到时回退到标准，并明确告诉用户原因
  if (state.quality !== 128 && /需要付费|受限|会员/.test((info.failProcess || []).join(''))) {
    toast('该音质需要会员，已回退标准音质');
  } else {
    toast(`音质 ${QUICK_QUALITY[state.quality] || state.quality} · 来源 ${QUALITY_SOURCE_LABEL[info.source] || '未知'}`);
  }

  console.log(`[播放] 取到地址来源=${info.source}  ${String(info.url).split('/').slice(0, 3).join('/')}`);

  audio.src = info.url;
  // 换源会把音量留在淡出后的 0，这里从头开始升
  audio.volume = 0;
  try {
    await audio.play();
    fadeIn(FADE_IN_MS);
  } catch (e) {
    toast(`播放被拒绝：${e.message}`, true);
  }

  // 播放页
  $('#np-title').textContent = song.name;
  $('#np-artist').textContent = song.artist || '';
  void setCoverForSong(song);
  updateStageText();
  updateMediaSession();
  setAlbumBackground(song.cover);
  updateTimingUI();

  // 如果当前就在「正在播放」页，新封面要立刻聚拢成形
  // （coverParticles 关掉时这里不聚拢 —— 那一刻页面用的是真正的封面图）
  const activeView = document.querySelector('#nav button.active');
  if (
    activeView &&
    activeView.dataset.view === 'nowplaying' &&
    settings.particles.coverParticles !== false
  ) {
    bg.setCoverFocus(1);
  }

  // 先按本地缓存显示，同时后台把完整收藏列表拉回来再校正一次
  updateLikeButton();
  void ensureLikes().then(updateLikeButton);

  lyricView.clear('歌词加载中…');
  loadLyrics(song);
}

/** 取歌词并装载；时间轴偏移按歌曲记住 */
async function loadLyrics(song) {
  try {
    const ly = await api.lyric(song);
    if (!ly.ok || !ly.text) {
      lyricView.clear('这首歌没有歌词');
      return;
    }
    const parsed = parseLyrics(ly.text, ly.isWordByWord);
    lyricView.setLyrics(parsed);
    lyricView.setOffset(getTiming(song.hash));
    lyricView.update(audio.currentTime || 0);
  } catch {
    lyricView.clear('歌词加载失败');
  }
}

/**
 * 高亮"正在播放"那一行
 *
 * 只在**当前这个列表容器**里找，不能扫全文档：`data-i` 是列表内的序号，
 * 首页推荐、搜索结果、歌单详情各自的第 3 行都是 `data-i="3"`，
 * 一起高亮的话会同时点亮好几首不同的歌，看起来就像"点错了歌"。
 */
function highlightRow() {
  const scope = state.listContainer || document;
  scope.querySelectorAll('.row').forEach((el) => {
    el.classList.toggle('playing', Number(el.dataset.i) === state.index);
  });
}

/**
 * 渲染歌曲列表
 *
 * 点击处理**只在这里绑定一次**。之前各个调用方又各自绑了一遍，导致点一下
 * 会触发两次播放（队列被设两次、playAt 被调两次），表现出来就是"放的歌不对"。
 *
 * @param {HTMLElement} container
 * @param {Array} songs
 * @param {{queueTitle?: string}} [opts] queueTitle 只用于提示文案
 */
/* ------------------------------------------------------------------ */
/* 歌单编辑：轻量弹层                                                  */
/* ------------------------------------------------------------------ */

/**
 * 通用弹层：标题 + 一段内容 + 取消。
 * 返回 { overlay, body, close }，调用方决定内容。
 *
 * 不用 window.prompt / confirm：Electron 里 prompt() 是不支持的
 *（返回 null 并在控制台报错），confirm() 能弹但样式和整体完全不一致。
 */
function mpModal(title) {
  const overlay = document.createElement('div');
  overlay.className = 'mp-modal-overlay';
  const box = document.createElement('div');
  box.className = 'mp-modal';
  const h = document.createElement('div');
  h.className = 'mp-modal-title';
  h.textContent = title;
  const body = document.createElement('div');
  body.className = 'mp-modal-body';
  const foot = document.createElement('div');
  foot.className = 'mp-modal-foot';
  const cancel = document.createElement('button');
  cancel.className = 'mp-btn';
  cancel.type = 'button';
  cancel.textContent = '取消';
  foot.appendChild(cancel);

  box.appendChild(h);
  box.appendChild(body);
  box.appendChild(foot);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  cancel.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  return { overlay, body, foot, close };
}

/** 文本输入弹层 */
function askText(title, placeholder, initial, onOk) {
  const m = mpModal(title);
  const input = document.createElement('input');
  input.className = 'mp-input';
  input.type = 'text';
  input.placeholder = placeholder || '';
  input.value = initial || '';
  input.maxLength = 40;
  m.body.appendChild(input);

  const ok = document.createElement('button');
  ok.className = 'mp-btn mp-btn-primary';
  ok.type = 'button';
  ok.textContent = '确定';
  m.foot.appendChild(ok);

  const submit = () => {
    const v = input.value.trim();
    if (!v) {
      input.focus();
      return;
    }
    m.close();
    onOk(v);
  };
  ok.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  setTimeout(() => input.focus(), 0);
}

/** 确认弹层（危险操作，比如删歌单） */
function askConfirm(title, message, onOk) {
  const m = mpModal(title);
  const p = document.createElement('div');
  p.className = 'mp-text';
  p.textContent = message;
  m.body.appendChild(p);

  const ok = document.createElement('button');
  ok.className = 'mp-btn mp-btn-danger';
  ok.type = 'button';
  ok.textContent = '删除';
  m.foot.appendChild(ok);
  ok.addEventListener('click', () => {
    m.close();
    onOk();
  });
  setTimeout(() => ok.focus(), 0);
}

/** 选一个歌单（用于「加到歌单」） */
function pickPlaylist(title, onPick) {
  const m = mpModal(title);
  const lists = state.playlists || [];
  if (!lists.length) {
    m.body.innerHTML = '<div class="mp-empty">没有歌单，先去「我的歌单」建一个</div>';
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'mp-list';
  for (const p of lists) {
    const item = document.createElement('button');
    item.className = 'mp-list-item';
    item.type = 'button';
    item.textContent = p.name + '（' + (p.count || 0) + ' 首）';
    item.addEventListener('click', () => {
      m.close();
      onPick(p);
    });
    wrap.appendChild(item);
  }
  m.body.appendChild(wrap);
}

/** 改完歌单后统一收尾：重新拉列表 + 提示 */
async function afterPlaylistChange(msg) {
  state.playlists = [];   // 强制重新拉，避免本地和服务器不一致
  playlistsRendered = false;
  await loadPlaylists();
  if (msg) toast(msg);
}

function renderRows(container, songs, opts = {}) {
  const queueTitle = opts.queueTitle || '';
  if (!songs.length) {
    container.innerHTML = '<div class="empty">没有结果</div>';
    return;
  }

  container.innerHTML = songs
    .map((s, i) => {
      const locked = Number(s.privilege) >= 9;
      /*
       * 行尾的操作按钮。两个场景互斥：
       *   在歌单里（opts.listId）→ 移出歌单；删歌要 fileId，没有就不给按钮
       *   搜索结果（opts.addable）→ 加到歌单
       */
      let act = '';
      if (opts.listId) {
        act = Number(s.fileId)
          ? '<button class="row-act" data-act="remove" title="移出歌单">✕</button>'
          : '';
      } else if (opts.addable) {
        act = '<button class="row-act" data-act="add" title="加到歌单">＋</button>';
      }
      return `<div class="row${locked ? ' locked' : ''}" data-i="${i}" title="${esc(s.name)} — ${esc(s.artist)}">
        <span class="row-idx">${String(i + 1).padStart(2, '0')}</span>
        <span class="row-name">${esc(s.name)}${locked ? ' 🔒' : ''}</span>
        ${/*
           * 第三列显示什么，看场景：
           *   歌手页（opts.showAlbum）→ **专辑名**，可点。
           *     整页都是同一个歌手，重复歌手名没有信息量，专辑名才是有用的导航。
           *   其它页面 → 歌手名；有 artistId 才做成链接
           *     （没有的话点了没反应，不如保持纯文本）。
           */
          opts.showAlbum
            ? Number(s.albumId)
              ? `<span class="row-artist link" data-album-id="${s.albumId}" title="查看专辑">${esc(s.albumName || s.artist)}</span>`
              : `<span class="row-artist">${esc(s.albumName || s.artist)}</span>`
            : Number(s.artistId)
              ? `<span class="row-artist link" data-artist-id="${s.artistId}" title="查看歌手">${esc(s.artist)}</span>`
              : `<span class="row-artist">${esc(s.artist)}</span>`
        }
        <span class="row-dur">${fmtDur(s.durationSec)}</span>
        <span class="row-actions">${act}</span>
      </div>`;
    })
    .join('');

  /*
   * 操作按钮的点击必须**先于**播放处理，而且要阻止冒泡 ——
   * 否则点「移出歌单」会顺带把这首歌播起来，那是最容易让人恼火的一类 bug。
   */
  /*
   * 行里的歌手名可点。
   * **必须 stopPropagation** —— 否则点歌手名会顺带把歌播起来，
   * 跟当初"点移出歌单结果播了歌"是同一类问题。
   */
  container.querySelectorAll('.row-artist.link').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      void openArtist(Number(el.dataset.artistId));
    });
  });

  /*
   * 行里的歌手名 / 专辑名可点。
   * **必须 stopPropagation** —— 否则点它会顺带把歌播起来，
   * 和当初"点移出歌单结果播了歌"是同一类问题。
   */
  container.querySelectorAll('.row-artist.link[data-album-id]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      void openAlbum(Number(el.dataset.albumId));
    });
  });
  container.querySelectorAll('.row-artist.link[data-artist-id]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      void openArtist(Number(el.dataset.artistId));
    });
  });

  container.querySelectorAll('.row-act').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const row = btn.closest('.row');
      const song = songs[Number(row.dataset.i)];
      if (!song) return;
      if (btn.dataset.act === 'remove') {
        btn.disabled = true;
        try {
          await api.playlistRemoveTracks(opts.listId, [song.fileId]);
          toast('已移出歌单');
          // 本地先摘掉，避免整页重排导致滚动位置丢失
          row.remove();
        } catch (err) {
          btn.disabled = false;
          toast('移出失败：' + err.message);
        }
      } else if (btn.dataset.act === 'add') {
        // 歌单列表可能还没拉过（比如直接从首页搜索），先保证有
        if (!state.playlists || !state.playlists.length) {
          try {
            state.playlists = await api.playlists();
          } catch (err) {
            toast('拉取歌单失败：' + err.message);
            return;
          }
        }
        pickPlaylist('加到歌单', async (p) => {
          try {
            await api.playlistAddTracks(p.listid, [song]);
            /*
             * 加完必须把歌单缓存清掉。
             *
             * 之前只弹了个提示，state.playlists 里的 count 还是旧值，
             * 于是"新加了歌，歌单下面还显示 0 首"。
             * 而且 loadPlaylists 里是
             *   `state.playlists.length ? state.playlists : await api.playlists()`
             * —— 它会复用缓存，不清空就永远不会真的重拉。
             */
            state.playlists = [];
            playlistsRendered = false;
            toast('已加到「' + p.name + '」');
          } catch (err) {
            toast('添加失败：' + err.message);
          }
        });
      }
    });
  });

  container.querySelectorAll('.row').forEach((el) => {
    el.addEventListener('click', () => {
      // 整个列表成为播放队列，再播被点的那首
      state.queue = songs.slice();
      state.index = -1;
      // 记下当前列表容器，供 highlightRow 限定高亮范围
      state.listContainer = container;
      renderQueue();
      if (queueTitle) toast(`已加载 ${songs.length} 首 · ${queueTitle}`);
      playAt(Number(el.dataset.i));
    });
  });
}

/* ------------------------------------------------------------------ */
/* 视图切换                                                            */
/* ------------------------------------------------------------------ */

/** 当前视图名。详情页的"返回"要知道是从哪儿进来的 */
let currentView = 'home';

function switchView(view) {
  currentView = view;
  /*
   * 导航高亮要单独算：歌单详情（view-playlist）没有自己的导航项，
   * 直接拿 view 去比对会让**所有**导航按钮都失去高亮 ——
   * 看上去就是"不知道自己在哪一页"。它属于「我的歌单」，就高亮那一项。
   */
/*
   * 滚轮缩放只在「正在播放」页生效。
   *
   * 为什么不是"哪一页都行"：其它页有列表要滚，滚轮必须归滚动；
   * 而 #main 在内容超高时会被判定成"可滚动容器"，于是连「正在播放」页
   * 也被让掉了 —— 用户反馈的"正在播放里滚轮怎么失效了"就是这个。
   * 现在按页面明确分工，不再靠"能不能滚"去猜。
   */
  if (bg) bg.setZoomEnabled(view === 'nowplaying');

  const navKey = view === 'playlist' ? 'playlists' : view;
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === navKey));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
}

$('#nav').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  switchView(btn.dataset.view);

  const v = btn.dataset.view;
  if (v === 'playlists') ensurePlaylistsView();
  if (v === 'history') ensureHistoryView();
  // 首页每次进入都刷新：它显示的最近播放是会变的，缓存住就成了旧快照
  if (v === 'home') loadHome();
  updateCoverFocus(v);
});

/* ------------------------------------------------------------------ */
/* 最近播放 + 私人 FM                                                  */
/* ------------------------------------------------------------------ */

/*
 * 这两个接口 core 里早就有（getUserHistory / getPersonalFm），
 * 从来没接过界面 —— 属于"写一行就多一个功能"的那种。
 */

/*
 * 最近播放：**每次进入都重新拉**，不做一次性渲染。
 *
 * 我第一版写的是 `let historyRendered = false; if (historyRendered) return;` ——
 * 于是进过一次之后就永远不再请求，列表停在"进应用那一刻的快照"。
 * 播放记录恰恰是**每次听歌都会变**的东西（刚听的应该排在第一条），
 * 缓存住就完全失去意义。用户反馈"最近播放也不会刷新"就是这个。
 *
 * 这和歌单计数那次是同一个错（`state.playlists.length ? 缓存 : 请求`），
 * 教训记在这里：**凡是随用户行为变化的数据，都不要用"渲染过就不再拉"来省请求。**
 *
 * 已经有内容时不显示"加载中"，避免每次回来闪一下。
 */
async function ensureHistoryView() {
  const box = $('#history-list');
  if (!box.querySelector('.row')) box.innerHTML = '<div class="loading">加载中</div>';
  try {
    const songs = await api.history(1);
    if (!songs.length) {
      box.innerHTML = '<div class="empty">还没有播放记录。听几首再回来看看。</div>';
      return;
    }
    renderRows(box, songs, { queueTitle: '最近播放', addable: true });
  } catch (e) {
    // 有旧内容就保留，只是提示一下；没内容才整块换成错误
    if (box.querySelector('.row')) toast('刷新最近播放失败：' + e.message);
    else box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

/**
 * 私人 FM：拉一批歌排进队列，再从第一首开始放。
 *
 * 不做成"一个视图"是因为 FM 的重点是**听**而不是"看列表" ——
 * 拉一批进队列、直接开播，用户想看列表就切「正在播放」的队列。
 */
async function startPersonalFm() {
  if (state.fmLoading) return;
  state.fmLoading = true;
  toast('正在获取私人 FM…');
  try {
    const songs = await api.personalFm();
    if (!songs.length) {
      toast('没有拿到 FM 歌曲（可能需要登录）');
      return;
    }
    state.queue = songs.slice();
    state.index = -1;
    state.listContainer = null;   // FM 不在某个列表里，不高亮任何行
    renderQueue();
    await playAt(0, 'next', true);
    toast(`私人 FM · ${songs.length} 首`);
  } catch (e) {
    toast('私人 FM 失败：' + e.message);
  } finally {
    state.fmLoading = false;
  }
}

$('#home-fm').addEventListener('click', startPersonalFm);

/* ------------------------------------------------------------------ */
/* 观感精简：侧栏折叠 + 沉浸模式                                        */
/* ------------------------------------------------------------------ */

/*
 * 侧栏折叠。状态存 localStorage，下次打开保持上次的样子。
 *
 * 折叠时整列宽度收成 0（body.sidebar-hidden #app { grid-template-columns: 0 1fr }），
 * 而不是把侧栏 visibility 隐藏 —— 那样它还占着那 208px，
 * 主内容区永远挪不过去，等于没收。
 *
 * 隐藏后靠 #side-reveal 那条 12px 的唤出条找回来（鼠标碰到左边缘就滑出），
 * 所以不会出现"收起来就再也点不到导航"的情况。
 */
const SIDEBAR_KEY = 'mp.sidebarHidden';

function setSidebarHidden(hidden) {
  document.body.classList.toggle('sidebar-hidden', !!hidden);
  try {
    localStorage.setItem(SIDEBAR_KEY, hidden ? '1' : '0');
  } catch {
    /* 隐私模式下写不了，不影响使用 */
  }
}

try {
  if (localStorage.getItem(SIDEBAR_KEY) === '1') {
    document.body.classList.add('sidebar-hidden');
  }
} catch {}

$('#btn-sidebar').addEventListener('click', () => {
  setSidebarHidden(!document.body.classList.contains('sidebar-hidden'));
});

/*
 * 沉浸模式：侧栏和播放条一起收掉，只剩粒子 + 歌词。
 *
 * 退出方式给三个：Esc、再点一次按钮、鼠标移到屏幕底部把播放条唤回来。
 * 只留一个入口的话，用户很容易"进去了不知道怎么出来"。
 */
function setImmersive(on) {
  document.body.classList.toggle('immersive', !!on);
  const btn = $('#btn-immersive');
  if (btn) btn.title = on ? '退出沉浸模式（Esc）' : '沉浸模式（只看粒子，Esc 退出）';
}

$('#btn-immersive').addEventListener('click', () => {
  setImmersive(!document.body.classList.contains('immersive'));
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('immersive')) {
    setImmersive(false);
  }
});
/* 歌单详情页的返回按钮 */
$('#pl-back').addEventListener('click', () => {
  switchView('playlists');
  // 覆盖层的光影跟着视图走，否则从歌单返回时封面还保持着"聚拢"的姿态
  updateCoverFocus('playlists');
});

/* ------------------------------------------------------------------ */
/* 回到顶部                                                            */
/* ------------------------------------------------------------------ */

/*
 * #main 是滚动容器（overflow: hidden auto），所以监听它而不是 window。
 * 用 passive 监听 + 只切一个 class：滚动事件本身很频繁，
 * 在回调里读 scrollTop 是可以的（不写样式就不会触发强制重排）。
 */
const mainEl = $('#main');
const toTopBtn = $('#to-top');

function syncToTop() {
  if (!toTopBtn || !mainEl) return;
  toTopBtn.classList.toggle('show', mainEl.scrollTop > 320);
}
mainEl.addEventListener('scroll', syncToTop, { passive: true });
syncToTop();

toTopBtn.addEventListener('click', () => {
  // 平滑滚动；用户在系统里开了"减少动态效果"时浏览器会自动降级为瞬移
  mainEl.scrollTo({ top: 0, behavior: 'smooth' });
  syncToTop();
});

/**
 * 只在「正在播放」页把封面聚拢成形；其他页面散开融进背景粒子。
 * 这样封面就不是"贴在某一页的一块东西"，而是整个视觉系统的一部分。
 */
function updateCoverFocus(view) {
  /*
   * coverParticles 关掉时，封面粒子层**永远不聚拢**（一直保持散开状态
   * 融在背景里，而且散开时它本身就不渲染，见 particles.js 的可见性判断）。
   * 因为"正在播放"页已经用真正的封面图了，再来一层粒子画封面只会互相干扰。
   */
  const useParticles = settings.particles.coverParticles !== false;
  coverFocusWanted = useParticles && view === 'nowplaying' && Boolean(state.currentSong);
  if (bg) bg.setCoverFocus(coverFocusWanted ? 1 : 0);
}

/* ------------------------------------------------------------------ */
/* 首页仪表盘                                                          */
/* ------------------------------------------------------------------ */

/*
 * 首页。
 *
 * 改版说明：原来有「每日推荐」和「排行榜」两块 —— 都删了。
 *   · 每日推荐 一直只显示"需登录"，实际拿不到内容
 *   · 排行榜  是"看榜"用的，而这里的人是来听自己歌的
 * 现在换成三块真正用得上的：**接着听** / **最近播放** / **我的歌单**。
 * 数据来源都是已经跑通的接口，不会再出现一整块空着的情况。
 */
const HOME_RECENT_MAX = 8;
const HOME_PLAYLIST_MAX = 8;

async function loadHome() {
  // 问候语按当前时间变
  const h = new Date().getHours();
  $('#home-kicker').textContent = h < 6 ? '夜深了' : h < 12 ? '早上好' : h < 18 ? '下午好' : '晚上好';

  // 登录态决定首页展示什么：未登录时下面那些依赖账号数据的区块全部藏掉
  let loggedIn = false;
  try {
    const acc = await api.account();
    loggedIn = Boolean(acc.loggedIn);
    if (loggedIn) {
      $('#home-title').textContent = acc.nickname || '已登录';
      $('#home-sub').textContent = `${acc.vipLevel || ''} · ${acc.userid || ''}`;
    } else {
      $('#home-title').textContent = '未登录';
      $('#home-sub').textContent = '点左下角「扫码登录酷狗」，登录后就能看到你的歌单和播放记录';
    }
  } catch {
    /*
     * 拿不到账号状态时按未登录处理：这条路径上继续去拉歌单 / 历史
     * 只会换来一堆失败，不如直接给一句能操作的提示。
     */
    loggedIn = false;
  }

  /*
   * 「继续播放」：读上次退出时的存档（和启动恢复用的是同一份）。
   * 有存档才显示按钮，并带上歌名 —— 比一个光秃秃的按钮有用得多。
   */
  try {
    const raw = localStorage.getItem('mp.resume.v1');
    const saved = raw ? JSON.parse(raw) : null;
    const btn = $('#home-resume');
    const song = saved && saved.queue && saved.queue[saved.index];
    if (song && song.hash) {
      btn.hidden = false;
      btn.textContent = `▶ 继续播放 · ${song.name}`;
      btn.onclick = () => {
        state.queue = saved.queue.slice();
        state.index = -1;
        renderQueue();
        void playAt(Math.max(0, Number(saved.index) || 0), 'next', true);
      };
    } else {
      btn.hidden = true;
    }
  } catch {
    /* 存档坏了就当没有 */
  }

  // 歌单（顺带喂统计数字）
  let totalSongs = 0;
  if (!loggedIn) {
    $('#tile-playlists').textContent = '需登录';
  } else {
    try {
      if (!state.playlists.length) state.playlists = await api.playlists();
      totalSongs = state.playlists.reduce((a, p) => a + (Number(p.count) || 0), 0);
      $('#tile-playlists').textContent = `${state.playlists.length} 个 · ${totalSongs} 首`;
    } catch (e) {
      /*
       * 登录着却拉不到歌单，是真的异常。
       * 但这里只把 tile 标成「不可用」、并把歌单区收起来 ——
       * 不把原始错误糊到首页上：错误对象经过 IPC 序列化之后
       * 信息基本丢光（常见的是 "[object Object] 未知错误"），
       * 显示出来对用户没有任何帮助，详细原因看主进程控制台。
       */
      console.warn('[home] 歌单加载失败：', e && e.message);
      $('#tile-playlists').textContent = '不可用';
    }
  }

  // 最近播放
  const recBox = $('#home-recent');
  let recent = null;
  if (loggedIn) {
    recBox.innerHTML = '<div class="loading">加载中</div>';
    try {
      recent = await api.history(1);
      $('#tile-history').textContent = recent.length ? `${recent.length} 首` : '还没有';
    } catch (e) {
      // 和歌单一样的处理：不把原始错误甩到页面上
      console.warn('[home] 最近播放加载失败：', e && e.message);
      recent = null;
    }
  } else {
    $('#tile-history').textContent = '需登录';
  }

  /*
   * 未登录：首页只留「能做什么」，把所有依赖账号的区块收起来。
   * 一屏的空卡片和空洞的入口，比一句明确的引导更让人困惑。
   */
  if (!loggedIn) {
    // 私人 FM 走的是个性化推荐接口，未登录拿不到内容
    const fm = $maybe('#home-fm');
    if (fm) fm.hidden = true;
    $('#home-metrics').innerHTML = '';
    for (const sel of ['#home-tiles', '#home-block-recent', '#home-block-playlists']) {
      const el = $maybe(sel);
      if (el) el.hidden = true;
    }
    return;
  }

  const fm = $maybe('#home-fm');
  if (fm) fm.hidden = false;

  // 从「未登录」切回已登录时要把这些重新显示出来，否则会一直藏着
  for (const sel of ['#home-tiles', '#home-block-recent', '#home-block-playlists']) {
    const el = $maybe(sel);
    if (el) el.hidden = false;
  }

  if (recent && recent.length) {
    // 首页只放前几首；完整列表在「最近播放」页
    renderRows(recBox, recent.slice(0, HOME_RECENT_MAX), {
      queueTitle: '最近播放',
      addable: true
    });
  } else {
    // 没有记录，或者拉取失败 —— 都收起来，不留一个空白区块
    recBox.innerHTML = '';
    const block = $maybe('#home-block-recent');
    if (block) block.hidden = true;
  }

  $('#home-metrics').innerHTML = `
      <div class="home-metric"><b>${state.playlists.length}</b><span>歌单</span></div>
      <div class="home-metric"><b>${totalSongs}</b><span>首歌</span></div>
      <div class="home-metric"><b>${recent ? recent.length : 0}</b><span>最近</span></div>`;

  // 我的歌单（横向一排卡片）
  const plBox = $('#home-playlists');
  if (!state.playlists.length) {
    // 一个歌单都没有时整块收起：留着标题栏和「全部 ›」只会点进一个空页面
    plBox.innerHTML = '';
    const block = $maybe('#home-block-playlists');
    if (block) block.hidden = true;
    return;
  }
  plBox.innerHTML = state.playlists
    .slice(0, HOME_PLAYLIST_MAX)
    .map(
      (p) => `<button class="home-pl" data-id="${esc(p.id)}" data-listid="${esc(String(p.listid || ''))}" data-name="${esc(p.name)}">
        <span class="home-pl-cover" style="${p.cover ? `background-image:url('${esc(p.cover)}')` : ''}"></span>
        <span class="home-pl-name">${esc(p.name)}</span>
        <span class="home-pl-count">${p.count} 首</span>
      </button>`
    )
    .join('');
  plBox.querySelectorAll('.home-pl').forEach((card) => {
    card.addEventListener('click', () => openPlaylist(card.dataset));
  });
}

/**
 * 打开一个歌单。
 *
 * 抽成函数是因为首页卡片和歌单页卡片**要做同一件事** ——
 * 之前只有歌单页那份有实现，首页要复制一遍的话，两边迟早会不一致。
 * 参数只用到 dataset 上的 id / listid / name，两边的写法就能统一。
 */
async function openPlaylist(ds) {
  switchView('playlist');
  updateCoverFocus('playlist');
  $('#pl-title').textContent = ds.name;
  $('#pl-count').textContent = '';
  const box = $('#pl-tracks');
  box.innerHTML = '<div class="loading">加载歌单</div>';
  try {
    const songs = await api.playlistTracks(ds.id);
    $('#pl-count').textContent = songs.length + ' 首';
    renderRows(box, songs, { queueTitle: ds.name, listId: ds.listid });
  } catch (e) {
    box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

/* ------------------------------------------------------------------ */
/* 歌手 / 专辑详情页                                                   */
/* ------------------------------------------------------------------ */

/** 记住进入详情页之前的视图，返回时回到原处 */
let detailBackView = 'playlists';

async function openArtist(artistId) {
  if (!artistId) return;
  detailBackView = currentView === 'playlist' ? 'playlists' : currentView || 'home';
  switchView('artist');
  updateCoverFocus('artist');
  $('#ar-title').textContent = '歌手';
  $('#ar-count').textContent = '';
  $('#ar-meta').innerHTML = '<div class="loading">加载歌手</div>';
  const box = $('#ar-tracks');
  box.innerHTML = '<div class="loading">加载歌曲</div>';

  try {
    /*
     * ★ 用 allSettled 而不是 all。
     *
     * 歌手信息和歌曲列表是两个独立请求，任一失败都不该拖垮另一个。
     * 用 all 的话，歌曲列表一失败（实测确实会遇到
     * [20010] invalid param），连头像和简介都显示不出来 ——
     * 页面看起来就是"坏了"。
     */
    const [detailR, songsR] = await Promise.allSettled([
      api.artistDetail(artistId),
      api.artistSongs(artistId, 1, 100),
    ]);
    const detail = detailR.status === 'fulfilled' ? detailR.value : null;
    const d = (detail && detail.data) || null;
    const songs = songsR.status === 'fulfilled' ? songsR.value : null;
    if (d) {
      $('#ar-title').textContent = d.name || '歌手';
      $('#ar-meta').innerHTML = `
        ${d.avatar ? `<img class="detail-cover" src="${esc(d.avatar)}" alt="" />` : '<div class="detail-cover detail-cover-empty">♪</div>'}
        <div class="detail-info">
          <div class="detail-counts">${d.songCount} 首 · ${d.albumCount} 张专辑 · ${fmtFans(d.fans)} 粉丝</div>
          ${d.intro ? `<div class="detail-intro">${esc(d.intro)}</div>` : ''}
        </div>`;
    } else {
      $('#ar-meta').innerHTML = '';
    }
    const list = (songs && songs.songs) || [];
    $('#ar-count').textContent = list.length ? list.length + ' 首' : '';
    /*
     * 歌手页里的每行**显示专辑名**而不是歌手名 ——
     * 整页都是同一个歌手，重复它没有信息量；专辑名才是有用的导航。
     */
    renderRows(box, list, { queueTitle: (d && d.name) || '歌手', showAlbum: true });
  } catch (e) {
    box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

async function openAlbum(albumId) {
  if (!albumId) return;
  detailBackView = currentView || 'home';
  switchView('album');
  updateCoverFocus('album');
  $('#al-title').textContent = '专辑';
  $('#al-count').textContent = '';
  $('#al-meta').innerHTML = '<div class="loading">加载专辑</div>';
  const box = $('#al-tracks');
  box.innerHTML = '<div class="loading">加载歌曲</div>';

  try {
    // 同 openArtist：详情和歌曲分开容错，一个失败不影响另一个
    const [detailR, songsR] = await Promise.allSettled([
      api.albumDetail(albumId),
      api.albumSongs(albumId, 1, 200),
    ]);
    const detail = detailR.status === 'fulfilled' ? detailR.value : null;
    const d = (detail && detail.data) || null;
    const res = songsR.status === 'fulfilled' ? songsR.value : null;
    if (d) {
      $('#al-title').textContent = d.name || '专辑';
      $('#al-meta').innerHTML = `
        ${d.cover ? `<img class="detail-cover" src="${esc(d.cover)}" alt="" />` : '<div class="detail-cover detail-cover-empty">♪</div>'}
        <div class="detail-info">
          <div class="detail-counts">${esc(d.artist)}${d.publishDate ? ' · ' + esc(d.publishDate) : ''}</div>
          ${d.intro ? `<div class="detail-intro">${esc(d.intro)}` : ''}
        </div>`;
    } else {
      $('#al-meta').innerHTML = '';
    }
    const songs = (res && res.songs) || [];
    $('#al-count').textContent = songs.length ? songs.length + ' 首' : '';
    if (!songs.length) {
      /*
       * 实测有些专辑的歌曲接口会返回 [20010] invalid param（平台侧限制）。
       * 那种时候给一句人话，别留一个空白列表让人以为页面卡住了。
       */
      box.innerHTML = '<div class="empty">这张专辑暂时取不到歌曲（可能受版权限制）</div>';
    } else {
      renderRows(box, songs, { queueTitle: (d && d.name) || '专辑' });
    }
  } catch (e) {
    box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

/** 粉丝数：上亿/上万的写法 */
function fmtFans(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return (v / 100000000).toFixed(1) + ' 亿';
  if (v >= 10000) return (v / 10000).toFixed(1) + ' 万';
  return String(v);
}

$('#ar-back').addEventListener('click', () => switchView(detailBackView));
// 删重复块时把这一行连带删掉了 —— 补回来，否则专辑页的"返回"点不动
$('#al-back').addEventListener('click', () => switchView(detailBackView));

/* ------------------------------------------------------------------ */
/* 全屏歌词页                                                          */
/* ------------------------------------------------------------------ */

/**
 * 全屏歌词当前是不是开着。
 * updateStageText 每帧都会调过来同步，所以用个标志挡掉无谓的 DOM 操作。
 */
let flOpen = false;
let flActive = -1;
/** 打开全屏歌词之前是不是沉浸模式 —— 关掉时要还原成原样，不能改掉用户的设置 */
let flWasImmersive = false;

/** 从 lyricView 已经解析好的数据里取"行文本 + 行起始时间" */
function flLines() {
  const lines = (lyricView && lyricView.lines) || [];
  return lines.map((ln, i) => {
    const chars = ln.chars || [];
    return {
      i,
      text: chars.map((c) => c.ch).join(''),
      // 行起始时间 = 第一个字的时间戳
      t: chars.length ? Number(chars[0].t) || 0 : 0,
    };
  });
}

function openFullLyrics() {
  const lines = flLines();
  if (!lines.length) {
    toast('这首歌还没有歌词');
    return;
  }
  switchView('lyrics');

  /*
   * 把封面交给 CSS 做模糊背景。
   * 用 CSS 变量而不是直接写 background-image：
   * 背景那层是伪元素（::before），JS 改不到它 —— 变量能传下去。
   */
  const cover = state.currentSong && state.currentSong.cover;
  document
    .getElementById('view-lyrics')
    .style.setProperty('--fl-cover', cover ? `url("${cover}")` : 'none');

  $('#fl-head .fl-title').textContent = state.currentSong ? state.currentSong.name || '' : '';
  $('#fl-head .fl-artist').textContent = state.currentSong ? state.currentSong.artist || '' : '';

  const box = $('#fl-lines');
  box.innerHTML = lines
    .map(
      (l) =>
        `<div class="fl-line" data-i="${l.i}" data-t="${l.t}">${esc(l.text) || '&nbsp;'}</div>`
    )
    .join('');

  /*
   * 点歌词行跳转 —— 全屏歌词最自然的交互。
   * 每行都带 data-t（该行第一个字的时间戳），直接拿来 seek。
   */
  box.querySelectorAll('.fl-line').forEach((el) => {
    el.addEventListener('click', () => {
      const tt = Number(el.dataset.t);
      if (Number.isFinite(tt) && tt >= 0) audio.currentTime = tt;
    });
  });

  /*
   * ★ 接管应用的边框。
   *
   * 沉浸模式会收起侧栏、隐藏播放条、淡化窗口按钮 —— 全屏歌词要的正是这个。
   * 不复用的话，浮层再漂亮也只是"叠在应用上面的一层字"。
   *
   * 先记下用户原本是不是沉浸模式：关掉全屏歌词时要**还原成原样**，
   * 不能无条件退出沉浸（那会把用户自己的设置改掉）。
   */
  flWasImmersive = document.body.classList.contains('immersive');
  setImmersive(true);
  // 3D 舞台上的歌词/歌名要清掉，否则和浮层重复
  if (bg && bg.setStageText) bg.setStageText('', '');

  flOpen = true;
  flActive = -1;
  /*
   * 浮层是**透明**的，而透明不等于遮住 —— 层级更低的元素照样看得见。
   * 沉浸模式有意保留了侧栏开关和沉浸按钮（平时要靠它们操作），
   * 但全屏歌词是专注模式，这两个也得藏。出口有 Esc 和右上角那个幽灵按钮。
   */
  document.body.classList.add('fl-open');
  syncFullLyrics();
}

function closeFullLyrics() {
  document.body.classList.remove('fl-open');
  flOpen = false;
  flActive = -1;
  setImmersive(flWasImmersive);
  switchView('nowplaying');
  // 让 3D 舞台的文字回来（updateStageText 里那道 flOpen 守卫此刻已经放行了）
  updateStageText();
}

/**
 * 同步高亮行。
 * ★ 只由 updateStageText() 调用 —— 那是每次 timeupdate 的**唯一汇合点**，
 *   而且它已经在读 lyricView.activeLine。挂在那里就不会出现
 *   "某一处更新了、另一处没跟上"。
 */
function syncFullLyrics() {
  if (!flOpen) return;
  const idx = lyricView ? lyricView.activeLine : -1;
  if (idx === flActive) return; // 没换行就别动 DOM
  flActive = idx;
  const box = $('#fl-lines');
  const lines = box.querySelectorAll('.fl-line');
  lines.forEach((el, i) => el.classList.toggle('active', i === idx));
  // 只在换行时滚动，不动每帧触发
  const cur = lines[idx];
  if (cur) {
    box.scrollTo({ top: Math.max(0, cur.offsetTop - box.clientHeight / 2 + cur.offsetHeight / 2), behavior: 'smooth' });
  }
}

$('#fl-chip').addEventListener('click', () => {
  if (flOpen) closeFullLyrics();
  else openFullLyrics();
});
$('#fl-close').addEventListener('click', closeFullLyrics);

// Esc 退出 —— 全屏模式的通用习惯，不加会让人找不到出口
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && flOpen) closeFullLyrics();
});

// 首页磁贴
$('#home-tiles').addEventListener('click', (e) => {
  const tile = e.target.closest('.home-tile');
  if (!tile) return;
  goFromHome(tile.dataset.go);
});

// 「全部 ›」
document.querySelectorAll('.home-more').forEach((b) => {
  b.addEventListener('click', () => goFromHome(b.dataset.go));
});

function goFromHome(go) {
  if (go === 'playlists') {
    switchView('playlists');
    ensurePlaylistsView();
  } else if (go === 'search') {
    switchView('search');
    $('#q').focus();
  } else if (go === 'history') {
    switchView('history');
    ensureHistoryView();
  } else if (go === 'nowplaying') {
    switchView('nowplaying');
  }
  updateCoverFocus(go === 'playlists' ? 'playlists' : go);
}

/* ------------------------------------------------------------------ */
/* 搜索                                                               */
/* ------------------------------------------------------------------ */

/*
 * 搜索：分页。
 *
 * 接口一页最多 100 条，而「搜索只能显示 30 条」那个上限是我自己在
 * web-api 里写死的（不是接口限制）。现在按 50 一页拉，底部给「加载更多」。
 *
 * 关键点：**每页返回的行要能接着上一页编号**，而且点任意一行播放时
 * 队列必须是"已经加载的全部结果"。所以把结果累积在 state.searchSongs 里，
 * 每次 renderRows 传整份 —— 不要只渲染新的一页。
 */
const SEARCH_PAGE_SIZE = 50;

async function doSearch() {
  const kw = $('#q').value.trim();
  if (!kw) return;
  const box = $('#search-result');
  $('#search-title').textContent = `搜索 · ${kw}`;
  box.innerHTML = '<div class="loading">搜索中</div>';

  try {
    const res = await api.search(kw, 1, SEARCH_PAGE_SIZE);
    const songs = res.songs || [];
    state.searchSongs = songs;
    state.searchKw = kw;
    state.searchPage = 1;
    state.searchTotal = res.total || 0;
    if (!songs.length) {
      box.innerHTML = '<div class="empty">没有结果</div>';
      return;
    }
    renderRows(box, songs, { queueTitle: `搜索 ${kw}`, addable: true });
    appendMoreButton(box, songs.length);
  } catch (e) {
    box.innerHTML = `<div class="empty">搜索失败：${esc(e.message)}</div>`;
  }
}

/** 在结果列表后面放一个「加载更多」；已经拿完就不放 */
function appendMoreButton(box, shown) {
  const old = box.querySelector('.load-more');
  if (old) old.remove();
  const total = state.searchTotal || 0;
  if (total && shown >= total) return;
  const btn = document.createElement('button');
  btn.className = 'load-more';
  btn.type = 'button';
  btn.textContent =
    total > 0 ? `加载更多（已显示 ${shown} / ${total}）` : `加载更多（已显示 ${shown}）`;
  btn.addEventListener('click', loadMoreSearch);
  box.appendChild(btn);
}

async function loadMoreSearch() {
  const kw = state.searchKw;
  if (!kw) return;
  const box = $('#search-result');
  const btn = box.querySelector('.load-more');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '加载中…';
  }
  try {
    const next = (state.searchPage || 1) + 1;
    const res = await api.search(kw, next, SEARCH_PAGE_SIZE);
    const more = (res.songs || []).filter(
      // 去重：接口翻页偶尔会重复给同一条
      (s) => !state.searchSongs.some((x) => x.hash === s.hash)
    );
    if (!more.length) {
      if (btn) btn.remove();
      toast('没有更多了');
      return;
    }
    state.searchSongs = state.searchSongs.concat(more);
    state.searchPage = next;
    state.searchTotal = res.total || state.searchTotal;
    // 整份重渲染：这样行号连续，点击播放时的队列也是全部已加载的结果
    renderRows(box, state.searchSongs, { queueTitle: `搜索 ${kw}`, addable: true });
    appendMoreButton(box, state.searchSongs.length);
  } catch (e) {
    toast('加载更多失败：' + e.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = '加载更多';
    }
  }
}

$('#go').addEventListener('click', doSearch);
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void doSearch();
});

/* ------------------------------------------------------------------ */
/* 我的歌单                                                            */
/* ------------------------------------------------------------------ */

/**
 * 歌单视图是否已经渲染过
 *
 * 注意：不能用「state.playlists 有没有数据」来判断要不要渲染 ——
 * 首页在启动时就会拉一次歌单来显示统计数字，那时数据就有了，
 * 但歌单页的 DOM 还完全没构建过。这两个条件必须分开。
 */
let playlistsRendered = false;

async function ensurePlaylistsView() {
  if (playlistsRendered) return;
  playlistsRendered = true;
  await loadPlaylists();
  // 失败时（例如未登录）允许下次进入重试
  if (!state.playlists.length) playlistsRendered = false;
}

async function loadPlaylists() {
  const grid = $('#playlist-grid');
  grid.innerHTML = '<div class="loading">加载中</div>';

  let lists;
  try {
    // 首页启动时通常已经拉过一次，直接复用，进歌单页就是瞬间的
    lists = state.playlists.length ? state.playlists : await api.playlists();
    state.playlists = lists;
  } catch (e) {
    grid.innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
    return;
  }
  if (!lists.length) {
    grid.innerHTML = '<div class="empty">没有歌单。请先在左下角扫码登录酷狗账号。</div>';
    return;
  }

  grid.innerHTML =
    `<div class="card card-new" data-new="1">
      <div class="card-cover card-cover-new">＋</div>
      <div class="card-name">新建歌单</div>
      <div class="card-count">建一个自己的歌单</div>
    </div>` +
    lists
      .map(
        (p) => `<div class="card" data-id="${esc(p.id)}" data-listid="${esc(String(p.listid || ''))}" data-name="${esc(p.name)}">
        <button class="card-del" title="删除歌单">✕</button>
        <div class="card-cover" style="${p.cover ? `background-image:url('${esc(p.cover)}')` : ''}"></div>
        <div class="card-name">${esc(p.name)}</div>
        <div class="card-count">${p.count} 首</div>
      </div>`
      )
      .join('');

  // 新建歌单
  const newCard = grid.querySelector('[data-new]');
  if (newCard) {
    newCard.addEventListener('click', () => {
      askText('新建歌单', '歌单名（最多 40 字）', '', async (name) => {
        try {
          await api.playlistCreate(name, 0);
          await afterPlaylistChange('已创建「' + name + '」');
        } catch (e) {
          toast('创建失败：' + e.message);
        }
      });
    });
  }

  /*
   * 删除歌单。stopPropagation 是必须的 ——
   * 否则点 ✕ 会同时把卡片点开、跳进歌单详情，看起来像"删除没生效还乱跳"。
   */
  grid.querySelectorAll('.card-del').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const card = btn.closest('.card');
      askConfirm(
        '删除歌单',
        `确定删除「${card.dataset.name}」？这会把歌单从你的酷狗账号里删掉，不能撤销。`,
        async () => {
          try {
            await api.playlistDelete(card.dataset.listid);
            await afterPlaylistChange('已删除');
          } catch (err) {
            toast('删除失败：' + err.message);
          }
        }
      );
    });
  });

  grid.querySelectorAll('.card[data-id]').forEach((card) => {
    // 和首页卡片共用同一份实现，避免两处逻辑漂移（见 openPlaylist）
    card.addEventListener('click', () => openPlaylist(card.dataset));
  });
}

/* ------------------------------------------------------------------ */
/* 账号与扫码登录                                                      */
/* ------------------------------------------------------------------ */

async function loadAccount() {
  const box = $('#account');
  try {
    const acc = await api.account();
    box.innerHTML = acc.loggedIn
      ? `<div class="who">${esc(acc.nickname || '已登录')}</div><div>${esc(acc.vipLevel || '')} · ${esc(acc.userid || '')}</div>` +
        '<button id="btn-logout" class="link">退出登录</button>'
      : '<div>未登录</div><button id="btn-login" class="link">扫码登录酷狗</button>';
  } catch {
    box.innerHTML = '<div>账号状态未知</div>';
  }

  const btn = document.querySelector('#btn-login');
  if (btn) btn.addEventListener('click', () => void startQrLogin());

  /*
   * 退出登录。
   *
   * 自己搭确认框而不用 askConfirm：后者的确定按钮文案写死是"删除"，
   * 而且它是回调式、不返回 Promise —— 语义和签名都不对，硬用只会出怪事。
   */
  const out = document.querySelector('#btn-logout');
  if (out) {
    out.addEventListener('click', () => {
      const m = mpModal('退出登录');
      const p = document.createElement('div');
      p.className = 'mp-text';
      p.textContent = '退出后需要重新扫码登录，确定吗？';
      m.body.appendChild(p);

      const ok = document.createElement('button');
      ok.className = 'mp-btn mp-btn-danger';
      ok.type = 'button';
      ok.textContent = '退出登录';
      m.foot.appendChild(ok);

      ok.addEventListener('click', async () => {
        m.close();
        const r = await api.logout();
        if (!r || !r.ok) {
          toast(`退出失败：${(r && r.error) || '未知错误'}`, true);
          return;
        }
        toast('已退出登录');
        // 账号、首页（"接着听"是个人数据）、歌单全都要重来
        await loadAccount();
        await loadHome();
        await loadPlaylists();
      });
    });
  }
}

const QR_LABEL = { 0: '二维码已过期', 1: '等待扫码…', 2: '已扫码，请在手机上确认', 4: '登录成功' };

async function startQrLogin() {
  let qr;
  try {
    qr = await api.loginQrCreate();
  } catch (e) {
    toast(`生成二维码失败：${e.message}`, true);
    return;
  }

  const overlay = document.createElement('div');
  overlay.id = 'qr-overlay';
  overlay.innerHTML = `
    <div class="qr-box">
      <h3>用酷狗 App 扫码登录</h3>
      <img src="${qr.image}" alt="登录二维码" />
      <p id="qr-status">等待扫码…</p>
      <button id="qr-close">关闭</button>
    </div>`;
  document.body.appendChild(overlay);

  const statusEl = overlay.querySelector('#qr-status');
  let stopped = false;
  const stop = () => {
    stopped = true;
    overlay.remove();
  };

  overlay.querySelector('#qr-close').addEventListener('click', stop);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) stop();
  });

  const poll = async () => {
    if (stopped) return;
    try {
      const r = await api.loginQrCheck(qr.key);
      statusEl.textContent = QR_LABEL[r.status] || '等待中…';
      if (r.loggedIn) {
        stopped = true;
        statusEl.textContent = '登录成功，正在加载…';
        window.setTimeout(() => {
          overlay.remove();
          // 登录后所有与账号相关的数据都要重来一遍
          state.playlists = [];
          playlistsRendered = false;
          state.ranks = [];
          loadAccount();
          loadHome();
          loadPlaylists();
          playlistsRendered = true;
        }, 900);
        return;
      }
      if (r.status === 0) {
        statusEl.textContent = '二维码已过期，请关闭后重试';
        return;
      }
    } catch {
      /* 单次轮询失败忽略，继续 */
    }
    window.setTimeout(poll, 2200);
  };
  void poll();
}

/* ------------------------------------------------------------------ */
/* 音质芯片（学自 Mineradio 的 #quality-control）                       */
/* ------------------------------------------------------------------ */

function updateQualityChip() {
  $('#quality-label').textContent = QUICK_QUALITY[state.quality] || String(state.quality);
  $$('#quality-menu button').forEach((b) => b.classList.toggle('active', String(b.dataset.q) === String(state.quality)));
}

function closeChipMenus() {
  $('#quality-menu').classList.remove('open');
  $('#queue-popover').classList.remove('open');
  $('#speed-menu').classList.remove('open');
}

$('#quality-chip').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('#quality-menu');
  const wasOpen = menu.classList.contains('open');
  closeChipMenus();
  if (!wasOpen) menu.classList.add('open');
});

$('#quality-menu').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-q]');
  if (!btn) return;
  const q = btn.dataset.q;
  state.quality = /^\d+$/.test(q) ? Number(q) : q;
  localStorage.setItem('music-player.quality', String(state.quality));
  updateQualityChip();
  closeChipMenus();
  // 立刻用新音质重取当前歌曲
  if (state.currentSong) await playAt(state.index);
});
/* ------------------------------------------------------------------ */
/* 快进 / 快退 + 倍速                                                  */
/* ------------------------------------------------------------------ */

/** 快进/快退的步长（秒）。不做成可配置 —— 这个数值业界基本一致，没有调的必要。 */
const SEEK_STEP = 5;

/**
 * 相对当前位置跳转。
 * 两头都夹住：负数时间会让 audio.currentTime 抛错，
 * 超过时长则直接停在末尾（再由 ended 事件去切下一首）。
 */
function seekBy(delta) {
  const dur = audio.duration;
  if (!Number.isFinite(dur) || dur <= 0) return;
  const next = Math.min(dur - 0.05, Math.max(0, (audio.currentTime || 0) + delta));
  audio.currentTime = next;
}

$('#pb-back').addEventListener('click', () => seekBy(-SEEK_STEP));
$('#pb-fwd').addEventListener('click', () => seekBy(SEEK_STEP));

/* ---- 倍速 ---- */

const SPEED_KEY = 'music-player.rate';

function updateSpeedChip() {
  const r = audio.playbackRate || 1;
  $('#speed-label').textContent = (r === 1 ? '1.0' : String(r)) + '×';
  $('#speed-chip').classList.toggle('on', r !== 1);
  // 菜单里当前那档高亮
  $('#speed-menu')
    .querySelectorAll('button[data-speed]')
    .forEach((b) => b.classList.toggle('active', Number(b.dataset.speed) === r));
}

function setSpeed(v) {
  const r = Math.max(0.25, Math.min(4, Number(v) || 1));
  /*
   * preservesPitch 默认是 true，但显式写一遍：某些浏览器/版本在改
   * playbackRate 时行为不一致，而变调（磁带快放那种）不是我们要的。
   */
  if ('preservesPitch' in audio) audio.preservesPitch = true;
  audio.playbackRate = r;
  try {
    localStorage.setItem(SPEED_KEY, String(r));
  } catch {}
  updateSpeedChip();
  // 系统媒体面板上的进度条也带速度，改完要同步一次
  updateMediaPosition();
}

try {
  const saved = Number(localStorage.getItem(SPEED_KEY));
  if (Number.isFinite(saved) && saved > 0 && saved !== 1) {
    audio.playbackRate = Math.max(0.25, Math.min(4, saved));
  }
} catch {}
updateSpeedChip();

$('#speed-chip').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('#speed-menu');
  const wasOpen = menu.classList.contains('open');
  closeChipMenus();
  if (!wasOpen) menu.classList.add('open');
});

$('#speed-menu').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-speed]');
  if (!btn) return;
  setSpeed(Number(btn.dataset.speed));
  closeChipMenus();
});


/* ------------------------------------------------------------------ */
/* 迷你播放队列（学自 Mineradio 的 #mini-queue-popover）                */
/* ------------------------------------------------------------------ */

function renderQueue() {
  const box = $('#queue-list');
  $('#queue-count').textContent = String(state.queue.length);

  if (!state.queue.length) {
    box.innerHTML = '<div class="mini-queue-empty">队列是空的</div>';
    return;
  }

  box.innerHTML = state.queue
    .map(
      (s, i) => `<button class="mini-queue-item${i === state.index ? ' playing' : ''}" data-i="${i}">
        <span class="mqi-idx">${i === state.index ? '▶' : String(i + 1).padStart(2, '0')}</span>
        <span class="mqi-name">${esc(s.name)}</span>
        <span class="mqi-artist">${esc(s.artist)}</span>
      </button>`
    )
    .join('');

  box.querySelectorAll('.mini-queue-item').forEach((el) => {
    el.addEventListener('click', () => {
      // 刚拖过就别播 —— 松手那一下会补一个 click 上来
      if (qSuppressClick) return;
      closeChipMenus();
      playAt(Number(el.dataset.i));
    });
  });

  // 把当前项滚进视野
  const cur = box.querySelector('.mini-queue-item.playing');
  if (cur) box.scrollTop = Math.max(0, cur.offsetTop - box.clientHeight / 2);
}

/* ------------------------------------------------------------------ */
/* 队列拖拽排序                                                        */
/* ------------------------------------------------------------------ */

/**
 * 把队列里第 from 项移到 to 位置之前。
 *
 * to 是**原数组里**的插入位置（插到第 to 项之前）。
 * 因为先删掉了 from，后面所有下标会左移一位，所以要减一 ——
 * 不减的话往后拖永远差一格。
 */
function moveQueueItem(from, to) {
  const q = state.queue;
  if (from < 0 || from >= q.length) return;
  const dest = to > from ? to - 1 : to;
  if (dest === from) return;
  const [item] = q.splice(from, 1);
  q.splice(Math.max(0, Math.min(q.length, dest)), 0, item);

  /*
   * ★ 按**歌曲对象**重新定位 state.index。
   *
   * state.index 是个下标，队列一动它就指到别的歌上去了 ——
   * 表现是"拖完顺序，正在播放的高亮跑到别的歌上"。
   * 用对象引用去找才是对的。
   */
  const cur = state.currentSong;
  if (cur) {
    const at = q.indexOf(cur);
    if (at >= 0) state.index = at;
  }
renderQueue();
  /*
   * 重排之后**立刻存一次**。
   *
   * 队列本来就有持久化（saveResume 每 5 秒跑一次 + 关窗时跑一次），
   * 所以不存也不会丢 —— 但"重排完马上关窗"这个组合有最多 5 秒的窗口。
   * 重排是低频操作，多存这一次没有成本。
   *
   * 注：我第一版这里写的是 saveQueueSoon()，那个函数**根本不存在**
   *（我是凭印象写的，没查），会在每次重排时抛 ReferenceError。
   * 存队列的入口只有一个：saveResume。
   */
  saveResume();
}

/** 由指针的 Y 坐标算出"该插到哪一项之前" */
function queueInsertIndexAt(box, clientY) {
  const items = Array.from(box.querySelectorAll('.mini-queue-item'));
  for (let i = 0; i < items.length; i++) {
    const r = items[i].getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return i;
  }
  return items.length;
}

let qDrag = null;
/** 拖过之后要吞掉紧随其后的那次 click（否则松手就播了那首） */
let qSuppressClick = false;

{
  const box = $('#queue-list');

  box.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.mini-queue-item');
    if (!el || e.button !== 0) return;
    qDrag = { from: Number(el.dataset.i), startY: e.screenY, moved: false, el, to: null };
  });

  box.addEventListener('pointermove', (e) => {
    if (!qDrag) return;
    // 5px 阈值：以下算点击，以上才算拖拽
    if (!qDrag.moved && Math.abs(e.screenY - qDrag.startY) < 5) return;
    if (!qDrag.moved) {
      qDrag.moved = true;
      qDrag.el.classList.add('dragging');
    }
    const to = queueInsertIndexAt(box, e.clientY);
    if (to === qDrag.to) return;
    qDrag.to = to;
    // 只在目标位置画一条落点线，不做花哨的实时位移
    box.querySelectorAll('.mini-queue-item').forEach((it, i) => {
      it.classList.toggle('drop-before', i === to);
    });
  });

  // 抬起监听在 window 上：拖到面板外面松手也要能收尾
  window.addEventListener('pointerup', (e) => {
    if (!qDrag) return;
    const d = qDrag;
    qDrag = null;
    d.el.classList.remove('dragging');
    box.querySelectorAll('.mini-queue-item').forEach((it) => it.classList.remove('drop-before'));
    if (!d.moved) return; // 只是点击，交给 click 处理

    // ★ 吞掉这次 click —— 否则松手会立刻播放拖过的那首
    qSuppressClick = true;
    setTimeout(() => {
      qSuppressClick = false;
    }, 0);

    if (d.to != null) moveQueueItem(d.from, d.to);
  });
}

$('#queue-chip').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $('#queue-popover');
  const wasOpen = pop.classList.contains('open');
  closeChipMenus();
  if (!wasOpen) {
    renderQueue();
    pop.classList.add('open');
  }
});

$('#queue-clear').addEventListener('click', (e) => {
  e.stopPropagation();
  state.queue = [];
  state.index = -1;
  renderQueue();
  toast('队列已清空');
});

// 点空白处关掉浮层
document.addEventListener('click', () => closeChipMenus());

/* ------------------------------------------------------------------ */
/* 歌词时间轴微调                                                       */
/* ------------------------------------------------------------------ */

$('#timing-row').addEventListener('click', (e) => {
  const btn = e.target.closest('.timing-btn');
  if (!btn) return;
  if (!state.currentSong) {
    toast('还没有在播放的歌曲');
    return;
  }
  if (btn.id === 'timing-reset') {
    setTiming(state.currentSong.hash, 0);
  } else {
    const delta = Number(btn.dataset.delta) || 0;
    setTiming(state.currentSong.hash, getTiming(state.currentSong.hash) + delta);
  }
  lyricView.setOffset(getTiming(state.currentSong.hash));
  lyricView.update(audio.currentTime || 0);
});

/* ------------------------------------------------------------------ */
/* 喜欢 / 收藏                                                         */
/* ------------------------------------------------------------------ */

// 已喜欢的 hash 集合。全量拉取比较重（上千首），所以懒加载 + 缓存，
// 点赞/取消时先本地乐观更新，失败了再回滚。
state.likedHashes = new Set();
state.likesLoaded = false;
let likesLoading = null;

async function ensureLikes() {
  if (state.likesLoaded) return state.likedHashes;
  if (likesLoading) return likesLoading;

  likesLoading = (async () => {
    try {
      const arr = await api.favoriteHashes();
      state.likedHashes = new Set(arr);
      state.likesLoaded = true;
    } catch {
      // 未登录或接口失败：保持空集合，按钮依然可点（点了会提示登录）
    }
    likesLoading = null;
    return state.likedHashes;
  })();

  return likesLoading;
}

function isLiked(song) {
  return Boolean(song && song.hash && state.likedHashes.has(String(song.hash).toLowerCase()));
}

function updateLikeButton() {
  const liked = isLiked(state.currentSong);
  const btn = $('#pb-like');
  btn.textContent = liked ? '♥' : '♡';
  btn.classList.toggle('on', liked);
  btn.title = liked ? '取消喜欢 (F)' : '喜欢 (F)';
}

/** 点赞时放一个小小的弹跳动画，给点触感 */
function popLikeButton() {
  const btn = $('#pb-like');
  btn.classList.remove('pop');
  void btn.offsetWidth;
  btn.classList.add('pop');
}

async function toggleLike() {
  const song = state.currentSong;
  if (!song) {
    toast('还没有在播放的歌曲');
    return;
  }

  const want = !isLiked(song);
  const key = String(song.hash).toLowerCase();

  // 乐观更新：先把按钮点亮，请求失败再回滚
  if (want) state.likedHashes.add(key);
  else state.likedHashes.delete(key);
  updateLikeButton();
  if (want) popLikeButton();

  try {
    if (want) await api.like(song);
    else await api.unlike(song);
    toast(want ? `已加入「我喜欢」` : '已从「我喜欢」移除');
  } catch (e) {
    if (want) state.likedHashes.delete(key);
    else state.likedHashes.add(key);
    updateLikeButton();
    toast(`操作失败：${e.message}`, true);
  }
}

$('#pb-like').addEventListener('click', toggleLike);

/* ------------------------------------------------------------------ */
/* 音量控制                                                            */
/* ------------------------------------------------------------------ */

const VOLUME_KEY = 'music-player.volume';

function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

state.volume = localStorage.getItem(VOLUME_KEY) !== null ? clamp01(localStorage.getItem(VOLUME_KEY)) : 0.85;
state.muted = false;

const VOL_ICONS = { mute: '🔇', low: '🔉', mid: '🔊', high: '🔊' };

/* ------------------------------------------------------------------ */
/* 淡入淡出                                                            */
/* ------------------------------------------------------------------ */

/** 切歌时的淡出时长。太长会显得拖沓，太短听不出效果 —— 220ms 是比较通行的值。 */
const FADE_OUT_MS = 220;
/** 淡入稍微长一点：进歌时柔一点更舒服，而且不会掩盖第一句歌词 */
const FADE_IN_MS = 420;
/** 暂停用短淡出，播放用短淡入（这两个是"随手按"的动作，不该等） */
const PAUSE_FADE_MS = 140;

let fadeRaf = 0;

/**
 * 把音量渐变到目标值。
 *
 * @param {number} target 目标音量（0~1）
 * @param {number} ms     时长
 * @param {Function=} onDone 到达后回调（切歌要等淡出完成再换源）
 */
function fadeVolumeTo(target, ms, onDone) {
  if (fadeRaf) cancelAnimationFrame(fadeRaf);
  const from = audio.volume;
  const to = clamp01(target);
  if (ms <= 0 || Math.abs(to - from) < 0.001) {
    audio.volume = to;
    if (onDone) onDone();
    return;
  }
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / ms);
    /*
     * 平方曲线：人耳对音量近似对数感知，线性渐变听起来会
     * "前半段几乎没变化、最后一下突然没了"。
     */
    const k = p * p;
    audio.volume = clamp01(from + (to - from) * k);
    if (p < 1) {
      fadeRaf = requestAnimationFrame(step);
    } else {
      fadeRaf = 0;
      audio.volume = to;
      if (onDone) onDone();
    }
  };
  fadeRaf = requestAnimationFrame(step);
}

/** 当前该有的音量（考虑静音） */
function targetVolume() {
  return state.muted ? 0 : state.volume;
}

/**
 * 淡入：从当前（通常是 0）升到目标音量。
 * 换歌、点播放、取消静音都走它。
 */
function fadeIn(ms) {
  fadeVolumeTo(targetVolume(), ms == null ? FADE_IN_MS : ms);
}

/** 淡出到 0，完成后回调（换歌要等这一刻再切源） */
function fadeOut(ms, onDone) {
  fadeVolumeTo(0, ms == null ? FADE_OUT_MS : ms, onDone);
}

function applyVolume() {
  /*
   * 用户手动拖音量条时，**必须取消正在进行的淡入淡出** ——
   * 否则动画每一帧都会把 volume 写回去，用户会看到滑块跟着乱跳。
   */
  if (fadeRaf) {
    cancelAnimationFrame(fadeRaf);
    fadeRaf = 0;
  }
  audio.volume = state.muted ? 0 : state.volume;

  const shown = state.muted ? 0 : state.volume;
  const pct = Math.round(shown * 100);

  const slider = $('#vol');
  slider.value = String(pct);
  slider.style.setProperty('--vol-pct', `${pct}%`);
  $('#vol-value').textContent = String(pct);

  let icon = VOL_ICONS.high;
  if (state.muted || state.volume === 0) icon = VOL_ICONS.mute;
  else if (state.volume < 0.34) icon = VOL_ICONS.low;
  else if (state.volume < 0.7) icon = VOL_ICONS.mid;
  $('#vol-btn').textContent = icon;

  $('#vol-btn').classList.toggle('muted', state.muted || state.volume === 0);
}

function setVolume(v, { persist = true } = {}) {
  state.volume = clamp01(v);
  if (state.volume > 0) state.muted = false;
  if (persist) {
    try {
      localStorage.setItem(VOLUME_KEY, String(state.volume));
    } catch {
      /* 忽略 */
    }
  }
  applyVolume();
}

$('#vol').addEventListener('input', (e) => setVolume(Number(e.target.value) / 100));

$('#vol-btn').addEventListener('click', () => {
  // 静音前记住原音量，取消静音时恢复
  if (state.muted || state.volume === 0) {
    state.muted = false;
    if (state.volume === 0) state.volume = state._lastVolume || 0.85;
    applyVolume();
  } else {
    state._lastVolume = state.volume;
    state.muted = true;
    applyVolume();
  }
});

/** 滚轮调音量（在音量区上滚） */
$('.pb-volume').addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    setVolume(state.volume + (e.deltaY < 0 ? 0.05 : -0.05));
  },
  { passive: false }
);

/* ------------------------------------------------------------------ */
/* 播放模式                                                            */
/* ------------------------------------------------------------------ */

const PLAY_MODES = [
  { key: 'list', icon: '⇄', name: '列表循环' },
  { key: 'single', icon: '↻', name: '单曲循环' },
  { key: 'shuffle', icon: '⤨', name: '随机播放' },
];

const MODE_KEY = 'music-player.playmode';
state.playMode = localStorage.getItem(MODE_KEY) || 'list';
if (!PLAY_MODES.some((m) => m.key === state.playMode)) state.playMode = 'list';

function applyPlayMode() {
  const mode = PLAY_MODES.find((m) => m.key === state.playMode) || PLAY_MODES[0];
  $('#pb-mode').textContent = mode.icon;
  $('#pb-mode').title = `播放模式：${mode.name}（L 切换）`;
  $('#pb-mode').classList.toggle('active', state.playMode !== 'list');
}

function cyclePlayMode() {
  const i = PLAY_MODES.findIndex((m) => m.key === state.playMode);
  state.playMode = PLAY_MODES[(i + 1) % PLAY_MODES.length].key;
  try {
    localStorage.setItem(MODE_KEY, state.playMode);
  } catch {
    /* 忽略 */
  }
  applyPlayMode();
  toast(`播放模式：${PLAY_MODES.find((m) => m.key === state.playMode).name}`);
}

$('#pb-mode').addEventListener('click', cyclePlayMode);

/**
 * 沿指定方向走一步的下标。
 *
 * 专门给"自动跳过播不了的歌"用，和下面 nextIndex/prevIndex 的区别是：
 * **不套用"播过 3 秒就重播当前"那条播放器习惯**。
 *
 * 为什么必须分开：上一版自动跳过写死了 `playAt(nextIndex())`，而 nextIndex
 * 算的是 `state.index + 1`；可 state.index 在 playAt 开头就被改成目标下标了，
 * 于是"点上一曲 → 上一首是 VIP 播不了 → 自动跳过"会把下标 +1 加回来，
 * **正好弹回用户原来在听的那首歌**（表现为"点上一曲却重播了当前歌曲"）。
 * 而且这时 audio.currentTime 还是上一首的，如果再套用 prevIndex 的
 * ">3 秒就重播当前"规则，就会原地打转，永远跳不出去。
 *
 * @param {'next'|'prev'} dir
 */
function stepIndex(dir) {
  const len = state.queue.length;
  if (!len) return -1;
  if (state.playMode === 'shuffle') {
    if (len === 1) return 0;
    let n = state.index;
    while (n === state.index) n = Math.floor(Math.random() * len);
    return n;
  }
  // 单曲循环下不换歌（见 nextIndex 里的说明）
  if (state.playMode === 'single') return state.index;
  const n = state.index + (dir === 'prev' ? -1 : 1);
  if (n >= len) return 0;
  if (n < 0) return len - 1; // 到头了绕回队尾
  return n;
}

/** 下一首的下标（考虑随机与循环） */
function nextIndex() {
  if (!state.queue.length) return -1;
  if (state.playMode === 'shuffle') {
    if (state.queue.length === 1) return 0;
    let n = state.index;
    // 避免随机到同一首
    while (n === state.index) n = Math.floor(Math.random() * state.queue.length);
    return n;
  }
  if (state.playMode === 'single') return state.index;
  const nn = state.index + 1;
  if (nn >= state.queue.length) return 0;
  return nn;
}

/** 上一首的下标（播过 3 秒则重播当前，符合常见播放器习惯） */
function prevIndex() {
  if (!state.queue.length) return -1;
  if (audio.currentTime > 3) return state.index;
  return stepIndex('prev');
}

/* ------------------------------------------------------------------ */
/* 播放控制                                                            */
/* ------------------------------------------------------------------ */

$('#pb-toggle').addEventListener('click', () => {
  if (!audio.src) {
    if (state.queue.length) playAt(0);
    return;
  }
  if (audio.paused) {
    audio.play();
    fadeIn(PAUSE_FADE_MS);
  } else {
    /*
     * 暂停**延迟到淡出结束**再执行。
     * 直接 pause() 是瞬时的，淡出就没有意义了。
     * 140ms 的延迟人手感觉不到。
     */
    fadeOut(PAUSE_FADE_MS, () => audio.pause());
  }
});

$('#pb-next').addEventListener('click', () => playAt(nextIndex(), 'next'));
$('#pb-prev').addEventListener('click', () => playAt(prevIndex(), 'prev'));

audio.addEventListener('play', () => {
  $('#pb-toggle').textContent = '⏸';
  // 播放：效果恢复运动
  if (bg) bg.setPlaying(true);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  updateMediaSession();
  reportPlayHistory();
});
audio.addEventListener('pause', () => {
  $('#pb-toggle').textContent = '▶';
  /*
   * 暂停：让所有粒子效果回到**初始状态**。
   * 否则 uTime 会继续推进 —— 星盘还在转、扫描线还在扫、雨还在下，
   * 看起来就是"暂停了但动画没停"。
   */
  if (bg) bg.setPlaying(false);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
});

audio.addEventListener('ended', () => {
  if (state.playMode === 'single') {
    // 单曲循环也淡一下：接缝处的声音突变最容易听出来
    audio.currentTime = 0;
    audio.volume = 0;
    audio.play();
    fadeIn(FADE_IN_MS);
    return;
  }
  playAt(nextIndex(), 'next');
});
audio.addEventListener('error', () => {
  if (audio.src) toast('音频加载失败，可能地址已过期', true);
});

audio.addEventListener('timeupdate', () => {
  const cur = audio.currentTime || 0;
  const dur = audio.duration || 0;
  $('#pb-cur').textContent = fmtDur(cur);
  $('#pb-dur').textContent = fmtDur(dur);
  if (dur > 0) $('#pb-seek').value = String(Math.round((cur / dur) * 1000));

  // 逐字歌词高亮
  lyricView.update(cur);
  updateStageText();
  updateMediaPosition();
});

// 拖动进度条后立刻重新对齐歌词游标
$('#pb-seek').addEventListener('input', (e) => {
  const dur = audio.duration || 0;
  if (dur > 0) {
    audio.currentTime = (Number(e.target.value) / 1000) * dur;
    lyricView.update(audio.currentTime);
    updateStageText();
  }
});

window.addEventListener('keydown', (e) => {
  if (e.target && e.target.tagName === 'INPUT') return;

  if (e.code === 'Space') {
    e.preventDefault();
    $('#pb-toggle').click();
  }
  if (e.code === 'ArrowRight' && e.ctrlKey) $('#pb-next').click();
  if (e.code === 'ArrowLeft' && e.ctrlKey) $('#pb-prev').click();
  /*
   * 不带修饰键的左右方向键 = 快退 / 快进。
   * 用 e.code（物理键位）而不是 e.key —— 换了键盘布局也不会错位。
   * 和 Ctrl 组合是刻意分开的两件事：切歌和跳时间不该挤在一个键上。
   */
  if (e.code === 'ArrowRight' && !e.ctrlKey) {
    e.preventDefault();
    seekBy(SEEK_STEP);
  }
  if (e.code === 'ArrowLeft' && !e.ctrlKey) {
    e.preventDefault();
    seekBy(-SEEK_STEP);
  }

  // 音量：上下方向键，Shift 加速
  if (e.code === 'ArrowUp') {
    e.preventDefault();
    setVolume(state.volume + (e.shiftKey ? 0.1 : 0.05));
  }
  if (e.code === 'ArrowDown') {
    e.preventDefault();
    setVolume(state.volume - (e.shiftKey ? 0.1 : 0.05));
  }
  /*
   * 单键快捷键改成需要 Alt。
   *
   * 原因：窗口有焦点时，光按 M/L/F 就触发 —— 太容易手滑。
   * 而且**静音那条必须删掉**：Alt+M 已经注册成全局热键了，
   * 窗口内再留一条 Alt+M 的话，有焦点时两条都会跑，
   * 静音被切两次 = 看起来完全没反应。全局那条负责静音就够了。
   */
  if (e.altKey && (e.key === 'l' || e.key === 'L')) cyclePlayMode();
  if (e.altKey && (e.key === 'f' || e.key === 'F')) void toggleLike();

  // 歌词时间轴微调
  if (e.key === '[') document.querySelector('.timing-btn[data-delta="-0.1"]').click();
  if (e.key === ']') document.querySelector('.timing-btn[data-delta="0.1"]').click();
});

/**
 * 宽屏时把封面往左偏，给右侧歌词面板让出构图空间；窄屏居中。
 * 这是构图问题，不是功能问题 —— 封面偏一边、文字在另一边，画面才有张弛。
 */
function applyCoverShift() {
  if (!bg) return;
  const wide = window.innerWidth > 900;
  // 封面**始终居中**。原来宽屏时左移 1.7 是为了给右侧的歌词面板让位，
  // 但现在歌词已经是 3D 舞台里那行大字了，不再需要让位 —— 偏着反而难看。
  bg.setCoverShift(0, 0);
}

window.addEventListener('resize', applyCoverShift);

/* ------------------------------------------------------------------ */
/* 无边框窗口控制                                                      */
/* ------------------------------------------------------------------ */

$('#btn-settings').addEventListener('click', () => settingsPanel.toggleOpen());

if (window.api && window.api.win) {
  $('#win-min').addEventListener('click', () => window.api.win.minimize());
  $('#win-max').addEventListener('click', () => window.api.win.maximize());
  $('#win-close').addEventListener('click', () => window.api.win.close());
  $('#titlebar').addEventListener('dblclick', () => window.api.win.maximize());
} else {
  $$('#titlebar .win-controls button').forEach((b) => b.remove());
}

/**
 * 播放条上的实时帧率
 * 让"流畅度"这件事随时可见，而不是卡了才知道
 */
function updateFpsChip(fps, scale) {
  const chip = document.getElementById('fps-chip');
  if (!chip) return;
  const pct = scale < 0.99 ? ` · ${Math.round(scale * 100)}%` : '';
  chip.textContent = `${fps} FPS${pct}`;
  chip.className = `fps-chip ${fps >= 55 ? 'good' : fps >= 40 ? 'mid' : 'bad'}`;
  chip.title =
    fps >= 55 ? '流畅' : fps >= 40 ? '略有掉帧 —— 试试设置里的「流畅优先」档' : '掉帧明显 —— 建议切到「流畅优先」档';
}

/* ------------------------------------------------------------------ */
/* 音频节拍 → 粒子脉冲                                                 */
/* ------------------------------------------------------------------ */

/**
 * 音频节拍 → 粒子脉冲
 *
 * 这里有一个很容易踩的坑：MediaElementAudioSourceNode 对**跨域媒体**会输出
 * 静音。酷狗的音频在 sharefs.kugou.com 上，如果它没有返回 CORS 头，
 * getByteFrequencyData 拿到的就全是 0 —— 永远检测不到鼓点，而且不会报错。
 *
 * 所以这里全程记录状态（控制台执行 __particleDebug = true 打开），
 * 并且提供手动触发（按 P）用来隔离问题：如果手动触发能跳、音频不跳，
 * 那就是音频分析链路的问题，不是粒子渲染的问题。
 */
let beatDebug = null;

/**
 * 是否采集节拍诊断。
 *
 * 这些诊断对象原来是**每帧无条件**创建的（165Hz 屏上每秒 155 个短命对象），
 * 纯粹是 GC 压力。现在只有把 `globalThis.__beatDebug = true` 打开时才采，
 * 平时一帧都不分配。要排查鼓点问题的时候在控制台打开它即可。
 */
let wantBeatDump = false;

/**
 * 切歌时重置节拍跟踪状态的钩子。
 *
 * 由下面的节拍闭包赋值。之所以要重置：速度估计和 ODF 历史是按"当前这首歌"
 * 积累的，换歌之后如果不清空，上一首的拍周期和相位会混进新歌的估计里，
 * 表现为换歌后前几秒节奏明显不对劲（甚至按着上一首的拍子在跳）。
 */
let resetBeatState = null;

function manualPulse() {
  if (bg) bg.pulse(1.2);
  toast('手动触发一次节拍脉冲');
}

window.addEventListener('keydown', (e) => {
  if (e.target && e.target.tagName === 'INPUT') return;
  if (e.key === 'p' || e.key === 'P') manualPulse();
});

(function wireAudioReactive() {
  let ctx = null;
  let analyser = null;
  let bins = null;
  /** 上一帧的频谱，用来算频谱通量（每个频点涨了多少） */
  let prevBins = null;
  /** 通量历史（约 1.2 秒），用来算自适应门限 */
  const fluxHist = [];
  /** 最近 3 帧的通量，用来判"局部极大"（每个鼓点只认一个峰） */
  const fluxWin = [];
  /** ODF（通量）历史，约 8 秒，自相关估速度用 */
  const odfHist = [];
  /** 实测的分析帧间隔（毫秒），把自相关的"滞后帧数"换算成时间 */
  let frameMs = 16.7;
  /** 估出的拍周期（毫秒）。0 = 还没估出来 */
  let beatPeriodMs = 0;
  /** 下一个预测拍点的时间戳 */
  let nextBeatAt = 0;
  /** 速度估计的可信度 0~1 */
  let tempoConf = 0;
  /** 最佳滞后处的归一化相关系数，仅用于诊断 */
  let tempoR = 0;
  /**
   * 速度是否已"锁定"。
   *
   * 锁定后自相关只在当前周期 ±12% 内搜索、周期每次只修正 5% ——
   * 这是为了不让速度估计的抖动传到拍点上（实测全局重估会让 BPM 在 124~151 间跳）。
   * 用滞回控制（0.6 锁 / 0.25 解），避免在阈值附近反复切换。
   */
  let tempoLocked = false;
  /** 锁定那一刻的周期，作为硬性限幅的锚点（防止周期跑飞） */
  let lockedPeriodMs = 0;
  /**
   * 自相关给出的权威周期（抛物线插值后，亚帧精度）。
   * 只由 ODF 决定，不受相位校正影响，也是搜索窗的锚点。
   */
  let autocorrPeriodMs = 0;
  /** 最近几次自相关估计，用于取中位数当冻结值 */
  const recentEsts = [];
  /** 递增的拍序号，用来限制"每拍最多校正一次相位" */
  let beatIndex = 0;
  /** 已经做过相位校正的拍序号 */
  let correctedBeat = -1;
  /** 平滑后的每拍力度，避免逐拍幅度忽大忽小 */
  let beatStrength = 0;
  /** 最近几拍的相位误差，用于诊断（只记录，不反馈进周期） */
  const phaseErrs = [];
  /** 16 段频谱强度，低频在前（"声纹星盘"用） */
  const bandLevels = new Array(16).fill(0);
  /** 估出的 BPM，仅用于诊断显示 */
  let estimatedBpm = 0;
  let lastTempoMs = 0;
  let baseline = 0;
  let last = 0;
  let lastTick = 0;
  /** 上次做频谱分析的时间戳，用来把分析限流到 ~60Hz */
  let lastAnalyserMs = 0;
  let armed = false;
  let lastPeak = 0;
  let triggers = 0;
  /** 最近若干次触发的时刻，用来算"鼓点间隔是否稳定" */
  const triggerTimes = [];

  const fail = (reason) => {
    beatDebug = { ok: false, reason };
    console.warn(`[节拍] 音频分析不可用: ${reason} —— 粒子不会跟鼓点。可按 P 手动触发验证渲染是否正常`);
  };

  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return fail('浏览器不支持 AudioContext');

    ctx = new AC();
    const src = ctx.createMediaElementSource(audio);
    analyser = ctx.createAnalyser();
    /*
     * fftSize 1024 → 频率分辨率约 43Hz（44.1kHz 下），512 个频点。
     * 鼓点检测只要低频那十几个频点，这个分辨率够用，而且窗口只有 23ms，
     * 对瞬态响应快。再大（2048/4096）窗口变长，鼓点的"砸下来"就被平均掉了。
     */
    analyser.fftSize = 1024;

    /*
     * smoothingTimeConstant 必须调低 —— 这是"跟不上节奏"的主因。
     *
     * 它是 Web Audio 对频谱做的**时间平滑**：
     *     输出 = k × 上一帧 + (1-k) × 当前帧
     * 默认 0.8，我原来设的 0.6 也偏高。鼓点靠的就是**瞬态**（一瞬间砸下来的能量），
     * 平滑恰恰把这个瞬态抹平：底鼓的峰值要 50~100ms 才爬到位。
     * 于是视觉上的"跳"会稳定地晚于听到的鼓点 100ms 以上，听起来就是"踩不准"。
     *
     * 检测瞬态就该几乎不平滑。设 0 之后每一帧都是当下真实的频谱，
     * 鼓点的上升沿立刻可见；噪声变多没关系，后面有阈值和最小间隔兜着。
     */
    analyser.smoothingTimeConstant = 0;

    // dB 映射范围。默认 -100~-30 偏窄，鼓点很容易顶到 255 削顶，
    // 削顶之后所有重拍都变成同一个值，力度差异（重拍跳得高）就没了。
    analyser.minDecibels = -95;
    analyser.maxDecibels = -18;

    src.connect(analyser);
    analyser.connect(ctx.destination);

    bins = new Uint8Array(analyser.frequencyBinCount);
    // 通量要跟上一帧逐频点相减，所以得留一份上一帧的频谱
    prevBins = new Uint8Array(analyser.frequencyBinCount);
    beatDebug = { ok: true, state: ctx.state };

    /*
     * 换歌时把速度估计、相位、ODF 历史全部清空，从这首歌重新估。
     * 保留 beatPeriodMs 也没意义 —— 新歌的速度可能完全不同，
     * 用旧值起搏会让前几秒明显踩错。
     */
    resetBeatState = () => {
      odfHist.length = 0;
      fluxHist.length = 0;
      fluxWin.length = 0;
      beatPeriodMs = 0;
      nextBeatAt = 0;
      tempoConf = 0;
      tempoR = 0;
      tempoLocked = false;
      lockedPeriodMs = 0;
      autocorrPeriodMs = 0;
      recentEsts.length = 0;
      beatIndex = 0;
      correctedBeat = -1;
      phaseErrs.length = 0;
      beatStrength = 0;
      estimatedBpm = 0;
      lastTempoMs = 0;
      baseline = 0;
    };
  } catch (e) {
    return fail(`初始化失败: ${e.message}`);
  }

  audio.addEventListener('play', () => {
    // 自动播放策略会让 AudioContext 处于 suspended，必须显式恢复
    if (ctx.state === 'suspended') {
      ctx.resume().then(
        () => console.log('[节拍] AudioContext 已恢复:', ctx.state),
        (e) => fail(`AudioContext 恢复失败: ${e.message}`)
      );
    }
    armed = true;
  });

  audio.addEventListener('error', () => fail('音频元素报错'));

  const tick = (ts) => {
    requestAnimationFrame(tick);
    if (!armed || !analyser) return;

    const now = ts || performance.now();

    /*
     * 暂停时不要打拍子 —— 这是我引入"预测式起搏"之后漏掉的一条。
     *
     * 拍点是**按时钟预测**出来的，不是每次都要有鼓点证据。所以暂停之后音频虽然
     * 变静音了，时钟照样在走，`while (now >= nextBeatAt)` 就继续按旧周期推脉冲 ——
     * 表现就是"歌停了、粒子还在跳"。实测日志里也留下了痕迹：
     * energy/flux 已经是 0（静音），却还有好几个采样周期显示"已锁定"，
     * 那十几秒里一直在空打拍子。
     *
     * 这里直接提前返回：不分析、不起搏，并把 nextBeatAt 清零，
     * 下次恢复播放时重新对齐相位，而不是把暂停期间欠下的拍子一次性补上。
     * 注意只停"节拍脉冲"，环境动效（uTime 驱动的那部分）照常，画面不会僵住。
     */
    if (audio.paused || audio.ended) {
      nextBeatAt = 0;
      lastAnalyserMs = now;
      lastTick = now;
      return;
    }

    /*
     * 节拍分析限制到 ~60Hz。
     *
     * 它跟着 rAF 跑，在 165Hz 屏上就是每秒 155 次 getByteFrequencyData ——
     * 那是一次跨线程的 FFT 结果读取，而且每次还要建一个诊断对象（每秒 155 个
     * 垃圾对象，GC 一抖就是一次卡顿）。
     * 鼓点检测不需要这个采样率：16ms 的采样间隔已经远超听觉分辨需求。
     */
    if (now - lastAnalyserMs < 16) return;
    lastAnalyserMs = now;

    const dt = lastTick ? Math.min(0.1, (now - lastTick) / 1000) : 0.016;
    lastTick = now;

    analyser.getByteFrequencyData(bins);

    /*
     * 算 16 段频谱，喂给"声纹星盘"。
     *
     * 频段按**对数**划分，不是均匀划分 —— 人耳对频率的感知本来就是对数的，
     * 而且音乐的频谱能量绝大部分集中在低频。均匀切 16 段的话，
     * 最后一多半段永远是空的，图形只有左边一小角在动。
     *
     * 范围取 40Hz ~ 12kHz（吉他、人声、镲片的基音和泛音都在里面）：
     *   bin 宽度 = sampleRate / fftSize，44.1kHz / 1024 ≈ 43Hz
     */
    {
      const binHz = (ctx.sampleRate || 44100) / analyser.fftSize;
      const fLo = 40;
      const fHi = 12000;
      for (let i = 0; i < 16; i++) {
        // 第 i 段覆盖的频率区间（对数等分）
        const f0 = fLo * Math.pow(fHi / fLo, i / 16);
        const f1 = fLo * Math.pow(fHi / fLo, (i + 1) / 16);
        const b0 = Math.max(0, Math.min(bins.length - 1, Math.round(f0 / binHz)));
        const b1 = Math.max(b0, Math.min(bins.length - 1, Math.round(f1 / binHz) - 1));

        let sum = 0;
        for (let k = b0; k <= b1; k++) sum += bins[k];
        const avg = sum / Math.max(1, b1 - b0 + 1) / 255;

        /*
         * 提亮：byte 频谱是 dB 映射的，平均值天然偏低（典型 0.1~0.4），
         * 直接用图形会几乎不动。开方把中低段拉起来，观感才"有反应"。
         */
        bandLevels[i] = Math.min(1, Math.pow(avg, 0.6) * 1.5);
      }
      if (bg && bg.setBands) bg.setBands(bandLevels);
    }

    const B = settings.beat;
    const lo = Math.max(0, Math.min(bins.length - 1, Math.round(B.bandLow)));
    const hi = Math.max(lo, Math.min(bins.length - 1, Math.round(B.bandHigh)));
    const bandCount = hi - lo + 1;

    /*
     * ============ 鼓点检测：频谱通量（spectral flux） ============
     *
     * 这是在大量实测数据之后推翻重写的一版，把之前那套"频段平均能量 vs 慢基线乘系数"
     * 整个换掉了。原因是那套方法有个**结构性缺陷**，不是调参能救的：
     *
     *   慢基线（τ=4 秒）会把鼓点自己也平均进去。于是在持续很响的段落里，
     *   基线被抬到接近鼓点峰值，阈值 = 基线 ×1.375 就**高过了鼓点本身** ——
     *   实测日志：energy 0.46~0.53 而 threshold 0.628~0.647，
     *   能量永远低于阈值、一次都触发不了，triggers 卡在 49 不再增长。
     *   表现就是"音乐越嗨、粒子越不动"，恰好是最该跳的地方跳不动。
     *   能触发的时候间隔也是 255→400→442→818ms，变异系数 0.54~0.90，完全跟不上。
     *
     * 通量法的思路完全不同：不看"现在有多响"，而看**每个频点相对上一帧涨了多少**：
     *     flux = Σ max(0, bins[i] - prevBins[i])
     * 鼓点是"一瞬间砸下来"，各频点同时上冲，通量出现尖峰；
     * 而持续的低音只是"一直维持"，通量接近 0。这才是瞬态的正确判据。
     *
     * 关键是**自适应阈值**：拿最近约 1.5 秒通量的均值 + 标准差当门限。
     * 响的段落里通量基线一起抬高，但鼓点的上冲仍然显著高于这段波动，
     * 所以照样能触发 —— 从根本上解决了"越响越跳不动"。
     */
    let flux = 0;
    for (let i = lo; i <= hi; i++) {
      const d = bins[i] - prevBins[i];
      if (d > 0) flux += d; // 只取上升部分：能量回落不算敲击
      prevBins[i] = bins[i];
    }
    flux /= bandCount * 255;

    // 通量历史（约 1.2 秒），用来算自适应门限
    fluxHist.push(flux);
    if (fluxHist.length > 72) fluxHist.shift();

    /*
     * 3 帧滑动窗口，用来判"局部极大"。
     *
     * 为什么需要：一个鼓点在频谱上往往不是单帧尖峰 —— 低频冲击会带出泛音和衰减尾巴，
     * 通量在相邻两三帧各出现一次次峰。实测就是这个问题：门限调好之后变异系数降到 0.1
     * （看起来"稳定"了），但中位间隔测出来是 206ms，而这首歌元数据里 bpm=142
     * （真实拍间隔 423ms）—— 206 ≈ 423÷2，说明**每拍漏出两个触发**，
     * 只是"稳定地"多打了一下。粒子会一拍跳两下，听起来仍然不跟拍。
     *
     * 只认局部极大就把这类次峰滤掉了：真正的鼓点先升后降，必然是它那一小段里的最高点。
     * 代价是判定延后一帧（约 16ms），可以忽略。
     */
    fluxWin.push(flux);
    if (fluxWin.length > 3) fluxWin.shift();
    const peakFlux = fluxWin.length === 3 ? fluxWin[1] : 0;
    const isPeak = fluxWin.length === 3 && fluxWin[1] > fluxWin[0] && fluxWin[1] >= fluxWin[2];

    let mean = 0;
    for (let i = 0; i < fluxHist.length; i++) mean += fluxHist[i];
    mean /= fluxHist.length;
    let variance = 0;
    for (let i = 0; i < fluxHist.length; i++) variance += (fluxHist[i] - mean) ** 2;
    const sd = Math.sqrt(variance / fluxHist.length);

    /*
     * 门限 = 中位数 × 系数 + 标准差的一部分。
     *
     * 中位数当"噪声底"：历史里大部分帧是没鼓点的低通量，中位数稳稳停在噪声底上，
     * 鼓点尖峰抬不动它（用均值+标准差异则会：尖峰把自己所在分布的 sd 撑大，
     * 门限反而高到只有最猛的几拍能过，实测变异系数 0.53~0.93）。
     * 再掺一点 sd，让门限能随歌曲整体的动态范围自适应。
     */
    const sortedFlux = [...fluxHist].sort((a, b) => a - b);
    const med = sortedFlux[Math.floor(sortedFlux.length / 2)];

    const k = Math.max(1.15, 1.9 - B.sensitivity * 0.9);
    const fluxGate = med * k + sd * 0.35 + 0.003;
    // 绝对下限：整首歌真静音时通量接近 0，不该触发
    const absFloor = 0.005;

    // 顺带算一下频段平均能量，只用于诊断显示（不再参与判定）
    let e = 0;
    let peak = 0;
    for (let i = lo; i <= hi; i++) {
      e += bins[i];
      if (bins[i] > peak) peak = bins[i];
    }
    e /= bandCount * 255;
    lastPeak = Math.max(lastPeak * 0.9, peak);
    baseline += (e - baseline) * (1 - Math.exp(-dt / 4.0));

    const onset = peakFlux - mean;
    /** 这一帧是不是一个够强的鼓点（后面既用于起搏，也用于校正相位） */
    const isOnset = isPeak && peakFlux > absFloor && peakFlux > fluxGate;

    /* ================= 速度估计 + 拍点起搏 =================
     *
     * 为什么必须走到这一步：
     *   只靠"检测到鼓点就跳"，画面永远只能**事后反应** —— 检测器漏一拍、
     *   或者被切分音带偏一次，看起来就是"乱跳"，节奏感建立不起来。
     *   实测过：即使把间隔校准到中位 ~400ms、变异系数 0.18，
     *   主观上仍然「没有节奏感」，因为它不是一个**稳定的周期**。
     *
     * 真正的做法（也是所有节拍跟踪器的做法）分两步：
     *   1. 估速度：对 ODF（通量）做自相关，找出最可能的拍周期。
     *   2. 相位锁定：按估出来的周期**主动起搏**，再用检测到的鼓点校正相位。
     *
     * 关键在于第 2 步是**预测式**的：即使某一拍没检测到，画面照样在正确的
     * 时刻跳下去。节奏感来自稳定预测，而不是零散触发 —— 这正是缺的东西。
     */

    // ODF 历史（约 8 秒），自相关需要足够长的窗口才能估准
    odfHist.push(flux);
    /*
     * ODF 历史（约 12 秒）。
     *
     * 长度直接决定速度估计的准头：太短（3~4 秒）窗口里只装得下几拍，
     * 自相关统计不足、峰值位置随机；12 秒能装 25~30 拍，估计才稳。
     * 代价只是每 0.5 秒多跑一次自相关（约 25 万次乘加，不到 1 毫秒）。
     */
    if (odfHist.length > 720) odfHist.shift();
    // 实测分析帧间隔，用来把"滞后帧数"换算成毫秒
    frameMs += (dt * 1000 - frameMs) * 0.02;

    // ---- 每 0.5 秒重估一次速度 ----
    if (now - lastTempoMs > 500 && odfHist.length >= 180 && frameMs > 4) {
      lastTempoMs = now;

      /*
       * 搜索范围：**锁定之后改成局部微调**，这是"节奏飘"的关键修正。
       *
       * 原来每 0.5 秒都做一次全局搜索（250~1500ms / 40~240 BPM），
       * 实测估出来的 BPM 在 124~151 之间来回跳（真实 142）——
       * 自相关峰本来就会在相邻滞后之间摆动，而全局搜索每次都可能跳到别的峰上
       * （尤其是二倍/一半周期的那个峰）。这些抖动会直接传到拍点上，
       * 听起来就是"踩着踩着就偏了一点"。
       *
       * 真实节拍跟踪器的做法是：**锁上之后只在当前周期附近跟**。
       * 这里锁定后把搜索窗收到 ±12%，估计值就再也跳不到八度之外去了。
       */
      const globalMin = Math.max(4, Math.round(250 / frameMs));
      const globalMax = Math.min(Math.round(1500 / frameMs), odfHist.length - 10);
      /*
       * 搜索窗**始终是全局范围**（250~1500ms，即 40~240 BPM）。
       *
       * 这里我反复栽过同一个跟头，写下来：**不能用"跟着当前周期"的窄窗**。
       * 窄窗的本意是防止估计跳到二倍/一半周期上去，但窗口一旦跟着自己的输出走，
       * 就再也没有真正的锚点 —— 估出 418ms、窗口跟着移到 418 附近、下次又估出 430、
       * 窗口再跟着移……实测 30 秒能漂 5%（418 → 438ms），听感就是"越到后面越飘"。
       *
       * 正确的分工是：
       *   搜索用全局范围（无偏），防八度交给 120 BPM 先验权重，
       *   防止跑飞交给下面"夹在锁定点 ±6% 内"那道硬限幅。
       * 锚点必须是**固定不动**的，不能是任何被自己更新的量。
       */
      const minLag = globalMin;
      const maxLag = globalMax;

      /*
       * 归一化自相关（先在整条滞后轴上算一遍，存进表里）。
       *
       * 必须除以能量 —— 自相关的绝对值取决于 ODF 的整体幅度，而不同歌曲、
       * 甚至同一首歌的不同段落，响度能差好几倍。之前用 `bestScore * 40` 这种
       * 写死的系数来换算可信度，结果可信度常年只有 0.04~0.07（阈值 0.15），
       * **锁定从来没生效过**，系统一直退在"检测到鼓点就跳"的旧路径上。
       * 归一化成相关系数之后，它就是个与幅度无关的 0~1 量。
       *
       * 之所以要事先整表算好：下面的梳状滤波要在 P、2P、3P、4P 上取值，
       * 现算的话每个候选周期都要重跑四遍自相关，白白多花几倍时间。
       */
      let energy = 0;
      for (let i = 0; i < odfHist.length; i++) energy += odfHist[i] * odfHist[i];

      const maxHarmonic = 4;
      const acLen = Math.min(odfHist.length - 1, maxLag * maxHarmonic + 2);
      const ac = new Float64Array(acLen + 1);
      for (let lag = 1; lag <= acLen; lag++) {
        let sum = 0;
        for (let i = lag; i < odfHist.length; i++) sum += odfHist[i] * odfHist[i - lag];
        ac[lag] = energy > 1e-12 ? sum / energy : 0;
      }
      const rAt = (lag) => {
        const L = Math.round(lag);
        if (L < 1 || L >= ac.length) return 0;
        return ac[L];
      };

      /*
       * ============ 梳状滤波（谐波求和）============
       *
       * 这是把速度估计做准的核心，取代原来的"单点自相关取峰"。
       *
       * 单点自相关的问题：它只问"隔 P 帧之后波形像不像"，于是**亚倍频和倍频
       * 的得分都很高** —— 真正的拍、以及它的二分之一、一倍，得分接近，
       * 稍微一点扰动就会让峰值在它们之间跳。实测就是这个问题：估出的周期
       * 在 418~467ms 之间游走（真实 423ms），怎么调平滑都压不住。
       *
       * 梳状滤波问的是另一件事："如果每 P 帧有一拍，那么 P、2P、3P、4P 处
       * 都应该有能量"。真正的拍周期在它的所有整数倍上都对齐，得分会明显高于
       * 那些只有局部对齐的候选 —— 尤其是二分之一周期：它只在偶数倍上对齐，
       * 奇数倍上错开，求和之后自然被压下去。
       *
       * 高次谐波除以 k 递减加权：远处的对齐更不可靠（一点周期误差在几倍之后
       * 就偏掉了），不给它同等话语权。
       */
      let bestLag = 0;
      let bestScore = 0;
      let bestR = 0;
      const combAt = (lag) => {
        let s = 0;
        for (let k = 1; k <= maxHarmonic; k++) {
          const L = Math.round(lag * k);
          if (L >= ac.length) break;
          s += ac[L] / k;
        }
        return s;
      };

      for (let lag = minLag; lag <= maxLag; lag++) {
        const comb = combAt(lag);
        /*
         * 偏向 120 BPM 的先验权重。
         * 梳状滤波已经压掉了大部分倍频歧义，但先验仍然有用 ——
         * 极慢的曲子（40~60 BPM）容易和它的二倍混淆，这里给个软引导。
         */
        const bpm = 60000 / (lag * frameMs);
        const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.85, 2));
        const score = comb * w;
        if (score > bestScore) {
          bestScore = score;
          bestR = comb;
          bestLag = lag;
        }
      }

      /*
       * 抛物线插值：整数滞后的分辨率不够。
       *
       * 自相关只能在**整数帧**上取滞后，而 frameMs ≈ 16.7ms ——
       * 对一个 423ms 的周期来说，相邻滞后是 417.5 和 434ms，
       * 也就是分辨率只有 ±8ms、约 ±2%。实测估出的周期是 426~434ms（真实 423），
       * 误差 1~2.5%，正好落在这个量化范围里。而 1.5% 的周期误差，
       * 30 秒就会累积出 450ms 以上的相位偏移 —— 超过一整拍。
       *
       * 在峰值附近用三个点拟一条抛物线取顶点，就能得到亚帧精度。
       * 注意插值用的是**梳状滤波的得分曲线**（不是单点自相关），
       * 因为真正被最大化的目标就是它，在它上面找顶点才自洽。
       */
      const scoreAt = (lag) => {
        if (lag < 1) return 0;
        const bpm = 60000 / (lag * frameMs);
        const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.85, 2));
        return combAt(lag) * w;
      };
      let refinedLag = bestLag;
      if (bestLag > 0) {
        const s0 = bestScore;
        const sm = scoreAt(bestLag - 1);
        const sp = scoreAt(bestLag + 1);
        const denom = sm - 2 * s0 + sp;
        // 顶点偏移量，限幅到 ±1 帧，避免退化成尖峰时插值乱飞
        const delta = Math.abs(denom) > 1e-9 ? (0.5 * (sm - sp)) / denom : 0;
        refinedLag = bestLag + Math.max(-1, Math.min(1, delta));
      }

      let est = refinedLag * frameMs;

      /*
       * 可信度仍然用**归一化自相关系数**，不用梳状得分。
       *
       * 梳状得分是 4 个谐波的和（最高约 2.08），量纲和"相关系数"完全不同；
       * 而 `(r - 0.08) / 0.3` 这套阈值是按相关系数标定过的（实测 r 0.5~0.7
       * 对应很明确的节拍），直接换量纲会把阈值全部带偏。
       * 所以周期用梳状滤波来选（更准），可信度还是看该周期上的相关系数（可比）。
       */
      bestR = ac[Math.max(1, Math.min(ac.length - 1, Math.round(refinedLag)))];

      if (bestLag > 0 && bestR > 0.05) {
        // 记录自相关"想给"的周期，只用于诊断对比
        autocorrPeriodMs = autocorrPeriodMs > 0 ? autocorrPeriodMs + (est - autocorrPeriodMs) * 0.08 : est;
        // 相关系数 0.08 以下基本等于没有周期性，0.38 以上就是很明确的节拍
        tempoConf = Math.max(0, Math.min(1, (bestR - 0.08) / 0.3));

        // 攒最近几次估计，用来求中位数当冻结值
        recentEsts.push(est);
        if (recentEsts.length > 7) recentEsts.shift();
      } else {
        // 这一段听不出周期（前奏、间奏、无鼓点），逐步降低信任
        tempoConf *= 0.85;
      }

      /*
       * ================= 周期"硬冻结" =================
       *
       * 这是"到后面感觉有点飘"的最终解法，也是我前面绕了好几圈才想通的地方。
       *
       * 试过并且都不行的做法：
       *   1. 周期每次修正 5%          → 27 秒漂 8.5%，越走越快
       *   2. 夹在锁定点 ±6% 内         → 不再跑飞，但估计值本身仍在 417~444 之间游走
       *   3. 窄搜索窗（跟着周期走）    → 自引用反馈，漂得更厉害
       *   4. 抛物线插值提高单次精度    → 精度确实到亚帧了，但峰的位置本身在动
       *
       * 根本原因：自相关是在 8 秒窗口上算的，歌曲进入不同段落（配器变了、切分音多了）
       * 时，它测到的"主导周期性"就会变。**这是加窗自相关在真实音乐上的固有性质，
       * 不是参数没调好**。只要还在持续更新周期，它就一定会跟着段落游走，
       * 听感就是"踩得挺准，但过一会儿就偏了"。
       *
       * 所以这里直接**冻结**：锁定那一刻的周期存进 lockedPeriodMs，之后一个数都不改。
       * 相位校正照常工作（它只调时刻、不调周期），拍点因此绝对均匀。
       *
       * 唯一的逃生口：相位误差的长期均值如果持续偏向一边、且大到接近半个拍子，
       * 那说明冻结的这个周期确实是错的（或者歌真的变速了），这时才解锁重估。
       * 用长期均值而不是单拍判断，是为了不被切分音和偶发误检触发。
       */
      if (!tempoLocked && tempoConf > 0.6 && recentEsts.length >= 5) {
        /*
         * 冻结值取最近几次估计的**中位数**，不取瞬时值。
         *
         * 实测教训：直接用当前估计冻结，结果冻在 407ms（148 BPM），
         * 而真实是 423ms（142 BPM）—— 收敛还没完成就锁死了，偏了 3.8%。
         * 中位数对个别跑偏的估计不敏感，攒够 5 次（约 2.5 秒）再冻更接近真值。
         */
        const sortedEst = [...recentEsts].sort((a, b) => a - b);
        lockedPeriodMs = sortedEst[Math.floor(sortedEst.length / 2)];
        tempoLocked = true;
        console.log(
          `[节拍] 周期已冻结在 ${Math.round(lockedPeriodMs)}ms（约 ${Math.round(60000 / lockedPeriodMs)} BPM）` +
            `，取自 ${recentEsts.length} 次估计的中位数`
        );
      } else if (tempoLocked && tempoConf < 0.25) {
        tempoLocked = false;
        lockedPeriodMs = 0;
        recentEsts.length = 0;
      }

      if (tempoLocked && lockedPeriodMs > 0) {
        beatPeriodMs = lockedPeriodMs; // 冻结：不跟随任何估计值
      } else if (autocorrPeriodMs > 0) {
        beatPeriodMs = autocorrPeriodMs;
      }

      estimatedBpm = beatPeriodMs > 0 ? Math.round(60000 / beatPeriodMs) : 0;
      tempoR = bestR;
    }

    /*
     * 冻结周期的逃生口：长期相位误差持续偏向一边且过大 → 说明周期冻错了。
     * 判据用"均值绝对值 > 周期的 22%"，正常跟踪时均值只有几十毫秒、远达不到。
     */
    if (tempoLocked && phaseErrs.length >= 10) {
      let s = 0;
      for (const v of phaseErrs) s += v;
      const avg = s / phaseErrs.length;
      if (Math.abs(avg) > beatPeriodMs * 0.22) {
        console.warn(`[节拍] 相位长期偏 ${Math.round(avg)}ms（超过半拍的 44%），冻结周期可能不准，解锁重估`);
        tempoLocked = false;
        lockedPeriodMs = 0;
        autocorrPeriodMs = 0;
        phaseErrs.length = 0;
      }
    }

    // ---- 按预测的拍点起搏 ----
    /*
     * 注意 `audio.paused` 的判断在 tick 开头已经提前返回了，
     * 所以走到这里一定是"正在播放"的状态 —— 暂停时不会再空打拍子。
     */
    const locked = tempoConf > 0.15 && beatPeriodMs > 200 && beatPeriodMs < 1600;
    if (locked) {
      /*
       * 先处理"相位已经过期"的情况：刚起播、刚取消暂停、或长时间卡顿之后，
       * nextBeatAt 可能停在很久以前。这时要**重新对齐**，而不是靠 while 循环
       * 把欠下的拍子一口气补完 —— 那会在恢复播放的瞬间打出一串脉冲，
       * 画面猛地抖一下。
       */
      if (nextBeatAt === 0 || nextBeatAt < now - beatPeriodMs) {
        // 冻结周期后这里不会漂，所以"过拍一整拍"只可能发生在起播/取消暂停之后
        nextBeatAt = now + beatPeriodMs * 0.5;
      }

      /*
       * 已经锁上速度：主动按周期起搏。
       *
       * 力度按最近这段 ODF 的强度来定 —— 音乐安静时轻跳、激烈时重跳，
       * 但**时刻是准的**，这就是"节奏感"的来源。
       */
      while (now >= nextBeatAt) {
        // 最近几帧通量的峰值，代表这一拍有多重
        const lookback = Math.min(odfHist.length, Math.max(3, Math.round(beatPeriodMs * 0.6 / frameMs)));
        let recent = 0;
        for (let i = odfHist.length - lookback; i < odfHist.length; i++) {
          if (i >= 0 && odfHist[i] > recent) recent = odfHist[i];
        }
        /*
         * 力度要留出动态范围，**但不能逐拍抖**。
         *
         * 两个阶段：
         *   1. 用通量算出这一拍"有多重" —— 中位数是"没鼓点时的噪声底"，
         *      真正的鼓点几乎必然超过它，所以系数要取得大一些（4.5 倍），
         *      只有砸得重的拍子才打满，轻拍只跳到六成，才有层次。
         *   2. 再做时间平滑。通量的瞬时值本身有噪声，直接用会让**每一拍的
         *      跳动幅度都不一样** —— 即使时刻是准的，看起来也是"忽大忽小、不齐"。
         *      平滑之后单拍的起伏被抹掉，但跨几拍的强弱变化（段落渐强渐弱）
         *      仍然跟得上。
         */
        const rel = med > 1e-6 ? recent / (med * 4.5) : 0.5;
        const rawStrength = 0.55 + Math.min(1, Math.max(0, rel)) * 0.45;
        beatStrength = beatStrength > 0 ? beatStrength + (rawStrength - beatStrength) * 0.25 : rawStrength;
        if (bg) bg.pulse(beatStrength * B.gain);

        if (triggerTimes.length > 24) triggerTimes.shift();
        triggerTimes.push(nextBeatAt);
        triggers++;
        beatIndex++;

        nextBeatAt += beatPeriodMs;
        // 落后太多（例如切歌、长时间卡顿）就重新对齐，不要疯狂补拍
        if (nextBeatAt < now) nextBeatAt = now + beatPeriodMs;
      }
    } else if (isOnset && now - last > B.minInterval) {
      // ---- 还没估出速度：退回"检测到鼓点就跳"，并以此建立初始相位 ----
      last = now;
      triggers++;
      if (triggerTimes.length > 24) triggerTimes.shift();
      triggerTimes.push(now);
      const excess = Math.min(1, fluxGate > 1e-6 ? (peakFlux - fluxGate) / (fluxGate * 1.5) : 0.5);
      if (bg) bg.pulse((0.55 + excess * 0.55) * B.gain);
      if (nextBeatAt === 0) nextBeatAt = now;
    }

    /*
     * 相位校正：检测到强鼓点时，把预测拍点往它身上拉一点。
     *
     * 两个约束都是为了让节奏**稳**，不是为了更"敏感"：
     *
     * 1. 容差 ±15%（原为 ±30%）。
     *    容差放宽看似"更容易对上"，实际是把**不属于这一拍的瞬态也算进来**
     *    ——这首歌有切分音和八分音符，那些音离预测拍点可能只有 100 多毫秒，
     *    落在 30% 的容差里，于是每拍都被拉好几次，相位来回飘，
     *    表现出来就是"踩着踩着就偏了、不稳"。收紧到 15% 之后，
     *    只有真正贴着拍点的瞬态才参与校正。
     *
     * 2. 每一拍最多校正一次（correctedBeat 记录已校正过的拍序号）。
     *    同一个拍点附近往往有好几个瞬态（鼓的起音、贝斯的音头），
     *    每个都校一次等于把同一个误差反复叠加，同样是飘的来源。
     */
    if (locked && isOnset) {
      const err = now - nextBeatAt;
      if (Math.abs(err) < beatPeriodMs * 0.15 && correctedBeat !== beatIndex) {
        nextBeatAt += err * 0.3;
        correctedBeat = beatIndex;

        /*
         * 把相位误差**只记录下来用于诊断**，绝不反馈进周期。
         *
         * 这里曾经加过一个"积分项"：把最近几拍相位误差的平均值并进周期，
         * 想消掉稳态误差。**那是错的，已经撤掉**，记下来免得以后再犯。
         *
         * 实测后果：周期在 27 秒内从 413ms 一路漂到 378ms（估出 BPM 145→158），
         * 整首歌越走越快。原因是——只要鼓点检测存在**固定的系统性提前**
         * （峰值判定本身带固定延迟），相位误差的平均值就会永远偏向同一个方向，
         * 积分项于是不停地朝一个方向推周期，形成跑飞。
         * 更糟的是自相关搜索窗被写成了"跟着当前周期 ±12%"，窗口跟着漂就再也拉不回来，
         * 构成正反馈闭环。
         *
         * 结论：**周期只该由自相关（对整段 ODF 的全局估计）决定，
         * 相位归相位、周期归周期，两者不要互相反馈。**
         * 现在这里只记录，用于判断"相位实际偏多少、抖多大"。
         */
        phaseErrs.push(err);
        if (phaseErrs.length > 16) phaseErrs.shift();
      }
    }

    /*
     * 慢速基线（只用于诊断显示，不再参与触发判定）。
     * 早期那套"能量 vs 基线乘系数"的判定已被上面的频谱通量取代，
     * 原因见那段注释 —— 慢基线会把鼓点自己平均进去，越响的段落阈值越高，
     * 最终高过鼓点本身、一次都触发不了。
     */
    const baseAlpha = 1 - Math.exp(-dt / 4.0);
    baseline += (e - baseline) * baseAlpha;

    /*
     * 诊断对象**只在真要打日志时才建**。
     *
     * 原来是每帧无条件建一个（165Hz 屏上每秒 155 个短命对象）。
     * 日志本身是 3 秒一次，所以这里用一个标志控制，平时完全不分配。
     */
    if (wantBeatDump) {
      /*
       * 鼓点间隔统计 —— 判断"跟不跟得上节奏"的客观依据。
       *
       * 只看 triggers 总数说明不了问题：跟不准有两种相反的表现，
       * 一种漏拍（总数偏少），一种是噪声乱触发（总数偏多）。
       * 该看的是**间隔的稳定性**：音乐节拍稳定时，相邻触发的间隔应当在某个基准值
       * 附近小幅波动；忽长忽短（变异系数大）的话，即使总数正常，观感也是踩不准。
       */
      const gaps = [];
      for (let i = 1; i < triggerTimes.length; i++) gaps.push(triggerTimes[i] - triggerTimes[i - 1]);
      let gapInfo = '样本不足';
      if (gaps.length >= 4) {
        const sorted = [...gaps].sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)];
        const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
        const cv = sd / mean;
        gapInfo =
          `中位${Math.round(med)}ms(≈${Math.round(60000 / med)}BPM) ` +
          `变异${cv.toFixed(2)} ` +
          (cv < 0.25 ? '稳定' : cv < 0.5 ? '一般' : '忽快忽慢');
      }

      beatDebug = {
        ok: true,
        state: ctx.state,
        armed,
        band: `${lo}-${hi}`,
        energy: +e.toFixed(3),
        flux: +flux.toFixed(4),
        fluxMean: +mean.toFixed(4),
        fluxSd: +sd.toFixed(4),
        fluxMed: +med.toFixed(4),
        fluxGate: +fluxGate.toFixed(4),
        peak: Math.round(lastPeak),
        baseline: +baseline.toFixed(3),
        k: +k.toFixed(2),
        triggers,
        // 速度估计与拍点锁定的状态
        估出BPM: estimatedBpm,
        拍周期ms: beatPeriodMs > 0 ? Math.round(beatPeriodMs) : 0,
        锁定可信度: +tempoConf.toFixed(2),
        自相关r: +tempoR.toFixed(3),
        速度已冻结: tempoLocked,
        每拍力度: +beatStrength.toFixed(2),
        锁定锚点ms: lockedPeriodMs > 0 ? Math.round(lockedPeriodMs) : 0,
        自相关周期ms: autocorrPeriodMs > 0 ? +autocorrPeriodMs.toFixed(1) : 0,
        相位误差: (() => {
          if (phaseErrs.length < 4) return '样本不足';
          let s = 0;
          for (const v of phaseErrs) s += v;
          const m = s / phaseErrs.length;
          let v2 = 0;
          for (const v of phaseErrs) v2 += (v - m) ** 2;
          const sd = Math.sqrt(v2 / phaseErrs.length);
          return `均值${m.toFixed(0)}ms 波动±${sd.toFixed(0)}ms`;
        })(),
        已锁定: !!(tempoConf > 0.15 && beatPeriodMs > 200),
        离下一拍ms: Math.round(nextBeatAt - now),
        间隔: gapInfo,
        // 当前脉冲值 + 当前效果：用来区分"脉冲没产生"和"脉冲没送到着色器"
        pulse: bg ? +bg.pulseValue.toFixed(3) : null,
        target: bg ? +(bg.pulseTarget ?? 0).toFixed(3) : null,
        effect: bg ? bg.effectKey : null,
        fps: bg ? bg.fps : null,
        scale: bg ? +bg.scale.toFixed(2) : null,
      };
    }
  };
  tick();

  /*
   * 性能事件标记。
   *
   * 光有"哪一帧卡了 80ms"还不够 —— 必须能对上"当时发生了什么"，
   * 否则只能猜。切歌、换效果、换页、换封面这些动作都打一个点，
   * 卡顿发生时就能算出最近的标记是什么，直接指向嫌疑犯。
   */
  const perfMarks = [];
  function markPerf(name) {
    perfMarks.push({ t: performance.now(), name });
    if (perfMarks.length > 80) perfMarks.shift();
  }
  window.__mpMark = markPerf;
  window.__mpMarks = () => perfMarks.slice();

  // 每 3 秒报一次真实帧率 + 帧间隔分位数（不需要播放也会输出），用来量化性能问题
  setInterval(() => {
    if (!bg) return;
    const p = settings.particles;
    let line =
      `[帧率] ${bg.fps} FPS  scale=${bg.scale.toFixed(2)}  效果=${bg.effectKey}  ` +
      `密度=${p.density}  泛光=${p.bloom ? p.bloomStrength : '关'}  磨砂=${settings.glassBlur}px`;
    const j = bg.jank;
    if (j) {
      line +=
        `\n[流畅度] p50=${j.p50}ms  p95=${j.p95}ms  p99=${j.p99}ms  最长=${j.max}ms  ` +
        `样本${j.n}  超33ms ${j.over33}  超50ms ${j.over50}`;
      for (const w of j.worst) {
        let best = null;
        let bd = Infinity;
        for (const m of perfMarks) {
          const d = Math.abs(m.t - w.t);
          if (d < bd) {
            bd = d;
            best = m;
          }
        }
        line +=
          `\n   卡顿 ${w.ms}ms` +
          (best && bd < 2000 ? `  ← 最近事件「${best.name}」(${Math.round(bd)}ms 前)` : '  （附近没有事件标记）');
      }
    }
    console.log(line);
    /*
     * 报完就清空卡顿记录。
     * 不清的话每 3 秒都会把同样那几条"历史最差"重打一遍，
     * 真正新发生的卡顿会被埋在重复行里看不见 —— 我要的是"这一刻发生了什么"。
     */
    if (bg._jankLog) bg._jankLog.length = 0;
  }, 3000);

  // 每 3 秒：打一次上一轮采到的节拍状态，然后决定要不要采下一轮。
  // 平时（没开 __beatDebug）只是把 null 打印判断跳过去，零开销。
  setInterval(() => {
    if (beatDebug) {
      console.log('[节拍]', JSON.stringify(beatDebug));
      beatDebug = null;
    }
    wantBeatDump = Boolean(globalThis.__beatDebug);
  }, 3000);
})();

/* ------------------------------------------------------------------ */
/* 性能基准（自动 A/B，用来定位"到底哪一层在吃帧"）                      */
/* ------------------------------------------------------------------ */

/**
 * 逐层测量渲染帧率，用来定位"到底哪一层在吃帧"。
 *
 * 为什么不用 gl.finish() 测 GPU 时间：Chromium 的 WebGL 走命令缓冲区，
 * `gl.finish()` 在渲染进程侧基本是空操作（实测整条管线"0.03ms"，明显不可能是真的），
 * 量到的只是提交命令的时间。
 *
 * 为什么每档要测这么久：这台机器的帧率抖动极大，同一份画面几十秒内能从 30 荡到 133。
 * 所以每档先静置让帧率稳定，再密集采样取**中位数**，避免被瞬时值带偏。
 *
 * 由主进程在 MP_BENCH=1 时自动调用；平时完全不执行。
 */
async function runPerfBench() {
  if (!bg) return { error: '粒子舞台没起来' };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 静置 settleMs 后，密集采若干次 bg.fps，取中位数 */
  async function sampleFps(settleMs = 2500, count = 8, gapMs = 400) {
    await wait(settleMs);
    const s = [];
    for (let i = 0; i < count; i++) {
      s.push(bg.fps);
      await wait(gapMs);
    }
    s.sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  const c = bg.composer;
  const gl = bg.renderer.getContext();
  /*
   * 关键一问：WebGL 到底跑在哪块硬件上。
   *
   * app.getGPUInfo() 报的是"系统里装了哪块显卡"，**不代表这个 WebGL 上下文真的在用它**。
   * Chromium 完全可能因为驱动被拉黑、GPU 进程崩过、或者启动参数问题，把 WebGL
   * 单独退回 CPU 软件渲染（SwiftShader）—— 那样的话，无论怎么优化粒子都是白费力气，
   * 而且现象正是"帧率与画面内容、像素数都无关"。
   * 只有 UNMASKED_RENDERER_WEBGL 才能给出确定答案。
   */
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const glInfo = {
    version: gl.getParameter(gl.VERSION),
    vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : '(无 debug_renderer_info 扩展)',
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '(无 debug_renderer_info 扩展)',
    maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    // SwiftShader 软件渲染的典型特征
    isSoftware: false,
  };
  glInfo.isSoftware = /swiftshader|software|llvmpipe|basic render/i.test(String(glInfo.renderer));

  const sizing = {
    css: `${window.innerWidth}x${window.innerHeight}`,
    dpr: window.devicePixelRatio,
    scale: bg.scale,
    drawingBuffer: `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`,
    composer: c ? `${c._width}x${c._height}@${c._pixelRatio}` : null,
    blurOn: !document.documentElement.classList.contains('no-glass-blur'),
    gl: glInfo,
  };

  const results = [];
  async function measure(label, apply, undo) {
    apply();
    const fps = await sampleFps();
    if (undo) undo();
    await wait(300);
    return { label, fps };
  }

  // 用一个自己控制的 <style> 来切各图层，避免改动真实样式
  const probe = document.createElement('style');
  document.head.appendChild(probe);
  const setCss = (css) => {
    probe.textContent = css;
  };
  const clearCss = () => {
    probe.textContent = '';
  };

  results.push({ label: '完整（当前设置）', fps: await sampleFps() });

  /*
   * 先量出屏幕的刷新率本身。
   *
   * benchSkipRender 会在**限帧判断之前**就 return，所以这一档测到的就是纯 rAF 频率，
   * 也就是显示器的刷新率。
   */
  const refresh = await (async () => {
    bg.benchSkipRender = true;
    const f = await sampleFps(600, 10, 300);
    bg.benchSkipRender = false;
    return f;
  })();
  results.push({ label: '屏幕刷新率（纯 rAF，不限帧）', fps: refresh });

  /*
   * 画质余量扫描。
   *
   * 之前为了迁就核显，把粒子密度砍到 0.5、玻璃磨砂整个关掉了。现在换到独显，
   * 需要知道这些画质项到底还能不能加回来 —— 一项一项加上去，看帧率掉多少。
   */
  const p0 = settings.particles.density;
  results.push(
    await measure(
      `粒子密度 ${p0}（当前）`,
      () => bg.setDensity(p0),
      null
    )
  );

  for (const d of [0.75, 1.0, 1.3]) {
    results.push(await measure(`粒子密度 ${d}`, () => bg.setDensity(d), () => bg.setDensity(p0)));
  }

  // 玻璃磨砂：这是唯一一项纯合成器开销，独显渲染 + 核显输出的混合架构下
  // 未必跟着变便宜，必须实测
  results.push(
    await measure(
      '玻璃磨砂 开（blur 14px）',
      () => applySettings({ ...settings, glassBlur: 14 }),
      () => applySettings({ ...settings, glassBlur: 0 })
    )
  );

  results.push(
    await measure(
      '玻璃磨砂 开 + 密度 1.0',
      () => {
        applySettings({ ...settings, glassBlur: 14 });
        bg.setDensity(1.0);
      },
      () => {
        applySettings({ ...settings, glassBlur: 0 });
        bg.setDensity(p0);
      }
    )
  );

  clearCss();
  probe.remove();
  bg.benchHideParticles = false;
  bg.benchSkipBloom = false;
  bg.benchSkipRender = false;

  return { sizing, results };
}

window.__mpBench = runPerfBench;

/** 探测脚本用：抑制/恢复设置存盘，避免测试状态污染用户存档 */
window.__mpProbeGuard = (on) => {
  suppressSettingsSave = Boolean(on);
  console.log(`[探测] 设置存盘已${suppressSettingsSave ? '抑制' : '恢复'}`);
  return true;
};

/* ------------------------------------------------------------------ */
/* 自动测试的屏幕提示                                                  */
/* ------------------------------------------------------------------ */

/**
 * 测试进行中在窗口最上层显示一条醒目横幅。
 *
 * 为什么需要：自动化测试是在**同一个窗口**里跑的 —— 它会自己点歌、暂停、
 * 切换画质档位。用户从外面看不出任何区别，只会看到"效果怎么自己变了/重置了"，
 * 于是把测试的中间状态当成产品 bug 报回来，来回浪费好几轮。
 * 有了这条横幅，谁都能一眼看出"这个窗口正在跑测试，别拿它当正常状态"。
 *
 * 只在测试模式（MP_BENCH / MP_PULSE / MP_SHOT）下出现，正常运行完全不显示。
 */
window.__mpTestBanner = (text) => {
  let el = document.getElementById('mp-test-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mp-test-banner';
    // 样式内联，避免污染正式样式表
    el.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
      'padding:10px 16px', 'font:600 14px/1.5 system-ui,sans-serif',
      'color:#1a1200', 'background:#ffcc33', 'text-align:center',
      'letter-spacing:.3px', 'box-shadow:0 2px 14px rgba(0,0,0,.5)',
      'pointer-events:none', 'animation:mpTestBlink 1.4s ease-in-out infinite',
    ].join(';');
    const style = document.createElement('style');
    style.textContent =
      '@keyframes mpTestBlink{0%,100%{filter:brightness(1)}50%{filter:brightness(.78)}}';
    document.head.appendChild(style);
    document.body.appendChild(el);
  }
  el.textContent = `⚠ 正在运行自动测试，这个窗口的异常表现不是产品问题 —— ${text}`;
  return true;
};

window.__mpTestBannerOff = () => {
  const el = document.getElementById('mp-test-banner');
  if (el) el.remove();
  return true;
};

/**
 * 分层显示开关，用来分清"哪部分是封面、哪部分是背景效果"。
 *
 * 起因：截图里看到一团白色放射状的东西，但没法确定它是封面层画的
 * 还是背景粒子效果画的 —— 光看一张合成图分不出来，而猜错就会改错地方。
 * 关掉一层再截一张，谁画的立刻清楚。
 */
/**
 * 完全不出图（跳过整条 WebGL 渲染），用来把"主线程 JS"和"GPU/合成器"分开。
 * 这一档还能跑，说明主线程本身不慢 —— 剩下的时间就只能在 GPU/合成器那头。
 */
/**
 * 把当前**实际在画的每一层**列出来。
 *
 * 为什么要这个：用户说"你看有三层，我只要封面的"，而我从读数和截图里
 * 数不出到底是哪三层 —— 猜了几轮都不对。直接把两个场景里的每个
 * Points/Mesh、点数、可见性列出来，就没有猜的余地了。
 */
/**
 * 粒子当前用的配色。
 *
 * 为什么要专门加这个探针：强调色有**两条独立的通路** ——
 * `--accent` 走 CSS 变量（界面），`bg.setPalette()` 走粒子材质。
 * 它们各自可能对、也可能不对，只看界面完全判断不出粒子那一半。
 * "开着封面取色时一关开关，界面变了粒子没变"这个 bug 就是这样藏了很久：
 * 界面每次都对，粒子从头到尾没动过，看起来像"两种颜色叠在一起"。
 */
/**
 * 舞台当前完整的粒子配色（全部槽位）。
 *
 * 之前只暴露了 ribbon0/1，结果"后面几个槽位还是主题色"这件事
 * 在探针里看不见 —— 而它正是"封面色和外观色混在一起"的最后一处。
 * 探针要暴露**全部**，不能只暴露你正在看的那两个。
 */
/**
 * 时空网格的状态。
 *
 * 专门加这个是因为上一个版本"看着有网格、其实着色器编译失败"——
 * 网格是 LineSegments，不走 Points 那套探针，光看 __mpListLayers
 * 根本不知道它在不在、什么颜色。
 */
window.__mpGridInfo = () => {
  if (!bg || !bg.group) return { error: '没有舞台' };
  let found = null;
  bg.group.traverse((o) => {
    if (o.isLineSegments) {
      const c = o.material && o.material.color;
      found = {
        线段数: (o.geometry.getAttribute('position') || {}).count
          ? o.geometry.getAttribute('position').count / 2
          : 0,
        可见: o.visible,
        透明度: o.material && o.material.opacity,
        颜色: c ? '#' + c.getHexString() : null,
      };
    }
  });
  return found || { error: '没找到 LineSegments' };
};

window.__mpStagePalette = () => {
  if (!bg || !bg.palette) return { error: '没有配色' };
  const p = bg.palette;
  const hex = (c) =>
    '#' +
    (c || [])
      .slice(0, 3)
      .map((v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0'))
      .join('');
  return {
    ribbons: (p.ribbons || []).map(hex),
    stars: (p.stars || []).map(hex),
    界面: {
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      violet: getComputedStyle(document.documentElement).getPropertyValue('--violet').trim(),
      ice: getComputedStyle(document.documentElement).getPropertyValue('--ice').trim(),
    },
  };
};

window.__mpPalette = () => {
  if (!bg) return { error: '没有舞台' };
  const p = bg.palette || {};
  const hex = (c) =>
    '#' +
    (c || [])
      .slice(0, 3)
      .map((v) =>
        Math.max(0, Math.min(255, Math.round(v * 255)))
          .toString(16)
          .padStart(2, '0')
      )
      .join('');
  return {
    ribbon0: hex((p.ribbons || [])[0]),
    ribbon1: hex((p.ribbons || [])[1]),
    star0: hex((p.stars || [])[0]),
    界面accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  };
};

window.__mpListLayers = () => {
  if (!bg) return { error: '没有舞台' };
  const rows = [];
  const walk = (scene, label) => {
    if (!scene) return;
    scene.traverse((o) => {
      if (!o.isPoints && !o.isMesh) return;
      const g = o.geometry;
      const at = g && g.getAttribute ? g.getAttribute('position') : null;
      rows.push([
        label, o.type, at ? at.count : 0, o.visible ? '可见' : '隐藏',
        'order=' + o.renderOrder, o.material ? o.material.type : '?',
      ].join(' | '));
    });
  };
  walk(bg.scene, '主场景');
  walk(bg.coverScene, '封面场景');
  return '效果=' + bg.effectKey + '\n' + rows.join('\n');
};
window.__mpSkipRender = (on) => {
  if (!bg) return false;
  bg.benchSkipRender = Boolean(on);
  console.log(`[跳渲染] ${bg.benchSkipRender ? '已跳过 WebGL 出图' : '已恢复出图'}`);
  return true;
};

/**
 * 读当前帧间隔统计；reset=true 时先清空采样，重新开始量。
 *
 * 二分定位卡顿必须能"清空再量"，否则上一档的样本会混进下一档，
 * 得出的差异全是噪声 —— 这正是我之前用平均帧率做 A/B 时的毛病。
 */
window.__mpJank = (reset) => {
  if (!bg) return null;
  if (reset) {
    bg._gapCount = 0;
    bg._gapHead = 0;
    bg._jankLog = [];
    bg.jank = null;
    return { reset: true };
  }
  /*
   * 除了帧间隔本身，还要把**当前实际的渲染配置**一起报出来。
   * 只报帧间隔的话，我拿着一堆数字却不知道那一轮到底是什么配置跑的 ——
   * 而且"设了"和"生效了"是两件事（这个坑我反复踩），必须回读真实值。
   */
  const cfg = {
    fps: bg.fps,
    // 主线程每帧耗时：和帧间隔对照就能分清是"主线程忙"还是"GPU/合成器慢"
    jsMs: bg.jsMs === undefined ? null : bg.jsMs,
    // 跳动链上的三个实数：uPulse(节拍包络) × uBeatAmp(效果幅度×强度) = 实际位移系数
    uPulse: Number((bg.uniforms?.uPulse?.value ?? 0).toFixed(3)),
    uBeatAmp: Number((bg.uniforms?.uBeatAmp?.value ?? 0).toFixed(3)),
    beatAmp: bg.beatAmp,
    pulseIntensity: bg.pulseIntensity,
    // desynchronized 是否真的生效（回读，不是"我请求了"）
    desync: bg.desync === true,
    // 估算出来的垂直同步间隔；限帧按它分频，取错了限帧就变空操作
    refreshMs: Number((bg._refreshMs || 0).toFixed(2)),
    // 动画时钟：暂停时应平滑收回 0（所有效果的姿态都是它的函数）
    /*
     * 窗口状态。必须和帧率一起记 —— 全屏和窗口化的开销差别很大，
     * 我上一次就是拿"全屏的 165 帧"和"窗口化的 46 帧"直接对比，
     * 得出了"封面效果贵 3 倍"的错误结论。读数不自带条件，就是在制造误判。
     */
    窗口: (function () {
      const full = innerWidth >= screen.availWidth - 4 && innerHeight >= screen.availHeight - 4;
      return `${innerWidth}x${innerHeight}${full ? ' 全屏' : ' 窗口'}`;
    })(),    elapsed: Number((bg.elapsed || 0).toFixed(2)),
    playing: bg.playing !== false,    scale: Number(bg.scale.toFixed(2)),
    bloom: bg.bloomPass ? bg.bloomPass.constructor.name : '关',
    bloomOn: !!bg.bloomPass,
    粒子层: bg.group ? bg.group.visible : null,
    封面层: bg.coverPoints ? bg.coverPoints.visible : null,
  };
  return bg.jank ? { ...cfg, ...JSON.parse(JSON.stringify(bg.jank)) } : { ...cfg, note: '样本还太少' };
};

/** 直接把相机摆到某个轨道角（az/el 单位：度）；不带参数则只读当前角度 */
window.__mpOrbit = (azDeg, elDeg) => {
  if (!bg || !bg.orbit) return { error: '没有轨道相机' };
  if (azDeg === undefined) {
    return {
      az: +((bg.orbit.az * 180) / Math.PI).toFixed(1),
      el: +((bg.orbit.el * 180) / Math.PI).toFixed(1),
      returning: !!bg.orbit.returning,
      dragging: !!bg.orbit.dragging,
    };
  }
  bg.orbit.az = (azDeg * Math.PI) / 180;
  bg.orbit.el = ((elDeg || 0) * Math.PI) / 180;
  bg.orbit.vAz = 0;
  bg.orbit.vEl = 0;
  bg.orbit.dragging = false;
  // 手动摆角度时把"停手时刻"刷新掉，否则会被自动回正立刻拉回去
  bg.orbit.lastActiveAt = performance.now();
  bg.orbit.returning = false;
  console.log(`[轨道] az=${azDeg}° el=${elDeg || 0}°`);
  return { az: bg.orbit.az, el: bg.orbit.el };
};

window.__mpLayers = async (opts = {}) => {
  if (!bg) return { error: '没有舞台' };
  const want = {
    cover: opts.cover !== false,
    particles: opts.particles !== false,
  };
  /*
   * 必须用 tick 真正认的那两个开关来切，不能在外部直接设 visible ——
   * 渲染循环每帧都会按开关重算 visible，外部设的值下一帧就被覆盖。
   * 这一点我踩过：控制台打了"背景粒子=false"，画面根本没变，
   * 于是拿着一张"其实两层都在"的图去做分层判断，结论全错。
   */
  bg.benchHideParticles = !want.particles;
  bg.benchHideCover = !want.cover;
  /*
   * ★ 回读必须**等两帧**。
   *
   * 上面两个开关是在 _tick 里被翻译成 visible 的，所以设完立刻读，
   * 读到的是**上一帧**的值 —— 日志里就会出现"请求 cover:false / 实际 封面:true"
   * 这种看起来像功能坏了的记录（截图其实是对的，因为截图在几帧之后）。
   * 这正是我反复栽的那个坑：把"设了"当成"生效了"。等两帧再读，
   * 日志里的"实际"才是画面上真正生效的东西。
   */
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  await nextFrame();
  await nextFrame();
  const actual = {
    背景粒子: bg.group ? bg.group.visible : null,
    封面: bg.coverPoints ? bg.coverPoints.visible : null,
  };
  const ok = actual.背景粒子 === want.particles && actual.封面 === want.cover;
  console.log(
    `[分层] 请求 ${JSON.stringify(want)}  实际 ${JSON.stringify(actual)}  ${ok ? '✓' : '✗ 没生效'}`,
  );
  return { want, actual, ok };
};

/**
 * 把封面层收拢成形，供截图检查。
 *
 * 封面只在"正在播放"页才聚拢（setCoverFocus(1)），首页是散开状态 ——
 * 所以要检查封面好不好看，必须先播歌 + 切到正在播放页再截。
 */
window.__mpShowCover = async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // 等首页数据
  let started = 0;
  for (let i = 0; i < 12 && !started; i++) {
    started = window.__mpPlayFirst ? await window.__mpPlayFirst() : 0;
    if (!started) await wait(1500);
  }
  if (!started) return { ok: false, why: '拿不到可播列表' };
  // 等起播 + 封面异步加载
  await wait(6000);
  // 切到正在播放页，封面才会聚拢
  const btn = document.querySelector('#nav button[data-view="nowplaying"]');
  if (btn) btn.click();
  await wait(4000); // 等聚拢动画走完
  return {
    ok: true,
    coverParticles: bg && bg.coverPoints ? bg.coverPoints.geometry.getAttribute('position').count : 0,
    focus: bg && bg.coverUniforms ? Number(bg.coverUniforms.uForm.value.toFixed(2)) : -1,
  };
};

/**
 * 依次切换所有粒子效果各停留一会儿。
 *
 * 目的：**逼出着色器编译错误**。
 * 新写的效果如果 GLSL 有问题（少个分号、用了未声明的 attribute、
 * uniform 名字打错……），three 会在编译那一帧把错误打到 console，
 * 而画面只是变空 —— 从截图或正常使用里很难判断"是这个效果坏了"还是"本来就长这样"。
 * 逐个走一遍，日志里就能直接看到是哪一个效果在报错。
 */
window.__mpCycleEffects = async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const keys = EFFECT_LIST.map((e) => e.key);
  const out = [];
  for (const k of keys) {
    console.log(`[效果检查] 切到 ${k}`);
    if (bg) bg.setEffect(k);
    await wait(1200);
    out.push({ effect: k, 生效: bg ? bg.effectKey === k : false });
  }
  console.log('[效果检查] 全部走完');
  return out;
};

/**
 * 探测脚本用：直接把首页推荐的第一首播起来。
 *
 * 为什么不点 DOM：探测原本是 `document.querySelector('.row').click()`，
 * 但首页数据是异步拉的，列表渲染时机不稳定 —— 点早了就扑空，
 * 起播失败、整轮测试作废（已经因此浪费了两轮验证）。
 * 这里直接走和点行一样的播放路径，不依赖 DOM 是否已经渲染。
 */
window.__mpPlayFirst = async () => {
  /*
   * 优先用首页每日推荐；它为空时退回"我喜欢"。
   *
   * 兜底是必须的：酷狗的每日推荐是服务端按天给的，实测出现过接口成功返回、
   * 但列表为空的情况（`[ipc] recommend ✓` 却没有数据），于是探测脚本
   * "等了 20 秒也没拿到列表"而整轮作废。"我喜欢"稳定得多。
   */
  let songs = state.homeRecommend;
  if (!Array.isArray(songs) || !songs.length) {
    try {
      const lists = await api.playlists();
      const fav = lists.find((l) => l.name === '我喜欢') || lists[0];
      if (fav) songs = await api.playlistTracks(fav.id);
    } catch {
      /* 下面统一判空 */
    }
  }
  if (!Array.isArray(songs) || !songs.length) return 0;
  state.queue = songs.slice();
  state.index = -1;
  renderQueue();
  void playAt(0, 'next');
  return songs.length;
};

/** 截图对比用：临时改粒子设置（只改不存盘，方便反复试参数看效果） */
window.__mpSet = (patch) => {
  if (!bg) return false;
  if (!patch || typeof patch !== 'object') {
    // 踩过坑：这里被当成 __mpSet('effect','coral') 这样传过，
    // 参数变成一个字符串，后面所有 if 全部落空 —— 调用"成功"了但什么都没改，
    // 于是我拿着一个没生效的探测结果去判断功能好坏。直接报错，别让它静默通过。
    console.warn('[试参数] 参数必须是对象，例如 __mpSet({effect:"coral"})');
    return false;
  }
  /*
   * 切效果走的是 bg.setEffect()，和界面上点效果按钮、以及设置里改 effect
   * 最终落到的是同一个函数 —— 探测必须打在同一条路径上，否则测的是别的东西。
   */
  if (patch.effect !== undefined) bg.setEffect(patch.effect);
  if (patch.bloom !== undefined) bg.setBloom(patch.bloom, patch.bloomStrength, patch.bloomThreshold);
  else if (patch.bloomStrength !== undefined) {
    bg.setBloom(true, patch.bloomStrength, settings.particles.bloomThreshold);
  }
  if (patch.pulseIntensity !== undefined) bg.setPulseIntensity(patch.pulseIntensity);
  if (patch.density !== undefined) bg.setDensity(patch.density);
  if (patch.renderScale !== undefined) bg.setRenderScale(patch.renderScale);
  if (patch.maxFps !== undefined) bg.setMaxFps(patch.maxFps);
  console.log(
    `[试参数] ${JSON.stringify(patch)}  当前效果=${bg.effectKey}  实际泛光强度=${bg.bloomPass ? bg.bloomPass.strength : '?'}`,
  );
  return true;
};

/**
 * 关掉专辑氛围背景（截图比对用）。
 *
 * 它是一大片彩色封面，会淡入淡出，一亮就把整幅图的亮度统计抬起来，
 * 完全盖住泛光的差异。做泛光对比时必须先把它拿掉。
 *
 * 注意这里**直接改 DOM 样式，不走设置**：走过 updateSettings 会存盘，
 * 而这些探测函数是给自动截图用的，把用户的设置改掉就麻烦了
 * （实际踩过：一轮探测跑完，专辑氛围背景和粒子密度都被改了并存进存档）。
 */
window.__mpBgOff = () => {
  const els = document.querySelectorAll('#album-bg, #album-bg-next');
  els.forEach((el) => {
    el.style.transition = 'none';
    el.style.opacity = '0';
  });
  console.log(`[试参数] 已隐藏专辑氛围背景（${els.length} 层，未改设置）`);
  return els.length;
};

/**
 * 冻结 / 解冻粒子动画，供截图逐像素比对。
 * 冻结后所有截图的粒子都在同一位置，画面差异只可能来自被改的那一项。
 */
window.__mpFreeze = (on) => {
  if (!bg) return false;
  bg.frozen = Boolean(on);
  console.log(`[冻结] ${bg.frozen ? '已冻结粒子动画' : '已恢复'}`);
  return true;
};

/**
 * 把渲染管线的色彩配置全打出来。
 *
 * 起因：截图统计发现"关掉泛光（直接渲染）"比"开泛光（走后处理链）"整幅图亮一倍，
 * 而泛光强度从 0.5 提到 2.6 几乎没有变化。这说明问题不在泛光本身，
 * 而在后处理链的色彩管理上 —— 后处理链把画面压暗了，泛光那点加色根本补不回来。
 *
 * 关键看三件事：renderer 的色调映射与输出色彩空间、后处理的 pass 顺序、
 * 以及各 render target 的色彩空间。三者只要有一个不匹配，亮度就会整体跑偏。
 */
window.__mpInfo = () => {
  if (!bg) return { error: '没有舞台' };
  const r = bg.renderer;
  const c = bg.composer;
  const passes = [];
  if (c && c.passes) {
    for (const p of c.passes) {
      passes.push({
        name: p.constructor ? p.constructor.name : String(p),
        enabled: p.enabled,
        needsSwap: p.needsSwap,
        renderToScreen: p.renderToScreen,
        ...(p.toneMapping !== undefined ? { toneMapping: p.toneMapping } : {}),
        ...(p.outputColorSpace !== undefined ? { outputColorSpace: p.outputColorSpace } : {}),
      });
    }
  }
  return {
    'renderer.toneMapping': r.toneMapping,
    'renderer.toneMappingExposure': r.toneMappingExposure,
    'renderer.outputColorSpace': r.outputColorSpace,
    'THREE.ColorManagement.enabled': globalThis.__mpColorMgmt ?? 'n/a',
    'renderer.getRenderTarget() 非空(是否在渲染到纹理)': r.getRenderTarget() !== null,
    'composer.renderTarget1.texture.colorSpace': c && c.renderTarget1 ? c.renderTarget1.texture.colorSpace : null,
    'composer.renderTarget2.texture.colorSpace': c && c.renderTarget2 ? c.renderTarget2.texture.colorSpace : null,
    'composer.renderTarget1.texture.type': c && c.renderTarget1 ? c.renderTarget1.texture.type : null,
    'bloomPass.renderToScreen': bg.bloomPass ? bg.bloomPass.renderToScreen : null,
    passes,
  };
};

/* ------------------------------------------------------------------ */
/* 律动诊断：切换画质档位后"跳动"为什么丢了                              */
/* ------------------------------------------------------------------ */

/**
 * 切换档位前后，把和"跳动"有关的所有数值都打出来。
 *
 * 跳动这条链是：节拍检测 → bg.pulse() → pulseTarget → pulseValue
 *   → uniform uPulse → 着色器 applyBeat(pos) 里的位移
 * 幅度 = uPulse × vary × uBeatAmp × 0.55，而 uBeatAmp = BEAT_AMP[效果] × pulseIntensity。
 * 所以只要 pulseIntensity 或 uBeatAmp 被谁清零，跳动就会整条消失 —— 但画面上
 * 粒子还在动（uTime 驱动），只有"跟鼓点跳"这一层没了，很难一眼看出是谁干的。
 */
window.__mpPulseProbe = async () => {
  if (!bg) return { error: '粒子舞台没起来' };
  // 探测全程抑制存盘：它只是测试，绝不能改到用户的真实设置
  suppressSettingsSave = true;
  const banner = (t) => {
    if (window.__mpTestBanner) window.__mpTestBanner(t);
  };
  banner('准备中');
  const wait = mpWait;

  /*
   * 整个探测包在 try/finally 里。
   *
   * 早期没包，探测一旦中途出错（列表还没渲染、起播失败……），
   * 后面的清理就不会执行 —— 横幅留在屏幕上，而且更早的版本还会把
   * 设置存盘抑制也留着。测试脚本必须保证"无论成功失败都收尾"。
   */
  try {
    return await runPulseProbeSteps({ banner });
  } finally {
    suppressSettingsSave = false;
    globalThis.__beatDebug = false;
    if (window.__mpTestBannerOff) window.__mpTestBannerOff();
  }
};


  /** 等音频真的开始播（点歌后要取流，可能要几秒） */
  async function waitForPlayback(maxMs = 20000) {
    const a = document.querySelector('audio');
    if (!a) return { ok: false, why: '页面里没有 audio 元素' };
    const t0 = performance.now();
    let lastSnap = '';
    while (performance.now() - t0 < maxMs) {
      const snap =
        `src=${a.src ? a.src.slice(0, 48) + '…' : '(空)'} ` +
        `readyState=${a.readyState} networkState=${a.networkState} ` +
        `paused=${a.paused} currentTime=${a.currentTime.toFixed(2)} ` +
        `error=${a.error ? `${a.error.code}/${a.error.message}` : '无'}`;
      if (snap !== lastSnap) {
        console.log('[律动]   媒体状态:', snap);
        lastSnap = snap;
      }
      if (!a.paused && a.currentTime > 0.3 && a.readyState >= 2) return { ok: true, t: a.currentTime };
      await mpWait(400);
    }
    return {
      ok: false,
      why:
        `等 ${maxMs}ms 仍未起播 —— src=${a.src ? a.src.slice(0, 48) : '(空)'} ` +
        `readyState=${a.readyState} networkState=${a.networkState} ` +
        `error=${a.error ? `${a.error.code}/${a.error.message}` : '无'}`,
    };
  }

/** 探测脚本用的等待。放模块级，让下面几个函数都能用同一个。 */
const mpWait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 采样一段时间内 pulseValue 的**峰值**。
 *
 * 这是整个诊断的关键：静态配置（uBeatAmp / pulseIntensity）切换档位时并不会丢，
 * 真正要问的是"鼓点来了，粒子到底有没有被推动"。而 pulseValue 是个反复起落的
 * 脉冲量，必须在有音乐播放时持续采样才能看到 —— 没有音乐时它恒为 0，
 * 光看瞬时值会得出"一切正常"的错误结论。
 */
async function peakPulse(ms) {
  let peak = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if ((bg.pulseValue ?? 0) > peak) peak = bg.pulseValue;
    await mpWait(40);
  }
  return Number(peak.toFixed(3));
}

/**
 * 律动探测的实际步骤（由 __mpPulseProbe 包在 try/finally 里调用）。
 *
 * 拆出来只是为了能统一收尾：无论中途哪一步抛错，横幅和存盘抑制都要被清掉。
 */
async function runPulseProbeSteps({ banner }) {
  const wait = mpWait;
  const snap = async (tag) => ({
    tag,
    uBeatAmp: bg.uniforms && bg.uniforms.uBeatAmp ? Number(bg.uniforms.uBeatAmp.value.toFixed(3)) : null,
    pulseIntensity: bg.pulseIntensity,
    effect: bg.effectKey,
    density: bg.density,
    'pulseValue 峰值': await peakPulse(2500),
  });

  const out = [];

  // 先让第一首歌播起来 —— 没有音频就没有鼓点，测不出任何东西。
  // 用 __mpPlayFirst 直接走播放路径，不依赖 DOM 渲染时机（点 .row 会扑空）。
  banner('等待首页数据并起播');
  let started = 0;
  for (let i = 0; i < 12 && !started; i++) {
    started = window.__mpPlayFirst ? await window.__mpPlayFirst() : 0;
    if (!started) await wait(1500);
  }
  if (!started) out.push({ tag: '（前置）', 说明: '等了 18 秒也没拿到任何可播列表' });

  banner('等待起播');
  const play = await waitForPlayback();
  out.push({
    tag: '（前置）起播检查',
    '是否真的在播': play.ok ? `是（已播 ${play.t.toFixed(1)}s）` : `否 —— ${play.why}`,
  });
  if (!play.ok) {
    out.push({ tag: '终止', 说明: '音乐没起来，后面的切换测试没有意义，先不测了' });
    return out;
  }

  out.push(await snap('播放中 · 切换前'));

  /*
   * 暂停测试：暂停后粒子不该再跟着鼓点跳。
   *
   * 这是"预测式起搏"特有的坑 —— 拍点是按时钟预测的，所以暂停后音频虽然静音，
   * 时钟照样在走、脉冲照样在推。必须实测确认已修好。
   */
  banner('测试暂停行为');
  const a = document.querySelector('audio');
  a.pause();
  /*
   * 先等 1.6 秒再测。
   *
   * 不能暂停后立刻测：脉冲的半衰期是 0.23 秒，暂停前最后一个拍子的余波
   * 会残留约 0.1 并继续衰减 —— 那是**正常的物理行为**（不该瞬间归零，
   * 否则会看到一次突兀的"啪"）。等 1.6 秒之后残值已衰减到千分之几，
   * 这时候测到的任何值都只可能来自**新打出的拍子**，才能判定修复是否有效。
   */
  await wait(1600);
  const pausedPeak = await peakPulse(2500);
  out.push({
    tag: '暂停 1.6 秒后（残余已衰减完，测的是"是否还在打新拍子"）',
    'pulseValue 峰值': pausedPeak,
    判定: pausedPeak < 0.03 ? '通过：暂停后不再起搏' : `未通过：仍在起搏（峰值 ${pausedPeak}）`,
  });
  await a.play().catch(() => {});
  await wait(2500);

  /*
   * 打开节拍诊断并让它跑一会儿。
   *
   * 目的是拿到"鼓点间隔"的统计：稳定度（变异系数）才是"跟不跟得上节奏"的客观依据。
   * 只看触发次数说明不了问题 —— 漏拍和乱触发都会让次数看起来"差不多"。
   */
  banner('采集节奏数据（约 15 秒）');
  globalThis.__beatDebug = true;
  console.log('[律动] 已打开节拍诊断，采样 15 秒…');
  await wait(15000);

  const original = structuredClone(settings);
  const originalProfile = settings.perfProfile;

  for (const key of ['quality', 'smooth', 'balanced']) {
    const prof = PERF_PROFILES[key];
    if (!prof) continue;
    banner(`切换画质档位「${prof.name}」`);
    updateSettings({ perfProfile: key, ...structuredClone(prof.patch) });
    await wait(1200);
    out.push(await snap(`播放中 · 切到「${prof.name}」`));
  }

  banner('还原设置');
  updateSettings({ ...original, perfProfile: originalProfile });
  await wait(1200);
  out.push(await snap('播放中 · 已还原'));

  return out;
}

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */

updateQualityChip();
updateTimingUI();
applyVolume();
applyPlayMode();
updateLikeButton();
renderQueue();
void loadAccount();
void loadHome();
// 收藏列表在后台拉，不阻塞启动
void ensureLikes().then(updateLikeButton);


/* ------------------------------------------------------------------ */
/* 启动收尾：全局热键                                                   */
/* ------------------------------------------------------------------ */

/*
 * 放在模块**最末尾**调用，而不是塞进舞台初始化那块。
 *
 * 踩过的坑：原来写在舞台初始化里，而 bindHotkeyActions 内部引用的
 * hotkeyUnsub 是用 let 声明在后面的 —— 暂时性死区直接抛错，
 * 后面那句 applyGlobalHotkeys 就永远不执行，而且写在 void 里连报错都没有，
 * 表现是"热键完全没注册"，查起来毫无线索。
 *
 * 现在放在这里：所有声明都已完成，不存在顺序问题；
 * 而且显式 catch，真出问题会打在日志里。
 */
try {
  bindHotkeyActions();
  /*
   * 注册完成后把结果回填到设置面板的「可用 / 被占用」那一列。
   *
   * 必须在这里再推一次：注册是异步的，而面板构建时结果还没回来 ——
   * 不回填那一列会一直是空的，用户会以为功能没生效。
   */
  void applyGlobalHotkeys().then(() => {
    if (settingsPanel && settingsPanel.refreshHotkeys) {
      settingsPanel.refreshHotkeys(
        { ...defaultHotkeyBindings(), ...(settings.hotkeys || {}) },
        globalThis.__hotkeyResults || []
      );
    }
  });
} catch (err) {
  console.error('[热键] 启动注册失败:', (err && err.message) || err);
}

/*
 * 恢复上次的音乐状态 + 定期存档。
 *
 * 定时 5 秒一次：够精确（最多丢 5 秒进度），又不会像 timeupdate
 * 那样每秒写好几次同步的 localStorage（那是会卡主线程的）。
 * 退出时再补存一次。
 */
void restoreResume();
setInterval(saveResume, 5000);
window.addEventListener('beforeunload', saveResume);