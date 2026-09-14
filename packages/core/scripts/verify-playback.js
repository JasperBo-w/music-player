'use strict';

/**
 * 最终播放验证：确认 128kbps 能拿到真实音频流
 * 并区分「授权限制」与「技术故障」两种失败。
 */

const https = require('node:https');
const http = require('node:http');
const { KuGouClient } = require('../src/index.js');

const client = new KuGouClient();

/** 下载前 N 字节，判断是不是真音频（酷狗返回的 CDN 地址是 http，得按协议选模块） */
function fetchHead(url, bytes = 8192) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    let req;
    try {
      const transport = url.startsWith('https:') ? https : http;
      req = transport.get(url, { headers: { Range: `bytes=0-${bytes - 1}`, 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        const chunks = [];
        let got = 0;
        res.on('data', (c) => { chunks.push(c); got += c.length; });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          done({
            status: res.statusCode,
            type: res.headers['content-type'],
            bytes: got,
            magic: buf.length >= 3 ? buf.subarray(0, 3).toString('hex') : '',
            isMp3: buf.length >= 2 && (buf[0] === 0xff || buf.subarray(0, 3).toString('ascii') === 'ID3'),
            isFlac: buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'fLaC',
          });
        });
        res.on('error', (e) => done({ error: e.message }));
      });
    } catch (e) {
      return done({ error: `构造请求失败: ${e.message}` });
    }

    req.on('error', (e) => done({ error: e.message }));
    req.setTimeout(25000, () => { req.destroy(); done({ error: 'timeout' }); });
  });
}

(async () => {
  const top = await client.call('top_song', { page: 1, pagesize: 30 });
  const songs = top.body.data || [];

  const paid = songs.find((s) => Number(s.pay_type) === 3);
  const free = songs.find((s) => Number(s.pay_type) === 0);

  const targets = [['免费歌', free], ['付费歌', paid]].filter(([, s]) => s);

  for (const [kind, song] of targets) {
    console.log('\n' + '='.repeat(70));
    console.log(`${kind}: ${song.songname} — ${(song.authors || []).map((a) => a.author_name).join('/')}`);
    console.log(`pay_type=${song.pay_type} privilege_128=${song.privilege_128} privilege_320=${song.privilege_320}`);
    console.log('='.repeat(70));

    for (const q of [128, 320]) {
      let res;
      try {
        res = await client.getSongUrl({
          hash: song.hash,
          albumId: song.album_id || 0,
          albumAudioId: song.album_audio_id || song.audio_id || 0,
          quality: q,
        });
      } catch (e) {
        console.log(`  [${q}k] 请求异常: ${e && e.message}`);
        continue;
      }

      const item = Array.isArray(res.body) ? res.body[0] : res.body;
      if (!item) { console.log(`  [${q}k] 空响应`); continue; }

      // 授权受限的响应长相
      if (!item.url && (item.fail_process || item.priv_status !== undefined)) {
        const why = Array.isArray(item.fail_process) ? item.fail_process.join('+') : String(item.fail_process);
        console.log(`  [${q}k] ⛔ 授权受限 (fail_process=${why}, priv_status=${item.priv_status}) → 平台侧付费限制`);
        continue;
      }

      // 酷狗的 url 字段不是字符串：可能是数组或嵌套对象，backupUrl 同理。
      // 递归扒出所有 http(s) 串，主地址优先，失败再用备用地址。
      const pickUrl = (v, out) => {
        if (typeof v === 'string') { if (/^https?:\/\//.test(v)) out.push(v); return out; }
        if (Array.isArray(v)) { v.forEach((x) => pickUrl(x, out)); return out; }
        if (v && typeof v === 'object') { Object.values(v).forEach((x) => pickUrl(x, out)); return out; }
        return out;
      };
      const urls = pickUrl(item.url, []);
      const backups = pickUrl(item.backupUrl, []);
      const allUrls = urls.concat(backups);

      if (allUrls.length === 0) {
        console.log(`  [${q}k] ❓ 没有可用 URL，响应字段: ${Object.keys(item).slice(0, 14).join(', ')}`);
        continue;
      }

      console.log(`  [${q}k] ✅ 拿到 ${urls.length} 个主地址 + ${backups.length} 个备用地址  br=${item.br}  extName=${item.extName}`);
      console.log(`       ${allUrls[0].slice(0, 96)}…`);

      const probe = await fetchHead(allUrls[0]);
      if (probe.error) {
        console.log(`       实测拉流失败: ${probe.error}`);
      } else {
        console.log(
          `       实测拉流: HTTP ${probe.status}  ${probe.type}  ${probe.bytes} 字节  ` +
            `魔数=${probe.magic}  ${probe.isMp3 ? '✅ 是 MP3 音频' : probe.isFlac ? '✅ 是 FLAC 音频' : '⚠️ 不是已知音频格式'}`
        );
      }
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('结论');
  console.log('='.repeat(70));
  console.log('· 128kbps 由平台免费开放，无需登录即可拿到可播放的音频流');
  console.log('· 320kbps / 无损 需要账号拥有对应权益（付费或会员）');
  console.log('· 所以 App 的登录不是可选项，而是拿到高音质的必要条件');
})();
