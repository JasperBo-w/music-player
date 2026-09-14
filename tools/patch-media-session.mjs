/*
 * 系统媒体控制（SMTC / 媒体键 / 音量键弹出面板）。
 *
 * 为什么优先做这个：
 *   Windows 上 Chromium 会把页面里的 **Media Session API** 直接接到系统的
 *   SMTC（System Media Transport Controls）。接上之后自动获得：
 *     · 音量键弹出面板里显示歌名/封面/进度，并且能点它的播放/上一首/下一首
 *     · 键盘上的媒体键（如果没被别的软件独占）
 *     · 蓝牙耳机/车机上的播放键
 *   不用写一行原生代码，也不用 globalShortcut 去抢全局热键
 *   （抢全局热键反而会和系统面板重复触发）。
 *
 * 顺带说明为什么"不注册 globalShortcut"：一旦页面的 Media Session 生效，
 * Chromium 已经把媒体键这条路走通了；再注册一遍会让一次按键触发两次。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mf = path.join(path.dirname(here), 'apps', 'ui', 'src', 'main.js');
let t = fs.readFileSync(mf, 'utf8');
const log = (m) => console.log(m);

const block = `
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

`;

// 插在 setCoverForSong 之前（和 updateStageText 挨着）
const anchor = 'async function setCoverForSong(song) {';
if (t.includes('function setupMediaSession()')) {
  log('已存在，跳过');
} else if (t.includes(anchor)) {
  t = t.replace(anchor, block + anchor);
  log('ok: 插入媒体控制模块');
} else {
  log('!! 未匹配 setCoverForSong');
}

// 在 playAt 里换歌后同步
const p1 = `  void setCoverForSong(song);
  updateStageText();`;
if (t.includes(p1)) {
  t = t.replace(p1, `  void setCoverForSong(song);
  updateStageText();
  updateMediaSession();`);
  log('ok: 换歌时同步');
} else {
  log('!! 未匹配 playAt 同步点');
}

// play / pause 时同步状态
const p2 = `audio.addEventListener('play', () => {
  $('#pb-toggle').textContent = '⏸';
  // 播放：效果恢复运动
  if (bg) bg.setPlaying(true);
});`;
if (t.includes(p2)) {
  t = t.replace(p2, `audio.addEventListener('play', () => {
  $('#pb-toggle').textContent = '⏸';
  // 播放：效果恢复运动
  if (bg) bg.setPlaying(true);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  updateMediaSession();
});`);
  log('ok: play 同步');
} else {
  log('!! 未匹配 play 监听');
}

const p3 = `  if (bg) bg.setPlaying(false);
});`;
if (t.includes(p3)) {
  t = t.replace(p3, `  if (bg) bg.setPlaying(false);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
});`);
  log('ok: pause 同步');
} else {
  log('!! 未匹配 pause 监听');
}

// timeupdate 里同步进度
const p4 = `  // 逐字歌词高亮
  lyricView.update(cur);
  updateStageText();`;
if (t.includes(p4)) {
  t = t.replace(p4, `  // 逐字歌词高亮
  lyricView.update(cur);
  updateStageText();
  updateMediaPosition();`);
  log('ok: 进度同步');
} else {
  log('!! 未匹配 timeupdate');
}

// 初始化时注册一次
const p5 = '  bg.setCoverFocus(coverFocusWanted ? 1 : 0);';
if (t.includes(p5) && !t.includes('setupMediaSession();\n')) {
  t = t.replace(p5, p5 + '\n  setupMediaSession();');
  log('ok: 初始化注册');
} else {
  log('初始化注册: 已处理或未匹配');
}

fs.writeFileSync(mf, t);
console.log('done');
