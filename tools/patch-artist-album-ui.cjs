/*
 * 歌手 / 专辑详情页：UI 层。
 *
 * 数据层已经打通并验证过（artist:detail / artist:songs / album:detail / album:songs）。
 * 这一层做三件事：
 *   ① 两个新视图（#view-artist / #view-album），结构照着 #view-playlist 来
 *   ② 歌曲行里的**歌手名可点**（有 artistId 才给链接，没有就保持纯文本）
 *   ③ 歌手详情里的行，把"歌手名"换成**专辑名**并可点 ——
 *      在歌手页里每行都重复歌手名没有意义，展示专辑名才有用
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

// ---------- ① 两个视图 ----------
{
  let t = readNorm(htmlFile);
  if (t.includes('id="view-artist"')) {
    log('视图已存在');
  } else {
    const anchor = `      <section id="view-playlist" class="view">`;
    const block = `      <!-- ================= 歌手详情 ================= -->
      <section id="view-artist" class="view">
        <div class="pl-head">
          <button id="ar-back" class="pl-back" type="button" title="返回">‹ 返回</button>
          <h2 id="ar-title">歌手</h2>
          <span id="ar-count" class="pl-count"></span>
        </div>
        <div id="ar-meta" class="detail-meta"></div>
        <div id="ar-tracks" class="list"></div>
      </section>

      <!-- ================= 专辑详情 ================= -->
      <section id="view-album" class="view">
        <div class="pl-head">
          <button id="al-back" class="pl-back" type="button" title="返回">‹ 返回</button>
          <h2 id="al-title">专辑</h2>
          <span id="al-count" class="pl-count"></span>
        </div>
        <div id="al-meta" class="detail-meta"></div>
        <div id="al-tracks" class="list"></div>
      </section>

${anchor}`;
    if (t.includes(anchor)) {
      t = t.replace(anchor, block);
      writeNorm(htmlFile, t);
      log('ok: 两个视图');
    } else {
      log('!! 没找到 view-playlist');
    }
  }
}

// ---------- ② 行里加可点的歌手名 / 专辑名 ----------
{
  let t = readNorm(uiFile);
  if (t.includes('data-artist-id')) {
    log('行渲染已改过');
  } else {
    const old = `        <span class="row-artist">\${esc(s.artist)}</span>`;
    const neu = `        \${/* 有 artistId 才做成链接 —— 没有的话点了没反应，不如保持纯文本 */
          Number(s.artistId)
            ? \`<span class="row-artist link" data-artist-id="\${s.artistId}" title="查看歌手">\${esc(s.artist)}</span>\`
            : \`<span class="row-artist">\${esc(s.artist)}</span>\`
        }`;
    if (t.includes(old)) {
      t = t.replace(old, neu);
      log('ok: 歌手名可点');
    } else {
      log('!! 行渲染没匹配');
    }
  }

  // 点击处理（插在 .row-act 那段的后面，同样要 stopPropagation）
  if (!t.includes('openArtist(')) {
    const anchor = `  container.querySelectorAll('.row-act').forEach((btn) => {`;
    const block = `  /*
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

${anchor}`;
    if (t.includes(anchor)) {
      t = t.replace(anchor, block);
      log('ok: 点击处理');
    } else {
      log('!! 没找到 row-act 锚点');
    }
  }

  // openArtist / openAlbum + 返回
  if (!t.includes('async function openArtist')) {
    const anchor = `// 首页磁贴`;
    const block = `/* ------------------------------------------------------------------ */
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
    const [detail, songs] = await Promise.all([
      api.artistDetail(artistId),
      api.artistSongs(artistId, 1, 100),
    ]);
    const d = (detail && detail.data) || null;
    if (d) {
      $('#ar-title').textContent = d.name || '歌手';
      $('#ar-meta').innerHTML = \`
        \${d.avatar ? \`<img class="detail-cover" src="\${esc(d.avatar)}" alt="" />\` : '<div class="detail-cover detail-cover-empty">♪</div>'}
        <div class="detail-info">
          <div class="detail-counts">\${d.songCount} 首 · \${d.albumCount} 张专辑 · \${fmtFans(d.fans)} 粉丝</div>
          \${d.intro ? \`<div class="detail-intro">\${esc(d.intro)}</div>\` : ''}
        </div>\`;
    } else {
      $('#ar-meta').innerHTML = '';
    }
    const list = (songs && songs.songs) || [];
    $('#ar-count').textContent = list.length + ' 首';
    /*
     * 歌手页里的每行**显示专辑名**而不是歌手名 ——
     * 整页都是同一个歌手，重复它没有信息量；专辑名才是有用的导航。
     */
    renderRows(box, list, { queueTitle: (d && d.name) || '歌手', showAlbum: true });
  } catch (e) {
    box.innerHTML = \`<div class="empty">加载失败：\${esc(e.message)}</div>\`;
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
    const [detail, res] = await Promise.all([
      api.albumDetail(albumId),
      api.albumSongs(albumId, 1, 200),
    ]);
    const d = (detail && detail.data) || null;
    if (d) {
      $('#al-title').textContent = d.name || '专辑';
      $('#al-meta').innerHTML = \`
        \${d.cover ? \`<img class="detail-cover" src="\${esc(d.cover)}" alt="" />\` : '<div class="detail-cover detail-cover-empty">♪</div>'}
        <div class="detail-info">
          <div class="detail-counts">\${esc(d.artist)}\${d.publishDate ? ' · ' + esc(d.publishDate) : ''}</div>
          \${d.intro ? \`<div class="detail-intro">\${esc(d.intro)}\` : ''}
        </div>\`;
    } else {
      $('#al-meta').innerHTML = '';
    }
    const songs = (res && res.songs) || [];
    $('#al-count').textContent = songs.length + ' 首';
    renderRows(box, songs, { queueTitle: (d && d.name) || '专辑' });
  } catch (e) {
    box.innerHTML = \`<div class="empty">加载失败：\${esc(e.message)}</div>\`;
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
$('#al-back').addEventListener('click', () => switchView(detailBackView));

${anchor}`;
    if (t.includes(anchor)) {
      t = t.replace(anchor, block);
      log('ok: openArtist / openAlbum');
    } else {
      log('!! 没找到"首页磁贴"锚点');
    }
  }

  writeNorm(uiFile, t);
}

