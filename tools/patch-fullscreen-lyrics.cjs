/*
 * ② 全屏歌词页。
 *
 * 设计取舍：
 *   · **不重写歌词解析** —— 直接复用 lyricView 已经解析好的 lines
 *     （每行有 chars，每个字带时间戳）。歌词解析是这一晚踩坑最多的地方，
 *     再写一份必然和主界面不一致。
 *   · **同步只有一个汇合点**：updateStageText()。它每次 timeupdate 都会走，
 *     而且已经在读 lyricView.activeLine —— 全屏页在那儿同步即可，
 *     不用去挂 lyricView.update() 的四处调用点（漏一处就会有一处不同步）。
 *   · **点歌词行可以跳转** —— 全屏歌词最自然的交互，顺手做掉。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const htmlFile = path.join(root, 'apps', 'ui', 'index.html');
const uiFile = path.join(root, 'apps', 'ui', 'src', 'main.js');
const cssFile = path.join(root, 'apps', 'ui', 'src', 'styles.css');
const log = (m) => console.log(m);
const readNorm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const writeNorm = (p, t) => fs.writeFileSync(p, t.replace(/\n/g, '\r\n'));
let n = 0;

// ---------- ① HTML：视图 + 入口按钮 ----------
{
  let t = readNorm(htmlFile);

  if (!t.includes('id="view-lyrics"')) {
    const anchor = `      <!-- ================= 歌手详情 ================= -->`;
    const block = `      <!-- ================= 全屏歌词 ================= -->
      <!-- 盖住整个窗口。它不是普通视图，而是一个"专注模式"：
           只显示歌词，别的一概不出现。 -->
      <section id="view-lyrics" class="view view-lyrics">
        <button id="fl-close" class="fl-close" type="button" title="退出全屏歌词 (Esc)">✕</button>
        <div id="fl-head" class="fl-head">
          <div class="fl-title"></div>
          <div class="fl-artist"></div>
        </div>
        <div id="fl-lines" class="fl-lines"></div>
      </section>

${anchor}`;
    if (t.includes(anchor)) {
      t = t.replace(anchor, block);
      n++;
    } else log('!! HTML 锚点没找到');
  }

  if (!t.includes('id="fl-chip"')) {
    t = t.replace(
      `        <button id="lyric-chip" class="chip" title="桌面歌词（独立置顶窗口）">词</button>`,
      `        <button id="lyric-chip" class="chip" title="桌面歌词（独立置顶窗口）">词</button>
        <button id="fl-chip" class="chip" title="全屏歌词（Esc 退出）">全</button>`
    );
    n++;
  }
  writeNorm(htmlFile, t);
}

// ---------- ② 主进程无关；渲染进程逻辑 ----------
{
  let t = readNorm(uiFile);

  if (!t.includes('function openFullLyrics')) {
    const anchor = `// 首页磁贴`;
    const block = `/* ------------------------------------------------------------------ */
/* 全屏歌词页                                                          */
/* ------------------------------------------------------------------ */

/**
 * 全屏歌词当前是不是开着。
 * updateStageText 每帧都会调过来同步，所以用个标志挡掉无谓的 DOM 操作。
 */
let flOpen = false;
let flActive = -1;

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

  $('#fl-head .fl-title').textContent = state.currentSong ? state.currentSong.name || '' : '';
  $('#fl-head .fl-artist').textContent = state.currentSong ? state.currentSong.artist || '' : '';

  const box = $('#fl-lines');
  box.innerHTML = lines
    .map(
      (l) =>
        \`<div class="fl-line" data-i="\${l.i}" data-t="\${l.t}">\${esc(l.text) || '&nbsp;'}</div>\`
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

  flOpen = true;
  flActive = -1;
  syncFullLyrics();
}

function closeFullLyrics() {
  flOpen = false;
  flActive = -1;
  switchView('nowplaying');
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

${anchor}`;
    if (t.includes(anchor)) {
      t = t.replace(anchor, block);
      n++;
    } else log('!! main.js 锚点没找到');
  }

  // 在 updateStageText 里同步（那是唯一汇合点）
  const syncAnchor = `  if (line && song) bg.setStageText(line, song.name);`;
  if (t.includes(syncAnchor) && !t.includes('syncFullLyrics();')) {
    t = t.replace(
      syncAnchor,
      `  // 全屏歌词页的高亮也在这里同步 —— 见 syncFullLyrics 里的说明
  syncFullLyrics();

${syncAnchor}`
    );
    n++;
  } else if (!t.includes(syncAnchor)) {
    log('!! updateStageText 锚点没找到');
  }

  writeNorm(uiFile, t);
}

// ---------- ③ 样式 ----------
{
  let c = fs.readFileSync(cssFile, 'utf8');
  if (c.includes('.view-lyrics')) {
    log('样式已存在');
  } else {
    c += `

/* ---------------- 全屏歌词 ---------------- */

/*
 * 盖住整个窗口（连侧栏一起）—— 它是"专注模式"，不是普通视图。
 * position:fixed 而不是 absolute：要盖住 #app 的 padding 和侧栏。
 */
.view-lyrics {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: none;
  flex-direction: column;
  padding: 56px 6vw 40px;
  box-sizing: border-box;
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
}
.view-lyrics.active { display: flex; }

.fl-close {
  position: absolute;
  top: 18px;
  right: 22px;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  font-size: 15px;
  opacity: .6;
  transition: opacity .2s;
}
.fl-close:hover { opacity: 1; }

.fl-head { flex: 0 0 auto; margin-bottom: 18px; }
.fl-title { font-size: 20px; font-weight: 700; color: var(--ink); }
.fl-artist { font-size: 12.5px; color: var(--muted); margin-top: 4px; }

/*
 * 歌词列表：上下加遮罩，让首尾行不是硬切（和软件内的歌词框一个做法）。
 */
.fl-lines {
  flex: 1 1 auto;
  overflow: hidden auto;
  scrollbar-width: none;
  -webkit-mask-image: linear-gradient(to bottom, transparent 0%, #000 14%, #000 84%, transparent 100%);
  mask-image: linear-gradient(to bottom, transparent 0%, #000 14%, #000 84%, transparent 100%);
}
.fl-lines::-webkit-scrollbar { width: 0; }

.fl-line {
  padding: 10px 0;
  font-size: 30px;
  font-weight: 700;
  line-height: 1.4;
  color: var(--muted);
  opacity: .45;
  cursor: pointer;
  transition: opacity .28s, color .28s, transform .28s;
  transform-origin: left center;
}
.fl-line:hover { opacity: .75; }
.fl-line.active {
  color: var(--accent-ink, var(--accent));
  opacity: 1;
  transform: scale(1.035);
}

/* 窄窗口下缩小一点，别一行放不下 */
@media (max-width: 980px) {
  .fl-line { font-size: 22px; }
  .view-lyrics { padding: 48px 5vw 32px; }
}
`;
    fs.writeFileSync(cssFile, c);
    n++;
  }
}

log('改了 ' + n + ' 处');
