'use strict';

/**
 * 用免费歌验证移动端播放端点
 * 上一步用周杰伦的歌测，全是付费歌所以被拒。换成 pay_type=0 的歌重测。
 */

const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');
const { KuGouClient } = require('../src/index.js');

const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');
const cloudKey = (hash) => md5(String(hash) + 'kgcloud');

const HEADERS = {
  Referer: 'https://www.kugou.com/',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

function get(url, extra) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(url, { headers: Object.assign({}, HEADERS, extra || {}) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* keep */ }
        resolve({ status: res.statusCode, text, json, type: res.headers['content-type'] });
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

/** 拉音频头部字节验证 */
function probeAudio(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(url, { headers: { Range: 'bytes=0-4095', 'User-Agent': HEADERS['User-Agent'] } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const magic = buf.subarray(0, 3).toString('hex');
        resolve({
          status: res.statusCode,
          type: res.headers['content-type'],
          bytes: buf.length,
          magic,
          isMp3: buf.length >= 2 && (buf[0] === 0xff || buf.subarray(0, 3).toString('ascii') === 'ID3'),
        });
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

(async () => {
  // 用核心拿几首免费歌（核心的榜单接口已验证可用）
  const client = new KuGouClient();
  const top = await client.call('top_song', { page: 1, pagesize: 30 });
  const free = (top.body.data || []).filter((s) => Number(s.pay_type) === 0 && Number(s.privilege_128) === 0);

  console.log(`找到 ${free.length} 首免费歌\n`);

  for (const song of free.slice(0, 3)) {
    console.log('='.repeat(70));
    console.log(`${song.songname} — ${(song.authors || []).map((a) => a.author_name).join('/')}`);
    console.log('='.repeat(70));

    // --- 端点 A：移动端 getSongInfo ---
    const mu = new URL('https://m.kugou.com/app/i/getSongInfo.php');
    mu.searchParams.set('cmd', 'playInfo');
    mu.searchParams.set('hash', song.hash);
    mu.searchParams.set('key', cloudKey(song.hash));
    mu.searchParams.set('album_id', String(song.album_id || 0));
    mu.searchParams.set('pid', '1');
    mu.searchParams.set('forceDown', '0');
    mu.searchParams.set('vip', '65530');

    const m = await get(mu.toString(), { Referer: 'https://m.kugou.com/' });
    const mj = m.json;
    if (mj && Number(mj.status) === 1 && mj.url) {
      const p = await probeAudio(mj.url);
      console.log(`  [移动端端点] ✅ status=1`);
      console.log(`     url      = ${String(mj.url).slice(0, 92)}…`);
      console.log(`     fileName = ${mj.fileName}   bitRate=${mj.bitRate}   时长=${mj.timeLength}s`);
      console.log(`     实测拉流 : HTTP ${p.status} ${p.type} ${p.bytes}B  魔数=${p.magic} ${p.isMp3 ? '✅ 真音频' : '⚠️'}`);
    } else {
      console.log(`  [移动端端点] ❌ status=${mj && mj.status} error=${mj && (mj.error || mj.err)}`);
    }

    // --- 端点 B：核心的网关路径（对照） ---
    const stream = await client.getSongStream({
      hash: song.hash,
      albumId: song.album_id,
      albumAudioId: song.album_audio_id || song.audio_id,
      quality: 128,
    });
    console.log(`  [网关路径  ] ${stream.url ? '✅ 有地址' : `❌ restricted=${stream.restricted} fail=${stream.failProcess}`}`);

    // --- 端点 C：Web wwwapi ---
    const wu = new URL('https://wwwapi.kugou.com/play/songinfo');
    wu.searchParams.set('hash', song.hash);
    wu.searchParams.set('album_id', String(song.album_id || 0));
    wu.searchParams.set('platid', '4');
    wu.searchParams.set('mid', md5(String(Date.now())));
    const w = await get(wu.toString());
    const wj = w.json;
    const wurl = wj && wj.data && (wj.data.play_url || wj.data.url);
    console.log(`  [Web 端点  ] ${wurl ? '✅ 有地址' : `❌ status=${wj && wj.status} err_code=${wj && wj.err_code}`}`);

    console.log('');
  }
})();
