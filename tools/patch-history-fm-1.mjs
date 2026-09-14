/*
 * 「最近播放」+「私人 FM」接线。
 *
 * core 里这两个方法早就有（getUserHistory / getPersonalFm），只是从来没接过 IPC
 * 和界面 —— 属于清单里性价比最高的两个。
 *
 * 这两条路径都要显式写，因为返回结构不一样：
 *   user_history → body.data.songs（或 info/lists）
 *    personal_fm → body.data（直接是数组）
 * 我先把原始返回打出来确认，再写映射，避免又踩"字段名猜错"的老坑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const log = (m) => console.log(m);

// ---------- ① desktop/main.js：两个 IPC ----------
{
  const f = path.join(root, 'apps', 'desktop', 'main.js');
  let t = fs.readFileSync(f, 'utf8');
  if (t.includes("'history',")) {
    log('desktop: 已存在');
  } else {
    const anchor = `  ipcMain.handle(
    'playlistTracks',`;
    if (!t.includes(anchor)) {
      log('!! desktop: 未找到插入点');
    } else {
      const block = `  /* ---- 最近播放 ---- */
  ipcMain.handle(
    'history',
    wrap('history', async (page = 1) => {
      const res = await c().getUserHistory({ page: Number(page) || 1, pagesize: 100 });
      const body = res.body || {};
      const data = body.data || body;
      const list = data.songs || data.info || data.lists || data.list || [];
      return (Array.isArray(list) ? list : []).map(mapSong).filter((s) => s.hash);
    })
  );

  /* ---- 私人 FM ---- */
  ipcMain.handle(
    'personalFm',
    wrap('personalFm', async () => {
      const res = await c().getPersonalFm();
      const body = res.body || {};
      /*
       * FM 的返回结构和别处不一样：body.data 本身可能就是数组，
       * 也可能包在 songs/info 里。三种都兜住，别写死一种。
       */
      const raw = body.data;
      const list = Array.isArray(raw)
        ? raw
        : (raw && (raw.songs || raw.info || raw.lists || raw.list)) || [];
      return (Array.isArray(list) ? list : []).map(mapSong).filter((s) => s.hash);
    })
  );

` + anchor;
      t = t.replace(anchor, block);
      fs.writeFileSync(f, t);
      log('ok: desktop IPC');
    }
  }
}

// ---------- ② preload ----------
{
  const f = path.join(root, 'apps', 'desktop', 'preload.js');
  let t = fs.readFileSync(f, 'utf8');
  if (t.includes('personalFm:')) {
    log('preload: 已存在');
  } else {
    t = t.replace(
      `  /** 搜索歌曲 */`,
      `  /** 最近播放 */
  history: (page) => ipcRenderer.invoke('history', page),
  /** 私人 FM（返回一批歌，前端排进队列一首首放） */
  personalFm: () => ipcRenderer.invoke('personalFm'),

  /** 搜索歌曲 */`
    );
    fs.writeFileSync(f, t);
    log('ok: preload');
  }
}

// ---------- ③ 导航项 ----------
{
  const f = path.join(root, 'apps', 'ui', 'index.html');
  let t = fs.readFileSync(f, 'utf8');
  if (t.includes('data-view="history"')) {
    log('index.html: 已存在');
  } else {
    t = t.replace(
      `        <button data-view="search">搜索</button>`,
      `        <button data-view="search">搜索</button>
        <button data-view="history">最近播放</button>`
    );
    // 视图：放在歌单详情后面
    t = t.replace(
      `      <!-- ================= 正在播放 =================`,
      `      <!-- ================= 最近播放 ================= -->
      <section id="view-history" class="view">
        <h2>最近播放</h2>
        <div id="history-list" class="list"></div>
      </section>

      <!-- ================= 正在播放 =================`
    );
    fs.writeFileSync(f, t);
    log('ok: index.html 导航 + 视图');
  }
}

console.log('done');
