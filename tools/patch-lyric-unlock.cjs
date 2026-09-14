/*
 * 修「锁定之后解不开」。
 *
 * 用户反馈："锁定没提示，也没有解锁提示，现在解不开"。
 *
 * 这是设计错误：锁定 = 整窗穿透 = **窗口收不到任何鼠标事件**，
 * 连那个用来解锁的中键也收不到。我在早先的注释里写过这条
 * （"穿透之后必须有第二个入口"），但把「词」按钮当成了那个入口 ——
 * 而它只管开关窗口，不管解锁。
 *
 *（回头看 Mineradio：它之所以要起一个 PowerShell 子进程读 GetAsyncKeyState(4)，
 *  唯一目的就是**在穿透状态下还能收到中键**。我把它当成多余的，是看漏了。）
 *
 * 补三个出口：
 *   ① 关闭再打开桌面歌词 → 自动解锁（最快的一条，也是应急出口）
 *   ② 播放条上加一个独立的「锁」按钮
 *   ③ 全局热键 Alt+K
 *
 * 另外把锁定提示做得**看得见** —— 原来是一行 11px、45% 透明度的小字贴在角落，
 * 用户反馈"锁定没提示"。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const mainFile = path.join(root, 'apps', 'desktop', 'main.js');
const htmlFile = path.join(root, 'apps', 'ui', 'index.html');
const uiFile = path.join(root, 'apps', 'ui', 'src', 'main.js');
const lyricFile = path.join(root, 'apps', 'ui', 'lyric.html');
const cssFile = path.join(root, 'apps', 'ui', 'src', 'styles.css');
const log = (m) => console.log(m);
const readNorm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const writeNorm = (p, t) => fs.writeFileSync(p, t.replace(/\n/g, '\r\n'));

// ---------- ① 关闭再打开 → 自动解锁 ----------
{
  let t = readNorm(mainFile);
  const old = `function showLyricWindow(on) {
  if (on) {
    createLyricWindow();`;
  const neu = `function showLyricWindow(on) {
  if (on) {
    /*
     * ★ 每次打开都从"未锁定"开始。
     *
     * 锁定状态是穿透的，一旦锁上就收不到任何鼠标事件 ——
     * 如果它还被持久化，用户就会永久卡住。
     * 所以"关掉再打开"必须是一条能出去的应急通道。
     */
    lyricLocked = false;
    lyricHardLock = false;
    lyricMouseIgnored = null;
    createLyricWindow();`;
  if (t.includes(old)) {
    t = t.replace(old, neu);
    log('ok: 打开时自动解锁');
  } else {
    log('!! showLyricWindow 没匹配');
  }
  // 创建后同步一次锁定状态给页面（否则页面不知道现在是解锁的）
  t = t.replace(
    `  console.log('[桌面歌词] 窗口已创建');
  return lyricWindow;`,
    `  // 页面加载完要把当前锁定状态告诉它，否则提示会显示成错的
  lyricWindow.webContents.on('did-finish-load', () => {
    if (lyricWindow && !lyricWindow.isDestroyed()) {
      lyricWindow.webContents.send('lyric:lock', lyricLocked);
    }
  });
  console.log('[桌面歌词] 窗口已创建');
  return lyricWindow;`
  );
  writeNorm(mainFile, t);
}

// ---------- ② 播放条上加「锁」按钮 ----------
{
  let t = readNorm(htmlFile);
  if (!t.includes('id="lyriclock-chip"')) {
    t = t.replace(
      `        <button id="lyric-chip" class="chip" title="桌面歌词（独立置顶窗口）">词</button>`,
      `        <button id="lyric-chip" class="chip" title="桌面歌词（独立置顶窗口）">词</button>
        <button id="lyriclock-chip" class="chip" title="锁定桌面歌词（点不动、鼠标穿过去）· Alt+K">锁</button>`
    );
    writeNorm(htmlFile, t);
    log('ok: 锁按钮');
  }
}

// ---------- ③ 逻辑：锁按钮 + 热键 ----------
{
  let t = readNorm(uiFile);
  if (!t.includes('syncLyricLockChip')) {
    const anchor = `$('#lyric-chip').addEventListener('click', () => void toggleDesktopLyric());`;
    const block = `${anchor}

/* ---- 锁定按钮 ---- */

/*
 * 锁定状态**从主进程回读**，不在渲染进程里自己记 ——
 * 歌词窗口自己也能切（中键），本地记一份必然和真实状态不一致。
 */
