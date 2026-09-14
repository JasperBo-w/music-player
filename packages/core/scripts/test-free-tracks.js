'use strict';

/**
 * 区分两件事：
 *   (A) 播放失败是因为「付费歌曲门槛」
 *   (B) 还是因为「需要补 SID/EDT 行为指纹验证」
 *
 * 做法：从榜单里挑出 pay_type === 0 的免费歌曲，逐个试播放地址。
 * 如果免费歌能出地址 → 核心链路没问题，付费歌失败是平台侧限制（预期内）。
 * 如果免费歌也不行 → 需要实现 SID/EDT 重试。
 */

const https = require('node:https');
const { KuGouClient } = require('../src/index.js');

const client = new KuGouClient();

function head(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { Range: 'bytes=0-4095', 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let got = 0;
      res.on('data', (c) => (got += c.length));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], bytes: got }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

function pick(obj, ...keys) {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

(async () => {
  // 多拿几页榜单，凑出足够多的免费歌
  const all = [];
  for (const page of [1, 2, 3]) {
    const res = await client.call('top_song', { page, pagesize: 30 });
    const data = (res.body && res.body.data) || [];
    all.push(...data);
  }

  console.log(`榜单共取到 ${all.length} 首`);

  // 观察付费类型分布
  const dist = {};
  for (const s of all) {
    const k = `pay_type=${s.pay_type} privilege_128=${s.privilege_128}`;
    dist[k] = (dist[k] || 0) + 1;
  }
  console.log('付费类型分布:');
  Object.entries(dist).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([k, v]) => console.log(`  ${k}  ×${v}`));

  const free = all.filter((s) => Number(s.pay_type) === 0 && Number(s.privilege_128) === 0);
  console.log(`\n其中「完全免费」(pay_type=0 且 privilege_128=0) 的歌: ${free.length} 首`);

  const targets = free.length ? free.slice(0, 3) : all.slice(0, 3);
  console.log(`测试对象: ${free.length ? '免费歌' : '（没有免费歌，退回测付费歌）'}`);

  for (const song of targets) {
    const name = song.songname || song.song_name;
    console.log(`\n${'-'.repeat(66)}\n--- ${name} ---`);
    console.log(`  pay_type=${song.pay_type} privilege_128=${song.privilege_128} privilege_320=${song.privilege_320}`);

    for (const q of [128, 320]) {
      for (const modName of ['song_url', 'song_url_new']) {
        try {
          const params = {
            hash: song.hash,
            album_id: pick(song, 'album_id', 'albumid') || 0,
            album_audio_id: pick(song, 'album_audio_id', 'audio_id') || 0,
            quality: q,
          };
          const res = await client.call(modName, params);
          const item = Array.isArray(res.body) ? res.body[0] : res.body;
          if (item && item.url) {
            const probe = await head(item.url);
            console.log(`  [${modName} q=${q}] ✅ 有地址 br=${item.br} 实测 HTTP ${probe.status} ${probe.type} ${probe.bytes}B`);
            console.log(`      ${String(item.url).slice(0, 95)}…`);
          } else {
            const brief = item ? { errcode: item.errcode, error: item.error, status: item.status, fail: item.fail_process } : null;
            console.log(`  [${modName} q=${q}] ❌ ${JSON.stringify(brief)}`);
          }
        } catch (e) {
          const b = e && e.body ? e.body : e;
          console.log(`  [${modName} q=${q}] ❌ 异常 errcode=${b && b.errcode} error=${b && b.error} status=${b && b.status}`);
        }
      }
    }
  }
})().catch((e) => console.error('\n[失败]', e && e.message ? e.message : e));