// ---------- ③ 样式 ----------
{
  let c = fs.readFileSync(cssFile, 'utf8');
  if (c.includes('.detail-meta')) {
    log('样式已存在');
  } else {
    c += `

/* ---------------- 歌手 / 专辑详情 ---------------- */

/* 头部：封面 + 统计 + 简介 */
.detail-meta {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  margin: 4px 0 18px;
}
.detail-meta:empty { display: none; }

.detail-cover {
  width: 132px;
  height: 132px;
  border-radius: 10px;
  object-fit: cover;
  flex: 0 0 auto;
  background: var(--surface-2);
}
.detail-cover-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 34px;
  color: var(--muted);
}

.detail-info { min-width: 0; }
.detail-counts {
  font-size: 13px;
  color: var(--accent-ink, var(--accent));
  margin-bottom: 8px;
}
.detail-intro {
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--muted);
  /* 简介可能很长，收到 6 行，别把列表挤下去 */
  display: -webkit-box;
  -webkit-line-clamp: 6;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* 行里可点的歌手名 / 专辑名 */
.row-artist.link {
  cursor: pointer;
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}
.row-artist.link:hover { color: var(--accent-ink, var(--accent)); }

/* 详情页没有导航项，高亮交给"我的歌单"那一项（和歌单详情一致） */
.view.active { display: block; }
`;
    fs.writeFileSync(cssFile, c);
    log('ok: 样式');
  }
}

console.log('done');
