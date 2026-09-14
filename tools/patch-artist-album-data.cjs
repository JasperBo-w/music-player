/*
 * 歌手 / 专辑详情：数据层。
 *
 * ★ 一个重要的发现：**这些东西 vendor 里早就有现成的模块** ——
 *   artist_detail / artist_audios / artist_albums / album_detail / album_songs
 *   全都在 packages/core/src/kugou/vendor/module/ 下，只是应用从没调用过。
 *
 * 我第一版去猜了外部的 mobilecdn.kugou.com 老接口，结果四个全部
 * TLS 证书不匹配（那个域名已经不再指向酷狗）。
 * **先看项目里 vendored 的参考实现，再自己去猜外部接口** ——
 * 这个错今晚已经犯过好几次了。
 *
 * 参数约定（读模块源码确认，不是猜的）：`{ id, page, pagesize }`
 * 返回结构（探针打出来的真实结构）：
 *   artist_detail → body.data 是**对象**（author_name / sizable_avatar / intro / song_count / fansnums）
 *   artist_audios → body.data 是**数组**（扁平的歌曲对象）
 *   album_detail  → body.data 是**数组**，取 [0]（album_name / author_name / sizable_cover / intro / publish_date）
 *   album_songs   → body.data = { total, songs: [...] }，每首是**嵌套**结构
 *                   base{audio_name,album_id,album_audio_id,author_name}
 *                   audio_info{hash,duration,hash_320...}
 *                   album_info{album_name,cover}
 *                   authors[{author_name,author_id}]
 */
const fs = require('node:fs');
const path = require('node:path');
const log = (m) => console.log(m);

// ---------- ① core：四个方法 ----------
{
  const f = path.join(__dirname, '..', 'packages', 'core', 'src', 'index.js');
  let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  if (t.includes('getArtistDetail')) {
    log('core 已存在');
  } else {
    const anchor = `  /** 搜索建议（输入联想） */`;
    const block = `  /* ------------------------------------------------------------------ */
  /* 歌手 / 专辑（用于详情页）                                          */
  /* ------------------------------------------------------------------ */

  /** 歌手详情。返回原始 data（对象），字段映射交给上层 */
  async getArtistDetail(artistId) {
    const res = await this.call('artist_detail', { id: Number(artistId) || 0 });
    return (res.body && res.body.data) || null;
  }

  /** 歌手的歌。返回**扁平**的歌曲数组 */
  async getArtistSongs(artistId, { page = 1, pagesize = 30 } = {}) {
    const res = await this.call('artist_audios', {
      id: Number(artistId) || 0,
      page,
      pagesize,
    });
    const d = res.body && res.body.data;
    return Array.isArray(d) ? d : [];
  }

  /** 歌手的专辑列表 */
  async getArtistAlbums(artistId, { page = 1, pagesize = 30 } = {}) {
    const res = await this.call('artist_albums', {
      id: Number(artistId) || 0,
      page,
      pagesize,
    });
    const d = res.body && res.body.data;
    return Array.isArray(d) ? d : [];
  }

  /**
   * 专辑详情。
   * ★ 注意这个接口返回的是**单元素数组**（请求体里就是 data:[{album_id}]），
   *   直接当对象用会拿到 undefined —— 我第一次就取错了。
   */
  async getAlbumDetail(albumId) {
    const res = await this.call('album_detail', { id: Number(albumId) || 0 });
    const d = res.body && res.body.data;
    if (Array.isArray(d)) return d[0] || null;
    return d || null;
  }

  /** 专辑的歌。返回 { total, songs }（songs 是嵌套结构，映射交给上层） */
  async getAlbumSongs(albumId, { page = 1, pagesize = 30 } = {}) {
    const res = await this.call('album_songs', {
      id: Number(albumId) || 0,
      page,
      pagesize,
    });
    const d = (res.body && res.body.data) || {};
    return { total: Number(d.total) || 0, songs: Array.isArray(d.songs) ? d.songs : [] };
  }

${anchor}`;
    if (t.includes(anchor)) {
      t = t.replace(anchor, block);
      fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
      log('ok: core 四个方法');
    } else {
      log('!! core 没找到锚点');
    }
  }
}

