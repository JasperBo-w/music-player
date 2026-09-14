'use strict';

/**
 * 下载某首歌的原始专辑封面，用来和"粒子渲染出来的封面"对比。
 *
 * 起因：截图里看到封面层画出一团白色放射状射线，但无法确定
 * "这是专辑图本来的样子"还是"我的渲染把它画坏了"。
 * 把原图下下来看一眼，就不用猜了。
 */

const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const { KuGouClient } = require('../src/index.js');
const { FileSessionStore } = require('../src/session-store.js');

const store = new FileSessionStore(
  process.env.MUSIC_SESSION_FILE || path.join(__dirname, '..', '.session.json')
);
const saved = store.load();
const client = new KuGouClient({ device: saved.device, session: saved.session });

const OUT = process.argv[2] || path.join(__dirname, '..', '..', '..', '.shots');

/** 递归找封面地址（和桌面端 findCover 同样的思路） */
function pick(o, ...keys) {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
}

function download(url, file) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        fs.writeFileSync(file, Buffer.concat(chunks));
        resolve(Buffer.concat(chunks).length);
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error('超时'));
    });
  });
}

(async () => {
  const plRes = await client.getUserPlaylists({ page: 1, pagesize: 100 });
  const lists = (plRes.body.data && (plRes.body.data.info || plRes.body.data.list)) || [];
  const fav = lists.find((p) => String(pick(p, 'name')) === '我喜欢');
  const res = await client.getPlaylistTracks(fav.global_collection_id, { page: 1, pagesize: 3 });
  const data = (res.body && (res.body.data || res.body)) || {};
  const songs = data.songs || data.info || data.lists || data.list || data.audios || [];

  fs.mkdirSync(OUT, { recursive: true });

  for (let i = 0; i < Math.min(3, songs.length); i++) {
    const s = songs[i];
    const name = pick(s, 'name', 'songname') || `song${i}`;
    // 封面字段：歌单接口里通常叫 img / pic / cover
    const img = pick(s, 'img', 'pic', 'cover', 'sizable_cover', 'trans_param');
    let url = typeof img === 'string' ? img : '';
    if (url.includes('{size}')) url = url.replace('{size}', '480');

    console.log(`《${name}》`);
    console.log(`  封面字段原始值: ${JSON.stringify(img)}`);
    if (!url) {
      console.log('  （没有封面地址）\n');
      continue;
    }
    try {
      const n = await download(url, path.join(OUT, `cover-orig-${i}.jpg`));
      console.log(`  已下载 ${n} 字节 → cover-orig-${i}.jpg\n`);
    } catch (e) {
      console.log(`  下载失败: ${e.message}\n`);
    }
  }

  // 顺手把整个第一首歌的所有以 img/pic/cover 结尾的字段打出来，便于核对
  const keys = Object.keys(songs[0] || {}).filter((k) => /img|pic|cover/i.test(k));
  console.log('第一首歌里所有疑似封面字段:', keys.join(', '));
})().catch((e) => {
  console.error('脚本出错：', e);
  process.exit(1);
});
