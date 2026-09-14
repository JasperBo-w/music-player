'use strict';

/**
 * 端到端验证：模拟用户真实操作路径
 *   搜索 → 选歌 → 播放地址 → 拉音频 → 歌词
 *
 * 这是「写界面之前必须全绿」的那条线。
 */

const https = require('node:https');
const http = require('node:http');
const { KuGouClient } = require('../src/index.js');

const client = new KuGouClient();

function probeAudio(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(url, { headers: { Range: 'bytes=0-4095', 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          type: res.headers['content-type'],
          bytes: buf.length,
          magic: buf.subarray(0, 3).toString('hex'),
          isAudio: buf.length >= 2 && (buf[0] === 0xff || buf.subarray(0, 3).toString('ascii') === 'ID3'),
        });
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

const hr = (t) => console.log('\n' + '='.repeat(70) + '\n' + t + '\n' + '='.repeat(70));

(async () => {
  let pass = 0;
  let fail = 0;
  const check = (label, ok, detail) => {
    console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`);
    ok ? pass++ : fail++;
  };

  // ---------- 1. 搜索 ----------
  hr('1. 搜索');
  const kw = process.argv[2] || '周杰伦';
  const res = await client.search(kw, { page: 1, pagesize: 10 });
  check('搜索返回结果', res.songs.length > 0, `共 ${res.total} 条，本页 ${res.songs.length} 条`);

  res.songs.slice(0, 5).forEach((s, i) => {
    console.log(`     [${i}] ${s.name} — ${s.artist}  ${Math.floor(s.durationSec / 60)}:${String(s.durationSec % 60).padStart(2, '0')}  priv=${s.privilege}`);
  });
  check('歌名已剥离 <em> 标签', !res.songs.some((s) => s.name.includes('<')), `示例: ${res.songs[0].name}`);

  if (!res.songs.length) { console.log('\n搜索无结果，测试中止'); process.exit(1); }

  // ---------- 2. 播放地址 ----------
  hr('2. 播放地址');
  let playable = null;
  for (const song of res.songs.slice(0, 6)) {
    const stream = await client.getSongStream({
      hash: song.hash,
      albumId: song.albumId,
      albumAudioId: song.albumAudioId,
      quality: 128,
    });

    if (stream.url) {
      console.log(`  ${song.name} — ${song.artist}`);
      console.log(`     来源=${stream.source}  ext=${stream.extName}  协议=${stream.url.split(':')[0]}  时长=${Math.round(stream.durationMs / 1000)}s`);
      console.log(`     ${stream.url.slice(0, 88)}…`);
      playable = { song, stream };
      break;
    } else {
      console.log(`  ${song.name} — ${song.artist}  ⛔ 受限: ${stream.failProcess.join(',') || '未知'}`);
    }
  }

  check('至少有一首能拿到播放地址', Boolean(playable));

  if (playable) {
    check('播放地址是 https（安卓可用）', playable.stream.url.startsWith('https://'),
      playable.stream.url.startsWith('https://') ? '' : '⚠️ 安卓 API28+ 默认拦明文 http');
    const p = await probeAudio(playable.stream.url);
    check('实测拉到真实音频字节', Boolean(p.isAudio),
      `HTTP ${p.status} ${p.type} ${p.bytes}B 魔数=${p.magic}`);
  }

  // ---------- 3. 歌词 ----------
  hr('3. 歌词');
  const target = playable ? playable.song : res.songs[0];
  const lyric = await client.getLyric({ name: target.name, artist: target.artist, hash: target.hash });
  check('拿到歌词', lyric.ok, lyric.ok ? `格式=${lyric.format} 逐字=${lyric.isWordByWord} 长度=${lyric.text.length}` : '');

  if (lyric.ok) {
    console.log('     歌词前 260 字:');
    console.log('     ' + lyric.text.replace(/\r?\n/g, '\n     ').slice(0, 260));
    if (lyric.isWordByWord) {
      const firstLine = lyric.text.split(/\r?\n/).find((l) => l.includes('['));
      console.log(`\n     逐字格式样例: ${firstLine ? firstLine.slice(0, 110) : '(无)'}`);
    }
  }

  // ---------- 汇总 ----------
  hr('汇总');
  console.log(`  通过 ${pass} / 失败 ${fail}`);
  console.log(fail === 0 ? '\n🎉 整条链路全绿，可以开始写界面了' : '\n⚠️ 有失败项，见上方明细');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n[异常]', e && e.message ? e.message : e);
  if (e && e.stack) console.error(e.stack.split('\n').slice(0, 5).join('\n'));
  process.exit(1);
});
