'use strict';

/**
 * 验证 albumAudioId 会不会影响酷狗实际返回的音频文件
 *
 * 背景：歌单接口返回的对象里 `audio_id` 和 `add_mixsongid` 是两个不同的值
 * （实测同一首歌分别是 529497156 和 836176367）。取流时这个值会被拼进播放地址
 * （`..._mx<值>_qu128...`）。界面代码原来拿的是 `audio_id`。
 *
 * 问题：这个 mx 只是"标签"，还是真的决定返回哪个文件？
 *   - 如果两个地址拿到**完全相同**的字节 → mx 无所谓，"放错歌"在别处
 *   - 如果拿到**不同**的文件 → mx 真的决定内容，界面填错了值就会放错歌
 *
 * 做法：同一个 hash，分别用两个 albumAudioId 取流，各下载一段真实音频，逐字节比对。
 */

const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
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

/** 下载前 N 字节，返回长度 + 内容的 md5 */
function fetchHead(url, bytes = 262144) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(
      url,
      { headers: { Range: `bytes=0-${bytes - 1}`, 'User-Agent': 'Mozilla/5.0' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            bytes: buf.length,
            md5: crypto.createHash('md5').update(buf).digest('hex').slice(0, 16),
            contentRange: res.headers['content-range'] || null,
            contentType: res.headers['content-type'] || null,
          });
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

  const res = await client.getPlaylistTracks(fav.global_collection_id, { page: 1, pagesize: 3 });
  const data = (res.body && (res.body.data || res.body)) || {};
  const raw = data.songs || data.info || data.lists || data.list || data.audios || [];

  for (const s of raw.slice(0, 2)) {
    console.log('='.repeat(70));
    console.log(`《${s.name}》`);
    console.log(`  hash          = ${s.hash}`);
    console.log(`  audio_id      = ${s.audio_id}      ← 界面原来用的`);
    console.log(`  add_mixsongid = ${s.add_mixsongid}  ← 真正的 mixsongid`);

    const cands = [
      { label: 'audio_id', value: s.audio_id },
      { label: 'add_mixsongid', value: s.add_mixsongid },
    ].filter((c) => c.value);

    const out = [];
    for (const c of cands) {
      const info = await client.getSongStream({
        hash: s.hash,
        albumId: s.album_id,
        albumAudioId: c.value,
        quality: 128,
      });
      if (!info.url) {
        console.log(`  ${c.label}: 取流失败 ${(info.failProcess || []).join('、')}`);
        continue;
      }
      const mx = (info.url.match(/_mx(\d+)_/) || [])[1];
      process.stdout.write(`  ${c.label.padEnd(15)} → mx=${mx}  下载中…`);
      const head = await fetchHead(info.url);
      console.log(` 完成`);
      out.push({ ...c, mx, url: info.url, head });
    }

    if (out.length === 2) {
      const [a, b] = out;
      const same = a.head.md5 && a.head.md5 === b.head.md5;
      console.log('');
      console.log(`    md5(${a.label}) = ${a.head.md5}  ${a.head.bytes} 字节`);
      console.log(`    md5(${b.label}) = ${b.head.md5}  ${b.head.bytes} 字节`);
      console.log(
        same
          ? '    → 两个地址拿到**完全相同**的字节：mx 只是个标签，填错不影响放什么歌'
          : '    → 两个地址拿到**不同**的文件：mx 真的决定内容，界面必须填对！'
      );
    }
    console.log('');
  }
})().catch((e) => {
  console.error('脚本出错：', e);
  process.exit(1);
});
