/*
 * 歌手 / 专辑详情页：UI 层（含前置改动，一次跑完）。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const uiFile = path.join(root, 'apps', 'ui', 'src', 'main.js');
const log = (m) => console.log(m);
const readNorm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const writeNorm = (p, t) => fs.writeFileSync(p, t.replace(/\n/g, '\r\n'));

let t = readNorm(uiFile);
const done = [];
const sub = (from, to, label) => {
  if (t.includes(from)) {
    t = t.replace(from, to);
    done.push('ok ' + label);
  } else {
    done.push('!! ' + label);
  }
};

// ① currentView
sub(
  `function switchView(view) {`,
  `/** 当前视图名。详情页的"返回"要知道是从哪儿进来的 */
let currentView = 'home';

function switchView(view) {
  currentView = view;`,
  'currentView'
);

// ② 行渲染：第三列按场景显示专辑名或歌手名，都可点
sub(
  `        <span class="row-artist">\${esc(s.artist)}</span>`,
  `        \${/*
           * 第三列显示什么，看场景：
           *   歌手页（opts.showAlbum）→ **专辑名**，可点。
           *     整页都是同一个歌手，重复歌手名没有信息量，专辑名才是有用的导航。
           *   其它页面 → 歌手名；有 artistId 才做成链接
           *     （没有的话点了没反应，不如保持纯文本）。
           */
          opts.showAlbum
            ? Number(s.albumId)
              ? \`<span class="row-artist link" data-album-id="\${s.albumId}" title="查看专辑">\${esc(s.albumName || s.artist)}</span>\`
              : \`<span class="row-artist">\${esc(s.albumName || s.artist)}</span>\`
            : Number(s.artistId)
              ? \`<span class="row-artist link" data-artist-id="\${s.artistId}" title="查看歌手">\${esc(s.artist)}</span>\`
              : \`<span class="row-artist">\${esc(s.artist)}</span>\`
        }`,
  '行渲染'
);

// ③ 点击处理
sub(
  `  container.querySelectorAll('.row-act').forEach((btn) => {`,
  `  /*
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

  container.querySelectorAll('.row-act').forEach((btn) => {`,
  '点击处理'
);

// ④ openArtist / openAlbum + 返回
sub(
  `// 首页磁贴`,
  `/* ------------------------------------------------------------------ */
/* 歌手 / 专辑详情页                                                   */
/* ------------------------------------------------------------------ */

/** 记住进入详情页之前的视图，返回时回到原处 */
let detailBackView = 'playlists';

/** 粉丝数：上亿/上万的写法 */
function fmtFans(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return (v / 100000000).toFixed(1) + ' 亿';
  if (v >= 10000) return (v / 10000).toFixed(1) + ' 万';
  return String(v);
}

async function openArtist(artistId) {
  if (!artistId) return;
  detailBackView = currentView || 'home';
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
      $('#ar-meta').innerHTML =
        (d.avatar
          ? \`<img class="detail-cover" src="\${esc(d.avatar)}" alt="" />\`
          : '<div class="detail-cover detail-cover-empty">♪</div>') +
        \`<div class="detail-info">
           <div class="detail-counts">\${d.songCount} 首 · \${d.albumCount} 张专辑 · \${fmtFans(d.fans)} 粉丝</div>
           \${d.intro ? \`<div class="detail-intro">\${esc(d.intro)}</div>\` : ''}
         </div>\`;
    } else {
      $('#ar-meta').innerHTML = '';
    }
    const list = (songs && songs.songs) || [];
    $('#ar-count').textContent = list.length + ' 首';
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
      $('#al-meta').innerHTML =
        (d.cover
          ? \`<img class="detail-cover" src="\${esc(d.cover)}" alt="" />\`
          : '<div class="detail-cover detail-cover-empty">♪</div>') +
        \`<div class="detail-info">
           <div class="detail-counts">\${esc(d.artist)}\${d.publishDate ? ' · ' + esc(d.publishDate) : ''}</div>
           \${d.intro ? \`<div class="detail-intro">\${esc(d.intro)}</div>\` : ''}
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

$('#ar-back').addEventListener('click', () => switchView(detailBackView));
$('#al-back').addEventListener('click', () => switchView(detailBackView));

// 首页磁贴`,
  'openArtist / openAlbum'
);

writeNorm(uiFile, t);
done.forEach(log);
