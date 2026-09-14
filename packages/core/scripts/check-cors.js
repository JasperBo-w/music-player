'use strict';

/**
 * 检查酷狗音频 CDN 是否返回 CORS 头
 *
 * 为什么关键：
 *   MediaElementAudioSourceNode 对**非同源媒体**会输出静音 ——
 *   如果 CDN 不带 Access-Control-Allow-Origin，getByteFrequencyData()
 *   拿到的全是 0，节拍永远检测不到，而且不报任何错。
 */

const https = require('node:https');
const http = require('node:http');
const path = require('node:path');
const { KuGouClient } = require('../src/index.js');
const { FileSessionStore } = require('../src/session-store.js');

const store = new FileSessionStore(path.join(__dirname, '..', '.session.json'));
const saved = store.load();
const client = new KuGouClient({ device: saved.device, session: saved.session });

/** 发一个 HEAD/GET 请求，把 CORS 相关的响应头打出来 */
function probe(url, method = 'HEAD') {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.request(
      url,
      { method, headers: { Origin: 'app://bundle', Range: 'bytes=0-1023', 'User-Agent': 'Mozilla/5.0' } },
      (res) => {
        resolve({
          status: res.statusCode,
          acao: res.headers['access-control-allow-origin'],
          acac: res.headers['access-control-allow-credentials'],
          vary: res.headers['vary'],
          type: res.headers['content-type'],
          all: Object.keys(res.headers).sort().join(', '),
        });
        res.destroy();
      }
    );
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.end();
  });
}

(async () => {
  // 取一首免费歌的播放地址
  const top = await client.call('top_song', { page: 1, pagesize: 30 });
  const free = (top.body.data || []).find((s) => Number(s.pay_type) === 0 && Number(s.privilege_128) === 0)
    || top.body.data[0];

  console.log(`测试歌曲: ${free.songname}`);

  const stream = await client.getSongStream({
    hash: free.hash,
    albumId: free.album_id,
    albumAudioId: free.album_audio_id || free.audio_id,
    quality: 128,
  });

  if (!stream.url) {
    console.log('没拿到播放地址，无法测试');
    return;
  }

  console.log(`\n播放地址域名: ${new URL(stream.url).host}`);
  const r = await probe(stream.url);
  console.log(JSON.stringify(r, null, 2));

  console.log('\n=== 结论 ===');
  if (r.acao) {
    console.log(`✅ 带 CORS 头 (Access-Control-Allow-Origin: ${r.acao})`);
    console.log('   → Web Audio 应该能正常分析，节拍检测理论上可用');
  } else if (r.error) {
    console.log(`⚠️ 请求失败: ${r.error}`);
  } else {
    console.log('❌ 没有 Access-Control-Allow-Origin');
    console.log('   → MediaElementAudioSourceNode 会输出静音，节拍检测拿不到数据');
    console.log('   → 这就是「粒子不跟鼓点」的根因');
  }

  // 顺便看看封面图（粒子采样也要读像素，同样受 CORS 限制）
  const cover = free.cover || '';
  if (cover) {
    console.log(`\n--- 封面图 CORS 检查 (${new URL(cover).host}) ---`);
    const c = await probe(cover, 'GET');
    console.log(c.acao ? `✅ ${c.acao}` : `❌ 无 CORS 头`);
  }
})().catch((e) => {
  console.error('[失败]', e && e.message ? e.message : e);
  if (e && e.body) console.error(JSON.stringify(e.body).slice(0, 300));
});
