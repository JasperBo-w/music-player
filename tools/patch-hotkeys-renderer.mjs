/*
 * 全局自定义热键 —— 渲染进程侧。
 *
 * 主进程只负责"按键 → 发一个动作名"，真正的动作在这里执行，
 * 因为播放器状态（队列、当前歌、音量）全在渲染进程里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const f = path.join(path.dirname(here), 'apps', 'ui', 'src', 'main.js');
let t = fs.readFileSync(f, 'utf8');
const log = (m) => console.log(m);

if (t.includes('HOTKEY_ACTIONS')) {
  log('已存在，跳过');
  process.exit(0);
}

const block = `
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
const HOTKEY_ACTIONS = [
  { id: 'playpause', label: '播放 / 暂停', def: 'Alt+F5' },
  { id: 'prev', label: '上一首', def: 'Alt+Home' },
  { id: 'next', label: '下一首', def: 'Alt+End' },
  { id: 'volup', label: '音量增加', def: 'Alt+PageUp' },
  { id: 'voldown', label: '音量降低', def: 'Alt+PageDown' },
  { id: 'mute', label: '静音开关', def: 'Alt+M' },
];

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
      setVolume(Math.min(100, Math.round((state.volume || 0) + 5)));
      break;
    case 'voldown':
      setVolume(Math.max(0, Math.round((state.volume || 0) - 5)));
      break;
    case 'mute':
      setVolume(state.muted ? state.volume || 60 : 0);
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
  const map = settings.hotkeys || defaultHotkeyBindings();
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

/** 订阅主进程发回来的动作。重新注册时先退订，避免监听叠加。 */
let hotkeyUnsub = null;
function bindHotkeyActions() {
  if (!window.api || !window.api.hotkeys) return;
  if (hotkeyUnsub) hotkeyUnsub();
  hotkeyUnsub = window.api.hotkeys.onAction((payload) => {
    if (payload && payload.action) doHotkeyAction(payload.action);
  });
}

`;

const anchor = 'async function setCoverForSong(song) {';
if (!t.includes(anchor)) {
  log('!! 未找到插入点');
  process.exit(1);
}
t = t.replace(anchor, block + anchor);
log('ok: 插入动作表与注册函数');

// 初始化时注册一次
const init = '  setupMediaSession();';
if (t.includes(init)) {
  t = t.replace(init, `  setupMediaSession();
  bindHotkeyActions();
  void applyGlobalHotkeys();`);
  log('ok: 初始化注册');
} else {
  log('!! 未找到初始化点');
}

fs.writeFileSync(f, t);
console.log('done');
