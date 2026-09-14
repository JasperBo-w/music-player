/*
 * 两处修复：
 *   ① mapSong 补 albumName（歌手页那一列显示的就是它，缺了会回落成歌手名）
 *   ② openArtist / openAlbum 改用 allSettled，并给"取不到歌"一句人话
 *
 * ② 的由来：实测有些专辑/歌手的歌曲接口返回 [20010] invalid param
 *（平台侧限制）。而我用的是 Promise.all —— 取歌失败把"专辑详情"也一起
 * 干掉了，页面标题回落成默认值、看起来就是坏了。两个独立请求应该各管各的。
 */
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const log = (m) => console.log(m);
let n = 0;
const apply = (file, pairs) => {
  let t = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  for (const [from, to, label] of pairs) {
    if (t.includes(from)) {
      t = t.replace(from, to);
      n++;
    } else {
      log('!! ' + label);
    }
  }
  fs.writeFileSync(file, t.replace(/\n/g, '\r\n'));
};

// ① mapSong
apply(path.join(root, 'apps', 'desktop', 'main.js'), [
  [
    `    albumId,\n    /*\n     * artistId —— 歌手页要用。`,
    `    albumId,\n    /*\n     * albumName —— 歌手页里那一列显示的就是它。\n     * 三种方言都要认（和 albumId 同理）：camelCase / snake_case / PascalCase。\n     * 缺了它，歌手页只能回落成显示歌手名（整页重复同一个名字，没有信息量）。\n     */\n    albumName: String(pick(raw, 'albumName', 'album_name', 'AlbumName') || '').replace(/<[^>]+>/g, ''),\n    /*\n     * artistId —— 歌手页要用。`,
    'mapSong 补 albumName',
  ],
]);

// ② 两个详情页
apply(path.join(root, 'apps', 'ui', 'src', 'main.js'), [
  [
    `    const [detail, songs] = await Promise.all([\n      api.artistDetail(artistId),\n      api.artistSongs(artistId, 1, 100),\n    ]);\n    const d = (detail && detail.data) || null;`,
    `    /*\n     * ★ 用 allSettled 而不是 all。\n     *\n     * 歌手信息和歌曲列表是两个独立请求，任一失败都不该拖垮另一个。\n     * 用 all 的话，歌曲列表一失败（实测确实会遇到\n     * [20010] invalid param），连头像和简介都显示不出来 ——\n     * 页面看起来就是"坏了"。\n     */\n    const [detailR, songsR] = await Promise.allSettled([\n      api.artistDetail(artistId),\n      api.artistSongs(artistId, 1, 100),\n    ]);\n    const detail = detailR.status === 'fulfilled' ? detailR.value : null;\n    const d = (detail && detail.data) || null;\n    const songs = songsR.status === 'fulfilled' ? songsR.value : null;`,
    'openArtist allSettled',
  ],
  [
    `    const [detail, res] = await Promise.all([\n      api.albumDetail(albumId),\n      api.albumSongs(albumId, 1, 200),\n    ]);\n    const d = (detail && detail.data) || null;`,
    `    // 同 openArtist：详情和歌曲分开容错，一个失败不影响另一个\n    const [detailR, songsR] = await Promise.allSettled([\n      api.albumDetail(albumId),\n      api.albumSongs(albumId, 1, 200),\n    ]);\n    const detail = detailR.status === 'fulfilled' ? detailR.value : null;\n    const d = (detail && detail.data) || null;\n    const res = songsR.status === 'fulfilled' ? songsR.value : null;`,
    'openAlbum allSettled',
  ],
  [
    `    const songs = (res && res.songs) || [];\n    $('#al-count').textContent = songs.length + ' 首';\n    renderRows(box, songs, { queueTitle: (d && d.name) || '专辑' });`,
    `    const songs = (res && res.songs) || [];\n    $('#al-count').textContent = songs.length ? songs.length + ' 首' : '';\n    if (!songs.length) {\n      /*\n       * 实测有些专辑的歌曲接口会返回 [20010] invalid param（平台侧限制）。\n       * 那种时候给一句人话，别留一个空白列表让人以为页面卡住了。\n       */\n      box.innerHTML = '<div class="empty">这张专辑暂时取不到歌曲（可能受版权限制）</div>';\n    } else {\n      renderRows(box, songs, { queueTitle: (d && d.name) || '专辑' });\n    }`,
    '专辑取不到歌时的提示',
  ],
  [
    `    const list = (songs && songs.songs) || [];\n    $('#ar-count').textContent = list.length + ' 首';`,
    `    const list = (songs && songs.songs) || [];\n    $('#ar-count').textContent = list.length ? list.length + ' 首' : '';`,
    '歌手计数',
  ],
]);

log('改了 ' + n + ' 处');
