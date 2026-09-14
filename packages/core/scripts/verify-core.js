'use strict';

/**
 * 核心门面自检：确认规整函数与 getSongStream 正常工作
 * 运行：node packages/core/scripts/verify-core.js
 */

const { KuGouClient, normalizeSongUrl, collectUrls } = require('../src/index.js');

(async () => {
  const client = new KuGouClient();

  const top = await client.call('top_song', { page: 1, pagesize: 5 });
  const song = top.body.data[0];
  console.log(`歌曲: ${song.songname} — ${(song.authors || []).map((a) => a.author_name).join('/')}`);

  const stream = await client.getSongStream({
    hash: song.hash,
    albumId: song.album_id,
    albumAudioId: song.album_audio_id,
    quality: 128,
  });

  console.log('\ngetSongStream 规整结果:');
  console.log(`  url        : ${stream.url ? stream.url.slice(0, 78) + '…' : '(无)'}`);
  console.log(`  backupUrls : ${stream.backupUrls.length} 个`);
  console.log(`  extName    : ${stream.extName}`);
  console.log(`  durationMs : ${stream.durationMs}`);
  console.log(`  restricted : ${stream.restricted}`);

  console.log('\n单元自检:');
  console.log(`  collectUrls 嵌套提取 -> ${JSON.stringify(collectUrls({ a: ['http://x/1'], b: { c: 'https://y/2' }, d: 'nope' }))}`);
  console.log(`  受限响应识别        -> ${JSON.stringify(normalizeSongUrl({ fail_process: ['pkg', 'buy'], priv_status: 0 }))}`);

  const ok = Boolean(stream.url) && stream.backupUrls.length > 0 && stream.restricted === false;
  console.log(`\n${ok ? '✅ 核心自检通过' : '❌ 核心自检未通过'}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('[失败]', e && e.message ? e.message : e);
  process.exit(1);
});
