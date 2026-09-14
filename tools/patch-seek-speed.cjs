/*
 * 快进 / 快退 + 倍速播放。
 *
 * 清单里这两项一起做，因为都是"播放控制"这一小块，而且都要动播放条。
 *
 * 快进快退用 **5 秒**：10 秒对短歌太粗（一首 2 分钟的歌跳 12 次就到底了），
 * 3 秒又太碎；5 秒和大多数播放器一致。
 *
 * 倍速用 audio.playbackRate。要显式确认 preservesPitch —— 它默认是 true，
 * 但一旦被别处设成 false，变速就会变调（像磁带快放），那不是我们要的。
 *
 * 两者都持久化：倍速存 localStorage（下次开还是这个速度），
 * 快进的步长不存（它是即时动作，没有"状态"可言）。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const f = path.join(root, 'apps', 'ui', 'src', 'main.js');
let t = fs.readFileSync(f, 'utf8');
const log = (m) => console.log(m);

if (t.includes('function seekBy')) {
  log('已存在，跳过');
  process.exit(0);
}

/*
 * 插入点用**行号定位**，不用字符串匹配。
 *
 * 上一版我拿整段注释当锚点，里面有用于对齐的尾随空格 ——
 * 数量对不上就静默失败（打印了 `!! 未找到插入点` 但我差点直接往下走）。
 * 尾随空格这种东西在编辑器里看不出来，拿它当锚点就是在给自己埋雷。
 */
const lines = t.split('\n');
const at = lines.findIndex((l) => l.includes('迷你播放队列')) - 2;
if (at < 0) {
  console.log('!! 没找到「迷你播放队列」');
  process.exit(1);
}
const anchor = lines.slice(at, at + 3).join('\n');

const block = `/* ------------------------------------------------------------------ */
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

${anchor}`;

if (!t.includes(anchor)) {
  log('!! 未找到插入点');
  process.exit(1);
}
t = t.replace(anchor, block);

// closeChipMenus 要把倍速菜单也收进去，否则它会和音质/队列的浮层同时开着
const closeOld = `  $('#queue-popover').classList.remove('open');`;
if (t.includes(closeOld) && !t.includes("$('#speed-menu').classList.remove('open')")) {
  t = t.replace(closeOld, `${closeOld}
  $('#speed-menu').classList.remove('open');`);
  log('ok: closeChipMenus 已收编倍速菜单');
}

// 键盘：← / → 快进快退（Ctrl+←/→ 仍是切歌）
const keyOld = `  if (e.code === 'ArrowRight' && e.ctrlKey) $('#pb-next').click();
  if (e.code === 'ArrowLeft' && e.ctrlKey) $('#pb-prev').click();`;
const keyNew = `  if (e.code === 'ArrowRight' && e.ctrlKey) $('#pb-next').click();
  if (e.code === 'ArrowLeft' && e.ctrlKey) $('#pb-prev').click();
  /*
   * 不带修饰键的左右方向键 = 快退 / 快进。
   * 用 e.code（物理键位）而不是 e.key：这样键盘布局换了也不会错位。
   * 和 Ctrl 组合是分开的两件事 —— 切歌和跳时间不该混在一个键上。
   */
  if (e.code === 'ArrowRight' && !e.ctrlKey) {
    e.preventDefault();
    seekBy(SEEK_STEP);
  }
  if (e.code === 'ArrowLeft' && !e.ctrlKey) {
    e.preventDefault();
    seekBy(-SEEK_STEP);
  }`;
if (t.includes(keyOld) && !t.includes('seekBy(SEEK_STEP)')) {
  t = t.replace(keyOld, keyNew);
  log('ok: 键盘 ← / → 快进快退');
}

fs.writeFileSync(f, t);
console.log('done');
