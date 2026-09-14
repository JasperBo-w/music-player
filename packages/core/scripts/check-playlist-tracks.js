'use strict';

/**
 * 歌单歌曲一致性排查
 *
 * 目的：确认「歌单里的歌变了」是核心层的问题还是界面层的问题。
 * 列出几个歌单的实际曲目，和界面显示对照。
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
  const plRes = await client.getUserPlaylists({ page: 1, pagesize: 100 });
  const list = (plRes.body.data && (plRes.body.data.info || plRes.body.data.list)) || [];

  console.log(`歌单总数: ${list.length}\n`);

  // 挑几个歌单：我喜欢的、以及用户自己建的几个
  const targets = list.filter((p) => /我喜欢|周杰伦|航拍|跑步|耳机/.test(String(pick(p, 'name') || ''))).slice(0, 4);
  if (!targets.length) targets.push(...list.slice(0, 3));

  for (const p of targets) {
    const name = pick(p, 'name');
    const gid = pick(p, 'global_collection_id');
    const count = pick(p, 'm_count');

    console.log('='.repeat(66));
    console.log(`《${name}》  声明 ${count} 首   ${gid}`);
    console.log('='.repeat(66));

    try {
      const res = await client.getPlaylistTracks(gid, { page: 1, pagesize: 5 });
      const data = (res.body && (res.body.data || res.body)) || {};
      const songs = data.songs || data.info || data.lists || data.list || data.audios || [];

      if (!Array.isArray(songs) || songs.length === 0) {
        console.log('  ⚠️ 没有返回歌曲。响应字段:', Object.keys(data).join(', '));
        console.log('  原文:', JSON.stringify(res.body).slice(0, 300));
        continue;
      }

      songs.slice(0, 5).forEach((s, i) => {
        console.log(
          `  [${i}] ${String(pick(s, 'name', 'songname') || '').slice(0, 30).padEnd(32)} ` +
            `${String(pick(s, 'singername', 'author_name') || '').slice(0, 14).padEnd(16)} ` +
            `hash=${String(pick(s, 'hash') || '').slice(0, 10)}`
        );
      });

      // 顺带看看返回结构里有没有别的数组字段（防止取错了分支）
      const arrayKeys = Object.keys(data).filter((k) => Array.isArray(data[k]));
      if (arrayKeys.length > 1) {
        console.log(`  （响应里还有别的数组字段: ${arrayKeys.join(', ')}）`);
      }
    } catch (e) {
      console.log('  ❌ 失败:', e && e.message);
      if (e && e.body) console.log('  ', JSON.stringify(e.body).slice(0, 200));
    }
    console.log('');
  }
})().catch((e) => {
  console.error('[失败]', e && e.message ? e.message : e);
});
