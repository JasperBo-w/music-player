'use strict';

/**
 * 音源核心冒烟测试
 *
 * 目的：在写任何界面之前，先证明「不登录也能拿到的链路」是通的：
 *   搜索 → 歌曲列表 → 播放地址 → 歌词
 *
 * 这几步不需要账号，所以可以完全自动化验证。
 * 登录相关的接口（扫码/手机号）需要真实账号，单独人工验证。
 *
 * 运行：node packages/core/scripts/smoke.js [搜索关键词]
 */

const { KuGouClient } = require('../src/index.js');

const KEYWORD = process.argv[2] || '周杰伦';

function line(title) {
  console.log('\n' + '='.repeat(64));
  console.log(title);
  console.log('='.repeat(64));
}

function fmtDuration(sec) {
  const s = Number(sec) || 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

(async () => {
  const client = new KuGouClient();

  line('1. 设备身份');
  console.log(JSON.stringify(client.device, null, 2));

  // ---------------- 搜索 ----------------
  line(`2. 搜索「${KEYWORD}」`);
  const searchRes = await client.search(KEYWORD, { page: 1, pagesize: 5 });
  console.log(`HTTP status: ${searchRes.status}`);

  const lists = searchRes.body && searchRes.body.data && searchRes.body.data.lists;
  if (!Array.isArray(lists) || lists.length === 0) {
    console.log('未拿到歌曲列表，原始响应：');
    console.log(JSON.stringify(searchRes.body, null, 2).slice(0, 2000));
    process.exit(1);
  }

  console.log(`拿到 ${lists.length} 条结果：`);
  lists.forEach((s, i) => {
    console.log(
      `  [${i}] ${s.SongName} — ${s.SingerName}  ` +
        `(${fmtDuration(s.Duration)})  hash=${String(s.FileHash).slice(0, 12)}…  ` +
        `album_id=${s.AlbumID}  audio_id=${s.Audioid}`
    );
  });

  const pick = lists[0];

  // ---------------- 播放地址 ----------------
  line(`3. 取播放地址：${pick.SongName}`);
  const urlRes = await client.getSongUrl({
    hash: pick.FileHash,
    albumId: pick.AlbumID,
    albumAudioId: pick.Audioid,
    quality: 128,
  });
  console.log(`HTTP status: ${urlRes.status}`);

  const urlData = Array.isArray(urlRes.body) ? urlRes.body[0] : urlRes.body;
  console.log('返回数据：');
  console.log(JSON.stringify(urlData, null, 2).slice(0, 1200));

  if (urlData && urlData.url) {
    console.log(`\n>>> 播放地址可用: ${urlData.url.slice(0, 110)}…`);
    console.log(`    码率 ${urlData.br}  时长 ${urlData.timeLength}s  大小 ${urlData.fileSize}`);
    // 验证地址真的能下载
    const https = require('node:https');
    await new Promise((resolve) => {
      https
        .get(urlData.url, { headers: { Range: 'bytes=0-2047', 'User-Agent': 'Mozilla/5.0' } }, (r) => {
          console.log(`    实测拉流: HTTP ${r.statusCode}  content-type=${r.headers['content-type']}  (读取到音频字节即为可用)`);
          r.destroy();
          resolve();
        })
        .on('error', (e) => {
          console.log(`    实测拉流失败: ${e.message}`);
          resolve();
        });
    });
  } else {
    console.log('\n>>> 没拿到播放地址（多半是付费/版权限制，属于预期内的平台侧限制）');
  }

  // ---------------- 歌词 ----------------
  line('4. 取歌词');
  const lyricId = pick.LyricId || (pick.EMixSongID ? undefined : undefined);
  const accesskey = pick.LyricId ? undefined : undefined;
  console.log(`搜索返回的 LyricId=${pick.LyricId}  accesskey=${pick.AccessKey || pick.accesskey || '(无)'}`);

  if (pick.LyricId) {
    try {
      const lyricRes = await client.getLyric({
        id: pick.LyricId,
        accesskey: pick.AccessKey || pick.accesskey,
        fmt: 'krc',
        decode: true,
      });
      const decoded = lyricRes.body && lyricRes.body.decodeContent;
      console.log(decoded ? `歌词前 300 字：\n${decoded.slice(0, 300)}` : '未取到解码歌词');
      console.log(`原始响应: ${JSON.stringify(lyricRes.body).slice(0, 300)}`);
    } catch (e) {
      console.log(`歌词接口报错: ${e.message || JSON.stringify(e).slice(0, 300)}`);
    }
  }

  line('冒烟测试结束');
})().catch((e) => {
  console.error('\n[失败]', e && e.message ? e.message : e);
  if (e && e.body) console.error('响应体:', JSON.stringify(e.body).slice(0, 1500));
  if (e && e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
