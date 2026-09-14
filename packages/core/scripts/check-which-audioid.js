'use strict';

/**
 * 判定哪个 albumAudioId 是"对的那个"
 *
 * 歌单接口的原始对象里给了这首 128k 版本的文件大小（`size` 字段，
 * 以及 relate_goods 里 bitrate=128 那一档的 size）。拿两个候选 mx 各请求一次
 * 文件总长度，谁跟原始对象报的大小对得上，谁就是正确的那首歌。
 *
 * 这比"听起来对不对"可靠得多，也不需要人耳。
 */

const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { KuGouClient } = require('../src/index.js');
const { FileSessionStore } = require('../src/session-store.js');

const store = new FileSessionStore(
  process.env.MUSIC_SESSION_FILE || path.join(__dirname, '..', '.session.json')
);
const saved = store.load();
if (!saved.session || !saved.session.token) {
  console.error('没有登录态');
  process.exit(1);
}
const client = new KuGouClient({ device: saved.device, session: saved.session });

/** 只取 1 个字节，从 Content-Range 里读出文件总长度 */
function totalSize(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(
      url,
      { headers: { Range: 'bytes=0-0', 'User-Agent': 'Mozilla/5.0' } },
      (res) => {
        res.resume();
        const cr = res.headers['content-range'] || '';
        const m = cr.match(/\/(\d+)$/);
        resolve({
          status: res.statusCode,
          total: m ? Number(m[1]) : Number(res.headers['content-length'] || 0),
          type: res.headers['content-type'] || '',
        });
      }
    );
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(20000, () => {
      req.destroy();
      resolve({ error: '超时' });
    });
  });
}

(async () => {
  const plRes = await client.getUserPlaylists({ page: 1, pagesize: 100 });
  const lists = (plRes.body.data && (plRes.body.data.info || plRes.body.data.list)) || [];
  const fav = lists.find((p) => String(p.name) === '我喜欢');
  const res = await client.getPlaylistTracks(fav.global_collection_id, { page: 1, pagesize: 4 });
  const data = (res.body && (res.body.data || res.body)) || {};
  const raw = data.songs || data.info || data.lists || data.list || data.audios || [];

  let audioIdWins = 0;
  let mixIdWins = 0;

  for (const s of raw.slice(0, 4)) {
    // 原始对象里 128k 那一档的官方大小
    const rg = (s.relate_goods || []).find((g) => Number(g.bitrate) === 128);
    const declared = rg ? Number(rg.size) : Number(s.size || 0);

    console.log('='.repeat(72));
    console.log(`《${s.name}》`);
    console.log(`  接口声明 128k 大小 = ${declared} 字节`);

    for (const [label, val] of [
      ['audio_id      ', s.audio_id],
      ['add_mixsongid ', s.add_mixsongid],
    ]) {
      if (!val) continue;
      const info = await client.getSongStream({
        hash: s.hash,
        albumId: s.album_id,
        albumAudioId: val,
        quality: 128,
      });
      if (!info.url) {
        console.log(`  ${label} → 取流失败`);
        continue;
      }
      const t = await totalSize(info.url);
      const hit = t.total === declared;
      console.log(
        `  ${label} → 实际 ${t.total} 字节   ${hit ? '✅ 与接口声明一致' : `❌ 差 ${t.total - declared}`}`
      );
      if (hit) {
        if (label.startsWith('audio_id')) audioIdWins++;
        else mixIdWins++;
      }
    }
  }

  console.log('\n' + '='.repeat(72));
  console.log(`判定：audio_id 命中 ${audioIdWins} 首，add_mixsongid 命中 ${mixIdWins} 首`);
  if (mixIdWins > audioIdWins) {
    console.log('→ 应该用 add_mixsongid（也就是 mixsongid），界面原来传 audio_id 是错的');
  } else if (audioIdWins > mixIdWins) {
    console.log('→ 反而是 audio_id 对 —— 我的修改方向错了，要改回去');
  } else {
    console.log('→ 两边都没命中，光看大小判不出来，需要另想办法');
  }
})().catch((e) => {
  console.error('脚本出错：', e);
  process.exit(1);
});