async function syncLyricLockChip() {
  if (!window.api || !window.api.desktopLyric) return;
  try {
    const on = await window.api.desktopLyric.locked();
    $('#lyriclock-chip').classList.toggle('on', !!on);
    $('#lyriclock-chip').title = on
      ? '已锁定（点不动、鼠标穿过去）· 点这里解锁 · Alt+K'
      : '锁定桌面歌词（点不动、鼠标穿过去）· Alt+K';
  } catch {}
}

async function toggleLyricLock() {
  if (!window.api || !window.api.desktopLyric) return;
  const now = await window.api.desktopLyric.toggleLock();
  await syncLyricLockChip();
  toast(now ? '桌面歌词已锁定（Alt+K 或点「锁」解锁）' : '桌面歌词已解锁');
}

$('#lyriclock-chip').addEventListener('click', () => void toggleLyricLock());
void syncLyricLockChip();
// 歌词开关变化时锁按钮的状态也要跟着刷新
setInterval(() => void syncLyricLockChip(), 1500);`;
    t = t.replace(anchor, block);
    log('ok: 锁按钮逻辑');
  }

  // 热键动作表加一条
  if (!t.includes("id: 'lyriclock'")) {
    t = t.replace(
      `  { id: 'lyric', label: '桌面歌词开关', def: 'Alt+D' },`,
      `  { id: 'lyric', label: '桌面歌词开关', def: 'Alt+D' },
  // Alt+K：锁/解锁桌面歌词。锁上之后窗口收不到鼠标事件，热键是唯一稳定的出口
  { id: 'lyriclock', label: '桌面歌词锁定', def: 'Alt+K' },`
    );
  }
  if (!t.includes("case 'lyriclock':")) {
    t = t.replace(
      `    case 'lyric':
      // 桌面歌词：复用播放条那个按钮同一条路径（它会先回读真实状态再切）
      void toggleDesktopLyric();
      break;`,
      `    case 'lyric':
      // 桌面歌词：复用播放条那个按钮同一条路径（它会先回读真实状态再切）
      void toggleDesktopLyric();
      break;
    case 'lyriclock':
      void toggleLyricLock();
      break;`
    );
  }
  writeNorm(uiFile, t);
}

// ---------- ④ 主进程 / preload：locked 查询 ----------
{
  let t = readNorm(mainFile);
  if (!t.includes("'lyric:locked'")) {
    t = t.replace(
      `  ipcMain.handle('lyric:visible'`,
      `  ipcMain.handle('lyric:locked', () => lyricHardLock);
  ipcMain.handle('lyric:visible'`
    );
    writeNorm(mainFile, t);
    log('ok: lyric:locked');
  }
  let p = readNorm(path.join(root, 'apps', 'desktop', 'preload.js'));
  if (!p.includes('locked:')) {
    p = p.replace(
      `    visible: () => ipcRenderer.invoke('lyric:visible'),`,
      `    visible: () => ipcRenderer.invoke('lyric:visible'),
    /** 当前是否处于"硬锁"（整窗穿透）状态 */
    locked: () => ipcRenderer.invoke('lyric:locked'),`
    );
    writeNorm(path.join(root, 'apps', 'desktop', 'preload.js'), p);
    log('ok: preload locked');
  }
}

// ---------- ⑤ 锁定提示做得看得见 ----------
{
  let t = readNorm(lyricFile);
  const old = `      #locked {
        position: fixed;
        right: 6px;
        top: 4px;
        z-index: 3;
        font-size: 11px;
        color: rgba(255, 255, 255, 0.45);
        opacity: 0;
        transition: opacity 0.2s;
      }
      body.locked #locked {
        opacity: 1;
      }`;
  const neu = `      /*
       * 锁定提示。
       *
       * 上一版是 11px、45% 透明的小字贴在角落 —— 用户反馈"锁定没提示"，
       * 那个确实等于没提示。改成居中的胶囊：有底色、有边框、够大，
       * 而且明确写出**怎么解锁**（锁上之后鼠标点不到它，所以文案很重要）。
       */
      #locked {
        position: fixed;
        left: 50%;
        transform: translateX(-50%);
        top: 6px;
        z-index: 3;
        padding: 3px 12px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
        color: #fff;
        background: rgba(0, 0, 0, 0.55);
        border: 1px solid rgba(255, 255, 255, 0.22);
        white-space: nowrap;
        opacity: 0;
        transition: opacity 0.22s;
        pointer-events: none;
      }
      body.locked #locked {
        opacity: 1;
      }`;
  if (t.includes(old)) {
    t = t.replace(old, neu);
    log('ok: 锁定提示');
  } else {
    log('!! #locked 样式没匹配');
  }
  t = t.replace('已锁定 · 中键解锁', '🔒 已锁定 · Alt+K 或点「锁」解锁');
  writeNorm(lyricFile, t);
}

console.log('done');