// ---------- ② 主进程：IPC ----------
{
  const f = path.join(__dirname, '..', 'apps', 'desktop', 'main.js');
  let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  if (t.includes("'artist:detail'")) {
    log('IPC 已存在');
  } else {
    const anchor = `  wrap('account', async () => {`;
    const block = `  /* ------------------------------------------------------------------ */
  /* 歌手 / 专辑详情                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * 专辑歌曲是**嵌套**结构（base / audio_info / album_info / authors），
   * 跟别的接口的扁平结构不一样，所以要单独摊平。
   *
   * 这些字段名是探针打出来的真实结构，不是猜的：
   *   base.audio_name / base.album_id / base.album_audio_id / base.author_name
   *   audio_info.hash / audio_info.duration（毫秒）
   *   album_info.album_name / album_info.cover（含 {size} 占位符）
   *   authors[0].author_id / authors[0].author_name
   */
  function mapNestedSong(item) {
    const base = item.base || {};
    const ai = item.audio_info || {};
    const al = item.album_info || {};
    const authors = Array.isArray(item.authors) ? item.authors : [];
    // 封面里带 {size} 占位符，替换成实际尺寸
    const cover = String(al.cover || '').replace('{size}', '480');
    return {
      hash: String(ai.hash || ''),
      name: String(base.audio_name || '').replace(/<[^>]+>/g, ''),
      artist: String(base.author_name || (authors[0] && authors[0].author_name) || ''),
      albumId: Number(base.album_id) || 0,
      albumName: String(al.album_name || ''),
      albumAudioId: Number(base.album_audio_id) || 0,
      mixSongId: Number(base.album_audio_id) || 0,
      artistId: Number((authors[0] && authors[0].author_id) || 0) || 0,
      durationSec: ai.duration ? Math.round(Number(ai.duration) / 1000) : 0,
      privilege: Number(item.copyright && item.copyright.privilege) || 0,
      cover,
      hqHash: String(ai.hash_320 || ''),
      sqHash: String(ai.hash_flac || ''),
    };
  }

  ipcMain.handle(
    'artist:detail',
    wrap('artist:detail', async (_e, artistId) => {
      const c = await getClient();
      const raw = await c.getArtistDetail(artistId);
      if (!raw) return { ok: true, data: null };
      return {
        ok: true,
        data: {
          artistId: Number(raw.author_id) || Number(artistId) || 0,
          name: String(raw.author_name || ''),
          avatar: String(raw.sizable_avatar || raw.avatar || '').replace('{size}', '480'),
          intro: String(raw.long_intro || raw.intro || ''),
          songCount: Number(raw.song_count) || 0,
          albumCount: Number(raw.album_count) || 0,
          fans: Number(raw.fansnums) || 0,
        },
      };
    })
  );

  ipcMain.handle(
    'artist:songs',
    wrap('artist:songs', async (_e, artistId, page = 1, pagesize = 30) => {
      const c = await getClient();
      const list = await c.getArtistSongs(artistId, { page, pagesize });
      // 扁平的，直接走 mapSong
      return { ok: true, songs: list.map(mapSong) };
    })
  );

  ipcMain.handle(
    'album:detail',
    wrap('album:detail', async (_e, albumId) => {
      const c = await getClient();
      const raw = await c.getAlbumDetail(albumId);
      if (!raw) return { ok: true, data: null };
      return {
        ok: true,
        data: {
          albumId: Number(raw.album_id) || Number(albumId) || 0,
          name: String(raw.album_name || ''),
          artist: String(raw.author_name || ''),
          cover: String(raw.sizable_cover || raw.cover || '').replace('{size}', '480'),
          intro: String(raw.intro || ''),
          publishDate: String(raw.publish_date || ''),
        },
      };
    })
  );

  ipcMain.handle(
    'album:songs',
    wrap('album:songs', async (_e, albumId, page = 1, pagesize = 50) => {
      const c = await getClient();
      const r = await c.getAlbumSongs(albumId, { page, pagesize });
      return { ok: true, total: r.total, songs: r.songs.map(mapNestedSong) };
    })
  );

${anchor}`;
    if (t.includes(anchor)) {
      t = t.replace(anchor, block);
      fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
      log('ok: IPC 四个通道');
    } else {
      log('!! 主进程没找到锚点');
    }
  }
}

// ---------- ③ preload ----------
{
  const f = path.join(__dirname, '..', 'apps', 'desktop', 'preload.js');
  let t = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  if (t.includes('artistDetail')) {
    log('preload 已存在');
  } else {
    t = t.replace(
      `  account: () => ipcRenderer.invoke('account'),`,
      `  account: () => ipcRenderer.invoke('account'),
  /** 歌手详情 / 歌手歌曲 */
  artistDetail: (id) => ipcRenderer.invoke('artist:detail', id),
  artistSongs: (id, page, pagesize) => ipcRenderer.invoke('artist:songs', id, page, pagesize),
  /** 专辑详情 / 专辑歌曲 */
  albumDetail: (id) => ipcRenderer.invoke('album:detail', id),
  albumSongs: (id, page, pagesize) => ipcRenderer.invoke('album:songs', id, page, pagesize),`
    );
    fs.writeFileSync(f, t.replace(/\n/g, '\r\n'));
    log('ok: preload 四个方法');
  }
}

console.log('done');
