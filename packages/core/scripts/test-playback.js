'use strict';

/**
 * 播放链路验证：这是整个 App 的生死线
 *   榜单取歌 → 拿播放地址 → 实测能否真的下到音频字节
 */

const https = require('node:https');
const { KuGouClient } = require('../src/index.js');

const client = new KuGouClient();

function sec(t) {
  const s = Math.floor((Number(t) || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function head(url, range) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { headers: { Range: range || 'bytes=0-4095', 'User-Agent': 'Mozilla/5.0' } },
      (res) => {
        let got = 0;
        res.on('data', (c) => (got += c.length));
        res.on('end', () =>
          resolve({ status: res.statusCode, type: res.headers['content-type'], bytes: got, len: res.headers['content-length'] })
        );
      }
    );
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

(async () => {
  console.log('='.repeat(70));
  console.log('第一步：从榜单拿真实歌曲');
  console.log('='.repeat(70));

  const top = await client.call('top_song', { page: 1, pagesize: 6 });
  const songs = top.body && top.body.data;
  if (!Array.isArray(songs) || !songs.length) {
    console.log('榜单没数据:', JSON.stringify(top.body).slice(0, 500));
    process.exit(1);
  }

  songs.forEach((s, i) => {
    const artist = (s.authors || []).map((a) => a.author_name).join('/') || s.singer_name || '?';
    console.log(
      `  [${i}] ${s.songname || s.song_name} — ${artist}  ${sec(s.timelength)}  hash=${String(s.hash).slice(0, 10)}…`
    );
  });

  console.log('\n' + '='.repeat(70));
  console.log('第二步：逐个试播放地址（不同音质）');
  console.log('='.repeat(70));

  const QUALITIES = [128, 320, 'flac'];

  for (const song of songs.slice(0, 3)) {
    const name = song.songname || song.song_name;
    console.log(`\n--- ${name} ---`);
    console.log(`  字段探测: album_id=${song.album_id} albumid=${song.albumid} album_audio_id=${song.album_audio_id} audio_id=${song.audio_id} cid=${song.cid}`);

    for (const q of QUALITIES) {
      try {
        const res = await client.getSongUrl({
          hash: song.hash,
          albumId: song.album_id || song.albumid || 0,
          albumAudioId: song.album_audio_id || song.audio_id || 0,
          quality: q,
        });

        const item = Array.isArray(res.body) ? res.body[0] : res.body;
        if (item && item.url) {
          const probe = await head(item.url);
          console.log(
            `  [音质 ${q}] ✅ 有地址  码率=${item.br}  大小=${((item.fileSize || 0) / 1e6).toFixed(1)}MB  ` +
              `实测拉流: HTTP ${probe.status} ${probe.type} 读到 ${probe.bytes} 字节`
          );
          console.log(`           ${String(item.url).slice(0, 100)}…`);
        } else {
          const info = item ? JSON.stringify(item).slice(0, 200) : 'null';
          console.log(`  [音质 ${q}] ❌ 无地址  ${info}`);
        }
      } catch (e) {
        const b = e && e.body ? JSON.stringify(e.body).slice(0, 200) : e && e.message;
        console.log(`  [音质 ${q}] ❌ 接口报错  ${b}`);
      }
    }
  }
})().catch((e) => {
  console.error('\n[失败]', e && e.message ? e.message : e);
  if (e && e.body) console.error(JSON.stringify(e.body).slice(0, 800));
});
