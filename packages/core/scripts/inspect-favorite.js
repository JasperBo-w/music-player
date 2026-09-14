'use strict';

/**
 * 只读调查：确认「我喜欢」歌单的 listid，以及歌曲数据里哪个字段是 fileid
 *
 * 添加歌曲用 playlist_tracks_add({ listid, data: "名字|hash|album_id|mixsongid" })
 * 删除歌曲用 playlist_tracks_del({ listid, fileids: "..." })
 * 删除要 fileid，但歌单歌曲返回里字段很多，得先确认是哪个。
 *
 * 本脚本不做任何写操作。
 */

const path = require('node:path');
const { KuGouClient } = require('../src/index.js');
const { FileSessionStore } = require('../src/session-store.js');

const store = new FileSessionStore(path.join(__dirname, '..', '.session.json'));
const saved = store.load();
const client = new KuGouClient({ device: saved.device, session: saved.session });

const pick = (o, ...keys) => {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
};

(async () => {
  // ---- 1. 找「我喜欢」 ----
  const plRes = await client.getUserPlaylists({ page: 1, pagesize: 100 });
  const list = (plRes.body.data && (plRes.body.data.info || plRes.body.data.list)) || [];

  console.log('=== 歌单的两种 id ===');
  for (const p of list.slice(0, 6)) {
    console.log(
      `  ${String(pick(p, 'name') || '').slice(0, 22).padEnd(24)} ` +
        `list_create_listid=${pick(p, 'list_create_listid')}  ` +
        `global_collection_id=${pick(p, 'global_collection_id')}`
    );
  }

  const fav = list.find((p) => /我喜欢/.test(String(pick(p, 'name') || '')));
  if (!fav) {
    console.log('\n没找到「我喜欢」歌单');
    return;
  }

  const listid = pick(fav, 'list_create_listid');
  const gid = pick(fav, 'global_collection_id');
  console.log(`\n「我喜欢」: listid=${listid}  global_collection_id=${gid}  (${pick(fav, 'm_count')} 首)`);

  // ---- 2. 拉几首歌，看有哪些可疑的 id 字段 ----
  const tr = await client.getPlaylistTracks(gid, { page: 1, pagesize: 3 });
  const data = (tr.body && (tr.body.data || tr.body)) || {};
  const songs = data.songs || data.info || data.lists || data.list || data.audios || [];

  console.log(`\n=== 歌曲数据的全部字段（第一首）===`);
  if (songs[0]) {
    const keys = Object.keys(songs[0]).sort();
    console.log('  ' + keys.join(', '));

    console.log('\n=== 所有像 id 的字段 ===');
    for (const k of keys) {
      if (/id/i.test(k)) {
        const v = songs[0][k];
        if (v === null || v === undefined || typeof v === 'object') continue;
        console.log(`  ${k.padEnd(24)} = ${v}`);
      }
    }
  }

  console.log('\n=== 三首歌的关键字段对照 ===');
  for (const s of songs) {
    console.log(
      `  name=${String(pick(s, 'name', 'songname') || '').slice(0, 16).padEnd(18)} ` +
        `hash=${String(pick(s, 'hash') || '').slice(0, 10)} ` +
        `audio_id=${pick(s, 'audio_id')} ` +
        `album_id=${pick(s, 'album_id')} ` +
        `mixsongid=${pick(s, 'mixsongid')} ` +
        `fileid=${pick(s, 'fileid')} ` +
        `file_id=${pick(s, 'file_id')}`
    );
  }

  // ---- 3. 看看有没有专门的「是否已喜欢」接口 ----
  console.log('\n=== 试试 song_auth / favorite_count（只读） ===');
  const first = songs[0];
  if (first) {
    try {
      const fc = await client.call('favorite_count', { mixsongids: pick(first, 'audio_id') });
      console.log(`  favorite_count: ${JSON.stringify(fc.body).slice(0, 220)}`);
    } catch (e) {
      console.log(`  favorite_count 失败: error_code=${e.body && e.body.error_code}`);
    }
  }
})().catch((e) => {
  console.error('[失败]', e && e.message ? e.message : e);
  if (e && e.body) console.error(JSON.stringify(e.body).slice(0, 400));
});
